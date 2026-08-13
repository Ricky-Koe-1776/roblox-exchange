// Roblox Exchange — local demo server.
//
// robloxexchange.com is a marketplace for buying and selling whole Roblox
// games, paid in USDC. This file is a runnable in-memory MVP so the full
// buy -> pay -> admin-finalize flow can be exercised without a database or
// real Roblox/Apirone credentials. Production (api/[...path].js) does the
// real Roblox OAuth login, real Roblox ownership checks, and real Apirone
// payments against Neon Postgres.
//
// "Sign in with Roblox" is faked here: GET /api/roblox/oauth/start serves a
// tiny standalone HTML page (not the SPA) with a username field. Submitting
// it hits /api/roblox/oauth/callback?username=..., which creates/finds a demo
// user and redirects back to '/' with a session cookie — same route names and
// same end state as the real OAuth flow, so the SPA's login link works
// unchanged in both environments.

import http from 'http'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import crypto from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 8088

// Local demo only — these usernames get admin so you can test the
// manual-finalization flow without real infra.
const DEMO_ADMINS = ['ricky', 'admin']

const db = {
  users: new Map(),   // id -> { id, username, role }
  byName: new Map(),  // lower username -> id
  sessions: new Map(),// sid -> userId
  gameListings: [],
  gameOrders: [],
  walletLedger: [],
}

function createUser(username) {
  const lower = username.toLowerCase()
  if (db.byName.has(lower)) return db.users.get(db.byName.get(lower))
  const id = crypto.randomUUID()
  const u = { id, username, role: DEMO_ADMINS.includes(lower) ? 'admin' : 'user' }
  db.users.set(id, u)
  db.byName.set(lower, id)
  return u
}
function sessionUser(req) {
  const sid = parseCookies(req.headers.cookie || '').rex_sid
  if (!sid) return null
  const uid = db.sessions.get(sid)
  return uid ? db.users.get(uid) : null
}
function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map((p) => [p[0], decodeURIComponent(p[1] || '')])
  )
}
function send(res, code, data, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(data))
}
function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers })
  res.end()
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

