// Mobile-first HTML shell. Server-rendered skeleton; Alpine.js drives tab
// switching and data fetching client-side against the JSON API. Front-end libs
// are pinned CDN URLs with SRI hashes — no build step, consistent with a repo
// that has no bundler.

const ALPINE = 'https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js';
const UPLOT_JS = 'https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.iife.min.js';
const UPLOT_CSS = 'https://cdn.jsdelivr.net/npm/uplot@1.6.31/dist/uPlot.min.css';

export function shell() {
  return `<!DOCTYPE html>
<html lang="en" x-data="charon()" x-init="init()" :data-tab="tab">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0b0e14" />
  <title>Charon</title>
  <link rel="stylesheet" href="${UPLOT_CSS}" />
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <header class="topbar">
    <div class="brand">⛴ Charon</div>
    <div class="topbar-right">
      <span class="pill" :class="overview.agent && overview.agent.enabled ? 'pill-on' : 'pill-off'"
            x-text="overview.agent ? (overview.agent.enabled ? 'RUNNING' : 'PAUSED') : '…'"></span>
      <span class="pill pill-mode" x-text="overview.agent ? overview.agent.tradingMode : ''"></span>
    </div>
  </header>

  <main class="content">
    <!-- OVERVIEW -->
    <section x-show="tab==='overview'" class="screen">
      <div class="card hero" x-show="overview.agent">
        <div class="hero-row">
          <div><div class="label">Strategy</div><div class="value" x-text="overview.agent && (overview.agent.activeStrategyName || '—')"></div></div>
          <div><div class="label">Open</div><div class="value"><span x-text="overview.agent && overview.agent.openPositions"></span>/<span x-text="overview.agent && overview.agent.maxOpenPositions"></span></div></div>
          <div><div class="label">Exposure</div><div class="value" x-text="overview.agent && fmtSol(overview.agent.totalOpenSizeSol)+' ◎'"></div></div>
        </div>
      </div>

      <div class="card" x-show="overview.today">
        <div class="card-title">Today <span class="muted" x-show="overview.today && overview.today.derived">(derived)</span></div>
        <div class="big-pnl" :class="(overview.today && overview.today.totalPnlSol>=0)?'pos':'neg'">
          <span x-text="overview.today && signed(overview.today.totalPnlSol,4)+' ◎'"></span>
          <span class="big-pct" x-text="overview.today && signed(overview.today.totalPnlPercent,1)+'%'"></span>
        </div>
        <div class="stat-grid">
          <div><div class="label">Trades</div><div x-text="overview.today && overview.today.trades"></div></div>
          <div><div class="label">Win rate</div><div x-text="overview.today ? winRate(overview.today) : '—'"></div></div>
          <div><div class="label">Loss streak</div><div x-text="overview.today && (overview.today.lossStreak ?? '—')"></div></div>
        </div>
        <div class="alert-banner" x-show="overview.today && overview.today.dailyLossLimitTriggered">⚠️ Daily loss limit triggered</div>
      </div>

      <div class="card">
        <div class="card-title">LLM</div>
        <div class="kv"><span>Last batch</span><b x-text="overview.llm && overview.llm.lastBatchAtMs ? ago(overview.llm.lastBatchAtMs) : 'never'"></b></div>
        <div class="kv"><span>Last verdict</span><b x-text="overview.llm && (overview.llm.lastVerdict || '—')"></b></div>
        <div class="kv"><span>Fallback</span><b x-text="overview.llm && (overview.llm.fallbackEnabled?'on':'off')"></b></div>
      </div>

      <div class="card">
        <div class="card-title">Providers</div>
        <template x-if="overview.providerHealth && !overview.providerHealth.available">
          <div class="muted">No health data on this schema.</div>
        </template>
        <div class="chips">
          <template x-for="p in (overview.providerHealth ? overview.providerHealth.providers : [])" :key="p.provider+p.endpoint">
            <span class="chip" :class="p.degraded?'chip-bad':'chip-ok'">
              <span x-text="p.degraded?'⚠':'✓'"></span>
              <span x-text="p.provider"></span>
              <small x-show="p.successRate!==null" x-text="Math.round(p.successRate)+'%'"></small>
            </span>
          </template>
        </div>
      </div>
    </section>

    <!-- POSITIONS -->
    <section x-show="tab==='positions'" class="screen">
      <div class="seg">
        <button :class="posFilter==='open'?'seg-on':''" @click="posFilter='open';loadPositions()">Open</button>
        <button :class="posFilter==='closed'?'seg-on':''" @click="posFilter='closed';loadPositions()">Closed</button>
      </div>
      <template x-if="positions.length===0"><div class="card muted">No positions.</div></template>
      <template x-for="p in positions" :key="p.id">
        <div class="card pos" @click="openPosition(p.id)">
          <div class="pos-head">
            <b x-text="p.symbol || p.mint.slice(0,6)"></b>
            <span class="pnl" :class="(p.pnlPercent>=0)?'pos':'neg'" x-text="p.pnlPercent!==null?signed(p.pnlPercent,1)+'%':'—'"></span>
          </div>
          <div class="pos-meta">
            <span x-text="p.executionMode"></span>
            <span x-text="fmtSol(p.sizeSol)+' ◎'"></span>
            <span x-show="p.tier" x-text="p.tier"></span>
            <span x-show="p.exitReason" class="tag" x-text="p.exitReason"></span>
          </div>
        </div>
      </template>
    </section>

    <!-- FUNNEL -->
    <section x-show="tab==='funnel'" class="screen">
      <div class="seg">
        <template x-for="w in ['1h','24h','7d']" :key="w">
          <button :class="window===w?'seg-on':''" @click="window=w;loadFunnel()" x-text="w"></button>
        </template>
      </div>
      <div class="card">
        <div class="card-title">Funnel</div>
        <template x-for="s in (funnel.stages||[])" :key="s.label">
          <div class="bar-row">
            <span class="bar-label" x-text="s.label"></span>
            <div class="bar"><div class="bar-fill" :style="'width:'+barPct(s.value)+'%'"></div></div>
            <span class="bar-val" x-text="s.value"></span>
          </div>
        </template>
      </div>
      <div class="card">
        <div class="card-title">Actions</div>
        <template x-for="a in (funnel.actions||[])" :key="a.action">
          <div class="kv"><span x-text="a.action"></span><b x-text="a.count"></b></div>
        </template>
      </div>
      <div class="card">
        <div class="card-title">Recent decisions</div>
        <template x-for="d in decisions" :key="d.atMs+d.action">
          <div class="dec">
            <div class="dec-top"><span x-text="ago(d.atMs)"></span><span class="tag" x-text="d.action"></span></div>
            <div class="muted" x-show="d.reason" x-text="d.reason"></div>
          </div>
        </template>
      </div>
    </section>

    <!-- SIGNALS -->
    <section x-show="tab==='signals'" class="screen">
      <div class="seg">
        <template x-for="w in ['1h','24h','7d']" :key="w">
          <button :class="window===w?'seg-on':''" @click="window=w;loadSignals()" x-text="w"></button>
        </template>
      </div>
      <div class="card">
        <div class="card-title">Signal volume</div>
        <div id="signalChart" class="chart"></div>
      </div>
      <div class="card">
        <div class="card-title">Source performance</div>
        <template x-if="!sourcePerf.available"><div class="muted">No source-performance data on this schema.</div></template>
        <template x-for="s in (sourcePerf.rows||[])" :key="s.source+s.signalType">
          <div class="kv"><span x-text="s.source+' · '+s.signalType"></span>
            <b x-text="(s.winRatePercent!==null?Math.round(s.winRatePercent)+'% · ':'')+s.total"></b></div>
        </template>
      </div>
    </section>

    <!-- LEARNING / CONFIG -->
    <section x-show="tab==='config'" class="screen">
      <div class="card">
        <div class="card-title">Controls</div>
        <button class="btn" :class="overview.agent && overview.agent.enabled?'btn-warn':'btn-go'"
                @click="toggleAgent()" x-text="overview.agent && overview.agent.enabled?'Pause agent':'Resume agent'"></button>
        <div class="ctl-row">
          <label>Active strategy</label>
          <select @change="switchStrategy($event.target.value)">
            <template x-for="s in (learning.strategies||[])" :key="s.id">
              <option :value="s.id" :selected="s.enabled" x-text="s.name"></option>
            </template>
          </select>
        </div>
      </div>
      <div class="card" x-show="learning.activeStrategy">
        <div class="card-title" x-text="'Strategy: '+(learning.activeStrategy && learning.activeStrategy.name)"></div>
        <template x-for="(v,k) in (learning.activeStrategy ? learning.activeStrategy.params : {})" :key="k">
          <div class="kv"><span x-text="k"></span><b x-text="String(v)"></b></div>
        </template>
      </div>
      <div class="card">
        <div class="card-title">Active lessons</div>
        <template x-if="(learning.lessons||[]).length===0"><div class="muted">None.</div></template>
        <template x-for="l in (learning.lessons||[])" :key="l.id">
          <div class="lesson" x-text="l.lesson"></div>
        </template>
      </div>
    </section>
  </main>

  <!-- Position detail drawer -->
  <div class="drawer-backdrop" x-show="detail" @click="detail=null" x-transition.opacity></div>
  <div class="drawer" x-show="detail" x-transition>
    <template x-if="detail">
      <div>
        <div class="drawer-head">
          <b x-text="detail.symbol || (detail.mint && detail.mint.slice(0,8))"></b>
          <button class="x" @click="detail=null">✕</button>
        </div>
        <div class="big-pnl" :class="(detail.pnlPercent>=0)?'pos':'neg'" x-text="detail.pnlPercent!==null?signed(detail.pnlPercent,1)+'%':'open'"></div>
        <div id="detailChart" class="chart"></div>
        <div class="stat-grid">
          <div><div class="label">Entry mcap</div><div x-text="fmtUsd(detail.entryMcap)"></div></div>
          <div><div class="label">TP/SL</div><div><span x-text="detail.tpPercent"></span>/<span x-text="detail.slPercent"></span></div></div>
          <div><div class="label">Size</div><div x-text="fmtSol(detail.sizeSol)+' ◎'"></div></div>
        </div>
        <button class="btn btn-danger" x-show="detail.status==='open'" @click="forceClose(detail.id)"
                :disabled="closing" x-text="closing?'Closing…':'Force close'"></button>
        <div class="muted" x-show="detail.status==='open' && overview.agent && overview.agent.tradingMode==='dry_run'">
          Dry-run: close is simulated by the agent.
        </div>
      </div>
    </template>
  </div>

  <nav class="tabbar">
    <button :class="tab==='overview'?'tab-on':''" @click="tab='overview'">📊<span>Home</span></button>
    <button :class="tab==='positions'?'tab-on':''" @click="tab='positions';loadPositions()">📍<span>Pos</span></button>
    <button :class="tab==='funnel'?'tab-on':''" @click="tab='funnel';loadFunnel()">🔻<span>Funnel</span></button>
    <button :class="tab==='signals'?'tab-on':''" @click="tab='signals';loadSignals()">📡<span>Signals</span></button>
    <button :class="tab==='config'?'tab-on':''" @click="tab='config';loadLearning()">⚙️<span>Config</span></button>
  </nav>

  <script src="${UPLOT_JS}"></script>
  <script src="${ALPINE}" defer></script>
  <script src="/app.js"></script>
</body>
</html>`;
}

export function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0b0e14" />
  <title>Charon — Login</title>
  <link rel="stylesheet" href="/app.css" />
</head>
<body class="login-body">
  <form class="login-card" method="POST" action="/login">
    <div class="brand-lg">⛴ Charon</div>
    <p class="muted">Enter access token</p>
    ${error ? `<div class="alert-banner">${error}</div>` : ''}
    <input type="password" name="token" placeholder="Access token" autocomplete="current-password" autofocus />
    <button type="submit" class="btn btn-go">Unlock</button>
  </form>
</body>
</html>`;
}
