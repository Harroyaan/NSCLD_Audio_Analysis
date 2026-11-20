(function (global) {
  'use strict';

  const DSP = {};
  const A_FREQS = [31.5, 63, 100, 200, 400, 800, 1000, 2000, 3150, 4000, 5000, 6300, 7100, 8000, 9000, 10000, 12500, 14000, 16000, 20000, 31500];
  const BS_FREQS = A_FREQS.slice();
  const BS_RESP = [-29.9, -23.9, -19.8, -13.8, -7.8, -1.9, 0, 5.6, 9, 10.5, 11.7, 12.2, 12, 11.4, 10.1, 8.1, 0, -5.3, -11.7, -22.2, -42.7];
  const WINDOW_NAMES = ['Hann', 'Blackman', 'Blackman-Harris', 'Hamming', 'FlatTop', '矩形'];

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function db(v) { return v > 1e-300 ? 20 * Math.log10(v) : -300; }
  function clampDb(v) { return v < -300 || !isFinite(v) ? -300 : v; }

  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function prevPow2(n) {
    let p = 1;
    while (p * 2 <= n) p <<= 1;
    return p;
  }

  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(angle), wi = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ar = re[i + k], ai = im[i + k];
          const br = re[i + k + len / 2], bi = im[i + k + len / 2];
          const tr = br * cr - bi * ci, ti = br * ci + bi * cr;
          re[i + k] = ar + tr; im[i + k] = ai + ti;
          re[i + k + len / 2] = ar - tr; im[i + k + len / 2] = ai - ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  function makeWindow(kind, n) {
    const w = new Float64Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const x = n <= 1 ? 0 : 2 * Math.PI * i / (n - 1);
      let v = 1;
      switch (kind) {
        case 'Blackman': v = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x); break;
        case 'Blackman-Harris': v = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x); break;
        case 'Hamming': v = 0.54 - 0.46 * Math.cos(x); break;
        case 'FlatTop':
          v = 0.21557895 - 0.41663158 * Math.cos(x) + 0.277263158 * Math.cos(2 * x)
            - 0.083578947 * Math.cos(3 * x) + 0.006947368 * Math.cos(4 * x);
          break;
        case '矩形': v = 1; break;
        default: v = 0.5 - 0.5 * Math.cos(x);
      }
      w[i] = v; sum += v;
    }
    let enbw = 0;
    for (let i = 0; i < n; i++) enbw += w[i] * w[i];
    enbw = n * enbw / (sum * sum);
    return { w: w, coherentGain: sum / n, enbw: enbw };
  }

  function aWeightDb(f) {
    if (f <= 0) return -300;
    const f2 = f * f;
    const num = 12194 * 12194 * f2 * f2;
    const den = (f2 + 20.6 * 20.6)
      * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9))
      * (f2 + 12194 * 12194);
    return 20 * Math.log10(num / den) + 2.0;
  }

  function bs468Db(f) {
    if (f <= BS_FREQS[0]) return BS_RESP[0];
    if (f >= BS_FREQS[BS_FREQS.length - 1]) return BS_RESP[BS_RESP.length - 1];
    for (let i = 1; i < BS_FREQS.length; i++) {
      if (f <= BS_FREQS[i]) {
        const t = (Math.log(f) - Math.log(BS_FREQS[i - 1]))
          / (Math.log(BS_FREQS[i]) - Math.log(BS_FREQS[i - 1]));
        return BS_RESP[i - 1] + t * (BS_RESP[i] - BS_RESP[i - 1]);
      }
    }
    return 0;
  }

  function genericFilterDb(filter, f) {
    if (!filter || !filter.kind || filter.kind === 'none') return 0;
    if (filter.kind === 'A') return aWeightDb(f);
    if (filter.kind === 'BS468') return bs468Db(f);
    const nyq = Math.max(1, filter.fs / 2);
    f = clamp(f, 1e-9, nyq);
    const order = Math.max(1, filter.order || 2);
    if (filter.kind === 'lowpass') {
      const fc = clamp(filter.cutoff || 1000, 1, nyq);
      return -10 * Math.log10(1 + Math.pow(f / fc, 2 * order));
    }
    if (filter.kind === 'highpass') {
      const fc = clamp(filter.cutoff || 1000, 1, nyq);
      return -10 * Math.log10(1 + Math.pow(fc / f, 2 * order));
    }
    const fc = clamp(filter.center || 1000, 1, nyq);
    const bw = clamp(filter.bandwidth || Math.max(1, fc / Math.max(0.1, filter.q || 1)), 1, nyq);
    if (filter.kind === 'bandpass') {
      const lo = Math.max(1, fc - bw / 2), hi = Math.min(nyq, fc + bw / 2);
      const hp = f < lo ? -10 * Math.log10(1 + Math.pow(lo / f, 2 * order)) : 0;
      const lp = f > hi ? -10 * Math.log10(1 + Math.pow(f / hi, 2 * order)) : 0;
      return hp + lp;
    }
    if (filter.kind === 'notch') {
      const q = Math.max(0.05, filter.q || 1);
      const t = (f / fc - fc / f) * q;
      return -10 * Math.log10(1 + t * t);
    }
    return 0;
  }

  function weightingDb(opts, f) {
    let v = 0;
    const fk = opts.filter && opts.filter.kind;
    if (opts.weighting === 'A' && fk !== 'A') v += aWeightDb(f);
    if (opts.weighting === 'BS468' && fk !== 'BS468') v += bs468Db(f);
    if (fk && fk !== 'none') {
      const f2 = Object.assign({}, opts.filter, { fs: opts.fs });
      v += genericFilterDb(f2, f);
    }
    return v;
  }

  function weightingLabel(opts) {
    const labels = [];
    const fk = opts.filter && opts.filter.kind;
    if (opts.weighting === 'A' && fk !== 'A') labels.push('A');
    if (opts.weighting === 'BS468' && fk !== 'BS468') labels.push('BS468');
    if (fk === 'A') { if (labels.indexOf('A') < 0) labels.push('A'); }
    else if (fk === 'BS468') { if (labels.indexOf('BS468') < 0) labels.push('BS468'); }
    else if (fk && fk !== 'none') labels.push('Filter');
    return labels.join('+');
  }

  function applyWeighting(samples, fs, opts) {
    if (!opts || (!opts.weighting || opts.weighting === 'none') && (!opts.filter || opts.filter.kind === 'none')) return null;
    const n = samples.length;
    if (!n) return null;
    const size = nextPow2(n + Math.min(n, 4096));
    const re = new Float64Array(size), im = new Float64Array(size);
    for (let i = 0; i < n; i++) re[i] = samples[i];
    fft(re, im, false);
    for (let k = 0; k <= size / 2; k++) {
      const f = k * fs / size;
      const g = Math.pow(10, weightingDb(opts, f) / 20);
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < size / 2) { re[size - k] *= g; im[size - k] *= g; }
    }
    fft(re, im, true);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = re[i];
    return { samples: out, label: weightingLabel(opts) };
  }

  function timeStats(samples, start, count) {
    const n = samples.length;
    start = clamp(start | 0, 0, n);
    count = clamp(count | 0, 0, n - start);
    if (!count) return null;
    let sum = 0, sq = 0, peak = 0, pos = 0, neg = 0;
    for (let i = start; i < start + count; i++) {
      const v = samples[i];
      sum += v; sq += v * v;
      if (Math.abs(v) >= peak) peak = Math.abs(v);
      if (v > pos) pos = v;
      if (v < neg) neg = v;
    }
    const dc = sum / count;
    const rms = Math.sqrt(sq / count);
    let acsq = 0;
    for (let i = start; i < start + count; i++) {
      const d = samples[i] - dc; acsq += d * d;
    }
    const acRms = Math.sqrt(acsq / count);
    return {
      count: count,
      rms: rms, acRms: acRms, dc: dc,
      rmsDbFs: clampDb(db(rms)), acRmsDbFs: clampDb(db(acRms)),
      peakAbs: peak, peakPos: pos, peakNeg: neg, peakToPeak: pos - neg,
      peakDbFs: clampDb(db(peak)),
      crestFactorDb: acRms > 0 ? 20 * Math.log10(peak / acRms) : 0
    };
  }

  function histogram(samples, start, count, bins) {
    bins = bins || 96;
    start = clamp(start | 0, 0, samples.length);
    count = clamp(count | 0, 0, samples.length - start);
    if (!count) return null;
    let lo = Infinity, hi = -Infinity, sum = 0, sum2 = 0;
    for (let i = start; i < start + count; i++) {
      const v = samples[i]; if (v < lo) lo = v; if (v > hi) hi = v;
      sum += v; sum2 += v * v;
    }
    if (!isFinite(lo) || hi <= lo) { lo -= 1; hi += 1; }
    const counts = new Uint32Array(bins);
    const scale = (bins - 1) / (hi - lo);
    for (let i = start; i < start + count; i++) counts[clamp(((samples[i] - lo) * scale) | 0, 0, bins - 1)]++;
    const mean = sum / count;
    const sd = Math.sqrt(Math.max(0, sum2 / count - mean * mean));
    return { counts: counts, min: lo, max: hi, mean: mean, std: sd, peakToPeak: hi - lo, count: count };
  }

  function spectrum(samples, start, count, fs, opts) {
    opts = opts || {};
    const nSamples = samples.length;
    start = clamp(start | 0, 0, nSamples);
    count = clamp(count | 0, 0, nSamples - start);
    if (count < 32 || !fs) return { valid: false, message: '分析区域过短' };
    let n = opts.fftSize || 0;
    if (!n) n = count >= 1024 ? prevPow2(Math.min(count, 65536)) : nextPow2(count);
    n = clamp(nextPow2(n), 64, 262144);
    const win = makeWindow(opts.window || 'Hann', n);
    const re = new Float64Array(n), im = new Float64Array(n);
    const power = new Float64Array(n / 2 + 1);
    const hop = Math.max(1, n >> 1);
    let segments = 0;
    const maxSegments = Math.max(1, opts.maxSegments || 128);
    for (let pos = start; pos < start + count; pos += hop) {
      for (let i = 0; i < n; i++) {
        const idx = pos + i;
        re[i] = idx < start + count ? samples[idx] * win.w[i] : 0;
        im[i] = 0;
      }
      fft(re, im, false);
      for (let k = 0; k <= n / 2; k++) power[k] += re[k] * re[k] + im[k] * im[k];
      segments++;
      if (!opts.averaging || pos + n >= start + count) break;
      if (segments >= maxSegments) break;
    }
    for (let k = 0; k < power.length; k++) power[k] /= Math.max(1, segments);
    const binHz = fs / n;
    const freq = new Float64Array(n / 2 + 1);
    const values = new Float64Array(n / 2 + 1);
    const rawPower = new Float64Array(n / 2 + 1);
    const weightOpts = { weighting: opts.weighting || 'none', filter: opts.filter || { kind: 'none' }, fs: fs };
    const bandwidth = opts.bandwidth > 0 ? Math.min(opts.bandwidth, fs / 2) : fs / 2;
    for (let k = 0; k <= n / 2; k++) {
      const f = k * binHz;
      freq[k] = f;
      const gainDb = weightingDb(weightOpts, f);
      const gain = f > bandwidth ? 0 : Math.pow(10, gainDb / 10);
      rawPower[k] = power[k];
      const p = power[k] * gain;
      const amp = (k === 0 || k === n / 2 ? 1 : 2) * Math.sqrt(p) / win.coherentGain / n;
      values[k] = clampDb(db(amp));
    }
    let fund = -1, maxP = -Infinity;
    for (let k = 2; k < values.length; k++) {
      if (freq[k] > bandwidth) break;
      const p = rawPower[k] * Math.pow(10, weightingDb(weightOpts, freq[k]) / 10);
      if (p > maxP) { maxP = p; fund = k; }
    }
    if (fund < 0) return { valid: false, message: '未找到有效谱峰' };
    let d = 0;
    if (fund > 0 && fund < values.length - 1) {
      const a = values[fund - 1], b = values[fund], c = values[fund + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) d = clamp(0.5 * (a - c) / den, -0.5, 0.5);
    }
    const f0 = (fund + d) * binHz;
    const signalHz = Math.max(2, Math.round(f0 * (opts.notchPercent || 3) / 100 / binHz));
    const harmBins = [];
    for (let h = 2; h <= 8; h++) {
      const hf = f0 * h; if (hf >= bandwidth) break;
      harmBins.push(Math.round(hf / binHz));
    }
    let total = 0, sig = 0, harm = 0;
    const signalSet = new Set();
    for (let k = Math.max(1, fund - signalHz); k <= Math.min(n / 2, fund + signalHz); k++) signalSet.add(k);
    for (let k = 1; k <= n / 2 && freq[k] <= bandwidth; k++) {
      const p = rawPower[k] * Math.pow(10, weightingDb(weightOpts, freq[k]) / 10);
      total += p;
      if (signalSet.has(k)) sig += p;
    }
    for (let hi = 0; hi < harmBins.length; hi++) {
      const hb = harmBins[hi];
      for (let k = Math.max(2, hb - signalHz); k <= Math.min(n / 2, hb + signalHz); k++) {
        const p = rawPower[k] * Math.pow(10, weightingDb(weightOpts, freq[k]) / 10);
        harm += p;
      }
    }
    const residual = Math.max(0, total - sig);
    const noise = Math.max(0, residual - harm);
    const tplusn = 10 * Math.log10(Math.max(1e-30, residual / Math.max(1e-30, sig)));
    const thd = 10 * Math.log10(Math.max(1e-30, harm / Math.max(1e-30, sig)));
    const snr = 10 * Math.log10(Math.max(1e-30, sig / Math.max(1e-30, noise)));
    const sinad = 10 * Math.log10(Math.max(1e-30, sig / Math.max(1e-30, noise + harm)));
    const harmonicDb = [], harmonicFreq = [];
    for (let hi = 0; hi < harmBins.length; hi++) {
      const hb = harmBins[hi];
      let hp = 0;
      for (let k = Math.max(2, hb - signalHz); k <= Math.min(n / 2, hb + signalHz); k++) hp += rawPower[k] * Math.pow(10, weightingDb(weightOpts, freq[k]) / 10);
      harmonicDb.push(clampDb(10 * Math.log10(Math.max(1e-30, hp))));
      harmonicFreq.push(freq[hb]);
    }
    const bins = [];
    for (let k = 1; k <= n / 2 && freq[k] <= bandwidth; k++) {
      if (signalSet.has(k)) continue;
      bins.push(values[k]);
    }
    bins.sort((a, b) => a - b);
    const noiseFloor = bins.length ? bins[(bins.length / 2) | 0] : -300;
    const peaks = [];
    for (let k = 2; k < values.length - 1 && freq[k] <= bandwidth; k++) {
      if (values[k] > values[k - 1] && values[k] >= values[k + 1]) peaks.push({ f: freq[k], db: values[k], hz: freq[k] });
    }
    peaks.sort((a, b) => b.db - a.db);
    return {
      valid: true, message: '', freq: freq, db: values, binHz: binHz, fftSize: n, segments: segments,
      window: opts.window || 'Hann', fundamentalHz: f0, fundamentalDb: values[fund],
      thdPlusNDb: tplusn, thdPlusPct: Math.sqrt(Math.max(0, residual / Math.max(1e-30, sig))) * 100,
      thdDb: thd, thdPct: Math.sqrt(Math.max(0, harm / Math.max(1e-30, sig))) * 100,
      snrDb: snr, sinadDb: sinad, enob: (sinad - 1.76) / 6.02,
      noiseFloorDb: noiseFloor, harmonicDb: harmonicDb, harmonicFreq: harmonicFreq,
      peaks: peaks.slice(0, 12), bandwidth: bandwidth, weighting: weightingLabel(weightOpts)
    };
  }

  function jitter(samples, start, count, fs) {
    start = clamp(start | 0, 0, samples.length);
    count = clamp(count | 0, 0, samples.length - start);
    if (count < 64) return { valid: false, message: '样本不足' };
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < start + count; i++) { if (samples[i] < lo) lo = samples[i]; if (samples[i] > hi) hi = samples[i]; }
    const amp = hi - lo;
    if (amp < 1e-9) return { valid: false, message: '无周期信号' };
    const threshold = (lo + hi) * 0.5;
    const hyst = amp * 0.02;
    const crossings = [];
    let state = samples[start] > threshold ? 1 : -1;
    for (let i = start + 1; i < start + count; i++) {
      const prev = samples[i - 1], curr = samples[i];
      if (state < 0 && curr > threshold + hyst) {
        const t = i - 1 + (threshold - prev) / (curr - prev || 1e-30);
        crossings.push(t); state = 1;
      } else if (state > 0 && curr < threshold - hyst) {
        state = -1;
      }
    }
    if (crossings.length < 6) return { valid: false, message: '过零不足' };
    const periods = [];
    for (let i = 1; i < crossings.length; i++) periods.push(crossings[i] - crossings[i - 1]);
    let mean = 0; for (const p of periods) mean += p; mean /= periods.length;
    let v = 0; for (const p of periods) v += (p - mean) * (p - mean);
    const rms = Math.sqrt(v / periods.length);
    if (mean <= 0 || rms / mean > 0.2) return { valid: false, message: '周期不稳定，无法测抖动' };
    let pp = 0; for (const p of periods) pp = Math.max(pp, Math.abs(p - mean));
    const cc = [];
    for (let i = 1; i < periods.length; i++) cc.push(periods[i] - periods[i - 1]);
    let ccSq = 0; for (const p of cc) ccSq += p * p;
    return {
      valid: true, message: '', crossings: crossings, periods: periods,
      f0: fs / mean, meanPeriod: mean, rmsPeriod: rms, ppPeriod: pp,
      rmsCycle: cc.length ? Math.sqrt(ccSq / cc.length) : 0,
      percent: mean > 0 ? rms / mean * 100 : 0,
      trend: periods.map((p, i) => ({ i: i, error: p - mean }))
    };
  }

  DSP.fft = fft;
  DSP.nextPow2 = nextPow2;
  DSP.prevPow2 = prevPow2;
  DSP.windowNames = WINDOW_NAMES;
  DSP.aWeightDb = aWeightDb;
  DSP.bs468Db = bs468Db;
  DSP.filterDb = genericFilterDb;
  DSP.weightingDb = weightingDb;
  DSP.weightingLabel = weightingLabel;
  DSP.applyWeighting = applyWeighting;
  DSP.timeStats = timeStats;
  DSP.histogram = histogram;
  DSP.spectrum = spectrum;
  DSP.jitter = jitter;
  DSP.clamp = clamp;
  DSP.db = db;
  global.DSP = DSP;
})(window);
