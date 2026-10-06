/* Сравнение двух версий трека по звуку — для режима «без цензуры».

   Каждая версия превращается в «карту громкости»: уровень звука каждые 50 мс.
   - Карты не похожи вообще → это другая запись (ремикс, live, другая песня) → не подходит.
   - Похожи везде → та же запись (например, перезалитая зацензуренная копия) → не подходит.
   - Похожи везде, кроме нескольких коротких мест, где в лицензионной версии звук заглушён,
     а в другой версии он есть → это версия без цензуры → подходит. */
'use strict';

const WINDOW_SEC = 0.05;

// Карта громкости из AudioBuffer (уровень RMS на каждые 50 мс, все каналы вместе)
function envelopeFromBuffer(buffer) {
  const rate = buffer.sampleRate;
  const step = Math.max(1, Math.round(rate * WINDOW_SEC));
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const count = Math.floor(buffer.length / step);
  const env = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    let sum = 0;
    const start = w * step;
    for (const data of channels) {
      for (let i = start; i < start + step; i++) sum += data[i] * data[i];
    }
    env[w] = Math.sqrt(sum / (step * channels.length));
  }
  return env;
}

function median(values) {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function correlation(a, b, lag) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) {
    const x = a[i], y = b[i + lag];
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  if (n < 20) return 0;
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

function trimmedCorrelation(a, b, lag, trim) {
  const pairs = [];
  for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) pairs.push([a[i], b[i + lag]]);
  if (pairs.length < 20) return 0;
  // убираем пары с самой большой разницей (после приведения средних)
  const ma = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const mb = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  pairs.sort((p, q) => Math.abs((p[0] - ma) - (p[1] - mb)) - Math.abs((q[0] - ma) - (q[1] - mb)));
  const kept = pairs.slice(0, Math.floor(pairs.length * (1 - trim)));
  return correlation(Float32Array.from(kept, (p) => p[0]), Float32Array.from(kept, (p) => p[1]), 0);
}

/* licensed — карта лицензионной (возможно, зацензуренной) версии, other — кандидат.
   Возвращает { verdict: 'uncensored' | 'same' | 'different', corr, spots, lag }. */
function compareEnvelopes(licensed, other) {
  // логарифм громкости с «дном»: заглушённые слова не должны перевешивать сравнение
  const log = (env) => {
    const floor = Math.max(1e-4, median(env) * 0.08);
    return Float32Array.from(env, (v) => Math.log(Math.max(floor, v)));
  };
  const la = log(licensed), lb = log(other);
  // выравнивание: кандидат может начинаться чуть раньше или позже (до ±1,5 с)
  let best = { lag: 0, corr: -1 };
  for (let lag = -30; lag <= 30; lag++) {
    const c = correlation(la, lb, lag);
    if (c > best.corr) best = { lag, corr: c };
  }
  // похожесть записей — без 10% самых непохожих участков (это как раз места цензуры)
  best.corr = trimmedCorrelation(la, lb, best.lag, 0.1);
  if (best.corr < 0.8) return { verdict: 'different', corr: best.corr, spots: 0, lag: best.lag };

  // приводим громкость к одному уровню (копии могут быть тише или громче целиком)
  const ratios = [];
  for (let i = Math.max(0, -best.lag); i < licensed.length && i + best.lag < other.length; i++) {
    if (licensed[i] > 1e-3 && other[i + best.lag] > 1e-3) ratios.push(other[i + best.lag] / licensed[i]);
  }
  const gain = median(ratios) || 1;
  const loudOther = median(other) * 0.25;

  // ищем участки ≥ 200 мс, где в лицензионной версии звук заглушён (тише в 3+ раза),
  // а в кандидате звучит
  let spots = 0, run = 0, spotWindows = 0, total = 0;
  for (let i = Math.max(0, -best.lag); i < licensed.length && i + best.lag < other.length; i++) {
    total++;
    const a = licensed[i] * gain, b = other[i + best.lag];
    const muted = b > loudOther && b > (a + 1e-4) * 3;
    if (muted) {
      run++;
    } else {
      if (run >= 4) { spots++; spotWindows += run; }
      run = 0;
    }
  }
  if (run >= 4) { spots++; spotWindows += run; }
  const share = total ? spotWindows / total : 0;
  const verdict = spots >= 1 && share < 0.15 ? 'uncensored' : 'same';
  return { verdict, corr: best.corr, spots, lag: best.lag, share };
}

if (typeof module !== 'undefined') module.exports = { envelopeFromBuffer, compareEnvelopes };
