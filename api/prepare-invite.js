// Prepares a shareable invite message via Telegram Bot API 8.0
// savePreparedInlineMessage. The Mini App then calls
// Telegram.WebApp.shareMessage(<id>) so the user can send a clean
// message with the referral link EMBEDDED in the text (HTML <a>),
// instead of a raw URL pasted by the share dialog.

import crypto from 'node:crypto';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME || 'kloverl_bot';

function hmacCheck(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return { ok: false };
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return { ok: false };
  const userRaw = params.get('user');
  if (!userRaw) return { ok: false };
  try { return { ok: true, user: JSON.parse(userRaw) }; } catch { return { ok: false }; }
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!BOT_TOKEN) {
    return res.status(200).json({ ok: false, reason: 'bot_token_missing' });
  }
  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  const verdict = hmacCheck(initData, BOT_TOKEN);
  if (!verdict.ok || !verdict.user?.id) {
    return res.status(200).json({ ok: false, reason: 'verify_failed' });
  }

  const refId = String(verdict.user.id).replace(/[^\d]/g, '');
  const startLink = `https://t.me/${BOT_USERNAME}?start=${refId}`;
  const messageText =
    '🏥 <b>Klover Hospital</b> — a quick pill-puzzle with Nurse Mai.\n' +
    `Play a round with me 👉 <a href="${startLink}">tap here to join</a>`;

  const result = {
    type: 'article',
    id: 'inv_' + refId,
    title: 'Invite a friend to Klover Hospital',
    description: 'Send your referral invite',
    input_message_content: {
      message_text: messageText,
      parse_mode: 'HTML',
      // We want the embedded link visible as text, no big preview card.
      link_preview_options: { is_disabled: true },
    },
    reply_markup: {
      inline_keyboard: [[{ text: '🎮 Play Klover Hospital', url: startLink }]],
    },
  };

  const r = await tg('savePreparedInlineMessage', {
    user_id: verdict.user.id,
    result,
    allow_user_chats: true,
    allow_group_chats: true,
    allow_channel_chats: true,
    allow_bot_chats: false,
  });

  if (!r || r.ok !== true || !r.result?.id) {
    return res.status(200).json({ ok: false, reason: 'prepare_failed', tg: r });
  }
  return res.status(200).json({ ok: true, id: r.result.id });
}
