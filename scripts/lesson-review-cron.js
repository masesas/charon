#!/usr/bin/env node
/**
 * Lesson Performance Review Cron Job
 * Runs every 6 hours to check for pending 7-day lesson reviews
 * and send performance summaries to Telegram
 */

import { initDb, db } from './src/db/connection.js';
import { TELEGRAM_CHAT_ID } from './src/config.js';
import { checkPendingReviews } from './src/learning/feedback.js';

initDb();

try {
  console.log('[cron] Checking pending lesson performance reviews...');
  await checkPendingReviews(TELEGRAM_CHAT_ID);
  console.log('[cron] Lesson review check complete');
  process.exit(0);
} catch (err) {
  console.error('[cron] Error:', err.message);
  process.exit(1);
}
