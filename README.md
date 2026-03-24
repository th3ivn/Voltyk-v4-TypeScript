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

- `SOURCE_JSON_URL` — URL snapshot-індексу, який збирається з репозиторію `Baskerville42/outage-data-ua` (зашито в код);
- `DEFAULT_POLL_INTERVAL_MS` — стартовий інтервал опитування;
- `ADMIN_USER_IDS` — доступ до `/admin` (порожній Set = дозволено всім у Stage 1).

## Source JSON contract

Джерело даних: репозиторій `Baskerville42/outage-data-ua`.

- метадані/записи графіків лежать у `data/`;
- зображення графіків лежать у `images/`;
- `SOURCE_JSON_URL` повертає зібраний snapshot (індекс) для бота, сформований із файлового набору цього репозиторію.

Snapshot, який читає бот, має структуру:

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

### Mapping: `data` запис → `image URL`

Логіка мапінгу для одного запису у `data/*`:

1. Береться запис з ключами `regionId` + `queueLabel` (+ службова дата/версія snapshot).
2. Для цього запису вибирається відповідний файл у `images/` (за тією ж парою `regionId`/`queueLabel` та актуальною датою/версією).
3. Бот отримує вже готовий `imageUrl` у snapshot:
   - `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/images/<resolved-file>.png`
4. У розсилці бот працює тільки з цим фінальним `imageUrl`, а не будує URL локально.

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
- polling фіксує новий snapshot, коли змінюється версія/склад файлового набору (зміни у `data/` і/або `images/`), а не через одне агреговане поле;
- після детекту нового snapshot бот ставить задачі для всіх active-користувачів у чергу;
- черга робить dedup та retry до 3 спроб на тимчасових помилках відправки.

## Existing audit helper

Історичний інструмент аудиту значень залишено в `scripts/audit-outage-values.mjs`.
