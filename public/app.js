// Roblox Exchange frontend. Vanilla JS SPA, no build step.
// Hash routes: #/  #/game/:id  #/sell  #/orders  #/order/:id  #/wallet  #/admin  #/signin

const state = {
  user: null,
  listings: [],
  listingsLoaded: false,
  market: { q: '', price: 'all', sort: 'playing', shown: 40, view: 'grid' },
  ordersBox: 'buying',
  signin: { username: '', phrase: '', busy: false },
}

const api = {
  async get(p) {
    const r = await fetch(p, { credentials: 'include' })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || 'Something went wrong')
    return d
  },
  async post(p, body) {
    const r = await fetch(p, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.error || 'Something went wrong')
    return d
  },
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild }
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const usd = (n) => {
  const v = Number(n || 0)
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })
}
const usd2 = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const compact = (n) => {
  const v = Number(n || 0)
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1e4) return (v / 1e3).toFixed(0) + 'K'
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
  return v.toLocaleString('en-US')
}
// Some imported text arrives with escaped newlines/quotes ("\\n"); show them as real characters.
const cleanText = (s) => String(s || '').replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"').trim()
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash }
function toast(msg, kind = 'ok') {
  document.querySelectorAll('.toast').forEach((t) => t.remove())
  const t = el(`<div class="toast ${kind}" role="status">${esc(msg)}</div>`)
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 3200)
}
const thumb = (l, cls = '') => l.thumbnail_url
  ? `<img class="${cls}" src="${esc(l.thumbnail_url)}" alt="" width="512" height="512" ${cls === 'eager' ? 'fetchpriority="high"' : 'loading="lazy"'} onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg'}))">`
  : '<div class="noimg"></div>'
const HOUSE_ID = 'house-roblox-exchange'
const statusLabel = { awaiting_payment: 'Awaiting payment', paid: 'Paid, transfer pending', completed: 'Completed', cancelled: 'Cancelled', refunded: 'Refunded' }
const icon = (name) => `<i class="ph ph-${name}" aria-hidden="true"></i>`
const cardHtml = (l, i = 0) => `<a class="card rise" style="--i:${Math.min(i, 11)}" href="#/game/${encodeURIComponent(l.id)}">
  <div class="card-img">${thumb(l)}</div>
  <div class="card-body"><div class="card-title">${esc(l.title)}</div>
    <div class="card-meta"><span title="Playing now">${icon('users')}${compact(l.ccu)}</span><span title="Visits">${icon('eye')}${compact(l.visits)}</span><span title="Favorites">${icon('heart')}${compact(l.favorites)}</span></div>
    <div class="card-price">${usd(l.price_usdc)}</div></div>
</a>`
const skeletonGrid = (n = 10) => `<div class="grid" aria-busy="true" aria-label="Loading games">${Array.from({ length: n }, () => `<div class="card sk-card"><div class="card-img sk"></div><div class="card-body"><div class="sk sk-line" style="width:80%"></div><div class="sk sk-line" style="width:55%"></div><div class="sk sk-line" style="width:35%;height:18px;margin-top:8px"></div></div></div>`).join('')}</div>`

async function loadListings(force = false) {
  if (state.listingsLoaded && !force) return
  state.listings = (await api.get('/api/marketplace/listings')).listings || []
  state.listingsLoaded = true
}

// ── Shell ────────────────────────────────────────────────────────────────────
let pollTimer = null
function shell(active, content) {
  const app = document.getElementById('app')
  app.innerHTML = ''
  const links = [['market', '#/', 'Browse'], ['sell', '#/sell', 'Sell a game'], ['orders', '#/orders', 'Orders'], ['wallet', '#/wallet', 'Wallet']]
  if (state.user?.role === 'admin') links.push(['admin', '#/admin', 'Admin'])
  const top = el(`<header class="topbar"><div class="wrap">
    <a class="brand" href="#/" translate="no"><span class="brand-mark" aria-hidden="true">RE</span>Roblox Exchange</a>
    <nav class="nav">${links.map(([k, h, t]) => `<a href="${h}" class="${active === k ? 'on' : ''}">${t}</a>`).join('')}</nav>
    <div class="me"></div>
  </div></header>`)
  const me = top.querySelector('.me')
  if (state.user) {
    me.innerHTML = `${state.user.avatar ? `<img src="${esc(state.user.avatar)}" alt="">` : ''}<span class="me-name">${esc(state.user.username)}</span>`
    const out = el('<button class="btn quiet sm">Sign out</button>')
    out.onclick = async () => { await api.post('/api/logout').catch(() => {}); state.user = null; toast('Signed out'); route() }
    me.appendChild(out)
  } else {
    me.appendChild(el('<a class="btn sm" href="#/signin">Sign in</a>'))
  }
  app.appendChild(top)
  app.appendChild(content)
  app.appendChild(el(`<footer><div class="wrap">
    <span>Roblox Exchange. Not affiliated with Roblox Corporation.</span>
    <span>Payments in USDC, held until each group transfer is confirmed.</span>
  </div></footer>`))
}

