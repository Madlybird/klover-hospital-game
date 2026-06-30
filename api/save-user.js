import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID || '';
const ADMIN_SECRET = process.env.ADMIN_DEBUG_SECRET || '';

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

// Fire-and-forget notify the admin channel that a user opened the app.
// Called once per session (client already gates with sessionStorage).
async function notifyChannel(user, referredBy, supabaseStatus, extra) {
  if (!REPORT_CHAT_ID || !BOT_TOKEN) return;
  const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

  const platEmoji = { ios: '🍎', android: '🤖', android_x: '🤖', macos: '💻', tdesktop: '💻', weba: '💻', web: '💻', webk: '💻' };
  const plat = extra?.platform ? (platEmoji[extra.platform] || '📱') + ' ' + extra.platform : '';
  const premium = user.is_premium ? ' ⭐' : '';
  const isNew = extra?.isNew;

  const lines = [
    (isNew ? '🆕 <b>New player</b>' : '🔁 <b>Session</b>') + (plat ? ' · ' + plat : '') + premium,
    `<code>${esc(user.id)}</code>` +
      (user.username ? ` · @${esc(user.username)}` : '') +
      (user.first_name ? ` · ${esc(user.first_name)}` + (user.last_name ? ' ' + esc(user.last_name) : '') : '') +
      (user.language_code ? ` · ${esc(user.language_code).toUpperCase()}` : ''),
  ];
  if (referredBy) lines.push(`↳ реф от <code>${esc(referredBy)}</code>`);
  if (extra?.coins != null || extra?.highScore != null) {
    const parts = [];
    if (extra.coins != null) parts.push(`${Number(extra.coins).toLocaleString('ru-RU')}🪙`);
    if (extra.highScore != null && extra.highScore > 0) parts.push(`🏆 ${Number(extra.highScore).toLocaleString('ru-RU')}`);
    if (parts.length) lines.push(parts.join('  ·  '));
  }
  // db status intentionally not shown — only matters for backend health
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: REPORT_CHAT_ID,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        disable_notification: true,
      }),
    });
  } catch (e) {
    console.warn('[save-user] notify channel failed:', e.message);
  }
}

