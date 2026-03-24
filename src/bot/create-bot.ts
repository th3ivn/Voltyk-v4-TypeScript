import { Bot, InlineKeyboard } from 'grammy';
import type { RegionScheduleImage, UserSettings } from '../types/domain.js';
import { UserStore } from '../storage/user-store.js';
import { ScheduleSource } from '../services/schedule-source.js';
import { BroadcastQueue } from '../services/broadcast-queue.js';
import { buildScheduleCaption } from '../utils/message-template.js';
import { ADMIN_USER_IDS } from '../config/runtime.js';

interface Dependencies {
  botToken: string;
  sourceJsonUrl: string;
  pollIntervalMs: number;
}

export function createBot({ botToken, sourceJsonUrl, pollIntervalMs }: Dependencies) {
  const bot = new Bot(botToken);
  const userStore = new UserStore();
  const source = new ScheduleSource(sourceJsonUrl);
  let lastBroadcastedUpdatedAtUnix: number | null = null;
  let currentPollIntervalMs = pollIntervalMs;
  let timer: ReturnType<typeof setInterval> | null = null;

  const queue = new BroadcastQueue(
    async (job) => {
      await sendSchedulePair(bot, job.user, job.payload);
    },
    {
      onJobError: (error, job) => {
        console.error('Queue job failed', {
          error,
          dedupKey: job.dedupKey,
          userId: job.user.userId,
          attempts: job.attempts,
        });
      },
    },
  );

  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) {
      return;
    }

    const existing = userStore.get(userId);
    userStore.upsert({
      userId,
      chatId,
      regionId: existing?.regionId ?? 'kyivska-oblast',
      queueLabel: existing?.queueLabel ?? '3.1',
      isActive: true,
    });

    await ctx.reply(
      'Привіт! Я надсилатиму фото графіка, а потім текст для твоєї черги.\n' +
        'Зміна регіону: /setregion <regionId> <queueLabel>\n' +
        'Ручна перевірка: /check',
    );
  });

  bot.command('setregion', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;

    if (!userId || !chatId) {
      return;
    }

    const parts = ctx.message?.text?.split(' ').filter(Boolean) ?? [];
    const regionId = parts[1];
    const queueLabel = parts[2];

    if (!regionId || !queueLabel) {
      await ctx.reply('Формат: /setregion <regionId> <queueLabel>');
      return;
    }

    const available = await source.fetch();
    const exists = available.some((item) => item.regionId === regionId && item.queueLabel === queueLabel);

    if (!exists) {
      await ctx.reply('Такої пари регіон/черга немає у поточних даних. Перевір /check пізніше.');
      return;
    }

    userStore.upsert({ userId, chatId, regionId, queueLabel, isActive: true });
    await ctx.reply(`Оновлено: ${regionId}, черга ${queueLabel}`);
  });

  bot.command('check', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      return;
    }

    const user = userStore.get(userId);
    if (!user) {
      await ctx.reply('Спочатку натисни /start');
      return;
    }

    const payload = await findPayloadForUser(source, user);
    if (!payload) {
      await ctx.reply('Для твоєї пари регіон/черга графік не знайдено.');
      return;
    }

    await sendSchedulePair(bot, user, payload);
  });

  bot.command('broadcast_test', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) {
      return;
    }

    const users = userStore.allActive();
    const enqueued = await enqueueBroadcast(queue, source, users, 'manual_test');
    await bot.api.sendMessage(chatId, `Тестову розсилку поставлено в чергу: ${enqueued} користувачів.`);
  });

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.reply('Немає доступу до адмін-панелі.');
      return;
    }

    const keyboard = new InlineKeyboard()
      .text('30с', 'admin_interval_30000')
      .text('60с', 'admin_interval_60000')
      .text('120с', 'admin_interval_120000');

    await ctx.reply(`Адмін-панель\nПоточний інтервал опитування: ${currentPollIntervalMs} мс`, { reply_markup: keyboard });
  });

  bot.callbackQuery(/admin_interval_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: 'Немає доступу', show_alert: true });
      return;
    }

    const match = ctx.match;
    const nextIntervalMs = Number(match[1]);

    if (!Number.isFinite(nextIntervalMs) || nextIntervalMs < 5000) {
      await ctx.answerCallbackQuery({ text: 'Некоректний інтервал', show_alert: true });
      return;
    }

    currentPollIntervalMs = nextIntervalMs;
    restartPolling();

    await ctx.answerCallbackQuery({ text: `Інтервал оновлено: ${currentPollIntervalMs} мс`, show_alert: false });
    await ctx.reply(`✅ Новий інтервал опитування: ${currentPollIntervalMs} мс`);
  });

  bot.callbackQuery('check_now', async (ctx) => {
    const userId = ctx.from.id;
    const user = userStore.get(userId);

    if (!user) {
      await ctx.answerCallbackQuery({ text: 'Спочатку натисни /start', show_alert: false });
      return;
    }

    const payload = await findPayloadForUser(source, user);
    if (!payload) {
      await ctx.answerCallbackQuery({ text: 'Графік не знайдено', show_alert: false });
      return;
    }

    await sendSchedulePair(bot, user, payload);
    await ctx.answerCallbackQuery({ text: 'Оновлено ✅', show_alert: false });
  });

  bot.callbackQuery('change_region', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Використай /setregion <regionId> <queueLabel>', show_alert: true });
  });

  bot.callbackQuery('open_menu', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Меню: /check /setregion /broadcast_test', show_alert: false });
  });

  const pollTick = async () => {
    try {
      const snapshot = await source.fetchSnapshot();
      if (lastBroadcastedUpdatedAtUnix !== null && snapshot.updatedAtUnix <= lastBroadcastedUpdatedAtUnix) {
        return;
      }

      const users = userStore.allActive();
      const enqueued = await enqueueBroadcast(queue, source, users, `poll_${snapshot.updatedAtUnix}`);
      if (enqueued > 0) {
        lastBroadcastedUpdatedAtUnix = snapshot.updatedAtUnix;
        console.info(`Queued ${enqueued} update notifications for snapshot ${snapshot.updatedAtUnix}`);
      }
    } catch (error) {
      console.error('Polling failed', error);
    }
  };

  const restartPolling = () => {
    if (timer) {
      clearInterval(timer);
    }

    timer = setInterval(() => {
      void pollTick();
    }, currentPollIntervalMs);
  };

  const startPolling = () => {
    restartPolling();

    return () => {
      if (timer) {
        clearInterval(timer);
      }
      timer = null;
    };
  };

  return { bot, startPolling };
}