function gate(title, text) {
  const v = el(`<main id="main" class="page"><div class="wrap"><div class="panel gate narrow" style="margin:0 auto">
    <h2>${title}</h2><p>${text}</p><a class="btn go lg" href="#/signin">Sign in with your Roblox username</a>
  </div></div></main>`)
  state.returnTo = location.hash
  return v
}

// ── Market (home) ────────────────────────────────────────────────────────────
const PRICE_BANDS = [
  ['all', 'Any price', () => true],
  ['u100', 'Under $100', (p) => p < 100],
  ['100-1k', '$100 to $1K', (p) => p >= 100 && p < 1000],
  ['1k-10k', '$1K to $10K', (p) => p >= 1000 && p < 10000],
  ['10k', '$10K+', (p) => p >= 10000],
]
const SORTS = {
  playing: ['Most players now', (a, b) => b.ccu - a.ccu],
  visits: ['Most visits', (a, b) => b.visits - a.visits],
  favs: ['Most favorites', (a, b) => b.favorites - a.favorites],
  price_asc: ['Price, low to high', (a, b) => a.price_usdc - b.price_usdc],
  price_desc: ['Price, high to low', (a, b) => b.price_usdc - a.price_usdc],
  newest: ['Newest', (a, b) => new Date(b.created_at) - new Date(a.created_at)],
}
function filtered() {
  const { q, price, sort } = state.market
  const band = PRICE_BANDS.find((b) => b[0] === price)[2]
  const needle = q.trim().toLowerCase()
  return state.listings
    .map((l) => ({ ...l, price_usdc: Number(l.price_usdc), ccu: Number(l.ccu || 0), visits: Number(l.visits || 0), favorites: Number(l.favorites || 0) }))
    .filter((l) => band(l.price_usdc) && (!needle || l.title.toLowerCase().includes(needle)))
    .sort(SORTS[sort][1])
}

