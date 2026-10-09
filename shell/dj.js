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
    Object.assign(p, { simple: true, beatmatched: false, r: 1, pA: 0.5, L: 16, startB: 0, entryB: 8, exitA: A.duration - 0.5, outro: false, drop: false });
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
      diag.add('dj', `${cur.title} → ${next.title}: ${ra.bpm ? ra.bpm.toFixed(1) : '?'} → ${rb.bpm ? rb.bpm.toFixed(1) : '?'} BPM, ${p.beatmatched ? `сведение ×${p.r.toFixed(3)}` : 'без подгонки темпа'}; наложение ${p.L} долей с ${p.startA.toFixed(1)} с (уходим на ${p.exitA.toFixed(1)} с из ${A.duration.toFixed(0)}${p.outro ? ', перед аутро' : ''}), новый с ${p.startB.toFixed(1)} с, вход на ${p.entryB.toFixed(1)} с${p.drop ? ' (после вступления)' : ''}`);
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
    // --- длина наложения: сколько долей вступления B помещается (максимум 32, минимум 8)
    let L = beatmatched ? (pA * 32 <= 20 ? 32 : 16) : 4;
    const fitB = Math.floor(entryB / (pA * r) / 4) * 4; // долей A до входа B
    L = Math.min(L, Math.max(4, fitB));
    if (!beatmatched) L = Math.min(L, 8);
    const startA = exitA - L * pA;
    const startB = Math.max(0, entryB - L * pA * r);
    return { beatmatched, r, pA, L, startA, startB, exitA, entryB, endA, outro, drop };
  },

  // готовим следующий трек на запасной деке: на нужной секунде, на паузе, с нужным темпом
  loadSpare(url, at, rate) {
    const i = 1 - deckIdx;
    const d = decks[i];
    clearInterval(d.fadeTimer); d.fadeTimer = 0;
    d.pause();
    player.destroyHls(i);
    d.fade = 0;
    applyVolume(d);
    eq.deckFx(i, { low: -26, hp: 10 });
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
    eq.deckFx(i, { low: 0, hp: 10 });
  },

  start() {
    const p = this.plan;
    clearInterval(this.timer); this.timer = 0;
    const aIdx = deckIdx;
    const B = decks[1 - aIdx];
    this.mixing = true;
    p.aIdx = aIdx;
    B.play().catch(() => {});
    // плеер переходит на следующий трек сразу: уже играющая запасная дека становится основной
    this.takeover = { track: p.next, deck: 1 - aIdx, substitute: p.src.substitute };
    player.pos = p.nextPos;
    player.load();
    p.lastFix = 0;
    p.err = 0;
    this.timer = setInterval(() => this.mixTick(), 25);
  },

  mixTick() {
    const p = this.plan;
    if (!p) return;
    const A = decks[p.aIdx], B = decks[1 - p.aIdx];
    const el = A.currentTime - p.startA;
    const k = el / (p.L * p.pA);
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
    // громкость: вступление B плавно поднимается под A (без баса), A держится и в последней
    // четверти стихает; на входе B — на сильной доле — бас переходит к нему
    const kin = Math.min(1, Math.max(0, k / 0.6));
    const kout = Math.min(1, Math.max(0, (k - 0.6) / 0.4));
    const soft = Math.min(1, el / (2 * p.pA)); // первые две доли — мягкий вход, без щелчка
    B.fade = p.beatmatched ? soft * (0.35 + 0.65 * Math.sin(kin * Math.PI / 2)) : Math.sin(Math.min(1, k) * Math.PI / 2);
    A.fade = Math.cos(kout * Math.PI / 2);
    applyVolume(A); applyVolume(B);
    if (k >= 0.5) eq.deckFx(p.aIdx, { hp: 20 * Math.pow(15, Math.min(1, (k - 0.5) / 0.5)) });
    if (k >= 0.97 && !p.swapped) {
      p.swapped = true;
      eq.deckFx(1 - p.aIdx, { low: 0 }, 0.02);
      eq.deckFx(p.aIdx, { low: -26 }, 0.02);
    }
  },

  finish() {
    const p = this.plan;
    clearInterval(this.timer); this.timer = 0;
    if (!p) return;
    const A = decks[p.aIdx], B = decks[1 - p.aIdx];
    A.pause();
    player.destroyHls(p.aIdx);
    A.removeAttribute('src');
    A.load();
    A.defaultPlaybackRate = 1;
    A.playbackRate = 1;
    A.fade = 1;
    eq.deckFx(p.aIdx, { low: 0, hp: 10 });
    eq.deckFx(1 - p.aIdx, { low: 0, hp: 10 });
    B.fade = 1;
    applyVolume(B);
    this.mixing = false;
    this.plan = null;
    // темп возвращается к родному плавно, за ~12 секунд — на слух незаметно
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
    if (this.mixing) { this.finish(); return; }
    clearInterval(this.ramp);
    if (this.plan) { this.plan = null; this.releaseSpare(); }
  },
};

// цепочка эквалайзера с отдельными фильтрами на каждую деку
eq.deckFx = function deckFx(i, { low, hp }, tau = 0) {
  const fx = this.fx && this.fx[i];
  if (!fx) return;
  const t = this.ctx.currentTime;
  if (low !== undefined) { if (tau) fx.low.gain.setTargetAtTime(low, t, tau); else { fx.low.gain.cancelScheduledValues(t); fx.low.gain.value = low; } }
  if (hp !== undefined) { fx.hp.frequency.cancelScheduledValues(t); fx.hp.frequency.value = hp; }
};

// --- Интерфейс ------------------------------------------------------------------------------------
function renderDj() {
  const badge = $('#fs-dj');
  if (!badge) return;
  const t = player.current;
  const info = dj.enabled && t ? dj.data[t.key] : null;
  badge.hidden = !info || !info.bpm;
  if (info && info.bpm) badge.textContent = `DJ · ${Math.round(info.bpm * (t && deck().playbackRate || 1))} BPM · ${info.camelot}`;
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
