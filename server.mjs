// Roblox Trade Hub — P2P item-trading marketplace for gifting-only Roblox games.
//
// This is a runnable MVP backend. It keeps state in memory with a seeded demo
// dataset so the trading flow can be exercised end-to-end without a database.
// The handler shape (single router, cookie sessions, per-user/per-game
// inventories, escrow-on-ad/settle-on-accept) mirrors the RoFlips Neon
// serverless stack, so each handler ports to api/auth/[...path].js + Neon later.
//
// Custody (real deposits/withdrawals via an automated gifting bot) is out of
// scope for now: inventories are seeded. The bot would later call the same
// grant/deduct primitives used here.

import http from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import crypto from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8088

// ── Game catalogs ─────────────────────────────────────────────────────────────
// value = community trade value (used to score how fair a trade is).
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

function itemValue(game, name) {
  const it = GAMES[game]?.items.find((i) => i.name === name)
  return it ? it.value : 0
}
function rarityOf(game, name) {
  const it = GAMES[game]?.items.find((i) => i.name === name)
  return it ? it.rarity : 'Unknown'
}
function validItem(game, name) {
  return !!GAMES[game]?.items.find((i) => i.name === name)
}

// ── In-memory store ───────────────────────────────────────────────────────────
const db = {
  users: new Map(), // id -> { id, username }
  byName: new Map(), // lower username -> id
  sessions: new Map(), // sid -> userId
  // inventories: `${userId}:${game}` -> Map(itemName -> qty)
  inventories: new Map(),
  ads: [], // trade ads (see createAd)
  offers: [], // counter-offers against ads (see createOffer)
  trades: [], // completed/declined trade records (history)
  pendingWithdrawals: [], // pending bot fulfillment
}

// Bot mailbox accounts per game (the Roblox account users gift items to).
const MAILBOX = {
  growagarden: 'RobloxExchangeGAG',
}

function invKey(userId, game) {
  return `${userId}:${game}`
}
function getInv(userId, game) {
  const k = invKey(userId, game)
  if (!db.inventories.has(k)) db.inventories.set(k, new Map())
  return db.inventories.get(k)
}
function invQty(userId, game, item) {
  return getInv(userId, game).get(item) || 0
}
function addItem(userId, game, item, qty) {
  const inv = getInv(userId, game)
  inv.set(item, (inv.get(item) || 0) + qty)
}
function removeItem(userId, game, item, qty) {
  const inv = getInv(userId, game)
  const have = inv.get(item) || 0
  if (have < qty) return false
  if (have === qty) inv.delete(item)
  else inv.set(item, have - qty)
  return true
}
function invList(userId, game) {
  return [...getInv(userId, game).entries()].map(([item, qty]) => ({
    item,
    qty,
    value: itemValue(game, item),
    rarity: rarityOf(game, item),
  }))
}

function createUser(username) {
  const lower = username.toLowerCase()
  if (db.byName.has(lower)) return db.users.get(db.byName.get(lower))
  const id = crypto.randomUUID()
  const u = { id, username }
  db.users.set(id, u)
  db.byName.set(lower, id)
  return u
}

// ── Seed demo data ────────────────────────────────────────────────────────────
function seed() {
  const ricky = createUser('ricky')
  const blox = createUser('bloxtrader')
  const garden = createUser('gardenking')

  // GAG inventories — mix of seeds and pet tiers (Normal/Big/Huge)
  addItem(ricky.id, 'growagarden', 'Raccoon', 1)
  addItem(ricky.id, 'growagarden', 'Big Raccoon', 1)
  addItem(ricky.id, 'growagarden', 'Cherry', 3)
  addItem(ricky.id, 'growagarden', 'Bee', 5)
  addItem(blox.id, 'growagarden', 'Moon Bloom', 1)
  addItem(blox.id, 'growagarden', 'Unicorn', 2)
  addItem(blox.id, 'growagarden', 'Huge Bee', 1)
  addItem(blox.id, 'growagarden', 'Owl', 4)
  addItem(garden.id, 'growagarden', 'Ice Serpent', 1)
  addItem(garden.id, 'growagarden', 'Glow Mushroom', 2)
  addItem(garden.id, 'growagarden', 'Monkey', 3)

  // A couple of open ads
  internalCreateAd(blox.id, 'growagarden',
    [{ item: 'Unicorn', qty: 1 }],
    [{ item: 'Cherry', qty: 2 }],
    'Quick flip, lmk')
  internalCreateAd(garden.id, 'growagarden',
    [{ item: 'Monkey', qty: 1 }],
    [{ item: 'Bee', qty: 2 }],
    '')
  internalCreateAd(blox.id, 'growagarden',
    [{ item: 'Huge Bee', qty: 1 }],
    [{ item: 'Big Raccoon', qty: 1 }],
    'Huge for Big, fair?')
}