function marketView() {
  const L = state.listings
  const players = L.reduce((s, l) => s + Number(l.ccu || 0), 0)
  const prices = L.map((l) => Number(l.price_usdc)).sort((a, b) => a - b)
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : 0
  const top = [...L].sort((a, b) => Number(b.ccu || 0) - Number(a.ccu || 0)).slice(0, 3)

  const v = el('<main id="main"></main>')
  // Animate the hero copy only on the first paint; the view re-renders once listings arrive.
  const heroAnim = state.heroShown ? '' : 'rise'
  state.heroShown = true
  const tile = (l, big) => `<a class="tile ${big ? 'big' : ''}" href="#/game/${encodeURIComponent(l.id)}">
    <div class="tile-img">${thumb(l, big ? 'eager' : '')}</div>
    <div class="tile-cap"><div style="min-width:0"><div class="t">${esc(l.title)}</div><div class="s">${compact(l.ccu)} playing now</div></div><div class="p">${usd(l.price_usdc)}</div></div>
  </a>`
  v.appendChild(el(`<div class="wrap"><section class="hero">
    <div>
      <h1 class="${heroAnim}">Roblox games with <em>real players.</em></h1>
      <p class="${heroAnim}" style="--i:1">Live player counts, visits and prices on every listing. Pay in USDC, held until the group is yours.</p>
      <div class="hero-ctas ${heroAnim}" style="--i:2">
        <a class="btn go lg" href="#market">Browse games</a>
        <a class="btn quiet lg" href="#/sell">Sell a game</a>
      </div>
    </div>
    ${top.length >= 3 ? `<div class="bento rise" style="--i:2" aria-label="Most played games for sale">${tile(top[0], true)}${tile(top[1])}${tile(top[2])}</div>` : `<div class="bento">${skeletonGrid(0)}</div>`}
  </section></div>`))
  v.appendChild(el(`<section class="band" aria-label="Market numbers"><div class="wrap">
    <div><div class="v">${L.length.toLocaleString()}</div><div class="k">games for sale</div></div>
    <div><div class="v">${players.toLocaleString()}</div><div class="k">people playing them now</div></div>
    <div><div class="v">${usd(median)}</div><div class="k">median asking price</div></div>
  </div></section>`))

  const sec = el(`<section class="wrap" id="market" style="padding-top:clamp(40px,5vw,72px);padding-bottom:clamp(56px,7vw,96px)"></section>`)
  sec.appendChild(el(`<div class="market-head"><h2 class="section-title">Games for sale</h2><span class="count" id="count"></span></div>`))
  const controls = el(`<div class="controls">
    <div class="view-toggle" role="group" aria-label="View"><button data-v="grid" aria-label="Grid view" class="${state.market.view === 'grid' ? 'on' : ''}">${icon('squares-four')}</button><button data-v="list" aria-label="List view" class="${state.market.view === 'list' ? 'on' : ''}">${icon('list')}</button></div>
    <label class="search"><span class="sr">Search games</span>${icon('magnifying-glass')}<input class="input" id="q" type="search" placeholder="Search by game title…" autocomplete="off" spellcheck="false" value="${esc(state.market.q)}"></label>
    <select class="input" id="sort" aria-label="Sort">${Object.entries(SORTS).map(([k, [t]]) => `<option value="${k}" ${state.market.sort === k ? 'selected' : ''}>${t}</option>`).join('')}</select>
  </div>`)
  const chips = el(`<div class="chips" style="margin-bottom:16px">${PRICE_BANDS.map(([k, t]) => `<button class="chip ${state.market.price === k ? 'on' : ''}" data-k="${k}">${t}</button>`).join('')}</div>`)
  sec.appendChild(controls)
  sec.appendChild(chips)
  const tableWrap = el('<div></div>')
  sec.appendChild(tableWrap)
  v.appendChild(sec)
  v.appendChild(el(`<div class="wrap"><section class="how" aria-labelledby="how-h">
    <h2 id="how-h">How buying works</h2>
    <ol class="how-list">
      <li><span class="ic">${icon('magnifying-glass')}</span><div><b>Compare the numbers</b><p>Players, visits and favorites come straight from Roblox, so you can judge a game before you open the listing.</p></div></li>
      <li><span class="ic">${icon('lock-simple')}</span><div><b>Pay in USDC</b><p>You get an address for the exact amount. The money is held and the seller is not paid yet.</p></div></li>
      <li><span class="ic">${icon('users-three')}</span><div><b>Take over the group</b><p>The group that owns the game is transferred to your Roblox account. A person checks the transfer, then the sale closes.</p></div></li>
    </ol>
  </section>
  <section class="sellband">
    <div><h2>Own a game with players?</h2><p>List it with live stats pulled from Roblox and get paid in USDC once the transfer is confirmed.</p></div>
    <a class="btn lg" href="#/sell">Sell a game</a>
  </section></div>`))

  const head = (key, label, cls = '') => `<div class="${cls}"><button data-sort="${key}" class="${state.market.sort === key || (key === 'price' && state.market.sort.startsWith('price')) ? 'on' : ''}">${label}</button></div>`
  function drawTable() {
    const rows = filtered()
    sec.querySelector('#count').textContent = `${rows.length.toLocaleString()} ${rows.length === 1 ? 'game' : 'games'}`
    tableWrap.innerHTML = ''
    if (!state.listingsLoaded) { tableWrap.appendChild(el(skeletonGrid(10))); return }
    if (!rows.length) {
      tableWrap.appendChild(el(`<div class="table"><div class="empty"><b>No games match.</b>${state.listings.length ? 'Try a different search or price range.' : 'Nothing is listed yet.'}</div></div>`))
      return
    }
    if (state.market.view === 'grid') {
      const g = el('<div class="grid"></div>')
      const from = g.childElementCount
      rows.slice(0, state.market.shown).forEach((l, i) => g.appendChild(el(cardHtml(l, i - from))))
      tableWrap.appendChild(g)
      return addMore(rows)
    }
    const t = el(`<div class="table" role="table">
      <div class="trow th" role="row">
        <div>Game</div>${head('playing', 'Playing', 'r c-play')}${head('visits', 'Visits', 'r c-visits')}${head('favs', 'Favorites', 'r c-favs')}${head('price', 'Price', 'r')}
      </div></div>`)
    rows.slice(0, state.market.shown).forEach((l) => {
      t.appendChild(el(`<a class="trow" role="row" href="#/game/${encodeURIComponent(l.id)}">
        <div class="game">${thumb(l)}<div style="min-width:0"><div class="game-title">${esc(l.title)}</div>
          <div class="game-sub num">${compact(l.ccu)} playing · ${compact(l.visits)} visits</div></div></div>
        <div class="cell r c-play">${l.ccu.toLocaleString()}</div>
        <div class="cell r c-visits">${compact(l.visits)}</div>
        <div class="cell r c-favs">${compact(l.favorites)}</div>
        <div class="cell r price">${usd(l.price_usdc)}</div>
      </a>`))
    })
    t.querySelectorAll('[data-sort]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.sort
        state.market.sort = k === 'price' ? (state.market.sort === 'price_asc' ? 'price_desc' : 'price_asc') : k
        controls.querySelector('#sort').value = state.market.sort
        drawTable()
      }
    })
    tableWrap.appendChild(t)
    addMore(rows)
  }
  function addMore(rows) {
    if (rows.length > state.market.shown) {
      const more = el(`<div class="more"><button class="btn quiet">Show more (${(rows.length - state.market.shown).toLocaleString()} left)</button></div>`)
      more.querySelector('button').onclick = () => { state.market.shown += 40; drawTable() }
      tableWrap.appendChild(more)
    }
  }
  controls.querySelectorAll('.view-toggle button').forEach((b) => {
    b.onclick = () => {
      state.market.view = b.dataset.v
      try { localStorage.setItem('rex_view', b.dataset.v) } catch {}
      controls.querySelectorAll('.view-toggle button').forEach((x) => x.classList.toggle('on', x === b))
      drawTable()
    }
  })
  controls.querySelector('#q').oninput = (e) => { state.market.q = e.target.value; state.market.shown = 40; drawTable() }
  controls.querySelector('#sort').onchange = (e) => { state.market.sort = e.target.value; drawTable() }
  chips.querySelectorAll('.chip').forEach((c) => {
    c.onclick = () => {
      state.market.price = c.dataset.k; state.market.shown = 40
      chips.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c))
      drawTable()
    }
  })
  v.querySelector('a[href="#market"]').onclick = (e) => { e.preventDefault(); sec.scrollIntoView({ behavior: 'smooth' }) }
  drawTable()
  return v
}

