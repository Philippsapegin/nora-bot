const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logic = require('./core/logic');
const { responses } = require('./core/personality');
const storage = require('./services/storage');


const originalLog = console.log;
const originalError = console.error;

function getTimestamp() {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const y = String(now.getFullYear()).slice(-2);
  const t = now.toLocaleTimeString('ru-RU', { hour12: false });
  return `${d}.${m}.${y}-${t}`;
}

console.log = (...args) => originalLog(getTimestamp(), ...args);
console.error = (...args) => originalError(getTimestamp(), ...args);


// Создаем бота
const bot = new TelegramBot(config.telegramToken, { polling: true });

// Передаем бота в AI-сервис для уведомлений
const ai = require('./services/ai');
ai.setBot(bot);

console.log(responses.index.startupLog);
console.log(`Admin ID: ${config.adminId}`);

// Обработка ошибок поллинга
bot.on('polling_error', (error) => {
    console.error(`[POLLING ERROR] ${error.code}: ${error.message}`);
    // Если ошибка "Conflict: terminated by other getUpdates", значит запущен второй экземпляр
  });

// Единый вход для всех сообщений
bot.on('message', async (msg) => {
  // Игнорируем сообщения, старше 2 минут (чтобы не отвечать на старое при рестарте)
  const now = Math.floor(Date.now() / 1000);
  if (msg.date < now - 120) return;

  const chatId = msg.chat.id;
  const chatTitle = msg.chat.title || responses.index.privateChatTitle;

  // === 🛡 SECURITY PROTOCOL: "ВЕРНЫЙ ОРУЖЕНОСЕЦ" ===
  // Проверяем наличие Админа в ЛЮБОМ групповом чате при ЛЮБОМ сообщении
  if (msg.chat.type !== 'private') {
      try {
          // 1. Проверяем статус Админа в этом чате
          const adminMember = await bot.getChatMember(chatId, config.adminId);
          const allowedStatuses = ['creator', 'administrator', 'member'];

          // 2. Если Админа нет (left, kicked) или он не участник
          if (!allowedStatuses.includes(adminMember.status)) {
            console.log(`[SECURITY] ⛔ Обнаружен чат без Админа...`);
            
            // ВОТ ТУТ МЕНЯЕМ СООБЩЕНИЕ
            const phrases = responses.index.securityPhrases;
            const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];

            await bot.sendMessage(chatId, randomPhrase).catch(() => {});
            await bot.leaveChat(chatId).catch(() => {});
            return; 
        }
      } catch (e) {
        // Если ошибка проверки прав
        console.error(`[SECURITY ERROR] Ошибка проверки прав в "${chatTitle}": ${e.message}`);
        
        // ВЫХОДИМ ТОЛЬКО ЕСЛИ ЧАТА БОЛЬШЕ НЕТ ИЛИ БОТА КИКНУЛИ
        // При обычных сетевых ошибках (ETIMEDOUT, 502 и т.д.) - ОСТАЕМСЯ
        if (e.message.includes('chat not found') || e.message.includes('kicked') || e.message.includes('Forbidden')) {
           bot.leaveChat(chatId).catch(() => {});
        } 
        // Во всех остальных случаях (лаг API) — просто игнорируем и работаем дальше
    }
  }

  // === ЛОГИКА ВЫХОДА ВСЛЕД ЗА АДМИНОМ (ХАТИКО) ===
  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    console.log(`[SECURITY] Админ вышел из чата "${chatTitle}". Ухожу следом.`);
    await bot.sendMessage(chatId, responses.index.adminLeftChat);
    await bot.leaveChat(chatId);
    return;
  }

  // Дальше идет обычная логика...
  await logic.processMessage(bot, msg);
});

// Сохраняем базу при выходе
process.on('SIGINT', () => {
  console.log("Сохранение данных перед выходом...");
  storage.forceSave(); 
  process.exit();
});
