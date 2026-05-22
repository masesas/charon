import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID } from '../config.js';
import { escapeHtml, fmtPct } from '../format.js';
import { getAllProviderHealth, getDegradedProviders } from '../health/providerHealth.js';

export async function sendStatus(chatId = TELEGRAM_CHAT_ID) {
  const allHealth = getAllProviderHealth();
  const degraded = getDegradedProviders();

  const lines = [
    '🏥 <b>Provider Health Status</b>',
    '',
  ];

  if (!allHealth.length) {
    lines.push('No health data collected yet.');
  } else {
    // Group by provider
    const byProvider = {};
    for (const row of allHealth) {
      if (!byProvider[row.provider]) byProvider[row.provider] = [];
      byProvider[row.provider].push(row);
    }

    for (const [provider, rows] of Object.entries(byProvider)) {
      const icon = degraded.some(d => d.provider === provider) ? '⚠️' : '✅';
      lines.push(`${icon} <b>${escapeHtml(provider)}</b>`);

      for (const row of rows) {
        const endpoint = row.endpoint || '(default)';
        const total = row.success_count + row.failure_count;
        const successRate = total > 0 ? (row.success_count / total * 100).toFixed(0) : 'N/A';
        const latency = row.avg_latency_ms ? `${row.avg_latency_ms.toFixed(0)}ms` : 'N/A';
        const status = row.status === 'healthy' ? '✓' : '✗';

        lines.push(
          `  ${status} ${escapeHtml(endpoint)}: ${successRate}% success, ${latency} avg`,
        );

        if (row.last_error) {
          lines.push(`     Error: ${escapeHtml(row.last_error.slice(0, 80))}`);
        }
      }
      lines.push('');
    }
  }

  if (degraded.length > 0) {
    lines.push('');
    lines.push('⚠️ <b>Degraded Providers</b>');
    for (const row of degraded) {
      const endpoint = row.endpoint || '(default)';
      lines.push(`• ${escapeHtml(row.provider)} ${escapeHtml(endpoint)}`);
      if (row.last_error) {
        lines.push(`  ${escapeHtml(row.last_error.slice(0, 100))}`);
      }
    }
  }

  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}