// ── Game detail ──────────────────────────────────────────────────────────────
function gameView(l) {
  const v = el('<main id="main" class="page"><div class="wrap"></div></main>')
  const w = v.firstElementChild
  w.appendChild(el(`<a class="back" href="#/">${icon('arrow-left')} All games</a>`))
  if (!l) { w.appendChild(el('<div class="panel empty"><b>Listing not found.</b>It may have sold or been removed.</div>')); return v }

  const grid = el('<div class="detail"></div>')
  const left = el(`<div>
    <div class="detail-top">${thumb(l)}
      <div style="min-width:0"><h1>${esc(l.title)}</h1>
        <div class="detail-links">
          <a href="https://www.roblox.com/games/${encodeURIComponent(l.place_id)}" target="_blank" rel="noopener">Open on Roblox ${icon('arrow-up-right')}</a>
          <a href="https://www.roblox.com/communities/${encodeURIComponent(l.group_id)}" target="_blank" rel="noopener">Owning group ${icon('arrow-up-right')}</a>
        </div>
      </div>
    </div>
    <div class="stats">
      <div><div class="k">Playing now</div><div class="v">${Number(l.ccu || 0).toLocaleString()}</div></div>
      <div><div class="k">Visits</div><div class="v">${compact(l.visits)}</div></div>
      <div><div class="k">Favorites</div><div class="v">${compact(l.favorites)}</div></div>
    </div>
    <div class="prose-h">About this listing</div>
    <div class="prose">${esc(cleanText(l.description) || 'The seller has not added a description.')}</div>
  </div>`)
  grid.appendChild(left)

  const buy = el(`<aside class="panel buy">
    <div class="buy-price">${usd(l.price_usdc)}</div>
    <div class="buy-cur">Paid in USDC${l.seller_id === HOUSE_ID ? '' : ` · listed by ${esc(l.seller_username)}`}</div>
    <div class="buy-action"></div>
    <ol class="steps">
      <li><div><b>Pay the exact amount</b>You get a USDC address for this order.</div></li>
      <li><div><b>Funds are held</b>The seller is not paid yet.</div></li>
      <li><div><b>Group is transferred to you</b>A person confirms the change on Roblox, then the sale closes.</div></li>
    </ol>
  </aside>`)
  const act = buy.querySelector('.buy-action')
  if (l.status !== 'active') {
    act.appendChild(el(`<div class="callout">This listing is ${esc(statusLabel[l.status] || l.status).toLowerCase()}.</div>`))
  } else if (!state.user) {
    const b = el('<a class="btn go lg block" href="#/signin">Sign in to buy</a>')
    b.onclick = () => { state.returnTo = location.hash }
    act.appendChild(b)
    act.appendChild(el('<div class="note">Sign in with your Roblox username. No password needed.</div>'))
  } else if (l.seller_id === state.user.id) {
    act.appendChild(el('<div class="callout" style="margin:0 0 12px">This is your listing.</div>'))
    const rm = el('<button class="btn danger block">Remove listing</button>')
    rm.onclick = async () => {
      if (!confirm('Remove this listing?')) return
      try { await api.post(`/api/marketplace/listings/${l.id}/cancel`); toast('Listing removed'); await loadListings(true); go('#/') }
      catch (e) { toast(e.message, 'bad') }
    }
    act.appendChild(rm)
  } else {
    const b = el('<button class="btn go lg block">Buy now</button>')
    b.onclick = async () => {
      b.disabled = true
      try { const d = await api.post(`/api/marketplace/listings/${l.id}/buy`); toast('Order created. Send payment to continue.'); go(`#/order/${d.id}`) }
      catch (e) { toast(e.message, 'bad'); b.disabled = false }
    }
    act.appendChild(b)
  }
  grid.appendChild(buy)
  w.appendChild(grid)
  const more = state.listings.filter((x) => x.id !== l.id).sort((a, b) => Number(b.ccu || 0) - Number(a.ccu || 0)).slice(0, 6)
  if (more.length) {
    w.appendChild(el('<h2 class="section-title" style="margin:56px 0 18px">More games for sale</h2>'))
    w.appendChild(el(`<div class="grid">${more.map((m, i) => cardHtml(m, i)).join('')}</div>`))
  }
  return v
}

