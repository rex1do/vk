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

// Низкие частоты (до ~1,5 кГц): их перекодирование и небольшая разница скорости почти не портят
function lowpass(x) {
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) { s += x[i] - (i >= 4 ? x[i - 4] : 0); y[i] = s / 4; }
  const z = new Float32Array(x.length);
  s = 0;
  for (let i = 0; i < y.length; i++) { s += y[i] - (i >= 4 ? y[i - 4] : 0); z[i] = s / 4; }
  return z;
}

// Сдвиг по ходу трека: копии бывают чуть быстрее/медленнее (2:07 и 2:05) или с другими паузами.
// Сдвиг ищется каждые 2,5 с около предыдущего, между точками — плавно.
const CHUNK = 2.5 * 8000;
function trackLags(a, b, ea, startLag) {
  const PROBE = 4000;
  const points = []; // [центр куска, сдвиг]
  let lag = startLag;
  const loud = median(ea);
  for (let c = 0; c * CHUNK < a.length; c++) {
    let from = -1, best = -1;
    for (let w = Math.floor(c * CHUNK / WIN); w < Math.min(ea.length, Math.floor((c * CHUNK + CHUNK - PROBE) / WIN)); w++) {
      if (ea[w] > best) { best = ea[w]; from = w * WIN; }
    }
    if (from >= 0 && best > loud * 0.3 && from + PROBE <= a.length) {
      const range = c === 0 ? 800 : 450;
      let top = { lag, score: -Infinity };
      for (let l = lag - range; l <= lag + range; l++) {
        if (from + l < 0 || from + PROBE + l > b.length) continue;
        let sum = 0, bb = 0;
        for (let i = from, e = from + PROBE; i < e; i++) { const y = b[i + l]; sum += a[i] * y; bb += y * y; }
        const score = bb > 0 ? sum / Math.sqrt(bb) : -Infinity;
        if (score > top.score) top = { lag: l, score };
      }
      lag = top.lag;
      points.push([from + PROBE / 2, lag]);
    }
  }
  if (!points.length) points.push([0, startLag]);
  return (pos) => {
    if (pos <= points[0][0]) return points[0][1];
    for (let k = 1; k < points.length; k++) {
      if (pos <= points[k][0]) {
        const [x0, y0] = points[k - 1], [x1, y1] = points[k];
        return Math.round(y0 + (y1 - y0) * (pos - x0) / (x1 - x0));
      }
    }
    return points[points.length - 1][1];
  };
}

/* licensed — лицензионная (возможно, зацензуренная) версия, other — кандидат.
   Оба — моно Float32Array 8 кГц. Возвращает
   { verdict, corr (доля совпавших окон), spots (мест цензуры), lag (сдвиг, с), level (громкость кандидата в местах отличий) }. */
// Растяжение сигнала в f раз (линейная интерполяция)
function stretch(x, f) {
  const n = Math.floor(x.length * f);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i / f, k = Math.floor(p), t = p - k;
    y[i] = k + 1 < x.length ? x[k] * (1 - t) + x[k + 1] * t : x[x.length - 1];
  }
  return y;
}

// Если копия чуть быстрее/медленнее (другая скорость, 2:07 и 2:05), подбираем множитель по громкости
function guessSpeed(a, b) {
  const ea = envelope(a), eb = envelope(b);
  let best = { f: 1, corr: coarseLag(ea, eb, 12).corr };
  for (let f = 0.97; f <= 1.0301; f += 0.002) {
    if (Math.abs(f - 1) < 0.001) continue;
    const c = coarseLag(ea, envelope(stretch(b, f)), 12).corr;
    if (c > best.corr + 0.02) best = { f, corr: c };
  }
  return best.f;
}

function compareAudio(licensedRaw, otherRaw, opts = {}) {
  const first = compareOnce(licensedRaw, otherRaw, opts);
  if (first.verdict !== 'different' || opts.noSpeed) return first;
  const f = guessSpeed(licensedRaw, otherRaw);
  if (f === 1) return first;
  const second = compareOnce(licensedRaw, stretch(otherRaw, f), opts);
  return second.verdict === 'different' ? first : { ...second, speed: f };
}

