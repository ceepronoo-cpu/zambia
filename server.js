require('dotenv').config();

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();

const PORT = process.env.PORT || 10000;
const DOMAIN = (process.env.BACKEND_URL || '').replace(/\/+$/, '');

const REQUIRED_UPDATES = [
  'message',
  'callback_query'
];


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
  console.warn(
    '⚠️ BACKEND_URL is not set.'
  );
}


// ============================================================
// BOTS
// ============================================================

const bots = [];

for (const key of Object.keys(process.env)) {

  const match = key.match(
    /^BOT(\d+)_TOKEN$/
  );

  if (!match) continue;

  const number = match[1];

  const token =
    process.env[`BOT${number}_TOKEN`];

  const chatId =
    process.env[`BOT${number}_CHATID`];

  if (token && chatId) {

    bots.push({
      botId: `bot${number}`,
      token,
      chatId
    });

  }
}

console.log('');
console.log('🤖 BOTS LOADED:');

if (bots.length === 0) {

  console.log('(none)');

} else {

  for (const bot of bots) {
    console.log(
      `   ✅ ${bot.botId}`
    );
  }

}

console.log('');


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
  {
    recursive: true
  }
);

const store = {
  requests: {}
};


function loadStore() {

  try {

    if (!fs.existsSync(STORE_FILE)) {
      console.log(
        '💾 No existing store found.'
      );
      return;
    }

    const raw =
      fs.readFileSync(
        STORE_FILE,
        'utf8'
      );

    const parsed =
      JSON.parse(raw);

    Object.assign(
      store.requests,
      parsed.requests || {}
    );

    console.log(
      '💾 Loaded',
      Object.keys(store.requests).length,
      'stored requests'
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
      JSON.stringify(
        store,
        null,
        2
      )
    );

  } catch (error) {

    console.error(
      '❌ Store save error:',
      error.message
    );

  }

}


loadStore();


// ============================================================
// HELPERS
// ============================================================

function getBot(botId) {

  return bots.find(
    bot => bot.botId === botId
  );

}


function newId() {

  return crypto
    .randomBytes(5)
    .toString('hex');

}


function clean(value) {

  return String(
    value == null
      ? ''
      : value
  )
    .replace(
      /[\u200B-\u200D\uFEFF]/g,
      ''
    )
    .trim();

}


function escapeHtml(value) {

  return String(
    value == null
      ? ''
      : value
  )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

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

    const response =
      await axios.post(
        `https://api.telegram.org/bot${bot.token}/${method}`,
        payload
      );

    return response.data;

  } catch (error) {

    console.error(
      `❌ Telegram ${method} error:`
    );

    console.error(
      error.response?.data ||
      error.message
    );

    return null;

  }

}


// ============================================================
// SEND MESSAGE
// ============================================================

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

      ...(keyboard
        ? {
            reply_markup: {
              inline_keyboard:
                keyboard
            }
          }
        : {})
    }
  );

}


// ============================================================
// ANSWER CALLBACK
// ============================================================

async function answerCallback(
  bot,
  callbackId,
  text
) {

  return telegram(
    bot,
    'answerCallbackQuery',
    {
      callback_query_id:
        callbackId,

      text:
        text || ''
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
    '🌐 SETTING WEBHOOK'
  );

  console.log(
    'Bot:',
    bot.botId
  );

  console.log(
    'URL:',
    webhookUrl
  );


  const result =
    await telegram(
      bot,
      'setWebhook',
      {
        url: webhookUrl,

        allowed_updates:
          REQUIRED_UPDATES,

        drop_pending_updates:
          false
      }
    );


  console.log(
    '📡 setWebhook response:'
  );

  console.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );


  if (!result?.ok) {

    console.error(
      `❌ WEBHOOK FAILED: ${bot.botId}`
    );

    return;

  }


  console.log(
    `✅ WEBHOOK REGISTERED: ${bot.botId}`
  );


  // ----------------------------------------------------------
  // Immediately check what Telegram has registered
  // ----------------------------------------------------------

  const info =
    await telegram(
      bot,
      'getWebhookInfo',
      {}
    );


  console.log(
    `🔎 WEBHOOK INFO FOR ${bot.botId}:`
  );

  console.log(
    JSON.stringify(
      info,
      null,
      2
    )
  );

}


// ============================================================
// INITIALIZE ALL WEBHOOKS
// ============================================================