// ── Sign in (Roblox bio code) ────────────────────────────────────────────────
function signinView() {
  const s = state.signin
  const v = el('<main id="main" class="page"><div class="wrap"><div class="narrow" style="margin:0 auto"></div></div></main>')
  const w = v.querySelector('.narrow')
  w.appendChild(el(`<div class="page-head"><h1>Sign in</h1><p>We confirm you own your Roblox account by having you put a short code in your profile's About section. No password, and you can delete the code afterwards.</p></div>`))
  const panel = el('<div class="panel"></div>')
  w.appendChild(panel)

  if (!s.phrase) {
    panel.appendChild(el(`<label class="field"><span>Roblox username</span><input class="input" id="u" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="e.g. Builderman…" value="${esc(s.username)}"><small>Your username, not your display name.</small></label>`))
    const b = el('<button class="btn go lg block">Get my code</button>')
    const input = panel.querySelector('#u')
    const submit = async () => {
      s.username = input.value.trim()
      if (!s.username) return toast('Enter your Roblox username', 'bad')
      b.disabled = true
      try { s.phrase = (await api.post('/api/roblox/challenge', { username: s.username })).phrase; route() }
      catch (e) { toast(e.message, 'bad'); b.disabled = false }
    }
    b.onclick = submit
    input.onkeydown = (e) => { if (e.key === 'Enter') submit() }
    panel.appendChild(b)
    setTimeout(() => input.focus(), 0)
  } else {
    panel.appendChild(el(`<ol class="track" style="margin-top:0">
      <li class="now"><div class="dot">1</div><div><b>Copy this code</b><div class="addr" style="margin-bottom:8px" id="code">${esc(s.phrase)}</div></div></li>
      <li class="now"><div class="dot">2</div><div><b>Paste it into your Roblox About section</b><span>On Roblox, open your profile, edit the About text, paste the code anywhere and save.</span></div></li>
      <li class="now"><div class="dot">3</div><div><b>Come back and check</b><span>We'll look for it on <b style="display:inline">${esc(s.username)}</b>'s profile. The code works for 10 minutes.</span></div></li>
    </ol>`))
    const row = el('<div style="display:flex;gap:10px;flex-wrap:wrap"></div>')
    const copy = el('<button class="btn quiet">Copy code</button>')
    copy.onclick = async () => { try { await navigator.clipboard.writeText(s.phrase); toast('Code copied') } catch { toast('Select the code and copy it', 'bad') } }
    const open = el(`<a class="btn quiet" href="https://www.roblox.com/users/profile" target="_blank" rel="noopener">Open my Roblox profile ${icon('arrow-up-right')}</a>`)
    row.appendChild(copy); row.appendChild(open)
    panel.appendChild(row)
    const check = el('<button class="btn go lg block" style="margin-top:16px">I added it, check my profile</button>')
    check.onclick = async () => {
      check.disabled = true; check.textContent = 'Checking your profile…'
      try {
        await api.post('/api/roblox/verify', { username: s.username })
        state.user = (await api.get('/api/me')).user
        state.signin = { username: '', phrase: '', busy: false }
        toast(`Signed in as ${state.user?.username || 'you'}`)
        const back = state.returnTo && state.returnTo !== '#/signin' ? state.returnTo : '#/'
        state.returnTo = null
        go(back)
      } catch (e) { toast(e.message, 'bad'); check.disabled = false; check.textContent = 'I added it, check my profile' }
    }
    panel.appendChild(check)
    const reset = el('<button class="btn quiet sm" style="margin-top:12px">Use a different username</button>')
    reset.onclick = () => { s.phrase = ''; route() }
    panel.appendChild(reset)
  }
  return v
}

