// Roblox Exchange — production API (Vercel serverless + Neon Postgres).
//
// Standalone from the RoFlips network: its own users/sessions DB, its own
// Roblox bio-verify auth, its own session cookie (rex_sid). Mirrors the RoFlips
// single-file router pattern so it's familiar, but shares nothing with roflips.com.
//
// Routes (all under /api):
//   GET  /games                      catalog
//   POST /roblox/challenge           {roblox_username} -> {phrase} to put in bio
//   POST /roblox/verify              {roblox_username} -> sets session cookie
//   GET  /me                         current user or null
//   POST /logout
//   GET  /inventory?game=            current user's per-game inventory
//   GET  /ads?game=                  open trade ads
//   POST /ads                        create ad (reserves offered items in escrow)
//   POST /ads/:id/accept             atomic swap
//   POST /ads/:id/cancel             release escrow
//   GET  /history?game=              completed trades
//
// Deposits/withdrawals (the gifting bot) are not wired yet — new users start
// with an empty inventory until the custody bot calls grant/deduct.

import { neon } from '@neondatabase/serverless'
import crypto from 'crypto'

const sql = neon(process.env.POSTGRES_URL)

// ── Game catalogs (community trade values) ────────────────────────────────────
// Grow a Garden splits into seeds (crops) and pets. Pets have 3 size mutation
// tiers — Normal / Big / Huge — same art, bigger = rarer. buildGagItems() expands
// each pet into all three as distinct tradeable items.
const GAG_SEEDS = [
  { name: 'Moon Bloom', rarity: 'Super', value: 7000, slug: 'moon-bloom' },
  { name: 'Poison Ivy', rarity: 'Legendary', value: 6000, slug: 'poison-ivy' },
  { name: "Dragon's Breath", rarity: 'Super', value: 3500, slug: 'dragon-s-breath' },
  { name: 'Glow Mushroom', rarity: 'Epic', value: 3000, slug: 'glow-mushroom' },
  { name: 'Ghost Pepper', rarity: 'Mythic', value: 2500, slug: 'ghost-pepper' },
  { name: 'Venom Spitter', rarity: 'Mythic', value: 1700, slug: 'venom-spitter' },
  { name: 'Poison Apple', rarity: 'Mythic', value: 1300, slug: 'poison-apple' },
  { name: 'Green Bean', rarity: 'Epic', value: 850, slug: 'green-bean' },
  { name: 'Baby Cactus', rarity: 'Rare', value: 800, slug: 'baby-cactus' },
  { name: 'Cherry', rarity: 'Legendary', value: 700, slug: 'cherry' },
]
const GAG_PETS = [
  { name: 'Ice Serpent', rarity: 'Super', value: 75000, slug: 'ice-serpent' },
  { name: 'Raccoon', rarity: 'Super', value: 11000, slug: 'raccoon' },
  { name: 'Unicorn', rarity: 'Mythic', value: 1500, slug: 'unicorn' },
  { name: 'Monkey', rarity: 'Mythic', value: 1000, slug: 'monkey' },
  { name: 'Golden Dragonfly', rarity: 'Mythic', value: 1000, slug: 'golden-dragonfly' },
  { name: 'Bear', rarity: 'Mythic', value: 500, slug: 'bear' },
  { name: 'Bee', rarity: 'Legendary', value: 500, slug: 'bee' },
  { name: 'Owl', rarity: 'Uncommon', value: 500, slug: 'owl' },
]
const REQUEST_TAGS = ['Any', 'Demand', 'Big', 'Huge', 'Upgrade', 'Downgrade', 'Adds']
const PET_TIERS = [
  { prefix: '', imgPrefix: '', mult: 1, tier: 'Normal' },
  { prefix: 'Big ', imgPrefix: 'big-', mult: 5, tier: 'Big' },
  { prefix: 'Huge ', imgPrefix: 'huge-', mult: 25, tier: 'Huge' },
]
function buildGagItems() {
  const items = []
  for (const s of GAG_SEEDS) items.push({ name: s.name, rarity: s.rarity, value: s.value, img: `seeds/${s.slug}.webp`, kind: 'seed' })
  for (const p of GAG_PETS) for (const t of PET_TIERS)
    items.push({ name: `${t.prefix}${p.name}`, rarity: p.rarity, value: p.value * t.mult, img: `pets/${t.imgPrefix}${p.slug}.webp`, kind: 'pet', tier: t.tier })
  return items
}

