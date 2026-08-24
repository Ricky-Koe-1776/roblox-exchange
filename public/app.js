// Roblox Exchange frontend — vanilla JS SPA. No build step.
// Marketplace for buying/selling whole Roblox games, paid in USDC.

const state = {
  user: null,
  tab: 'browse', // browse | detail | sell | orders | orderDetail | wallet | admin
  mktListings: [],
  mktActiveListing: null,
  mktOrders: [],
  mktOrdersBox: 'buying',
  mktActiveOrder: null,
  mktWallet: { balance: 0, ledger: [] },
  mktAdminOrders: [],
}

const api = {
  async get(p) { const r = await fetch(p, { credentials: 'include' }); return r.json() },
  async post(p, body) {
    const r = await fetch(p, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error || 'Error')
    return d
  },
}

function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild }
function toast(msg, kind = 'ok') {
  const t = document.createElement('div')
  t.className = `toast ${kind}`
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2600)
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
function fmtUsd(n) { return `$${Number(n || 0).toFixed(2)}` }

// ── Data loaders ──────────────────────────────────────────────────────────────
async function refresh() {
  if (state.tab === 'browse') state.mktListings = (await api.get('/api/marketplace/listings')).listings
  if (state.tab === 'orders') state.mktOrders = state.user ? (await api.get(`/api/marketplace/orders?box=${state.mktOrdersBox}`)).orders : []
  if (state.tab === 'wallet') state.mktWallet = state.user ? await api.get('/api/marketplace/wallet') : { balance: 0, ledger: [] }
  if (state.tab === 'admin') state.mktAdminOrders = state.user?.role === 'admin' ? (await api.get('/api/marketplace/admin/orders')).orders : []
  render()
}

async function openListing(id) {
  state.tab = 'detail'; state.mktActiveListing = null
  render()
  try { state.mktActiveListing = (await api.get(`/api/marketplace/listings/${id}`)).listing }
  catch (e) { toast(e.message, 'bad') }
  render()
}

async function openOrder(id) {
  state.tab = 'orderDetail'; state.mktActiveOrder = null
  render()
  try { state.mktActiveOrder = (await api.get(`/api/marketplace/orders/${id}`)).order }
  catch (e) { toast(e.message, 'bad') }
  render()
}

// ── Shell ─────────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app')
  app.innerHTML = ''
  app.appendChild(header())
  if (!state.user) { app.appendChild(loginView()); return }
  const wrap = el('<div class="wrap"></div>')
  wrap.appendChild(tabs())
  wrap.appendChild(
    state.tab === 'detail' ? listingDetailView()
      : state.tab === 'sell' ? sellView()
      : state.tab === 'orders' ? ordersListView()
      : state.tab === 'orderDetail' ? orderDetailView()
      : state.tab === 'wallet' ? walletView()
      : state.tab === 'admin' ? adminView()
      : browseView()
  )
  app.appendChild(wrap)
}

function header() {
  const h = el(`<header><div class="wrap"><div class="nav">
    <div class="logo">Roblox<span>Exchange</span></div>
    <div id="userArea"></div>
  </div></div></header>`)
  const ua = h.querySelector('#userArea')
  if (state.user) {
    ua.innerHTML = `${state.user.avatar ? `<img class="nav-avatar" src="${state.user.avatar}" alt="" onerror="this.style.display='none'">` : ''}<span class="who">Signed in as <b>${escHtml(state.user.username)}</b></span>`
    const btn = el('<button class="btn ghost" style="margin-left:12px">Logout</button>')
    btn.onclick = async () => { await api.post('/api/logout'); state.user = null; render() }
    ua.appendChild(btn)
  } else {
    ua.appendChild(el('<a class="btn" href="/api/roblox/oauth/start">Sign in with Roblox</a>'))
  }
  return h
}

