// DJ-режим: следующий трек подбирается по темпу и тональности (круг Камелота), а переход
// сводится как на диджейском сете: темп следующего трека подгоняется под текущий, доли
// совпадают, на сильной доле бас «передаётся» новому треку, старый уходит с фильтром.
// Подключается после app.js и пользуется его плеером (player, decks, deck, eq, bridge…).

const DJ_RATE = 11025;
const djSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dj = {
  get enabled() { return transitions.mode === 'dj' || player.djSet; },
  // темп и тональность уже разобранных треков (по ключу трека)
  data: (() => { try { return JSON.parse(localStorage.getItem('djData1') || '{}'); } catch { return {}; } })(),
  failed: new Set(),
  worker: null,
  wid: 0,
  waits: new Map(),
  decodeCtx: null,
  busy: false,
  plan: null,    // подготовленный или идущий переход
  mixing: false,
  takeover: null,
  ramp: 0,
  timer: 0,

  modeChanged() {
    if (!this.enabled) this.abort();
    renderDj();
    if (this.enabled) this.kick();
  },

  saveData() {
    const keys = Object.keys(this.data);
    if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach((k) => delete this.data[k]);
    try { localStorage.setItem('djData1', JSON.stringify(this.data)); } catch { /* не страшно */ }
  },

  // --- Анализ звука ------------------------------------------------------------------------------
  run(samples, wantKey) {
    if (!this.worker) {
      this.worker = new Worker('dj-worker.js');
      this.worker.onmessage = (e) => {
        const w = this.waits.get(e.data.id);
        this.waits.delete(e.data.id);
        if (w) (e.data.ok ? w.resolve(e.data.res) : w.reject(new Error(e.data.error)));
      };
    }
    const id = ++this.wid;
    return new Promise((resolve, reject) => {
      this.waits.set(id, { resolve, reject });
      this.worker.postMessage({ id, samples, rate: DJ_RATE, wantKey }, [samples.buffer]);
    });
  },

  // кусок трека: звук и точное время его начала на шкале трека
  async grab(url, start, seconds, retry = true) {
    try {
      return await this.grab_(url, start, seconds);
    } catch (err) {
      if (!retry) throw err;
      await djSleep(800);
      return this.grab(url, start, seconds, false);
    }
  },

  async grab_(url, start, seconds) {
    const res = await bridge.audioWindow(url, start, seconds);
    if (!res.ok) throw new Error(res.error || 'звук не скачался');
    if (!this.decodeCtx) this.decodeCtx = new OfflineAudioContext(1, 1, DJ_RATE);
    const bytes = res.data;
    const buffer = await this.decodeCtx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    let samples = monoFromBuffer(buffer);
    let startTime = res.startTime;
    if (res.whole) {
      samples = samples.slice(Math.floor(start * DJ_RATE), Math.floor((start + seconds) * DJ_RATE));
      startTime = start;
    }
    return { samples, startTime };
  },

  async ensureUrl(t) {
    if (t.url) return t.url;
    const [fresh] = await vk('audio.getById', { audios: t.fullId }, { cache: false });
    if (fresh && fresh.url) t.url = fresh.url;
    return t.url;
  },

  // темп и тональность трека — по куску из середины (во вступлении бита часто нет)
  async analyzeTrack(t) {
    if (this.data[t.key]) return this.data[t.key];
    const url = await this.ensureUrl(t);
    if (!url) throw new Error('нет ссылки');
    const start = t.duration > 150 ? 50 : Math.max(0, t.duration / 2 - 25);
    // у короткого фрагмента (без входа ВК даёт 30 секунд) середины нет — берём начало
    const w = await this.grab(url, start, 50).catch(() => (start > 0 ? this.grab(url, 0, 50) : Promise.reject(new Error('звук не разобрался'))));
    const r = await this.run(w.samples, true);
    const info = {
      bpm: r.bpm ? Math.round(r.bpm * 10) / 10 : 0, conf: Math.round((r.conf || 0) * 10) / 10,
      camelot: r.key ? r.key.camelot : '', key: r.key ? r.key.name : '', energy: Math.round(r.energy * 10) / 10,
    };
    this.data[t.key] = info;
    this.saveData();
    diag.add('dj', `${t.artist} — ${t.title}: ${info.bpm} BPM, ${info.key} (${info.camelot}), чёткость ${info.conf}`);
    return info;
  },

  upcoming(n = 10) {
    const out = [];
    for (let i = player.pos + 1; i < player.order.length && out.length < n; i++) out.push({ pos: i, t: player.queue[player.order[i]] });
    return out;
  },

  // разбираем текущий и ближайшие треки по одному, в фоне
  async kick() {
    if (!this.enabled || this.busy || !auth.loggedIn) return;
    this.busy = true;
    try {
      for (;;) {
        if (!this.enabled || !player.current) break;
        const list = [player.current, ...this.upcoming(10).map((x) => x.t)];
        const t = list.find((x) => x && !this.data[x.key] && !this.failed.has(x.key) && x.duration > 60);
        if (!t) break;
        try {
          await this.analyzeTrack(t);
        } catch (err) {
          this.failed.add(t.key);
          diag.add('dj', `${t.artist} — ${t.title}: не разобран (${err.message})`);
        }
        this.arrange();
        renderDj();
        await djSleep(300);
      }
    } finally {
      this.busy = false;
    }
  },

  // --- Подбор следующего трека ------------------------------------------------------------------
  // во сколько раз ускорить/замедлить b, чтобы доли совпали с a (с учётом «вдвое быстрее/медленнее»)
  tempoRatio(bpmA, bpmB) {
    if (!bpmA || !bpmB) return null;
    let best = null;
    for (const m of [0.5, 1, 2]) {
      const r = bpmA / (bpmB * m);
      if (!best || Math.abs(Math.log(r)) < Math.abs(Math.log(best.r))) best = { r, m };
    }
    return best;
  },

  camelotScore(a, b) {
    const pa = /^(\d+)([AB])$/.exec(a || ''), pb = /^(\d+)([AB])$/.exec(b || '');
    if (!pa || !pb) return 0.5;
    const na = +pa[1], nb = +pb[1];
    const step = Math.min((na - nb + 12) % 12, (nb - na + 12) % 12);
    if (pa[2] === pb[2]) return step === 0 ? 1 : step === 1 ? 0.9 : step === 2 ? 0.45 : 0.1;
    return step === 0 ? 0.85 : step === 1 ? 0.4 : 0.1;
  },

  score(a, b, ta, tb) {
    const tr = this.tempoRatio(a.bpm, b.bpm);
    const diff = tr ? Math.abs(tr.r - 1) : 1;
    const tempo = diff <= 0.02 ? 1 : diff <= 0.04 ? 0.85 : diff <= 0.06 ? 0.6 : diff <= 0.08 ? 0.3 : 0;
    const energy = 1 - Math.min(1, Math.abs((a.energy || 0) - (b.energy || 0)) / 12);
    const sameArtist = normText(ta.artist) === normText(tb.artist) ? 0.15 : 0;
    const halfTime = tr && tr.m !== 1 ? 0.06 : 0; // «вдвое медленнее» сводится хуже, чем тот же темп
    return 0.55 * tempo + 0.35 * this.camelotScore(a.camelot, b.camelot) + 0.1 * energy - sameArtist - halfTime;
  },

  // ставим следующим самый подходящий из ближайших разобранных треков
  arrange() {
    // альбом или плейлист, запущенный как DJ-сет, играет в своём порядке
    if (!this.enabled || player.djSet || !player.current || this.plan || this.mixing) return;
    const cur = this.data[player.current.key];
    if (!cur) return;
    const cands = this.upcoming(10).filter((x) => x.t && this.data[x.t.key]);
    if (!cands.length) return;
    let best = null;
    for (const c of cands) {
      const s = this.score(cur, this.data[c.t.key], player.current, c.t) + Math.random() * 0.03;
      if (!best || s > best.s) best = { ...c, s };
    }
    if (best.pos !== player.pos + 1) {
      const [idx] = player.order.splice(best.pos, 1);
      player.order.splice(player.pos + 1, 0, idx);
      renderQueue();
    }
  },

  nextPos() {
    if (player.repeat === 'one') return null;
    if (player.pos + 1 < player.order.length) return player.pos + 1;
    if (player.repeat === 'all' && !player.mix && !player.shuffle && player.order.length > 1) return 0;
    return null;
  },

  // --- Переход ------------------------------------------------------------------------------------
  // в режиме DJ-сета кроссфейда нет совсем: не получилось свести — следующий трек просто сменяет текущий
  blocksCrossfade() {
    return this.enabled;
  },

  tick() {
    if (!this.enabled || !player.current) return;
    const A = deck();
    if (this.mixing) return;
    const left = (A.duration || 0) - A.currentTime;
    if (!this.plan && !A.paused && isFinite(left) && left < 100 && left > 6 && A.duration > 30 && this.nextPos() !== null) this.prepare();
    const p = this.plan;
    if (p && p.ready && !p.fallback && !A.paused) {
      if (A.currentTime >= p.startA - 0.006) {
        // момент проскочили (перемотка, подвисание) — сводим прямо сейчас, без привязки к доле
        if (A.currentTime > p.startA + 0.25) { p.startB += (A.currentTime - p.startA) * p.r; p.startA = A.currentTime; p.loose = true; }
        this.start();
      } else if (p.startA - A.currentTime < 1.2 && !this.timer) {
        // последнюю секунду следим чаще, чтобы попасть в долю
        this.timer = setInterval(() => this.tick(), 4);
      }
    }
  },

  // точный расчёт не удался — сводим по запасной схеме: последние ~8 секунд, без подгонки темпа
  async fail(why) {
    const p = this.plan;
    clearInterval(this.timer); this.timer = 0;
    if (!p || p.ready || p.simple) { if (p) p.fallback = true; this.releaseSpare(); return; }
    diag.add('dj', `простое сведение: ${why}`);
    const A = deck(), id = player.loadId;
    Object.assign(p, { simple: true, style: 'simple', beatmatched: false, r: 1, pA: 0.5, L: 16, startB: 0, entryB: 8, exitA: A.duration - 0.5, outro: false, drop: false, trimDb: 0 });
    p.startA = Math.max(A.currentTime + 2, A.duration - 8.5);
    try {
      p.src = p.src || await this.sourceFor(p.next);
      if (!p.src.url) throw new Error('нет ссылки на следующий трек');
      await this.loadSpare(p.src.url, 0, 1);
      if (this.plan !== p || id !== player.loadId) { this.releaseSpare(); return; }
      p.ready = true;
    } catch (err) {
      p.fallback = true;
      this.releaseSpare();
      diag.add('dj', `сведение не получилось: ${err.message}`);
    }
  },

  // ссылка на версию следующего трека (без цензуры, если она уже известна)
  async sourceFor(t) {
    const known = uncensor.applies(t) ? uncensor.get(t.key) : undefined;
    if (known) {
      const u = await Promise.race([uncensor.urlOf(known), djSleep(3000).then(() => null)]);
      if (u) return { url: u, substitute: { ...known, url: u } };
    }
    return { url: await this.ensureUrl(t), substitute: null };
  },

  async prepare() {
    const id = player.loadId;
    this.arrange();
    const nextPos = this.nextPos();
    if (nextPos === null) return;
    const A = deck(), cur = player.current;
    const next = player.queue[player.order[nextPos]];
    const p = this.plan = { id, next, nextPos, ready: false, fallback: false };
    try {
      const src = await this.sourceFor(next);
      if (!src.url) throw new Error('нет ссылки на следующий трек');
      const urlA = cur.substitute ? cur.substitute.url : cur.url;
      const tailFrom = Math.max(0, A.duration - 95);
      const [wa, wb] = await Promise.all([this.grab(urlA, tailFrom, 95), this.grab(src.url, 0, 55)]);
      if (this.plan !== p || id !== player.loadId) return;
      const [ra, rb] = await Promise.all([this.run(wa.samples, false), this.run(wb.samples, false)]);
      if (this.plan !== p || id !== player.loadId) return;
      Object.assign(p, this.plan_(ra, rb, wa.startTime, A));
      if (!p.startA) throw new Error('нет места для перехода');
      if (p.startA < A.currentTime + 3) throw new Error('не успели подготовить');
      p.src = src;
      await this.loadSpare(src.url, p.startB, p.r);
      if (this.plan !== p || id !== player.loadId) { this.releaseSpare(); return; }
      p.ready = true;
      diag.add('dj', `${cur.title} → ${next.title}: ${ra.bpm ? ra.bpm.toFixed(1) : '?'} → ${rb.bpm ? rb.bpm.toFixed(1) : '?'} BPM, ${p.style === 'blend' ? `сведение ×${p.r.toFixed(3)}` : 'эхо-переход в долю'}, громкость ${p.trimDb > 0 ? '+' : ''}${p.trimDb.toFixed(1)} дБ; наложение ${p.L} долей с ${p.startA.toFixed(1)} с (уходим на ${p.exitA.toFixed(1)} с из ${A.duration.toFixed(0)}${p.outro ? ', перед аутро' : ''}), новый с ${p.startB.toFixed(1)} с, вход на ${p.entryB.toFixed(1)} с${p.drop ? ' (после вступления)' : ''}`);
    } catch (err) {
      if (this.plan === p) this.fail(err.message);
    }
  },

  // Расчёт перехода, как в AutoMix у Apple и у диджеев:
  //  - текущий трек (A) уходит на границе фразы перед аутро (затишьем в конце), а не в последние секунды;
  //  - следующий (B) подкладывается так, чтобы его «вход» — конец вступления, где музыка набирает силу, —
  //    пришёлся ровно на этот момент; вступление B звучит поверх последних тактов A;
  //  - на входе бас переходит к B, A к этому моменту стихает с фильтром.
  plan_(ra, rb, tailStart, A) {
    const ok = (r) => r && r.bpm && r.period && r.conf > 2.5;
    const tr = ok(ra) && ok(rb) ? this.tempoRatio(ra.bpm, rb.bpm) : null;
    const beatmatched = Boolean(tr && Math.abs(tr.r - 1) <= 0.08);
    const r = beatmatched ? tr.r : 1;
    const pA = ok(ra) ? ra.period : 0.5;
    const level = (res, from, to) => {
      const db = (res && res.db) || [];
      let sum = 0, n = 0;
      for (let i = Math.max(0, Math.floor(from * 10)); i < Math.min(db.length, Math.ceil(to * 10)); i++) { sum += db[i]; n++; }
      return n ? sum / n : -100;
    };
    // --- где уходит A
    const endA = Math.min(A.duration - 0.2, tailStart + (ra ? ra.lastLoud : 90));
    let exitA = endA, outro = false;
    if (ok(ra)) {
      const firstA = tailStart + ra.first, db = ra.downbeat || 0;
      const bounds = [];
      for (let k = 0; firstA + k * pA <= endA; k++) if ((k - db) % 16 === 0) bounds.push(firstA + k * pA);
      // затишье: следующие 8 долей заметно тише предыдущих 16 — начинается аутро
      const drop = (b) => level(ra, b - tailStart - 16 * pA, b - tailStart) - level(ra, b - tailStart, b - tailStart + 8 * pA);
      const lulls = bounds.filter((b) => b > A.currentTime + 12 && b >= endA - 60 && b <= endA - 4 && drop(b) > 2.5);
      if (lulls.length) { exitA = lulls.reduce((x, y) => (drop(y) > drop(x) ? y : x)); outro = true; }
      else {
        const fit = bounds.filter((b) => b <= endA - 0.5 && b > A.currentTime + 8);
        exitA = fit.length ? fit[fit.length - 1] : endA;
      }
    }
    // --- где B «входит»: первая граница фразы, где музыка набирает полную силу (конец вступления)
    let entryB = rb ? rb.firstLoud : 0, drop = false;
    if (ok(rb)) {
      const pB = rb.period, db = rb.downbeat || 0;
      const loud = rb.loud;
      for (let j = 0; rb.first + j * pB < 45; j++) {
        if ((j - db) % 8 !== 0) continue;
        const t = rb.first + j * pB;
        if (t < rb.firstLoud + 4 * pB) continue;
        const after = level(rb, t, t + 8 * pB), before = level(rb, Math.max(0, t - 8 * pB), t);
        if (after > before + 2.5 || (after > loud - 4 && before < loud - 6)) { entryB = t; drop = true; break; }
      }
      // без явного вступления — вход через 16 долей после начала музыки
      if (!drop) {
        for (let j = 0; j < 400; j++) {
          const t = rb.first + j * pB;
          if ((j - db) % 4 === 0 && t >= rb.firstLoud - 0.05) { entryB = t + 16 * pB; break; }
        }
      }
    }
    // --- сценарий и длина наложения
    let style, L, startB;
    if (beatmatched) {
      // вступление B целиком под последними тактами A (до 32 долей); короткое вступление —
      // B начинается с самого начала, а его «вход» придётся чуть позже
      style = 'blend';
      L = pA * 32 <= 20 ? 32 : 16;
      const fitB = Math.floor(entryB / (pA * r) / 4) * 4;
      if (fitB >= 8) { L = Math.min(L, fitB); startB = entryB - L * pA * r; } else { L = 16; startB = 0; }
    } else {
      // темпы не свести — 4 доли разгона фильтром и эхом, новый трек вступает сразу со своей сильной части
      style = 'cut';
      L = 4;
      startB = Math.max(0, entryB - L * pA);
    }
    const startA = exitA - L * pA;
    // громкость: новый трек на входе звучит так же громко, как старый перед уходом
    const pB = ok(rb) ? rb.period : 0.5;
    const lvA = level(ra, exitA - tailStart - 8 * pA, exitA - tailStart), lvB = level(rb, entryB, entryB + 8 * pB);
    const trimDb = lvA > -90 && lvB > -90 ? Math.max(-6, Math.min(4, lvA - lvB)) : 0;
    return { style, beatmatched, r, pA, L, startA, startB: Math.max(0, startB), exitA, entryB, endA, outro, drop, trimDb };
  },

  // готовим следующий трек на запасной деке: на нужной секунде, на паузе, с нужным темпом, фейдер внизу
  loadSpare(url, at, rate) {
    const i = 1 - deckIdx;
    const d = decks[i];
    clearInterval(d.fadeTimer); d.fadeTimer = 0;
    d.pause();
    player.destroyHls(i);
    d.fade = 1;
    applyVolume(d);
    eq.resetDeck(i, { mix: 0 });
    return new Promise((resolve, reject) => {
      const done = () => {
        d.defaultPlaybackRate = rate;
        d.playbackRate = rate;
        d.preservesPitch = true;
        if (Math.abs(d.currentTime - at) > 0.004) d.currentTime = at;
        const ready = () => (d.readyState >= 3 ? resolve() : d.addEventListener('canplay', resolve, { once: true }));
        if (d.seeking) d.addEventListener('seeked', ready, { once: true }); else ready();
      };
      setTimeout(() => reject(new Error('следующий трек не загрузился')), 15000);
      if (/\.m3u8/.test(url) && window.Hls && Hls.isSupported()) {
        const hls = new Hls({ ...hlsConfig(), startPosition: at });
        player.hlsDeck[i] = hls;
        hls.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) reject(new Error(data.details)); });
        hls.loadSource(url);
        hls.attachMedia(d);
      } else {
        d.src = url;
      }
      d.addEventListener('loadedmetadata', done, { once: true });
    });
  },

  releaseSpare() {
    if (this.mixing) return;
    const i = 1 - deckIdx;
    const d = decks[i];
    if (!d.paused) return;
    player.destroyHls(i);
    d.removeAttribute('src');
    d.load();
    d.defaultPlaybackRate = 1;
    d.playbackRate = 1;
    eq.resetDeck(i);
  },

  start() {
    const p = this.plan;
    clearInterval(this.timer); this.timer = 0;
    const aIdx = deckIdx;
    const A = decks[aIdx], B = decks[1 - aIdx];
    this.mixing = true;
    p.aIdx = aIdx;
    p.rateA = A.playbackRate || 1;
    B.play().catch(() => {});
    // весь переход расписываем заранее по долям прямо в звуковом движке — точно в бит и без ступенек
    if (eq.ctx && eq.fx) this.schedule(p, eq.ctx.currentTime + Math.max(0, p.startA - A.currentTime));
    else p.noFx = true;
    // плеер переходит на следующий трек сразу: уже играющая запасная дека становится основной
    this.takeover = { track: p.next, deck: 1 - aIdx, substitute: p.src.substitute };
    player.pos = p.nextPos;
    player.load();
    p.lastFix = 0;
    p.err = 0;
    document.body.classList.add('dj-mixing');
    renderDj();
    this.timer = setInterval(() => this.mixTick(), 25);
  },

  // Сценарии переходов. T(b) — время доли b перехода (по сетке уходящего трека).
  //  blend — темпы сведены: вступление нового трека входит «тонким» (без баса, фильтр открывается),
  //          оба трека звучат вместе; на сильной доле бас переходит к новому, старый уходит
  //          с резонансным фильтром, эхом в такт и хвостом ревербератора;
  //  cut   — темпы не свести: старый трек разгоняется фильтром, последняя доля уходит в эхо,
  //          и новый трек вступает точно в долю — сразу со своей сильной части;
  //  simple — бит не определился: плавное сведение с фильтрами за ~8 секунд.
  schedule(p, t0) {
    const a = eq.fx[p.aIdx], b = eq.fx[1 - p.aIdx];
    const pA = p.pA / (p.rateA || 1), T = (k) => t0 + k * pA; // доля в реальном времени
    const set = (param, v, t) => param.setValueAtTime(v, t);
    const lin = (param, v, t) => param.linearRampToValueAtTime(v, t);
    const exp = (param, v, t) => param.exponentialRampToValueAtTime(Math.max(v, 0.0001), t);
    const all = [a, b].flatMap((f) => [f.trim.gain, f.low.gain, f.mid.gain, f.high.gain, f.hp.frequency, f.hp.Q, f.mix.gain, f.echoIn.gain, f.fb.gain, f.wet.gain, f.rvIn.gain]);
    all.forEach((param) => { param.cancelScheduledValues(t0 - 0.05); param.setValueAtTime(param.value, t0 - 0.01); });
    // громкость нового трека подравниваем к старому, потом она плавно вернётся к своей
    set(b.trim.gain, Math.pow(10, (p.trimDb || 0) / 20), t0);
    a.delay.delayTime.setValueAtTime(Math.min(2.5, pA * 0.75), t0);
    const L = p.L;
    if (p.style === 'blend') {
      // новый: вступление «тонкое» — без баса, фильтр открывается к середине
      set(b.mix.gain, 0, t0); lin(b.mix.gain, 0.8, T(2)); lin(b.mix.gain, 1, T(L));
      set(b.low.gain, -40, t0); set(b.low.gain, -40, T(L) - 0.05); lin(b.low.gain, 0, T(L));
      set(b.mid.gain, -5, t0); lin(b.mid.gain, 0, T(L * 0.75));
      set(b.hp.frequency, 450, t0); exp(b.hp.frequency, 20, T(L * 0.5));
      // старый: середина уступает место, на сильной доле бас уходит, дальше фильтр, эхо и хвост
      set(a.mid.gain, 0, T(L * 0.5)); lin(a.mid.gain, -6, T(L));
      set(a.low.gain, 0, T(L) - 0.05); lin(a.low.gain, -40, T(L));
      set(a.hp.frequency, 20, T(L * 0.75)); exp(a.hp.frequency, 160, T(L)); exp(a.hp.frequency, 2200, T(L + 4));
      set(a.hp.Q, 0.7, T(L)); lin(a.hp.Q, 6, T(L + 3.5));
      set(a.mix.gain, 1, T(L)); lin(a.mix.gain, 0, T(L + 4));
      set(a.fb.gain, 0.45, T(L - 1));
      set(a.echoIn.gain, 0, T(L - 1)); lin(a.echoIn.gain, 1, T(L - 0.5)); set(a.echoIn.gain, 1, T(L + 2)); lin(a.echoIn.gain, 0, T(L + 4));
      set(a.wet.gain, 0, T(L - 1)); lin(a.wet.gain, 0.5, T(L)); lin(a.wet.gain, 0, T(L + 12));
      set(a.rvIn.gain, 0, T(L)); lin(a.rvIn.gain, 0.55, T(L + 2)); lin(a.rvIn.gain, 0, T(L + 4.5));
      lin(a.fb.gain, 0, T(L + 14));
      p.endBeats = L + 4;
    } else if (p.style === 'cut') {
      // старый: 4 доли разгона резонансным фильтром, последняя доля уходит в эхо и ревербератор
      set(a.hp.frequency, 20, t0); exp(a.hp.frequency, 900, T(L));
      set(a.hp.Q, 0.7, t0); lin(a.hp.Q, 7, T(L));
      set(a.fb.gain, 0.5, T(L - 1));
      set(a.echoIn.gain, 0, T(L - 1)); lin(a.echoIn.gain, 1, T(L - 0.75)); set(a.echoIn.gain, 1, T(L)); lin(a.echoIn.gain, 0, T(L) + 0.03);
      set(a.wet.gain, 0, T(L - 1)); lin(a.wet.gain, 0.65, T(L)); lin(a.wet.gain, 0, T(L + 10));
      set(a.rvIn.gain, 0, T(L - 1)); lin(a.rvIn.gain, 0.7, T(L)); lin(a.rvIn.gain, 0, T(L) + 0.25);
      set(a.mix.gain, 1, T(L)); lin(a.mix.gain, 0, T(L) + 0.03);
      lin(a.fb.gain, 0, T(L + 12));
      // новый: молчит до сильной доли, потом вступает сразу во всю силу, фильтр раскрывается за долю
      set(b.mix.gain, 0, t0); set(b.mix.gain, 0, T(L)); lin(b.mix.gain, 1, T(L) + 0.02);
      set(b.hp.frequency, 260, T(L)); exp(b.hp.frequency, 20, T(L + 1));
      p.endBeats = L + 0.2;
    } else {
      const S = (sec) => t0 + sec;
      set(b.mix.gain, 0, t0); lin(b.mix.gain, 1, S(4));
      set(b.low.gain, -30, t0); set(b.low.gain, -30, S(4)); lin(b.low.gain, 0, S(4.3));
      set(b.hp.frequency, 600, t0); exp(b.hp.frequency, 20, S(4));
      set(a.low.gain, 0, S(4)); lin(a.low.gain, -30, S(4.3));
      set(a.hp.frequency, 20, S(4)); exp(a.hp.frequency, 1600, S(8));
      set(a.hp.Q, 0.7, S(4)); lin(a.hp.Q, 4, S(8));
      set(a.mix.gain, 1, S(5)); lin(a.mix.gain, 0, S(8));
      set(a.rvIn.gain, 0, S(5)); lin(a.rvIn.gain, 0.5, S(7)); lin(a.rvIn.gain, 0, S(8.2));
      p.endBeats = 8 / pA;
    }
  },

  mixTick() {
    const p = this.plan;
    if (!p) return;
    const A = decks[p.aIdx], B = decks[1 - p.aIdx];
    const el = A.currentTime - p.startA;
    const k = el / ((p.endBeats || p.L) * p.pA);
    if (A.paused || A.ended || A.readyState < 3 || k >= 1) return this.finish();
    // держим доли вместе: сравниваем, где B есть и где должен быть, и чуть подгоняем скорость
    const now = performance.now();
    if (now - p.lastFix > 120 && !B.seeking) {
      p.lastFix = now;
      const err = B.currentTime - (p.startB + p.r * el);
      p.err = p.err * 0.5 + err * 0.5;
      if (Math.abs(err) > 0.25) { this.selfSeek = true; B.currentTime = p.startB + p.r * el + 0.03; p.err = 0; }
      else B.playbackRate = Math.max(p.r * 0.95, Math.min(p.r * 1.05, p.r * (1 - p.err * 1.2)));
    }
    if (p.noFx) {
      // без звукового движка — простое сведение громкостью
      B.fade = Math.min(1, k * 2); A.fade = Math.max(0, 1 - Math.max(0, k - 0.5) * 2);
      applyVolume(A); applyVolume(B);
    }
    const bar = $('#fs-dj');
    if (bar) bar.style.setProperty('--mix', Math.min(1, Math.max(0, k)).toFixed(3));
  },

  finish() {
    const p = this.plan;
    clearInterval(this.timer); this.timer = 0;
    if (!p) return;
    const aIdx = p.aIdx, bIdx = 1 - aIdx;
    const A = decks[aIdx], B = decks[bIdx];
    A.pause();
    player.destroyHls(aIdx);
    A.removeAttribute('src');
    A.load();
    A.defaultPlaybackRate = 1;
    A.playbackRate = 1;
    A.fade = 1;
    B.fade = 1;
    applyVolume(A); applyVolume(B);
    // у нового трека пульт возвращается в нейтраль; у старого эхо и ревербератор доигрывают хвост
    eq.resetDeck(bIdx, { keepTrim: true });
    const ctx = eq.ctx;
    if (ctx && eq.fx) {
      const tb = eq.fx[bIdx].trim.gain;
      tb.cancelScheduledValues(ctx.currentTime);
      tb.setValueAtTime(tb.value, ctx.currentTime);
      tb.linearRampToValueAtTime(1, ctx.currentTime + 20);
      const id = player.loadId;
      setTimeout(() => { if (!this.mixing && !this.plan && id === player.loadId) eq.resetDeck(aIdx); }, 9000);
    }
    this.mixing = false;
    this.plan = null;
    document.body.classList.remove('dj-mixing');
    renderDj();
    // темп возвращается к родному плавно, за ~20 секунд — на слух незаметно
    const id = player.loadId, from = B.playbackRate;
    clearInterval(this.ramp);
    if (Math.abs(from - 1) > 0.001) {
      const t0 = performance.now();
      this.ramp = setInterval(() => {
        if (id !== player.loadId || this.mixing) { clearInterval(this.ramp); return; }
        const k = Math.min(1, (performance.now() - t0) / 20000);
        B.playbackRate = from + (1 - from) * k;
        if (k >= 1) { B.defaultPlaybackRate = 1; clearInterval(this.ramp); }
      }, 100);
    } else {
      B.playbackRate = 1;
      B.defaultPlaybackRate = 1;
    }
    this.kick();
  },

  // ручное вмешательство (другой трек, перемотка, пауза): переход сворачивается сразу
  abort() {
    clearInterval(this.timer); this.timer = 0;
    if (this.mixing) {
      const p = this.plan;
      this.finish();
      if (p) { eq.resetDeck(p.aIdx); eq.resetDeck(1 - p.aIdx); }
      return;
    }
    clearInterval(this.ramp);
    if (this.plan) { this.plan = null; this.releaseSpare(); }
  },
};

