# RIK ANIMATION Puyo Game

A Telegram Mini App puzzle game inspired by Puyo Pop Fever mechanics, built for RIK ANIMATION studio (rik.studio).

## How to Play

- Swipe left/right to move falling blob pairs
- Tap to rotate the pair
- Swipe down to fast drop
- Match 4 or more same-color blobs to clear them
- Chain clears for massive combo bonuses

## How to Test in Telegram

### Step 1: Set up BotFather

1. Open Telegram and search for `@BotFather`
2. Send `/newbot` and follow the prompts to create a bot
3. Save your bot token (format: `123456:ABC-DEF...`)
4. Send `/newapp` to BotFather
5. Select your bot, then provide:
   - App title: `RIK Puzzle Game`
   - Description: `Puyo-style puzzle game by RIK ANIMATION`
   - Photo: upload any square image
   - GIF: skip with `-`
   - URL: your ngrok URL (see below)
   - Short name: `rikgame`

### Step 2: Expose local server with ngrok

1. Install ngrok: https://ngrok.com/download
2. Serve the project locally:
   ```bash
   # Using Python (no install needed)
   python -m http.server 8080
   # OR using Node
   npx serve .
   ```
3. In a new terminal, expose the server:
   ```bash
   ngrok http 8080
   ```
4. Copy the `https://xxxx.ngrok.io` URL
5. Paste it into BotFather's Web App URL field

### Step 3: Launch the Mini App

1. Open your bot in Telegram
2. Click the menu button or send `/start`
3. The game will open as a Mini App

### Step 4: Test on mobile

- Use Telegram on your phone for authentic touch controls
- Or use Telegram Desktop with browser DevTools in mobile mode

---

## GitHub Setup

```bash
git remote add origin https://github.com/USERNAME/rik-puyo-game.git
git branch -M main
git push -u origin main
```

Replace `USERNAME` with your GitHub username.

---

## Tech Stack

- Single-file HTML5 app (index.html)
- HTML5 Canvas game grid
- Telegram Web App SDK
- TON Connect UI
- Google Fonts: Barlow Condensed
- No frameworks, no build tools

## Project Structure

```
rik-puyo-game/
├── index.html               # Complete game, all screens
├── tonconnect-manifest.json # TON Connect configuration
├── .gitignore
├── README.md
└── assets/
    ├── character/           # Rik mascot poses
    │   ├── rik_idle.jpg
    │   ├── rik_walk.jpg
    │   ├── rik_tablet.jpg
    │   ├── rik_machine.jpg
    │   ├── rik_fly.jpg
    │   ├── rik_books.jpg
    │   ├── rik_eating.jpg
    │   ├── rik_teddy.jpg
    │   └── rik_shocked.jpg
    ├── brand/               # Logo and icon
    │   ├── logo_white.png
    │   ├── logo_pink.png
    │   └── icon.png
    └── sounds/              # Audio (Web Audio API placeholders)
```

## Backend (Supabase + Vercel API)

Secure player progress sync. The frontend never talks to Supabase directly
— all writes go through `api/user.js`, which verifies Telegram `initData`
HMAC against the bot token before touching the database.

### Required Vercel env vars

| Name                    | Where it comes from |
|-------------------------|---------------------|
| `TELEGRAM_BOT_TOKEN`    | `@BotFather`        |
| `SUPABASE_URL`          | Supabase → Project Settings → API (Project URL) |
| `SUPABASE_SERVICE_KEY`  | Supabase → Project Settings → API (`service_role` — **never commit**) |

Set these in Vercel → Project → Settings → Environment Variables for
Production + Preview + Development, then redeploy.

### Supabase table

```sql
create table if not exists public.users (
  telegram_id bigint primary key,
  username    varchar(50),
  coins       integer default 100,
  high_score  integer default 0,
  referred_by bigint references public.users(telegram_id) on delete set null,
  created_at  timestamptz default now()
);
alter table public.users enable row level security;
-- No anon policies needed: all access is via service key from the API.
```

### API

- `GET  /api/user` → returns the caller's row (creates if missing). Requires
  header `telegram-init-data: <WebApp.initData>`.
- `POST /api/user` body `{ coins?, highScore?, referredBy? }` → upserts.
  `high_score` is always `max(db, client)`; `coins` trust the client
  (capped at 10M) so skin purchases can decrement.
- `POST /api/save-user` → minimal first-visit capture for future
  broadcasts. Upserts `telegram_id`, `username`, and (if the columns
  exist) `first_name`, `last_name`, `language_code`. Called once per
  session from the client.

### Optional columns for broadcast personalization

```sql
alter table public.users
  add column if not exists first_name    varchar(64),
  add column if not exists last_name     varchar(64),
  add column if not exists language_code varchar(8);
```

Not required — `save-user` auto-falls back to the minimal row if these
columns aren't present.

## Version

v0.2.0 - Klover Hospital reskin + backend