const GAMES = {
  growagarden: {
    label: 'Grow a Garden',
    items: buildGagItems(),
  },
}
function catalogItem(game, name) { return GAMES[game]?.items.find((i) => i.name === name) }
function itemValue(game, name) { return catalogItem(game, name)?.value || 0 }
function validItem(game, name) { return !!catalogItem(game, name) }
function sumValue(game, list) { return list.reduce((s, l) => s + itemValue(game, l.item) * l.qty, 0) }

// ── Schema bootstrap ──────────────────────────────────────────────────────────
let _initDone = false
async function ensureInit() {
  if (_initDone) return
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id         TEXT PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      roblox_id  TEXT UNIQUE,
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
    CREATE TABLE IF NOT EXISTS rex_inventories (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game    TEXT NOT NULL,
      item    TEXT NOT NULL,
      qty     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, game, item)
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_challenges (
      roblox_username TEXT PRIMARY KEY,
      phrase          TEXT NOT NULL,
      expires_at      TIMESTAMPTZ NOT NULL
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_trade_ads (
      id           TEXT PRIMARY KEY,
      game         TEXT NOT NULL,
      user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username     TEXT NOT NULL,
      offering     JSONB NOT NULL,
      requesting   JSONB NOT NULL,
      note         TEXT DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'open',
      buyer_id     TEXT,
      buyer_name   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_trade_offers (
      id            TEXT PRIMARY KEY,
      ad_id         TEXT,
      game          TEXT NOT NULL,
      from_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_name     TEXT NOT NULL,
      to_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_name       TEXT NOT NULL,
      offer_items   JSONB NOT NULL,
      request_items JSONB NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_pending_withdrawals (
      id         TEXT PRIMARY KEY,
      game       TEXT NOT NULL,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username   TEXT NOT NULL,
      items      JSONB NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_chat_messages (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username   TEXT NOT NULL,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_dm_messages (
      id         TEXT PRIMARY KEY,
      from_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_name  TEXT NOT NULL,
      to_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_name    TEXT NOT NULL,
      message    TEXT NOT NULL,
      read       BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`
  await sql`
    CREATE TABLE IF NOT EXISTS rex_reputation (
      from_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (from_id, to_id)
    )`
  // Make ad_id nullable for direct offers (idempotent)
  await sql`ALTER TABLE rex_trade_offers ALTER COLUMN ad_id DROP NOT NULL`.catch(() => {})
  _initDone = true
}

const MAILBOX = {
  growagarden: 'RobloxExchangeGAG',
}

// ── Inventory primitives (the gifting bot will reuse addItem/removeItem) ───────
async function invQty(userId, game, item) {
  const r = await sql`SELECT qty FROM rex_inventories WHERE user_id=${userId} AND game=${game} AND item=${item}`
  return r[0]?.qty || 0
}
async function addItem(userId, game, item, qty) {
  await sql`
    INSERT INTO rex_inventories (user_id, game, item, qty) VALUES (${userId},${game},${item},${qty})
    ON CONFLICT (user_id, game, item) DO UPDATE SET qty = rex_inventories.qty + ${qty}`
}
async function removeItem(userId, game, item, qty) {
  const r = await sql`
    UPDATE rex_inventories SET qty = qty - ${qty}
    WHERE user_id=${userId} AND game=${game} AND item=${item} AND qty >= ${qty}
    RETURNING qty`
  if (!r.length) return false
  if (r[0].qty === 0) await sql`DELETE FROM rex_inventories WHERE user_id=${userId} AND game=${game} AND item=${item} AND qty=0`
  return true
}
async function invList(userId, game) {
  const rows = await sql`SELECT item, qty FROM rex_inventories WHERE user_id=${userId} AND game=${game} ORDER BY qty DESC`
  return rows.map((r) => ({ item: r.item, qty: r.qty, value: itemValue(game, r.item), rarity: catalogItem(game, r.item)?.rarity || 'Unknown' }))
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
const WORDS = ['garden','dragon','mango','comet','pixel','otter','maple','quartz','river','ember','lunar','cobalt','willow','sage','flint','onyx']
function generatePhrase() {
  const w = []
  for (let i = 0; i < 6; i++) w.push(WORDS[Math.floor(Math.random() * WORDS.length)])
  return `RE | ${w.join(' ')}`
}
function normalizeUsername(u) { return (u || '').trim().toLowerCase() }
async function fetchRobloxUserId(username) {
  const res = await fetch('https://users.roblox.com/v1/usernames/users', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  })
  const data = await res.json()
  return data?.data?.[0]?.id || null
}
async function fetchRobloxBio(robloxId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${robloxId}`)
  const data = await res.json()
  return data?.description || ''
}
async function fetchAvatarUrl(robloxId) {
  try {
    const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${robloxId}&size=150x150&format=Png&isCircular=false`)
    const data = await res.json()
    return data?.data?.[0]?.imageUrl || null
  } catch { return null }
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map((p) => [p[0], decodeURIComponent(p[1] || '')]))
}
function setCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`
}
async function sessionUser(req) {
  const sid = parseCookies(req.headers.cookie || '').rex_sid
  if (!sid) return null
  const rows = await sql`SELECT u.id, u.username, u.role, u.roblox_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=${sid}`
  return rows[0] || null
}

// ── Trade logic ───────────────────────────────────────────────────────────────
async function createAd(userId, username, game, offering, requesting, note) {
  if (!Array.isArray(offering) || !Array.isArray(requesting) || !offering.length || !requesting.length)
    throw new Error('Offer and request must each have at least one item')
  for (const o of offering) {
    if (o.tag) throw new Error('Offer must be specific items, not tags')
    if (!validItem(game, o.item)) throw new Error(`Unknown item: ${o.item}`)
    if (!(o.qty > 0)) throw new Error('Quantity must be positive')
  }
  // Requests may be specific items or preference tags (Any/Demand/Big/...).
  for (const r of requesting) {
    if (r.tag) { if (!REQUEST_TAGS.includes(r.tag)) throw new Error(`Unknown tag: ${r.tag}`); continue }
    if (!validItem(game, r.item)) throw new Error(`Unknown item: ${r.item}`)
    if (!(r.qty > 0)) throw new Error('Quantity must be positive')
  }
  // Reserve offered items (escrow). Fail atomically if any is short.
  const reserved = []
  for (const o of offering) {
    const ok = await removeItem(userId, game, o.item, o.qty)
    if (!ok) { for (const r of reserved) await addItem(userId, game, r.item, r.qty); throw new Error(`You don't have ${o.qty}x ${o.item}`) }
    reserved.push(o)
  }
  const id = crypto.randomUUID()
  await sql`
    INSERT INTO rex_trade_ads (id, game, user_id, username, offering, requesting, note)
    VALUES (${id},${game},${userId},${username},${JSON.stringify(offering)},${JSON.stringify(requesting)},${(note || '').slice(0,140)})`
  return id
}
async function acceptAd(adId, buyer) {
  const rows = await sql`SELECT * FROM rex_trade_ads WHERE id=${adId}`
  const ad = rows[0]
  if (!ad) throw new Error('Ad not found')
  if (ad.status !== 'open') throw new Error('Ad is no longer open')
  if (ad.user_id === buyer.id) throw new Error("You can't accept your own ad")
  const requesting = ad.requesting, offering = ad.offering
  if (requesting.some((r) => r.tag)) throw new Error('This ad takes offers, not instant accept')
  for (const r of requesting) {
    if (await invQty(buyer.id, ad.game, r.item) < r.qty) throw new Error(`You don't have ${r.qty}x ${r.item} to complete this trade`)
  }
  // Atomic swap: buyer's requested -> seller; escrowed offered -> buyer.
  for (const r of requesting) {
    const ok = await removeItem(buyer.id, ad.game, r.item, r.qty)
    if (!ok) throw new Error(`You don't have ${r.qty}x ${r.item}`)
  }
  for (const r of requesting) await addItem(ad.user_id, ad.game, r.item, r.qty)
  for (const o of offering) await addItem(buyer.id, ad.game, o.item, o.qty)
  await sql`UPDATE rex_trade_ads SET status='completed', buyer_id=${buyer.id}, buyer_name=${buyer.username}, completed_at=NOW() WHERE id=${adId}`
}
async function cancelAd(adId, userId) {
  const rows = await sql`SELECT * FROM rex_trade_ads WHERE id=${adId}`
  const ad = rows[0]
  if (!ad) throw new Error('Ad not found')
  if (ad.user_id !== userId) throw new Error('Not your ad')
  if (ad.status !== 'open') throw new Error('Ad is no longer open')
  for (const o of ad.offering) await addItem(userId, ad.game, o.item, o.qty)
  await sql`UPDATE rex_trade_ads SET status='cancelled' WHERE id=${adId}`
}

// ── Counter-offers (Roblox-style trade builder) ───────────────────────────────
async function invListByUsername(username, game) {
  const u = (await sql`SELECT id FROM users WHERE username=${(username || '').toLowerCase()}`)[0]
  return u ? await invList(u.id, game) : []
}
async function createOffer(fromId, fromName, adId, offerItems, requestItems) {
  const ad = (await sql`SELECT * FROM rex_trade_ads WHERE id=${adId}`)[0]
  if (!ad) throw new Error('Ad not found')
  if (ad.status !== 'open') throw new Error('Ad is no longer open')
  if (ad.user_id === fromId) throw new Error("You can't make an offer on your own ad")
  if (!offerItems.length) throw new Error('Add at least one item to your offer')
  if (!requestItems.length) throw new Error('Pick at least one item you want')
  for (const o of [...offerItems, ...requestItems]) {
    if (o.tag) throw new Error('Offers must be specific items')
    if (!validItem(ad.game, o.item)) throw new Error(`Unknown item: ${o.item}`)
    if (!(o.qty > 0)) throw new Error('Quantity must be positive')
  }
  for (const r of requestItems) {
    if (await invQty(ad.user_id, ad.game, r.item) < r.qty) throw new Error(`${ad.username} no longer has ${r.qty}x ${r.item}`)
  }
  // Escrow sender's offered items (atomic).
  const reserved = []
  for (const o of offerItems) {
    const ok = await removeItem(fromId, ad.game, o.item, o.qty)
    if (!ok) { for (const x of reserved) await addItem(fromId, ad.game, x.item, x.qty); throw new Error(`You don't have ${o.qty}x ${o.item}`) }
    reserved.push(o)
  }
  const id = crypto.randomUUID()
  await sql`
    INSERT INTO rex_trade_offers (id, ad_id, game, from_id, from_name, to_id, to_name, offer_items, request_items)
    VALUES (${id},${adId},${ad.game},${fromId},${fromName},${ad.user_id},${ad.username},${JSON.stringify(offerItems)},${JSON.stringify(requestItems)})`
  return id
}
async function createDirectOffer(fromId, fromName, toUsername, game, offerItems, requestItems) {
  const toUser = (await sql`SELECT * FROM users WHERE LOWER(roblox_username)=LOWER(${toUsername})`)[0]
  if (!toUser) throw new Error(`User ${toUsername} not found`)
  if (toUser.id === fromId) throw new Error("You can't send an offer to yourself")
  if (!offerItems.length) throw new Error('Add at least one item to your offer')
  if (!requestItems.length) throw new Error('Pick at least one item you want')
  for (const o of [...offerItems, ...requestItems]) {
    if (o.tag) throw new Error('Offers must be specific items')
    if (!validItem(game, o.item)) throw new Error(`Unknown item: ${o.item}`)
    if (!(o.qty > 0)) throw new Error('Quantity must be positive')
  }
  for (const r of requestItems) {
    if (await invQty(toUser.id, game, r.item) < r.qty) throw new Error(`${toUsername} doesn't have ${r.qty}x ${r.item}`)
  }
  const reserved = []
  for (const o of offerItems) {
    const ok = await removeItem(fromId, game, o.item, o.qty)
    if (!ok) { for (const x of reserved) await addItem(fromId, game, x.item, x.qty); throw new Error(`You don't have ${o.qty}x ${o.item}`) }
    reserved.push(o)
  }
  const id = crypto.randomUUID()
  await sql`
    INSERT INTO rex_trade_offers (id, ad_id, game, from_id, from_name, to_id, to_name, offer_items, request_items)
    VALUES (${id},${null},${game},${fromId},${fromName},${toUser.id},${toUser.roblox_username},${JSON.stringify(offerItems)},${JSON.stringify(requestItems)})`
  return id
}
async function acceptOffer(offerId, byId) {
  const o = (await sql`SELECT * FROM rex_trade_offers WHERE id=${offerId}`)[0]
  if (!o) throw new Error('Offer not found')
  if (o.to_id !== byId) throw new Error('Only the recipient can accept this offer')
  if (o.status !== 'pending') throw new Error('Offer is no longer pending')
  for (const r of o.request_items) {
    if (await invQty(o.to_id, o.game, r.item) < r.qty) throw new Error(`You no longer have ${r.qty}x ${r.item}`)
  }
  for (const r of o.request_items) { const ok = await removeItem(o.to_id, o.game, r.item, r.qty); if (!ok) throw new Error(`You no longer have ${r.qty}x ${r.item}`) }
  for (const r of o.request_items) await addItem(o.from_id, o.game, r.item, r.qty)
  for (const it of o.offer_items) await addItem(o.to_id, o.game, it.item, it.qty)
  await sql`UPDATE rex_trade_offers SET status='accepted' WHERE id=${offerId}`
  if (o.ad_id) {
    // Close the tied ad and release its escrow.
    const ad = (await sql`SELECT * FROM rex_trade_ads WHERE id=${o.ad_id}`)[0]
    if (ad && ad.status === 'open') {
      for (const it of ad.offering) await addItem(ad.user_id, ad.game, it.item, it.qty)
      await sql`UPDATE rex_trade_ads SET status='completed', buyer_id=${o.from_id}, buyer_name=${o.from_name}, completed_at=NOW() WHERE id=${o.ad_id}`
    }
    // Decline sibling offers and release their escrow.
    const sibs = await sql`SELECT * FROM rex_trade_offers WHERE ad_id=${o.ad_id} AND status='pending' AND id != ${offerId}`
    for (const s of sibs) { for (const it of s.offer_items) await addItem(s.from_id, s.game, it.item, it.qty); await sql`UPDATE rex_trade_offers SET status='declined' WHERE id=${s.id}` }
  }
}
async function setOfferStatus(offerId, userId, action) {
  const o = (await sql`SELECT * FROM rex_trade_offers WHERE id=${offerId}`)[0]
  if (!o) throw new Error('Offer not found')
  if (o.status !== 'pending') throw new Error('Offer is no longer pending')
  if (action === 'decline' && o.to_id !== userId) throw new Error('Only the ad owner can decline')
  if (action === 'cancel' && o.from_id !== userId) throw new Error('Only the sender can cancel')
  for (const it of o.offer_items) await addItem(o.from_id, o.game, it.item, it.qty)
  await sql`UPDATE rex_trade_offers SET status=${action === 'cancel' ? 'cancelled' : 'declined'} WHERE id=${offerId}`
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

    if (path === '/games' && method === 'GET') {
      return json({ games: Object.entries(GAMES).map(([id, g]) => ({ id, label: g.label, items: g.items })) })
    }

    if (path === '/roblox/challenge' && method === 'POST') {
      const key = normalizeUsername(req.body?.roblox_username)
      if (!key) return res.status(400) && json({ error: 'roblox_username required' })
      const phrase = generatePhrase()
      await sql`
        INSERT INTO rex_challenges (roblox_username, phrase, expires_at)
        VALUES (${key},${phrase},NOW() + INTERVAL '10 minutes')
        ON CONFLICT (roblox_username) DO UPDATE SET phrase=${phrase}, expires_at=NOW() + INTERVAL '10 minutes'`
      return json({ phrase })
    }

    if (path === '/roblox/verify' && method === 'POST') {
      const key = normalizeUsername(req.body?.roblox_username)
      if (!key) return res.status(400) && json({ error: 'roblox_username required' })
      const ch = await sql`SELECT phrase FROM rex_challenges WHERE roblox_username=${key} AND expires_at > NOW()`
      if (!ch[0]) return res.status(400) && json({ error: 'Challenge expired or not found. Start over.' })
      const robloxId = await fetchRobloxUserId(key)
      if (!robloxId) return res.status(400) && json({ error: 'Roblox username not found' })
      const bio = await fetchRobloxBio(robloxId)
      if (!bio.includes(ch[0].phrase)) return res.status(400) && json({ error: 'Phrase not found in your Roblox bio. Add it and try again.' })
      await sql`DELETE FROM rex_challenges WHERE roblox_username=${key}`
      let u = (await sql`SELECT id, username, role FROM users WHERE roblox_id=${String(robloxId)}`)[0]
      if (!u) {
        const id = crypto.randomUUID()
        await sql`INSERT INTO users (id, username, roblox_id) VALUES (${id},${key},${String(robloxId)}) ON CONFLICT (roblox_id) DO UPDATE SET username=${key}`
        u = (await sql`SELECT id, username, role FROM users WHERE id=${id}`)[0]
      }
      const sid = crypto.randomUUID()
      await sql`INSERT INTO sessions (id, user_id) VALUES (${sid}, ${u.id})`
      res.setHeader('Set-Cookie', setCookie('rex_sid', sid, 60 * 60 * 24 * 30))
      return json({ user: { id: u.id, username: u.username, role: u.role } })
    }

    if (path === '/me' && method === 'GET') {
      const u = await sessionUser(req)
      if (!u) return json({ user: null })
      const avatar = u.roblox_id ? await fetchAvatarUrl(u.roblox_id) : null
      return json({ user: { id: u.id, username: u.username, role: u.role, avatar } })
    }
    if (path === '/avatar' && method === 'GET') {
      const username = (url.searchParams.get('username') || '').trim()
      if (!username) return res.status(400) && json({ error: 'username required' })
      const row = (await sql`SELECT roblox_id FROM users WHERE LOWER(roblox_username)=LOWER(${username})`)[0]
        || (await sql`SELECT roblox_id FROM users WHERE LOWER(username)=LOWER(${username})`)[0]
      if (!row?.roblox_id) return json({ url: null })
      const avatarUrl = await fetchAvatarUrl(row.roblox_id)
      return json({ url: avatarUrl })
    }
    if (path === '/logout' && method === 'POST') {
      const sid = parseCookies(req.headers.cookie || '').rex_sid
      if (sid) await sql`DELETE FROM sessions WHERE id=${sid}`
      res.setHeader('Set-Cookie', setCookie('rex_sid', '', 0))
      return json({ ok: true })
    }

    if (path === '/inventory' && method === 'GET') {
      const u = await sessionUser(req)
      if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const game = url.searchParams.get('game') || 'growagarden'
      if (!GAMES[game]) return res.status(400) && json({ error: 'Unknown game' })
      const other = url.searchParams.get('user')
      if (other) return json({ game, username: other, items: await invListByUsername(other, game) })
      return json({ game, items: await invList(u.id, game) })
    }

    if (path === '/ads' && method === 'GET') {
      const game = url.searchParams.get('game') || 'growagarden'
      const u = await sessionUser(req)
      const rows = await sql`SELECT * FROM rex_trade_ads WHERE game=${game} AND status='open' ORDER BY created_at DESC LIMIT 100`
      const ads = rows.map((a) => ({
        id: a.id, game: a.game, username: a.username, offering: a.offering, requesting: a.requesting,
        note: a.note, offerValue: sumValue(a.game, a.offering), requestValue: sumValue(a.game, a.requesting),
        mine: u ? a.user_id === u.id : false,
      }))
      return json({ ads })
    }
    if (path === '/ads' && method === 'POST') {
      const u = await sessionUser(req)
      if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const { game, offering, requesting, note } = req.body || {}
      if (!GAMES[game]) return res.status(400) && json({ error: 'Unknown game' })
      const id = await createAd(u.id, u.username, game, offering || [], requesting || [], note)
      return json({ ok: true, id })
    }
    let m
    if ((m = path.match(/^\/ads\/([^/]+)\/accept$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      await acceptAd(m[1], u); return json({ ok: true })
    }
    if ((m = path.match(/^\/ads\/([^/]+)\/cancel$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      await cancelAd(m[1], u.id); return json({ ok: true })
    }

    // --- Counter-offers ---
    if ((m = path.match(/^\/ads\/([^/]+)\/offer$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const id = await createOffer(u.id, u.username, m[1], req.body?.offerItems || [], req.body?.requestItems || [])
      return json({ ok: true, id })
    }
    if (path === '/offers/direct' && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const { toUsername, offerItems, requestItems, game } = req.body || {}
      const id = await createDirectOffer(u.id, u.username, toUsername, game || 'growagarden', offerItems || [], requestItems || [])
      return json({ ok: true, id })
    }
    if (path === '/offers' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const box = url.searchParams.get('box') || 'incoming'
      const rows = box === 'outgoing'
        ? await sql`SELECT * FROM rex_trade_offers WHERE status='pending' AND from_id=${u.id} ORDER BY created_at DESC LIMIT 100`
        : await sql`SELECT * FROM rex_trade_offers WHERE status='pending' AND to_id=${u.id} ORDER BY created_at DESC LIMIT 100`
      return json({ offers: rows.map((o) => ({ id: o.id, adId: o.ad_id, game: o.game, fromName: o.from_name, toName: o.to_name, offerItems: o.offer_items, requestItems: o.request_items })) })
    }
    if ((m = path.match(/^\/offers\/([^/]+)\/accept$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      await acceptOffer(m[1], u.id); return json({ ok: true })
    }
    if ((m = path.match(/^\/offers\/([^/]+)\/(decline|cancel)$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      await setOfferStatus(m[1], u.id, m[2]); return json({ ok: true })
    }

    if (path === '/history' && method === 'GET') {
      const game = url.searchParams.get('game') || 'growagarden'
      const box = url.searchParams.get('box') || 'all'
      const search = (url.searchParams.get('search') || '').trim()
      const pat = search ? `%${search}%` : '%' // ILIKE '%' matches everything
      const PAGE = 10
      const u = await sessionUser(req)
      const mine = box === 'mine' && u
      const name = mine ? u.username : null
      const cnt = mine
        ? await sql`SELECT COUNT(*)::int AS n FROM rex_trade_ads WHERE game=${game} AND status='completed' AND (username=${name} OR buyer_name=${name}) AND (offering::text ILIKE ${pat} OR requesting::text ILIKE ${pat})`
        : await sql`SELECT COUNT(*)::int AS n FROM rex_trade_ads WHERE game=${game} AND status='completed' AND (offering::text ILIKE ${pat} OR requesting::text ILIKE ${pat})`
      const totalPages = Math.max(1, Math.ceil((cnt[0]?.n || 0) / PAGE))
      const page = Math.min(Math.max(1, parseInt(url.searchParams.get('page')) || 1), totalPages)
      const offset = (page - 1) * PAGE
      const rows = mine
        ? await sql`SELECT username, buyer_name, offering, requesting, completed_at FROM rex_trade_ads WHERE game=${game} AND status='completed' AND (username=${name} OR buyer_name=${name}) AND (offering::text ILIKE ${pat} OR requesting::text ILIKE ${pat}) ORDER BY completed_at DESC LIMIT ${PAGE} OFFSET ${offset}`
        : await sql`SELECT username, buyer_name, offering, requesting, completed_at FROM rex_trade_ads WHERE game=${game} AND status='completed' AND (offering::text ILIKE ${pat} OR requesting::text ILIKE ${pat}) ORDER BY completed_at DESC LIMIT ${PAGE} OFFSET ${offset}`
      return json({ trades: rows.map((t) => ({ seller: t.username, buyer: t.buyer_name, offering: t.offering, requesting: t.requesting, completedAt: t.completed_at })), page, totalPages })
    }

    // --- Global chat ---
    if (path === '/chat/global' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const before = url.searchParams.get('before') // ISO timestamp for pagination
      const rows = before
        ? await sql`SELECT id, username, message, created_at FROM rex_chat_messages WHERE created_at < ${before} ORDER BY created_at DESC LIMIT 50`
        : await sql`SELECT id, username, message, created_at FROM rex_chat_messages ORDER BY created_at DESC LIMIT 50`
      return json({ messages: rows.reverse() })
    }
    if (path === '/chat/global' && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const msg = (req.body?.message || '').trim().slice(0, 200)
      if (!msg) return res.status(400) && json({ error: 'Message cannot be empty' })
      const id = crypto.randomUUID()
      await sql`INSERT INTO rex_chat_messages (id, user_id, username, message) VALUES (${id},${u.id},${u.username},${msg})`
      return json({ ok: true, id })
    }

    // --- DMs ---
    if (path === '/chat/dms' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      // Get latest message per conversation partner
      const rows = await sql`
        SELECT DISTINCT ON (partner_id)
          partner_id, partner_name, message, created_at, read, from_id
        FROM (
          SELECT to_id AS partner_id, to_name AS partner_name, message, created_at, read, from_id
          FROM rex_dm_messages WHERE from_id=${u.id}
          UNION ALL
          SELECT from_id AS partner_id, from_name AS partner_name, message, created_at, read, from_id
          FROM rex_dm_messages WHERE to_id=${u.id}
        ) t
        ORDER BY partner_id, created_at DESC`
      const unread = await sql`SELECT COUNT(*)::int AS n FROM rex_dm_messages WHERE to_id=${u.id} AND read=false`
      return json({ conversations: rows, unreadTotal: unread[0]?.n || 0 })
    }
    if ((m = path.match(/^\/chat\/dms\/([^/]+)$/)) && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const otherId = m[1]
      const rows = await sql`
        SELECT id, from_id, from_name, to_id, to_name, message, created_at, read
        FROM rex_dm_messages
        WHERE (from_id=${u.id} AND to_id=${otherId}) OR (from_id=${otherId} AND to_id=${u.id})
        ORDER BY created_at ASC LIMIT 200`
      // Mark received messages as read
      await sql`UPDATE rex_dm_messages SET read=true WHERE to_id=${u.id} AND from_id=${otherId} AND read=false`
      return json({ messages: rows })
    }
    if ((m = path.match(/^\/chat\/dms\/([^/]+)$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const otherId = m[1]
      const msg = (req.body?.message || '').trim().slice(0, 500)
      if (!msg) return res.status(400) && json({ error: 'Message cannot be empty' })
      const other = (await sql`SELECT id, username FROM users WHERE id=${otherId}`)[0]
      if (!other) return res.status(400) && json({ error: 'User not found' })
      const id = crypto.randomUUID()
      await sql`INSERT INTO rex_dm_messages (id, from_id, from_name, to_id, to_name, message)
        VALUES (${id},${u.id},${u.username},${other.id},${other.username},${msg})`
      return json({ ok: true, id })
    }
    if (path === '/chat/unread' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const r = await sql`SELECT COUNT(*)::int AS n FROM rex_dm_messages WHERE to_id=${u.id} AND read=false`
      return json({ unread: r[0]?.n || 0 })
    }
    // Look up a user's id by username (for opening DMs)
    if (path === '/users/lookup' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const username = (url.searchParams.get('username') || '').toLowerCase()
      const row = (await sql`SELECT id, username FROM users WHERE LOWER(username)=${username}`)[0]
      if (!row) return res.status(404) && json({ error: 'User not found' })
      return json({ user: row })
    }
    if ((m = path.match(/^\/users\/([^/]+)\/thumbsup$/)) && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const target = (await sql`SELECT id FROM users WHERE LOWER(roblox_username)=LOWER(${m[1]})`)[0]
      if (!target) return res.status(404) && json({ error: 'User not found' })
      if (target.id === u.id) return res.status(400) && json({ error: "Can't thumb-up yourself" })
      await sql`INSERT INTO rex_reputation (from_id, to_id) VALUES (${u.id}, ${target.id}) ON CONFLICT DO NOTHING`
      const count = (await sql`SELECT COUNT(*) FROM rex_reputation WHERE to_id=${target.id}`)[0].count
      return json({ ok: true, thumbsUp: Number(count), hasThumbedUp: true })
    }
    if (path === '/users/profile' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const username = (url.searchParams.get('username') || '').trim()
      const game = url.searchParams.get('game') || 'growagarden'
      const row = (await sql`SELECT id, roblox_username, roblox_id FROM users WHERE LOWER(roblox_username)=LOWER(${username})`)[0]
      if (!row) return res.status(404) && json({ error: 'User not found' })
      const [adsRows, invRows, countRow, repRow, myVote] = await Promise.all([
        sql`SELECT * FROM rex_trade_ads WHERE user_id=${row.id} AND game=${game} AND status='open' ORDER BY created_at DESC LIMIT 20`,
        sql`SELECT item, qty FROM rex_inventories WHERE user_id=${row.id} AND game=${game} AND qty > 0 ORDER BY item`,
        sql`SELECT COUNT(*) FROM rex_trade_ads WHERE game=${game} AND status='completed' AND (user_id=${row.id} OR buyer_id=${row.id})`,
        sql`SELECT COUNT(*) FROM rex_reputation WHERE to_id=${row.id}`,
        sql`SELECT 1 FROM rex_reputation WHERE from_id=${u.id} AND to_id=${row.id}`,
      ])
      const ads = adsRows.map((a) => ({ id: a.id, username: a.username, note: a.note, offering: a.offering, requesting: a.requesting, mine: a.user_id === u.id }))
      const inventory = invRows.map((r) => ({ item: r.item, qty: r.qty, rarity: '' }))
      const avatar = row.roblox_id ? await fetchAvatarUrl(row.roblox_id) : null
      return json({ username: row.roblox_username, targetId: row.id, avatar, stats: { completedTrades: Number(countRow[0].count), thumbsUp: Number(repRow[0].count), hasThumbedUp: myVote.length > 0 }, ads, inventory })
    }

    // --- Deposit info ---
    if (path === '/deposit/info' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const game = url.searchParams.get('game') || 'growagarden'
      return json({ mailbox: MAILBOX[game] || 'RobloxExchangeGAG', game })
    }

    // --- Withdrawals ---
    if (path === '/withdraw/request' && method === 'POST') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const { game, items } = req.body || {}
      if (!GAMES[game]) return res.status(400) && json({ error: 'Unknown game' })
      if (!Array.isArray(items) || !items.length) return res.status(400) && json({ error: 'No items selected' })
      if (items.length > 20) return res.status(400) && json({ error: 'Max 20 items per withdrawal' })
      for (const it of items) {
        if (!validItem(game, it.item)) throw new Error(`Unknown item: ${it.item}`)
        if (!it.qty || it.qty < 1) throw new Error(`Invalid qty for ${it.item}`)
        if (await invQty(u.id, game, it.item) < it.qty) throw new Error(`You don't have ${it.qty}x ${it.item}`)
      }
      for (const it of items) await removeItem(u.id, game, it.item, it.qty)
      const id = crypto.randomUUID()
      await sql`INSERT INTO rex_pending_withdrawals (id, game, user_id, username, items) VALUES (${id},${game},${u.id},${u.username},${JSON.stringify(items)})`
      return json({ ok: true, id })
    }
    if (path === '/withdraw/pending' && method === 'GET') {
      const u = await sessionUser(req); if (!u) return res.status(401) && json({ error: 'Not logged in' })
      const rows = await sql`SELECT id, game, items, created_at FROM rex_pending_withdrawals WHERE user_id=${u.id} AND status='pending' ORDER BY created_at DESC`
      return json({ withdrawals: rows })
    }

    return res.status(404) && json({ error: `No route: ${method} ${path}` })
  } catch (err) {
    console.error('[api]', method, path, err?.message)
    return res.status(err.message?.includes("don't have") || err.message?.includes('no longer') ? 400 : 500) && json({ error: err?.message || 'Server error' })
  }
}
