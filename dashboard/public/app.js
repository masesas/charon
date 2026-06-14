/* Alpine.js component: tab state, polling, fetch helpers, uPlot charts.
   The cookie carries auth, so fetch() needs no Authorization header. */

const SOURCE_COLORS = ['#4c8dff', '#2ecc71', '#ffb020', '#ff5d5d', '#a779ff', '#34d3c1'];

async function api(path, opts) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'request failed');
  return json.data;
}

function charon() {
  return {
    tab: 'overview',
    window: '24h',
    posFilter: 'open',
    overview: {},
    positions: [],
    funnel: {},
    decisions: [],
    signals: { buckets: [], sources: [] },
    sourcePerf: { available: false, rows: [] },
    learning: {},
    detail: null,
    closing: false,
    _signalChart: null,
    _detailChart: null,
    _poll: null,

    init() {
      this.loadOverview();
      this._poll = setInterval(() => {
        if (this.tab === 'overview') this.loadOverview();
      }, 5000);
    },

    // ── loaders ──
    async loadOverview() { try { this.overview = await api('/overview'); } catch (e) {} },
    async loadPositions() {
      try { const d = await api('/positions?status=' + this.posFilter + '&limit=100'); this.positions = d.rows; } catch (e) {}
    },
    async loadFunnel() {
      try {
        this.funnel = await api('/funnel?window=' + this.window);
        const d = await api('/decisions?limit=30'); this.decisions = d.rows;
      } catch (e) {}
    },
    async loadSignals() {
      try {
        this.signals = await api('/signals?window=' + this.window);
        this.sourcePerf = await api('/sources');
        this.$nextTick(() => this.renderSignalChart());
      } catch (e) {}
    },
    async loadLearning() {
      try { this.learning = await api('/learning'); await this.loadOverview(); } catch (e) {}
    },

    async openPosition(id) {
      try {
        this.detail = await api('/positions/' + id);
        this.$nextTick(() => this.renderDetailChart());
      } catch (e) {}
    },

    // ── controls ──
    async toggleAgent() {
      const next = !(this.overview.agent && this.overview.agent.enabled);
      try { await api('/agent/toggle', { method: 'POST', body: JSON.stringify({ enabled: next }) }); await this.loadOverview(); } catch (e) {}
    },
    async switchStrategy(id) {
      try { await api('/strategy/active', { method: 'POST', body: JSON.stringify({ id }) }); await this.loadLearning(); } catch (e) {}
    },
    async forceClose(id) {
      this.closing = true;
      try {
        const r = await api('/positions/' + id + '/close', { method: 'POST', body: '{}' });
        await this.pollCommand(r.commandId);
      } catch (e) { alert('Close failed: ' + e.message); }
      finally { this.closing = false; this.detail = null; this.loadPositions(); }
    },
    async pollCommand(commandId) {
      for (let i = 0; i < 20; i++) {
        const c = await api('/commands/' + commandId);
        if (c && (c.status === 'done' || c.status === 'failed' || c.status === 'rejected')) return c;
        await new Promise((r) => setTimeout(r, 1500));
      }
      return null;
    },

    // ── charts ──
    renderSignalChart() {
      const el = document.getElementById('signalChart');
      if (!el || !window.uPlot) return;
      el.innerHTML = '';
      const { buckets, sources } = this.signals;
      if (!buckets.length) { el.innerHTML = '<div class="muted">No signals in window.</div>'; return; }
      const xs = buckets.map((b) => b.atMs / 1000);
      const seriesData = [xs];
      const seriesDefs = [{}];
      sources.forEach((s, i) => {
        seriesData.push(buckets.map((b) => b[s] || 0));
        seriesDefs.push({ label: s, stroke: SOURCE_COLORS[i % SOURCE_COLORS.length], width: 2, points: { show: false } });
      });
      this._signalChart && this._signalChart.destroy();
      this._signalChart = new uPlot(
        { width: el.clientWidth || 320, height: 180, series: seriesDefs,
          legend: { show: true }, axes: this._axes(), cursor: { y: false } },
        seriesData, el,
      );
    },
    renderDetailChart() {
      const el = document.getElementById('detailChart');
      if (!el || !window.uPlot || !this.detail) return;
      el.innerHTML = '';
      const series = this.detail.series || [];
      if (!series.length) { el.innerHTML = '<div class="muted">No price snapshots.</div>'; return; }
      const xs = series.map((s) => s.atMs / 1000);
      const ys = series.map((s) => s.mcapUsd || s.priceUsd || 0);
      this._detailChart && this._detailChart.destroy();
      this._detailChart = new uPlot(
        { width: el.clientWidth || 320, height: 180,
          series: [{}, { label: 'mcap', stroke: '#4c8dff', width: 2, points: { show: false } }],
          axes: this._axes(), cursor: { y: false } },
        [xs, ys], el,
      );
    },
    _axes() {
      const stroke = '#8a97ad';
      const grid = { stroke: '#232c3d', width: 1 };
      return [{ stroke, grid }, { stroke, grid }];
    },

    // ── formatters ──
    fmtSol(v) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(4) : '?'; },
    fmtUsd(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return '?';
      if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
      return '$' + n.toFixed(0);
    },
    signed(v, dp) { const n = Number(v); if (!Number.isFinite(n)) return '—'; return (n >= 0 ? '+' : '') + n.toFixed(dp); },
    winRate(t) { const tot = (t.wins || 0) + (t.losses || 0); return tot ? Math.round((t.wins / tot) * 100) + '%' : '—'; },
    barPct(v) {
      const max = Math.max(1, ...((this.funnel.stages || []).map((s) => s.value)));
      return Math.round((Number(v) / max) * 100);
    },
    ago(ms) {
      const d = Date.now() - Number(ms);
      if (!Number.isFinite(d)) return '—';
      const s = Math.floor(d / 1000);
      if (s < 60) return s + 's ago';
      const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
      const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
      return Math.floor(h / 24) + 'd ago';
    },
  };
}
window.charon = charon;