// ── Sell ─────────────────────────────────────────────────────────────────────
function sellView() {
  if (!state.user) return gate('Sign in to list a game', 'Listings are tied to your verified Roblox account so buyers know who owns the group.')
  const v = el(`<main id="main" class="page"><div class="wrap"><div class="narrow">
    <div class="page-head"><h1>Sell a game</h1><p>Games sell by transferring the Roblox group that owns them. You need to be the group's owner, not just an admin. We check ownership with Roblox before the listing goes live.</p></div>
    <div class="panel">
      <label class="field"><span>Roblox group ID</span><input class="input" id="g" name="group_id" inputmode="numeric" autocomplete="off" placeholder="1234567…"><small>The number in the group's page URL.</small></label>
      <label class="field"><span>Place ID</span><input class="input" id="p" name="place_id" inputmode="numeric" autocomplete="off" placeholder="9876543210…"><small>The number in the game's page URL. We use it to pull live players, visits and favorites.</small></label>
      <label class="field"><span>Listing title</span><input class="input" id="t" name="title" maxlength="80" autocomplete="off" placeholder="Your game’s name…"></label>
      <label class="field"><span>Description</span><textarea class="input" id="d" maxlength="2000" name="description" placeholder="Revenue, update history, what’s included, why you’re selling…"></textarea></label>
      <label class="field"><span>Asking price (USDC)</span><input class="input" id="pr" name="price" type="number" min="1" step="0.01" autocomplete="off" placeholder="500…"></label>
      <button class="btn go lg block" id="sub">Publish listing</button>
    </div>
  </div></div></main>`)
  const $ = (id) => v.querySelector('#' + id).value.trim()
  v.querySelector('#sub').onclick = async (e) => {
    e.target.disabled = true
    try {
      const d = await api.post('/api/marketplace/listings', { groupId: $('g'), placeId: $('p'), title: $('t'), description: $('d'), priceUsdc: $('pr') })
      toast('Your game is listed'); await loadListings(true); go(`#/game/${d.id}`)
    } catch (err) { toast(err.message, 'bad'); e.target.disabled = false }
  }
  return v
}

// ── Orders ───────────────────────────────────────────────────────────────────
function ordersView(orders) {
  if (!state.user) return gate('Sign in to see your orders', 'Purchases and sales show up here once you are signed in.')
  const v = el(`<main id="main" class="page"><div class="wrap">
    <div class="page-head"><h1>Orders</h1></div>
    <div class="seg"><button data-b="buying" class="${state.ordersBox === 'buying' ? 'on' : ''}">Buying</button><button data-b="selling" class="${state.ordersBox === 'selling' ? 'on' : ''}">Selling</button></div>
    <div class="list"></div>
  </div></main>`)
  v.querySelectorAll('.seg button').forEach((b) => { b.onclick = () => { state.ordersBox = b.dataset.b; route() } })
  const list = v.querySelector('.list')
  if (!orders.length) list.appendChild(el(`<div class="empty"><b>No orders yet.</b>${state.ordersBox === 'buying' ? 'Games you buy will appear here.' : 'Sales of your games will appear here.'}</div>`))
  const byId = Object.fromEntries(state.listings.map((l) => [l.id, l]))
  orders.forEach((o) => {
    const l = byId[o.listing_id]
    list.appendChild(el(`<a class="list-row" href="#/order/${encodeURIComponent(o.id)}">
      <div style="min-width:0"><div class="t">${esc(l?.title || 'Game order')}</div>
      <div class="s">${state.ordersBox === 'buying' ? 'From ' + esc(o.seller_username) : 'To ' + esc(o.buyer_username)} · ${new Date(o.created_at).toLocaleDateString()}</div></div>
      <div style="display:flex;align-items:center;gap:14px"><span class="pill ${o.status}">${statusLabel[o.status] || o.status}</span><span class="num" style="font-weight:700">${usd(o.price_usdc)}</span></div>
    </a>`))
  })
  return v
}

