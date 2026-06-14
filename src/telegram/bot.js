import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

// Test/observation harnesses set __E2E_NO_TELEGRAM=1 to avoid opening a real
// polling connection or sending to the live chat. We expose a no-op stub with
// the same surface the codebase uses (sendMessage, on, ...) so imports resolve
// and any send becomes a logged no-op instead of a network call.
function makeNoopBot() {
  const noop = async () => ({ message_id: 0 });
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'sendMessage') {
        return async (_chatId, text) => {
          console.log(`[telegram:noop] ${String(text).split('\n')[0].slice(0, 120)}`);
          return { message_id: 0 };
        };
      }
      if (prop === 'on' || prop === 'removeListener' || prop === 'onText') return () => {};
      return noop;
    },
  });
}

// Resolve the bot in one of three modes:
//   __E2E_NO_TELEGRAM=1        → no-op stub (no network at all)
//   __E2E_TELEGRAM_SEND_ONLY=1 → real bot, polling DISABLED (can send, never
//                                calls getUpdates → never 409-conflicts with the
//                                production agent that owns the polling lease)
//   (default)                  → real bot with polling (production behavior)
function resolveBot() {
  if (process.env.__E2E_NO_TELEGRAM === '1') return makeNoopBot();
  const polling = process.env.__E2E_TELEGRAM_SEND_ONLY !== '1';
  return new TelegramBot(TELEGRAM_BOT_TOKEN, { polling });
}

export const bot = resolveBot();
