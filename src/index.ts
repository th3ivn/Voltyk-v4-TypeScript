import 'dotenv/config';
import { createBot } from './bot/create-bot.js';
import { DEFAULT_POLL_INTERVAL_MS, SCHEDULE_SOURCE_CONFIG } from './config/runtime.js';

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  throw new Error('BOT_TOKEN is required');
}

const { bot, startPolling } = createBot({
  botToken,
  sourceConfig: SCHEDULE_SOURCE_CONFIG,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
});

bot.catch((error) => {
  console.error('Bot error:', error.error);
});

const stopPolling = startPolling();

process.once('SIGINT', () => {
  stopPolling();
  process.exit(0);
});

process.once('SIGTERM', () => {
  stopPolling();
  process.exit(0);
});

await bot.start();