function tabs() {
  const t = el('<div class="tabs"></div>')
  const defs = [['browse', 'Browse Games'], ['sell', 'Sell Your Game'], ['orders', 'My Orders'], ['wallet', 'Wallet']]
  if (state.user?.role === 'admin') defs.push(['admin', 'Admin: Finalize'])
  defs.forEach(([id, label]) => {
    const active = state.tab === id || (state.tab === 'detail' && id === 'browse') || (state.tab === 'orderDetail' && id === 'orders')
    const d = el(`<div class="tab ${active ? 'active' : ''}">${label}</div>`)
    d.onclick = () => { state.tab = id; refresh() }
    t.appendChild(d)
  })
  return t
}

function loginView() {
  const err = new URLSearchParams(location.search).get('error') === 'oauth'
  const v = el('<div class="wrap"></div>')

  v.appendChild(el(`<div class="hero">
    <h1>The marketplace for Roblox game acquisitions.</h1>
    <p>Buy and sell whole Roblox games. Every listing is ownership-verified against Roblox's own records, and every payment sits in USDC escrow until the transfer is confirmed — the seller never gets paid upfront.</p>
    <div class="hero-ctas">
      <a class="btn" href="/api/roblox/oauth/start">Sign in with Roblox</a>
      <a class="btn ghost" href="#listings">Browse Listings</a>
    </div>
    ${err ? '<p class="fine" style="color:var(--danger);margin-top:14px">Sign-in failed — please try again.</p>' : ''}
  </div>`))

  v.appendChild(el(`<div class="trust-row">
    <div class="trust-item">
      <div class="trust-title">Ownership Verified</div>
      <div class="trust-sub">Every seller is checked against Roblox's own group-ownership records before a listing goes live.</div>
    </div>
    <div class="trust-item">
      <div class="trust-title">USDC Escrow</div>
      <div class="trust-sub">Your payment is held the moment you pay — never sent to the seller until the game is actually transferred.</div>
    </div>
    <div class="trust-item">
      <div class="trust-title">Manually Verified Transfers</div>
      <div class="trust-sub">A real person confirms the Roblox ownership change before any payout is released — not an automated guess.</div>
    </div>
  </div>`))

  v.appendChild(el('<h2 class="section-h">How it works</h2>'))
  const steps = el('<div class="hiw-steps"></div>')
  ;[
    ['1', 'Sign in with Roblox', "Connect instantly with Roblox's own login — no password, ever."],
    ['2', 'Buy with USDC', 'Your payment is held in escrow the moment you pay, not sent to the seller.'],
    ['3', 'Get the game', 'Once the Roblox ownership transfer is verified, the deal is done and funds release.'],
  ].forEach(([n, t, s]) => steps.appendChild(el(`<div class="hiw-step"><div class="hiw-num">${n}</div><div><div class="hiw-title">${t}</div><div class="hiw-sub">${s}</div></div></div>`)))
  v.appendChild(steps)

  v.appendChild(el('<h2 class="section-h" id="listings">Recently listed</h2>'))
  if (!state.mktListings.length) {
    v.appendChild(el('<div class="empty">No games listed yet — sign in to be the first to sell one.</div>'))
  } else {
    const grid = el('<div class="listing-grid"></div>')
    state.mktListings.slice(0, 6).forEach((l) => {
      const card = el(`<div class="listing-card">
        ${l.thumbnail_url ? `<img class="listing-thumb" src="${l.thumbnail_url}" onerror="this.style.display='none'">` : '<div class="listing-thumb-ph"></div>'}
        <div class="listing-body">
          <div class="listing-title">${escHtml(l.title)}</div>
          <div class="listing-price">${fmtUsd(l.price_usdc)}</div>
          <div class="listing-stats"><span>${l.ccu} CCU</span><span>${Number(l.visits).toLocaleString()} visits</span><span>${l.favorites} favs</span></div>
        </div>
      </div>`)
      card.onclick = () => { location.href = '/api/roblox/oauth/start' }
      grid.appendChild(card)
    })
    v.appendChild(grid)
    v.appendChild(el('<p class="fine" style="text-align:center;margin-top:14px">Sign in to view full details or buy.</p>'))
  }

  v.appendChild(el(`<div class="card login" style="margin:40px auto 60px">
    <a class="btn" href="/api/roblox/oauth/start">Sign in with Roblox</a>
    <p class="fine">We use Roblox's own sign-in — no password, ever.</p>
  </div>`))
  return v
}