// Admin diagnostic: ask Telegram whether the bot can actually post to the
// configured report channel. Surfaces the three real failure modes — env not
// set, chat id stale/migrated, or bot not a member/admin of the channel.
async function probeChannel() {
  if (!BOT_TOKEN) return { ok: false, reason: 'bot_token_missing' };
  if (!REPORT_CHAT_ID) return { ok: false, reason: 'report_chat_id_unset' };
  const call = async (method, qs) => {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}${qs || ''}`);
      return await r.json();
    } catch (e) { return { ok: false, description: e.message }; }
  };
  const me = await call('getMe');
  const botId = me?.result?.id;
  const chat = await call('getChat', `?chat_id=${encodeURIComponent(REPORT_CHAT_ID)}`);
  const member = botId
    ? await call('getChatMember', `?chat_id=${encodeURIComponent(REPORT_CHAT_ID)}&user_id=${botId}`)
    : { ok: false, description: 'no_bot_id' };
  return {
    report_chat_id: REPORT_CHAT_ID,
    bot: me?.result?.username ? `@${me.result.username}` : (me?.description || 'unknown'),
    chat_reachable: !!chat?.ok,
    chat_title: chat?.result?.title || null,
    chat_error: chat?.ok ? null : chat?.description || null,
    bot_status: member?.result?.status || null,
    member_error: member?.ok ? null : member?.description || null,
    can_post: !!chat?.ok && ['administrator', 'creator', 'member'].includes(member?.result?.status),
  };
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

function hmacCheck(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no_hash' };
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (computed !== hash) return { ok: false, reason: 'bad_hmac' };
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate) return { ok: false, reason: 'no_auth_date' };
  if (Date.now() / 1000 - authDate > 86400) return { ok: false, reason: 'stale' };
  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, reason: 'no_user_param' };
  try { return { ok: true, user: JSON.parse(userRaw) }; }
  catch { return { ok: false, reason: 'bad_user_json' }; }
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Diagnostics disclose which env vars are configured — admin only.
    const provided = req.headers['x-admin-secret'] || req.query?.secret || '';
    if (!ADMIN_SECRET || !safeEqual(provided, ADMIN_SECRET)) {
      return res.status(200).json({ ok: true });
    }
    const channel = await probeChannel();
    return res.status(200).json({
      ok: true,
      env: {
        SUPABASE_URL: !!SUPABASE_URL,
        SUPABASE_SERVICE_KEY: !!SUPABASE_SERVICE_KEY,
        TELEGRAM_BOT_TOKEN: !!BOT_TOKEN,
        REPORT_CHAT_ID: !!REPORT_CHAT_ID,
      },
      supabase_client: !!supabase,
      channel_notify: !!REPORT_CHAT_ID,
      channel,
      build: 'save-user v5 (channel probe)',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate user even when storage is degraded — useful telemetry
  if (!BOT_TOKEN) {
    return res.status(200).json({ ok: true, degraded: 'bot_token_missing' });
  }
  const initData = req.headers['telegram-init-data'] || req.headers['x-telegram-init-data'];
  if (!initData) return res.status(200).json({ ok: true, degraded: 'no_init_data' });
  const verdict = hmacCheck(initData, BOT_TOKEN);
  if (!verdict.ok) {
    return res.status(200).json({ ok: true, degraded: 'verify_failed', reason: verdict.reason });
  }
  const user = verdict.user;
  if (!user?.id) return res.status(200).json({ ok: true, degraded: 'no_user_id' });

  const body = readBody(req);
  const referredBy = Number.isFinite(body.referredBy) ? Math.floor(body.referredBy) : null;
  const platform = typeof body.platform === 'string' ? body.platform.slice(0, 32) : null;

  // If Supabase isn't configured (or unreachable), don't 500 — the
  // game's core flow doesn't need it. Still notify the admin channel
  // so user IDs are captured regardless of DB status.
  if (!supabase) {
    console.log('[save-user] supabase unavailable — skipping persistence for', user.id);
    await notifyChannel(user, referredBy, 'unconfigured', { platform, isNew: true });
    return res.status(200).json({ ok: true, degraded: 'supabase_unconfigured', user: { telegram_id: user.id } });
  }

  const row = {
    telegram_id: user.id,
    username: (user.username || user.first_name || '').slice(0, 50),
  };
  if (user.first_name) row.first_name = String(user.first_name).slice(0, 64);
  if (user.last_name) row.last_name = String(user.last_name).slice(0, 64);
  if (user.language_code) row.language_code = String(user.language_code).slice(0, 8);
  if (referredBy && referredBy !== user.id) row.referred_by = referredBy;

  try {
    let { data, error } = await supabase
      .from('users')
      .upsert(row, { onConflict: 'telegram_id', ignoreDuplicates: false })
      .select('telegram_id, username, coins, high_score, created_at')
      .single();

    if (error && /column|does not exist|schema/i.test(error.message)) {
      const minimal = { telegram_id: row.telegram_id, username: row.username };
      if (row.referred_by) minimal.referred_by = row.referred_by;
      ({ data, error } = await supabase
        .from('users')
        .upsert(minimal, { onConflict: 'telegram_id', ignoreDuplicates: false })
        .select('telegram_id, username, created_at')
        .single());
    }

    if (error) {
      console.warn('[save-user] supabase error (soft):', error.message);
      await notifyChannel(user, referredBy, 'db_error', { platform });
      return res.status(200).json({ ok: true, degraded: 'db_error', message: error.message, user: { telegram_id: user.id } });
    }
    const isNew = data?.created_at
      ? (Date.now() - new Date(data.created_at).getTime()) < 60_000
      : false;
    await notifyChannel(user, referredBy, 'ok', {
      platform,
      isNew,
      coins: data?.coins ?? null,
      highScore: data?.high_score ?? null,
    });
    return res.status(200).json({ ok: true, user: data });
  } catch (e) {
    // Network/DNS errors when Supabase is gone — soft-fail
    console.warn('[save-user] supabase unreachable (soft):', e.message);
    await notifyChannel(user, referredBy, 'unreachable');
    return res.status(200).json({ ok: true, degraded: 'supabase_unreachable', user: { telegram_id: user.id } });
  }
}