// ── Trade ad + escrow logic ───────────────────────────────────────────────────
// Ad creation RESERVES the offered items (deducted from inventory into the ad's
// escrow) so they can't be double-spent or coinflipped while the ad is live.
// Accepting an ad atomically swaps: buyer's requested items -> seller, escrowed
// offered items -> buyer. Cancelling returns escrow to the seller.

function sumValue(game, list) {
  return list.reduce((s, l) => s + itemValue(game, l.item) * l.qty, 0)
}

function internalCreateAd(userId, game, offering, requesting, note) {
  // Validate ownership of everything being offered, then move to escrow.
  for (const o of offering) {
    if (o.tag) throw new Error('Offer must be specific items, not tags')
    if (!validItem(game, o.item)) throw new Error(`Unknown item: ${o.item}`)
    if (o.qty <= 0) throw new Error('Quantity must be positive')
    if (invQty(userId, game, o.item) < o.qty) throw new Error(`You don't have ${o.qty}x ${o.item}`)
  }
  // Requests may be specific items or preference tags (Any/Demand/Big/...).
  for (const r of requesting) {
    if (r.tag) { if (!REQUEST_TAGS.includes(r.tag)) throw new Error(`Unknown tag: ${r.tag}`); continue }
    if (!validItem(game, r.item)) throw new Error(`Unknown item: ${r.item}`)
    if (r.qty <= 0) throw new Error('Quantity must be positive')
  }
  if (!offering.length || !requesting.length) throw new Error('Offer and request must each have at least one item')

  for (const o of offering) removeItem(userId, game, o.item, o.qty) // escrow

  const ad = {
    id: crypto.randomUUID(),
    game,
    userId,
    username: db.users.get(userId).username,
    offering,
    requesting,
    offerValue: sumValue(game, offering),
    requestValue: sumValue(game, requesting),
    note: (note || '').slice(0, 140),
    status: 'open',
    createdAt: Date.now(),
  }
  db.ads.unshift(ad)
  return ad
}

function acceptAd(adId, buyerId) {
  const ad = db.ads.find((a) => a.id === adId)
  if (!ad) throw new Error('Ad not found')
  if (ad.status !== 'open') throw new Error('Ad is no longer open')
  if (ad.userId === buyerId) throw new Error("You can't accept your own ad")
  if (ad.requesting.some((r) => r.tag)) throw new Error('This ad takes offers, not instant accept')

  // Buyer must own every requested item.
  for (const r of ad.requesting) {
    if (invQty(buyerId, ad.game, r.item) < r.qty) {
      throw new Error(`You don't have ${r.qty}x ${r.item} to complete this trade`)
    }
  }
  // Atomic swap.
  for (const r of ad.requesting) removeItem(buyerId, ad.game, r.item, r.qty)
  for (const r of ad.requesting) addItem(ad.userId, ad.game, r.item, r.qty) // -> seller
  for (const o of ad.offering) addItem(buyerId, ad.game, o.item, o.qty) // escrow -> buyer

  ad.status = 'completed'
  ad.completedAt = Date.now()
  ad.buyerId = buyerId
  ad.buyerUsername = db.users.get(buyerId).username
  db.trades.unshift({
    id: ad.id, game: ad.game, seller: ad.username, buyer: ad.buyerUsername,
    offering: ad.offering, requesting: ad.requesting, completedAt: ad.completedAt,
  })
  return ad
}

function cancelAd(adId, userId) {
  const ad = db.ads.find((a) => a.id === adId)
  if (!ad) throw new Error('Ad not found')
  if (ad.userId !== userId) throw new Error('Not your ad')
  if (ad.status !== 'open') throw new Error('Ad is no longer open')
  for (const o of ad.offering) addItem(userId, ad.game, o.item, o.qty) // release escrow
  ad.status = 'cancelled'
  return ad
}

