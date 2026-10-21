// VK Player для Android: тот же интерфейс, что в Windows-версии, а вместо основного процесса Electron —
// Android-приложение (AndroidHost). Здесь — window.vkp с теми же методами, что в preload-shell.js.
// Звук для анализа (DJ-режим, поиск версий без цензуры) и скачивание собираются прямо тут:
// плейлист HLS, расшифровка AES-128 (WebCrypto), звук из MPEG-TS.
(function () {
  'use strict';
  const host = window.AndroidHost;
  document.documentElement.classList.add('android');

  // --- связь с приложением ---------------------------------------------------------------------
  const pending = new Map();
  const listeners = {};
  let seq = 0;
  window.__vkpResolve = (id, json) => {
    const done = pending.get(id);
    if (!done) return;
    pending.delete(id);
    let value = null;
    try { value = JSON.parse(json); } catch { value = null; }
    done(value);
  };
  window.__vkpEmit = (channel, json) => {
    let value;
    try { value = json === undefined || json === null ? undefined : JSON.parse(json); } catch { value = json; }
    (listeners[channel] || []).forEach((fn) => { try { fn(value); } catch (err) { console.error(err); } });
  };
  const call = (name, ...args) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    host.call(id, name, JSON.stringify(args));
  });
  const send = (name, ...args) => host.send(name, JSON.stringify(args));
  const on = (channel) => (fn) => { (listeners[channel] = listeners[channel] || []).push(fn); };
  const emit = (channel, value) => window.__vkpEmit(channel, JSON.stringify(value));

  // прямоугольник окна входа: из CSS-пикселей в пиксели экрана считает приложение
  const rectOf = (r) => r && { x: r.x, y: r.y, width: r.width, height: r.height, viewport: window.innerWidth };

  // --- байты --------------------------------------------------------------------------------------
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  };
  async function fetchBytes(url) {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  // --- HLS: плейлист, кусочки, расшифровка, звук из MPEG-TS ---------------------------------------
  async function hlsSegments(playlistUrl) {
    const text = new TextDecoder().decode(await fetchBytes(playlistUrl));
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const variant = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    if (variant >= 0 && lines[variant + 1]) return hlsSegments(new URL(lines[variant + 1], playlistUrl).href);
    const segments = [];
    let key = null, mediaSeq = 0, duration = 0;
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8)) || 0;
      else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = parseInt(line.split(':')[1], 10) || 0;
      else if (line.startsWith('#EXT-X-KEY:')) {
        const method = /METHOD=([^,]+)/.exec(line);
        const uri = /URI="([^"]+)"/.exec(line);
        const iv = /IV=0x([0-9a-f]+)/i.exec(line);
        key = method && method[1] === 'AES-128' && uri ? { uri: new URL(uri[1], playlistUrl).href, iv: iv ? hexBytes(iv[1].padStart(32, '0')) : null } : null;
      } else if (!line.startsWith('#')) {
        segments.push({ url: new URL(line, playlistUrl).href, key, seq: mediaSeq, duration });
        mediaSeq += 1;
      }
    }
    return segments;
  }
  const hexBytes = (hex) => Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
  const seqIv = (n) => { const iv = new Uint8Array(16); for (let i = 15; i >= 0 && n > 0; i--) { iv[i] = n & 0xff; n = Math.floor(n / 256); } return iv; };

  async function fetchSegment(seg, keys) {
    let data = await fetchBytes(seg.url);
    if (seg.key) {
      if (!keys.has(seg.key.uri)) {
        keys.set(seg.key.uri, fetchBytes(seg.key.uri).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
      }
      const key = await keys.get(seg.key.uri);
      data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: seg.key.iv || seqIv(seg.seq) }, key, data));
    }
    return data;
  }

  // звук из MPEG-TS (PES с stream_id 0xC0–0xDF)
  function demuxTs(buf) {
    if (buf[0] !== 0x47) return buf;
    const out = [];
    let audioPid = -1;
    for (let i = 0; i + 188 <= buf.length; i += 188) {
      if (buf[i] !== 0x47) continue;
      const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
      const start = (buf[i + 1] & 0x40) !== 0;
      const afc = (buf[i + 3] >> 4) & 3;
      let off = i + 4;
      if (afc === 2) continue;
      if (afc === 3) off += 1 + buf[off];
      if (off >= i + 188) continue;
      if (start && buf[off] === 0 && buf[off + 1] === 0 && buf[off + 2] === 1) {
        const streamId = buf[off + 3];
        if (audioPid === -1 && streamId >= 0xc0 && streamId <= 0xdf) audioPid = pid;
        if (pid !== audioPid) continue;
        off += 9 + buf[off + 8];
      } else if (pid !== audioPid) continue;
      out.push(buf.subarray(off, i + 188));
    }
    return concat(out);
  }

  // время первого звукового пакета (PTS, 90 кГц) — по нему кусок точно ложится на шкалу трека
  function firstPts(buf) {
    if (buf[0] !== 0x47) return null;
    for (let i = 0; i + 188 <= buf.length; i += 188) {
      if (buf[i] !== 0x47 || !(buf[i + 1] & 0x40)) continue;
      const afc = (buf[i + 3] >> 4) & 3;
      let off = i + 4;
      if (afc === 2) continue;
      if (afc === 3) off += 1 + buf[off];
      if (buf[off] !== 0 || buf[off + 1] !== 0 || buf[off + 2] !== 1) continue;
      const streamId = buf[off + 3];
      if (streamId < 0xc0 || streamId > 0xdf || !(buf[off + 7] & 0x80)) continue;
      const p = buf.subarray(off + 9, off + 14);
      return (p[0] & 0x0e) * 536870912 + p[1] * 4194304 + (p[2] & 0xfe) * 16384 + p[3] * 128 + (p[4] >> 1);
    }
    return null;
  }

  async function fetchAudioData(url, onProgress = () => {}, maxSeconds = 0) {
    if (!/\.m3u8/.test(url)) return fetchBytes(url);
    let segments = await hlsSegments(url);
    if (maxSeconds > 0) {
      let total = 0;
      segments = segments.filter((seg) => { const keep = total < maxSeconds; total += seg.duration || 10; return keep; });
    }
    const keys = new Map();
    const parts = new Array(segments.length);
    let done = 0, next = 0;
    const worker = async () => {
      while (next < segments.length) {
        const index = next++;
        parts[index] = demuxTs(await fetchSegment(segments[index], keys));
        done += 1;
        onProgress(done / segments.length);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return concat(parts);
  }

  async function fetchAudioWindow(url, start, seconds) {
    if (!/\.m3u8/.test(url)) return { data: await fetchBytes(url), startTime: 0, whole: true };
    const segments = await hlsSegments(url);
    let t = 0, firstIndex = -1, approx = 0;
    const picked = [];
    segments.forEach((seg, i) => {
      const d = seg.duration || 10;
      if (t + d > start && t < start + seconds) { if (firstIndex < 0) { firstIndex = i; approx = t; } picked.push(seg); }
      t += d;
    });
    if (!picked.length) throw new Error('в треке нет такого куска');
    const keys = new Map();
    const raw = await Promise.all(picked.map((seg) => fetchSegment(seg, keys)));
    let startTime = approx;
    const ptsWin = firstPts(raw[0]);
    if (ptsWin !== null) {
      const pts0 = firstIndex === 0 ? ptsWin : firstPts(await fetchSegment(segments[0], keys));
      if (pts0 !== null) {
        let diff = ptsWin - pts0;
        if (diff < 0) diff += 2 ** 33;
        startTime = diff / 90000;
      }
    }
    return { data: concat(raw.map(demuxTs)), startTime };
  }

  // --- скачивание в MP3 с тегами --------------------------------------------------------------------
  function id3Tag({ title, artist, album }, cover) {
    const frame = (id, body) => {
      const head = new Uint8Array(10);
      for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
      new DataView(head.buffer).setUint32(4, body.length);
      return concat([head, body]);
    };
    const text = (id, value) => {
      if (!value) return new Uint8Array(0);
      const s = String(value);
      const body = new Uint8Array(3 + s.length * 2 + 2);
      body[0] = 1; body[1] = 0xff; body[2] = 0xfe;
      for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); body[3 + i * 2] = c & 0xff; body[4 + i * 2] = c >> 8; }
      return frame(id, body);
    };
    const frames = [text('TIT2', title), text('TPE1', artist), text('TALB', album)];
    if (cover) {
      const mime = new TextEncoder().encode('image/jpeg\0');
      frames.push(frame('APIC', concat([new Uint8Array([0]), mime, new Uint8Array([3, 0]), cover])));
    }
    const content = concat(frames);
    const size = content.length;
    return concat([new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]), content]);
  }

  // файл передаём приложению кусками в base64 — оно кладёт его в «Музыку» или «Загрузки»
  function saveBytes(name, mime, folder, bytes) {
    const handle = host.saveBegin(name, mime, folder);
    if (!handle) throw new Error('не удалось создать файл');
    const step = 3 * 128 * 1024;
    for (let off = 0; off < bytes.length; off += step) {
      const chunk = bytes.subarray(off, off + step);
      let bin = '';
      for (let i = 0; i < chunk.length; i += 0x8000) bin += String.fromCharCode.apply(null, chunk.subarray(i, i + 0x8000));
      if (!host.saveChunk(handle, btoa(bin))) throw new Error('не удалось записать файл');
    }
    return host.saveEnd(handle);
  }

  async function download(info) {
    const progress = (p) => emit('download-progress', { key: info.key, progress: p });
    progress(0);
    const audio = await fetchAudioData(info.url, progress);
    const isAac = audio[0] === 0xff && (audio[1] & 0xf6) === 0xf0;
    const cover = info.cover ? await fetchBytes(info.cover).catch(() => null) : null;
    const safe = `${info.artist} - ${info.title}`.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 150) || 'track';
    const file = saveBytes(`${safe}.${isAac ? 'aac' : 'mp3'}`, isAac ? 'audio/aac' : 'audio/mpeg', 'music', concat([id3Tag(info, cover), audio]));
    progress(1);
    return { ok: true, path: file };
  }

  // --- тексты: LRCLIB и Genius ------------------------------------------------------------------------
  const httpText = (url, accept) => call('httpText', url, accept || 'text/html').then((r) => (r && r.text) || null);
  const clean = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const firstArtist = (artist) => String(artist || '').split(/,|&| feat\.?| ft\.?| x /i)[0].trim();
  const bare = (title) => String(title || '').replace(/\(.*?\)|\[.*?\]/g, '').trim();

  async function lrclibLyrics({ artist, title, duration }) {
    const wantTitle = clean(title), wantArtist = clean(firstArtist(artist));
    for (const q of [`${firstArtist(artist)} ${bare(title)}`, bare(title)]) {
      let items = [];
      try { items = JSON.parse(await httpText(`https://lrclib.net/api/search?q=${encodeURIComponent(q.trim())}`, 'application/json')) || []; } catch { items = []; }
      const ok = items.filter((x) => {
        const t = clean(x.trackName);
        return (t === wantTitle || t.startsWith(wantTitle + ' ')) && clean(x.artistName).includes(wantArtist)
          && (!duration || !x.duration || Math.abs(x.duration - duration) <= 6) && (x.syncedLyrics || x.plainLyrics);
      });
      const best = ok.find((x) => x.syncedLyrics) || ok[0];
      if (best) return { synced: best.syncedLyrics || null, plain: best.plainLyrics || null };
    }
    return null;
  }

  async function geniusSearch(q) {
    try {
      const data = JSON.parse(await httpText(`https://genius.com/api/search/multi?q=${encodeURIComponent(q)}`, 'application/json'));
      return (data.response.sections || []).flatMap((s) => s.hits || []).filter((h) => h.type === 'song').map((h) => h.result);
    } catch { return []; }
  }

  async function geniusFind({ artist, title }) {
    const wantTitle = clean(title), wantArtist = clean(firstArtist(artist));
    const titleOk = (h) => { const t = clean(h.title); return t === wantTitle || t.startsWith(wantTitle + ' ') || t.includes(wantTitle); };
    const artistOk = (h) => [h.primary_artist && h.primary_artist.name, h.artist_names].map(clean).join(' ').includes(wantArtist);
    for (const q of [`${firstArtist(artist)} ${bare(title)}`.trim(), bare(title)]) {
      const hits = await geniusSearch(q);
      const best = hits.find((h) => titleOk(h) && artistOk(h)) || hits.find((h) => artistOk(h) && clean(h.title).split(' ')[0] === wantTitle.split(' ')[0]);
      if (best) return best.url;
    }
    return null;
  }

  function divEnd(html, from) {
    const tag = /<\/?div\b[^>]*>/g;
    tag.lastIndex = from;
    let depth = 1, t;
    while ((t = tag.exec(html))) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (!depth) return { close: t.index, after: tag.lastIndex };
    }
    return null;
  }

  function geniusParseHtml(html) {
    const parts = [];
    const re = /<div[^>]*data-lyrics-container="true"[^>]*>/g;
    let m;
    while ((m = re.exec(html))) {
      const end = divEnd(html, re.lastIndex);
      if (!end) break;
      let chunk = html.slice(re.lastIndex, end.close);
      for (let x; (x = /<div[^>]*data-exclude-from-selection="true"[^>]*>/.exec(chunk));) {
        const e = divEnd(chunk, x.index + x[0].length);
        chunk = chunk.slice(0, x.index) + (e ? chunk.slice(e.after) : '');
      }
      parts.push(chunk);
      re.lastIndex = end.after;
    }
    if (!parts.length) return null;
    const box = document.createElement('textarea');
    box.innerHTML = parts.join('\n').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
    return box.value;
  }

  function cleanLyricLines(text) {
    const lines = String(text).split('\n').map((l) => l.trim())
      .filter((l) => !/^\[(текст песни|lyrics)(\s|$)[^\]]*\]$/i.test(l) && !/^\d+\s+contributors?/i.test(l) && !/^translations?$/i.test(l));
    while (lines.length && !lines[0]) lines.shift();
    return lines.filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim()));
  }

  async function geniusLyrics(info) {
    const url = await geniusFind(info);
    if (!url) return null;
    const html = await httpText(url);
    const text = html ? geniusParseHtml(html) : null;
    if (!text) return { url, lines: null, error: 'страница Genius не открылась' };
    const lines = cleanLyricLines(text);
    return { url, lines: lines.length ? lines : null };
  }

  // --- состояние воспроизведения — для медиасессии (кнопки на руле, шторка) ---------------------------
  let lastPlaying = null;
  setInterval(() => {
    let playing = false;
    try { playing = typeof audio !== 'undefined' && !audio.paused; } catch { playing = false; }
    if (playing !== lastPlaying) { lastPlaying = playing; send('playState', playing); }
  }, 700);

  // --- window.vkp: те же методы, что в Windows-версии ---------------------------------------------
  window.vkp = {
    platform: 'android',
    api: (method, params, options) => call('api', method, params || {}, options || {}),
    authState: () => call('authState'),
    login: (rect) => send('login', rectOf(rect)),
    loginBounds: (rect) => send('loginBounds', rectOf(rect)),
    loginCancel: () => send('loginCancel'),
    logout: () => send('logout'),
    window: (action) => send('window', action),
    download: (info) => download(info).catch((err) => ({ ok: false, error: err.message })),
    showFile: () => {},
    audioData: (url, maxSeconds) => fetchAudioData(url, () => {}, Number(maxSeconds) || 0)
      .then((data) => ({ ok: true, data }), (err) => ({ ok: false, error: err.message })),
    audioWindow: (url, start, seconds) => fetchAudioWindow(url, Number(start) || 0, Number(seconds) || 40)
      .then((r) => ({ ok: true, startTime: r.startTime, whole: Boolean(r.whole), data: r.data }), (err) => ({ ok: false, error: err.message })),
    geniusLyrics: (info) => geniusLyrics(info).catch((err) => ({ lines: null, error: String(err && err.message || err) })),
    lrclibLyrics: (info) => lrclibLyrics(info).catch(() => null),
    saveReport: async (text) => saveBytes(`vkplayer-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`, 'text/plain', 'downloads', new TextEncoder().encode(String(text))),
    resetNetwork: () => Promise.resolve(true),
    installUpdate: () => send('openUpdate'),
    openUpdatePage: () => send('openUpdate'),
    onUpdateState: on('update-state'),
    geniusOpen: async (info) => {
      const url = await geniusFind(info).catch(() => null);
      send('openUrl', url || `https://genius.com/search?q=${encodeURIComponent(`${info.artist} ${info.title}`)}`);
    },
    onDownloadProgress: on('download-progress'),
    trackTitle: (title) => send('trackTitle', String(title || '')),
    ready: () => send('ready'),
    onAuthChanged: on('auth-changed'),
    onLoginClosed: on('login-closed'),
    onWindowState: on('window-state'),
    onMedia: on('media'),
    onWindowVisible: on('window-visible'),
    onFocusSearch: on('focus-search'),
  };
})();
