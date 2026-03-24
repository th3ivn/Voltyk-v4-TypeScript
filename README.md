# Voltyk-v4-TypeScript

MVP Stage 1 для Voltyk на **TypeScript + grammY**:
- фото графіка **першим**;
- текстове повідомлення **другим**;
- кнопки під текстом;
- масова розсилка через вбудовану чергу;
- авто-polling джерела (оновлення приходять всім active-користувачам);
- інтервал polling змінюється через `/admin` панель (без env змінної).

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

## Environment

```env
BOT_TOKEN=123456:ABC
```

## Runtime config in code

Фундаментальні налаштування зафіксовані в коді (`src/config/runtime.ts`):

- `SOURCE_JSON_URL` — джерело графіків (зашито в код);
- `DEFAULT_POLL_INTERVAL_MS` — стартовий інтервал опитування;
- `ADMIN_USER_IDS` — доступ до `/admin` (порожній Set = дозволено всім у Stage 1).

## Source JSON contract

`SOURCE_JSON_URL` має повертати JSON такого виду:

```json
{
  "updatedAtUnix": 1770000000,
  "regions": [
    {
      "regionId": "kyivska-oblast",
      "queueLabel": "3.1",
      "imageUrl": "https://example.com/kyiv-3-1.png",
      "statusText": "✅ Відключень не заплановано"
    }
  ]
}
```

## Commands

- `/start` — реєстрація користувача та інструкції.
- `/setregion <regionId> <queueLabel>` — змінити регіон/чергу.
- `/check` — надіслати актуальне фото + текст для користувача.
- `/broadcast_test` — поставити масову тестову розсилку для всіх active у чергу.
- `/admin` — адмін-панель для зміни polling-інтервалу (30/60/120 сек).

## Callback buttons

- `🌍 Замінити` → підказка використовувати `/setregion`.
- `🌀 Перевірити` → моментальна повторна відправка фото + тексту.
- `⤴ Меню` → коротка підказка по командах.

## Message order (зафіксовано)

1. `sendPhoto` (картинка графіка).
2. `sendMessage` (текст + кнопки) з динамічним `Оновлено: ...` через `date_time` (`<tg-time unix="..." format="r">`).
3. Якщо фото не завантажилось — надсилається текстовий fallback.

## Auto-updates flow

- бот опитує `SOURCE_JSON_URL` за поточним polling-інтервалом;
- адмін може змінити інтервал через `/admin` без редеплою;
- коли `updatedAtUnix` зростає, бот ставить задачі для всіх active-користувачів у чергу;
- черга робить dedup та retry до 3 спроб на тимчасових помилках відправки.

## Existing audit helper

Історичний інструмент аудиту значень залишено в `scripts/audit-outage-values.mjs`.
