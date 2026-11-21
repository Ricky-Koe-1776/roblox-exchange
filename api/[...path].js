// Roblox Exchange — production API (Vercel serverless + Neon Postgres).
//
// robloxexchange.com is a marketplace for buying and selling whole Roblox
// games (via Roblox group-ownership transfer), paid in USDC through Apirone.
// Login is Roblox bio verification (same flow RoFlips used): the user asks
// for a code, pastes "RE: <words>" into their Roblox profile About section,
// and the server reads it back from users.roblox.com. That verified Roblox
// account IS the login, so there is no separate "connect Roblox" step.
//
// Order completion is MANUAL: an admin confirms the Roblox group ownership
// actually transferred to the buyer before releasing the seller's payout.
// There is no automated Roblox-ownership poller.
//
// Routes (all under /api):
//   POST /roblox/challenge {username}        -> issues an "RE: ..." bio code (10 min)
//   POST /roblox/verify    {username}        -> checks the bio, sets session cookie
//   GET  /me                                 current user or null
//   POST /logout
//   GET  /marketplace/listings               active listings
//   GET  /marketplace/listings/:id           listing detail
//   POST /marketplace/listings               create listing (verifies group ownership)
//   POST /marketplace/listings/:id/cancel    seller removes their own listing
//   POST /marketplace/listings/:id/buy       creates an order + Apirone invoice
//   GET  /marketplace/orders/:id             order detail (buyer/seller/admin)
//   POST /marketplace/orders/:id/check-payment
//   POST /marketplace/orders/:id/cancel      buyer cancels before paying
//   GET  /marketplace/orders?box=buying|selling
//   GET  /marketplace/admin/orders           admin: paid orders awaiting finalization
//   POST /marketplace/orders/:id/finalize    admin: release seller payout
//   POST /marketplace/apirone/callback       Apirone payment webhook
//   GET  /marketplace/wallet                 balance + ledger
//   POST /marketplace/wallet/withdraw        request payout to an address

import { neon } from '@neondatabase/serverless'
import crypto from 'crypto'
import { createInvoice, getInvoiceStatus } from '../lib/apirone.mjs'

const sql = neon(process.env.POSTGRES_URL)
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean)