// ── Browse ────────────────────────────────────────────────────────────────────
function browseView() {
  const c = el('<div></div>')
  if (!state.mktListings.length) { c.appendChild(el('<div class="empty">No games listed yet. Be the first to sell one.</div>')); return c }
  const grid = el('<div class="listing-grid"></div>')
  state.mktListings.forEach((l) => {
    const card = el(`<div class="listing-card">
      ${l.thumbnail_url ? `<img class="listing-thumb" src="${l.thumbnail_url}" onerror="this.style.display='none'">` : '<div class="listing-thumb-ph"></div>'}
      <div class="listing-body">
        <div class="listing-title">${escHtml(l.title)}</div>
        <div class="listing-price">${fmtUsd(l.price_usdc)}</div>
        <div class="listing-stats"><span>${l.ccu} CCU</span><span>${Number(l.visits).toLocaleString()} visits</span><span>${l.favorites} favs</span></div>
      </div>
    </div>`)
    card.onclick = () => openListing(l.id)
    grid.appendChild(card)
  })
  c.appendChild(grid)
  return c
}

// ── Listing detail / buy ─────────────────────────────────────────────────────
function listingDetailView() {
  const c = el('<div></div>')
  const back = el('<button class="btn ghost" style="margin-bottom:16px">← Back to Browse</button>')
  back.onclick = () => { state.tab = 'browse'; refresh() }
  c.appendChild(back)
  const l = state.mktActiveListing
  if (!l) { c.appendChild(el('<div class="empty">Loading…</div>')); return c }

  const grid = el('<div class="listing-detail"></div>')
  const left = el('<div></div>')
  left.appendChild(el(l.thumbnail_url ? `<img class="listing-detail-thumb" src="${l.thumbnail_url}" onerror="this.style.display='none'">` : '<div class="listing-detail-thumb-ph"></div>'))
  left.appendChild(el(`<h2 style="margin-top:16px">${escHtml(l.title)}</h2>`))
  left.appendChild(el(`<div class="listing-stats" style="margin-top:8px;font-size:13px">
    <span>${l.ccu} playing now</span><span>${Number(l.visits).toLocaleString()} visits</span><span>${l.favorites} favorites</span>
  </div>`))
  left.appendChild(el(`<div class="listing-desc">${escHtml(l.description || 'No description provided.')}</div>`))
  left.appendChild(el(`<div class="muted" style="font-size:13px">Listed by <b>${escHtml(l.seller_username)}</b> · Roblox group ${escHtml(l.group_id)}</div>`))
  grid.appendChild(left)

  const right = el('<div class="buy-box"></div>')
  right.appendChild(el(`<div class="buy-price">${fmtUsd(l.price_usdc)}</div>`))
  right.appendChild(el('<div class="buy-sub">Paid in USDC. Funds are held until an admin confirms the Roblox group ownership transfer.</div>'))
  if (l.status !== 'active') {
    right.appendChild(el(`<div class="empty" style="padding:10px 0">This listing is ${escHtml(l.status)}.</div>`))
  } else if (l.seller_id === state.user.id) {
    right.appendChild(el('<div class="empty" style="padding:10px 0">This is your listing.</div>'))
    const cancel = el('<button class="btn danger" style="width:100%">Remove Listing</button>')
    cancel.onclick = async () => {
      try { await api.post(`/api/marketplace/listings/${l.id}/cancel`); toast('Listing removed'); state.tab = 'browse'; await refresh() }
      catch (e) { toast(e.message, 'bad') }
    }
    right.appendChild(cancel)
  } else {
    const buy = el('<button class="btn" style="width:100%">Buy Now</button>')
    buy.onclick = async () => {
      try {
        const d = await api.post(`/api/marketplace/listings/${l.id}/buy`)
        toast('Order created — send payment to continue')
        await openOrder(d.id)
      } catch (e) { toast(e.message, 'bad') }
    }
    right.appendChild(buy)
  }
  grid.appendChild(right)
  c.appendChild(grid)
  return c
}

