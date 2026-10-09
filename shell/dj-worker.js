// Анализ звука для DJ-переходов (в отдельном потоке, чтобы не мешать воспроизведению):
// темп и сетка долей, сильные доли (начало такта), тональность по кругу Камелота, громкость.
// На вход — моно-звук и частота дискретизации; на выход — всё во времени от начала куска.

// --- БПФ (радикс-2, на месте) --------------------------------------------------------------
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function spectra(x, size, hop, each) {
  const win = new Float32Array(size).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const re = new Float32Array(size), im = new Float32Array(size), mag = new Float32Array(size / 2);
  for (let pos = 0, f = 0; pos + size <= x.length; pos += hop, f++) {
    for (let i = 0; i < size; i++) { re[i] = x[pos + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    each(mag, f);
  }
}

// --- Темп и доли -------------------------------------------------------------------------------
function onsets(x, rate) {
  const size = 512, hop = 128;
  const frames = Math.max(0, Math.floor((x.length - size) / hop) + 1);
  const flux = new Float32Array(frames), low = new Float32Array(frames);
  const binHz = rate / size;
  const top = Math.min(size / 2, Math.round(5000 / binHz)), lowTop = Math.max(2, Math.round(160 / binHz));
  let prev = new Float32Array(size / 2);
  spectra(x, size, hop, (mag, f) => {
    let s = 0, l = 0;
    for (let i = 1; i < top; i++) {
      const v = Math.log1p(100 * mag[i]);
      const d = v - prev[i];
      if (d > 0) { s += d; if (i < lowTop) l += d; }
      prev[i] = v;
    }
    // доля — это прежде всего бочка: басовые всплески весят больше, чем хай-хэты между долями
    flux[f] = s / top + 2.5 * l / lowTop; low[f] = l;
  });
  // убираем медленный фон: остаются только всплески (удары)
  const out = new Float32Array(frames), w = 16;
  for (let i = 0; i < frames; i++) {
    let m = 0, c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(frames - 1, i + w); j++) { m += flux[j]; c++; }
    out[i] = Math.max(0, flux[i] - m / c);
  }
  // время кадра — его середина: так всплеск приходится на момент самого удара
  return { env: out, low, hopSec: hop / rate, offset: size / 2 / rate };
}

const at = (a, p) => {
  const i = Math.floor(p);
  if (i < 0 || i + 1 >= a.length) return 0;
  const k = p - i;
  return a[i] * (1 - k) + a[i + 1] * k;
};

function tempo(env, hopSec) {
  const n = env.length;
  if (n < 400) return null;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  const e = env.map((v) => v - mean);
  const ac = (lag) => { let s = 0; for (let i = 0; i + lag < n; i++) s += e[i] * e[i + lag]; return s / (n - lag); };
  const minLag = Math.floor(60 / 185 / hopSec), maxLag = Math.ceil(60 / 68 / hopSec);
  const cache = new Map();
  const A = (l) => { if (!cache.has(l)) cache.set(l, ac(l)); return cache.get(l); };
  let best = -Infinity, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60 / (lag * hopSec);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.85) ** 2);
    const s = (A(lag) + 0.5 * A(2 * lag) + 0.25 * (lag * 4 < n ? A(4 * lag) : 0)) * prior;
    if (s > best) { best = s; bestLag = lag; }
  }
  if (!bestLag) return null;
  // уточняем период и фазу по самой сетке: максимум суммы силы ударов на долях
  let P = bestLag, phase = 0, top = -Infinity;
  for (let p = bestLag * 0.97; p <= bestLag * 1.03; p += bestLag * 0.0015) {
    for (let ph = 0; ph < p; ph += 0.5) {
      let s = 0;
      for (let t = ph; t < n; t += p) s += at(env, t);
      if (s > top) { top = s; P = p; phase = ph; }
    }
  }
  // точная подгонка: ищем пик возле каждой доли и проводим через пики прямую
  const pts = [];
  for (let k = 0, t = phase; t < n; k++, t = phase + k * P) {
    let bi = -1, bv = 0;
    for (let i = Math.max(1, Math.floor(t - P * 0.12)); i <= Math.min(n - 2, Math.ceil(t + P * 0.12)); i++) {
      if (env[i] > bv && env[i] >= env[i - 1] && env[i] >= env[i + 1]) { bv = env[i]; bi = i; }
    }
    if (bi > 0) {
      const a = env[bi - 1], b = env[bi], c = env[bi + 1];
      const d = a - 2 * b + c;
      pts.push({ k, t: bi + (d ? 0.5 * (a - c) / d : 0), w: bv });
    }
  }
  const fit = (list) => {
    let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (const q of list) { sw += q.w; sk += q.w * q.k; st += q.w * q.t; skk += q.w * q.k * q.k; skt += q.w * q.k * q.t; }
    const den = sw * skk - sk * sk;
    if (!den) return null;
    const b = (sw * skt - sk * st) / den;
    return { a: (st - b * sk) / sw, b };
  };
  let line = pts.length > 8 ? fit(pts) : null;
  if (line) {
    const good = pts.filter((q) => Math.abs(q.t - (line.a + line.b * q.k)) < P * 0.08);
    if (good.length > 8) line = fit(good) || line;
    if (Math.abs(line.b / P - 1) < 0.02) { P = line.b; phase = line.a; }
  }
  while (phase < 0) phase += P;
  while (phase >= P) phase -= P;
  // насколько чётко звучат доли (ровный бит — высоко, эмбиент и речь — низко)
  let onBeat = 0, cnt = 0;
  for (let t = phase; t < n; t += P) { onBeat += at(env, t); cnt++; }
  const conf = cnt ? (onBeat / cnt) / (mean || 1) : 0;
  return { period: P * hopSec, first: phase * hopSec, bpm: 60 / (P * hopSec), conf, P, phase };
}

