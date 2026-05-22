import { setDefaultResultOrder } from 'node:dns';
import { APP_NAME, SIGNAL_SERVER_URL, SIGNAL_POLL_MS, GRADUATED_POLL_MS, TRENDING_POLL_MS, POSITION_CHECK_MS, TELEGRAM_CHAT_ID, validateConfig } from './config.js';
import { initDb } from './db/connection.js';
import { initLiveExecution } from './liveExecutor.js';
import { setupTelegram } from './telegram/commands.js';
import { monitorPositions } from './execution/positions.js';
import { reconcileWallet } from './execution/reconcile.js';
import { processCandidateFromSignals, maybeProcessDegenCandidate } from './pipeline/orchestrator.js';
import { sendTelegram } from './telegram/send.js';
import { makeFailureTracker } from './utils.js';
import { checkPendingReviews } from './learning/feedback.js';
import { setDegradedAlertCallback } from './health/providerHealth.js';

setDefaultResultOrder('ipv4first');
validateConfig();

// Set up degraded provider alerting
setDegradedAlertCallback(async (provider, endpoint, error) => {
  const msg = [
    '⚠️ <b>Provider Degraded</b>',
    '',
    `Provider: <b>${provider}</b>`,
    `Endpoint: ${endpoint}`,
    `Error: ${error.slice(0, 200)}`,
  ].join('\n');
  await sendTelegram(msg);
});

export async function startCharon() {
  initDb();
  initLiveExecution();
  setupTelegram();

  if (SIGNAL_SERVER_URL) {
    // ── Server mode: fetch signals from signal server ──────────────────────
    const { fetchServerSignals, setCandidateHandler, setDegenHandler } = await import('./signals/serverClient.js');

    setCandidateHandler(processCandidateFromSignals);
    setDegenHandler(maybeProcessDegenCandidate);

    const alert = (msg) => sendTelegram(msg);
    const trackServer = makeFailureTracker('server signals', alert);
    const trackDip = makeFailureTracker('dip monitor', alert);

    await fetchServerSignals().catch(error => console.log(`[server] initial fetch failed: ${error.message}`));
    setInterval(() => trackServer(() => fetchServerSignals()), SIGNAL_POLL_MS);

    // Price monitor for dip buy strategy
    const { monitorPriceAlerts, cleanupAlerts } = await import('./signals/priceMonitor.js');
    const { setCandidateHandler: setAlertHandler } = await import('./signals/priceMonitor.js');
    setAlertHandler(processCandidateFromSignals);
    setInterval(() => trackDip(() => monitorPriceAlerts()), 10_000);
    setInterval(() => cleanupAlerts(), 60 * 60 * 1000);

    console.log(`[bot] ${APP_NAME} started (server mode: ${SIGNAL_SERVER_URL})`);
  } else {
    // ── Standalone mode: direct polling (legacy) ───────────────────────────
    const { fetchGraduatedCoins } = await import('./signals/graduated.js');
    const { fetchGmgnTrending, setDegenHandler } = await import('./signals/trending.js');
    const { startWebsocket, setCandidateHandler } = await import('./signals/feeClaim.js');

    setDegenHandler(maybeProcessDegenCandidate);
    setCandidateHandler(processCandidateFromSignals);

    await fetchGraduatedCoins().catch(error => console.log(`[graduated] initial fetch failed: ${error.message}`));
    await fetchGmgnTrending().catch(error => console.log(`[trending] initial fetch failed: ${error.message}`));

    setInterval(() => fetchGraduatedCoins().catch(error => console.log(`[graduated] ${error.message}`)), GRADUATED_POLL_MS);
    setInterval(() => fetchGmgnTrending().catch(error => console.log(`[trending] ${error.message}`)), TRENDING_POLL_MS);
    startWebsocket();

    console.log(`[bot] ${APP_NAME} started (standalone mode)`);
  }

  // Position monitoring runs in both modes
  const trackPositions = makeFailureTracker('position monitor', (msg) => sendTelegram(msg));
  setInterval(() => trackPositions(() => monitorPositions()), POSITION_CHECK_MS);

  // Wallet reconciliation (Epic 5) - run on startup and every 5 minutes
  const trackReconciliation = makeFailureTracker('wallet reconciliation', (msg) => sendTelegram(msg));
  reconcileWallet().catch(err => console.log(`[reconcile] startup reconciliation failed: ${err.message}`));
  setInterval(() => trackReconciliation(() => reconcileWallet()), 5 * 60 * 1000);

  // Lesson performance review check every 6 hours
  setInterval(() => checkPendingReviews(TELEGRAM_CHAT_ID).catch(err => console.log(`[lesson-review] ${err.message}`)), 6 * 60 * 60 * 1000);
}
