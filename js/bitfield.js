(function (global) {
  'use strict';

  const B = {};
  const channelColors = ['#56c4ff', '#e8a838', '#7ec8a0', '#b09ee8', '#e89ab8'];

  function el(tag, attrs, html) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (html != null) n.innerHTML = html;
    return n;
  }

  class BitFieldDiagram {
    constructor(canvas, app) {
      this.canvas = canvas;
      this.app = app;
      this.ctx = canvas.getContext('2d');
      this.resize = this.resize.bind(this);
      new ResizeObserver(this.resize).observe(canvas);
      this.resize();
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.dpr = Math.min(2, devicePixelRatio || 1);
      this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.draw();
    }
    draw() {
      const c = getComputedStyle(document.body);
      const text = c.getPropertyValue('--text').trim() || '#e9edf5';
      const muted = c.getPropertyValue('--muted').trim() || '#9aa5b8';
      const dim = c.getPropertyValue('--dim').trim() || '#687386';
      const line = c.getPropertyValue('--line').trim() || '#303744';
      const accent = c.getPropertyValue('--accent').trim() || '#56c4ff';
      const amber = c.getPropertyValue('--amber').trim() || '#e8a838';
      const g = this.ctx;
      g.clearRect(0, 0, this.w, this.h);
      g.fillStyle = c.getPropertyValue('--panel').trim() || '#1a1d24';
      g.fillRect(0, 0, this.w, this.h);
      const fields = this.app.state.bitFields || [];
      const bits = this.app.state.bitWordBits || 32;
      if (!fields.length) {
        g.fillStyle = dim; g.font = '12px "Segoe UI", sans-serif'; g.textAlign = 'center';
        g.fillText('添加字段后显示位域图解', this.w / 2, this.h / 2);
        return;
      }
      const left = 34, right = this.w - 34;
      const cellW = (right - left) / bits;
      const top = 27;
      const laneH = 26;
      const gap = 4;
      const lanes = this.layout(fields, bits);
      const laneCount = Math.max(1, ...lanes) + 1;
      const gridBottom = top + laneCount * (laneH + gap) - gap;
      g.fillStyle = 'rgba(255,255,255,.035)';
      for (let r = 0; r < laneCount; r++) {
        const y = top + r * (laneH + gap);
        g.fillRect(left, y, right - left, laneH);
      }
      g.strokeStyle = line; g.lineWidth = .5;
      for (let b = 0; b <= bits; b++) {
        const x = left + b * cellW;
        g.globalAlpha = b % 4 === 0 ? .8 : .32;
        g.beginPath(); g.moveTo(x, top - 3); g.lineTo(x, gridBottom); g.stroke();
      }
      g.globalAlpha = 1;
      g.font = '8px "Cascadia Mono", Consolas, monospace'; g.textAlign = 'center'; g.fillStyle = dim;
      for (let b = 0; b < bits; b++) {
        if (bits <= 16 || b % 4 === 0 || b === bits - 1) {
          const x = left + (bits - 1 - b + .5) * cellW;
          g.fillText(String(b), x, gridBottom + 13);
        }
      }
      g.textAlign = 'left'; g.fillStyle = muted;
      g.fillText('MSB · ' + (bits - 1), left, 12);
      g.textAlign = 'right';
      g.fillText('LSB · 0', right, 12);
      const groups = this.overlapGroups(fields, bits);
      const overlapRows = {};
      groups.forEach(gr => gr.forEach(i => overlapRows[i] = true));
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        const range = normalizeFieldRange(f, bits);
        const start = range.start;
        const width = range.width;
        const displayStart = bits - 1 - start;
        const x = left + displayStart * cellW + 2;
        const w = Math.max(3, width * cellW - 4);
        const lane = lanes[i];
        const y = top + (laneCount - 1 - lane) * (laneH + gap) + 3;
        const color = channelColors[i % channelColors.length];
        g.globalAlpha = .17; g.fillStyle = color; g.fillRect(x, y, w, laneH - 6); g.globalAlpha = 1;
        g.strokeStyle = overlapRows[i] ? amber : (f.msbFirst === false ? amber : color);
        g.lineWidth = 1.2;
        g.strokeRect(x + .5, y + .5, w - 1, laneH - 7);
        if (f.msbFirst === false) {
          g.strokeStyle = amber; g.globalAlpha = .7;
          g.beginPath(); g.moveTo(x + w - 8, y + 5); g.lineTo(x + w - 3, y + 5); g.lineTo(x + w - 3, y + 10); g.stroke(); g.globalAlpha = 1;
        }
        const label = (f.name || 'field') + (f.signed ? ' ±' : ' U') + '  [' + start + '..' + range.end + '] W' + width;
        g.font = '9px "Cascadia Mono", Consolas, monospace';
        g.fillStyle = text;
        g.textAlign = 'left';
        const max = Math.max(1, Math.floor((w - 8) / 5.5));
        g.fillText(label.length > max ? (f.name || 'field') + ' · ' + start + ':' + width : label, x + 4, y + 14);
      }
      if (laneCount > 1) {
        g.font = '8px "Cascadia Mono", Consolas, monospace'; g.fillStyle = dim; g.textAlign = 'right';
        g.fillText('重叠字段自动分行', right, 12);
      }
    }
    layout(fields, bits) {
      const lanes = [];
      const ranges = fields.map(f => {
        const range = normalizeFieldRange(f, bits);
        return [range.end, range.start];
      });
      for (let i = 0; i < fields.length; i++) {
        let lane = 0;
        for (; lane < 8; lane++) {
          let ok = true;
          for (let j = 0; j < i; j++) {
            if (lanes[j] !== lane) continue;
            if (!(ranges[i][1] < ranges[j][0] || ranges[i][0] > ranges[j][1])) { ok = false; break; }
          }
          if (ok) break;
        }
        lanes.push(Math.min(7, lane));
      }
      return lanes;
    }
    overlapGroups(fields, bits) {
      const out = [];
      const ranges = fields.map(f => {
        const range = normalizeFieldRange(f, bits);
        return [range.end, range.start];
      });
      for (let i = 0; i < fields.length; i++) {
        for (let j = i + 1; j < fields.length; j++) {
          if (!(ranges[i][1] < ranges[j][0] || ranges[i][0] > ranges[j][1])) out.push([i, j]);
        }
      }
      return out;
    }
  }

  class BitFieldEditor {
    constructor(app) {
      this.app = app;
      this.body = document.getElementById('bitFieldsBody');
      this.wordBitsInput = document.getElementById('bitWordBits');
      this.unitInput = document.getElementById('bitUnit');
      this.normalizeCheck = document.getElementById('bitNormalize');
      this.visibleCheck = document.getElementById('bitDiagramVisible');
      this.meta = document.getElementById('bitMeta');
      this.error = document.getElementById('bitError');
      this.diagram = new BitFieldDiagram(document.getElementById('bitDiagram'), app);
      this.selected = 0;
      this.events();
      this.syncControls();
      this.render();
    }
    events() {
      this.body.addEventListener('input', e => this.onEdit(e));
      this.body.addEventListener('change', e => this.onEdit(e));
      this.body.addEventListener('click', e => {
        const tr = e.target.closest('tr');
        if (tr) this.selected = Number(tr.dataset.index);
      });
      this.body.addEventListener('dblclick', e => e.preventDefault());
      this.wordBitsInput.addEventListener('change', () => {
        this.app.state.bitWordBits = Math.max(4, Math.min(32, Number(this.wordBitsInput.value) || 32));
        this.wordBitsInput.value = this.app.state.bitWordBits;
        this.clampFields();
        this.save();
      });
      this.unitInput.addEventListener('input', () => { this.app.state.bitUnit = this.unitInput.value || 'FS'; this.save(); });
      this.normalizeCheck.addEventListener('change', () => {
        const v = this.normalizeCheck.checked;
        this.app.state.bitFields.forEach(f => f.normalize = v);
        this.render();
        this.save();
      });
      this.visibleCheck.addEventListener('change', () => {
        document.getElementById('bitDiagramWrap').classList.toggle('hidden', !this.visibleCheck.checked);
        this.app.state.bitDiagramVisible = this.visibleCheck.checked;
        this.save();
      });
      document.getElementById('bitAddRow').addEventListener('click', () => this.addRow());
      document.getElementById('bitRemoveRow').addEventListener('click', () => this.removeRow());
      document.getElementById('bitApply').addEventListener('click', () => {
        const fields = this.read();
        if (!fields) return;
        this.app.applyBitFields(fields);
      });
      document.getElementById('bitRestore').addEventListener('click', () => this.app.restoreOriginal());
    }
    syncControls() {
      this.wordBitsInput.value = this.app.state.bitWordBits;
      this.unitInput.value = this.app.state.bitUnit;
      this.visibleCheck.checked = this.app.state.bitDiagramVisible !== false;
      document.getElementById('bitDiagramWrap').classList.toggle('hidden', !this.visibleCheck.checked);
    }
    defaultFields() {
      const bits = this.app.state.bitWordBits || 32;
      return [{ name: 'DATA', start: bits - 1, width: Math.min(16, bits), signed: true, scale: 1, offset: 0, full: 0, unit: this.app.state.bitUnit || 'FS', normalize: true, msbFirst: true }];
    }
    ensure() {
      if (!Array.isArray(this.app.state.bitFields) || !this.app.state.bitFields.length) this.app.state.bitFields = this.defaultFields();
      if (!this.app.state.bitWordBits) this.app.state.bitWordBits = 32;
    }
    render() {
      this.ensure();
      const bits = this.app.state.bitWordBits;
      const overlaps = this.overlapRows();
      this.body.innerHTML = '';
      this.app.state.bitFields.forEach((f, i) => {
        const tr = el('tr', { 'data-index': i });
        if (overlaps[i]) tr.className = 'overlap';
        if (this.selected === i) tr.style.outline = '1px solid var(--accent)';
        tr.innerHTML =
          '<td><input data-key="name" type="text" value="' + esc(f.name) + '"></td>' +
          '<td><input data-key="start" type="number" min="0" max="' + (bits - 1) + '" value="' + (f.start | 0) + '"></td>' +
          '<td><input data-key="width" type="number" min="1" max="' + bits + '" value="' + (f.width | 0) + '"></td>' +
          '<td><select data-key="signed"><option value="0"' + (f.signed ? '' : ' selected') + '>U</option><option value="1"' + (f.signed ? ' selected' : '') + '>±</option></select></td>' +
          '<td><input data-key="scale" type="number" step="any" value="' + fmt(f.scale) + '"></td>' +
          '<td><input data-key="offset" type="number" step="any" value="' + fmt(f.offset) + '"></td>' +
          '<td><input data-key="full" type="number" step="any" value="' + fmt(f.full) + '"></td>' +
          '<td><input data-key="unit" type="text" value="' + esc(f.unit) + '"></td>' +
          '<td><input data-key="normalize" type="checkbox"' + (f.normalize ? ' checked' : '') + '></td>' +
          '<td><select data-key="msbFirst"><option value="1"' + (f.msbFirst ? ' selected' : '') + '>MSB</option><option value="0"' + (!f.msbFirst ? ' selected' : '') + '>LSB</option></select></td>' +
          '<td class="overlap-badge">' + (overlaps[i] ? '⚠ 重叠' : '') + '</td>';
        this.body.appendChild(tr);
      });
      this.meta.textContent = bits + '-bit · ' + this.app.state.bitFields.length + ' 字段 · 起始为实际 bit 号';
      this.normalizeCheck.checked = this.app.state.bitFields.every(f => f.normalize);
      this.diagram.draw();
    }
    overlapRows() {
      const out = {};
      const f = this.app.state.bitFields;
      const bits = this.app.state.bitWordBits || 32;
      const ranges = f.map(x => normalizeFieldRange(x, bits));
      for (let i = 0; i < f.length; i++) {
        for (let j = i + 1; j < f.length; j++) {
          if (!(ranges[i].start < ranges[j].end || ranges[j].start < ranges[i].end)) { out[i] = true; out[j] = true; }
        }
      }
      return out;
    }
    onEdit(e) {
      const input = e.target;
      if (!input.dataset || !input.dataset.key) return;
      const tr = input.closest('tr');
      const idx = Number(tr.dataset.index);
      const f = this.app.state.bitFields[idx];
      const key = input.dataset.key;
      if (key === 'name') f.name = input.value;
      else if (key === 'unit') f.unit = input.value;
      else if (key === 'normalize') f.normalize = input.checked;
      else if (key === 'signed') f.signed = input.value === '1';
      else if (key === 'msbFirst') f.msbFirst = input.value === '1';
      else {
        let v = parseFloat(input.value);
        if (!isFinite(v)) v = 0;
        if (key === 'start') {
          f.start = Math.max(0, Math.min(this.app.state.bitWordBits - 1, Math.round(v)));
          input.value = f.start;
        } else if (key === 'width') {
          f.width = Math.max(1, Math.min(f.start + 1, Math.round(v)));
          input.value = f.width;
          this.avoidAfter(idx);
        } else f[key] = v;
      }
      this.render();
      this.save();
    }
    avoidAfter(idx) {
      const f = this.app.state.bitFields[idx];
      const high = f.start | 0, low = high - Math.max(1, f.width | 0) + 1;
      for (let j = idx + 1; j < this.app.state.bitFields.length; j++) {
        const n = this.app.state.bitFields[j];
        if (n.start <= high && n.start >= low) n.start = Math.max(0, high - f.width);
      }
    }
    addRow() {
      const bits = this.app.state.bitWordBits;
      let low = bits;
      for (const f of this.app.state.bitFields) low = Math.min(low, (f.start | 0) - (f.width | 0) + 1);
      const width = Math.min(8, bits);
      let start = low - 1;
      if (start < 0) start = bits - 1;
      this.app.state.bitFields.push({
        name: 'F' + (this.app.state.bitFields.length + 1),
        start: start, width: Math.max(1, Math.min(width, start + 1)),
        signed: true, scale: 1, offset: 0, full: 0,
        unit: this.app.state.bitUnit || 'FS', normalize: true, msbFirst: true
      });
      this.selected = this.app.state.bitFields.length - 1;
      this.render(); this.save();
    }
    removeRow() {
      if (this.app.state.bitFields.length <= 1) return;
      this.app.state.bitFields.splice(Math.max(0, this.selected), 1);
      this.selected = Math.max(0, this.selected - 1);
      this.render(); this.save();
    }
    clampFields() {
      const bits = this.app.state.bitWordBits;
      this.app.state.bitFields.forEach(f => {
        const range = normalizeFieldRange(f, bits);
        f.start = range.start;
        f.width = range.width;
      });
      this.render();
    }
    read() {
      this.error.textContent = '';
      const bits = this.app.state.bitWordBits;
      for (let i = 0; i < this.app.state.bitFields.length; i++) {
        const f = this.app.state.bitFields[i];
        if (!f.name) f.name = 'F' + (i + 1);
        if (f.start < 0 || f.start >= bits) { this.error.textContent = '第 ' + (i + 1) + ' 个字段起始位越界'; return null; }
        const range = normalizeFieldRange(f, bits);
        f.start = range.start;
        f.width = range.width;
      }
      return this.app.state.bitFields.map(f => Object.assign({}, f));
    }
    save() {
      this.app.saveSettings();
      this.diagram.draw();
    }
    setFields(fields, bits) {
      if (Array.isArray(fields) && fields.length) this.app.state.bitFields = fields.map(f => Object.assign({}, f));
      if (bits) this.app.state.bitWordBits = bits;
      this.syncControls();
      this.render();
    }
  }

  function normalizeFieldRange(field, wordBits) {
    const bits = Math.max(1, Math.trunc(wordBits) || 32);
    const start = Math.max(0, Math.min(bits - 1, Math.trunc(field.start) || 0));
    const requested = Math.max(1, Math.trunc(field.width) || 1);
    const width = Math.min(requested, start + 1, bits);
    return { start: start, width: width, end: start - width + 1, requested: requested, clamped: width !== requested };
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
  function fmt(v) { return isFinite(v) ? String(v) : '0'; }

  B.normalizeFieldRange = normalizeFieldRange;
  B.BitFieldEditor = BitFieldEditor;
  B.BitFieldDiagram = BitFieldDiagram;
  global.NSCLDBitfield = B;
})(window);