// сильная доля: из четырёх возможных сдвигов выбираем тот, где ударный бас сильнее всего
function downbeat(low, P, phase) {
  const sums = [0, 0, 0, 0];
  for (let k = 0, t = phase; t < low.length; k++, t = phase + k * P) sums[k % 4] += at(low, t) + at(low, t + 1);
  return sums.indexOf(Math.max(...sums));
}

// --- Тональность (профили Крумхансла) -----------------------------------------------------------
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const CAMELOT_MAJOR = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

function corr(a, b) {
  const ma = a.reduce((s, v) => s + v, 0) / 12, mb = b.reduce((s, v) => s + v, 0) / 12;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return num / Math.sqrt(da * db || 1);
}

function key(x, rate) {
  const size = 4096, hop = 2048, binHz = rate / size;
  const chroma = new Float64Array(12);
  const pcs = new Int8Array(size / 2).fill(-1);
  for (let i = 1; i < size / 2; i++) {
    const f = i * binHz;
    if (f < 60 || f > 2000) continue;
    pcs[i] = ((Math.round(12 * Math.log2(f / 440)) + 9) % 12 + 12) % 12;
  }
  spectra(x, size, hop, (mag) => {
    const frame = new Float64Array(12);
    let sum = 0;
    for (let i = 1; i < size / 2; i++) if (pcs[i] >= 0) { frame[pcs[i]] += mag[i]; sum += mag[i]; }
    if (sum > 0) for (let i = 0; i < 12; i++) chroma[i] += Math.sqrt(frame[i] / sum);
  });
  const scores = [];
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + t) % 12]);
    scores.push({ tonic: t, minor: false, r: corr(rot, MAJOR) }, { tonic: t, minor: true, r: corr(rot, MINOR) });
  }
  scores.sort((a, b) => b.r - a.r);
  const best = scores[0];
  return {
    name: NAMES[best.tonic] + (best.minor ? 'm' : ''),
    camelot: `${(best.minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[best.tonic]}${best.minor ? 'A' : 'B'}`,
    conf: best.r - scores[1].r,
  };
}

// --- Громкость: где музыка начинается и кончается ---------------------------------------------
function loudness(x, rate) {
  const step = Math.round(rate * 0.1);
  const db = [];
  for (let i = 0; i + step <= x.length; i += step) {
    let s = 0;
    for (let j = i; j < i + step; j++) s += x[j] * x[j];
    db.push(10 * Math.log10(s / step + 1e-12));
  }
  const sorted = [...db].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] ?? -100;
  const floor = loud - 28;
  const first = db.findIndex((v) => v > floor);
  let last = db.length - 1;
  while (last > 0 && db[last] <= floor) last--;
  const avg = db.length ? db.reduce((s, v) => s + v, 0) / db.length : -100;
  return { firstLoud: Math.max(0, first) * 0.1, lastLoud: (last + 1) * 0.1, energy: avg, loud, db: db.map((v) => Math.round(v * 10) / 10) };
}

self.onmessage = (e) => {
  const { id, samples, rate, wantKey } = e.data;
  try {
    const { env, low, hopSec, offset } = onsets(samples, rate);
    const t = tempo(env, hopSec);
    const res = { ...loudness(samples, rate), duration: samples.length / rate };
    if (t) {
      res.bpm = t.bpm; res.period = t.period; res.first = t.first + offset; res.conf = t.conf;
      if (res.first >= t.period) res.first -= t.period;
      res.downbeat = downbeat(low, t.P, t.phase);
    }
    if (wantKey) res.key = key(samples, rate);
    self.postMessage({ id, ok: true, res });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