const DEMO_LOGIN_PAGE = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Sign in — demo</title>
<style>body{background:#0e1014;color:#e7ebf2;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#161a21;border:1px solid #272d38;border-radius:12px;padding:28px;max-width:340px;width:100%}
h1{font-size:18px;margin:0 0 6px}p{color:#8b94a3;font-size:13px;margin:0 0 18px}
input{width:100%;background:#1d222b;border:1px solid #272d38;color:#e7ebf2;border-radius:8px;padding:10px 12px;font-size:14px;box-sizing:border-box;margin-bottom:10px}
button{width:100%;background:#4ade80;color:#07120c;border:none;border-radius:8px;padding:10px;font-weight:700;font-size:14px;cursor:pointer}</style>
</head><body><div class="card">
<h1>Sign in with Roblox (demo)</h1>
<p>Local dev stand-in for the real Roblox OAuth screen. Production uses the actual Roblox login.</p>
<form action="/api/roblox/oauth/callback" method="GET">
<input name="username" placeholder="Pick a demo Roblox username" autofocus required pattern="[a-zA-Z0-9_]{3,20}" />
<button type="submit">Continue</button>
</form>
</div></body></html>`

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

  let body = {}
  if (method === 'POST') {
    body = await new Promise((resolve) => {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { resolve({}) } })
    })
  }

  try {
    let m

    // --- Auth (demo stand-in for Roblox OAuth) ---
    if (path === '/api/roblox/oauth/start' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end(DEMO_LOGIN_PAGE)
    }
    if (path === '/api/roblox/oauth/callback' && method === 'GET') {
      const username = (url.searchParams.get('username') || '').trim()
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return redirect(res, '/api/roblox/oauth/start')
      const u = createUser(username)
      const sid = crypto.randomUUID()
      db.sessions.set(sid, u.id)
      return redirect(res, '/', { 'Set-Cookie': `rex_sid=${sid}; Path=/; HttpOnly; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax` })
    }
    if (path === '/api/me' && method === 'GET') {
      const u = sessionUser(req)
      return send(res, 200, { user: u ? { id: u.id, username: u.username, role: u.role } : null })
    }
    if (path === '/api/logout' && method === 'POST') {
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'rex_sid=; Path=/; Max-Age=0' })
    }

    // --- Game marketplace (LOCAL DEMO — no real Roblox ownership check, no
    // real Apirone invoice; check-payment simulates instant payment so the
    // buy -> pay -> admin-finalize flow can be exercised end-to-end offline.
    // Field names are snake_case to match what api/[...path].js returns from
    // raw Postgres rows in production, so the frontend can use one shape. ---
    if (path === '/api/marketplace/listings' && method === 'GET') {
      return send(res, 200, { listings: db.gameListings.filter((l) => l.status === 'active') })
    }
    if ((m = path.match(/^\/api\/marketplace\/listings\/([^/]+)$/)) && method === 'GET') {
      const listing = db.gameListings.find((l) => l.id === m[1])
      if (!listing) return send(res, 404, { error: 'Listing not found' })
      return send(res, 200, { listing })
    }
    if (path === '/api/marketplace/listings' && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const { groupId, placeId, title, description, priceUsdc } = body
      if (!groupId || !placeId) return send(res, 400, { error: 'groupId and placeId are required' })
      if (!title || !(Number(priceUsdc) > 0)) return send(res, 400, { error: 'Title and a positive price are required' })
      const listing = {
        id: crypto.randomUUID(), seller_id: u.id, seller_username: u.username,
        group_id: String(groupId), place_id: String(placeId), universe_id: String(placeId),
        title: title.slice(0, 80), description: (description || '').slice(0, 2000),
        price_usdc: Number(priceUsdc), ccu: Math.floor(Math.random() * 200), visits: Math.floor(Math.random() * 500000),
        favorites: Math.floor(Math.random() * 5000), thumbnail_url: null,
        status: 'active', created_at: new Date().toISOString(),
      }
      db.gameListings.unshift(listing)
      return send(res, 200, { ok: true, id: listing.id })
    }
    if ((m = path.match(/^\/api\/marketplace\/listings\/([^/]+)\/cancel$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const listing = db.gameListings.find((l) => l.id === m[1])
      if (!listing) return send(res, 404, { error: 'Listing not found' })
      if (listing.seller_id !== u.id) return send(res, 400, { error: 'Not your listing' })
      if (listing.status !== 'active') return send(res, 400, { error: 'Listing is not active' })
      listing.status = 'removed'
      return send(res, 200, { ok: true })
    }
    if ((m = path.match(/^\/api\/marketplace\/listings\/([^/]+)\/buy$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const listing = db.gameListings.find((l) => l.id === m[1])
      if (!listing) return send(res, 404, { error: 'Listing not found' })
      if (listing.status !== 'active') return send(res, 400, { error: 'This listing is no longer available' })
      if (listing.seller_id === u.id) return send(res, 400, { error: "You can't buy your own listing" })
      listing.status = 'pending_sale'
      const order = {
        id: crypto.randomUUID(), listing_id: listing.id,
        buyer_id: u.id, buyer_username: u.username, buyer_roblox_id: u.id,
        seller_id: listing.seller_id, seller_username: listing.seller_username,
        price_usdc: listing.price_usdc, invoice_id: 'demo-' + crypto.randomUUID().slice(0, 8),
        pay_address: 'DEMO-ADDRESS-' + crypto.randomUUID().slice(0, 10).toUpperCase(),
        status: 'awaiting_payment', paid_at: null, transfer_deadline: null, completed_at: null, cancelled_at: null,
        created_at: new Date().toISOString(),
      }
      db.gameOrders.unshift(order)
      return send(res, 200, { ok: true, id: order.id, payAddress: order.pay_address, amount: order.price_usdc })
    }
    if ((m = path.match(/^\/api\/marketplace\/orders\/([^/]+)$/)) && method === 'GET') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const order = db.gameOrders.find((o) => o.id === m[1])
      if (!order) return send(res, 404, { error: 'Order not found' })
      if (![order.buyer_id, order.seller_id].includes(u.id) && u.role !== 'admin') return send(res, 403, { error: 'Not your order' })
      return send(res, 200, { order })
    }
    if ((m = path.match(/^\/api\/marketplace\/orders\/([^/]+)\/check-payment$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const order = db.gameOrders.find((o) => o.id === m[1])
      if (!order) return send(res, 404, { error: 'Order not found' })
      if (![order.buyer_id, order.seller_id].includes(u.id) && u.role !== 'admin') return send(res, 403, { error: 'Not your order' })
      if (order.status === 'awaiting_payment') {
        // Demo mode: simulate the payment landing the moment this is checked.
        order.status = 'paid'
        order.paid_at = new Date().toISOString()
        order.transfer_deadline = new Date(Date.now() + 7 * 86400000).toISOString()
      }
      return send(res, 200, { order })
    }
    if ((m = path.match(/^\/api\/marketplace\/orders\/([^/]+)\/cancel$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const order = db.gameOrders.find((o) => o.id === m[1])
      if (!order) return send(res, 404, { error: 'Order not found' })
      if (order.buyer_id !== u.id) return send(res, 400, { error: 'Only the buyer can cancel' })
      if (order.status !== 'awaiting_payment') return send(res, 400, { error: 'This order can no longer be cancelled' })
      order.status = 'cancelled'; order.cancelled_at = new Date().toISOString()
      const listing = db.gameListings.find((l) => l.id === order.listing_id)
      if (listing && listing.status === 'pending_sale') listing.status = 'active'
      return send(res, 200, { ok: true })
    }
    if (path === '/api/marketplace/orders' && method === 'GET') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const box = url.searchParams.get('box') || 'buying'
      const orders = db.gameOrders.filter((o) => (box === 'selling' ? o.seller_id === u.id : o.buyer_id === u.id))
      return send(res, 200, { orders })
    }
    if (path === '/api/marketplace/admin/orders' && method === 'GET') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      if (u.role !== 'admin') return send(res, 403, { error: 'Admin only' })
      return send(res, 200, { orders: db.gameOrders.filter((o) => o.status === 'paid') })
    }
    if ((m = path.match(/^\/api\/marketplace\/orders\/([^/]+)\/finalize$/)) && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      if (u.role !== 'admin') return send(res, 403, { error: 'Admin only' })
      const order = db.gameOrders.find((o) => o.id === m[1])
      if (!order) return send(res, 404, { error: 'Order not found' })
      if (order.status !== 'paid') return send(res, 400, { error: 'Order must be paid before it can be finalized' })
      order.status = 'completed'; order.completed_at = new Date().toISOString()
      const listing = db.gameListings.find((l) => l.id === order.listing_id)
      if (listing) listing.status = 'sold'
      db.walletLedger.unshift({ id: crypto.randomUUID(), user_id: order.seller_id, kind: 'sale', amount_usdc: order.price_usdc, order_id: order.id, status: 'completed', created_at: new Date().toISOString() })
      return send(res, 200, { ok: true })
    }
    if (path === '/api/marketplace/wallet' && method === 'GET') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const ledger = db.walletLedger.filter((l) => l.user_id === u.id)
      const balance = ledger.reduce((s, l) => s + (l.kind === 'sale' && l.status === 'completed' ? l.amount_usdc : (l.kind === 'withdrawal' && l.status !== 'failed' ? -l.amount_usdc : 0)), 0)
      return send(res, 200, { balance, ledger })
    }
    if (path === '/api/marketplace/wallet/withdraw' && method === 'POST') {
      const u = sessionUser(req)
      if (!u) return send(res, 401, { error: 'Not logged in' })
      const { amount, toAddress } = body
      if (!(Number(amount) > 0) || !toAddress) return send(res, 400, { error: 'Amount and destination address are required' })
      const ledger = db.walletLedger.filter((l) => l.user_id === u.id)
      const balance = ledger.reduce((s, l) => s + (l.kind === 'sale' && l.status === 'completed' ? l.amount_usdc : (l.kind === 'withdrawal' && l.status !== 'failed' ? -l.amount_usdc : 0)), 0)
      if (Number(amount) > balance) return send(res, 400, { error: `Amount exceeds your balance ($${balance.toFixed(2)})` })
      db.walletLedger.unshift({ id: crypto.randomUUID(), user_id: u.id, kind: 'withdrawal', amount_usdc: Number(amount), to_address: toAddress, status: 'pending', created_at: new Date().toISOString() })
      return send(res, 200, { ok: true })
    }

    return send(res, 404, { error: `No route: ${method} ${path}` })
  } catch (err) {
    return send(res, 400, { error: err.message || 'Error' })
  }
})

server.listen(PORT, () => console.log(`Roblox Exchange (game marketplace) running on http://localhost:${PORT}`))
