// Telegram Bot webhook — runs on Vercel, receives updates from the
// Bot API and replies. Specifically handles /start [payload] by sending
// the game preview + a Mini App button. The payload is forwarded to the
// Mini App as ?startapp=<id>, which Game.detectReferral() already reads.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'kloverl_bot';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
// Set PUBLIC_URL in Vercel env. Example: https://klover-hospital-game.vercel.app
// If unset, falls back to the host header (fine for most deployments).
const PUBLIC_URL = process.env.PUBLIC_URL || '';

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    console.error('[tg]', method, 'failed:', data);
  }
  return data;
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `https://${host}` : '';
}

function welcomeCaption(referralId) {
  const base =
    'Time to treat yourself.\n\n' +
    'Play Klover Hospital with Nurse Mai — a quick medical puzzle to lift the mood.';
  if (referralId) return base + '\n\nA friend invited you — bonus rewards are waiting.';
  return base;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Simple health check so you can curl the endpoint in a browser.
    return res.status(200).json({ ok: true, tokenSet: !!BOT_TOKEN, publicUrl: baseUrl(req) });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!BOT_TOKEN) {
    console.error('[webhook] TELEGRAM_BOT_TOKEN missing');
    return res.status(500).json({ error: 'bot_token_missing' });
  }
  // Optional shared-secret check — set the same value as X-Telegram-Bot-Api-Secret-Token
  // when you register the webhook via setWebhook.
  if (WEBHOOK_SECRET) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== WEBHOOK_SECRET) return res.status(401).json({ error: 'bad_secret' });
  }

  const update = req.body || {};

  // ---- Inline mode: user picks a chat and the BOT composes the
  // message (animated GIF + formatted caption with an embedded link
  // + button). The inviter is the referrer, so the start payload is
  // their own Telegram id (from.id), independent of what they typed.
  if (update.inline_query) {
    const iq = update.inline_query;
    const refId = String(iq.from?.id || '').replace(/[^\d]/g, '');
    const host = baseUrl(req);
    const gifUrl = host + '/assets/pushes/refferal.gif';
    const startLink = `https://t.me/${BOT_USERNAME}?start=${refId}`;
    const caption =
      '🏥 <b>Klover Hospital</b> — pill puzzle with Nurse Mai.\n' +
      'Play a quick round with me 👇\n' +
      `<a href="${startLink}">Tap to start your treatment</a>`;

    const results = [{
      type: 'gif',
      id: 'invite_' + (refId || 'x'),
      gif_url: gifUrl,
      thumbnail_url: gifUrl,
      caption,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: '🎮 Play Klover Hospital', url: startLink },
        ]],
      },
    }];

    await tg('answerInlineQuery', {
      inline_query_id: iq.id,
      results,
      cache_time: 1,
      is_personal: true,
    });
    return res.status(200).json({ ok: true, inline: true, refId: refId || null });
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.chat || !msg.text) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  const chatId = msg.chat.id;
  const match = /^\/start(?:@[\w_]+)?(?:\s+(\S+))?/.exec(msg.text || '');
  if (!match) {
    return res.status(200).json({ ok: true, unhandled: true });
  }

  const referralRaw = (match[1] || '').trim();
  const referralId = /^\d+$/.test(referralRaw) ? referralRaw : '';

  const host = baseUrl(req);
  // Forward the referral id through the Mini App URL so
  // Game.detectReferral() captures it as start_param.
  const webAppUrl = host + (referralId ? `/?startapp=${referralId}` : '/');
  const gifUrl = host + '/assets/pushes/refferal.gif';

  const keyboard = {
    inline_keyboard: [[
      { text: 'Start treatment', web_app: { url: webAppUrl } },
    ]],
  };

  // Send the animated GIF as an animation; if Telegram can't fetch it
  // (not deployed yet, too large, etc.) fall back to a plain sendMessage
  // so the welcome still works.
  const animRes = await tg('sendAnimation', {
    chat_id: chatId,
    animation: gifUrl,
    caption: welcomeCaption(referralId),
    reply_markup: keyboard,
  });
  if (!animRes.ok) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: welcomeCaption(referralId),
      reply_markup: keyboard,
    });
  }

  return res.status(200).json({ ok: true, referralId: referralId || null });
}
