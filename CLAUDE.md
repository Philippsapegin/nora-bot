# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nora Bot is a Telegram bot with Gemini 3.7 Flash conversational generation and Gemini 3.5 Flash-Lite service logic. It's a stateful conversational agent with character, memory, and autonomous decision-making capabilities. The bot operates primarily in Russian.

- **Node.js**: 20+ required
- **Package Type**: CommonJS
- **Entry Point**: `src/index.js`

## Commands

```bash
npm start          # Run the bot locally
npm install        # Install dependencies
```

### Production Deployment (PM2)
```bash
pm2 start src/index.js --name "nora-bot"
pm2 restart nora-bot --update-env
```

Legacy GitHub Actions deployment is disabled. Production is deployed manually to `/home/phil/nora-bot` and restarted through the `nora-bot` PM2 process.

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
5. Развернуть архив коммита на сервере, установить production-зависимости и перезапустить `nora-bot` через PM2 с `--update-env`

## Architecture

### Core Components

```
src/
├── index.js           # Bot initialization and polling
├── config.js          # Environment config, API keys, model selection
├── core/
│   ├── logic.js       # Main message handler and decision logic
│   └── personality.js # System prompts, bot personality and static responses
├── services/
│   ├── ai.js          # Multi-provider AI service with fallback chain
│   ├── gemini.js      # Google GenAI SDK, per-model project-key rotation
│   ├── aiFailover.js  # Persistent 4-message / 4-hour conversational circuit breaker
│   ├── conversationMemory.js # Expiring per-user/per-topic dialogue context
│   ├── loreMemory.js  # Local relevance retrieval for Nora's memories
│   ├── telegramHealth.js # Polling watchdog, bounded requests and admin alerts
│   └── storage.js     # JSON file-based persistence (debounced saves)
├── lore/
│   ├── core.md        # Always-on canonical biography and worldview
│   └── events.json    # Episodic first-person memories with retrieval metadata
```

### Data Storage (`/data` directory)
- `db.json` - Chats and banned users
- `profiles.json` - User profiles (reputation, traits, interests)
- `chatProfiles.json` - Legacy chat-profile data; it is not injected into replies
- `instructions.json` - User-specific instructions
- `ai-failover.json` - Consecutive fallback count, working reserve and recovery deadline

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
| Google Native | `GOOGLE_NATIVE_MODEL` | Gemini fallback for the optional OpenAI provider |
| Google Search | `GOOGLE_SEARCH_MODEL` | Separate search model, currently Gemini 2.5 Flash-Lite |
| Fallback | `GOOGLE_FALLBACK_MODELS` | Ordered reserves; legacy `GOOGLE_FALLBACK_MODEL` also supported |
| Perplexity Search | `PERPLEXITY_MODEL` | Search through OpenRouter |

**Default provider**: `AI_PROVIDER=google`. Gemini 3.7 Flash → per-model key rotation across projects → Gemini 3.5 Flash → Gemini 2.5 Flash. Gemini 3.8/3.6 Flash are not in the active chain. Service JSON/text tasks use Flash-Lite without Nora's conversational system prompt. All conversational tasks (including profile descriptions) use the current personality and canonical lore. Search results survive fallback unchanged.

**Persistent conversational failover**: after four consecutive replies route away from the primary (even if all reserves fail), skip the primary for four hours. A primary text response resets the streak. Count once per conversational reply, globally across chats, excluding service/search/probe calls. In pinned mode try the last working reserve first, then other reserves, never the primary. At expiry one internal 30-second primary probe runs even in an idle chat, without SDK retries or key rotation; usable text restores normal routing, any failure/empty output extends the pin by one hour. Replies continue on reserve during the single-flight probe. Persist the streak, active reserve and deadline atomically in `data/ai-failover.json`; daily stats reset must not clear it. Configuration changes invalidate saved state. Epoch guards stop older concurrent requests from undoing a pin/recovery. Report pin/deadline in stats and notify the admin on transitions. Preserve the author's conversational personality; only help/stats formatting changes for this feature.

The Google GenAI SDK uses no internal retries. Primary conversational requests have a 20-second deadline, fallback and service logic 30 seconds, and search 60 seconds. Model timeouts immediately fall back instead of repeating across projects; temporary HTTP overload gets at most one extra project. Quota/key errors rotate through the key pool independently per model. Gemini 3.x Flash uses low thinking, Flash-Lite minimal thinking, and Gemini 2.5 Flash zero thinking budget. Thought parts are never published. The optional `AI_PROVIDER=openai` path is retained; an existing OpenAI key cannot override Google routing.

### Search Providers (configurable via `SEARCH_PROVIDER` env var)
- Google (default; returns search facts to the primary model)
- Tavily
- Perplexity (via OpenRouter)

Search providers gather factual context only. The final user-facing response is generated by `AI_MAIN_MODEL`.

## Key Environment Variables

