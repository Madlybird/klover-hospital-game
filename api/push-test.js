// One-off TEST broadcast. Hardcoded recipient list + fixed message so
// it can't be abused as an open broadcast tool. Sends a short teaser +
// a "play" Mini App button (no GIF). Safe to delete after use.

export const config = { maxDuration: 60 };

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const PUSH_TEXT = '🩷 Psst. Something new opened at the clinic.';

const RECIPIENTS = [
  94949077, 1343650209, 7202438438, 2133452507, 1260924167, 5307320541,
  409155307, 774584443, 732598648, 1771331434, 6818694588, 5693136429,
  1004645139, 6108347682, 1499301854, 6970579900, 5913860512, 306879508,
  379330457, 264154297, 614064165, 653553977, 7886533512, 786080766,
  750416265, 5167327900, 798788289, 1436864216, 876422083, 1936355542,
  8778600118, 406338059, 6803823540, 956153693, 75244491, 5257747965,
  5258024367, 881282443, 791036913, 6593483146,
];

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  if (!BOT_TOKEN) {
    return res.status(200).json({ ok: false, reason: 'bot_token_missing' });
  }

  // Dry-run probe: lets us confirm the new deploy is live WITHOUT
  // sending anything, so polling doesn't trigger the broadcast.
  const isDry = /(?:[?&])dry=1\b/.test(req.url || '') || req.query?.dry === '1';
  if (isDry) {
    return res.status(200).json({ ok: true, dry: true, ready: true, build: 'broadcast-v2' });
  }

  const host = baseUrl(req);
  const keyboard = {
    inline_keyboard: [[
      { text: '🏥 Open the clinic', web_app: { url: host + '/' } },
    ]],
  };

  const ids = [...new Set(RECIPIENTS)];
  const results = [];
  let sent = 0;
  let failed = 0;

  for (const id of ids) {
    const r = await tg('sendMessage', {
      chat_id: id,
      text: PUSH_TEXT,
      reply_markup: keyboard,
    });
    if (r && r.ok === true) {
      sent++;
      results.push({ id, ok: true });
    } else {
      failed++;
      results.push({ id, ok: false, error: r?.description || 'unknown' });
    }
    // Gentle throttle — stay well under Telegram's broadcast limits.
    await sleep(60);
  }

  return res.status(200).json({
    ok: true,
    total: ids.length,
    sent,
    failed,
    results,
  });
}