async function initializeWebhooks() {

  console.log('');
  console.log(
    '========================================'
  );
  console.log(
    '🔧 INITIALIZING WEBHOOKS'
  );
  console.log(
    '========================================'
  );


  for (const bot of bots) {

    await setWebhook(bot);

  }


  console.log('');
  console.log(
    '✅ WEBHOOK INITIALIZATION FINISHED'
  );
  console.log('');

}


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  express.json()
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static('public')
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  '/health',
  (req, res) => {

    res.json({
      ok: true,

      domain: DOMAIN,

      bots:
        bots.map(
          bot => bot.botId
        )
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
      getBot(
        req.params.botId
      );

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

    console.log('');
    console.log(
      '🧪 TELEGRAM GET TEST'
    );

    console.log(
      'Bot:',
      req.params.botId
    );


    res.json({
      ok: true,

      route:
        `/telegram/${req.params.botId}`,

      message:
        'Webhook route is reachable'
    });

  }
);


// ============================================================
// WEBHOOK INFO TEST
// ============================================================

app.get(
  '/webhook-info/:botId',
  async (req, res) => {

    const bot =
      getBot(
        req.params.botId
      );


    if (!bot) {

      return res
        .status(404)
        .json({
          ok: false,

          error:
            'Unknown bot'
        });

    }


    console.log('');
    console.log(
      '🔎 MANUAL WEBHOOK INFO REQUEST'
    );

    console.log(
      'Bot:',
      bot.botId
    );


    const result =
      await telegram(
        bot,
        'getWebhookInfo',
        {}
      );


    console.log(
      JSON.stringify(
        result,
        null,
        2
      )
    );


    res.json(
      result || {
        ok: false,
        error:
          'Telegram request failed'
      }
    );

  }
);


// ============================================================
// TELEGRAM TEST MESSAGE
// ============================================================
//
// Open:
// /telegram-test/bot9
//
// This sends a harmless callback button.
// ============================================================

app.get(
  '/telegram-test/:botId',
  async (req, res) => {

    const bot =
      getBot(
        req.params.botId
      );


    if (!bot) {

      return res
        .status(404)
        .json({
          ok: false,

          error:
            'Unknown bot'
        });

    }


    console.log('');
    console.log(
      '🧪 CREATING CALLBACK TEST'
    );

    console.log(
      'Bot:',
      bot.botId
    );


    const result =
      await sendMessage(
        bot,

        '🧪 <b>Webhook callback test</b>\n\nClick the button below.',

        [
          [
            {
              text:
                'TEST CALLBACK',

              callback_data:
                'test_callback'
            }
          ]
        ]
      );


    console.log(
      '📨 TEST MESSAGE RESULT:'
    );

    console.log(
      JSON.stringify(
        result,
        null,
        2
      )
    );


    res.json({
      ok:
        result?.ok === true,

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
      '========================================'
    );
    console.log(
      '🚨 TELEGRAM WEBHOOK RECEIVED'
    );
    console.log(
      '========================================'
    );


    console.log(
      '🆔 Bot ID:',
      req.params.botId
    );


    console.log(
      '📦 Request body:'
    );


    console.log(
      JSON.stringify(
        req.body,
        null,
        2
      )
    );


    // ----------------------------------------------------------
    // IMPORTANT:
    // Telegram needs a quick HTTP 200 response.
    // ----------------------------------------------------------

    res.sendStatus(200);


    try {

      const bot =
        getBot(
          req.params.botId
        );


      if (!bot) {

        console.error(
          '❌ UNKNOWN BOT:',
          req.params.botId
        );

        return;

      }


      const callback =
        req.body?.callback_query;


      // --------------------------------------------------------
      // Ignore ordinary Telegram messages
      // --------------------------------------------------------

      if (!callback) {

        console.log(
          'ℹ️ Update contains no callback_query'
        );

        return;

      }


      console.log('');
      console.log(
        '========================================'
      );

      console.log(
        '🔘 CALLBACK QUERY RECEIVED'
      );

      console.log(
        '========================================'
      );


      console.log(
        'Callback ID:',
        callback.id
      );


      console.log(
        'Callback data:',
        callback.data
      );


      // --------------------------------------------------------
      // SAFE TEST CALLBACK
      // --------------------------------------------------------

      if (
        callback.data ===
        'test_callback'
      ) {

        console.log(
          '✅ TEST CALLBACK SUCCESS'
        );


        const answer =
          await answerCallback(
            bot,

            callback.id,

            'Webhook is working ✅'
          );


        console.log(
          '📡 answerCallback result:'
        );

        console.log(
          JSON.stringify(
            answer,
            null,
            2
          )
        );


        // ------------------------------------------------------
        // Edit the test message
        // ------------------------------------------------------

        if (
          callback.message?.chat?.id &&
          callback.message?.message_id
        ) {

          const editResult =
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


          console.log(
            '✏️ editMessageText result:'
          );

          console.log(
            JSON.stringify(
              editResult,
              null,
              2
            )
          );

        }


        return;

      }


      // --------------------------------------------------------
      // Any other callback
      // --------------------------------------------------------

      console.log(
        '⚠️ Unknown/test callback data:',
        callback.data
      );


      await answerCallback(
        bot,

        callback.id,

        'Callback received'
      );


    } catch (error) {

      console.error('');
      console.error(
        '❌ WEBHOOK PROCESSING ERROR'
      );

      console.error(
        error.stack ||
        error.message
      );

    }

  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  async () => {

    console.log('');
    console.log(
      '========================================'
    );

    console.log(
      `🚀 SERVER LISTENING ON PORT ${PORT}`
    );

    console.log(
      '🌐 DOMAIN:',
      DOMAIN
    );

    console.log(
      '========================================'
    );


    if (!DOMAIN) {

      console.error(
        '❌ BACKEND_URL is missing.'
      );

      return;

    }


    await initializeWebhooks();

  }
);