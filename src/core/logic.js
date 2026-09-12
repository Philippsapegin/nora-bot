const telegram = require('node-telegram-bot-api');
const storage = require('../services/storage');
const ai = require('../services/ai');
const config = require('../config');
const { responses } = require('./personality');
const ConversationMemory = require('../services/conversationMemory');
const axios = require('axios');
const { exec } = require('child_process');
const conversationMemory = new ConversationMemory({
  ttlMs: config.contextTtlMs,
  maxMessages: config.contextSize,
});
const analysisBuffers = {};
const BUFFER_SIZE = 20;
// Храним 10 последних активных юзеров для удобного бана
const recentActiveUsers = []; 
const noraTriggerForms = '(?:нора|норы|норе|нору|норой|норою)';
const noraStatsRegex = new RegExp(`^${noraTriggerForms}\\W+(?:стата|статистика)$`);

// === ГЕНЕРАТОР ОТМАЗОК СЫЧА ===
function getSychErrorReply(errText) {
  return responses.getErrorReply(errText);
}

function getBaseOptions(threadId) {
    const opts = { parse_mode: 'Markdown', disable_web_page_preview: true };
    if (threadId) opts.message_thread_id = threadId;
    return opts;
}

function getReplyOptions(msg) {
    return { reply_to_message_id: msg.message_id, parse_mode: 'Markdown', disable_web_page_preview: true };
}

