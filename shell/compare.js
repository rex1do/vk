/* Сравнение двух версий трека по звуку — для режима «без цензуры».

   Обе версии декодируются в моно 8 кГц и выравниваются с точностью до отсчёта.
   Дальше сравниваются сами звуковые волны окнами по 50 мс:
   - одна и та же запись (даже перекодированная, тише или громче) совпадает почти идеально;
   - там, где в лицензионной версии слово заглушено или перевёрнуто, волны не совпадают;
   - другая запись (ремикс, live, ускоренная, другая песня) не совпадает почти нигде.
   Вердикт:
   - 'uncensored' — та же запись, но есть короткие места, где лицензия отличается (цензура);
   - 'same'       — та же запись без отличий (перезалитая зацензуренная копия);
   - 'different'  — другая запись. */
'use strict';

const RATE = 8000;
const WIN = 400; // 50 мс при 8 кГц

// Моно-сигнал из AudioBuffer (каналы усредняются)
function monoFromBuffer(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const ch = buffer.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

// Громкость (RMS) по окнам 50 мс
function envelope(x) {
  const count = Math.floor(x.length / WIN);
  const env = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    let s = 0;
    for (let i = w * WIN, e = i + WIN; i < e; i++) s += x[i] * x[i];
    env[w] = Math.sqrt(s / WIN);
  }
  return env;
}

function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function corrAt(a, b, lag) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) {
    const x = a[i], y = b[i + lag];
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 40) return -1;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : -1;
}

// Грубое выравнивание по громкости: сдвиг до ±maxSec секунд (в окнах по 50 мс)
function coarseLag(ea, eb, maxSec) {
  const log = (env) => {
    const floor = Math.max(1e-4, median(env) * 0.1);
    return Float32Array.from(env, (v) => Math.log(Math.max(floor, v)));
  };
  const la = log(ea), lb = log(eb);
  const max = Math.round(maxSec * RATE / WIN);
  let best = { lag: 0, corr: -1 };
  for (let lag = -max; lag <= max; lag++) {
    const c = corrAt(la, lb, lag);
    if (c > best.corr) best = { lag, corr: c };
  }
  return best;
}

// Точное выравнивание по самой волне: перебор ±range отсчётов вокруг грубого сдвига
// на нескольких громких кусках трека
function fineLag(a, b, ea, approx, range = 600) {
  const loud = median(ea);
  const chunks = [];
  const step = Math.max(1, Math.floor(ea.length / 7));
  for (let w = step; w < ea.length - 40 && chunks.length < 5; w += step) {
    if (ea[w] > loud) chunks.push(w * WIN);
  }
  if (!chunks.length) chunks.push(Math.floor(a.length / 2));
  const len = 4000; // 0,5 с
  let best = { lag: approx, score: -Infinity };
  for (let lag = approx - range; lag <= approx + range; lag++) {
    let s = 0;
    for (const start of chunks) {
      if (start + lag < 0 || start + len + lag > b.length || start + len > a.length) continue;
      for (let i = start, e = start + len; i < e; i++) s += a[i] * b[i + lag];
    }
    if (s > best.score) best = { lag, score: s };
  }
  return best.lag;
}

/* licensed — лицензионная (возможно, зацензуренная) версия, other — кандидат.
   Оба — моно Float32Array 8 кГц. Возвращает
   { verdict, corr (доля совпавших окон), spots (мест цензуры), lag (сдвиг, с) }. */
function compareAudio(licensed, other, { maxShiftSec = 12 } = {}) {
  const ea = envelope(licensed), eb = envelope(other);
  if (ea.length < 60 || eb.length < 60) return { verdict: 'different', corr: 0, spots: 0, lag: 0 };
  const coarse = coarseLag(ea, eb, maxShiftSec);
  const lag = fineLag(licensed, other, ea, coarse.lag * WIN);

  const quietA = median(ea) * 0.05, quietB = median(eb) * 0.05;
  const loudB = median(eb) * 0.2;
  const total = Math.floor((Math.min(licensed.length, other.length - lag) - Math.max(0, -lag)) / WIN);
  const startA = Math.max(0, -lag);
  // окна у краёв (вступление, концовка) не считаем: там копии часто обрезаны иначе
  const edge = 60; // 3 с
  const marks = new Int8Array(Math.max(0, total)); // 1 — совпало, -1 — лицензия отличается, 0 — тишина/край
  let matched = 0, counted = 0;
  for (let w = 0; w < total; w++) {
    const i0 = startA + w * WIN;
    let ab = 0, aa = 0, bb = 0;
    for (let i = i0, e = i0 + WIN; i < e; i++) {
      const x = licensed[i], y = other[i + lag];
      ab += x * y; aa += x * x; bb += y * y;
    }
    const ra = Math.sqrt(aa / WIN), rb = Math.sqrt(bb / WIN);
    if (ra < quietA && rb < quietB) continue; // тишина в обеих
    if (w < edge || w >= total - edge) continue;
    counted++;
    const ncc = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
    if (ncc > 0.6) { marks[w] = 1; matched++; } else if (rb > loudB) marks[w] = -1; // у кандидата здесь звук есть
  }
  const share = counted ? matched / counted : 0;
  if (share < 0.55) return { verdict: 'different', corr: share, spots: 0, lag: lag / RATE };

  // места цензуры: подряд ≥ 3 окон (150 мс) несовпадения, разрывы в 1 окно допускаются
  let spots = 0, spotWindows = 0, run = 0, gap = 0;
  const close = () => { if (run >= 3 && run <= 80) { spots++; spotWindows += run; } run = 0; gap = 0; };
  for (let w = 0; w < total; w++) {
    if (marks[w] === -1) { run++; gap = 0; } else if (run && gap < 1 && marks[w] !== 1) { gap++; } else if (run) close();
  }
  close();
  const spotShare = counted ? spotWindows / counted : 0;
  const verdict = spots >= 1 && spotShare < 0.35 ? 'uncensored' : 'same';
  return { verdict, corr: share, spots, lag: lag / RATE };
}

// для совместимости со старым кодом: карта громкости из AudioBuffer
function envelopeFromBuffer(buffer) { return envelope(monoFromBuffer(buffer)); }

if (typeof module !== 'undefined') module.exports = { monoFromBuffer, compareAudio, envelope, envelopeFromBuffer, RATE };
