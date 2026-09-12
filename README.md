# Nora Bot (Нора)

Nora Bot - Telegram-бот с характером, памятью и гибридной AI-архитектурой.

## Что умеет

- Отвечает в чате с учетом контекста диалога.
- Ведет профили пользователей: факты, отношение, динамика общения.
- Ведет фактический профиль чата: тема и важные факты. Характер Норы от чата не меняется.
- Ищет информацию в интернете (через AI-решение).
- Понимает медиа: фото, видео, документы, стикеры.
- Ставит emoji-реакции по контексту.
- Использует fallback-логику при ошибках API и лимитах.

## Как вызвать бота

Триггер в `src/config.js` уже настроен на имя «Нора» и склонения:

- `Нора`
- `Норы`
- `Норе`
- `Нору`
- `Норой`
- `Норою`

Примеры:

- `Нора, объясни эту ошибку`
- `Норе покажи свежие новости`
- `Норой что изобретём сегодня?`

## Команды

### Для всех

- `/start`, `/help` - справка.
- `/mute` - включить/выключить режим тишины в чате/топике.
- `/reset` - сброс локальной памяти диалога в чате.

Текстовые функции (через триггер):

- `кто я`, `расскажи про ...`
- статистика: `Нора стата` / `Нора статистика`

### Для админа

- `/banlist` - список забаненных.
- `/ban` - список последних активных для быстрого бана.
- `/ban @username|ID` - глобальный бан пользователя.
- `/unban ID` - разбан.
- `/restart` - рестарт процесса через PM2.
- `/version` - версия из `package.json`.

## Режим лички

- В личке бот полноценно работает только для `ADMIN_USER_ID`.
- Остальным пишет информационный ответ и не ведет обычный диалог.

## Установка (локально)

Требуется Node.js 18+.

```bash
git clone https://github.com/Veta-one/sych-bot.git
cd sych-bot
npm install
```

Создайте `.env` в корне проекта.

Минимально:

```ini
TELEGRAM_BOT_TOKEN=your_token
ADMIN_USER_ID=123456789
AI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=your_openai_key
GOOGLE_GEMINI_API_KEY=your_google_key
AI_MAIN_MODEL=gpt-5.6-luna
AI_LOGIC_MODEL=gpt-5.6-luna
GOOGLE_NATIVE_MODEL=gemini-2.5-flash-lite
GOOGLE_FALLBACK_MODEL=gemini-2.5-flash-lite
```

Опционально для поиска:

```ini
SEARCH_PROVIDER=google
# TAVILY_API_KEY=tvly-...
PERPLEXITY_MODEL=perplexity/sonar
```

Google/Tavily/Perplexity только добывают факты. Финальную реплику с характером Норы всегда формирует основная модель.

Запуск:

```bash
npm start
```

Или через PM2:

```bash
pm2 start src/index.js --name "nora-bot"
pm2 save
```

## Docker

### Запуск через docker compose (рекомендуется)

```bash
docker compose up -d --build
```

Контейнер:

- читает переменные из `.env`
- хранит данные в `./data` (volume `./data:/app/data`)

Остановка:

```bash
docker compose down
```

### Запуск через docker build/run

```bash
docker build -t nora-bot .
docker run -d --name nora-bot --restart unless-stopped --env-file .env -v "${PWD}/data:/app/data" nora-bot
```

## Хранилище данных

Бот хранит данные в JSON-файлах в `data/` (профили, чаты, статистика и т.д.).
Для продакшена стоит регулярно делать бэкап этой папки.

## Структура проекта

- `src/core` - логика поведения и промпты.
- `src/services` - работа с AI, хранилищем и внешними API.
- `src/index.js` - запуск бота и обработка апдейтов Telegram.
