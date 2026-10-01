require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();

const PORT = process.env.PORT || 10000;
const DOMAIN = (process.env.BACKEND_URL || '').replace(/\/+$/, '');

if (!DOMAIN) {
  console.warn('⚠️ BACKEND_URL is not set');
}

const REQUIRED_UPDATES = ['message', 'callback_query'];
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const REQ_TTL_MS = 30 * 60 * 1000;


// ============================================================
// BOTS
// ============================================================

const bots = [];

Object.keys(process.env).forEach(key => {
  const match = key.match(/^BOT(\d+)_TOKEN$/);

  if (!match) return;

  const number = match[1];

  const token = process.env[`BOT${number}_TOKEN`];
  const chatId = process.env[`BOT${number}_CHATID`];

  if (token && chatId) {
    bots.push({
      botId: `bot${number}`,
      token,
      chatId
    });
  }
});

console.log(
  '🤖 Bots loaded:',
  bots.map(bot => bot.botId).join(', ') || '(none)'
);


// ============================================================
// STORE
// ============================================================

const STORE_FILE = path.join(
  __dirname,
  'data',
  'store.json'
);

fs.mkdirSync(
  path.dirname(STORE_FILE),
  { recursive: true }
);

const store = {
  requests: {}
};


function loadStore() {
  try {
    if (!fs.existsSync(STORE_FILE)) {
      return;
    }

    const raw = JSON.parse(
      fs.readFileSync(STORE_FILE, 'utf8')
    );

    Object.assign(
      store.requests,
      raw.requests || {}
    );

    console.log(
      '💾 Loaded requests:',
      Object.keys(store.requests).length
    );

  } catch (error) {
    console.error(
      '❌ Store load error:',
      error.message
    );
  }
}


function saveStore() {
  try {
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify(store, null, 2)
    );
  } catch (error) {
    console.error(
      '❌ Store save error:',
      error.message
    );
  }
}


loadStore();


setInterval(() => {

  const now = Date.now();
  let changed = false;

  for (const [id, record] of Object.entries(store.requests)) {

    if (
      now - record.createdAt >
      REQ_TTL_MS
    ) {
      delete store.requests[id];
      changed = true;
    }

  }

  if (changed) {
    saveStore();
  }

}, 5 * 60 * 1000);


// ============================================================
// HELPERS
// ============================================================

function clean(value) {
  return String(
    value == null ? '' : value
  )
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}


function escapeHtml(value) {
  return String(
    value == null ? '' : value
  )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}


function newId() {
  return crypto
    .randomBytes(5)
    .toString('hex');
}


function getBot(botId) {
  return bots.find(
    bot => bot.botId === botId
  );
}


function formatMessage(
  header,
  name,
  phone,
  extra = []
) {

  const lines = [

    `<b>${escapeHtml(header)}</b>`,

    SEP,

    `<b>Name:</b> ${escapeHtml(name || 'Unknown')}`,

    `<b>Phone:</b> ${escapeHtml(phone || 'Unknown')}`

  ];

  if (extra.length) {
    lines.push(
      SEP,
      ...extra
    );
  }

  lines.push(SEP);

  return lines.join('\n');
}


// ============================================================
// TELEGRAM API
// ============================================================

async function telegram(
  bot,
  method,
  payload
) {

  try {

    const response = await axios.post(
      `https://api.telegram.org/bot${bot.token}/${method}`,
      payload
    );

    return response.data;

  } catch (error) {

    console.error(
      `❌ Telegram ${method}:`,
      error.response?.data ||
      error.message
    );

    return null;
  }
}


async function sendMessage(
  bot,
  text,
  keyboard = null
) {

  return telegram(
    bot,
    'sendMessage',
    {
      chat_id: bot.chatId,
      text,
      parse_mode: 'HTML',

      reply_markup:
        keyboard
          ? {
              inline_keyboard: keyboard
            }
          : undefined
    }
  );
}


async function answerCallback(
  bot,
  callbackId,
  text = ''
) {

  return telegram(
    bot,
    'answerCallbackQuery',
    {
      callback_query_id: callbackId,
      text
    }
  );
}


// ============================================================
// WEBHOOK SETUP
// ============================================================

async function setWebhook(bot) {

  const webhookUrl =
    `${DOMAIN}/telegram/${bot.botId}`;

  console.log('');
  console.log(
    `🌐 Setting webhook for ${bot.botId}`
  );

  console.log(
    `➡️ ${webhookUrl}`
  );

  const result = await telegram(
    bot,
    'setWebhook',
    {
      url: webhookUrl,

      allowed_updates:
        REQUIRED_UPDATES,

      drop_pending_updates: false
    }
  );

  console.log(
    '📡 setWebhook response:',
    JSON.stringify(
      result,
      null,
      2
    )
  );


  if (!result?.ok) {

    console.error(
      `❌ Webhook failed for ${bot.botId}`
    );

    return;
  }


  console.log(
    `✅ Webhook registered for ${bot.botId}`
  );


  // Ask Telegram what it currently has
  const info = await telegram(
    bot,
    'getWebhookInfo',
    {}
  );

  console.log(
    `🔎 ${bot.botId} getWebhookInfo:`
  );

  console.log(
    JSON.stringify(
      info,
      null,
      2
    )
  );
}