// ── Sell ──────────────────────────────────────────────────────────────────────
function sellView() {
  const c = el('<div></div>')
  const form = el(`<div class="card sell-form" style="max-width:560px">
    <h2 style="margin-bottom:4px">Sell Your Game</h2>
    <p class="muted" style="font-size:13px">Games are sold via Roblox group-ownership transfer — the game must be owned by a group you're the OWNER of (not just admin).</p>
    <label>Roblox Group ID</label>
    <input id="sGroup" placeholder="e.g. 1234567" />
    <div class="sell-hint">The numeric ID from the group's Roblox page URL. You must be the group's owner.</div>
    <label>Roblox Place ID</label>
    <input id="sPlace" placeholder="e.g. 9876543" />
    <div class="sell-hint">The numeric ID from the game's Roblox page URL. Used to pull live CCU/visits/favorites.</div>
    <label>Title</label>
    <input id="sTitle" maxlength="80" placeholder="Game title" />
    <label>Description</label>
    <textarea id="sDesc" maxlength="2000" placeholder="What's included, why it's worth it..."></textarea>
    <label>Price (USDC)</label>
    <input id="sPrice" type="number" min="1" step="0.01" placeholder="500" />
    <button class="btn" id="sSubmit" style="width:100%;margin-top:18px">List Game</button>
  </div>`)
  form.querySelector('#sSubmit').onclick = async () => {
    const groupId = form.querySelector('#sGroup').value.trim()
    const placeId = form.querySelector('#sPlace').value.trim()
    const title = form.querySelector('#sTitle').value.trim()
    const description = form.querySelector('#sDesc').value.trim()
    const priceUsdc = form.querySelector('#sPrice').value.trim()
    try {
      await api.post('/api/marketplace/listings', { groupId, placeId, title, description, priceUsdc })
      toast('Game listed!')
      state.tab = 'browse'; await refresh()
    } catch (e) { toast(e.message, 'bad') }
  }
  c.appendChild(form)
  return c
}

// ── Orders ────────────────────────────────────────────────────────────────────
function ordersListView() {
  const c = el('<div></div>')
  const toggle = el(`<div class="mkt-subtabs" style="max-width:380px;margin-bottom:14px">
    <div class="mkt-subtab ${state.mktOrdersBox === 'buying' ? 'active' : ''}" data-b="buying">Buying</div>
    <div class="mkt-subtab ${state.mktOrdersBox === 'selling' ? 'active' : ''}" data-b="selling">Selling</div></div>`)
  toggle.querySelectorAll('.mkt-subtab').forEach((x) => { x.onclick = () => { state.mktOrdersBox = x.dataset.b; refresh() } })
  c.appendChild(toggle)
  if (!state.mktOrders.length) { c.appendChild(el('<div class="empty">No orders yet.</div>')); return c }
  state.mktOrders.forEach((o) => {
    const card = el(`<div class="order-card">
      <div class="order-card-top"><b>${fmtUsd(o.price_usdc)}</b><span class="status-chip status-${o.status}">${o.status.replace('_', ' ')}</span></div>
      <div class="muted" style="font-size:13px">${state.mktOrdersBox === 'buying' ? 'Seller: ' + escHtml(o.seller_username) : 'Buyer: ' + escHtml(o.buyer_username)}</div>
    </div>`)
    card.onclick = () => openOrder(o.id)
    c.appendChild(card)
  })
  return c
}