// ── Schema bootstrap ──────────────────────────────────────────────────────────
let _initDone = false
async function ensureInit() {
  if (_initDone) return
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      roblox_id  TEXT UNIQUE,
      avatar_url TEXT,
      role       TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_game_listings (
      id              TEXT PRIMARY KEY,
      seller_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seller_username TEXT NOT NULL,
      group_id        TEXT NOT NULL,
      place_id        TEXT NOT NULL,
      universe_id     TEXT NOT NULL,
      title           TEXT NOT NULL,
      description     TEXT DEFAULT '',
      price_usdc      NUMERIC NOT NULL,
      ccu             INTEGER DEFAULT 0,
      visits          BIGINT DEFAULT 0,
      favorites       INTEGER DEFAULT 0,
      thumbnail_url   TEXT,
      status          TEXT NOT NULL DEFAULT 'active',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_game_orders (
      id                TEXT PRIMARY KEY,
      listing_id        TEXT NOT NULL REFERENCES rex_game_listings(id) ON DELETE CASCADE,
      buyer_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      buyer_username    TEXT NOT NULL,
      buyer_roblox_id   TEXT NOT NULL,
      seller_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      seller_username   TEXT NOT NULL,
      price_usdc        NUMERIC NOT NULL,
      invoice_id        TEXT,
      pay_address       TEXT,
      status            TEXT NOT NULL DEFAULT 'awaiting_payment',
      paid_at           TIMESTAMPTZ,
      transfer_deadline TIMESTAMPTZ,
      completed_at      TIMESTAMPTZ,
      cancelled_at      TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_wallet_ledger (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      amount_usdc NUMERIC NOT NULL,
      order_id    TEXT,
      to_address  TEXT,
      status      TEXT NOT NULL DEFAULT 'completed',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT` // safety net for pre-existing tables
  // Imported listings: where the game is sourced from, for fulfillment. Never sent to the public API.
  await sql`ALTER TABLE rex_game_listings ADD COLUMN IF NOT EXISTS source TEXT`
  await sql`ALTER TABLE rex_game_listings ADD COLUMN IF NOT EXISTS source_listing_id TEXT`
  await sql`ALTER TABLE rex_game_listings ADD COLUMN IF NOT EXISTS source_url TEXT`
  await sql`ALTER TABLE rex_game_listings ADD COLUMN IF NOT EXISTS source_price_usdc NUMERIC`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS rex_listings_source_uq ON rex_game_listings (source, source_listing_id)`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_roblox_challenges (
      username   TEXT PRIMARY KEY,
      phrase     TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )`
  _initDone = true
}

// ── Roblox lookups ────────────────────────────────────────────────────────────
async function fetchAvatarUrl(robloxId) {
  try {
    const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`)
    const data = await res.json()
    return data?.data?.[0]?.imageUrl || null
  } catch { return null }
}
async function fetchGroupInfo(groupId) {
  try {
    const res = await fetch(`https://groups.roblox.com/v1/groups/${groupId}`)
    if (!res.ok) return null
    const data = await res.json()
    return { name: data?.name || '', ownerId: data?.owner?.userId ? String(data.owner.userId) : null }
  } catch { return null }
}
async function fetchUniverseFromPlace(placeId) {
  try {
    const res = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`)
    if (!res.ok) return null
    const data = await res.json()
    return data?.universeId ? String(data.universeId) : null
  } catch { return null }
}
async function fetchGameStats(universeId) {
  try {
    const res = await fetch(`https://games.roblox.com/v1/games?universeIds=${universeId}`)
    if (!res.ok) return null
    const g = (await res.json())?.data?.[0]
    if (!g) return null
    return { ccu: g.playing || 0, visits: g.visits || 0, favorites: g.favoritedCount || 0 }
  } catch { return null }
}
async function fetchGameThumbnail(universeId) {
  try {
    const res = await fetch(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&size=512x512&format=Png`)
    const data = await res.json()
    return data?.data?.[0]?.imageUrl || null
  } catch { return null }
}
function isAdmin(u) { return u?.role === 'admin' }
// Strip internal sourcing fields before a listing leaves the server.
function publicListing(row) {
  if (!row) return row
  const { source, source_listing_id, source_url, source_price_usdc, ...rest } = row
  return rest
}

// ── Cookies / sessions ────────────────────────────────────────────────────────
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map((p) => [p[0], decodeURIComponent(p[1] || '')]))
}
function setCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`
}
async function sessionUser(req) {
  const sid = parseCookies(req.headers.cookie || '').rex_sid
  if (!sid) return null
  const rows = await sql`SELECT u.id, u.username, u.role, u.roblox_id, u.avatar_url FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=${sid}`
  return rows[0] || null
}

// ── Roblox bio verification ───────────────────────────────────────────────────
const WORDS = [
  'apple','brave','cloud','dance','eagle','flame','grape','honey','ivory','jelly','karma','lemon',
  'maple','noble','ocean','pearl','queen','river','storm','tiger','vivid','waltz','amber','blaze',
  'crisp','delta','ember','frost','glide','lunar','merit','oasis','pixel','relic','swift','topaz',
  'vigor','whirl','brisk','crest','drift','epoch','flare','glint','heron','jewel','lyric','zebra',
]
function generatePhrase() {
  const w = []
  for (let i = 0; i < 6; i++) w.push(WORDS[crypto.randomInt(WORDS.length)])
  return `RE: ${w.join(' ')}`
}
function normalizeBio(s) {
  return String(s || '').normalize('NFC')
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff\u2002\u2003\u2009\u202f\u3000]/g, ' ')
    .replace(/[\uff1a]/g, ':')
    .replace(/\s+/g, ' ').trim().toLowerCase()
}
async function lookupRobloxUser(username) {
  try {
    const r = await fetch('https://users.roblox.com/v1/usernames/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }),
    })
    const d = (await r.json())?.data?.[0]
    return d ? { id: String(d.id), name: d.name } : null
  } catch { return null }
}
async function fetchRobloxBio(robloxId) {
  try {
    const d = await (await fetch(`https://users.roblox.com/v1/users/${robloxId}`)).json()
    if (d?.description) return d.description
  } catch {}
  // The API returns an empty description for some accounts; fall back to the profile page meta tag.
  try {
    const html = await (await fetch(`https://www.roblox.com/users/${robloxId}/profile`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text()
    return html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/)?.[1] || ''
  } catch { return '' }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.status = (c) => { res.statusCode = c; return res }
  const json = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); return res }
  res.clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()

  const url = new URL(req.url, `https://${req.headers.host}`)
  const path = url.pathname.replace(/^\/api/, '') || '/'
  const method = req.method.toUpperCase()

  if (method === 'POST' && req.body === undefined) {
    req.body = await new Promise((resolve) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
    })
  }

  try {
    await ensureInit()
    let m

    // --- Roblox bio verification login ---
    if (path === '/roblox/challenge' && method === 'POST') {
      const name = String(req.body?.username || '').trim()
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return res.status(400) && json({ error: 'Enter your Roblox username.' })
      const key = name.toLowerCase()
      const phrase = generatePhrase()
      await sql`
        INSERT INTO rex_roblox_challenges (username, phrase, expires_at) VALUES (${key}, ${phrase}, NOW() + INTERVAL '10 minutes')
        ON CONFLICT (username) DO UPDATE SET phrase=${phrase}, expires_at=NOW() + INTERVAL '10 minutes'`
      return json({ phrase })
    }
    if (path === '/roblox/verify' && method === 'POST') {
      const name = String(req.body?.username || '').trim()
      const key = name.toLowerCase()
      const ch = (await sql`SELECT phrase FROM rex_roblox_challenges WHERE username=${key} AND expires_at > NOW()`)[0]
      if (!ch) return res.status(400) && json({ error: 'That code expired. Get a new one and try again.' })
      const rbx = await lookupRobloxUser(name)
      if (!rbx) return res.status(400) && json({ error: 'No Roblox account with that username.' })
      const bio = await fetchRobloxBio(rbx.id)
      if (!normalizeBio(bio).includes(normalizeBio(ch.phrase))) {
        return res.status(400) && json({ error: "We couldn't find the code in your Roblox About section yet. Save it there, wait a few seconds, then check again." })
      }
      await sql`DELETE FROM rex_roblox_challenges WHERE username=${key}`
      const robloxId = rbx.id, username = rbx.name
      const avatarUrl = await fetchAvatarUrl(robloxId)
      let u = (await sql`SELECT id, username, role FROM users WHERE roblox_id=${robloxId}`)[0]
      if (!u) {
        const id = crypto.randomUUID()
        await sql`INSERT INTO users (id, username, roblox_id, avatar_url) VALUES (${id},${username},${robloxId},${avatarUrl}) ON CONFLICT (roblox_id) DO UPDATE SET username=${username}, avatar_url=${avatarUrl}`
        u = (await sql`SELECT id, username, role FROM users WHERE roblox_id=${robloxId}`)[0]
      } else {
        await sql`UPDATE users SET username=${username}, avatar_url=${avatarUrl} WHERE id=${u.id}`
      }
      if (ADMIN_USERNAMES.includes(username.toLowerCase()) && u.role !== 'admin') {
        await sql`UPDATE users SET role='admin' WHERE id=${u.id}`
        u.role = 'admin'
      }
      const sid = crypto.randomUUID()
      await sql`INSERT INTO sessions (id, user_id) VALUES (${sid}, ${u.id})`
      res.setHeader('Set-Cookie', setCookie('rex_sid', sid, 60 * 60 * 24 * 30))
      return json({ ok: true })
    }

    if (path === '/me' && method === 'GET') {
      const u = await sessionUser(req)
      if (!u) return json({ user: null })
      return json({ user: { id: u.id, username: u.username, role: u.role, avatar: u.avatar_url || null } })
    }
    if (path === '/logout' && method === 'POST') {
      const sid = parseCookies(req.headers.cookie || '').rex_sid
      if (sid) await sql`DELETE FROM sessions WHERE id=${sid}`
      res.setHeader('Set-Cookie', setCookie('rex_sid', '', 0))
      return json({ ok: true })
    }

    // ============================================================
    // GAME MARKETPLACE — buy/sell whole Roblox games, USDC via Apirone.
    // Payment is automatic (Apirone invoice + webhook); order completion is
    // MANUAL — an admin confirms the Roblox ownership transfer happened and
    // releases the seller's payout.
    // ============================================================
    if (path === '/marketplace/listings' && method === 'GET') {
      const rows = await sql`SELECT * FROM rex_game_listings WHERE status='active' ORDER BY created_at DESC LIMIT 1000`
      return json({ listings: rows.map(publicListing) })
    }
    if ((m = path.match(/^\/marketplace\/listings\/([^/]+)$/)) && method === 'GET') {
      const row = (await sql`SELECT * FROM rex_game_listings WHERE id=${m[1]}`)[0]
      if (!row) return res.status(404) && json({ error: 'Listing not found' })
      return json({ listing: publicListing(row) })
    }
    if (path === '/marketplace/listings' && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      if (!u.roblox_id) return res.status(400) && json({ error: 'Connect your Roblox account first' })
      const { groupId, placeId, title, description, priceUsdc } = req.body || {}
      if (!groupId || !placeId) return res.status(400) && json({ error: 'groupId and placeId are required' })
      if (!title || !(Number(priceUsdc) > 0)) return res.status(400) && json({ error: 'Title and a positive price are required' })
      const groupInfo = await fetchGroupInfo(groupId)
      if (!groupInfo) return res.status(400) && json({ error: 'Could not look up that Roblox group' })
      if (groupInfo.ownerId !== u.roblox_id) return res.status(400) && json({ error: 'You are not the owner of that group on Roblox — only the group owner can list it. (Game sales here are done via group-ownership transfer, so the game must be group-owned.)' })
      const universeId = await fetchUniverseFromPlace(placeId)
      if (!universeId) return res.status(400) && json({ error: 'Could not look up that place ID' })
      const stats = await fetchGameStats(universeId)
      const thumb = await fetchGameThumbnail(universeId)
      const id = crypto.randomUUID()
      await sql`
        INSERT INTO rex_game_listings (id, seller_id, seller_username, group_id, place_id, universe_id, title, description, price_usdc, ccu, visits, favorites, thumbnail_url)
        VALUES (${id},${u.id},${u.username},${String(groupId)},${String(placeId)},${universeId},${title.slice(0,80)},${(description||'').slice(0,2000)},${Number(priceUsdc)},${stats?.ccu||0},${stats?.visits||0},${stats?.favorites||0},${thumb})`
      return json({ ok: true, id })
    }
    if ((m = path.match(/^\/marketplace\/listings\/([^/]+)\/cancel$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const row = (await sql`SELECT * FROM rex_game_listings WHERE id=${m[1]}`)[0]
      if (!row) return res.status(404) && json({ error: 'Listing not found' })
      if (row.seller_id !== u.id) return res.status(400) && json({ error: 'Not your listing' })
      if (row.status !== 'active') return res.status(400) && json({ error: 'Listing is not active' })
      await sql`UPDATE rex_game_listings SET status='removed' WHERE id=${m[1]}`
      return json({ ok: true })
    }

    if ((m = path.match(/^\/marketplace\/listings\/([^/]+)\/buy$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      if (!u.roblox_id) return res.status(400) && json({ error: 'Connect your Roblox account first' })
      const listing = (await sql`SELECT * FROM rex_game_listings WHERE id=${m[1]}`)[0]
      if (!listing) return res.status(404) && json({ error: 'Listing not found' })
      if (listing.status !== 'active') return res.status(400) && json({ error: 'This listing is no longer available' })
      if (listing.seller_id === u.id) return res.status(400) && json({ error: "You can't buy your own listing" })
      const orderId = crypto.randomUUID()
      let invoiceId = null, payAddress = null
      try {
        const inv = await createInvoice({ amountUsdc: listing.price_usdc, orderId, callbackUrl: `https://${req.headers.host}/api/marketplace/apirone/callback` })
        invoiceId = inv.invoiceId; payAddress = inv.address
      } catch (e) {
        return res.status(500) && json({ error: `Payment provider unavailable: ${e.message}` })
      }
      await sql`UPDATE rex_game_listings SET status='pending_sale' WHERE id=${listing.id}`
      await sql`
        INSERT INTO rex_game_orders (id, listing_id, buyer_id, buyer_username, buyer_roblox_id, seller_id, seller_username, price_usdc, invoice_id, pay_address)
        VALUES (${orderId},${listing.id},${u.id},${u.username},${u.roblox_id},${listing.seller_id},${listing.seller_username},${listing.price_usdc},${invoiceId},${payAddress})`
      return json({ ok: true, id: orderId, payAddress, amount: listing.price_usdc })
    }

    if ((m = path.match(/^\/marketplace\/orders\/([^/]+)$/)) && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const o = (await sql`SELECT * FROM rex_game_orders WHERE id=${m[1]}`)[0]
      if (!o) return res.status(404) && json({ error: 'Order not found' })
      if (![o.buyer_id, o.seller_id].includes(u.id) && !isAdmin(u)) return res.status(403) && json({ error: 'Not your order' })
      return json({ order: o })
    }
    if ((m = path.match(/^\/marketplace\/orders\/([^/]+)\/check-payment$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const o = (await sql`SELECT * FROM rex_game_orders WHERE id=${m[1]}`)[0]
      if (!o) return res.status(404) && json({ error: 'Order not found' })
      if (![o.buyer_id, o.seller_id].includes(u.id) && !isAdmin(u)) return res.status(403) && json({ error: 'Not your order' })
      if (o.status !== 'awaiting_payment') return json({ order: o })
      if (!o.invoice_id) return res.status(400) && json({ error: 'No invoice on this order' })
      const inv = await getInvoiceStatus(o.invoice_id)
      if (['paid', 'completed', 'overpaid'].includes(inv.status)) {
        await sql`UPDATE rex_game_orders SET status='paid', paid_at=NOW(), transfer_deadline=NOW() + INTERVAL '7 days' WHERE id=${o.id}`
        return json({ order: (await sql`SELECT * FROM rex_game_orders WHERE id=${o.id}`)[0] })
      }
      return json({ order: o, invoiceStatus: inv.status })
    }
    if ((m = path.match(/^\/marketplace\/orders\/([^/]+)\/cancel$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const o = (await sql`SELECT * FROM rex_game_orders WHERE id=${m[1]}`)[0]
      if (!o) return res.status(404) && json({ error: 'Order not found' })
      if (o.buyer_id !== u.id) return res.status(400) && json({ error: 'Only the buyer can cancel' })
      if (o.status !== 'awaiting_payment') return res.status(400) && json({ error: 'This order can no longer be cancelled — contact support if you already paid' })
      await sql`UPDATE rex_game_orders SET status='cancelled', cancelled_at=NOW() WHERE id=${o.id}`
      await sql`UPDATE rex_game_listings SET status='active' WHERE id=${o.listing_id} AND status='pending_sale'`
      return json({ ok: true })
    }
    if (path === '/marketplace/orders' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const box = url.searchParams.get('box') || 'buying'
      const rows = box === 'selling'
        ? await sql`SELECT * FROM rex_game_orders WHERE seller_id=${u.id} ORDER BY created_at DESC LIMIT 100`
        : await sql`SELECT * FROM rex_game_orders WHERE buyer_id=${u.id} ORDER BY created_at DESC LIMIT 100`
      return json({ orders: rows })
    }

    // --- Admin: manual finalization (confirms the Roblox transfer, releases seller payout) ---
    if (path === '/marketplace/admin/orders' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      if (!isAdmin(u)) return res.status(403) && json({ error: 'Admin only' })
      const rows = await sql`SELECT o.*, l.source, l.source_url, l.source_price_usdc FROM rex_game_orders o LEFT JOIN rex_game_listings l ON l.id=o.listing_id WHERE o.status='paid' ORDER BY o.paid_at ASC`
      return json({ orders: rows })
    }
    if ((m = path.match(/^\/marketplace\/orders\/([^/]+)\/finalize$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      if (!isAdmin(u)) return res.status(403) && json({ error: 'Admin only' })
      const o = (await sql`SELECT * FROM rex_game_orders WHERE id=${m[1]}`)[0]
      if (!o) return res.status(404) && json({ error: 'Order not found' })
      if (o.status !== 'paid') return res.status(400) && json({ error: 'Order must be paid before it can be finalized' })
      await sql`UPDATE rex_game_orders SET status='completed', completed_at=NOW() WHERE id=${o.id}`
      await sql`UPDATE rex_game_listings SET status='sold' WHERE id=${o.listing_id}`
      const ledgerId = crypto.randomUUID()
      await sql`INSERT INTO rex_wallet_ledger (id, user_id, kind, amount_usdc, order_id, status) VALUES (${ledgerId},${o.seller_id},'sale',${o.price_usdc},${o.id},'completed')`
      return json({ ok: true })
    }

    // --- Apirone webhook (public — no session) ---
    if (path === '/marketplace/apirone/callback' && method === 'POST') {
      const data = req.body || {}
      const invoiceId = data.invoice || data['invoice-id'] || data.id
      const status = data.status
      if (invoiceId && ['paid', 'completed', 'overpaid'].includes(status)) {
        await sql`
          UPDATE rex_game_orders SET status='paid', paid_at=NOW(), transfer_deadline=NOW() + INTERVAL '7 days'
          WHERE invoice_id=${invoiceId} AND status='awaiting_payment'`
      }
      res.setHeader('Content-Type', 'text/plain'); res.end('ok'); return res
    }

    // --- Wallet ---
    if (path === '/marketplace/wallet' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const ledger = await sql`SELECT * FROM rex_wallet_ledger WHERE user_id=${u.id} ORDER BY created_at DESC LIMIT 200`
      const balance = ledger.reduce((s, l) => s + (l.kind === 'sale' && l.status === 'completed' ? Number(l.amount_usdc) : (l.kind === 'withdrawal' && l.status !== 'failed' ? -Number(l.amount_usdc) : 0)), 0)
      return json({ balance, ledger })
    }
    if (path === '/marketplace/wallet/withdraw' && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const { amount, toAddress } = req.body || {}
      if (!(Number(amount) > 0) || !toAddress) return res.status(400) && json({ error: 'Amount and destination address are required' })
      const ledger = await sql`SELECT * FROM rex_wallet_ledger WHERE user_id=${u.id}`
      const balance = ledger.reduce((s, l) => s + (l.kind === 'sale' && l.status === 'completed' ? Number(l.amount_usdc) : (l.kind === 'withdrawal' && l.status !== 'failed' ? -Number(l.amount_usdc) : 0)), 0)
      if (Number(amount) > balance) return res.status(400) && json({ error: `Amount exceeds your balance ($${balance.toFixed(2)})` })
      const id = crypto.randomUUID()
      await sql`INSERT INTO rex_wallet_ledger (id, user_id, kind, amount_usdc, to_address, status) VALUES (${id},${u.id},'withdrawal',${amount},${toAddress},'pending')`
      return json({ ok: true, id })
    }

    return res.status(404) && json({ error: `No route: ${method} ${path}` })
  } catch (err) {
    console.error('[api]', method, path, err?.message)
    return res.status(err.message?.includes("don't have") || err.message?.includes('no longer') ? 400 : 500) && json({ error: err?.message || 'Server error' })
  }
}
