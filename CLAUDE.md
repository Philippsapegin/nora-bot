# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sych Bot is a Telegram bot with hybrid AI architecture (OpenAI GPT-5.6 Luna primary, Google Gemini fallback). It's a stateful conversational agent with character, memory, and autonomous decision-making capabilities. The bot operates primarily in Russian.

- **Node.js**: 18+ required
- **Package Type**: CommonJS
- **Entry Point**: `src/index.js`

## Commands

```bash
npm start          # Run the bot locally
npm install        # Install dependencies
```

### Production Deployment (PM2)
```bash
pm2 start src/index.js --name "sych-bot"
pm2 restart sych-bot
```

Auto-deployment triggers on push to `main` via GitHub Actions (`.github/workflows/deploy.yml`).

## Development Workflow

При любых изменениях:
1. Обновить версию в `package.json` (поле `"version"`)
2. **При добавлении новой функции** — обновить `/help` команду в `src/core/logic.js` (helpText)
3. **При важных изменениях** — обновить `README.md` и `CLAUDE.md` если затронута документируемая функциональность
4. Закоммитить и запушить в `main`:
   ```bash
   git add .
   git commit -m "описание изменений"
   git push origin main
   ```
5. GitHub Actions автоматически деплоит на сервер — бот пересобирается для тестирования

## Architecture

### Core Components

```
src/
├── index.js           # Bot initialization and polling
├── config.js          # Environment config, API keys, model selection
├── core/
│   ├── logic.js       # Main message handler and decision logic
│   └── prompts.js     # System prompts and bot personality
├── services/
│   ├── ai.js          # Multi-provider AI service with fallback chain
│   └── storage.js     # JSON file-based persistence (debounced saves)
└── utils/
    └── helpers.js     # Utility functions
```

### Data Storage (`/data` directory)
- `db.json` - Chats and banned users
- `profiles.json` - User profiles (reputation, traits, interests)
- `chatProfiles.json` - Factual chat profiles (topic and facts)
- `instructions.json` - User-specific instructions

### Message Processing Flow

1. **index.js**: Receives Telegram message via polling
2. **logic.js**: `processMessage()` handles routing:
   - Ban check → Thread resolution → Admin presence check → Command detection
   - Private messages forward to admin
   - Group messages go through AI processing
3. **ai.js**: Multi-model response generation with search integration
4. **storage.js**: Persist updates to JSON files

### Hybrid AI Model Strategy

| Purpose | Environment variable | Usage |
|---------|----------------------|-------|
| Logic/Analysis | `AI_LOGIC_MODEL` | Context analysis, search routing, emoji selection |
| Smart Responses | `AI_MAIN_MODEL` | Generate conversational replies |
| Google Native | `GOOGLE_NATIVE_MODEL` | Native Gemini and Google Search |
| Fallback | `GOOGLE_FALLBACK_MODEL` | Google Gemini fallback |
| Perplexity Search | `PERPLEXITY_MODEL` | Search through OpenRouter |

**Fallback chain**: OpenAI GPT-5.6 Luna → Google Gemini (rotates through multiple keys) → Admin notification

### Search Providers (configurable via `SEARCH_PROVIDER` env var)
- Tavily (default, recommended)
- Perplexity (via OpenRouter)
- Google (via Gemini Tools)

## Key Environment Variables

```
TELEGRAM_BOT_TOKEN     # From @BotFather
ADMIN_USER_ID          # Your Telegram ID (controls admin features)
OPENAI_API_KEY         # OpenAI API key
AI_API_KEY             # Optional generic key for another compatible provider
OPENROUTER_API_KEY     # Optional OpenRouter key
AI_BASE_URL            # Optional, defaults to the official OpenAI API
AI_MAIN_MODEL          # Main conversational model ID
AI_LOGIC_MODEL         # Logic and JSON analysis model ID
SEARCH_PROVIDER        # tavily | perplexity | google
TAVILY_API_KEY         # If using Tavily search
PERPLEXITY_MODEL       # Perplexity model ID when that provider is selected
GOOGLE_GEMINI_API_KEY  # Required for fallback
GOOGLE_GEMINI_API_KEY_2 # Optional additional keys for rotation
GOOGLE_NATIVE_MODEL    # Native Gemini model ID
GOOGLE_FALLBACK_MODEL  # Gemini fallback model ID
```

See `.env.example` for full configuration template.

## Profile System (User Memory)

Бот запоминает информацию о пользователях в `profiles.json` (изолировано по чатам).

**Поля профиля:** `realName`, `facts`, `attitude`, `relationship` (0-100), `location`

**Два механизма обновления:**
- **Batch (Наблюдатель)**: каждые 20 сообщений анализирует всех участников
- **Immediate (Рефлекс)**: после каждого ответа бота анализирует собеседника

**Правила репутации:**
- Позитив к боту: +1..+3 (копить сложно)
- Негатив к боту: -5..-10 (терять легко)
- Конфликты с другими пользователями НЕ влияют на репутацию
- Валидация в коде: `storage.js` → `_applyProfileUpdates()`

## Chat Profile System (Chat Context)

Бот запоминает информацию о чатах в `chatProfiles.json`.

**Поля профиля чата:** `topic`, `facts`, `lastUpdated`

**Механизмы обновления:**
- **Batch**: каждые 50 сообщений анализирует тему и факты чата
- **Инициализация**: при пустом профиле и наличии 10+ сообщений в истории

**Лимиты:**
- `topic`: до 200 символов (1-2 предложения)
- `facts`: до 500 символов (накопленные факты)

**Использование:** контекст чата передаётся в каждый запрос AI (~100 токенов).

## Design Decisions

- **Admin-only groups**: Bot auto-leaves groups where admin isn't a member
- **No database**: JSON file persistence with 5-second debounced saves
- **Graceful shutdown**: SIGINT handler saves all data before exit
- **History limit**: Keeps last 30 messages per chat
- **Profile updates queue**: Prevents race condition between Batch and Immediate
- **Bot trigger pattern**: `/(?<![а-яёa-z])(сыч|sych)(?![а-яёa-z])/i`
- **Timezone**: Yekaterinburg UTC+5 for time-aware responses

## Bot Commands (in-chat)

- `/start` - Bot info
- `/ban [username]` - Ban user (admin only)
- `/unban [ID]` - Restore user (admin only)
- `Сыч кто я?` - Show user profile
- `Сыч стата` - Show token usage statistics