let _orderPollTimer = null
function orderDetailView() {
  clearTimeout(_orderPollTimer)
  const c = el('<div></div>')
  const back = el('<button class="btn ghost" style="margin-bottom:16px">← Back to Orders</button>')
  back.onclick = () => { clearTimeout(_orderPollTimer); state.tab = 'orders'; refresh() }
  c.appendChild(back)

  const o = state.mktActiveOrder
  if (!o) { c.appendChild(el('<div class="empty">Loading…</div>')); return c }

  const card = el(`<div class="card" style="max-width:560px">
    <div class="order-card-top"><h2 style="margin:0">${fmtUsd(o.price_usdc)}</h2><span class="status-chip status-${o.status}">${o.status.replace('_', ' ')}</span></div>
  </div>`)

  const steps = [
    { title: 'Payment', sub: 'Buyer sends USDC to the order address.' },
    { title: 'Ownership transfer', sub: 'Seller transfers the Roblox group to the buyer. An admin confirms and releases payout.' },
    { title: 'Done', sub: "Payout released to the seller's wallet." },
  ]
  const orderKeys = ['awaiting_payment', 'paid', 'completed']
  const curIdx = orderKeys.indexOf(o.status)
  if (curIdx >= 0) {
    const track = el('<div class="order-track"></div>')
    steps.forEach((s, i) => {
      const cls = i < curIdx ? 'done' : i === curIdx ? 'active' : ''
      track.appendChild(el(`<div class="order-step ${cls}">
        <div class="order-dot">${i < curIdx ? '✓' : i + 1}</div>
        <div><div class="order-step-title">${s.title}</div><div class="order-step-sub">${s.sub}</div></div>
      </div>`))
    })
    card.appendChild(track)
  }

  if (o.status === 'awaiting_payment' && state.user?.id === o.buyer_id) {
    card.appendChild(el('<div class="sell-hint">Send exactly this amount in USDC to:</div>'))
    card.appendChild(el(`<div class="pay-address">${escHtml(o.pay_address || 'generating…')}</div>`))
    const row = el('<div class="row" style="margin-top:12px;gap:10px"></div>')
    const check = el('<button class="btn">I&rsquo;ve Paid — Check Status</button>')
    check.onclick = async () => {
      try {
        const d = await api.post(`/api/marketplace/orders/${o.id}/check-payment`)
        state.mktActiveOrder = d.order
        toast(d.order.status === 'paid' ? 'Payment received!' : 'Not received yet — try again shortly')
        render()
      } catch (e) { toast(e.message, 'bad') }
    }
    const cancelBtn = el('<button class="btn danger">Cancel Order</button>')
    cancelBtn.onclick = async () => {
      try { await api.post(`/api/marketplace/orders/${o.id}/cancel`); toast('Order cancelled'); state.tab = 'orders'; await refresh() }
      catch (e) { toast(e.message, 'bad') }
    }
    row.appendChild(check); row.appendChild(cancelBtn)
    card.appendChild(row)
  } else if (o.status === 'awaiting_payment') {
    card.appendChild(el('<div class="sell-hint">Waiting for the buyer to pay.</div>'))
  }

  if (o.status === 'paid') {
    const who = state.user?.id === o.seller_id ? 'You' : 'The seller'
    card.appendChild(el(`<div class="sell-hint">${who} should transfer the Roblox group to the buyer's connected account now.${o.transfer_deadline ? ` Window ends ${new Date(o.transfer_deadline).toLocaleString()}.` : ''} An admin will verify the transfer and release the payout — this page updates automatically once that happens.</div>`))
  }
  if (o.status === 'completed') card.appendChild(el('<div class="sell-hint">Completed. Payout was released to the seller&rsquo;s wallet.</div>'))
  if (o.status === 'cancelled') card.appendChild(el('<div class="sell-hint">This order was cancelled.</div>'))

  c.appendChild(card)

  // Lightweight read-only poll so buyer/seller see the admin's finalize in near real time.
  if (['awaiting_payment', 'paid'].includes(o.status)) {
    _orderPollTimer = setTimeout(async () => {
      try {
        const d = await api.get(`/api/marketplace/orders/${o.id}`)
        state.mktActiveOrder = d.order
        if (state.tab === 'orderDetail') render()
      } catch {}
    }, 5000)
  }
  return c
}