async function initializeWebhooks() {

  console.log('');
  console.log(
    '🔧 Initializing Telegram webhooks...'
  );

  for (const bot of bots) {

    await setWebhook(bot);

  }

  console.log(
    '✅ Webhook initialization finished'
  );
}


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(express.json());

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static('public')
);


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (req, res) => {

    res.json({
      ok: true,

      bots:
        bots.map(
          bot => bot.botId
        ),

      domain: DOMAIN
    });

  }
);


// ============================================================
// BOT ROUTE
// ============================================================

app.get(
  '/bot/:botId',
  (req, res) => {

    const bot =
      getBot(req.params.botId);

    if (!bot) {

      return res
        .status(404)
        .send('Unknown bot');

    }

    res.redirect(
      `/index.html?botId=${encodeURIComponent(
        bot.botId
      )}`
    );

  }
);


// ============================================================
// TELEGRAM GET TEST
// ============================================================

app.get(
  '/telegram/:botId',
  (req, res) => {

    console.log(
      '🧪 TELEGRAM GET TEST:',
      req.params.botId
    );

    res.json({
      ok: true,

      route:
        `/telegram/${req.params.botId}`,

      message:
        'Telegram webhook route is reachable'
    });

  }
);


// ============================================================
// TELEGRAM CALLBACK TEST
//
// Open:
// https://YOUR-DOMAIN/telegram-test/bot9
//
// This sends a harmless TEST CALLBACK button.
// ============================================================

app.get(
  '/telegram-test/:botId',
  async (req, res) => {

    const bot =
      getBot(req.params.botId);

    if (!bot) {

      return res
        .status(404)
        .json({
          ok: false,
          error: 'Unknown bot'
        });

    }


    console.log(
      '🧪 Creating Telegram callback test for:',
      bot.botId
    );


    const result =
      await sendMessage(
        bot,

        '🧪 <b>Webhook callback test</b>\n\nClick the button below.',

        [
          [
            {
              text: 'TEST CALLBACK',

              callback_data:
                'test_callback'
            }
          ]
        ]
      );


    console.log(
      '📨 Test message result:',
      JSON.stringify(
        result,
        null,
        2
      )
    );


    res.json({
      ok: true,

      botId:
        bot.botId,

      telegram:
        result
    });

  }
);


// ============================================================
// TELEGRAM POST WEBHOOK
// ============================================================

app.post(
  '/telegram/:botId',
  async (req, res) => {

    console.log('');
    console.log(
      '🚨🚨🚨 TELEGRAM WEBHOOK RECEIVED 🚨🚨🚨'
    );

    console.log(
      '🆔 botId:',
      req.params.botId
    );

    console.log(
      '📦 body:',
      JSON.stringify(
        req.body,
        null,
        2
      )
    );


    // Respond immediately to Telegram
    res.sendStatus(200);


    try {

      const bot =
        getBot(req.params.botId);


      if (!bot) {

        console.log(
          '❌ Unknown bot:',
          req.params.botId
        );

        return;
      }


      const callback =
        req.body?.callback_query;


      // Ignore normal Telegram messages
      if (!callback) {

        console.log(
          'ℹ️ Update is not a callback query'
        );

        return;
      }


      console.log('');
      console.log(
        '🔘 CALLBACK RECEIVED'
      );

      console.log(
        'callback id:',
        callback.id
      );

      console.log(
        'callback data:',
        callback.data
      );


      // ------------------------------------------------------
      // SAFE TEST CALLBACK
      // ------------------------------------------------------

      if (
        callback.data ===
        'test_callback'
      ) {

        console.log(
          '✅ TEST CALLBACK SUCCESS'
        );


        await answerCallback(
          bot,
          callback.id,
          'Webhook is working ✅'
        );


        if (
          callback.message?.chat?.id &&
          callback.message?.message_id
        ) {

          await telegram(
            bot,
            'editMessageText',
            {
              chat_id:
                callback.message.chat.id,

              message_id:
                callback.message.message_id,

              text:
                '✅ <b>TEST CALLBACK RECEIVED</b>\n\nTelegram → Render → Express is working.',

              parse_mode:
                'HTML',

              reply_markup: {
                inline_keyboard: []
              }
            }
          );

        }


        return;
      }


      // ------------------------------------------------------
      // OTHER CALLBACKS
      // ------------------------------------------------------

      console.log(
        '⚠️ Callback is not the test callback.'
      );

      await answerCallback(
        bot,
        callback.id,
        'Callback received'
      );

    } catch (error) {

      console.error(
        '❌ Webhook processing error:',
        error.message
      );

    }

  }
);


// ============================================================
// START SERVER
// ============================================================

(async () => {

  console.log('');
  console.log(
    '🚀 Starting server...'
  );

  console.log(
    '🌐 DOMAIN:',
    DOMAIN
  );

  console.log(
    '🔌 PORT:',
    PORT
  );


  // Start HTTP server first
  // so Render is listening before Telegram
  // starts sending webhook requests.

  app.listen(
    PORT,
    async () => {

      console.log('');
      console.log(
        `🚀 Server listening on port ${PORT}`
      );

      console.log(
        '🌐 Public domain:',
        DOMAIN
      );


      await initializeWebhooks();

    }
  );

})();