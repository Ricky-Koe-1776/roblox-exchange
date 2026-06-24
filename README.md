# Roblox Exchange

Safe P2P item trading for gifting-only Roblox games (no native trade window) —
**robloxexchange.com**. Deposit items, trade with on-site escrow, withdraw. No
"you gift first" middleman scams.

First game: **Grow a Garden**. Built multi-game from day one (Steal a Brainrot
seeded too). Standalone from the RoFlips network (own DB, own auth).

## How trading works (anti-scam core)

- **Post a trade** → the items you offer are moved into **escrow** (deducted from
  your inventory) so you can't double-spend them while the ad is live.
- **Accept a trade** → atomic swap: your requested items go to the seller, the
  escrowed items come to you. Either it all happens or none of it does.
- **Cancel** → escrow releases back to you.

## Auth

Roblox **bio-verify** — we generate a phrase, you paste it into your Roblox
profile bio, we read the bio via the public Roblox API to confirm ownership. No
password is ever handled. (Same pattern as the RoFlips sites.)

## Layout

```
api/[...path].js   Production API — Vercel serverless + Neon Postgres (real bio-verify)
server.mjs         Local dev server — in-memory, seeded demo data, bio-check bypassed
public/            Static SPA (index.html + app.js), no build step
vercel.json        Routes /api/* to the function, serves public/ statically
```

`api/[...path].js` and `server.mjs` share the same game catalog and route shape;
the serverless function is the source of truth for production.

## Run locally

```bash
npm install
npm run dev        # http://localhost:8088
```

Log in as `ricky`, `bloxtrader`, or `gardenking` (seeded with items). Any new
username is auto-seeded so the demo stays alive. Local mode skips the real bio
check — just click Verify.

## Deploy to robloxexchange.com (Vercel + Neon)

1. **Neon** — create a project, copy the connection string.
2. **Vercel** — `vercel` (or import the repo). Set env var:
   - `POSTGRES_URL` = the Neon connection string
   Tables auto-create on first request (`ensureInit`).
3. **Domain** — add `robloxexchange.com` in Vercel → Project → Domains, then at
   your registrar point the apex `A` record (and `www` CNAME) to Vercel as shown.
4. Visit the domain; the real Roblox bio-verify flow is active in production.

## Not built yet (next)

- **Deposits / withdrawals** — the automated gifting-bot custody layer. New
  production users start with an empty inventory until the bot grants items. The
  bot will call the same `addItem` / `removeItem` primitives in `api/[...path].js`
  (add `/bot/deposit` + `/bot/pending-withdrawals` like growagardenflips has).
- Counter-offers (negotiate instead of straight accept).
- Per-game value-list ingestion (currently a hardcoded catalog).