// ── Wallet ────────────────────────────────────────────────────────────────────
function walletView() {
  const c = el('<div></div>')
  const w = state.mktWallet
  const card = el(`<div class="card" style="max-width:560px">
    <div class="muted" style="font-size:13px">Available balance</div>
    <div class="wallet-balance">${fmtUsd(w.balance)}</div>
    <label style="display:block;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-bottom:6px;font-weight:700">Withdraw to address</label>
    <input id="wAddr" placeholder="Your USDC wallet address" style="width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px 12px;margin-bottom:10px" />
    <input id="wAmt" type="number" min="1" step="0.01" placeholder="Amount" style="width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px 12px;margin-bottom:10px" />
    <button class="btn" id="wSubmit" style="width:100%">Request Withdrawal</button>
  </div>`)
  card.querySelector('#wSubmit').onclick = async () => {
    const toAddress = card.querySelector('#wAddr').value.trim()
    const amount = card.querySelector('#wAmt').value.trim()
    try {
      await api.post('/api/marketplace/wallet/withdraw', { amount, toAddress })
      toast('Withdrawal requested')
      await refresh()
    } catch (e) { toast(e.message, 'bad') }
  }
  c.appendChild(card)
  c.appendChild(el('<h3 style="margin:22px 0 12px">History</h3>'))
  if (!w.ledger?.length) { c.appendChild(el('<div class="empty">No wallet activity yet.</div>')); return c }
  w.ledger.forEach((l) => {
    const pos = l.kind === 'sale'
    c.appendChild(el(`<div class="ledger-row">
      <span>${pos ? 'Sale payout' : 'Withdrawal'}${l.status !== 'completed' ? ` (${l.status})` : ''}</span>
      <span class="ledger-amt ${pos ? 'pos' : 'neg'}">${pos ? '+' : '-'}${fmtUsd(l.amount_usdc)}</span>
    </div>`))
  })
  return c
}

// ── Admin ─────────────────────────────────────────────────────────────────────
function adminView() {
  const c = el('<div></div>')
  if (state.user?.role !== 'admin') { c.appendChild(el('<div class="empty">Admin only.</div>')); return c }
  c.appendChild(el("<p class=\"muted\" style=\"margin-bottom:16px\">Orders here are paid and waiting for you to confirm the Roblox group ownership actually transferred to the buyer before releasing the seller's payout.</p>"))
  if (!state.mktAdminOrders.length) { c.appendChild(el('<div class="empty">Nothing waiting on finalization.</div>')); return c }
  state.mktAdminOrders.forEach((o) => {
    const card = el(`<div class="order-card" style="cursor:default">
      <div class="order-card-top"><b>${fmtUsd(o.price_usdc)}</b><span class="status-chip status-${o.status}">${o.status}</span></div>
      <div class="muted" style="font-size:13px">Buyer: ${escHtml(o.buyer_username)} → Seller: ${escHtml(o.seller_username)}</div>
      <div class="muted" style="font-size:12px;margin-top:4px">Paid ${o.paid_at ? new Date(o.paid_at).toLocaleString() : ''}</div>
    </div>`)
    const btn = el('<button class="btn" style="margin-top:8px">Verify Transfer &amp; Finalize</button>')
    btn.onclick = async () => {
      try { await api.post(`/api/marketplace/orders/${o.id}/finalize`); toast('Order finalized — seller paid out'); await refresh() }
      catch (e) { toast(e.message, 'bad') }
    }
    card.appendChild(btn)
    c.appendChild(card)
  })
  return c
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  state.user = (await api.get('/api/me')).user
  if (state.user) { await refresh(); return }
  state.mktListings = (await api.get('/api/marketplace/listings')).listings
  render()
}
boot()