// ── Counter-offers (Roblox-style trade builder) ───────────────────────────────
// A counter-offer is a fresh proposal against an ad: the sender picks items from
// their OWN inventory (offerItems, escrowed on send) and from the ad owner's
// inventory (requestItems, validated at accept).
function getInvByUsername(username, game) {
  const id = db.byName.get((username || '').toLowerCase())
  return id ? invList(id, game) : []
}
function createOffer(fromId, adId, offerItems, requestItems) {
  const ad = db.ads.find((a) => a.id === adId)
  if (!ad) throw new Error('Ad not found')
  if (ad.status !== 'open') throw new Error('Ad is no longer open')
  if (ad.userId === fromId) throw new Error("You can't make an offer on your own ad")
  if (!offerItems.length) throw new Error('Add at least one item to your offer')
  if (!requestItems.length) throw new Error('Pick at least one item you want')
  for (const o of offerItems) {
    if (!validItem(ad.game, o.item)) throw new Error(`Unknown item: ${o.item}`)
    if (invQty(fromId, ad.game, o.item) < o.qty) throw new Error(`You don't have ${o.qty}x ${o.item}`)
  }
  for (const r of requestItems) {
    if (!validItem(ad.game, r.item)) throw new Error(`Unknown item: ${r.item}`)
    if (invQty(ad.userId, ad.game, r.item) < r.qty) throw new Error(`${ad.username} no longer has ${r.qty}x ${r.item}`)
  }
  for (const o of offerItems) removeItem(fromId, ad.game, o.item, o.qty) // escrow sender's side
  const offer = {
    id: crypto.randomUUID(), adId, game: ad.game,
    fromId, fromName: db.users.get(fromId).username,
    toId: ad.userId, toName: ad.username,
    offerItems, requestItems,
    status: 'pending', createdAt: Date.now(),
  }
  db.offers.unshift(offer)
  return offer
}
function releaseOfferEscrow(offer) {
  for (const o of offer.offerItems) addItem(offer.fromId, offer.game, o.item, o.qty)
}
function acceptOffer(offerId, byId) {
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) throw new Error('Offer not found')
  if (offer.toId !== byId) throw new Error('Only the ad owner can accept this offer')
  if (offer.status !== 'pending') throw new Error('Offer is no longer pending')
  // Ad owner must still own every requested item.
  for (const r of offer.requestItems) {
    if (invQty(offer.toId, offer.game, r.item) < r.qty) throw new Error(`You no longer have ${r.qty}x ${r.item}`)
  }
  for (const r of offer.requestItems) removeItem(offer.toId, offer.game, r.item, r.qty)
  for (const r of offer.requestItems) addItem(offer.fromId, offer.game, r.item, r.qty) // -> sender
  for (const o of offer.offerItems) addItem(offer.toId, offer.game, o.item, o.qty)     // escrow -> owner
  offer.status = 'accepted'
  // Close the ad and release its original escrow back to the owner.
  const ad = db.ads.find((a) => a.id === offer.adId)
  if (ad && ad.status === 'open') {
    for (const o of ad.offering) addItem(ad.userId, ad.game, o.item, o.qty)
    ad.status = 'completed'; ad.completedAt = Date.now()
  }
  // Decline sibling offers on the same ad and release their escrow.
  for (const sib of db.offers.filter((o) => o.adId === offer.adId && o.status === 'pending' && o.id !== offer.id)) {
    releaseOfferEscrow(sib); sib.status = 'declined'
  }
  db.trades.unshift({
    id: offer.id, game: offer.game, seller: offer.toName, buyer: offer.fromName,
    offering: offer.requestItems, requesting: offer.offerItems, completedAt: Date.now(),
  })
  return offer
}
function setOfferStatus(offerId, userId, action) {
  const offer = db.offers.find((o) => o.id === offerId)
  if (!offer) throw new Error('Offer not found')
  if (offer.status !== 'pending') throw new Error('Offer is no longer pending')
  if (action === 'decline' && offer.toId !== userId) throw new Error('Only the ad owner can decline')
  if (action === 'cancel' && offer.fromId !== userId) throw new Error('Only the sender can cancel')
  releaseOfferEscrow(offer)
  offer.status = action === 'cancel' ? 'cancelled' : 'declined'
  return offer
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────
function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map((p) => [p[0], decodeURIComponent(p[1] || '')])
  )
}
function sessionUser(req) {
  const sid = parseCookies(req.headers.cookie || '').rex_sid
  if (!sid) return null
  const uid = db.sessions.get(sid)
  return uid ? db.users.get(uid) : null
}

