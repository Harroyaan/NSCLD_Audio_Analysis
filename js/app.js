(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const SETTINGS_KEY = 'nscld.workbench.v2';
  const FILTER_NAMES = { A: 'A-weight', BS468: 'ITU-R BS.468-4', lowpass: '低通', highpass: '高通', bandpass: '带通', notch: '带阻' };
  const GENERIC_FILTERS = { lowpass: true, highpass: true, bandpass: true, notch: true };
  const saved = readStore();

  const state = {
    theme: saved.theme || 'dark',
    spectrumLayout: saved.spectrumLayout || 'stacked',
    waveOverlay: saved.waveOverlay === true,
    logX: saved.logX !== false,
    loop: saved.loop || 'off',
    speed: Number(saved.speed) || 1,
    fftSize: Number(saved.fftSize) || 0,
    window: saved.window || 'Hann',
    averaging: saved.averaging !== false,
    weighting: saved.weighting || 'none',
    bandwidth: Number(saved.bandwidth) || 0,
    filterKind: saved.filterKind || 'none',
    filterCutoff: Number(saved.filterCutoff) || 1000,
    filterOrder: Number(saved.filterOrder) || 2,
    bitWordBits: Number(saved.bitWordBits) || 32,
    bitUnit: saved.bitUnit || 'FS',
    bitFields: Array.isArray(saved.bitFields) ? saved.bitFields : null,
    bitDiagramVisible: saved.bitDiagramVisible !== false,
    signal: null,
    baseSignal: null,
    channel: 0,
    channelCount: 0,
    waveX0: 0,
    waveX1: 1,
    specX0: 20,
    specX1: 24000,
    specY1: 10,
    specStacked: saved.spectrumLayout !== 'overlay',
    cursorA: null,
    cursorB: null,
    selection: null,
    fixedY: null,
    weighted: null,
    weightedLabel: '',
    specs: [],
    spec: null,
    times: [],
    jitters: [],
    jitter: null,
    playhead: null,
    bitSourceChannel: 0,
    bitSplit: false,
    lastHover: ''
  };

  const app = { state: state };
  window.NSCLDApp = app;

  let wavePlot, spectrumPlot, jitterPlot, editor;
  let analysisRun = 0, analyzeTimer = null, saveTimer = null;
  const audio = { ctx: null, source: null, started: 0, offset: 0, len: 0, speed: 1, loop: false, raf: 0 };
  let axisLane = 0;

  function readStore() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
    catch (e) { return {}; }
  }

  function setStatus(text) {
    $('statusInfo').textContent = text;
  }

  function errorStatus(text) {
    $('statusInfo').textContent = text;
    $('statusInfo').style.color = 'var(--danger)';
    clearTimeout(errorStatus.timer);
    errorStatus.timer = setTimeout(() => { $('statusInfo').style.color = ''; }, 5000);
  }

  function tick() {
    return new Promise(resolve => setTimeout(resolve, 16));
  }

  function filterObject(fs) {
    return {
      kind: state.filterKind,
      cutoff: state.filterCutoff,
      center: state.filterCutoff,
      bandwidth: Math.max(20, state.filterCutoff * 0.5),
      order: state.filterOrder,
      q: 1,
      fs: fs
    };
  }

  function spectrumOptions() {
    const fs = state.signal ? state.signal.sampleRate : 48000;
    return {
      fftSize: state.fftSize,
      window: state.window,
      averaging: state.averaging,
      bandwidth: state.bandwidth,
      weighting: state.weighting,
      filter: filterObject(fs),
      fs: fs,
      notchPercent: 3
    };
  }

  function analysisRange() {
    const sig = state.signal;
    if (!sig) return { start: 0, count: 0 };
    if (state.selection && state.selection.count >= 32) {
      return {
        start: clamp(state.selection.start | 0, 0, sig.length),
        count: clamp(state.selection.count | 0, 1, sig.length - state.selection.start | 0)
      };
    }
    return { start: 0, count: sig.length };
  }

  async function analyzeAll() {
    const sig = state.signal;
    if (!sig) return;
    const run = ++analysisRun;
    const range = analysisRange();
    setStatus('计算时域统计与抖动…');
    await tick();
    if (run !== analysisRun) return;
    const fs = sig.sampleRate;
    const filter = filterObject(fs);
    const filterActive = filter.kind && filter.kind !== 'none';
    state.weighted = null;
    state.weightedLabel = '';
    if (filterActive) {
      setStatus('应用时域滤波…');
      await tick();
      const out = DSP.applyWeighting(sig.channels[state.channel], fs, { weighting: 'none', filter: filter, fs: fs });
      if (out) { state.weighted = out.samples; state.weightedLabel = out.label; }
      if (run !== analysisRun) return;
    }
    const times = [], jitters = [];
    for (let c = 0; c < sig.channelCount; c++) {
      const data = c === state.channel && state.weighted ? state.weighted : sig.channels[c];
      times[c] = DSP.timeStats(data, range.start, range.count);
      jitters[c] = DSP.jitter(data, range.start, range.count, fs);
    }
    const opts = spectrumOptions();
    const specs = [];
    for (let c = 0; c < sig.channelCount; c++) {
      setStatus('计算 FFT 通道 ' + (c + 1) + '/' + sig.channelCount + '…');
      await tick();
      if (run !== analysisRun) return;
      specs[c] = DSP.spectrum(sig.channels[c], range.start, range.count, fs, opts);
    }
    if (run !== analysisRun) return;
    state.times = times;
    state.jitters = jitters;
    state.specs = specs;
    state.spec = specs[state.channel] || specs[0];
    state.jitter = jitters[state.channel];
    if (state.spec && state.spec.valid) {
      state.specX0 = 20;
      state.specX1 = Math.max(100, fs / 2);
      state.specY1 = Math.max(0, Math.ceil((state.spec.fundamentalDb + 10) / 10) * 10);
    }
    updateMeasurements();
    updateSpectrumMeta();
    renderPlots();
    updateEmpty();
    setStatus(sig.name + ' · 分析完成 · ' + (state.spec && state.spec.valid ? state.spec.fundamentalHz.toFixed(2) + ' Hz' : '无有效谱峰'));
  }

  function scheduleAnalyze(delay) {
    clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => analyzeAll(), delay == null ? 220 : delay);
  }

  function updateMeasurements() {
    const sig = state.signal;
    if (!sig) {
      clearCards();
      return;
    }
    const c = state.channel;
    const range = analysisRange();
    const data = state.weighted && c === state.channel ? state.weighted : sig.channels[c];
    const stats = state.times[c] || DSP.timeStats(data, range.start, range.count);
    if (stats) state.times[c] = stats;
    const spec = state.specs[c] || state.spec;
    const jit = state.jitters[c] || state.jitter;
    $('activeChannel').textContent = sig.channelNames[c] || ('CH' + (c + 1));
    const unit = sig.channelUnits[c] || 'FS';
    if (stats) {
      if (unit === 'V') {
        $('rmsValue').textContent = stats.rms.toFixed(5);
        $('rmsUnit').textContent = 'Vrms';
        $('rmsSub').textContent = 'AC ' + stats.acRms.toFixed(5) + ' V · DC ' + stats.dc.toFixed(5) + ' V';
        $('peakValue').textContent = stats.peakAbs.toFixed(5);
        $('peakUnit').textContent = 'Vpk';
        $('peakSub').textContent = 'P-P ' + stats.peakToPeak.toFixed(5) + ' V · 峰均 ' + stats.crestFactorDb.toFixed(2) + ' dB';
        const load = Number($('toolLoad').value) || 8;
        const p = stats.rms * stats.rms / load;
        $('powerValue').textContent = p.toFixed(5);
        $('powerUnit').textContent = 'W';
        $('powerSub').textContent = (10 * Math.log10(Math.max(1e-30, p / 0.001))).toFixed(2) + ' dBm · ' + load + ' Ω';
      } else {
        $('rmsValue').textContent = stats.rmsDbFs.toFixed(2);
        $('rmsUnit').textContent = 'dBFS';
        $('rmsSub').textContent = 'AC ' + stats.acRmsDbFs.toFixed(2) + ' dBFS · DC ' + stats.dc.toFixed(4);
        $('peakValue').textContent = stats.peakDbFs.toFixed(2);
        $('peakUnit').textContent = 'dBFS';
        $('peakSub').textContent = 'P-P ' + stats.peakToPeak.toFixed(4) + ' FS · 峰均 ' + stats.crestFactorDb.toFixed(2) + ' dB';
        $('powerValue').textContent = fmtNum(stats.rms * stats.rms);
        $('powerUnit').textContent = 'FS²';
        $('powerSub').textContent = 'RMS 平方值 · 归一化';
      }
    }
    if (spec && spec.valid) {
      $('thdValue').textContent = spec.thdPlusNDb.toFixed(2);
      $('thdSub').textContent = 'THD ' + spec.thdPct.toFixed(3) + '% · SINAD ' + spec.sinadDb.toFixed(1) + ' dB';
      $('snrValue').textContent = spec.snrDb.toFixed(2);
      $('snrSub').textContent = 'ENOB ' + spec.enob.toFixed(2) + ' bit · 噪底 ' + spec.noiseFloorDb.toFixed(1) + ' dB';
      $('freqValue').textContent = spec.fundamentalHz >= 1000 ? (spec.fundamentalHz / 1000).toFixed(4) : spec.fundamentalHz.toFixed(2);
      $('freqUnit').textContent = spec.fundamentalHz >= 1000 ? 'kHz' : 'Hz';
      $('freqSub').textContent = spec.window + ' · ' + spec.fftSize + ' pts · Δf ' + spec.binHz.toFixed(3) + ' Hz';
    } else {
      $('thdValue').textContent = '—'; $('snrValue').textContent = '—'; $('freqValue').textContent = '—';
      $('thdSub').textContent = spec && spec.message ? spec.message : '等待频谱';
      $('snrSub').textContent = '等待频谱';
      $('freqSub').textContent = 'FFT 谱峰';
    }
    if (jit && jit.valid) {
      $('jitterValue').textContent = (jit.rmsPeriod * 1e12).toFixed(2);
      $('jitterSub').textContent = 'P-P ' + (jit.ppPeriod * 1e12).toFixed(2) + ' ps · ' + jit.f0.toFixed(2) + ' Hz';
      $('jitterHead').textContent = 'f0 ' + jit.f0.toFixed(3) + ' Hz · RMS ' + (jit.rmsPeriod * 1e12).toFixed(2)
        + ' ps · P-P ' + (jit.ppPeriod * 1e12).toFixed(2) + ' ps · ' + jit.periods.length + ' 个周期';
    } else {
      $('jitterValue').textContent = '—';
      $('jitterSub').textContent = jit && jit.message ? jit.message : '等待抖动分析';
      $('jitterHead').textContent = jit && jit.message ? jit.message : '抖动分析尚未运行';
    }
    updateFilterInfo();
    updateSummary();
    $('analysisFoot').textContent = state.selection
      ? '选区：' + NSCLDPlots.timeText(range.start / sig.sampleRate) + ' → ' + NSCLDPlots.timeText((range.start + range.count) / sig.sampleRate)
      : '分析区域：全记录';
    $('selectionInfo').textContent = state.selection ? '选区 ' + range.count.toLocaleString() + ' samples' : '全记录';
  }

  function updateFilterInfo() {
    const active = state.filterKind && state.filterKind !== 'none';
    if (!active) {
      $('filterInfo').textContent = '时域滤波: 关';
      $('filterInfo').style.color = '';
      return;
    }
    const generic = GENERIC_FILTERS[state.filterKind];
    $('filterInfo').textContent = '时域滤波: ' + FILTER_NAMES[state.filterKind]
      + (generic ? ' · ' + state.filterCutoff + ' Hz · ' + state.filterOrder + ' 阶' : '')
      + (state.weighted ? ' · 已应用' : '');
    $('filterInfo').style.color = 'var(--amber)';
  }

  function updateSummary() {
    const sig = state.signal;
    const card = $('cardSummary');
    if (!sig || sig.channelCount < 2) { card.hidden = true; return; }
    card.hidden = false;
    let html = '<div class="summary-row head"><span>通道</span><span>RMS</span><span>峰值</span><span>基波</span><span>抖动</span></div>';
    const unit = sig.channelUnits[0] || 'FS';
    for (let c = 0; c < sig.channelCount; c++) {
      const t = state.times[c], sp = state.specs[c], j = state.jitters[c];
      html += '<div class="summary-row"><span style="color:' + NSCLDPlots.channelColors[c % NSCLDPlots.channelColors.length] + '">' + esc(sig.channelNames[c]) + '</span>'
        + '<span>' + (t ? (unit === 'V' ? t.rms.toFixed(3) + 'V' : t.rmsDbFs.toFixed(1)) : '—') + '</span>'
        + '<span>' + (t ? (unit === 'V' ? t.peakAbs.toFixed(3) + 'V' : t.peakDbFs.toFixed(1)) : '—') + '</span>'
        + '<span>' + (sp && sp.valid ? NSCLDPlots.fmtTick(sp.fundamentalHz) : '—') + '</span>'
        + '<span>' + (j && j.valid ? (j.rmsPeriod * 1e12).toFixed(0) + 'ps' : '—') + '</span></div>';
    }
    $('summaryRows').innerHTML = html;
  }

  function clearCards() {
    ['rmsValue', 'peakValue', 'powerValue', 'thdValue', 'snrValue', 'freqValue', 'jitterValue'].forEach(id => $(id).textContent = '—');
    $('rmsUnit').textContent = 'dBFS'; $('peakUnit').textContent = 'dBFS'; $('powerUnit').textContent = '';
    $('rmsSub').textContent = '等待信号'; $('peakSub').textContent = '等待信号'; $('powerSub').textContent = '伏特单位信号可计算';
    $('thdSub').textContent = '等待频谱'; $('snrSub').textContent = '等待频谱'; $('freqSub').textContent = 'FFT 谱峰'; $('jitterSub').textContent = '等待抖动分析';
    $('cardSummary').hidden = true;
  }

  function updateSpectrumMeta() {
    const sp = state.spec;
    if (!sp || !sp.valid) { $('spectrumMeta').textContent = sp && sp.message ? sp.message : '尚未分析'; return; }
    $('spectrumMeta').textContent = 'F0 ' + sp.fundamentalHz.toFixed(3) + ' Hz · THD+N ' + sp.thdPlusNDb.toFixed(2)
      + ' dB · SNR ' + sp.snrDb.toFixed(2) + ' dB · ' + sp.segments + ' 段' + (sp.weighting ? ' · ' + sp.weighting + ' 加权' : '');
  }

  function updateEmpty() {
    $('waveEmpty').classList.toggle('hidden', !!state.signal);
    $('spectrumEmpty').classList.toggle('hidden', !!(state.specs && state.specs.length));
    $('jitterEmpty').classList.toggle('hidden', !!(state.jitter && state.jitter.valid));
  }

  function renderPlots() {
    wavePlot && wavePlot.draw();
    spectrumPlot && spectrumPlot.draw();
    jitterPlot && jitterPlot.draw();
  }

  function updateFileMeta(name, detail) {
    const meta = document.querySelector('#fileMeta .meta-name');
    if (meta) { meta.textContent = name; meta.title = detail || name; }
  }

  function setSignal(sig, fileName) {
    if (!sig || !sig.channels.length) return;
    stopPlayback();
    sig.name = fileName || sig.name || 'Signal';
    state.signal = sig;
    state.baseSignal = sig;
    state.channel = 0;
    state.channelCount = sig.channelCount;
    state.weighted = null;
    state.weightedLabel = '';
    state.specs = [];
    state.spec = null;
    state.times = [];
    state.jitters = [];
    state.jitter = null;
    state.cursorA = null;
    state.cursorB = null;
    state.selection = null;
    state.fixedY = null;
    state.playhead = null;
    state.waveX0 = 0;
    state.waveX1 = Math.max(1e-6, sig.duration);
    state.specX0 = 20;
    state.specX1 = Math.max(100, sig.sampleRate / 2);
    state.specY1 = 10;
    state.bitSplit = false;
    state.bitSourceChannel = 0;
    state.bitWordBits = clamp(sig.rawBits || sig.bits || 32, 4, 32);
    state.bitUnit = sig.unit === 'V' ? 'V' : 'FS';
    updateChannelSelect();
    $('sourceSelect').value = 'raw';
    updateFileMeta(sig.name, sig.format + ' · ' + sig.sampleRate + ' Hz');
    $('channelSelect').value = String(0);
    if (editor) {
      editor.syncControls();
      editor.clampFields();
      editor.render();
    }
    $('bitMeta').textContent = state.bitWordBits + '-bit · ' + (state.bitFields ? state.bitFields.length : 0) + ' 字段';
    updateEmpty();
    clearCards();
    setStatus('已载入 ' + sig.name + ' · ' + sig.format + ' · ' + sig.sampleRate + ' Hz · ' + sig.channelCount + ' 通道');
    analyzeAll();
  }

  function updateChannelSelect() {
    const sel = $('channelSelect');
    const sig = state.signal;
    sel.innerHTML = '';
    if (!sig) { sel.innerHTML = '<option>CH1</option>'; return; }
    for (let c = 0; c < sig.channelCount; c++) {
      const o = document.createElement('option');
      o.value = String(c);
      o.textContent = sig.channelNames[c] || ('CH' + (c + 1));
      sel.appendChild(o);
    }
    sel.value = String(state.channel);
  }

  async function handleFile(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    setStatus('读取 ' + file.name + '…');
    try {
      if (ext === 'bin' || ext === 'dat' || ext === 'raw' || ext === 'pdm') {
        await loadDigitalFile(file);
        return;
      }
      if (ext === 'csv' || ext === 'txt') {
        const text = await file.text();
        const sig = NSCLDFormats.parseCsv(text, file.name);
        setSignal(sig, file.name);
        return;
      }
      const buffer = await file.arrayBuffer();
      if (ext === 'flac') {
        setStatus('解码 FLAC…');
        const sig = await NSCLDFormats.parseFlac(buffer, file.name);
        setSignal(sig, file.name);
        return;
      }
      if (ext === 'wav') {
        const sig = NSCLDFormats.parseWav(buffer);
        setSignal(sig, file.name);
        return;
      }
      const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
      if (String.fromCharCode.apply(null, head) === 'fLaC') {
        const sig = await NSCLDFormats.parseFlac(buffer, file.name);
        setSignal(sig, file.name);
      } else if (head.length >= 4 && (head[0] === 82 || head[0] === 70)) {
        const sig = NSCLDFormats.parseWav(buffer);
        setSignal(sig, file.name);
      } else {
        throw new Error('无法识别的文件。请选择 WAV、FLAC、CSV 或使用数字流导入。');
      }
    } catch (err) {
      console.error(err);
      errorStatus('导入失败: ' + (err && err.message ? err.message : err));
      $('dropZone').title = err && err.message ? err.message : String(err);
    }
  }

  async function loadDigitalFile(file) {
    if (!file) return;
    try {
      if (/\.csv$/i.test(file.name)) {
        const sig = NSCLDFormats.parseCsv(await file.text(), file.name);
        setSignal(sig, file.name);
        return;
      }
      const cfg = readDigitalConfig();
      const buffer = await file.arrayBuffer();
      const sig = NSCLDFormats.decodeRawDigital(buffer, cfg, file.name);
      setSignal(sig, file.name);
    } catch (err) {
      errorStatus('数字流导入失败: ' + (err && err.message ? err.message : err));
    }
  }

  function readDigitalConfig() {
    return {
      mode: $('digitalMode').value,
      sampleRate: Number($('digitalRate').value) || 48000,
      wordBits: Number($('digitalBits').value) || 16,
      slots: Number($('digitalSlots').value) || 2,
      slotWidth: Number($('digitalSlotWidth').value) || 16,
      offset: Number($('digitalOffset').value) || 0,
      alignment: $('digitalAlign').value,
      lsbFirst: $('digitalOrder').value === 'lsb',
      signed: $('digitalSigned').value === 'signed',
      decim: Number($('digitalDecim').value) || 64
    };
  }

  function loadDemo() {
    const sig = NSCLDFormats.demoSignal();
    setSignal(sig, 'NSCLD demo · 3-channel test tone');
  }

  function stopPlayback() {
    cancelAnimationFrame(audio.raf);
    audio.raf = 0;
    if (audio.source) {
      try { audio.source.onended = null; audio.source.stop(); } catch (e) {}
      audio.source = null;
    }
    audio.started = 0;
    $('playBtn').textContent = '▶ 播放';
    $('playBtn').classList.add('accent');
  }

  async function play() {
    if (!state.signal) { errorStatus('请先载入信号'); return; }
    if (audio.source) { stopPlayback(); state.playhead = null; wavePlot.draw(); return; }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!audio.ctx) audio.ctx = new Ctx();
      if (audio.ctx.state === 'suspended') await audio.ctx.resume();
      let data = state.signal.channels[state.channel];
      if ($('sourceSelect').value === 'filtered' && state.filterKind !== 'none') {
        if (!state.weighted) {
          setStatus('生成滤波播放源…');
          await tick();
          const out = DSP.applyWeighting(state.signal.channels[state.channel], state.signal.sampleRate, { weighting: 'none', filter: filterObject(state.signal.sampleRate), fs: state.signal.sampleRate });
          if (out) { state.weighted = out.samples; state.weightedLabel = out.label; }
        }
        if (state.weighted) data = state.weighted;
      }
      let start = state.selection ? Math.max(0, state.selection.start) : (state.cursorA != null ? Math.round(state.cursorA * state.signal.sampleRate) : 0);
      start = clamp(start, 0, Math.max(0, state.signal.length - 1));
      let end = state.selection ? Math.min(state.signal.length, state.selection.start + state.selection.count) : state.signal.length;
      if (end - start < 8) end = state.signal.length;
      const buf = audio.ctx.createBuffer(1, end - start, state.signal.sampleRate);
      buf.copyToChannel(data.subarray(start, end), 0);
      const src = audio.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = Number($('speedSelect').value) || 1;
      src.loop = state.loop === 'continuous';
      src.connect(audio.ctx.destination);
      audio.source = src;
      audio.started = audio.ctx.currentTime;
      audio.offset = start / state.signal.sampleRate;
      audio.len = buf.duration;
      audio.speed = src.playbackRate.value;
      audio.loop = state.loop === 'continuous';
      audio.lastDraw = 0;
      src.onended = () => {
        if (audio.source === src) {
          audio.source = null;
          state.playhead = null;
          $('playBtn').textContent = '▶ 播放';
          $('playBtn').classList.add('accent');
          wavePlot.draw();
          setStatus('播放结束');
        }
      };
      src.start(0);
      $('playBtn').textContent = '❚❚ 停止';
      $('playBtn').classList.remove('accent');
      setStatus('播放中 · ' + (state.weighted && $('sourceSelect').value === 'filtered' ? '滤波信号' : '原始信号'));
      const animate = () => {
        if (!audio.source || !audio.ctx) return;
        let elapsed = (audio.ctx.currentTime - audio.started) * audio.speed;
        if (audio.loop) elapsed %= Math.max(1e-9, audio.len);
        state.playhead = audio.offset + elapsed;
        if (state.playhead > state.signal.duration) state.playhead = state.signal.duration;
        const now = performance.now();
        if (!audio.lastDraw || now - audio.lastDraw >= 32) {
          audio.lastDraw = now;
          wavePlot.draw();
        }
        if (!audio.loop && elapsed >= audio.len) {
          state.playhead = null;
          return;
        }
        audio.raf = requestAnimationFrame(animate);
      };
      animate();
    } catch (err) {
      console.error(err);
      errorStatus('无法播放: ' + (err && err.message ? err.message : err));
    }
  }

  function applySelection() {
    const sig = state.signal;
    if (!sig) return;
    if (state.selection) {
      state.selection.start = clamp(state.selection.start | 0, 0, sig.length - 1);
      state.selection.count = clamp(state.selection.count | 0, 1, sig.length - state.selection.start);
    }
    updateSelectionInfo();
    scheduleAnalyze(180);
  }

  function updateSelectionInfo() {
    const sig = state.signal;
    if (!sig) { $('selectionInfo').textContent = '全记录'; return; }
    if (state.selection) {
      $('selectionInfo').textContent = '选区 ' + state.selection.count.toLocaleString() + ' samples';
    } else {
      $('selectionInfo').textContent = '全记录';
    }
  }

  function resetWaveView() {
    if (!state.signal) return;
    state.waveX0 = 0;
    state.waveX1 = state.signal.duration;
    state.fixedY = null;
    updateSelectionInfo();
    wavePlot.draw();
  }

  function resetSpectrumView() {
    if (!state.signal) return;
    state.specX0 = state.logX ? 20 : 0;
    state.specX1 = state.signal.sampleRate / 2;
    state.specY1 = state.spec && state.spec.valid ? Math.ceil((state.spec.fundamentalDb + 10) / 10) * 10 : 10;
    spectrumPlot.draw();
  }

  function setCursorLabel(name, which) {
    const t = name === 'A' ? state.cursorA : state.cursorB;
    if (t != null) setStatus('游标 ' + name + ' = ' + NSCLDPlots.timeText(t));
  }

  function statusHover(text) {
    state.lastHover = text;
    $('statusHover').textContent = text;
  }

  function showMenu(x, y, items) {
    const menu = $('contextMenu');
    menu.innerHTML = '';
    items.forEach(item => {
      if (item.note) {
        const d = document.createElement('div');
        d.className = 'menu-note'; d.textContent = item.note; menu.appendChild(d);
      } else {
        const b = document.createElement('button');
        b.textContent = item.label;
        b.onclick = () => { menu.classList.add('hidden'); item.action(); };
        menu.appendChild(b);
      }
    });
    menu.style.left = Math.min(x, innerWidth - 220) + 'px';
    menu.style.top = Math.min(y, innerHeight - 200) + 'px';
    menu.classList.remove('hidden');
  }

  function hideMenu() { $('contextMenu').classList.add('hidden'); }

  function showWaveMenu(x, y, lane) {
    const sig = state.signal; if (!sig) return;
    const rect = wavePlot.canvas.getBoundingClientRect();
    const t = wavePlot.timeAt(x - rect.left);
    const lname = sig.channelNames[lane] || ('CH' + (lane + 1));
    showMenu(x, y, [
      { note: lname + ' · ' + NSCLDPlots.timeText(t) },
      { label: '固定 ' + (state.waveOverlay ? '叠放视图' : lname) + ' 的 Y 范围…', action: () => openAxis(lane) },
      { label: '恢复 ' + (state.waveOverlay ? '叠放视图' : lname) + ' 自动 Y', action: () => { if (state.fixedY) delete state.fixedY[state.waveOverlay ? 'overlay' : lane]; wavePlot.draw(); } },
      { label: '把游标 A 放在这里', action: () => { state.cursorA = t; setCursorLabel('A'); wavePlot.draw(); } },
      { label: '把游标 B 放在这里', action: () => { state.cursorB = t; setCursorLabel('B'); wavePlot.draw(); } },
      { label: '设为选区起点，终点用游标 B', action: () => { if (state.cursorB == null) state.cursorB = sig.duration; state.selection = { start: Math.round(Math.min(t, state.cursorB) * sig.sampleRate), count: Math.max(1, Math.round(Math.abs(state.cursorB - t) * sig.sampleRate)) }; applySelection(); } },
      { label: '全图 / 自动 Y', action: resetWaveView }
    ]);
  }

  function showSpectrumMenu(x, y) {
    showMenu(x, y, [
      { note: state.logX ? '当前：对数频率轴' : '当前：线性频率轴' },
      { label: '切换线性频率轴', action: () => { state.logX = false; setAxisButtons(); spectrumPlot.draw(); saveSettings(); } },
      { label: '切换对数频率轴', action: () => { state.logX = true; setAxisButtons(); spectrumPlot.draw(); saveSettings(); } },
      { label: '重置频谱视图', action: resetSpectrumView }
    ]);
  }

  function openAxis(lane) {
    axisLane = lane;
    const sig = state.signal; if (!sig) return;
    const range = wavePlot.rangeFor(lane);
    axisLane = state.waveOverlay ? 'overlay' : lane;
    $('axisTitle').textContent = '固定 ' + (state.waveOverlay ? '叠放视图' : (sig.channelNames[lane] || ('CH' + (lane + 1)))) + ' 的 Y 范围';
    $('axisMin').value = range[0];
    $('axisMax').value = range[1];
    $('axisModal').classList.remove('hidden');
  }

  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const payload = {
        version: 2,
        theme: state.theme,
        spectrumLayout: state.spectrumLayout,
        waveOverlay: state.waveOverlay,
        logX: state.logX,
        loop: state.loop,
        speed: state.speed,
        fftSize: state.fftSize,
        window: state.window,
        averaging: state.averaging,
        weighting: state.weighting,
        bandwidth: state.bandwidth,
        filterKind: state.filterKind,
        filterCutoff: state.filterCutoff,
        filterOrder: state.filterOrder,
        bitWordBits: state.bitWordBits,
        bitUnit: state.bitUnit,
        bitFields: state.bitFields,
        bitDiagramVisible: state.bitDiagramVisible
      };
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload)); } catch (e) {}
    }, 90);
  }

  function applyTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    document.body.dataset.theme = state.theme;
    renderPlots();
    if (editor) editor.diagram.draw();
  }

  function syncControls() {
    applyTheme(state.theme);
    $('speedSelect').value = String(state.speed);
    $('loopSelect').value = state.loop;
    $('windowSelect').value = state.window;
    $('fftSelect').value = String(state.fftSize);
    $('averageCheck').checked = state.averaging;
    $('weightSelect').value = state.weighting;
    $('filterKind').value = state.filterKind;
    $('filterCutoff').value = state.filterCutoff;
    $('filterOrder').value = String(state.filterOrder);
    refreshFilterControls();
    $('bandwidthInput').value = state.bandwidth;
    $('specLayout').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.layout === state.spectrumLayout));
    $('waveLayout').querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.layout === 'overlay') === state.waveOverlay));
    setAxisButtons();
    $('settingTheme').value = state.theme;
    $('settingLayout').value = state.spectrumLayout;
    $('settingAxis').value = state.logX ? 'log' : 'linear';
    $('settingLoop').value = state.loop;
    $('settingSpeed').value = String(state.speed);
    $('sourceSelect').value = 'raw';
  }

  function setAxisButtons() {
    $('spectrumAxis').querySelectorAll('button').forEach(b => b.classList.toggle('active', (b.dataset.axis === 'log') === state.logX));
  }

  function refreshFilterControls() {
    const generic = !!GENERIC_FILTERS[state.filterKind];
    $('filterCutoff').disabled = !generic;
    $('filterOrder').disabled = !generic;
  }

  function setView(name) {
    document.querySelectorAll('.rail-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    requestAnimationFrame(() => {
      wavePlot && wavePlot.resize();
      spectrumPlot && spectrumPlot.resize();
      jitterPlot && jitterPlot.resize();
    });
  }

  function bind() {
    document.querySelectorAll('.rail-item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
    $('openBtn').addEventListener('click', () => $('fileInput').click());
    $('dropBrowseBtn').addEventListener('click', () => $('fileInput').click());
    $('demoBtn').addEventListener('click', loadDemo);
    $('fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f); e.target.value = ''; });
    $('digitalBrowseBtn').addEventListener('click', () => $('digitalInput').click());
    $('digitalInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadDigitalFile(f); e.target.value = ''; });
    $('digitalBtn').addEventListener('click', () => setView('import'));

    const dz = $('dropZone');
    ['dragenter', 'dragover'].forEach(k => dz.addEventListener(k, e => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(k => dz.addEventListener(k, e => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    ['dragover', 'drop'].forEach(k => document.addEventListener(k, e => e.preventDefault()));

    $('themeBtn').addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
      $('settingTheme').value = state.theme;
      saveSettings();
    });

    $('settingsBtn').addEventListener('click', () => {
      $('settingTheme').value = state.theme;
      $('settingLayout').value = state.spectrumLayout;
      $('settingAxis').value = state.logX ? 'log' : 'linear';
      $('settingLoop').value = state.loop;
      $('settingSpeed').value = String(state.speed);
      $('settingsModal').classList.remove('hidden');
    });
    $('saveSettingsBtn').addEventListener('click', () => {
      applyTheme($('settingTheme').value);
      state.spectrumLayout = $('settingLayout').value;
      state.specStacked = state.spectrumLayout !== 'overlay';
      state.logX = $('settingAxis').value === 'log';
      state.loop = $('settingLoop').value;
      state.speed = Number($('settingSpeed').value) || 1;
      $('loopSelect').value = state.loop;
      $('speedSelect').value = String(state.speed);
      $('specLayout').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.layout === state.spectrumLayout));
      setAxisButtons();
      saveSettings(); renderPlots(); $('settingsModal').classList.add('hidden');
      setStatus('设置已保存到本机');
    });
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => { $(b.dataset.close).classList.add('hidden'); }));
    document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));
    document.addEventListener('click', e => {
      if (!e.target.closest('#contextMenu')) hideMenu();
    });

    $('playBtn').addEventListener('click', play);
    $('stopBtn').addEventListener('click', () => { stopPlayback(); state.playhead = null; wavePlot.draw(); });
    $('selectBtn').addEventListener('click', () => {
      const sig = state.signal; if (!sig) return;
      if (state.cursorA != null && state.cursorB != null) {
        const a = Math.min(state.cursorA, state.cursorB), b = Math.max(state.cursorA, state.cursorB);
        state.selection = { start: Math.round(a * sig.sampleRate), count: Math.max(1, Math.round((b - a) * sig.sampleRate)) };
      } else {
        state.selection = { start: Math.round(state.waveX0 * sig.sampleRate), count: Math.max(1, Math.round((state.waveX1 - state.waveX0) * sig.sampleRate)) };
      }
      applySelection();
    });
    $('resetViewBtn').addEventListener('click', resetWaveView);
    $('speedSelect').addEventListener('change', () => {
      state.speed = Number($('speedSelect').value) || 1;
      audio.speed = state.speed;
      if (audio.source) audio.source.playbackRate.value = state.speed;
      saveSettings();
    });
    $('loopSelect').addEventListener('change', () => {
      state.loop = $('loopSelect').value;
      audio.loop = state.loop === 'continuous';
      if (audio.source) audio.source.loop = audio.loop;
      saveSettings();
    });
    $('channelSelect').addEventListener('change', () => {
      state.channel = Number($('channelSelect').value) || 0;
      state.selection = null;
      state.weighted = null;
      state.spec = state.specs[state.channel] || state.spec;
      state.jitter = state.jitters[state.channel] || state.jitter;
      analyzeAll();
    });
    $('sourceSelect').addEventListener('change', () => {});

    $('waveLayout').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      state.waveOverlay = b.dataset.layout === 'overlay';
      $('waveLayout').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      wavePlot.draw(); saveSettings();
    }));
    $('specLayout').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      state.spectrumLayout = b.dataset.layout;
      state.specStacked = state.spectrumLayout !== 'overlay';
      $('specLayout').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      spectrumPlot.draw(); saveSettings();
    }));
    $('spectrumAxis').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      state.logX = b.dataset.axis === 'log';
      setAxisButtons(); spectrumPlot.draw(); saveSettings();
    }));
    $('windowSelect').addEventListener('change', () => { state.window = $('windowSelect').value; saveSettings(); scheduleAnalyze(160); });
    $('fftSelect').addEventListener('change', () => { state.fftSize = Number($('fftSelect').value) || 0; saveSettings(); scheduleAnalyze(160); });
    $('averageCheck').addEventListener('change', () => { state.averaging = $('averageCheck').checked; saveSettings(); scheduleAnalyze(160); });
    $('weightSelect').addEventListener('change', () => { state.weighting = $('weightSelect').value; saveSettings(); scheduleAnalyze(160); });
    $('bandwidthInput').addEventListener('change', () => { state.bandwidth = Math.max(0, Number($('bandwidthInput').value) || 0); saveSettings(); scheduleAnalyze(160); });
    $('filterKind').addEventListener('change', () => {
      state.filterKind = $('filterKind').value;
      refreshFilterControls();
      updateFilterInfo();
      saveSettings();
    });
    $('filterCutoff').addEventListener('input', () => { state.filterCutoff = Math.max(1, Number($('filterCutoff').value) || 1000); saveSettings(); });
    $('filterOrder').addEventListener('change', () => { state.filterOrder = Number($('filterOrder').value) || 2; saveSettings(); });
    $('reanalyzeBtn').addEventListener('click', () => { saveSettings(); analyzeAll(); });

    $('jitterTrend').addEventListener('change', () => jitterPlot.draw());
    $('axisApply').addEventListener('click', () => {
      if (!state.signal) return;
      const a = Number($('axisMin').value), b = Number($('axisMax').value);
      if (isFinite(a) && isFinite(b) && b > a) {
        if (!state.fixedY) state.fixedY = {};
        state.fixedY[axisLane] = [a, b];
        wavePlot.draw();
      }
      $('axisModal').classList.add('hidden');
    });

    $('bitToggleBtn').addEventListener('click', () => {
      const panel = $('bitfieldPanel');
      panel.classList.toggle('hidden');
      $('bitToggleBtn').classList.toggle('primary', !panel.classList.contains('hidden'));
      if (!panel.classList.contains('hidden')) { setView('wave'); setTimeout(() => editor.diagram.resize(), 80); }
    });
    $('exportWavBtn').addEventListener('click', exportWav);
    $('exportReportBtn').addEventListener('click', exportReport);
    $('exportSettingsBtn').addEventListener('click', () => downloadJson('nscld-settings.json', readSettingsPayload()));
    $('importSettingsBtn').addEventListener('click', () => $('settingsFileInput').click());
    $('settingsFileInput').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const obj = JSON.parse(await f.text());
        applySettingsPayload(obj);
        $('settingsModal').classList.add('hidden');
        setStatus('设置已导入');
      } catch (err) { errorStatus('设置导入失败'); }
      e.target.value = '';
    });

    bindTools();
    document.addEventListener('keydown', e => {
      if (e.target.matches('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); play(); }
      if (e.key === 'Escape') { hideMenu(); document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden')); }
    });
  }

  function bindTools() {
    const updateDb = () => {
      const v = Number($('toolDb').value) || 0;
      $('toolDbOut').textContent = Math.pow(10, v / 20).toFixed(6);
    };
    const updateRatio = () => {
      const v = Math.max(1e-12, Number($('toolRatio').value) || 1);
      $('toolRatioOut').textContent = (20 * Math.log10(v)).toFixed(2) + ' dB';
    };
    const updatePower = () => {
      const v = Number($('toolVolt').value) || 0, r = Math.max(0.0001, Number($('toolLoad').value) || 8);
      const p = v * v / r;
      $('toolPowerOut').textContent = p.toFixed(5) + ' W · ' + (10 * Math.log10(Math.max(1e-30, p / 0.001))).toFixed(2) + ' dBm';
      updateMeasurements();
    };
    const updateFft = () => {
      const fs = Number($('toolFs').value) || 48000, n = Number($('toolN').value) || 32768;
      $('toolFftOut').textContent = 'Δf = ' + (fs / n).toFixed(3) + ' Hz · 时长 ' + (n / fs * 1e3).toFixed(2) + ' ms';
    };
    $('toolDb').addEventListener('input', updateDb);
    $('toolRatio').addEventListener('input', updateRatio);
    $('toolVolt').addEventListener('input', updatePower);
    $('toolLoad').addEventListener('input', updatePower);
    $('toolFs').addEventListener('input', updateFft);
    $('toolN').addEventListener('input', updateFft);
    updateDb(); updateRatio(); updatePower(); updateFft();
  }

  function readSettingsPayload() {
    return {
      version: 2, theme: state.theme, spectrumLayout: state.spectrumLayout, waveOverlay: state.waveOverlay, logX: state.logX,
      loop: state.loop, speed: state.speed, fftSize: state.fftSize, window: state.window,
      averaging: state.averaging, weighting: state.weighting, bandwidth: state.bandwidth,
      filterKind: state.filterKind, filterCutoff: state.filterCutoff, filterOrder: state.filterOrder,
      bitWordBits: state.bitWordBits, bitUnit: state.bitUnit, bitFields: state.bitFields,
      bitDiagramVisible: state.bitDiagramVisible
    };
  }

  function applySettingsPayload(o) {
    if (!o || typeof o !== 'object') throw new Error('无效设置');
    if (o.theme) state.theme = o.theme;
    if (o.spectrumLayout) { state.spectrumLayout = o.spectrumLayout; state.specStacked = o.spectrumLayout !== 'overlay'; }
    if (o.waveOverlay != null) state.waveOverlay = !!o.waveOverlay;
    if (o.logX != null) state.logX = !!o.logX;
    if (o.loop) state.loop = o.loop;
    if (o.speed) state.speed = Number(o.speed) || 1;
    if (o.fftSize != null) state.fftSize = Number(o.fftSize) || 0;
    if (o.window) state.window = o.window;
    if (o.averaging != null) state.averaging = !!o.averaging;
    if (o.weighting) state.weighting = o.weighting;
    if (o.bandwidth != null) state.bandwidth = Number(o.bandwidth) || 0;
    if (o.filterKind) state.filterKind = o.filterKind;
    if (o.filterCutoff) state.filterCutoff = Number(o.filterCutoff) || 1000;
    if (o.filterOrder) state.filterOrder = Number(o.filterOrder) || 2;
    if (o.bitWordBits) state.bitWordBits = Number(o.bitWordBits) || 32;
    if (o.bitUnit) state.bitUnit = o.bitUnit;
    if (Array.isArray(o.bitFields)) state.bitFields = o.bitFields;
    if (o.bitDiagramVisible != null) state.bitDiagramVisible = !!o.bitDiagramVisible;
    syncControls();
    if (editor) { editor.syncControls(); editor.clampFields(); editor.render(); }
    saveSettings(); scheduleAnalyze(100);
  }

  function downloadJson(name, obj) {
    downloadBlob(name, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  }

  function downloadBlob(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1200);
  }

  function exportWav() {
    const sig = state.signal;
    if (!sig) { errorStatus('没有可导出的信号'); return; }
    const data = state.weighted && state.channel === state.channel ? state.weighted : sig.channels[state.channel];
    downloadBlob((sig.name || 'signal').replace(/\.[^.]+$/, '') + '-nscld.wav', NSCLDFormats.exportWav(data, sig.sampleRate));
    setStatus('WAV 已导出');
  }

  function exportReport() {
    const sig = state.signal;
    if (!sig) { errorStatus('没有可导出的分析'); return; }
    const t = state.times[state.channel], s = state.specs[state.channel], j = state.jitters[state.channel];
    const lines = [
      'NSCLD Audio Measurement Workbench',
      'Generated: ' + new Date().toISOString(),
      'Signal: ' + sig.name,
      'Format: ' + sig.format,
      'Sample rate: ' + sig.sampleRate + ' Hz',
      'Channels: ' + sig.channelCount,
      'Samples: ' + sig.length,
      'Duration: ' + sig.duration.toFixed(6) + ' s',
      'Analysis channel: ' + (sig.channelNames[state.channel] || ('CH' + (state.channel + 1))),
      '',
      'TIME DOMAIN',
      t ? 'RMS: ' + t.rms.toFixed(8) + ' (' + t.rmsDbFs.toFixed(3) + ' dBFS)' : 'RMS: n/a',
      t ? 'AC RMS: ' + t.acRms.toFixed(8) + ' (' + t.acRmsDbFs.toFixed(3) + ' dBFS)' : '',
      t ? 'Peak: ' + t.peakAbs.toFixed(8) + ' (' + t.peakDbFs.toFixed(3) + ' dBFS)' : '',
      t ? 'Peak-to-peak: ' + t.peakToPeak.toFixed(8) : '',
      t ? 'DC: ' + t.dc.toFixed(8) + '  Crest factor: ' + t.crestFactorDb.toFixed(3) + ' dB' : '',
      '',
      'SPECTRUM',
      s && s.valid ? 'Window: ' + s.window + '  FFT: ' + s.fftSize + '  Segments: ' + s.segments : 'Spectrum: n/a',
      s && s.valid ? 'Fundamental: ' + s.fundamentalHz.toFixed(6) + ' Hz  ' + s.fundamentalDb.toFixed(3) + ' dB' : '',
      s && s.valid ? 'THD+N: ' + s.thdPlusNDb.toFixed(3) + ' dB (' + s.thdPlusPct.toFixed(5) + ' %)' : '',
      s && s.valid ? 'THD: ' + s.thdDb.toFixed(3) + ' dB  SNR: ' + s.snrDb.toFixed(3) + ' dB  SINAD: ' + s.sinadDb.toFixed(3) + ' dB' : '',
      s && s.valid ? 'ENOB: ' + s.enob.toFixed(3) + ' bit  Noise floor: ' + s.noiseFloorDb.toFixed(3) + ' dB' : '',
      s && s.weighting ? 'Weighting: ' + s.weighting : '',
      '',
      'JITTER',
      j && j.valid ? 'f0: ' + j.f0.toFixed(6) + ' Hz' : 'Jitter: n/a',
      j && j.valid ? 'RMS period: ' + (j.rmsPeriod * 1e12).toFixed(3) + ' ps' : '',
      j && j.valid ? 'P-P period: ' + (j.ppPeriod * 1e12).toFixed(3) + ' ps' : '',
      j && j.valid ? 'RMS cycle-cycle: ' + (j.rmsCycle * 1e12).toFixed(3) + ' ps  ' + j.percent.toFixed(4) + '%' : '',
      '',
      'BIT FIELDS (' + state.bitWordBits + '-bit, start is actual bit index)',
      ...(state.bitFields || []).map(f => f.name + ': start ' + f.start + ', width ' + f.width + ', ' + (f.signed ? 'signed' : 'unsigned') + ', ' + (f.msbFirst ? 'MSB First' : 'LSB First') + ', normalize=' + (f.normalize ? 'yes' : 'no')),
      '',
      'Filter: ' + (state.filterKind === 'none' ? 'off' : FILTER_NAMES[state.filterKind] + ' ' + state.filterCutoff + ' Hz'),
      'Selection: ' + (state.selection ? (state.selection.start + ' + ' + state.selection.count) : 'full record')
    ];
    downloadBlob((sig.name || 'nscld').replace(/\.[^.]+$/, '') + '-report.txt', new Blob([lines.filter(Boolean).join('\r\n')], { type: 'text/plain;charset=utf-8' }));
    setStatus('分析报告已导出');
  }

  function bitAt(word, index) { return (word >>> index) & 1; }

  function reverseBits(v, width) {
    let r = 0;
    for (let i = 0; i < width; i++) { r = (r << 1) | (v & 1); v >>>= 1; }
    return r >>> 0;
  }

  function decodeField(word, spec, wordBits) {
    const range = NSCLDBitfield.normalizeFieldRange(spec, wordBits);
    const start = range.start;
    const width = range.width;
    const low = range.end;
    const mask = width >= 32 ? 0xffffffff : ((1 << width) - 1) >>> 0;
    let code = (word >>> low) & mask;
    if (!spec.msbFirst) code = reverseBits(code, width);
    let signedCode = code;
    if (spec.signed && width > 0 && (code & (1 << (width - 1)))) signedCode = code - Math.pow(2, width);
    if (spec.normalize) {
      let frac = spec.signed ? signedCode / Math.pow(2, width - 1) : code / (Math.pow(2, width) - 1);
      if (Math.abs(spec.full) > 1e-15) {
        const limit = Math.abs(spec.full);
        frac *= spec.full;
        frac = clamp(frac, -limit, limit);
      }
      return frac;
    }
    return signedCode * (isFinite(spec.scale) ? spec.scale : 1) + (isFinite(spec.offset) ? spec.offset : 0);
  }

  async function applyBitFields(fields) {
    const base = state.baseSignal;
    if (!base) { $('bitError').textContent = '请先载入信号'; return; }
    if (!fields || !fields.length) { $('bitError').textContent = '至少需要一个字段'; return; }
    const bits = state.bitWordBits;
    const sourceChannel = state.bitSplit ? state.bitSourceChannel : state.channel;
    const srcData = base.channels[sourceChannel];
    const raw = base.rawWords && base.rawWords[sourceChannel] ? base.rawWords[sourceChannel] : null;
    const rawBits = base.rawBits || 0;
    const wordMask = bits >= 32 ? 0xffffffff : ((1 << bits) - 1) >>> 0;
    const channels = [];
    const units = [];
    for (let fi = 0; fi < fields.length; fi++) {
      const f = fields[fi];
      const out = new Float32Array(base.length);
      for (let i = 0; i < base.length; i++) {
        let word;
        if (raw && rawBits) word = raw[i] >>> 0;
        else {
          const scale = Math.pow(2, Math.max(1, bits - 1));
          word = (Math.round(srcData[i] * scale) >>> 0);
        }
        word = (word & wordMask) >>> 0;
        out[i] = decodeField(word, f, bits);
      }
      channels.push(out);
      units.push(f.unit || state.bitUnit || 'FS');
    }
    const sig = NSCLDFormats.baseSignal(base.name + ' · bitfields', base.sampleRate, channels, '位域拆分');
    sig.channelUnits = units;
    sig.channelNames = fields.map((f, i) => f.name || ('FIELD' + (i + 1)));
    sig.format = '位域拆分 · ' + fields.length + ' 字段';
    sig.bits = bits;
    state.bitSourceChannel = sourceChannel;
    state.bitSplit = true;
    state.signal = sig;
    state.channel = 0;
    state.channelCount = sig.channelCount;
    state.weighted = null;
    state.specs = []; state.spec = null; state.times = []; state.jitters = []; state.jitter = null;
    state.selection = null; state.cursorA = null; state.cursorB = null; state.playhead = null;
    state.waveX0 = 0; state.waveX1 = sig.duration;
    updateChannelSelect();
    updateFileMeta(base.name + ' · ' + fields.length + ' fields', sig.format);
    $('bitError').textContent = '';
    $('bitMeta').textContent = bits + '-bit · ' + fields.length + ' 字段 · 已拆分';
    updateEmpty();
    clearCards();
    renderPlots();
    setStatus('位域拆分完成 · ' + fields.length + ' 个字段通道');
    analyzeAll();
  }

  function restoreOriginal() {
    if (!state.baseSignal) return;
    const sig = state.baseSignal;
    state.signal = sig;
    state.bitSplit = false;
    state.channel = Math.min(state.bitSourceChannel || 0, sig.channelCount - 1);
    state.channelCount = sig.channelCount;
    state.weighted = null;
    state.specs = []; state.spec = null; state.times = []; state.jitters = []; state.jitter = null;
    state.selection = null;
    state.waveX0 = 0; state.waveX1 = sig.duration;
    updateChannelSelect();
    updateFileMeta(sig.name, sig.format + ' · ' + sig.sampleRate + ' Hz');
    $('bitMeta').textContent = state.bitWordBits + '-bit · ' + (state.bitFields ? state.bitFields.length : 0) + ' 字段';
    updateEmpty(); clearCards(); renderPlots();
    setStatus('已恢复原始信号');
    analyzeAll();
  }

  function fmtNum(v) {
    if (!isFinite(v)) return '—';
    if (v !== 0 && Math.abs(v) < 0.001) return v.toExponential(2);
    return v.toFixed(5);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

  app.analyzeAll = analyzeAll;
  app.updateMeasurements = updateMeasurements;
  app.updateSelectionInfo = updateSelectionInfo;
  app.applySelection = applySelection;
  app.resetWaveView = resetWaveView;
  app.resetSpectrumView = resetSpectrumView;
  app.showWaveMenu = showWaveMenu;
  app.showSpectrumMenu = showSpectrumMenu;
  app.statusHover = statusHover;
  app.setCursorLabel = setCursorLabel;
  app.saveSettings = saveSettings;
  app.applyBitFields = applyBitFields;
  app.restoreOriginal = restoreOriginal;
  app.setView = setView;

  function init() {
    syncControls();
    wavePlot = new NSCLDPlots.WaveformPlot($('waveCanvas'), app);
    spectrumPlot = new NSCLDPlots.SpectrumPlot($('spectrumCanvas'), app);
    jitterPlot = new NSCLDPlots.JitterPlot($('jitterCanvas'), app);
    editor = new NSCLDBitfield.BitFieldEditor(app);
    app.editor = editor;
    app.plots = { wave: wavePlot, spectrum: spectrumPlot, jitter: jitterPlot };
    bind();
    updateEmpty();
    clearCards();
    setStatus('NSCLD Web instrument · 载入信号或打开内置测试信号');
    setTimeout(loadDemo, 120);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
