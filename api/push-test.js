// One-off TEST push. Hardcoded to a single recipient so it can't be
// abused to broadcast. Sends the referral GIF + a short teaser + a
// "play" Mini App button. Safe to delete after testing.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || '';

// Fixed test recipient — do not parameterize.
const TARGET_CHAT_ID = 881282443;
const PUSH_TEXT = '🩷 Psst. Something new opened at the clinic.';

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `https://${host}` : '';
}

export default async function handler(req, res) {
  if (!BOT_TOKEN) {
    return res.status(200).json({ ok: false, reason: 'bot_token_missing' });
  }

  const host = baseUrl(req);
  const gifUrl = host + '/assets/pushes/refferal.gif';
  const webAppUrl = host + '/';
  const keyboard = {
    inline_keyboard: [[
      { text: '🏥 Open the clinic', web_app: { url: webAppUrl } },
    ]],
  };

  // Try the GIF first; fall back to a plain text message so the push
  // still lands if Telegram can't fetch the 9 MB animation.
  const anim = await tg('sendAnimation', {
    chat_id: TARGET_CHAT_ID,
    animation: gifUrl,
    caption: PUSH_TEXT,
    reply_markup: keyboard,
  });

  let fallback = null;
  if (!anim || anim.ok !== true) {
    fallback = await tg('sendMessage', {
      chat_id: TARGET_CHAT_ID,
      text: PUSH_TEXT,
      reply_markup: keyboard,
    });
  }

  return res.status(200).json({
    ok: true,
    target: TARGET_CHAT_ID,
    animation_ok: anim?.ok === true,
    animation_error: anim?.ok === true ? null : (anim?.description || anim),
    fallback_ok: fallback ? fallback.ok === true : null,
  });
}