function orderView(o) {
  if (!state.user) return gate('Sign in to view this order', 'Orders are only visible to the buyer and the seller.')
  const v = el('<main id="main" class="page"><div class="wrap"><div class="narrow"></div></div></main>')
  const w = v.querySelector('.narrow')
  w.appendChild(el(`<a class="back" href="#/orders">${icon('arrow-left')} All orders</a>`))
  if (!o) { w.appendChild(el('<div class="panel empty"><b>Order not found.</b></div>')); return v }
  const l = state.listings.find((x) => x.id === o.listing_id)
  const isBuyer = state.user.id === o.buyer_id
  const p = el(`<div class="panel">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div><div class="muted" style="font-size:13px;font-weight:600">${esc(l?.title || 'Game order')}</div><div class="buy-price" style="margin-top:6px">${usd2(o.price_usdc)}</div></div>
      <span class="pill ${o.status}">${statusLabel[o.status] || o.status}</span>
    </div>
  </div>`)
  const keys = ['awaiting_payment', 'paid', 'completed']
  const cur = keys.indexOf(o.status)
  if (cur >= 0) {
    const steps = [
      ['Payment', 'The buyer sends USDC to the order address.'],
      ['Group transfer', 'The seller transfers the group to the buyer. A person confirms it on Roblox.'],
      ['Done', "The seller's payout is released."],
    ]
    p.appendChild(el(`<ol class="track">${steps.map(([t, s], i) => `<li class="${i < cur || o.status === 'completed' ? 'done' : i === cur ? 'now' : ''}"><div class="dot">${i < cur || o.status === 'completed' ? '✓' : i + 1}</div><div><b>${t}</b><span>${s}</span></div></li>`).join('')}</ol>`))
  }
  if (o.status === 'awaiting_payment' && isBuyer) {
    p.appendChild(el(`<div><div class="prose-h" style="margin-bottom:4px">Send exactly ${usd2(o.price_usdc)} USDC to</div><div class="addr">${esc(o.pay_address || 'Generating address…')}</div></div>`))
    const row = el('<div style="display:flex;gap:10px;flex-wrap:wrap"></div>')
    const check = el("<button class='btn go'>I've paid, check status</button>")
    check.onclick = async () => {
      check.disabled = true
      try { const d = await api.post(`/api/marketplace/orders/${o.id}/check-payment`); toast(d.order.status === 'paid' ? 'Payment received' : 'Not received yet. Try again in a minute.'); route() }
      catch (e) { toast(e.message, 'bad'); check.disabled = false }
    }
    const cancel = el('<button class="btn danger">Cancel order</button>')
    cancel.onclick = async () => {
      if (!confirm('Cancel this order?')) return
      try { await api.post(`/api/marketplace/orders/${o.id}/cancel`); toast('Order cancelled'); go('#/orders') }
      catch (e) { toast(e.message, 'bad') }
    }
    row.appendChild(check); row.appendChild(cancel)
    p.appendChild(row)
  } else if (o.status === 'awaiting_payment') {
    p.appendChild(el('<div class="callout">Waiting for the buyer to pay.</div>'))
  }
  if (o.status === 'paid') {
    p.appendChild(el(`<div class="callout">${isBuyer ? 'Payment received. The seller now transfers the group to your Roblox account.' : "Payment received. Transfer the group to the buyer's Roblox account now."}${o.transfer_deadline ? ` Transfer window ends ${new Date(o.transfer_deadline).toLocaleString()}.` : ''} This page updates on its own once the transfer is confirmed.</div>`))
  }
  if (o.status === 'completed') p.appendChild(el(`<div class="callout">Sale complete. ${isBuyer ? 'The group is yours.' : 'Your payout is in your wallet.'}</div>`))
  if (o.status === 'cancelled') p.appendChild(el('<div class="callout">This order was cancelled.</div>'))
  w.appendChild(p)
  if (['awaiting_payment', 'paid'].includes(o.status)) {
    pollTimer = setTimeout(() => { if (location.hash === `#/order/${o.id}`) route(true) }, 6000)
  }
  return v
}

// ── Wallet ───────────────────────────────────────────────────────────────────
function walletView(w) {
  if (!state.user) return gate('Sign in to see your wallet', 'Sale payouts land in your wallet, and you can withdraw USDC from there.')
  const v = el(`<main id="main" class="page"><div class="wrap"><div class="narrow">
    <div class="page-head"><h1>Wallet</h1></div>
    <div class="panel">
      <div class="muted" style="font-size:13px;font-weight:600">Available to withdraw</div>
      <div class="bal">${usd2(w.balance)}</div>
      <label class="field"><span>Send to USDC address</span><input class="input" id="a" name="usdc_address" placeholder="T… (USDC on Tron)" autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>Amount</span><input class="input" id="m" name="amount" type="number" min="1" step="0.01" autocomplete="off" placeholder="0.00…"></label>
      <button class="btn go lg block" id="wd">Request withdrawal</button>
    </div>
    <h2 class="prose-h" style="margin:32px 0 12px">History</h2>
    <div class="list" id="hist"></div>
  </div></div></main>`)
  v.querySelector('#wd').onclick = async (e) => {
    e.target.disabled = true
    try { await api.post('/api/marketplace/wallet/withdraw', { amount: v.querySelector('#m').value.trim(), toAddress: v.querySelector('#a').value.trim() }); toast('Withdrawal requested'); route() }
    catch (err) { toast(err.message, 'bad'); e.target.disabled = false }
  }
  const hist = v.querySelector('#hist')
  if (!w.ledger?.length) hist.appendChild(el('<div class="empty">No activity yet.</div>'))
  ;(w.ledger || []).forEach((x) => {
    const pos = x.kind === 'sale'
    hist.appendChild(el(`<div class="list-row"><div><div class="t">${pos ? 'Sale payout' : 'Withdrawal'}</div><div class="s">${new Date(x.created_at).toLocaleString()}${x.status !== 'completed' ? ' · ' + esc(x.status) : ''}</div></div>
      <span class="${pos ? 'amt-pos' : 'amt-neg'}">${pos ? '+' : '−'}${usd2(x.amount_usdc)}</span></div>`))
  })
  return v
}