// Give a brand-new demo user a few items so the local marketplace stays alive.
function seedNewUser(userId) {
  if (getInv(userId, 'growagarden').size) return
  addItem(userId, 'growagarden', 'Cherry', 3)
  addItem(userId, 'growagarden', 'Bee', 4)
  addItem(userId, 'growagarden', 'Owl', 2)
}
function send(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(data))
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname
  const method = req.method.toUpperCase()

  // Static files
  if (!path.startsWith('/api/')) {
    try {
      const file = path === '/' ? 'index.html' : path.slice(1)
      const ext = file.slice(file.lastIndexOf('.'))
      const body = readFileSync(join(__dirname, 'public', file))
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      return res.end(body)
    } catch {
      res.writeHead(404); return res.end('Not found')
    }
  }

  // Parse JSON body
  let body = {}
  if (method === 'POST') {
    body = await new Promise((resolve) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
    })
  }

  try {
    // --- Catalog / games ---
    if (path === '/api/games' && method === 'GET') {
      return send(res, 200, {
        games: Object.entries(GAMES).map(([id, g]) => ({ id, label: g.label, items: g.items })),
      })
    }

    // --- Auth ---
    // Local DEMO MODE: mirrors the production Roblox bio-verify endpoints, but
    // /roblox/verify skips the real bio check so you can log in without editing a
    // Roblox profile. Production (api/[...path].js) does the real check.
    if (path === '/api/roblox/challenge' && method === 'POST') {
      const key = (body.roblox_username || '').trim().toLowerCase()
      if (!key) return send(res, 400, { error: 'roblox_username required' })
      return send(res, 200, { phrase: `ROBLOXEXCHANGE | demo mode — click verify (no bio needed locally)` })
    }
    if (path === '/api/roblox/verify' && method === 'POST') {
      const username = (body.roblox_username || '').trim()
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return send(res, 400, { error: 'Username must be 3-20 letters/numbers/underscores' })
      const isNew = !db.byName.has(username.toLowerCase())
      const u = createUser(username)
      if (isNew) seedNewUser(u.id)
      const sid = crypto.randomUUID()
      db.sessions.set(sid, u.id)
      return send(res, 200, { user: { id: u.id, username: u.username } },
        { 'Set-Cookie': `rex_sid=${sid}; Path=/; HttpOnly; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax` })
    }
    if (path === '/api/me' && method === 'GET') {
      const u = sessionUser(req)
      return send(res, 200, { user: u ? { id: u.id, username: u.username } : null })
    }
    if (path === '/api/logout' && method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'rex_sid=; Path=/; Max-Age=0' })
    }

    // --- Inventory ---
    if (path === '/api/inventory' && method === 'GET') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const game = url.searchParams.get('game') || 'growagarden'
      if (!GAMES[game]) return send(res, 400, { error: 'Unknown game' })
      // ?user=<username> returns another player's inventory (public, for trading)
      const other = url.searchParams.get('user')
      if (other) return send(res, 200, { game, username: other, items: getInvByUsername(other, game) })
      return send(res, 200, { game, items: invList(u.id, game) })
    }

    // --- Trade ads ---
    if (path === '/api/ads' && method === 'GET') {
      const game = url.searchParams.get('game') || 'growagarden'
      const u = sessionUser(req)
      const ads = db.ads
        .filter((a) => a.game === game && a.status === 'open')
        .map((a) => ({ ...a, mine: u ? a.userId === u.id : false }))
      return send(res, 200, { ads })
    }
    if (path === '/api/ads' && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const { game, offering, requesting, note } = body
      if (!GAMES[game]) return send(res, 400, { error: 'Unknown game' })
      const ad = internalCreateAd(u.id, game, offering || [], requesting || [], note)
      return send(res, 200, { ad })
    }
    let m
    if ((m = path.match(/^\/api\/ads\/([^/]+)\/accept$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const ad = acceptAd(m[1], u.id)
      return send(res, 200, { ad })
    }
    if ((m = path.match(/^\/api\/ads\/([^/]+)\/cancel$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const ad = cancelAd(m[1], u.id)
      return send(res, 200, { ad })
    }

    // --- Counter-offers ---
    if ((m = path.match(/^\/api\/ads\/([^/]+)\/offer$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const offer = createOffer(u.id, m[1], body.offerItems || [], body.requestItems || [])
      return send(res, 200, { offer })
    }
    if (path === '/api/offers' && method === 'GET') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const box = url.searchParams.get('box') || 'incoming'
      const offers = db.offers
        .filter((o) => o.status === 'pending' && (box === 'outgoing' ? o.fromId === u.id : o.toId === u.id))
      return send(res, 200, { offers })
    }
    if ((m = path.match(/^\/api\/offers\/([^/]+)\/accept$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      return send(res, 200, { offer: acceptOffer(m[1], u.id) })
    }
    if ((m = path.match(/^\/api\/offers\/([^/]+)\/(decline|cancel)$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      return send(res, 200, { offer: setOfferStatus(m[1], u.id, m[2]) })
    }

    // --- Trade history (paginated; box=all|mine) ---
    if (path === '/api/history' && method === 'GET') {
      const game = url.searchParams.get('game') || 'growagarden'
      const box = url.searchParams.get('box') || 'all'
      const search = (url.searchParams.get('search') || '').toLowerCase().trim()
      const PAGE = 10
      const u = sessionUser(req)
      let all = db.trades.filter((t) => t.game === game)
      if (box === 'mine' && u) all = all.filter((t) => t.seller === u.username || t.buyer === u.username)
      if (search) all = all.filter((t) => [...t.offering, ...t.requesting].some((e) => (e.item || e.tag || '').toLowerCase().includes(search)))
      const totalPages = Math.max(1, Math.ceil(all.length / PAGE))
      const page = Math.min(Math.max(1, parseInt(url.searchParams.get('page')) || 1), totalPages)
      return send(res, 200, { trades: all.slice((page - 1) * PAGE, page * PAGE), page, totalPages })
    }

    // --- Deposit info ---
    if (path === '/api/deposit/info' && method === 'GET') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const game = url.searchParams.get('game') || 'growagarden'
      const mailbox = MAILBOX[game] || 'RobloxExchangeBot'
      return send(res, 200, { mailbox, game })
    }

    // --- Withdrawals ---
    if (path === '/api/withdraw/request' && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const { game, items } = body
      if (!GAMES[game]) return send(res, 400, { error: 'Unknown game' })
      if (!Array.isArray(items) || !items.length) return send(res, 400, { error: 'No items selected' })
      if (items.length > 20) return send(res, 400, { error: 'Max 20 items per withdrawal' })
      for (const it of items) {
        if (!validItem(game, it.item)) throw new Error(`Unknown item: ${it.item}`)
        if (!it.qty || it.qty < 1) throw new Error(`Invalid qty for ${it.item}`)
        if (invQty(u.id, game, it.item) < it.qty) throw new Error(`You don't have ${it.qty}x ${it.item}`)
      }
      for (const it of items) removeItem(u.id, game, it.item, it.qty)
      const wr = {
        id: crypto.randomUUID(), game, userId: u.id, username: u.username,
        items, status: 'pending', createdAt: Date.now(),
      }
      db.pendingWithdrawals.unshift(wr)
      return send(res, 200, { withdrawal: wr })
    }
    if (path === '/api/withdraw/pending' && method === 'GET') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const mine = db.pendingWithdrawals.filter((w) => w.userId === u.id && w.status === 'pending')
      return send(res, 200, { withdrawals: mine })
    }

    return send(res, 404, { error: `No route: ${method} ${path}` })
  } catch (err) {
    return send(res, 400, { error: err.message || 'Error' })
  }
})

seed()
server.listen(PORT, () => console.log(`Roblox Trade Hub running on http://localhost:${PORT}`))
