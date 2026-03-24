import 'dotenv/config';
import { createBot } from './bot/create-bot.js';
import { DEFAULT_POLL_INTERVAL_MS, SOURCE_JSON_URL } from './config/runtime.js';

const botToken = process.env.BOT_TOKEN;

if (!botToken) {
  throw new Error('BOT_TOKEN is required');
}

const { bot, startPolling } = createBot({
  botToken,
  sourceJsonUrl: SOURCE_JSON_URL,
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