// ── Admin ────────────────────────────────────────────────────────────────────
function adminView(orders) {
  if (state.user?.role !== 'admin') return el('<main id="main" class="page"><div class="wrap"><div class="panel empty"><b>Admins only.</b></div></div></main>')
  const v = el(`<main id="main" class="page"><div class="wrap">
    <div class="page-head"><h1>Transfers to confirm</h1><p>These orders are paid. Check on Roblox that the group now belongs to the buyer, then release the payout.</p></div>
    <div class="list"></div>
  </div></main>`)
  const list = v.querySelector('.list')
  if (!orders.length) list.appendChild(el('<div class="empty"><b>Nothing waiting.</b>Paid orders show up here.</div>'))
  orders.forEach((o) => {
    const row = el(`<div class="list-row" style="flex-wrap:wrap">
      <div style="min-width:0"><div class="t num">${usd2(o.price_usdc)}</div>
        <div class="s">Buyer ${esc(o.buyer_username)} · Seller ${esc(o.seller_username)} · paid ${o.paid_at ? new Date(o.paid_at).toLocaleString() : ''}</div>
        ${o.source_url ? `<div class="s">Source: <a href="${esc(o.source_url)}" target="_blank" rel="noopener" style="color:var(--accent)">${esc(o.source || 'link')} ${icon('arrow-up-right')}</a>${o.source_price_usdc ? ` · cost ${usd2(o.source_price_usdc)}` : ''}</div>` : ''}
      </div>
    </div>`)
    const b = el('<button class="btn go sm">Confirm transfer and pay out</button>')
    b.onclick = async () => {
      if (!confirm('Confirm the group transferred and release the payout?')) return
      try { await api.post(`/api/marketplace/orders/${o.id}/finalize`); toast('Payout released'); route() }
      catch (e) { toast(e.message, 'bad') }
    }
    row.appendChild(b)
    list.appendChild(row)
  })
  return v
}

// ── Router ───────────────────────────────────────────────────────────────────
async function route(quiet = false) {
  clearTimeout(pollTimer)
  const h = location.hash.replace(/^#/, '') || '/'
  const parts = h.split('/').filter(Boolean)
  const [page, id] = [parts[0] || '', parts[1] ? decodeURIComponent(parts[1]) : null]
  try {
    if (page === '' || page === 'market') {
      if (!state.listingsLoaded) { shell('market', marketView()); await loadListings() }
      shell('market', marketView())
    } else if (page === 'game') {
      let l = state.listings.find((x) => x.id === id)
      if (!l) l = (await api.get(`/api/marketplace/listings/${encodeURIComponent(id)}`).catch(() => ({}))).listing
      loadListings().then(() => { if (location.hash === `#/game/${encodeURIComponent(id)}` && !document.querySelector('.grid')) route(true) }).catch(() => {})
      shell('market', gameView(l))
    } else if (page === 'signin') {
      if (state.user) return go('#/')
      shell('', signinView())
    } else if (page === 'sell') {
      shell('sell', sellView())
    } else if (page === 'orders') {
      const orders = state.user ? (await api.get(`/api/marketplace/orders?box=${state.ordersBox}`)).orders : []
      await loadListings().catch(() => {})
      shell('orders', ordersView(orders))
    } else if (page === 'order') {
      const o = state.user ? (await api.get(`/api/marketplace/orders/${encodeURIComponent(id)}`).catch(() => ({}))).order : null
      await loadListings().catch(() => {})
      shell('orders', orderView(o))
    } else if (page === 'wallet') {
      const w = state.user ? await api.get('/api/marketplace/wallet') : { balance: 0, ledger: [] }
      shell('wallet', walletView(w))
    } else if (page === 'admin') {
      const orders = state.user?.role === 'admin' ? (await api.get('/api/marketplace/admin/orders')).orders : []
      shell('admin', adminView(orders))
    } else {
      return go('#/')
    }
    if (!quiet) window.scrollTo(0, 0)
  } catch (e) {
    toast(e.message, 'bad')
  }
}

window.addEventListener('hashchange', () => route())
;(async function boot() {
  try { const v = localStorage.getItem('rex_view'); if (v === 'grid' || v === 'list') state.market.view = v } catch {}
  try { state.user = (await api.get('/api/me')).user } catch { state.user = null }
  route()
})()