function compareOnce(licensedRaw, otherRaw, { maxShiftSec = 12 } = {}) {
  const licensed = lowpass(licensedRaw), other = lowpass(otherRaw);
  const ea = envelope(licensed), eb = envelope(other);
  if (ea.length < 60 || eb.length < 60) return { verdict: 'different', corr: 0, spots: 0, lag: 0 };
  const coarse = coarseLag(ea, eb, maxShiftSec);
  const start = fineLag(licensed, other, ea, coarse.lag * WIN);
  const lagAt = trackLags(licensed, other, ea, start);

  const quietA = median(ea) * 0.05, quietB = median(eb) * 0.05;
  const total = ea.length;
  const edge = 60; // 3 с по краям не считаем: копии часто обрезаны иначе
  const marks = new Int8Array(total); // 1 — совпало, -1 — отличается
  const rA = new Float32Array(total), rB = new Float32Array(total);
  let matched = 0, counted = 0;
  for (let w = edge; w < total - edge; w++) {
    const i0 = w * WIN;
    const lag = lagAt(i0 + WIN / 2);
    if (i0 + lag < 0 || i0 + WIN + lag > other.length) continue;
    let ab = 0, aa = 0, bb = 0;
    for (let i = i0, e = i0 + WIN; i < e; i++) {
      const x = licensed[i], y = other[i + lag];
      ab += x * y; aa += x * x; bb += y * y;
    }
    const ra = Math.sqrt(aa / WIN), rb = Math.sqrt(bb / WIN);
    rA[w] = ra; rB[w] = rb;
    if (ra < quietA && rb < quietB) continue;
    counted++;
    const ncc = aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
    // та же запись совпадает почти идеально; бит без голоса или другой микс — заметно хуже
    if (ncc > 0.85) { marks[w] = 1; matched++; } else marks[w] = -1;
  }
  const share = counted ? matched / counted : 0;
  const lagSec = lagAt(0) / RATE;
  if (share < 0.5) return { verdict: 'different', corr: share, spots: 0, lag: lagSec };

  // громкость кандидата относительно лицензии там, где совпадает, и там, где отличается
  const ratios = [], diffRatios = [];
  for (let w = 0; w < total; w++) {
    if (!rA[w]) continue;
    if (marks[w] === 1) ratios.push(rB[w] / rA[w]);
    else if (marks[w] === -1) diffRatios.push(rB[w] / rA[w]);
  }
  const gain = median(ratios) || 1;
  // цензура: в лицензии слово заглушено (кандидат громче) или перевёрнуто (вровень);
  // если в местах отличий кандидат тише — в нём нет голоса (бит, минус), это другая запись
  const level = diffRatios.length ? median(diffRatios) / gain : 1;

  // места: подряд ≥ 3 окон (150 мс) несовпадения, разрыв в 1 окно допускается
  let spots = 0, spotWindows = 0, run = 0, gap = 0;
  const close = () => { if (run >= 3 && run <= 80) { spots++; spotWindows += run; } run = 0; gap = 0; };
  for (let w = 0; w < total; w++) {
    if (marks[w] === -1) { run++; gap = 0; } else if (run && gap < 1 && marks[w] === 0) { gap++; } else if (run) close();
  }
  close();
  const spotShare = counted ? spotWindows / counted : 0;
  if (spots >= 1 && level < 0.95) return { verdict: 'different', corr: share, spots, lag: lagSec, level };
  const verdict = spots >= 1 && spotShare < 0.35 ? 'uncensored' : 'same';
  return { verdict, corr: share, spots, lag: lagSec, level };
}

// для совместимости со старым кодом: карта громкости из AudioBuffer
function envelopeFromBuffer(buffer) { return envelope(monoFromBuffer(buffer)); }

if (typeof module !== 'undefined') module.exports = { monoFromBuffer, compareAudio, envelope, envelopeFromBuffer, RATE };