function getActionOptions(threadId) {
    // [FIX] Если топика нет, возвращаем undefined.
    // Это важно: библиотека node-telegram-bot-api не любит пустой объект {} в обычных группах.
    if (!threadId) return undefined;
    return { message_thread_id: threadId };
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function processBuffer(chatId) {
    const buffer = analysisBuffers[chatId];
    if (!buffer || buffer.length === 0) return;

    const userIds = [...new Set(buffer.map(m => m.userId))];
    const currentProfiles = storage.getProfilesForUsers(chatId, userIds);
    const updates = await ai.analyzeBatch(buffer, currentProfiles);

    if (updates) {
        storage.bulkUpdateProfiles(chatId, updates);
        console.log(`[OBSERVER] Обновлено профилей: ${Object.keys(updates).length}`);
    }
    analysisBuffers[chatId] = [];
}

async function processMessage(bot, msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    // === ⛔ ГЛОБАЛЬНЫЙ БАН ===
    if (storage.isBanned(userId) && userId !== config.adminId) {
        return; // Полный игнор
    }
    
    // 1. УМНЫЙ ПОИСК ТОПИКА
    // Если это топик, ID должен быть тут. Если это реплай, иногда ID лежит внутри reply_to_message.
    // [FIX] ЖЕСТКАЯ ПРОВЕРКА: Топик должен быть числом.
    // В обычных группах тут может быть undefined, null или мусор — всё превращаем в null.
    let threadId = msg.is_topic_message ? msg.message_thread_id : (msg.message_thread_id || (msg.reply_to_message ? msg.reply_to_message.message_thread_id : null));
    if (typeof threadId !== 'number') threadId = null;
    
    let text = msg.text || msg.caption || "";

    const cleanText = text.toLowerCase();
    const replyUserId = msg.reply_to_message?.from?.id;
    const isReplyToBot = replyUserId && String(replyUserId) === String(config.botId);
    const hasTriggerWord = config.triggerRegex.test(cleanText); 
    const isDirectlyCalled = hasTriggerWord || isReplyToBot; 

    // === ЕДИНЫЙ КОНТРОЛЛЕР СТАТУСА "ПЕЧАТАЕТ" ===
    let typingTimer = null;
    let safetyTimeout = null; // Предохранитель

    const stopTyping = () => {
        if (typingTimer) {
            clearInterval(typingTimer);
            typingTimer = null;
        }
        if (safetyTimeout) {
            clearTimeout(safetyTimeout);
            safetyTimeout = null;
        }
    };

    const startTyping = () => {
        if (typingTimer) return; // Уже печатает

        const sendAction = () => {
            // Шлем action с учетом треда
            if (threadId) {
                bot.sendChatAction(chatId, 'typing', { message_thread_id: threadId }).catch(() => {});
            } else {
                bot.sendChatAction(chatId, 'typing').catch(() => {});
            }
        };

        sendAction(); // Шлем первый раз сразу
        typingTimer = setInterval(sendAction, 4000); // Повторяем каждые 4 сек

        // !!! ЗАЩИТА ОТ ВЕЧНОГО ПЕЧАТАНИЯ !!!
        // Если через 60 секунд мы все еще печатаем — вырубаем принудительно.
        safetyTimeout = setTimeout(() => {
            console.log(`[TYPING SAFETY] Принудительная остановка тайпинга в ${chatId}`);
            stopTyping();
        }, 20000);
    };

    const command = text.trim().split(/[\s@]+/)[0].toLowerCase(); 
  
    // Определяем красивое имя чата (Название группы или Имя юзера в личке)
    const chatTitle = msg.chat.title || msg.chat.username || msg.chat.first_name || "Unknown";
    // Запоминаем активность для команды /ban (кроме Админа)
    if (userId !== config.adminId) {
        const senderInfo = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
        // Убираем дубли, если юзер уже есть в начале списка
        const existingIndex = recentActiveUsers.findIndex(u => u.id === userId);
        if (existingIndex !== -1) recentActiveUsers.splice(existingIndex, 1);
        
        recentActiveUsers.unshift({
            id: userId,
            name: senderInfo,
            text: text.slice(0, 30), // Сохраняем начало сообщения
            chat: chatTitle
        });
        if (recentActiveUsers.length > 10) recentActiveUsers.pop();
    }
      // === УВЕДОМЛЕНИЕ О НОВОМ ЧАТЕ ===
  // Если чата нет в базе И это не сам админ пишет себе в личку
  if (!storage.hasChat(chatId) && chatId !== config.adminId) {
    let alertText = responses.adminAlerts.newContactHeader(chatTitle, chatId);
    
    const inviter = `@${msg.from.username || responses.adminAlerts.noUsername} (${msg.from.first_name})`;

    if (msg.chat.type === 'private') {
        alertText += responses.adminAlerts.privateMessage(inviter, text);
    } else {
        // Если добавили в группу
        if (msg.new_chat_members && msg.new_chat_members.some(u => u.id === config.botId)) {
           alertText += responses.adminAlerts.groupAdded(inviter);
        } else {
           // Просто первое сообщение из новой группы, где я уже был (или админ чистил базу)
           alertText += responses.adminAlerts.groupActivated(inviter, text);
        }
    }
    
        // Шлем админу тихонько
        bot.sendMessage(config.adminId, alertText, { parse_mode: 'Markdown' }).catch(() => {});
        }

        // Сохраняем в базу, чтобы в файлах было видно
        storage.updateChatName(chatId, chatTitle);

        // === ЛИЧКА: ПЕРЕСЫЛКА АДМИНУ И ОТВОРОТ-ПОВОРОТ ===
    if (msg.chat.type === 'private' && userId !== config.adminId) {
        // 1. Стучим админу о КАЖДОМ сообщении
        const senderInfo = `@${msg.from.username || responses.adminAlerts.noUsername} (${msg.from.first_name})`;
        
        // Формируем отчет: текст или пометка о файле
        let contentReport = text ? responses.adminAlerts.privateForwardText(text) : responses.privateMode.filePlaceholder;
        
        // Шлем тебе
        bot.sendMessage(config.adminId, responses.adminAlerts.privateForward(senderInfo, contentReport)).catch(e => console.error(responses.adminAlerts.privateForwardErrorLog, e.message));

        // 2. Если это не команда /start — отшиваем вежливо, но с инфой
        if (command !== '/start') {
            bot.sendChatAction(chatId, 'typing', getActionOptions(threadId)).catch(() => {});
            await new Promise(r => setTimeout(r, 1500)); // Пауза для реализма

            const infoText = responses.privateMode.infoText;

            // Отправляем с Markdown.
            // disable_web_page_preview: true — чтобы не забивать чат картинками ссылок
            await bot.sendMessage(chatId, infoText, { parse_mode: 'Markdown', disable_web_page_preview: true });
            
            return; // Дальше не пускаем
        }
    }

  
  if (msg.left_chat_member && msg.left_chat_member.id === config.adminId) {
    await bot.sendMessage(chatId, responses.privateMode.adminLeftShort);
    await bot.leaveChat(chatId);
    return;
  }

  if (!text && !msg.photo && !msg.video && !msg.document && !msg.sticker) return;

  if (msg.chat.type === 'private') {
    if (userId !== config.adminId) return;
  } else {
    storage.trackUser(chatId, msg.from);
  }

  // === НАБЛЮДАТЕЛЬ ===
  if (!analysisBuffers[chatId]) analysisBuffers[chatId] = [];
  
  // Собираем полную инфу о юзере для лога
  const senderName = msg.from.first_name || responses.identity.fallbackSenderName;
  const senderUsername = msg.from.username ? `@${msg.from.username}` : "";
  const displayName = senderUsername ? `${senderName} (${senderUsername})` : senderName;

  if (!text.startsWith('/')) {
      // Пишем в буфер для анализа профилей юзеров
      analysisBuffers[chatId].push({ userId, name: displayName, text });
  }
  if (analysisBuffers[chatId].length >= BUFFER_SIZE) {
      processBuffer(chatId);
  }

  const isMuted = storage.isTopicMuted(chatId, threadId);

  // === КОМАНДЫ ===
  if (command === '/version') {
    return bot.sendMessage(chatId, responses.commands.version(config.version), getBaseOptions(threadId));
}

  // === АДМИН-ПАНЕЛЬ (БАНЫ) ===
  if (userId === config.adminId) {
      
    // 1. СПИСОК ЗАБАНЕННЫХ
    if (command === '/banlist') {
        const banned = storage.getBannedList();
        const list = Object.entries(banned).map(([uid, name]) => `⛔ \`${uid}\` — ${name}`).join('\n');
        return bot.sendMessage(chatId, responses.commands.banList(list), getBaseOptions(threadId));
    }

    // 2. РАЗБАН
    if (command === '/unban') {
        const targetId = text.split(' ')[1];
        if (!targetId) return bot.sendMessage(chatId, responses.commands.unbanPrompt, getBaseOptions(threadId));

        storage.unbanUser(targetId);
        return bot.sendMessage(chatId, responses.commands.unbanSuccess(targetId), getBaseOptions(threadId));
    }

    // 3. БАН (С интерфейсом)
    if (command === '/ban') {
        const args = text.split(/\s+/);
        const target = args[1]; // Может быть ID или @username

        // Вариант А: Просто /ban (показываем последних активных)
        if (!target) {
            if (recentActiveUsers.length === 0) return bot.sendMessage(chatId, responses.commands.emptyActivity, getBaseOptions(threadId));
            
            const list = recentActiveUsers.map((u, i) => {
                return `${i+1}. **${u.name}**\n🆔 \`${u.id}\`\n💬 "${u.text}..."\n📂 ${u.chat}`;
            }).join('\n\n');
            
            return bot.sendMessage(chatId, responses.commands.lastActive(list), getBaseOptions(threadId));
        }

        // Вариант Б: /ban @username или /ban 123456
        let targetId = target;
        let targetName = target;

        // Если ввели username (начинается с @ или буквы)
        if (isNaN(target)) {
           const foundId = storage.findUserIdByUsername(target);
           if (!foundId) return bot.sendMessage(chatId, responses.commands.userNotFound(target), getBaseOptions(threadId));
           targetId = foundId;
        }

        if (parseInt(targetId) === config.adminId) return bot.sendMessage(chatId, responses.commands.selfBan, getBaseOptions(threadId));

        storage.banUser(targetId, targetName);
        return bot.sendMessage(chatId, responses.commands.banSuccess(targetName, targetId), getBaseOptions(threadId));
    }
}

  if (command === '/help' || command === '/start') {
    const helpText = responses.commands.helpText;
    try { return await bot.sendMessage(chatId, helpText, getBaseOptions(threadId)); } catch (e) {}
}

  if (command === '/mute') {
    const nowMuted = storage.toggleMute(chatId, threadId);
    return bot.sendMessage(chatId, nowMuted ? responses.commands.muteOn : responses.commands.muteOff, getBaseOptions(threadId));
  }
  if (command === '/reset') {
    conversationMemory.reset(chatId, threadId, userId);
    return bot.sendMessage(chatId, responses.commands.resetDone, getBaseOptions(threadId));
  }

  if (command === '/restart' && userId === config.adminId) {
    await bot.sendMessage(chatId, responses.commands.restarting, getBaseOptions(threadId));
    exec('pm2 restart nora-bot || pm2 restart sych-bot', (err) => {
        if (err) bot.sendMessage(config.adminId, responses.commands.restartError(err.message));
    });
    return;
  }

  // === СТРОГАЯ ПРОВЕРКА МУТА ===
  // Если топик в муте, мы игнорируем ЛЮБОЙ текст (триггеры, реплаи, имя),
  // кроме команд выше (/mute, /reset, /start).
  if (storage.isTopicMuted(chatId, threadId)) {
    return; // Полный игнор
  }

  // === ТЕПЕРЬ, КОГДА МЫ ТОЧНО НЕ В МУТЕ ===
  if (isDirectlyCalled) {
    startTyping(); 
  }

  // Диалоговая память принадлежит конкретному человеку внутри конкретного топика.
  // Текущее сообщение передаётся модели отдельно, поэтому в history кладём только прошлое.
  const conversationHistory = conversationMemory.get(chatId, threadId, userId);
  conversationMemory.add(chatId, threadId, userId, senderName, text);

  // === СТАТИСТИКА ===
  if (noraStatsRegex.test(cleanText.trim())) {
    const report = ai.getStatsReport();
    return bot.sendMessage(chatId, report, getReplyOptions(msg));
  }

  // === ФИЧИ ===
  if (hasTriggerWord) {
      const aboutMatch = cleanText.match(/(?:расскажи про|кто так(?:ой|ая)|мнение о|поясни за)\s+(.+)/);
      if (aboutMatch) {
        const targetName = aboutMatch[1].replace('?', '').trim();
        const targetProfile = storage.findProfileByQuery(chatId, targetName);
        if (targetProfile) {
            startTyping();
            const description = await ai.generateProfileDescription(targetProfile, targetName);
            stopTyping();
            conversationMemory.add(chatId, threadId, userId, responses.identity.botName, description);
            try { return await bot.sendMessage(chatId, description, getReplyOptions(msg)); } catch(e){}
        }
    }
      
  }

  // === РЕШЕНИЕ ОБ ОТВЕТЕ ===
  // Бот отвечает ТОЛЬКО когда его явно вызвали по имени (любой формой "Нора") или ответили на его сообщение
  const shouldAnswer = isDirectlyCalled;

  // === ЛОГИКА РЕАКЦИЙ (15%) ===
  if (!shouldAnswer && text.length > 10 && !isReplyToBot && Math.random() < 0.015) {
      
    // Реакция учитывает только сообщения этого пользователя в текущем топике.
    const historyBlock = conversationMemory.get(chatId, threadId, userId)
        .slice(-15)
        .map(m => `${m.role}: ${m.text}`)
        .join('\n');
    
    // Передаем истории вместе с текущим текстом
    ai.determineReaction(historyBlock + responses.features.reactionContext(text)).then(async (emoji) => {
        if (emoji) {
            try { await bot.setMessageReaction(chatId, msg.message_id, { reaction: [{ type: 'emoji', emoji: emoji }] }); } catch (e) {}
        }
    });
}

  // === ОТПРАВКА ОТВЕТА ===
  if (shouldAnswer) {
    startTyping();

    let imageBuffer = null;
    let mimeType = "image/jpeg"; // По умолчанию для фото

    // === ОБРАБОТКА МЕДИА (ФОТО, ВИДЕО, ДОКИ, СТИКЕРЫ) ===
    
    // 1. СТИКЕР
    if (msg.sticker) {
        const stickerEmoji = msg.sticker.emoji || "";
        if (stickerEmoji) text += responses.features.stickerContext(stickerEmoji);

        if (!msg.sticker.is_animated && !msg.sticker.is_video) {
            try {
                const link = await bot.getFileLink(msg.sticker.file_id);
                const resp = await axios.get(link, { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
                mimeType = "image/webp";
            } catch (e) { console.error("Ошибка стикера:", e.message); }
        }
    }

    // 2. ФОТО (обычное или реплай)
    else if (msg.photo || (msg.reply_to_message && msg.reply_to_message.photo)) {
       try {
         const photoObj = msg.photo ? msg.photo[msg.photo.length-1] : msg.reply_to_message.photo[msg.reply_to_message.photo.length-1];
         const link = await bot.getFileLink(photoObj.file_id);
         const resp = await axios.get(link, { responseType: 'arraybuffer' });
         imageBuffer = Buffer.from(resp.data);
         mimeType = "image/jpeg";
         console.log(`[MEDIA] Фото скачано`);
       } catch(e) { console.error("Ошибка фото:", e.message); }
    }

    // 3. ВИДЕО
    else if (msg.video || (msg.reply_to_message && msg.reply_to_message.video)) {
        const vid = msg.video || msg.reply_to_message.video;
        // Лимит 20 МБ (Telegram API limit for getFile)
        if (vid.file_size > 20 * 1024 * 1024) {
            return bot.sendMessage(chatId, responses.features.videoTooLarge, getReplyOptions(msg));
        }
        try {
            await bot.sendChatAction(chatId, 'upload_video', getActionOptions(threadId));
            const link = await bot.getFileLink(vid.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
            mimeType = vid.mime_type || "video/mp4";
            console.log(`[MEDIA] Видео скачано (${mimeType})`);
        } catch(e) { console.error("Ошибка видео:", e.message); }
    }

    // 4. ДОКУМЕНТЫ (PDF, TXT, CSV...)
    else if (msg.document || (msg.reply_to_message && msg.reply_to_message.document)) {
        const doc = msg.document || msg.reply_to_message.document;
        
        // Список того, что Gemini точно ест
        const allowedMimes = [
            'application/pdf', 'application/x-javascript', 'text/javascript', 
            'application/x-python', 'text/x-python', 'text/plain', 'text/html', 
            'text/css', 'text/md', 'text/csv', 'text/xml', 'text/rtf'
        ];

        if (doc.file_size > 20 * 1024 * 1024) {
            return bot.sendMessage(chatId, responses.features.documentTooLarge, getReplyOptions(msg));
        }

        if (!allowedMimes.includes(doc.mime_type) && !doc.mime_type.startsWith('image/')) {
             // ???? ?????? ????????, ?? ???? ????? ?????? - ????? ??????????? ????????, ?? ????? ????????????
             return bot.sendMessage(chatId, responses.features.unsupportedDocumentType, getReplyOptions(msg));
        }

        try {
            await bot.sendChatAction(chatId, 'upload_document', getActionOptions(threadId));
            const link = await bot.getFileLink(doc.file_id);
            const resp = await axios.get(link, { responseType: 'arraybuffer' });
            imageBuffer = Buffer.from(resp.data);
            mimeType = doc.mime_type;
            console.log(`[MEDIA] Док скачан (${mimeType})`);
        } catch(e) { console.error("Ошибка дока:", e.message); }
    }

    // 5. ССЫЛКА (если ничего другого нет)
    // 5. ССЫЛКА (ищем в текущем тексте ИЛИ в реплае)
    else if (!imageBuffer) {
        // Сначала ищем в том, что ты написал
        let urlMatch = text.match(/https?:\/\/[^\s]+?\.(jpg|jpeg|png|webp|gif|bmp)/i);
        
        // Если нет, и это реплай — ищем в сообщении, на которое ответили
        if (!urlMatch && msg.reply_to_message && (msg.reply_to_message.text || msg.reply_to_message.caption)) {
             const replyText = msg.reply_to_message.text || msg.reply_to_message.caption;
             urlMatch = replyText.match(/https?:\/\/[^\s]+?\.(jpg|jpeg|png|webp|gif|bmp)/i);
        }

        if (urlMatch) {
            try {
                const resp = await axios.get(urlMatch[0], { responseType: 'arraybuffer' });
                imageBuffer = Buffer.from(resp.data);
                if (urlMatch[0].endsWith('.webp')) mimeType = "image/webp";
                else mimeType = "image/jpeg"; 
                console.log(`[MEDIA] Картинка по ссылке скачана`);
            } catch(e) {}
        }
    }
    const instruction = msg.from.username ? storage.getUserInstruction(msg.from.username) : "";
    const userProfile = storage.getProfile(chatId, userId);

    // === ЛОГИКА ССЫЛОК ===
    let targetLink = null;
    
    // Ищем ссылку
    const linkRegex = /https?:\/\/[^\s]+/;
    const linkInText = text.match(linkRegex);
    
    if (linkInText) {
        targetLink = linkInText[0];
    } else if (msg.reply_to_message) {
        if (msg.reply_to_message.text) {
             const linkInReply = msg.reply_to_message.text.match(linkRegex);
             if (linkInReply) targetLink = linkInReply[0];
        } else if (msg.reply_to_message.caption) {
             const linkInCaption = msg.reply_to_message.caption.match(linkRegex);
             if (linkInCaption) targetLink = linkInCaption[0];
        }
    }

    let aiResponse = "";

    try {
    // Вытаскиваем текст реплая для контекста
    const replyText = msg.reply_to_message ? (msg.reply_to_message.text || msg.reply_to_message.caption || "") : "";

    aiResponse = await ai.getResponse(
        conversationHistory,
        { sender: senderName, text: text, replyText: replyText },
        imageBuffer,
        mimeType,
        instruction,
        userProfile,
        !isDirectlyCalled
    );

    console.log(`[DEBUG] 2. Ответ от AI получен! Длина: ${aiResponse ? aiResponse.length : "PUSTO"}`);
    
    if (!aiResponse) {
        console.log(`[DEBUG] 🚨 ОШИБКА: AI вернул пустоту!`);
        bot.sendMessage(config.adminId, responses.adminAlerts.geminiEmptyAlarm(chatTitle), { parse_mode: "Markdown" }).catch(() => {});
        aiResponse = getSychErrorReply("503 overloaded");

    }
    
    } catch (err) {
        console.error("[CRITICAL AI ERROR]:", err.message);
        
        // 1. ШЛЕМ ТЕХНИЧЕСКИЙ РЕПОРТ АДМИНУ (В личку)
        const errorMsg = responses.adminAlerts.geminiCrash(chatTitle, err.message);
        bot.sendMessage(config.adminId, errorMsg, { parse_mode: 'Markdown' }).catch(() => {});

        // 2. ГЕНЕРИРУЕМ СМЕШНОЙ ОТВЕТ ДЛЯ ЧАТА
        // Передаем текст ошибки в нашу новую функцию
        aiResponse = getSychErrorReply(err.message);
    }

    
    // === ФОРМАТИРОВАНИЕ И ОТПРАВКА ===
    
    // Создаем копию текста для обработки
    let formattedResponse = aiResponse;

    try {
        // --- 1. ФОРМАТИРОВАНИЕ ---
        
        // Заголовки (### Текст -> *ТЕКСТ*)
        formattedResponse = formattedResponse.replace(/^#{1,6}\s+(.*?)$/gm, (match, title) => {
            return `\n*${title.toUpperCase()}*`;
        });

        // Жирный шрифт (**текст** -> *текст*)
        formattedResponse = formattedResponse.replace(/\*\*([\s\S]+?)\*\*/g, '*$1*');
        formattedResponse = formattedResponse.replace(/__([\s\S]+?)__/g, '*$1*');

        // Списки (* пункт -> • пункт)
        formattedResponse = formattedResponse.replace(/^(\s*)[\*\-]\s+/gm, '$1• ');

        // Убираем лишние переносы
        formattedResponse = formattedResponse.replace(/\n{3,}/g, '\n\n');

    } catch (fmtErr) {
        console.error("[FORMAT ERROR] Ошибка форматирования, шлю сырой текст:", fmtErr.message);
        formattedResponse = aiResponse; // Если формат сломался, шлем оригинал
    }


    try {
        // --- 2. ОТПРАВКА ---

        // Защита от спама (обрезаем, если больше 8500)
        if (formattedResponse.length > 8500) {
            formattedResponse = formattedResponse.substring(0, 8500) + responses.features.longResponseSuffix;
        }

        // Разбиваем на куски по 4000 символов
        let chunks = formattedResponse.match(/[\s\S]{1,4000}/g) || [];

        // !!! ГЛАВНОЕ ИСПРАВЛЕНИЕ !!!
        // Если match вернул пустоту (глюк), но текст ЕСТЬ — создаем кусок вручную
        if (chunks.length === 0 && formattedResponse.length > 0) {
            console.log("[DEBUG] Регулярка вернула 0 кусков! Форсирую отправку.");
            chunks = [formattedResponse];
        }
        
        for (const chunk of chunks) {
            await bot.sendMessage(chatId, chunk, getReplyOptions(msg));
        }

        stopTyping(); // <-- Всё, сообщение ушло, выключаем статус
        
        conversationMemory.add(chatId, threadId, userId, responses.identity.botName, aiResponse);

    } catch (error) {
        stopTyping(); // <-- Если ошибка, ОБЯЗАТЕЛЬНО выключаем
        console.error(`[SEND ERROR]: ${error.message}`);

        // Отчет админу
        bot.sendMessage(config.adminId, responses.adminAlerts.sendError(error.message, chatTitle, chatId), { parse_mode: "Markdown" }).catch(() => {});

        // АВАРИЙНАЯ ОТПРАВКА (Если Markdown сломался или что-то еще)
        // Шлем чистый текст без всякого форматирования
        try { 
             const rawChunks = aiResponse.match(/[\s\S]{1,4000}/g) || [aiResponse];
             for (const chunk of rawChunks) {
                await bot.sendMessage(chatId, chunk, { reply_to_message_id: msg.message_id });
             }
             conversationMemory.add(chatId, threadId, userId, responses.identity.botName, aiResponse);
        } catch (e2) { console.error("FATAL SEND ERROR (Даже аварийная не ушла):", e2.message); }
    }

    // Рефлекс (Анализ стиля общения и репутации)
    const contextForAnalysis = conversationMemory.get(chatId, threadId, userId)
        .slice(-5)
        .map(m => `${m.role}: ${m.text}`)
        .join('\n');
    
    // Запускаем анализ
    ai.analyzeUserImmediate(contextForAnalysis, userProfile).then(updated => {
        if (updated) {
            // ЛОГИРУЕМ ИЗМЕНЕНИЯ
            if (updated.relationship) {
                console.log(`[RELATIONSHIP] ${senderName}: Новая репутация = ${updated.relationship}/100`);
            }
            
            const updates = {}; updates[userId] = updated;
            storage.bulkUpdateProfiles(chatId, updates);
        } else {
            console.log(`[RELATIONSHIP] Не удалось обновить профиль (AI вернул null)`);
        }
    }).catch(err => console.error("[RELATIONSHIP ERROR]", err));
  }
}

module.exports = { processMessage };
