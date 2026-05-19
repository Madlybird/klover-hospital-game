// Telegram Bot webhook — runs on Vercel, receives updates from the
// Bot API and replies. Handles /start [payload] by sending a short
// welcome + a Mini App button. The payload is forwarded to the Mini
// App as ?startapp=<id>, which Game.detectReferral() reads for the
// referral program.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
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

function welcomeText(referralId) {
  const base =
    'Time to treat yourself.\n\n' +
    'Play Klover Hospital with Nurse Mai — a quick medical puzzle to lift the mood.';
  if (referralId) return base + '\n\nA friend invited you — tap below to start.';
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

  const keyboard = {
    inline_keyboard: [[
      { text: 'Start treatment', web_app: { url: webAppUrl } },
    ]],
  };

  await tg('sendMessage', {
    chat_id: chatId,
    text: welcomeText(referralId),
    reply_markup: keyboard,
  });

  return res.status(200).json({ ok: true, referralId: referralId || null });
}
