# Klover Hospital — Roadmap

## 🗓️ THIS WEEK (June 25 – July 1, 2026)

### Telegram-native analytics
Use the existing Telegram notification channel as an event log — no database needed.

**Add 3 new event types to the notification bot:**
- `🎮 Level done` — player, chapter, level, score, coins earned, total coins
- `🔗 Referral` — who referred whom (fix: currently 0 referrals recorded out of 193 players)
- `🏆 Record` — Ch.3 Endless new high score

**Why:** weekly Telegram export + parser script → full funnel analytics (session → Ch.1 → Ch.2 → Ch.3, referral chains, coin economy). Zero infra cost.

**Files to change:**
- `api/save-user.js` — extend session notification; add `/api/event` endpoint
- `index.html` — call `/api/event` on level complete, referral use, new record

---

## 📺 Hospital TV (Adsgram rewarded video) — monetization

**SHIPPED 2026-07-03.** A dedicated in-app screen ("Hospital TV") where players
**voluntarily** watch rewarded video ads via [Adsgram](https://adsgram.ai/) (the
TON-native ad network for Telegram Mini Apps) in exchange for coins. Block ID
`37139`, plugged into `#screen-hospital-tv` (index.html).

**Why Adsgram:** native to Telegram/TON, payouts in TON/USDt-TON straight to the
wallet (TON Connect is already integrated), rewarded format has 20–40% CTR.

**Reality check on economics:** at ~200 total users the realistic revenue is
**~$2–75/mo** (back-of-envelope at ~$0.004/view). Not worth building real
infra for yet — so the reward path below is intentionally client-side, matching
how the rest of the game's coin/progress state already works (100% localStorage,
no Supabase, see `api/user.js`). Revisit server-side validation only once DAU
is high enough that fraud losses would actually matter (see SECURITY notes).

**What's implemented (client-side only, no new API endpoint):**
- Reward in-game value only — coins, diminishing per view: `200 → 150 → 100 → 75 → 50`.
- **Daily cap** 5 views/user, **cooldown** 90s between views — tracked in
  `localStorage` (`klover_htv_ad_state`), resets at local midnight.
- `AdController.show().then(...)` grants reward; `.catch(...)` (no fill / error)
  shows a toast, no reward, no cap/cooldown consumed.
- `Sync.sendEvent('ad_watched', ...)` fires into the existing Telegram analytics
  channel (`api/event.js`) so we can see real show volume before investing more.

**Stretch — own-content path:** alternate/replace Adsgram slots with videos from
the studio's own YouTube channel (cross-promo instead of ad revenue) — same
screen, same reward mechanic, zero extra backend. Not yet built; revisit if
Adsgram fill-rate is low or cross-promo value outweighs the ad $.

**Stretch — tournament tie-in:** each ad watched = 1 raffle ticket toward a
bi-weekly prize pool. Pool = a fixed % of actual Adsgram revenue for the cycle
(so we can never pay out more than we earn). Split prize between a skill
leaderboard (top players) and a raffle (everyone with tickets). **Blocked on**
server-authoritative scoring (see SECURITY) — needed once real money is at stake.

---

## Monetization phases (bigger picture)

1. **Adsgram rewarded video** (Hospital TV) — easiest, monetizes non-payers.
2. **XP + Season Pass** — progression + recurring reason to pay.
3. **Telegram Stars** — continue-for-Stars, coin packs, instant skin unlocks.
   Needs a server webhook (`successful_payment`) + `refundStarPayment` handling.
4. **TON Web3** — NFT skins / premium membership via the connected wallet.

Reality check: ads-only to ~$1–3k/mo needs ~3–10k DAU. Blending Stars hits the
same revenue at far lower DAU. Grow DAU first via referral loop + Telegram
catalogs + retention hooks (daily streak, push re-engagement).

---

## SECURITY blockers for any cash/leaderboard feature

Before ANY real-money reward (Stars payout, TON prize pool, cash leaderboard):
- **Server-authoritative scores.** `api/user.js` currently writes client-supplied
  `coins`/`high_score`; `high_score` has no upper cap. A spoofer with valid
  initData can post an arbitrary score → would steal a cash prize. Scores must be
  validated/derived server-side before they gate money.
- **Anti-sybil on referrals** (`api/referral-complete.js`) — multi-account farming
  is free on Telegram; fine for soft coins, not for cash.
- See the full audit handed over separately.