// пульт деки в нейтраль: всё как без DJ-режима (отменяет и расписанные изменения)
eq.resetDeck = function resetDeck(i, { mix = 1, keepTrim = false } = {}) {
  const f = this.fx && this.fx[i];
  if (!f) return;
  const t = this.ctx.currentTime;
  const put = (param, v) => { param.cancelScheduledValues(t); param.setValueAtTime(v, t); };
  if (!keepTrim) put(f.trim.gain, 1);
  put(f.low.gain, 0); put(f.mid.gain, 0); put(f.high.gain, 0);
  put(f.hp.frequency, 10); put(f.hp.Q, 0.7);
  put(f.mix.gain, mix);
  put(f.echoIn.gain, 0); put(f.fb.gain, 0); put(f.wet.gain, 0); put(f.rvIn.gain, 0);
};

// --- Интерфейс ------------------------------------------------------------------------------------
function renderDj() {
  const badge = $('#fs-dj');
  if (!badge) return;
  const t = player.current;
  const info = dj.enabled && t ? dj.data[t.key] : null;
  const mixing = dj.mixing && dj.plan;
  badge.hidden = !mixing && (!info || !info.bpm);
  badge.classList.toggle('mixing', Boolean(mixing));
  if (mixing) badge.textContent = dj.plan.style === 'blend' ? 'Сведение в такт' : 'Эхо-переход';
  else if (info && info.bpm) badge.textContent = `DJ · ${Math.round(info.bpm * (t && deck().playbackRate || 1))} BPM · ${info.camelot}`;
}

audio.addEventListener('timeupdate', () => dj.tick());
audio.addEventListener('playing', () => { dj.kick(); renderDj(); });
decks.forEach((d, i) => d.addEventListener('seeking', () => {
  // перемотка текущего трека до начала перехода — план пересчитаем заново
  if (dj.plan && !dj.mixing && i === deckIdx) dj.abort();
  else if (dj.mixing && i === deckIdx) { if (dj.selfSeek) dj.selfSeek = false; else dj.abort(); }
}));
renderDj();

// запуск DJ-микса из своей музыки
async function playDjMix() {
  if (!dj.enabled) transitions.set('dj');
  toast('DJ-микс: треки подбираются по темпу и тональности');
  await playAllMy(true);
}
