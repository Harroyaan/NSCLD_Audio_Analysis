(function (global) {
  'use strict';

  const F = {};
  const textDecoder = new TextDecoder('utf-8');

  function ascii(view, off, len) {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(off + i));
    return s;
  }

  function baseSignal(name, sampleRate, channels, format) {
    return {
      name: name,
      sampleRate: sampleRate,
      channels: channels,
      channelCount: channels.length,
      length: channels.length ? channels[0].length : 0,
      duration: sampleRate > 0 && channels.length ? channels[0].length / sampleRate : 0,
      format: format || 'WAV',
      bits: 0,
      unit: 'FS',
      channelUnits: new Array(channels.length).fill('FS'),
      channelNames: channels.map((_, i) => 'CH' + (i + 1)),
      rawWords: null,
      rawBits: 0
    };
  }

  function readInt24(view, off) {
    let v = view.getUint8(off) | (view.getUint8(off + 1) << 8) | (view.getUint8(off + 2) << 16);
    if (v & 0x800000) v |= 0xff000000;
    return v;
  }

  function parseWav(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 12) throw new Error('WAV 文件过短');
    const riff = ascii(view, 0, 4);
    if (riff !== 'RIFF' && riff !== 'RF64') throw new Error('不是 RIFF/RF64 WAV');
    let p = 12, fmt = null, dataOff = 0, dataSize = 0;
    while (p + 8 <= view.byteLength) {
      const id = ascii(view, p, 4);
      let size = view.getUint32(p + 4, true);
      const body = p + 8;
      if (id === 'fmt ') {
        let audioFormat = view.getUint16(body, true);
        const channels = view.getUint16(body + 2, true);
        const sampleRate = view.getUint32(body + 4, true);
        const blockAlign = view.getUint16(body + 12, true);
        const bits = view.getUint16(body + 14, true);
        if (audioFormat === 0xfffe && size >= 40) {
          audioFormat = view.getUint16(body + 24, true);
        }
        fmt = { format: audioFormat, channels: channels, sampleRate: sampleRate, blockAlign: blockAlign, bits: bits };
      } else if (id === 'data') {
        dataOff = body;
        dataSize = size;
        if (size === 0xffffffff || body + size > view.byteLength) dataSize = view.byteLength - body;
        if (size > 4) break;
      }
      p = body + size + (size & 1);
    }
    if (!fmt) throw new Error('WAV 缺少 fmt chunk');
    if (!dataOff) throw new Error('WAV 缺少 data chunk');
    if (!fmt.channels || !fmt.sampleRate) throw new Error('WAV 参数无效');
    const bytes = fmt.bits >> 3;
    const frames = Math.floor(dataSize / Math.max(1, fmt.blockAlign));
    const channels = [];
    const rawWords = fmt.format === 1 || fmt.format === 0xfffe ? [] : null;
    for (let c = 0; c < fmt.channels; c++) {
      channels.push(new Float32Array(frames));
      if (rawWords) rawWords.push(new Uint32Array(frames));
    }
    for (let i = 0, off = dataOff; i < frames; i++, off += fmt.blockAlign) {
      for (let c = 0; c < fmt.channels; c++) {
        const o = off + c * bytes;
        let v = 0, raw = 0;
        if (fmt.format === 3) {
          if (fmt.bits === 64) v = view.getFloat64(o, true);
          else v = view.getFloat32(o, true);
        } else if (fmt.bits === 8) {
          raw = view.getUint8(o);
          v = (raw - 128) / 128;
        } else if (fmt.bits === 16) {
          const s = view.getInt16(o, true);
          raw = s & 0xffff; v = s / 32768;
        } else if (fmt.bits === 24) {
          const s = readInt24(view, o);
          raw = s & 0xffffff; v = s / 8388608;
        } else if (fmt.bits === 32) {
          const s = view.getInt32(o, true);
          raw = s >>> 0; v = s / 2147483648;
        } else {
          v = 0;
        }
        channels[c][i] = v;
        if (rawWords) rawWords[c][i] = raw;
      }
    }
    const sig = baseSignal('WAV', fmt.sampleRate, channels, fmt.format === 3 ? 'WAV float' : 'WAV PCM');
    sig.bits = fmt.bits;
    sig.rawBits = rawWords ? fmt.bits : 0;
    sig.rawWords = rawWords;
    sig.format = (fmt.format === 3 ? 'WAV float' : 'WAV PCM') + ' ' + fmt.bits + '-bit';
    return sig;
  }

  function flacInfo(buffer) {
    const view = new DataView(buffer);
    if (ascii(view, 0, 4) !== 'fLaC') return null;
    if (view.byteLength < 42) return null;
    const b20 = view.getUint8(20), b21 = view.getUint8(21);
    const sampleRate = (view.getUint8(18) << 12) | (view.getUint8(19) << 4) | (b20 >> 4);
    const channels = ((b20 >> 1) & 7) + 1;
    const bits = (((b20 & 1) << 4) | (b21 >> 4)) + 1;
    return { sampleRate, channels, bits };
  }

  async function parseFlac(buffer, name) {
    const info = flacInfo(buffer);
    if (!info) throw new Error('FLAC 头解析失败');
    const Ctx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('浏览器不支持 Web Audio 解码');
    const rate = Math.max(8000, Math.min(96000, info.sampleRate || 48000));
    const ctx = new Ctx(Math.max(1, info.channels), 1, rate);
    const data = buffer.slice(0);
    const audio = await ctx.decodeAudioData(data);
    const channels = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(new Float32Array(audio.getChannelData(c)));
    const sig = baseSignal(name || 'FLAC', audio.sampleRate || info.sampleRate, channels, 'FLAC');
    sig.bits = info.bits;
    sig.format = 'FLAC ' + info.bits + '-bit';
    return sig;
  }

  function parseDelimited(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim().length);
    if (!lines.length) throw new Error('CSV 为空');
    let delimiter = ',';
    if (lines[0].indexOf('\t') >= 0 && lines[0].indexOf(',') < 0) delimiter = '\t';
    else if (lines[0].indexOf(';') >= 0 && lines[0].indexOf(',') < 0) delimiter = ';';
    let header = null, start = 0;
    const first = lines[0].split(delimiter);
    if (first.some(v => isNaN(parseFloat(v)))) { header = first.map(v => v.trim()); start = 1; }
    const rows = [];
    for (let i = start; i < lines.length; i++) {
      const cols = lines[i].split(delimiter);
      if (cols.length < 2) continue;
      const nums = cols.map(v => parseFloat(v));
      if (nums.every(v => isNaN(v))) continue;
      rows.push(nums);
    }
    if (!rows.length) throw new Error('CSV 没有数值列');
    return { header, rows, delimiter };
  }

  function parseCsv(text, name) {
    const { header, rows } = parseDelimited(text);
    if (header && header.some(h => /bclk|bit.?clock/i.test(h)) && header.some(h => /fs|frame/i.test(h))) {
      return decodeLogicCsv(header, rows, name);
    }
    const cols = rows[0].length;
    let timeCol = -1;
    if (header) {
      for (let i = 0; i < header.length; i++) {
        if (/time|时间|^t$|sec/i.test(header[i])) { timeCol = i; break; }
      }
    }
    if (timeCol < 0 && !header && cols > 1) {
      let monotonic = true;
      for (let i = 1; i < Math.min(rows.length, 64); i++) {
        if (!(rows[i][0] > rows[i - 1][0])) { monotonic = false; break; }
      }
      if (monotonic) timeCol = 0;
    }
    const valueCols = [];
    for (let i = 0; i < cols; i++) if (i !== timeCol) valueCols.push(i);
    let fs = 48000;
    if (timeCol >= 0 && rows.length > 2) {
      const t0 = rows[0][timeCol], t1 = rows[1][timeCol];
      let sec = Math.abs(t1 - t0);
      if (header && /ms|毫秒/i.test(header[timeCol])) sec /= 1000;
      else if (header && /us|µs/i.test(header[timeCol])) sec /= 1e6;
      if (sec > 0) fs = 1 / sec;
    }
    const channels = valueCols.map(() => new Float32Array(rows.length));
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < valueCols.length; c++) channels[c][r] = isFinite(rows[r][valueCols[c]]) ? rows[r][valueCols[c]] : 0;
    }
    let unit = 'FS';
    if (header && valueCols.some(i => /\(V\)|volts?|^v(out|in|rms)|V(out|in|rms)/i.test(header[i] || ''))) unit = 'V';
    const sig = baseSignal(name || 'AP CSV', fs, channels, 'AP CSV');
    sig.unit = unit;
    sig.channelUnits = channels.map(() => unit);
    sig.channelNames = valueCols.map((i, n) => header && header[i] ? header[i] : 'CH' + (n + 1));
    sig.format = 'AP CSV';
    return sig;
  }

  function decodeLogicCsv(header, rows, name) {
    const find = re => header.findIndex(h => re.test(h));
    const iB = find(/bclk|bit.?clock/i), iF = find(/fs|frame|lrck/i), iD = find(/data|din|dout/i);
    if (iB < 0 || iF < 0 || iD < 0) throw new Error('逻辑 CSV 需要 BCLK/FS/DATA 列');
    const b = rows.map(r => r[iB] > 0.5 ? 1 : 0);
    const f = rows.map(r => r[iF] > 0.5 ? 1 : 0);
    const d = rows.map(r => r[iD] > 0.5 ? 1 : 0);
    const channels = [[], []];
    let bits = [], lastFs = f[0], edgeCount = 0;
    for (let i = 1; i < rows.length; i++) {
      if (f[i] !== lastFs) {
        if (bits.length) channels[lastFs ? 1 : 0].push(bitsToSigned(bits));
        bits = []; lastFs = f[i];
      }
      if (!b[i - 1] && b[i]) {
        bits.push(d[i]); edgeCount++;
      }
    }
    if (bits.length) channels[lastFs ? 1 : 0].push(bitsToSigned(bits));
    let max = 1;
    channels.forEach(ch => { ch.forEach(v => { if (Math.abs(v) > max) max = Math.abs(v); }); });
    const out = channels.filter(ch => ch.length).map(ch => {
      const a = new Float32Array(ch.length);
      for (let i = 0; i < ch.length; i++) a[i] = ch[i] / max;
      return a;
    });
    const dur = rows.length > 1 ? Math.abs(rows[rows.length - 1][iB] - rows[0][iB]) : 1;
    const sig = baseSignal(name || 'Logic CSV', 48000, out, '逻辑 CSV');
    sig.format = '逻辑 CSV';
    sig.bits = Math.round(edgeCount / Math.max(1, out.length));
    return sig;
  }

  function bitsToSigned(bits) {
    let v = 0;
    for (const bit of bits) v = (v << 1) | bit;
    const width = bits.length;
    if (width && width < 32 && (v & (1 << (width - 1)))) v -= (1 << width);
    return v;
  }

  function bitAt(bytes, bitPos, msbFirst) {
    const idx = bitPos >> 3, off = bitPos & 7;
    return msbFirst ? (bytes[idx] >> (7 - off)) & 1 : (bytes[idx] >> off) & 1;
  }

  function decodeRawDigital(buffer, cfg, name) {
    const bytes = new Uint8Array(buffer);
    const wordBits = Math.max(1, Math.min(32, cfg.wordBits || 16));
    const slotCount = Math.max(1, Math.min(16, cfg.slots || 2));
    const slotWidth = Math.max(wordBits, Math.min(64, cfg.slotWidth || wordBits));
    const offset = Math.max(0, cfg.offset || 0);
    const frameBits = slotCount * slotWidth;
    const frames = Math.floor((bytes.length * 8 - offset) / frameBits);
    const mode = cfg.mode || 'tdm';
    if (mode === 'pdm') {
      const bitCount = bytes.length * 8;
      const decim = Math.max(1, cfg.decim || 64);
      const len = Math.floor(bitCount / decim);
      const out = new Float32Array(len);
      let acc = 0;
      for (let i = 0; i < len; i++) {
        let sum = 0;
        for (let k = 0; k < decim; k++) sum += bitAt(bytes, i * decim + k, true) ? 1 : -1;
        acc += sum;
        out[i] = acc / decim / 8;
        acc *= 0.995;
      }
      const sig = baseSignal(name || 'PDM', cfg.sampleRate || 48000, [out], 'PDM');
      sig.format = 'PDM';
      return sig;
    }
    const channels = [];
    const raws = [];
    for (let s = 0; s < slotCount; s++) { channels.push(new Float32Array(frames)); raws.push(new Uint32Array(frames)); }
    for (let f = 0; f < frames; f++) {
      for (let s = 0; s < slotCount; s++) {
        let start = offset + f * frameBits + s * slotWidth + (cfg.alignment === 'i2s' ? 1 : 0);
        let v = 0;
        for (let k = 0; k < wordBits; k++) {
          const bit = bitAt(bytes, start + k, cfg.lsbFirst !== true);
          if (cfg.lsbFirst) v |= bit << k; else v = (v << 1) | bit;
        }
        if (cfg.signed !== false) {
          const sign = 1 << (wordBits - 1);
          if (v & sign) v -= (1 << wordBits);
        }
        channels[s][f] = v / Math.pow(2, wordBits - 1);
        raws[s][f] = v & ((1 << wordBits) - 1);
      }
    }
    const sig = baseSignal(name || 'TDM', cfg.sampleRate || 48000, channels, '数字流');
    sig.format = 'TDM / ' + wordBits + '-bit';
    sig.rawWords = raws;
    sig.rawBits = wordBits;
    sig.bits = wordBits;
    return sig;
  }

  function demoSignal() {
    const fs = 48000, len = fs * 2;
    const a = new Float32Array(len), b = new Float32Array(len), c = new Float32Array(len);
    const ra = new Uint32Array(len), rb = new Uint32Array(len), rc = new Uint32Array(len);
    for (let i = 0; i < len; i++) {
      const t = i / fs;
      a[i] = 0.5 * Math.sin(2 * Math.PI * 1000 * t) + 0.02 * Math.sin(2 * Math.PI * 3000 * t);
      b[i] = 0.36 * Math.sin(2 * Math.PI * 2000 * t);
      c[i] = 0.28 * Math.sin(2 * Math.PI * 500 * t);
      ra[i] = Math.round(a[i] * 2147483647) >>> 0;
      rb[i] = Math.round(b[i] * 2147483647) >>> 0;
      rc[i] = Math.round(c[i] * 2147483647) >>> 0;
    }
    const sig = baseSignal('NSCLD demo · 3-channel test tone', fs, [a, b, c], '内置测试信号');
    sig.bits = 32;
    sig.rawBits = 32;
    sig.rawWords = [ra, rb, rc];
    sig.format = '内置测试信号';
    return sig;
  }

  function exportWav(samples, sampleRate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);
    const write = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    write(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); write(8, 'WAVE');
    write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    write(36, 'data'); view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  F.parseWav = parseWav;
  F.parseFlac = parseFlac;
  F.parseCsv = parseCsv;
  F.decodeRawDigital = decodeRawDigital;
  F.demoSignal = demoSignal;
  F.exportWav = exportWav;
  F.baseSignal = baseSignal;
  global.NSCLDFormats = F;
})(window);