```
TELEGRAM_BOT_TOKEN     # From @BotFather
ADMIN_USER_ID          # Your Telegram ID (controls admin features)
NORA_INTERVIEWER_USER_ID # User Nora recognizes as her longtime Interviewer
OPENAI_API_KEY         # OpenAI API key
AI_PROVIDER            # google | openai; set explicitly in .env
AI_API_KEY             # Optional generic key for another compatible provider
OPENROUTER_API_KEY     # Optional OpenRouter key
AI_BASE_URL            # Optional, defaults to the official OpenAI API
AI_MAIN_MODEL          # Main conversational model ID
AI_LOGIC_MODEL         # Logic and JSON analysis model ID
SEARCH_PROVIDER        # tavily | perplexity | google
TAVILY_API_KEY         # If using Tavily search
PERPLEXITY_MODEL       # Perplexity model ID when that provider is selected
GOOGLE_GEMINI_API_KEY  # Required for the Google provider/search/fallback
GOOGLE_GEMINI_API_KEY_2 # Optional additional keys for rotation
GOOGLE_NATIVE_MODEL    # Native Gemini model ID
GOOGLE_SEARCH_MODEL    # Search model; separate from conversational Gemini 3.x
GOOGLE_FALLBACK_MODELS # Comma-separated ordered Gemini conversational reserves
GOOGLE_FALLBACK_MODEL  # Legacy single reserve, used only without the list
CONTEXT_MAX_MESSAGES   # Maximum messages in one temporary dialogue (default 20)
CONTEXT_TTL_MINUTES    # Lifetime of each dialogue message (default 30 minutes)
```

See `.env.example` for full configuration template.

## Canonical Lore Memory

The source lore is a 23-week author document. Runtime lore is a careful first-person reconstruction rather than the interview transcript itself.

- `core.md` is included in the system prompt on every conversational generation.
- `events.json` contains 17 meaningful memories; empty weeks, author instructions, and transcript scaffolding are excluded.
- `loreMemory.js` performs deterministic local retrieval using aliases and weighted normalized tokens.
- At most two matching event memories are injected. Unrelated questions receive no episodic lore.
- Matching lore titles are passed to the search router so autobiographical questions do not trigger web search.
- Statements by the Duck Professor about being text remain his philosophical position; Nora's disagreement is preserved.
- New lore must be written as Nora's memory, not as an interview, prompt, or narrator transcript.
- `NORA_INTERVIEWER_USER_ID` gets a conditional relationship cue: Nora often prefers calling that user «Интервьюер», but does not append it mechanically to every response.

### Wednesday behavior

Wednesday in Asia/Yekaterinburg activates the author's local system-level invention modifier: near-madness of ΩКРЫЛ, the self-aware teacup, and the Cathedral of Wednesdays, with wild invention additions to advice. Preserve author edits in `src/core/personality.js`; Gemini receives that system prompt afresh on every conversational call.

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

## Temporary Dialogue Context

Контекст ответа хранится только в памяти процесса и разделён ключом `chatId + threadId + userId`.

- Сообщения другого пользователя никогда не попадают в диалог текущего собеседника.
- Один пользователь имеет независимый контекст в каждом Telegram-топике.
- По умолчанию сохраняются последние 20 реплик, каждая живёт 30 минут.
- Старые сообщения удаляются постепенно по собственному времени создания.
- `/reset` очищает только диалог вызвавшего пользователя в текущем топике.
- Общий профиль чата больше не передаётся в основной промпт и поисковый маршрутизатор.
- Перезапуск PM2 полностью очищает временный контекст.

## Design Decisions

### Telegram transport health

- Telegram requests use a 45-second socket/connection timeout; long polling waits 10 seconds.
- `telegramHealth.js` observes successful and failed `getUpdates` completions, including empty replies. Chat silence is not a failure.
- The watchdog checks every 10 seconds and cancels/restarts stalled polling after 60 seconds, preserving update offsets and in-memory conversations.
- Consecutive errors for 60 seconds notify the admin; authentication/conflict errors notify immediately. Outage reminders are throttled to five minutes.
- Alerts use an independent HTTP request with a 10-second deadline, scrub tokens, and retry failed delivery. Recovery is reported after a successful poll.
- A `[TELEGRAM HEALTH] Polling OK` heartbeat is logged at startup and every five minutes while healthy.
- Async message-processing errors are caught, logged and reported instead of escaping the event handler.

- **Admin-only groups**: Bot auto-leaves groups where admin isn't a member
- **No database**: JSON file persistence with 5-second debounced saves
- **Graceful shutdown**: SIGINT handler saves all data before exit
- **History isolation**: Keeps up to 20 expiring messages per chat/topic/user by default
- **Profile updates queue**: Prevents race condition between Batch and Immediate
- **Bot trigger pattern**: Russian name «Нора» and its grammatical forms
- **Timezone**: Yekaterinburg UTC+5 for time-aware responses

## Bot Commands (in-chat)

- `/start` - Bot info
- `/ban [username]` - Ban user (admin only)
- `/unban [ID]` - Restore user (admin only)
- `Нора кто я?` - Show user profile
- `Нора стата` - Show token usage statistics