function isAdmin(userId: number | undefined): boolean {
  if (!userId) {
    return false;
  }

  if (ADMIN_USER_IDS.size === 0) {
    return true;
  }

  return ADMIN_USER_IDS.has(userId);
}

async function findPayloadForUser(source: ScheduleSource, user: UserSettings): Promise<RegionScheduleImage | null> {
  const data = await source.fetch();
  return data.find((item) => item.regionId === user.regionId && item.queueLabel === user.queueLabel) ?? null;
}

async function enqueueBroadcast(
  queue: BroadcastQueue,
  source: ScheduleSource,
  users: UserSettings[],
  updateScope: string,
): Promise<number> {
  const data = await source.fetch();
  let enqueued = 0;

  for (const user of users) {
    const payload = data.find((item) => item.regionId === user.regionId && item.queueLabel === user.queueLabel);
    if (!payload) {
      continue;
    }

    const dedupKey = `${updateScope}:${payload.regionId}:${payload.queueLabel}:${payload.updatedAtUnix}:${user.userId}`;
    queue.enqueue({ dedupKey, user, payload });
    enqueued += 1;
  }

  return enqueued;
}

async function sendSchedulePair(bot: Bot, user: UserSettings, payload: RegionScheduleImage): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text('🌍 Замінити', 'change_region')
    .text('🌀 Перевірити', 'check_now')
    .row()
    .text('⤴ Меню', 'open_menu');

  try {
    await bot.api.sendPhoto(user.chatId, payload.imageUrl);
  } catch {
    await bot.api.sendMessage(user.chatId, '⚠️ Не вдалося завантажити фото графіка, надсилаю текст.');
  }

  await bot.api.sendMessage(user.chatId, buildScheduleCaption(payload, user), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}
