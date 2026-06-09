# Klover Hospital — Roadmap

## 📺 Hospital TV (Adsgram rewarded video) — monetization

A dedicated in-app screen ("Hospital TV") where players **voluntarily** watch
rewarded video ads via [Adsgram](https://adsgram.ai/) (the TON-native ad network
for Telegram Mini Apps) in exchange for in-game rewards.

**Why Adsgram:** native to Telegram/TON, payouts in TON/USDt-TON straight to the
wallet (TON Connect is already integrated), rewarded format has 20–40% CTR.

**Design (must-haves):**
- Reward in-game value only — **coins / lives / bombs**, NOT withdrawable cash
  (cash-per-view = negative margin + fraud magnet; we earn ~$0.004/view).
- **Daily cap** ~5–10 views/user (Adsgram fill-rate + anti-fraud also self-limit).
- **Diminishing reward** per view (e.g. 200 → 150 → 100 coins) to kill spam and
  lift retention instead of wrecking the economy.
- **Cooldown** 60–120s between views.
- Server-side reward grant (validate the watch event) — never trust the client
  for anything that maps to money. (See SECURITY notes below.)

**Integration sketch:**
1. Register the mini-app in Adsgram → get `Block ID`.
2. Load Adsgram SDK (`sad.min.js`) in `index.html`.
3. New screen `#screen-hospital-tv` + menu button.
4. `AdController.show()` → on success callback, call a server endpoint that
   grants the reward (rate-limited, capped, idempotent).

**Stretch — tournament tie-in:** each ad watched = 1 raffle ticket toward a
bi-weekly prize pool. Pool = a fixed % of actual Adsgram revenue for the cycle
(so we can never pay out more than we earn). Split prize between a skill
leaderboard (top players) and a raffle (everyone with tickets). **Blocked on**
server-authoritative scoring (see SECURITY).

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
