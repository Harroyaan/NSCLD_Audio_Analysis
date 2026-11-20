(function (global) {
  'use strict';

  const P = {};
  const CHANNELS = ['#56c4ff', '#e8a838', '#7ec8a0', '#b09ee8', '#e89ab8'];

  function css(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function colors() {
    return {
      back: css('--panel', '#1a1d24'),
      plot: css('--bg', '#14161b'),
      card: css('--card', '#20242d'),
      grid: css('--grid', 'rgba(160,178,204,.12)'),
      text: css('--text', '#e9edf5'),
      muted: css('--muted', '#9aa5b8'),
      dim: css('--dim', '#687386'),
      accent: css('--accent', '#56c4ff'),
      amber: css('--amber', '#e8a838'),
      green: css('--green', '#7ec8a0'),
      violet: css('--violet', '#b09ee8'),
      line: css('--line', '#303744')
    };
  }

  function font(size, weight, mono) {
    return (weight || 400) + ' ' + size + 'px ' + (mono ? '"Cascadia Mono", Consolas, monospace' : '"Segoe UI Variable Text", "Segoe UI", sans-serif');
  }

  function niceTicks(lo, hi, count) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / Math.max(2, count);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  }

  function logTicks(lo, hi) {
    const out = [];
    for (let d = Math.floor(Math.log10(Math.max(1, lo))); d <= Math.ceil(Math.log10(Math.max(10, hi))); d++) {
      const v = Math.pow(10, d);
      if (v >= lo && v <= hi) out.push(v);
    }
    if (lo <= 20 && hi >= 20) out.push(20);
    if (lo <= 20000 && hi >= 20000) out.push(20000);
    return [...new Set(out)].sort((a, b) => a - b);
  }

  function fmtTick(v) {
    const a = Math.abs(v);
    if (a >= 1e6) return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (a >= 1e3) return (v / 1e3).toFixed(2).replace(/\.?0+$/, '') + 'k';
    if (a >= 1) return v.toFixed(3).replace(/\.?0+$/, '');
    if (a > 0) return v.toPrecision(2);
    return '0';
  }

  function timeText(t) {
    const a = Math.abs(t);
    if (a >= 1) return t.toFixed(4).replace(/\.?0+$/, '') + ' s';
    if (a >= 1e-3) return (t * 1e3).toFixed(2) + ' ms';
    if (a >= 1e-6) return (t * 1e6).toFixed(2) + ' µs';
    return (t * 1e9).toFixed(1) + ' ns';
  }

  class Plot {
    constructor(canvas, app) {
      this.canvas = canvas;
      this.app = app;
      this.ctx = canvas.getContext('2d');
      this.w = 1; this.h = 1; this.dpr = 1;
      this.resize = this.resize.bind(this);
      new ResizeObserver(this.resize).observe(canvas);
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = Math.max(1, r.width);
      this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.draw();
    }
    clear(c) {
      const g = this.ctx;
      g.clearRect(0, 0, this.w, this.h);
      g.fillStyle = c.plot;
      g.fillRect(0, 0, this.w, this.h);
    }
    text(s, x, y, opts) {
      const g = this.ctx;
      g.font = font((opts && opts.size) || 10, (opts && opts.weight) || 400, !!(opts && opts.mono));
      g.fillStyle = (opts && opts.color) || colors().muted;
      g.textAlign = (opts && opts.align) || 'left';
      g.textBaseline = (opts && opts.baseline) || 'alphabetic';
      g.fillText(s, x, y);
    }
    line(x0, y0, x1, y1, color, width, dash) {
      const g = this.ctx;
      g.save();
      g.strokeStyle = color;
      g.lineWidth = width || 1;
      if (dash) g.setLineDash(dash);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.restore();
    }
    rect(x, y, w, h, fill, stroke) {
      const g = this.ctx;
      if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); }
      if (stroke) { g.strokeStyle = stroke; g.strokeRect(x, y, w, h); }
    }
    chip(s, x, y, color) {
      const g = this.ctx;
      g.font = font(9, 500, true);
      const w = g.measureText(s).width + 12;
      g.fillStyle = 'rgba(20,23,30,.82)';
      g.fillRect(x, y, w, 18);
      g.strokeStyle = color; g.globalAlpha = .35; g.strokeRect(x + .5, y + .5, w - 1, 17); g.globalAlpha = 1;
      g.fillStyle = color; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(s, x + 6, y + 9);
    }
  }

  class WaveformPlot extends Plot {
    constructor(canvas, app) {
      super(canvas, app);
      this.state = app.state;
      this.drag = null;
      this.mid = null;
      this.hover = null;
      this.cursorColor = null;
      canvas.addEventListener('pointerdown', e => this.down(e));
      canvas.addEventListener('pointermove', e => this.move(e));
      canvas.addEventListener('pointerup', e => this.up(e));
      canvas.addEventListener('pointerleave', e => this.leave(e));
      canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
      canvas.addEventListener('contextmenu', e => { e.preventDefault(); });
      canvas.addEventListener('pointerdown', e => { if (e.button === 2) e.preventDefault(); });
      this.resize();
    }
    view() {
      const s = this.state;
      return { x0: s.waveX0, x1: s.waveX1 };
    }
    plotRect() { return { left: 62, top: 26, right: this.w - 12, bottom: this.h - 30 }; }
    timeAt(x) {
      const r = this.plotRect(), v = this.view();
      return v.x0 + (x - r.left) / Math.max(1, r.right - r.left) * (v.x1 - v.x0);
    }
    xAt(t) {
      const r = this.plotRect(), v = this.view();
      return r.left + (t - v.x0) / Math.max(1e-12, v.x1 - v.x0) * (r.right - r.left);
    }
    laneAt(e) {
      const sig = this.state.signal; if (!sig) return 0;
      if (this.state.waveOverlay) return this.state.channel;
      const r = this.plotRect();
      const y = e.clientY - this.canvas.getBoundingClientRect().top;
      if (y < r.top || y > r.bottom) return 0;
      const c = Math.floor((y - r.top) / Math.max(1, (r.bottom - r.top) / sig.channelCount));
      return Math.max(0, Math.min(sig.channelCount - 1, c));
    }
    laneRect(c) {
      const sig = this.state.signal, r = this.plotRect();
      if (!sig || this.state.waveOverlay) return r;
      const n = Math.max(1, sig.channelCount), h = (r.bottom - r.top) / n;
      const top = r.top + c * h;
      return { left: r.left, right: r.right, top: top, bottom: c === n - 1 ? r.bottom : top + h };
    }
    rangeSignature() {
      const s = this.state;
      return [s.waveX0, s.waveX1, s.waveOverlay ? 1 : 0, s.channel, s.weighted ? 1 : 0,
        s.fixedY ? JSON.stringify(s.fixedY) : ''].join('|');
    }
    prepareRanges() {
      const s = this.state, sig = s.signal;
      if (!sig) return;
      const signature = this.rangeSignature();
      if (this._rangeSignature === signature && this._rangeSignal === sig && this._rangeWeighted === s.weighted) return;
      this._rangeSignature = signature;
      this._rangeSignal = sig;
      this._rangeWeighted = s.weighted;
      this._rangeCache = [];
      if (s.waveOverlay) {
        const range = this.computeRange('overlay');
        for (let c = 0; c < sig.channelCount; c++) this._rangeCache[c] = range;
      } else {
        for (let c = 0; c < sig.channelCount; c++) this._rangeCache[c] = this.computeRange(c);
      }
    }
    computeRange(c) {
      const s = this.state, sig = s.signal, key = s.waveOverlay ? 'overlay' : c;
      if (s.fixedY && s.fixedY[key]) return s.fixedY[key];
      const v = this.view();
      const start = Math.max(0, Math.floor(v.x0 * sig.sampleRate));
      const end = Math.min(sig.length, Math.ceil(v.x1 * sig.sampleRate));
      const stride = Math.max(1, Math.floor((end - start) / 60000));
      let lo = Infinity, hi = -Infinity;
      const list = s.waveOverlay ? sig.channels : [sig.channels[c]];
      for (let ch = 0; ch < list.length; ch++) {
        const samples = list[ch];
        for (let i = start; i < end; i += stride) { const x = samples[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
      }
      if (s.weighted && (s.waveOverlay || c === s.channel)) {
        const w = s.weighted;
        for (let i = start; i < end; i += stride) { const x = w[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
      }
      if (!isFinite(lo) || lo === hi) { lo = -1; hi = 1; }
      const span = Math.max(hi - lo, 1e-9);
      const pad = span * .12;
      return [lo - pad, hi + pad];
    }
    rangeFor(c) {
      if (!this.state.signal) return [-1, 1];
      this.prepareRanges();
      return this._rangeCache[c] || [-1, 1];
    }
    yAt(c, v, range, rect) {
      const lr = rect || this.laneRect(c), r = range || this.rangeFor(c);
      return lr.bottom - (v - r[0]) / Math.max(1e-12, r[1] - r[0]) * (lr.bottom - lr.top);
    }
    draw() {
      const c = colors(), s = this.state;
      this.clear(c);
      if (!s.signal || !s.signal.channels.length) {
        this.text('打开波形或载入内置测试信号', this.w / 2, this.h / 2, { align: 'center', color: c.dim, size: 13 });
        return;
      }
      const sig = s.signal, r = this.plotRect(), v = this.view();
      const laneCount = sig.channelCount;
      const x0 = Math.max(0, Math.floor(v.x0 * sig.sampleRate));
      const x1 = Math.min(sig.length, Math.ceil(v.x1 * sig.sampleRate));
      const spp = (v.x1 - v.x0) * sig.sampleRate / Math.max(1, r.right - r.left);
      const xTicks = niceTicks(v.x0, v.x1, 7);
      const g = this.ctx;
      this.prepareRanges();
      g.save();
      for (const t of xTicks) {
        const x = this.xAt(t);
        this.line(x, r.top, x, r.bottom, c.grid, 1);
        this.text(fmtTick(t), x, r.bottom + 15, { size: 9, color: c.dim, align: 'center' });
      }
      for (let ch = 0; ch < laneCount; ch++) {
        const lr = this.laneRect(ch);
        const yr = this._rangeCache[ch] || [-1, 1];
        const yPix = value => lr.bottom - (value - yr[0]) / Math.max(1e-12, yr[1] - yr[0]) * (lr.bottom - lr.top);
        if (!s.waveOverlay && (ch & 1)) this.rect(lr.left, lr.top, lr.right - lr.left, lr.bottom - lr.top, 'rgba(255,255,255,.018)');
        if (!s.waveOverlay || ch === 0) this.line(lr.left, lr.top, lr.right, lr.top, c.grid, 1);
        if (!s.waveOverlay || ch === 0) {
          const yTicks = niceTicks(yr[0], yr[1], 3);
          for (const yv of yTicks) {
            const y = yPix(yv);
            this.line(lr.left, y, lr.right, y, c.grid, yv === 0 ? 1 : .7);
            const ySpan = yr[1] - yr[0];
            const dec = ySpan < 0.001 ? 6 : ySpan < 0.01 ? 4 : ySpan < 0.1 ? 3 : 2;
            this.text((yv > 0 ? '+' : '') + yv.toFixed(dec), lr.left + 5, y, { size: 8, color: c.dim, mono: true });
          }
        }
        const trace = sig.channels[ch];
        g.beginPath();
        const color = CHANNELS[ch % CHANNELS.length];
        let started = false;
        if (spp > 1.5) {
          for (let x = r.left; x < r.right; x++) {
            const i0 = Math.max(0, Math.floor(this.timeAt(x) * sig.sampleRate));
            const i1 = Math.max(i0 + 1, Math.min(x1, Math.floor(this.timeAt(x + 1) * sig.sampleRate)));
            let lo = Infinity, hi = -Infinity;
            const stride = Math.max(1, Math.floor((i1 - i0) / 64));
            for (let i = i0; i < i1; i += stride) { const q = trace[i]; if (q < lo) lo = q; if (q > hi) hi = q; }
            if (!isFinite(lo)) continue;
            const ya = yPix(hi), yb = yPix(lo);
            if (!started) { g.moveTo(x, ya); started = true; }
            g.lineTo(x, ya); g.lineTo(x, yb);
          }
        } else {
          const i0 = Math.max(0, Math.floor(v.x0 * sig.sampleRate));
          const i1 = Math.min(sig.length, Math.ceil(v.x1 * sig.sampleRate));
          for (let i = i0; i < i1; i += Math.max(1, Math.floor((i1 - i0) / 4000))) {
            const x = this.xAt(i / sig.sampleRate), y = yPix(trace[i]);
            if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
          }
        }
        g.globalAlpha = .86;
        g.strokeStyle = color; g.lineWidth = 1.1; g.stroke();
        g.globalAlpha = 1;
        if (ch === s.channel && s.weighted) {
          const w = s.weighted;
          g.beginPath();
          const ii0 = Math.max(0, Math.floor(v.x0 * sig.sampleRate));
          const ii1 = Math.min(sig.length, Math.ceil(v.x1 * sig.sampleRate));
          const step = Math.max(1, Math.floor((ii1 - ii0) / 5000));
          for (let i = ii0; i < ii1; i += step) {
            const x = this.xAt(i / sig.sampleRate), y = yPix(w[i]);
            if (i === ii0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.strokeStyle = c.amber; g.lineWidth = 1; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
        }
        const labelY = lr.top + 11;
        const labelX = s.waveOverlay ? lr.left + 48 + ch * Math.min(92, (lr.right - lr.left - 56) / Math.max(1, laneCount)) : lr.left + 48;
        this.text(sig.channelNames[ch] + '  [' + sig.channelUnits[ch] + ']', labelX, labelY, { size: 9, color: c.text, weight: 500 });
        this.rect(labelX - 8, lr.top + 7, 5, 5, color, null);
      }
      const sel = s.selection;
      if (sel && sel.count > 0) {
        const xa = this.xAt(sel.start / sig.sampleRate), xb = this.xAt((sel.start + sel.count) / sig.sampleRate);
        this.rect(Math.max(r.left, xa), r.top, Math.max(0, Math.min(r.right, xb) - Math.max(r.left, xa)), r.bottom - r.top, 'rgba(158,170,188,.13)');
        this.line(Math.max(r.left, xa), r.top, Math.max(r.left, xa), r.bottom, 'rgba(200,206,216,.55)', 1, [4, 3]);
      }
      if (s.cursorA != null) this.cursor(s.cursorA, 'A', c.accent, false);
      if (s.cursorB != null) this.cursor(s.cursorB, 'B', c.amber, true);
      if (s.playhead != null) {
        const x = this.xAt(s.playhead);
        this.line(x, r.top, x, r.bottom, c.text, 1.4);
        this.rect(x - 4, r.top, 8, 4, c.text, null);
      }
      if (this.mid && this.mid.drag) {
        const xa = Math.min(this.mid.x0, this.mid.x1), xb = Math.max(this.mid.x0, this.mid.x1);
        const ya = Math.min(this.mid.y0, this.mid.y1), yb = Math.max(this.mid.y0, this.mid.y1);
        this.rect(xa, this.mid.shift ? ya : r.top, xb - xa, (this.mid.shift ? yb - ya : r.bottom - r.top), 'rgba(158,170,188,.13)');
        this.line(xa, this.mid.shift ? ya : r.top, xa, this.mid.shift ? yb : r.bottom, 'rgba(200,206,216,.6)', 1, [4, 3]);
        this.line(xb, this.mid.shift ? ya : r.top, xb, this.mid.shift ? yb : r.bottom, 'rgba(200,206,216,.6)', 1, [4, 3]);
        if (this.mid.shift) {
          this.line(xa, ya, xb, ya, 'rgba(200,206,216,.6)', 1, [4, 3]);
          this.line(xa, yb, xb, yb, 'rgba(200,206,216,.6)', 1, [4, 3]);
        }
        const d = Math.abs(this.timeAt(xb) - this.timeAt(xa));
        this.chip('Δt ' + timeText(d), xa + 4, (this.mid.shift ? ya : r.top) + 4, c.amber);
      }
      this.text(s.selection ? '选区 ' + timeText(s.selection.start / sig.sampleRate) + ' → ' + timeText((s.selection.start + s.selection.count) / sig.sampleRate) : '全记录', r.left, this.h - 7, { size: 9, color: c.dim, mono: true });
      this.text(sig.sampleRate.toLocaleString() + ' Hz · ' + sig.length.toLocaleString() + ' samples', r.right, this.h - 7, { size: 9, color: c.dim, align: 'right', mono: true });
      g.restore();
    }
    cursor(t, name, color, dashed) {
      const r = this.plotRect(), x = this.xAt(t);
      if (x < r.left || x > r.right) return;
      this.line(x, r.top, x, r.bottom, color, 1, dashed ? [5, 3] : null);
      const sig = this.state.signal;
      const idx = Math.max(0, Math.min(sig.length - 1, Math.round(t * sig.sampleRate)));
      const c = this.state.channel;
      const data = c === this.state.channel && this.state.weighted ? this.state.weighted : sig.channels[c];
      const v = data[idx];
      this.chip(name + ' ' + timeText(t) + '  ' + v.toFixed(5) + (data === this.state.weighted ? ' (滤波)' : ''), x + 4, r.bottom - 22, color);
    }
    down(e) {
      const sig = this.state.signal; if (!sig) return;
      this.canvas.setPointerCapture(e.pointerId);
      const local = this.local(e), r = this.plotRect();
      if (e.button === 1) {
        e.preventDefault();
        const now = Date.now();
        if (this._lastMiddle && now - this._lastMiddle < 360) {
          this._lastMiddle = 0;
          this.app.resetWaveView();
          return;
        }
        this._lastMiddle = now;
        this.mid = { drag: true, x0: local.x, x1: local.x, y0: local.y, y1: local.y, shift: e.shiftKey, lane: this.laneAt(e) };
        return;
      }
      if (e.button === 2) {
        this.drag = { type: 'select', x0: local.x, x1: local.x, start: this.timeAt(local.x), moved: false };
        e.preventDefault();
        return;
      }
      this.drag = { type: 'pan', x0: local.x, x1: local.x, startX: this.state.waveX0, endX: this.state.waveX1, moved: false, ctrl: e.ctrlKey };
    }
    move(e) {
      const sig = this.state.signal; if (!sig) return;
      const local = this.local(e);
      if (this.drag) {
        const dx = local.x - this.drag.x0;
        if (Math.abs(dx) > 3) this.drag.moved = true;
        if (this.drag.type === 'pan' && this.drag.moved) {
          const span = this.drag.endX - this.drag.startX;
          const delta = -dx / Math.max(1, this.plotRect().right - this.plotRect().left) * span;
          const max = sig.duration;
          let a = this.drag.startX + delta, b = this.drag.endX + delta;
          if (a < 0) { b -= a; a = 0; }
          if (b > max) { a -= b - max; b = max; }
          this.state.waveX0 = Math.max(0, a); this.state.waveX1 = Math.min(max, b);
          this.draw();
        } else if (this.drag.type === 'select') {
          this.drag.x1 = local.x;
          const x0 = Math.min(this.drag.x0, local.x), x1 = Math.max(this.drag.x0, local.x);
          this.state.selection = { start: Math.round(this.timeAt(x0) * sig.sampleRate), count: Math.max(1, Math.round((this.timeAt(x1) - this.timeAt(x0)) * sig.sampleRate)) };
          this.draw();
        }
      }
      if (this.mid && this.mid.drag) {
        this.mid.x1 = local.x;
        this.mid.y1 = local.y;
        this.draw();
      }
      const t = this.timeAt(local.x);
      const lane = this.laneAt(e);
      if (this.state.fixedY) {
        this.app.statusHover('t ' + timeText(t));
      } else {
        this.app.statusHover('t ' + timeText(t) + '  ' + sig.channelNames[lane]);
      }
    }
    up(e) {
      const sig = this.state.signal; if (!sig) return;
      const local = this.local(e);
      if (this.mid && this.mid.drag) {
        this.mid.drag = false;
        const dx = Math.abs(this.mid.x1 - this.mid.x0);
        const dy = Math.abs(this.mid.y1 - this.mid.y0);
        if (e.shiftKey && dy > 3) {
          const lane = this.mid.lane, lr = this.laneRect(lane), yr = this.rangeFor(lane);
          const ya = Math.min(this.mid.y0, this.mid.y1), yb = Math.max(this.mid.y0, this.mid.y1);
          const vTop = yr[0] + (lr.bottom - ya) / Math.max(1, lr.bottom - lr.top) * (yr[1] - yr[0]);
          const vBottom = yr[0] + (lr.bottom - yb) / Math.max(1, lr.bottom - lr.top) * (yr[1] - yr[0]);
          if (!this.state.fixedY) this.state.fixedY = {};
          this.state.fixedY[lane] = [Math.min(vTop, vBottom), Math.max(vTop, vBottom)];
        } else if (dx > 3) {
          const t0 = this.timeAt(Math.min(this.mid.x0, this.mid.x1));
          const t1 = this.timeAt(Math.max(this.mid.x0, this.mid.x1));
          const span = Math.max(1e-3, t1 - t0);
          this.state.waveX0 = Math.max(0, Math.min(this.state.waveX0 + (t0 - this.state.waveX0), sig.duration - span));
          this.state.waveX1 = this.state.waveX0 + span;
        }
        this.mid = null;
        this.app.updateSelectionInfo();
        this.draw();
        return;
      }
      if (this.drag) {
        if (this.drag.type === 'select') {
          if (this.drag.moved) this.app.applySelection();
          else this.app.showWaveMenu(e.clientX, e.clientY, this.laneAt(e));
        } else if (!this.drag.moved) {
          const t = this.timeAt(local.x);
          if (e.ctrlKey) {
            this.state.cursorB = t; this.app.setCursorLabel('B', 'A');
          } else {
            this.state.cursorA = t; this.app.setCursorLabel('A', 'A');
          }
          this.app.updateMeasurements();
          this.draw();
        }
        this.drag = null;
      }
    }
    leave() { if (!this.drag && !this.mid) this.app.statusHover(''); }
    wheel(e) {
      const sig = this.state.signal; if (!sig) return;
      e.preventDefault();
      const local = this.local(e), r = this.plotRect();
      if (e.shiftKey) {
        const lane = this.laneAt(e), lr = this.laneRect(lane), yr = this.rangeFor(lane);
        const anchor = yr[0] + (lr.bottom - local.y) / Math.max(1, lr.bottom - lr.top) * (yr[1] - yr[0]);
        const factor = e.deltaY > 0 ? 1.15 : .85;
        const lo = anchor + (yr[0] - anchor) * factor, hi = anchor + (yr[1] - anchor) * factor;
        if (!this.state.fixedY) this.state.fixedY = {};
        this.state.fixedY[lane] = [lo, hi];
      } else {
        const factor = e.deltaY > 0 ? 1.15 : .85;
        const anchor = this.timeAt(local.x);
        let a = anchor + (this.state.waveX0 - anchor) * factor;
        let b = anchor + (this.state.waveX1 - anchor) * factor;
        a = Math.max(0, a); b = Math.min(sig.duration, b);
        if (b - a > 1e-7) { this.state.waveX0 = a; this.state.waveX1 = b; }
      }
      this.app.updateSelectionInfo();
      this.draw();
    }
    local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    localY(e) { return e.clientY - this.canvas.getBoundingClientRect().top; }
  }

  class SpectrumPlot extends Plot {
    constructor(canvas, app) {
      super(canvas, app);
      this.hover = null;
      this.drag = null;
      this.state = app.state;
      canvas.addEventListener('pointermove', e => this.move(e));
      canvas.addEventListener('pointerleave', () => { this.hover = null; this.app.statusHover(''); this.draw(); });
      canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
      canvas.addEventListener('pointerdown', e => this.down(e));
      canvas.addEventListener('pointerup', e => this.up(e));
      canvas.addEventListener('contextmenu', e => { e.preventDefault(); this.app.showSpectrumMenu(e.clientX, e.clientY); });
      canvas.addEventListener('dblclick', () => this.app.resetSpectrumView());
      this.resize();
    }
    plotRect() { return { left: 62, top: 48, right: this.w - 14, bottom: this.h - 30 }; }
    xAt(f) {
      const r = this.plotRect();
      if (this.state.logX) {
        const a = Math.log10(Math.max(1, this.state.specX0)), b = Math.log10(Math.max(10, this.state.specX1));
        return r.left + (Math.log10(Math.max(1, f)) - a) / Math.max(1e-9, b - a) * (r.right - r.left);
      }
      return r.left + (f - this.state.specX0) / Math.max(1e-9, this.state.specX1 - this.state.specX0) * (r.right - r.left);
    }
    fAt(x) {
      const r = this.plotRect(), t = (x - r.left) / Math.max(1, r.right - r.left);
      if (this.state.logX) {
        const a = Math.log10(Math.max(1, this.state.specX0)), b = Math.log10(Math.max(10, this.state.specX1));
        return Math.pow(10, a + t * (b - a));
      }
      return this.state.specX0 + t * (this.state.specX1 - this.state.specX0);
    }
    laneRect(c, n) {
      const r = this.plotRect();
      if (!this.state.specStacked || n <= 1) return r;
      const top = r.top + 20, h = (r.bottom - top) / n;
      return { left: r.left, right: r.right, top: top + c * h, bottom: c === n - 1 ? r.bottom : top + (c + 1) * h };
    }
    draw() {
      const c = colors(), s = this.state;
      this.clear(c);
      const specs = s.specs || [];
      if (!specs.length || !specs[0]) {
        this.text('载入信号后进行 FFT 分析', this.w / 2, this.h / 2, { align: 'center', color: c.dim, size: 13 });
        return;
      }
      const g = this.ctx, r = this.plotRect();
      const n = specs.length;
      const stack = s.specStacked && n > 1;
      const y0 = -150, y1 = s.specY1 || 10;
      const yAt = y => r.bottom - (y - y0) / Math.max(1e-9, y1 - y0) * (r.bottom - r.top);
      const xTicks = s.logX ? logTicks(s.specX0, s.specX1) : niceTicks(s.specX0, s.specX1, 7);
      for (const f of xTicks) {
        const x = this.xAt(f);
        this.line(x, r.top, x, r.bottom, c.grid, .7);
        this.text(fmtTick(f), x, r.bottom + 15, { size: 9, color: c.dim, align: 'center', mono: true });
      }
      const yTicks = niceTicks(y0, y1, 7);
      for (const yv of yTicks) {
        const yy = yAt(yv);
        this.line(r.left, yy, r.right, yy, c.grid, .7);
        this.text(yv.toFixed(0), r.left - 8, yy + 3, { size: 8, color: c.dim, align: 'right', mono: true });
      }
      for (let ch = 0; ch < n; ch++) {
        const sp = specs[ch]; if (!sp || !sp.valid) continue;
        const lane = this.laneRect(ch, n);
        const laneY = y => stack ? lane.bottom - (y - y0) / Math.max(1e-9, y1 - y0) * (lane.bottom - lane.top) : yAt(y);
        const color = CHANNELS[ch % CHANNELS.length];
        g.save();
        g.beginPath();
        let started = false;
        const pixelWidth = Math.max(1, Math.round(r.right - r.left));
        for (let px = 0; px <= pixelWidth; px++) {
          const x = r.left + px;
          const fa = this.fAt(x), fb = this.fAt(Math.min(r.right, x + 1));
          let i0 = Math.max(1, Math.floor(Math.min(fa, fb) / sp.binHz));
          let i1 = Math.min(sp.freq.length - 1, Math.ceil(Math.max(fa, fb) / sp.binHz));
          if (i1 < i0) i1 = i0;
          let peak = -Infinity;
          for (let i = i0; i <= i1; i++) if (sp.db[i] > peak) peak = sp.db[i];
          if (!isFinite(peak)) continue;
          const yy = laneY(peak);
          if (!started) { g.moveTo(x, yy); started = true; } else g.lineTo(x, yy);
        }
        g.strokeStyle = color; g.lineWidth = 1.15; g.stroke();
        g.restore();
        if (stack) {
          this.rect(lane.left + 7, lane.top + 7, 10, 3, color);
          this.text(s.signal.channelNames[ch] + ' [' + s.signal.channelUnits[ch] + ']', lane.left + 22, lane.top + 10, { size: 9, color: c.text });
        }
        if (sp.valid) {
          const x = this.xAt(sp.fundamentalHz), yy = laneY(sp.fundamentalDb);
          this.ctx.beginPath(); this.ctx.arc(x, yy, 3, 0, Math.PI * 2); this.ctx.fillStyle = c.green; this.ctx.fill();
          this.text('F0', x + 4, yy - 6, { size: 8, color: c.green, mono: true });
        }
      }
      if (!stack && n > 1) {
        let x = r.right - 8;
        for (let ch = n - 1; ch >= 0; ch--) {
          const label = s.signal.channelNames[ch] + ' [' + s.signal.channelUnits[ch] + ']';
          this.ctx.font = font(9, 400, true);
          const w = this.ctx.measureText(label).width + 16;
          this.rect(x - w, r.top + 8, w, 16, 'rgba(20,23,30,.6)');
          this.rect(x - w + 5, r.top + 14, 7, 3, CHANNELS[ch % CHANNELS.length]);
          this.text(label, x - w + 16, r.top + 20, { size: 9, color: c.text, mono: true });
          x -= w + 8;
        }
      }
      if (this.hover) this.drawSnap(this.hover, specs, n, stack, y0, y1, yAt);
      const sp = s.spec || specs[0];
      this.text('FFT ' + (sp.fftSize || '—') + '  Δf ' + (sp.binHz ? sp.binHz.toFixed(3) : '—') + ' Hz  ' + (sp.window || '') + '  ' + (sp.segments || 0) + ' 段' + (sp.weighting ? '  ' + sp.weighting + ' 加权' : ''), r.left, 18, { size: 10, color: c.muted, mono: true });
      this.text(s.logX ? '对数频率' : '线性频率', r.left, this.h - 7, { size: 9, color: c.dim, mono: true });
      this.text('dBFS', 14, r.top + (r.bottom - r.top) / 2, { size: 9, color: c.dim, align: 'center', baseline: 'middle' });
    }
    drawSnap(h, specs, n, stack, y0, y1, yAt) {
      const sp = specs[h.ch]; if (!sp || !sp.valid) return;
      const lane = this.laneRect(h.ch, n);
      const y = stack ? lane.bottom - (h.db - y0) / Math.max(1e-9, y1 - y0) * (lane.bottom - lane.top) : yAt(h.db);
      const x = this.xAt(h.f);
      this.line(x, this.plotRect().top, x, this.plotRect().bottom, colors().accent, 1, [4, 3]);
      this.line(this.plotRect().left, y, this.plotRect().right, y, colors().accent, 1, [4, 3]);
      this.ctx.beginPath(); this.ctx.arc(x, y, 4, 0, Math.PI * 2); this.ctx.fillStyle = colors().accent; this.ctx.fill();
      const label = (n > 1 && !stack ? AppChannelName(this.app, h.ch) + '  ' : '') + h.f.toFixed(2) + ' Hz  ' + h.db.toFixed(2) + ' dB';
      this.chip(label, Math.min(x + 10, this.w - 190), Math.max(y - 24, this.plotRect().top + 2), colors().accent);
    }
    move(e) {
      const specs = this.state.specs || []; if (!specs.length) return;
      const local = this.local(e);
      if (this.drag) {
        const dx = local.x - this.drag.x;
        if (Math.abs(dx) > 2) {
          const f = this.factor(dx);
          const a = this.drag.f0 * f, b = this.drag.f1 * f;
          this.state.specX0 = Math.max(1, a); this.state.specX1 = b; this.draw();
        }
        return;
      }
      const r = this.plotRect();
      if (local.x < r.left || local.x > r.right || local.y < r.top || local.y > r.bottom) { this.hover = null; this.draw(); return; }
      const f = this.fAt(local.x);
      const stack = this.state.specStacked && specs.length > 1;
      let best = null, bestD = 48 * 48;
      for (let ch = 0; ch < specs.length; ch++) {
        const sp = specs[ch]; if (!sp || !sp.valid) continue;
        if (stack && ch !== this.state.channel) continue;
        const lane = this.laneRect(ch, specs.length);
        const y0 = -150, y1 = this.state.specY1 || 10;
        let lo = 1, hi = sp.freq.length - 1;
        const fa = this.fAt(local.x - 48), fb = this.fAt(local.x + 48);
        lo = Math.max(1, Math.floor(Math.min(fa, fb) / sp.binHz));
        hi = Math.min(hi, Math.ceil(Math.max(fa, fb) / sp.binHz));
        for (let i = lo; i <= hi; i++) {
          const xx = this.xAt(sp.freq[i]);
          const yy = stack ? lane.bottom - (sp.db[i] - y0) / Math.max(1e-9, y1 - y0) * (lane.bottom - lane.top) : r.bottom - (sp.db[i] - y0) / Math.max(1e-9, y1 - y0) * (r.bottom - r.top);
          const d = (xx - local.x) ** 2 + (yy - local.y) ** 2;
          if (d < bestD) { bestD = d; best = { ch: ch, i: i, f: sp.freq[i], db: sp.db[i] }; }
        }
      }
      this.hover = best;
      if (best) this.app.statusHover((specs.length > 1 ? 'CH' + (best.ch + 1) + '  ' : '') + best.f.toFixed(2) + ' Hz  ' + best.db.toFixed(2) + ' dB');
      else this.app.statusHover('f ' + fmtTick(f) + ' Hz');
      this.draw();
    }
    down(e) {
      if (!this.state.specs || !this.state.specs.length) return;
      const local = this.local(e);
      if (e.button === 2) return;
      this.drag = { x: local.x, f0: this.state.specX0, f1: this.state.specX1 };
    }
    up() { this.drag = null; }
    factor(dx) {
      const base = this.state.logX
        ? Math.pow(this.state.specX1 / this.state.specX0, -dx / Math.max(160, this.plotRect().right - this.plotRect().left))
        : Math.exp(-dx / Math.max(160, this.plotRect().right - this.plotRect().left) * 3);
      return Math.max(0.7, Math.min(1.4, base));
    }
    wheel(e) {
      e.preventDefault();
      const local = this.local(e), f = this.fAt(local.x);
      const factor = e.deltaY > 0 ? 1.15 : .85;
      let a = f + (this.state.specX0 - f) * factor, b = f + (this.state.specX1 - f) * factor;
      a = Math.max(this.state.logX ? 20 : 0, a);
      if (this.state.specs && this.state.specs[0]) b = Math.min(b, this.state.specs[0].freq[this.state.specs[0].freq.length - 1]);
      if (b - a > 1) { this.state.specX0 = a; this.state.specX1 = b; this.draw(); }
    }
    local(e) { const r = this.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  }

  function AppChannelName(app, ch) {
    const sig = app.state.signal;
    return sig && sig.channelNames ? sig.channelNames[ch] : 'CH' + (ch + 1);
  }

  class JitterPlot extends Plot {
    constructor(canvas, app) { super(canvas, app); this.state = app.state; this.resize(); }
    draw() {
      const c = colors(), s = this.state, j = s.jitter;
      this.clear(c);
      const r = { left: 58, top: 34, right: this.w - 16, bottom: this.h - 30 };
      for (let i = 0; i <= 6; i++) {
        const y = r.top + (r.bottom - r.top) * i / 6;
        this.line(r.left, y, r.right, y, c.grid, .7);
      }
      if (!j || !j.valid) {
        this.text('载入准周期信号后显示周期抖动', this.w / 2, this.h / 2, { align: 'center', color: c.dim, size: 13 });
        return;
      }
      const errs = j.trend.map(t => t.error / Math.max(1, j.meanPeriod));
      const showTrend = document.getElementById('jitterTrend').checked;
      let maxAbs = 1e-12; errs.forEach(v => maxAbs = Math.max(maxAbs, Math.abs(v)));
      if (showTrend) {
        const tx = i => r.left + i / Math.max(1, errs.length - 1) * (r.right - r.left);
        const ty = v => (r.top + r.bottom) / 2 - v / maxAbs * (r.bottom - r.top) * .42;
        this.line(r.left, ty(0), r.right, ty(0), c.grid, 1);
        const rmsRel = j.meanPeriod > 0 ? j.rmsPeriod / j.meanPeriod : 0;
        this.line(r.left, ty(rmsRel), r.right, ty(rmsRel), c.amber, 1, [5, 4]);
        this.line(r.left, ty(-rmsRel), r.right, ty(-rmsRel), c.amber, 1, [5, 4]);
        this.text('+' + (maxAbs * 100).toFixed(3) + '%', r.left - 8, r.top + 4, { size: 8, color: c.dim, align: 'right', mono: true });
        this.text('0', r.left - 8, ty(0) + 3, { size: 8, color: c.dim, align: 'right', mono: true });
        this.text('-' + (maxAbs * 100).toFixed(3) + '%', r.left - 8, r.bottom, { size: 8, color: c.dim, align: 'right', mono: true });
        const stride = Math.max(1, Math.floor(errs.length / 2400));
        this.ctx.save();
        this.ctx.globalAlpha = .62;
        for (let i = 0; i < errs.length; i += stride) {
          const v = errs[i];
          this.ctx.beginPath();
          this.ctx.arc(tx(i), ty(v), Math.abs(v) > rmsRel * 3 ? 1.7 : 1, 0, Math.PI * 2);
          this.ctx.fillStyle = Math.abs(v) > rmsRel * 3 ? c.amber : c.accent;
          this.ctx.fill();
        }
        this.ctx.restore();
        for (let i = 0; i <= 4; i++) {
          const x = r.left + (r.right - r.left) * i / 4;
          this.line(x, r.top, x, r.bottom, c.grid, .5);
          this.text(String(Math.round(errs.length * i / 4)), x, r.bottom + 13, { size: 8, color: c.dim, align: 'center', mono: true });
        }
        this.text('周期序号 →', r.right, this.h - 7, { size: 9, color: c.dim, align: 'right', mono: true });
      } else {
        const bins = 56, counts = new Uint32Array(bins);
        for (const v of errs) counts[Math.max(0, Math.min(bins - 1, Math.floor((v / maxAbs + 1) * .5 * bins)))]++;
        let peak = 1; counts.forEach(v => peak = Math.max(peak, v));
        const bw = (r.right - r.left) / bins;
        for (let i = 0; i < bins; i++) {
          const h = counts[i] / peak * (r.bottom - r.top);
          this.ctx.fillStyle = i === (bins >> 1) ? c.amber : 'rgba(86,196,255,.55)';
          this.ctx.fillRect(r.left + i * bw + 1, r.bottom - h, Math.max(1, bw - 2), h);
        }
        this.line((r.left + r.right) / 2, r.top, (r.left + r.right) / 2, r.bottom, c.grid, 1);
        this.text('相对周期误差分布 · ±' + (maxAbs * 100).toFixed(3) + '%', r.left, this.h - 7, { size: 9, color: c.dim, mono: true });
      }
      this.text('周期抖动 RMS ' + (j.rmsPeriod * 1e12).toFixed(2) + ' ps   P-P ' + (j.ppPeriod * 1e12).toFixed(2) + ' ps   f0 ' + j.f0.toFixed(2) + ' Hz', r.left, 18, { size: 10, color: c.muted, mono: true });
    }
  }

  P.WaveformPlot = WaveformPlot;
  P.SpectrumPlot = SpectrumPlot;
  P.JitterPlot = JitterPlot;
  P.timeText = timeText;
  P.fmtTick = fmtTick;
  P.channelColors = CHANNELS;
  global.NSCLDPlots = P;
})(window);
