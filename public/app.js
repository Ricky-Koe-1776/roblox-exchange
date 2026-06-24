// Trade Hub frontend — vanilla JS SPA. No build step.

const state = {
  user: null,
  games: [],
  game: 'growagarden',
  tab: 'market', // market | inventory | history | create | messages
  ads: [],
  inventory: [],
  history: [],
  offers: [],
  offerBox: 'incoming',
  historyBox: 'all',
  historyPage: 1,
  historyTotalPages: 1,
  marketFilter: { offer: '', request: '' },
  historySearch: '',
  builder: { offering: [], requesting: [] },
  // counter-offer trade builder
  tradeAd: null,
  myInv: [],
  theirInv: [],
  tradeBuilder: { offer: [], request: [] },
  // profile lookup
  profileUser: null, // { username, stats, ads, inventory }
  // chat
  globalChat: { open: false, messages: [], lastId: null },
  dms: { conversations: [], unread: 0, activeId: null, activeName: null, messages: [] },
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

function gameItems() { return (state.games.find((g) => g.id === state.game) || {}).items || [] }
function catalogItem(name) { return gameItems().find((i) => i.name === name) || {} }
// <img> from the catalog's img field; hides itself if missing (games without art).
function itemImg(name, cls) {
  const img = catalogItem(name).img
  if (!img) return ''
  return `<img class="${cls}" src="/items/${img}" alt="" loading="lazy" onerror="this.style.display='none'" />`
}
function tierChip(name) {
  const t = catalogItem(name).tier
  return (t && t !== 'Normal') ? `<span class="tier tier-${t.toLowerCase()}">${t}</span>` : ''
}
// Request entries can be a specific item OR a preference tag (Any, Demand, ...).
const REQUEST_TAGS = ['Any', 'Demand', 'Big', 'Huge', 'Upgrade', 'Downgrade', 'Adds']
function entryPill(e) {
  if (e && e.tag) return `<span class="pill tag-pill">${e.tag}</span>`
  return itemPill(e)
}

// Confirmation modal showing exactly what the trade is before committing.
function confirmTrade({ title, giveLabel, give, getLabel, get, confirmText, onConfirm }) {
  const items = (list) => list.length ? list.map(entryPill).join('') : '<span class="muted">nothing</span>'
  const bg = el('<div class="modal-bg"></div>')
  const m = el(`<div class="modal card">
    <h2 class="modal-title">${title}</h2>
    <div class="confirm-sides">
      <div class="side"><div class="label">${giveLabel}</div><div class="items">${items(give)}</div></div>
      <div class="confirm-arrow">⇄</div>
      <div class="side"><div class="label">${getLabel}</div><div class="items">${items(get)}</div></div>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" id="mCancel">Cancel</button>
      <button class="btn" id="mConfirm">${confirmText || 'Confirm Trade'}</button>
    </div>
  </div>`)
  bg.appendChild(m)
  const close = () => bg.remove()
  bg.onclick = (e) => { if (e.target === bg) close() }
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) } })
  m.querySelector('#mCancel').onclick = close
  m.querySelector('#mConfirm').onclick = async () => { close(); await onConfirm() }
  document.body.appendChild(bg)
}

// Read-only popup showing a trade's full Offering/Requesting cleanly.
function viewTrade(ad) {
  const cards = (list) => list.length
    ? `<div class="view-grid">${list.map((e) => e.tag
        ? `<div class="view-card view-tag">${e.tag}</div>`
        : `<div class="view-card">${itemImg(e.item, 'view-img')}<div class="view-n">${e.item}</div><div class="view-r">${catalogItem(e.item).rarity || ''}${e.qty > 1 ? ` · ×${e.qty}` : ''}</div></div>`).join('')}</div>`
    : '<div class="muted" style="padding:8px">nothing</div>'
  const bg = el('<div class="modal-bg"></div>')
  const m = el(`<div class="modal card">
    <h2 class="modal-title">${ad.username}'s Trade</h2>
    ${ad.note ? `<p class="muted" style="text-align:center;margin:-8px 0 14px">"${ad.note}"</p>` : ''}
    <div class="view-sides">
      <div><div class="label">Offering</div>${cards(ad.offering)}</div>
      <div><div class="label">Requesting</div>${cards(ad.requesting)}</div>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="vClose">Close</button></div>
  </div>`)
  bg.appendChild(m)
  const close = () => bg.remove()
  bg.onclick = (e) => { if (e.target === bg) close() }
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) } })
  m.querySelector('#vClose').onclick = close
  document.body.appendChild(bg)
}

// ── Deposit modal ─────────────────────────────────────────────────────────────
async function depositModal() {
  const { mailbox } = await api.get(`/api/deposit/info?game=${state.game}`)
  const gameName = (state.games.find((g) => g.id === state.game) || {}).label || state.game
  const bg = el('<div class="modal-bg"></div>')
  const m = el(`<div class="modal card dep-modal">
    <h2 class="modal-title">Deposit Items</h2>
    <div class="dep-steps">
      <div class="dep-step">
        <div class="dep-num">1</div>
        <div>
          <div class="dep-label">Open <b>${gameName}</b> on Roblox</div>
          <div class="dep-sub">Make sure you're logged into the account you verified here.</div>
        </div>
      </div>
      <div class="dep-step">
        <div class="dep-num">2</div>
        <div>
          <div class="dep-label">Send items in mailbox to:</div>
          <div class="dep-mailbox">${mailbox}</div>
        </div>
      </div>
      <div class="dep-step">
        <div class="dep-num">3</div>
        <div>
          <div class="dep-label">Wait for confirmation</div>
          <div class="dep-sub">Once the bot receives your items, your inventory here will update automatically. This usually takes under a minute.</div>
        </div>
      </div>
    </div>
    <div class="modal-actions"><button class="btn ghost" id="depClose">Close</button></div>
  </div>`)
  bg.appendChild(m)
  const close = () => bg.remove()
  bg.onclick = (e) => { if (e.target === bg) close() }
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) } })
  m.querySelector('#depClose').onclick = close
  document.body.appendChild(bg)
}

// ── Withdraw modal ────────────────────────────────────────────────────────────
async function withdrawModal() {
  const inv = state.user ? (await api.get(`/api/inventory?game=${state.game}`)).items : []
  if (!inv.length) { toast('Your inventory is empty — deposit items first.', 'bad'); return }

  const MAX = 20
  // selected: Map(itemName -> qty)
  const selected = new Map()

  const bg = el('<div class="modal-bg"></div>')
  const m = el(`<div class="modal card wd-modal">
    <h2 class="modal-title">Withdraw Items</h2>
    <div class="wd-bar">
      <span class="wd-count" id="wdCount">0 / ${MAX} items selected</span>
      <button class="btn" id="wdSubmit" disabled>Request Withdrawal</button>
    </div>
    <div class="wd-selected" id="wdSelected"></div>
    <div class="wd-grid" id="wdGrid"></div>
    <div class="modal-actions"><button class="btn ghost" id="wdClose">Cancel</button></div>
  </div>`)
  bg.appendChild(m)
  const close = () => bg.remove()
  bg.onclick = (e) => { if (e.target === bg) close() }
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) } })
  m.querySelector('#wdClose').onclick = close

  function syncUI() {
    const count = selected.size
    m.querySelector('#wdCount').textContent = `${count} / ${MAX} items selected`
    const submitBtn = m.querySelector('#wdSubmit')
    submitBtn.disabled = count === 0

    // Selected summary strip
    const strip = m.querySelector('#wdSelected')
    strip.innerHTML = ''
    selected.forEach((qty, item) => {
      const chip = el(`<div class="wd-chip">${itemImg(item, 'pill-img')}<span>${item} ×${qty}</span><button class="wd-rm" title="Remove">×</button></div>`)
      chip.querySelector('.wd-rm').onclick = () => { selected.delete(item); syncUI(); syncGrid() }
      strip.appendChild(chip)
    })

    syncGrid()
  }

  function syncGrid() {
    const grid = m.querySelector('#wdGrid')
    grid.innerHTML = ''
    inv.forEach((it) => {
      const isSelected = selected.has(it.item)
      const selQty = isSelected ? selected.get(it.item) : 0
      const card = el(`<div class="wd-card ${isSelected ? 'wd-on' : ''}">
        ${itemImg(it.item, 'pick-img')}
        <div class="pick-n">${it.item}</div>
        <div class="pick-r">${it.rarity}${tierChip(it.item)}</div>
        ${isSelected
          ? `<div class="wd-qty-row">
              <button class="wd-q" data-d="-1">−</button>
              <span class="wd-q-n">×${selQty}</span>
              <button class="wd-q" data-d="1">+</button>
             </div>`
          : `<div class="wd-avail">×${it.qty} available</div>`}
      </div>`)
      if (!isSelected) {
        card.onclick = () => {
          if (selected.size >= MAX) { toast(`Max ${MAX} items per withdrawal`, 'bad'); return }
          selected.set(it.item, 1)
          syncUI()
        }
      } else {
        card.querySelectorAll('.wd-q').forEach((btn) => {
          btn.onclick = (e) => {
            e.stopPropagation()
            const d = parseInt(btn.dataset.d)
            const next = selQty + d
            if (next < 1) { selected.delete(it.item) }
            else if (next > it.qty) return
            else selected.set(it.item, next)
            syncUI()
          }
        })
      }
      grid.appendChild(card)
    })
  }

  m.querySelector('#wdSubmit').onclick = async () => {
    if (!selected.size) return
    const items = [...selected.entries()].map(([item, qty]) => ({ item, qty }))
    try {
      await api.post('/api/withdraw/request', { game: state.game, items })
      toast(`Withdrawal requested! The bot will gift ${items.length} item${items.length > 1 ? 's' : ''} to you in-game.`)
      close()
      if (state.tab === 'inventory') refresh()
    } catch (e) { toast(e.message, 'bad') }
  }

  syncUI()
  document.body.appendChild(bg)
}

function toast(msg, kind = 'ok') {
  const t = document.createElement('div')
  t.className = `toast ${kind}`
  t.textContent = msg
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 2600)
}

// ── Data loaders ──────────────────────────────────────────────────────────────
async function refresh() {
  if (state.tab === 'market') state.ads = (await api.get(`/api/ads?game=${state.game}`)).ads
  if (state.tab === 'inventory' || state.tab === 'create') state.inventory = state.user ? (await api.get(`/api/inventory?game=${state.game}`)).items : []
  if (state.tab === 'history') {
    const d = await api.get(`/api/history?game=${state.game}&box=${state.historyBox}&page=${state.historyPage}&search=${encodeURIComponent(state.historySearch)}`)
    state.history = d.trades; state.historyTotalPages = d.totalPages || 1; state.historyPage = d.page || 1
  }
  if (state.tab === 'offers') state.offers = state.user ? (await api.get(`/api/offers?box=${state.offerBox}`)).offers : []
  if (state.tab === 'messages' && state.user) {
    const d = await api.get('/api/chat/dms')
    state.dms.conversations = d.conversations || []
    state.dms.unread = d.unreadTotal || 0
    if (state.dms.activeId) {
      const t = await api.get(`/api/chat/dms/${state.dms.activeId}`)
      state.dms.messages = t.messages || []
      state.dms.unread = Math.max(0, state.dms.unread - (t.messages || []).filter(m => m.to_id === state.user.id && !m.read).length)
    }
  }
  if (state.user) { const r = await api.get('/api/chat/unread'); state.dms.unread = r.unread || 0 }
  render()
}

// Open the Roblox-style trade builder against an ad (loads both inventories).
async function openTrade(ad) {
  state.tradeAd = ad
  state.tradeBuilder = { offer: [], request: [] }
  state.tab = 'trade'
  try {
    const [mine, theirs] = await Promise.all([
      api.get(`/api/inventory?game=${state.game}`),
      api.get(`/api/inventory?game=${state.game}&user=${encodeURIComponent(ad.username)}`),
    ])
    state.myInv = mine.items || []
    state.theirInv = theirs.items || []
  } catch (e) { toast(e.message, 'bad') }
  render()
}

// ── Render ────────────────────────────────────────────────────────────────────
function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild }

function itemPill(it) {
  return `<span class="pill">${itemImg(it.item, 'pill-img')}${it.item}${it.qty > 1 ? ` ×${it.qty}` : ''}</span>`
}

function render() {
  const app = document.getElementById('app')
  app.innerHTML = ''
  app.appendChild(header())
  if (!state.user) { app.appendChild(loginView()); return }
  const wrap = el('<div class="wrap"></div>')
  if (state.tab === 'trade') { wrap.appendChild(tradeView()); app.appendChild(wrap); return }
  wrap.appendChild(tabs())
  wrap.appendChild(
    state.tab === 'market' ? marketView()
      : state.tab === 'inventory' ? inventoryView()
      : state.tab === 'create' ? createView()
      : state.tab === 'offers' ? offersView()
      : state.tab === 'messages' ? messagesView()
      : state.tab === 'players' ? playersView()
      : historyView()
  )
  app.appendChild(wrap)
  mountGlobalChat()
}

function header() {
  const h = el(`<header><div class="wrap"><div class="nav">
    <div class="nav-left">
      <div class="logo">Roblox<span>Exchange</span></div>
      <select class="game-select" id="gameSel"></select>
    </div>
    <div class="nav-center" id="navCenter"></div>
    <div class="nav-right" id="userArea"></div>
  </div></div></header>`)
  const sel = h.querySelector('#gameSel')
  state.games.forEach((g) => {
    const o = document.createElement('option'); o.value = g.id; o.textContent = g.label
    if (g.id === state.game) o.selected = true; sel.appendChild(o)
  })
  sel.onchange = () => { state.game = sel.value; state.builder = { offering: [], requesting: [] }; refresh() }
  const ua = h.querySelector('#userArea')
  const center = h.querySelector('#navCenter')
  if (state.user) {
    const dep = el('<button class="btn ghost">Deposit</button>')
    dep.onclick = () => depositModal()
    center.appendChild(dep)
    const wd = el('<button class="btn" style="margin-left:8px">Withdraw</button>')
    wd.onclick = () => withdrawModal()
    center.appendChild(wd)
    ua.innerHTML = `<span class="who">Signed in as <b>${state.user.username}</b></span>`
    const btn = el('<button class="btn ghost" style="margin-left:12px">Logout</button>')
    btn.onclick = async () => { await api.post('/api/logout'); state.user = null; render() }
    ua.appendChild(btn)
  }
  return h
}

function tabs() {
  const t = el('<div class="tabs"></div>')
  const unread = state.dms.unread
  const defs = [['market', 'Marketplace'], ['create', 'Post a Trade'], ['offers', 'Offers'], ['inventory', 'My Inventory'], ['history', 'Recent Trades'], ['messages', unread ? `Messages <span class="badge">${unread}</span>` : 'Messages'], ['players', 'Players']]
  defs.forEach(([id, label]) => {
    const d = el(`<div class="tab ${state.tab === id ? 'active' : ''}">${label}</div>`)
    d.querySelector('.badge')?.addEventListener('click', (e) => e.stopPropagation())
    d.onclick = () => { state.tab = id; refresh() }
    t.appendChild(d)
  })
  return t
}

function loginView() {
  const v = el(`<div class="wrap">
    <div class="hero">
      <h1>Trade Roblox items without getting scammed.</h1>
      <p>For gifting-only games with no trade window. Deposit your items, trade safely with escrow on our site, then withdraw. No middleman, no "you gift first."</p>
    </div>
    <div class="card login">
      <div id="step1">
        <input id="uname" placeholder="Your Roblox username" autocomplete="off" />
        <button class="btn" id="getPhrase" style="width:100%">Continue</button>
      </div>
      <div id="step2" style="display:none">
        <div class="step">1. Copy this phrase into your Roblox profile bio:</div>
        <div class="phrase" id="phraseBox"></div>
        <div class="step">2. Save your bio, then click Verify.</div>
        <button class="btn" id="verifyBtn" style="width:100%">Verify &amp; Enter</button>
        <button class="btn ghost" id="backBtn" style="width:100%;margin-top:8px">Back</button>
      </div>
      <div class="err" id="loginErr"></div>
      <p class="muted" style="font-size:12px;margin-top:10px">We verify you own the account by checking your bio — no password, ever. <span id="demoHint"></span></p>
    </div>
  </div>`)
  const input = v.querySelector('#uname')
  const err = v.querySelector('#loginErr')
  const step1 = v.querySelector('#step1'), step2 = v.querySelector('#step2')

  const getPhrase = async () => {
    err.textContent = ''
    const username = input.value.trim()
    if (!username) { err.textContent = 'Enter your Roblox username'; return }
    try {
      const d = await api.post('/api/roblox/challenge', { roblox_username: username })
      v.querySelector('#phraseBox').textContent = d.phrase
      step1.style.display = 'none'; step2.style.display = 'block'
      if (/demo mode/i.test(d.phrase)) v.querySelector('#demoHint').innerHTML = '<b>Local demo:</b> just click Verify — no real bio needed.'
    } catch (e) { err.textContent = e.message }
  }
  const verify = async () => {
    err.textContent = ''
    try {
      const d = await api.post('/api/roblox/verify', { roblox_username: input.value.trim() })
      state.user = d.user; state.tab = 'market'; await refresh()
    } catch (e) { err.textContent = e.message }
  }
  v.querySelector('#getPhrase').onclick = getPhrase
  v.querySelector('#verifyBtn').onclick = verify
  v.querySelector('#backBtn').onclick = () => { step2.style.display = 'none'; step1.style.display = 'block'; err.textContent = '' }
  input.onkeydown = (e) => { if (e.key === 'Enter') getPhrase() }
  return v
}

function adCard(ad) {
  const hasTags = ad.requesting.some((r) => r.tag)
  const ad_el = el(`<div class="ad ad-mkt">
    <div class="ad-head">
      <div class="ad-user"><span class="seller dm-link" data-uname="${ad.username}">${ad.username}</span>${ad.note ? `<span class="note">"${ad.note}"</span>` : ''}</div>
      <div class="ad-actions"></div>
    </div>
    <div class="ad-body">
      <div class="side"><div class="label">Offering</div><div class="items">${ad.offering.map(entryPill).join('')}</div></div>
      <div class="arrow">→</div>
      <div class="side"><div class="label">Requesting</div><div class="items">${ad.requesting.map(entryPill).join('')}</div></div>
    </div>
  </div>`)
  if (!ad.mine) ad_el.querySelector('.dm-link').onclick = (e) => userPopover(e, ad.username)
  const actions = ad_el.querySelector('.ad-actions')
  const view = el('<button class="btn ghost">View</button>')
  view.onclick = () => viewTrade(ad)
  actions.appendChild(view)
  if (ad.mine) {
    const b = el('<button class="btn danger">Cancel</button>')
    b.onclick = async () => { try { await api.post(`/api/ads/${ad.id}/cancel`); toast('Ad cancelled, items returned'); refresh() } catch (e) { toast(e.message, 'bad') } }
    actions.appendChild(b)
  } else {
    if (!hasTags) {
      const a = el('<button class="btn">Accept Trade</button>')
      a.onclick = () => confirmTrade({
        title: `Trade with ${ad.username}`,
        giveLabel: 'You give', give: ad.requesting,
        getLabel: 'You receive', get: ad.offering,
        confirmText: 'Confirm Trade',
        onConfirm: async () => { try { await api.post(`/api/ads/${ad.id}/accept`); toast('Trade complete! Items swapped.'); refresh() } catch (e) { toast(e.message, 'bad') } },
      })
      actions.appendChild(a)
    }
    const cbtn = el(`<button class="btn ghost">${hasTags ? 'Make Offer' : 'Counter'}</button>`)
    cbtn.onclick = () => openTrade(ad)
    actions.appendChild(cbtn)
  }
  return ad_el
}

// True if any entry (item or tag) in `list` matches the query string.
function entryMatches(list, q) {
  if (!q) return true
  q = q.toLowerCase()
  return list.some((e) => (e.tag || e.item || '').toLowerCase().includes(q))
}

function marketView() {
  const c = el('<div></div>')
  const f = state.marketFilter

  const bar = el(`<div class="filterbar">
    <div class="filtercol"><div class="filterh">Offer filter</div><input id="fOffer" placeholder="Item or tag they're offering" /></div>
    <div class="filtercol"><div class="filterh">Request filter</div><input id="fRequest" placeholder="Item or tag they want" /></div>
  </div>`)
  const offerIn = bar.querySelector('#fOffer'), reqIn = bar.querySelector('#fRequest')
  offerIn.value = f.offer; reqIn.value = f.request
  const results = el('<div class="ad-list"></div>')

  function applyFilter() {
    f.offer = offerIn.value; f.request = reqIn.value
    results.innerHTML = ''
    const list = state.ads.filter((ad) => entryMatches(ad.offering, f.offer) && entryMatches(ad.requesting, f.request))
    if (!state.ads.length) { results.appendChild(el('<div class="empty">No open trades for this game yet. Be the first — post one!</div>')); return }
    if (!list.length) { results.appendChild(el('<div class="empty">No trades match your filters.</div>')); return }
    list.forEach((ad) => results.appendChild(adCard(ad)))
  }
  offerIn.oninput = applyFilter
  reqIn.oninput = applyFilter

  c.appendChild(bar)
  c.appendChild(results)
  applyFilter()
  return c
}

function inventoryView() {
  const c = el('<div></div>')
  if (!state.inventory.length) { c.appendChild(el('<div class="empty">No items in this game. (In the live version you\'d deposit via the gifting bot.)</div>')); return c }
  const grid = el('<div class="grid"></div>')
  state.inventory.forEach((it) => {
    grid.appendChild(el(`<div class="inv-item">${itemImg(it.item, 'inv-img')}<div class="n">${it.item}</div>
      <div class="r">${it.rarity}${tierChip(it.item)}</div>
      <div class="b"><span class="muted">Qty</span><span class="qty">×${it.qty}</span></div></div>`))
  })
  c.appendChild(grid)
  return c
}

const MIN_SLOTS = 8
// Show at least 8 slots, growing in rows of 4 so there's always an empty one to fill.
function slotCount(len) { return Math.max(MIN_SLOTS, Math.ceil((len + 1) / 4) * 4) }
function createView() {
  const b = state.builder
  if (!b.addTab) b.addTab = 'offer'
  if (b.search == null) b.search = ''
  if (b.note == null) b.note = ''
  const c = el('<div></div>')

  // ── Offer / Request slot panel ──────────────────────────────────────────────
  function slotPanel() {
    const p = el(`<div class="trade-panel">
      <div class="trade-col"><div class="trade-h">Offer</div><div class="slots" data-side="offering"></div></div>
      <div class="trade-mid"><button class="btn" id="submitAd">Submit</button></div>
      <div class="trade-col"><div class="trade-h">Request</div><div class="slots" data-side="requesting"></div></div>
    </div>`)
    p.querySelectorAll('.slots').forEach((box) => {
      const side = box.dataset.side
      const arr = b[side]
      for (let i = 0; i < slotCount(arr.length); i++) {
        const e = arr[i]
        if (e) {
          const s = el(`<div class="slot filled" title="Remove">${e.tag ? `<div class="slot-tag">${e.tag}</div>` : `${itemImg(e.item, 'slot-img')}<div class="slot-name">${e.item}${e.qty > 1 ? ` ×${e.qty}` : ''}</div>`}</div>`)
          s.onclick = () => { arr.splice(i, 1); redraw() }
          box.appendChild(s)
        } else box.appendChild(el('<div class="slot"></div>'))
      }
    })
    p.querySelector('#submitAd').onclick = submit
    return p
  }

  // ── Add-to tabs ─────────────────────────────────────────────────────────────
  function subTabs() {
    const t = el(`<div class="addtabs">
      <div class="addtab ${b.addTab === 'offer' ? 'active' : ''}" data-t="offer">Add to Offer</div>
      <div class="addtab ${b.addTab === 'request' ? 'active' : ''}" data-t="request">Add to Request</div>
    </div>`)
    t.querySelectorAll('.addtab').forEach((x) => { x.onclick = () => { b.addTab = x.dataset.t; b.search = ''; redraw() } })
    return t
  }

  function addEntry(side, entry) {
    const arr = b[side]
    if (entry.tag) { if (arr.some((e) => e.tag === entry.tag)) return; arr.push(entry) }
    else {
      const ex = arr.find((e) => e.item === entry.item)
      // Offer items are capped at how many you actually own; requests are unlimited.
      if (side === 'offering') {
        const owned = (state.inventory.find((i) => i.item === entry.item) || {}).qty || 0
        if (ex) { if (ex.qty >= owned) return toast(`You only have ×${owned} ${entry.item}`, 'bad'); ex.qty += 1 }
        else if (owned >= 1) arr.push({ item: entry.item, qty: 1 })
        else return toast(`You don't own ${entry.item}`, 'bad')
      } else {
        if (ex) ex.qty += 1; else arr.push({ item: entry.item, qty: 1 })
      }
    }
    redraw()
  }

  // ── Picker grid ─────────────────────────────────────────────────────────────
  function pickerArea() {
    const area = el('<div class="picker"></div>')
    if (b.addTab === 'request') {
      const tagRow = el('<div class="tagrow"></div>')
      REQUEST_TAGS.forEach((tag) => {
        const chip = el(`<div class="tagbtn">${tag}</div>`)
        chip.onclick = () => addEntry('requesting', { tag })
        tagRow.appendChild(chip)
      })
      area.appendChild(tagRow)
    }
    const searchPlaceholder = b.addTab === 'offer' ? 'Search your inventory' : 'Search the catalog'
    const sb = el(`<div class="searchbar"><input placeholder="${searchPlaceholder}" /></div>`)
    const input = sb.querySelector('input')
    input.value = b.search
    input.oninput = () => { b.search = input.value; drawGrid() }
    area.appendChild(sb)
    const gridWrap = el('<div class="pickgrid"></div>')
    area.appendChild(gridWrap)

    function drawGrid() {
      gridWrap.innerHTML = ''
      const q = b.search.trim().toLowerCase()
      let source
      if (b.addTab === 'offer') {
        source = state.inventory.map((it) => ({ name: it.item, rarity: it.rarity, qty: it.qty }))
      } else {
        source = gameItems().map((it) => ({ name: it.name, rarity: it.rarity }))
      }
      const list = source.filter((it) => !q || it.name.toLowerCase().includes(q))
      if (!list.length) { gridWrap.appendChild(el(`<div class="empty">${b.addTab === 'offer' ? 'No items in your inventory for this game.' : 'No matches.'}</div>`)); return }
      list.forEach((it) => {
        const card = el(`<div class="pickcard">${itemImg(it.name, 'pick-img')}
          <div class="pick-n">${it.name}</div>
          <div class="pick-r">${it.rarity}${tierChip(it.name)}${it.qty != null ? ` · ×${it.qty}` : ''}</div></div>`)
        card.onclick = () => addEntry(b.addTab === 'offer' ? 'offering' : 'requesting', { item: it.name })
        gridWrap.appendChild(card)
      })
    }
    drawGrid()
    // keep focus after redraws triggered by typing
    setTimeout(() => { if (b.addTab && document.activeElement !== input) {} }, 0)
    return area
  }

  function noteBar() {
    const n = el(`<div class="card" style="margin:14px 0"><input id="note" placeholder="Optional note (e.g. 'quick flip', 'offers')" maxlength="140" style="width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:10px"/></div>`)
    const input = n.querySelector('#note')
    input.value = b.note
    input.oninput = () => { b.note = input.value }
    return n
  }

  async function submit() {
    if (!b.offering.length || !b.requesting.length) return toast('Add at least one item to Offer and Request', 'bad')
    if (b.offering.some((e) => e.tag)) return toast('Offer must be specific items, not tags', 'bad')
    try {
      await api.post('/api/ads', { game: state.game, offering: b.offering, requesting: b.requesting, note: b.note })
      state.builder = { offering: [], requesting: [], addTab: 'offer', search: '', note: '' }
      toast('Trade posted! Your offered items are held in escrow.')
      state.tab = 'market'; refresh()
    } catch (e) { toast(e.message, 'bad') }
  }

  function redraw() {
    c.innerHTML = ''
    c.appendChild(slotPanel())
    c.appendChild(noteBar())
    c.appendChild(subTabs())
    c.appendChild(pickerArea())
  }
  redraw()
  return c
}

// ── Counter-offer trade builder (Roblox-style, both inventories) ───────────────
function tradeView() {
  const ad = state.tradeAd
  const tb = state.tradeBuilder
  const c = el('<div></div>')

  function back() { state.tab = 'market'; state.tradeAd = null; refresh() }

  function invGrid(items, onPick, emptyMsg) {
    const g = el('<div class="pickgrid"></div>')
    if (!items.length) { g.appendChild(el(`<div class="empty">${emptyMsg}</div>`)); return g }
    items.forEach((it) => {
      const card = el(`<div class="pickcard">${itemImg(it.item, 'pick-img')}
        <div class="pick-n">${it.item}</div>
        <div class="pick-r">${it.rarity}${tierChip(it.item)} · ×${it.qty}</div></div>`)
      card.onclick = () => onPick(it)
      g.appendChild(card)
    })
    return g
  }

  function addSide(side, it) {
    const arr = tb[side]
    const ex = arr.find((e) => e.item === it.item)
    if (ex) { if (ex.qty >= it.qty) return toast(`Only ×${it.qty} available`, 'bad'); ex.qty += 1 }
    else arr.push({ item: it.item, qty: 1 })
    redraw()
  }

  function slotCol(side) {
    const box = el('<div class="slots-col"></div>')
    for (let i = 0; i < slotCount(tb[side].length); i++) {
      const e = tb[side][i]
      if (e) {
        const s = el(`<div class="slot filled" title="Remove">${itemImg(e.item, 'slot-img')}<div class="slot-name">${e.item}${e.qty > 1 ? ` ×${e.qty}` : ''}</div></div>`)
        s.onclick = () => { tb[side].splice(i, 1); redraw() }
        box.appendChild(s)
      } else box.appendChild(el('<div class="slot"></div>'))
    }
    return box
  }

  async function send() {
    try {
      if (ad.direct) {
        await api.post('/api/offers/direct', { toUsername: ad.username, game: state.game, offerItems: tb.offer, requestItems: tb.request })
      } else {
        await api.post(`/api/ads/${ad.id}/offer`, { offerItems: tb.offer, requestItems: tb.request })
      }
      toast('Offer sent!'); back()
    } catch (e) { toast(e.message, 'bad') }
  }

  function redraw() {
    c.innerHTML = ''
    const head = el(`<div class="trade-head">
      <button class="btn ghost" id="tbBack">← Back</button>
      <div class="trade-title">Trade with <b>${ad.username}</b></div>
      <button class="btn" id="tbSend">Send Offer</button></div>`)
    head.querySelector('#tbBack').onclick = back
    head.querySelector('#tbSend').onclick = send
    c.appendChild(head)

    const grid = el('<div class="trade-grid"></div>')
    const left = el('<div class="trade-col-l"></div>')
    left.appendChild(el('<h3 class="inv-h">Your Inventory</h3>'))
    left.appendChild(invGrid(state.myInv, (it) => addSide('offer', it), 'You have no items in this game.'))
    left.appendChild(el(`<h3 class="inv-h">${ad.username}'s Inventory</h3>`))
    left.appendChild(invGrid(state.theirInv, (it) => addSide('request', it), 'They have no items in this game.'))
    grid.appendChild(left)

    const right = el('<div class="trade-col-r"></div>')
    right.appendChild(el('<h3 class="inv-h">Your Offer</h3>'))
    right.appendChild(slotCol('offer'))
    right.appendChild(el('<h3 class="inv-h" style="margin-top:18px">Your Request</h3>'))
    right.appendChild(slotCol('request'))
    grid.appendChild(right)
    c.appendChild(grid)
  }
  redraw()
  return c
}

function offersView() {
  const c = el('<div></div>')
  const incoming = state.offerBox === 'incoming'
  const toggle = el(`<div class="addtabs" style="max-width:380px;margin-bottom:14px">
    <div class="addtab ${incoming ? 'active' : ''}" data-b="incoming">Incoming</div>
    <div class="addtab ${!incoming ? 'active' : ''}" data-b="outgoing">Outgoing</div></div>`)
  toggle.querySelectorAll('.addtab').forEach((x) => { x.onclick = () => { state.offerBox = x.dataset.b; refresh() } })
  c.appendChild(toggle)
  if (!state.offers.length) { c.appendChild(el(`<div class="empty">No ${state.offerBox} offers.</div>`)); return c }
  state.offers.forEach((o) => {
    const card = el(`<div class="ad">
      <div class="side"><div class="label">${incoming ? o.fromName + ' offers' : 'You offer'}</div><div class="items">${o.offerItems.map(itemPill).join('')}</div></div>
      <div class="arrow">→</div>
      <div class="side"><div class="label">${incoming ? 'They want' : 'You want'}</div><div class="items">${o.requestItems.map(itemPill).join('')}</div></div>
      <div class="meta"><div class="seller">${incoming ? o.fromName : 'to ' + o.toName}</div><div style="margin-top:8px"></div></div>
    </div>`)
    const meta = card.querySelector('.meta')
    if (incoming) {
      const a = el('<button class="btn">Accept</button>')
      a.onclick = () => confirmTrade({
        title: `Accept ${o.fromName}'s offer`,
        giveLabel: 'You give', give: o.requestItems,
        getLabel: 'You receive', get: o.offerItems,
        confirmText: 'Accept Offer',
        onConfirm: async () => { try { await api.post(`/api/offers/${o.id}/accept`); toast('Trade complete! Items swapped.'); refresh() } catch (e) { toast(e.message, 'bad') } },
      })
      const d = el('<button class="btn danger" style="margin-top:6px">Decline</button>')
      d.onclick = async () => { try { await api.post(`/api/offers/${o.id}/decline`); toast('Offer declined'); refresh() } catch (e) { toast(e.message, 'bad') } }
      meta.appendChild(a); meta.appendChild(d)
    } else {
      const cn = el('<button class="btn danger">Cancel</button>')
      cn.onclick = async () => { try { await api.post(`/api/offers/${o.id}/cancel`); toast('Offer cancelled'); refresh() } catch (e) { toast(e.message, 'bad') } }
      meta.appendChild(cn)
    }
    c.appendChild(card)
  })
  return c
}

// Page numbers with ellipsis: ‹ 1 … 4 5 6 … 50 ›
function pager(current, total, onGo) {
  if (total <= 1) return el('<div></div>')
  const nums = []
  const add = (n) => nums.push(n)
  add(1)
  const from = Math.max(2, current - 1), to = Math.min(total - 1, current + 1)
  if (from > 2) nums.push('…')
  for (let n = from; n <= to; n++) add(n)
  if (to < total - 1) nums.push('…')
  if (total > 1) add(total)
  const bar = el('<div class="pager"></div>')
  const arrow = (label, target, disabled) => {
    const b = el(`<button class="pg ${disabled ? 'pg-off' : ''}">${label}</button>`)
    if (!disabled) b.onclick = () => onGo(target)
    return b
  }
  bar.appendChild(arrow('‹', current - 1, current <= 1))
  nums.forEach((n) => {
    if (n === '…') { bar.appendChild(el('<span class="pg-dots">…</span>')); return }
    const b = el(`<button class="pg ${n === current ? 'pg-on' : ''}">${n}</button>`)
    if (n !== current) b.onclick = () => onGo(n)
    bar.appendChild(b)
  })
  bar.appendChild(arrow('›', current + 1, current >= total))
  return bar
}

function historyView() {
  const c = el('<div></div>')
  const mine = state.historyBox === 'mine'
  const toggle = el(`<div class="addtabs" style="max-width:380px;margin-bottom:14px">
    <div class="addtab ${!mine ? 'active' : ''}" data-b="all">All Trades</div>
    <div class="addtab ${mine ? 'active' : ''}" data-b="mine">My Trades</div></div>`)
  toggle.querySelectorAll('.addtab').forEach((x) => { x.onclick = () => { state.historyBox = x.dataset.b; state.historyPage = 1; refresh() } })
  c.appendChild(toggle)

  // Single item search — server-side across all trades. Debounced; refocus after re-render.
  const bar = el(`<div class="filterbar-single"><input id="hSearch" placeholder="Search an item to see its trades" /></div>`)
  const input = bar.querySelector('#hSearch')
  input.value = state.historySearch
  input.oninput = () => {
    state.historySearch = input.value; state.historyPage = 1; state._refocusHistory = true
    clearTimeout(window._histTimer)
    window._histTimer = setTimeout(() => refresh(), 250)
  }
  c.appendChild(bar)
  if (state._refocusHistory) setTimeout(() => { const el2 = document.getElementById('hSearch'); if (el2) { el2.focus(); el2.setSelectionRange(el2.value.length, el2.value.length) } state._refocusHistory = false }, 0)

  if (!state.history.length) {
    const what = state.historySearch ? `trades with "${state.historySearch}"` : (mine ? 'trades involving you' : 'completed trades')
    c.appendChild(el(`<div class="empty">No ${what} yet.</div>`)); return c
  }
  state.history.forEach((t) => {
    c.appendChild(el(`<div class="ad" style="grid-template-columns:1fr auto 1fr">
      <div class="side"><div class="label">${t.seller} gave</div><div class="items">${t.offering.map(itemPill).join('')}</div></div>
      <div class="arrow">⇄</div>
      <div class="side"><div class="label">${t.buyer} gave</div><div class="items">${t.requesting.map(itemPill).join('')}</div></div>
    </div>`))
  })
  c.appendChild(pager(state.historyPage, state.historyTotalPages, (n) => { state.historyPage = n; refresh() }))
  return c
}

// ── Global chat panel (floating right side) ───────────────────────────────────
let _gcPollTimer = null

function mountGlobalChat() {
  // Panel already exists — nothing to do
  if (document.getElementById('globalChat')) return

  // Only create when logged in
  if (!state.user) return

  const panel = el(`<div id="globalChat" class="gc-panel">
    <div class="gc-head">
      <span class="gc-title">💬 Global Chat</span>
    </div>
    <div class="gc-messages" id="gcMsgs"></div>
    <div class="gc-input-row">
      <input id="gcInput" placeholder="Say something..." maxlength="200" autocomplete="off" />
    </div>
  </div>`)

  document.body.appendChild(panel)

  const msgsEl = panel.querySelector('#gcMsgs')
  const input = panel.querySelector('#gcInput')

  function renderMessages() {
    const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60
    msgsEl.innerHTML = ''
    state.globalChat.messages.forEach((m) => {
      const mine = state.user && m.username === state.user.username
      const row = el(`<div class="gc-msg ${mine ? 'gc-mine' : ''}">
        <span class="gc-who" data-uid="${m.user_id || ''}" data-uname="${m.username}">${m.username}</span>
        <span class="gc-text">${escHtml(m.message)}</span>
      </div>`)
      row.querySelector('.gc-who').onclick = () => openDmWith(m.user_id, m.username)
      msgsEl.appendChild(row)
    })
    if (atBottom || state.globalChat.messages.length <= 10) msgsEl.scrollTop = msgsEl.scrollHeight
  }

  async function pollChat() {
    try {
      const d = await api.get('/api/chat/global')
      state.globalChat.messages = d.messages || []
      renderMessages()
    } catch {}
    _gcPollTimer = setTimeout(pollChat, 3000)
  }

  const send = async () => {
    const msg = input.value.trim()
    if (!msg) return
    input.value = ''
    try {
      await api.post('/api/chat/global', { message: msg })
      await pollChat()
    } catch (e) { toast(e.message, 'bad') }
  }
  input.onkeydown = (e) => { if (e.key === 'Enter') send() }

  clearTimeout(_gcPollTimer)
  pollChat()
}

async function openProfile(username) {
  state.tab = 'players'
  state.profileUser = { username, loading: true, stats: null, ads: [], inventory: [] }
  render()
  try {
    const d = await api.get(`/api/users/profile?username=${encodeURIComponent(username)}&game=${state.game}`)
    state.profileUser = { username, loading: false, ...d }
  } catch (e) {
    state.profileUser = { username, loading: false, error: e.message, stats: null, ads: [], inventory: [] }
  }
  render()
}

function playersView() {
  const wrap = el('<div></div>')

  // Search bar
  const searchRow = el('<div class="players-search-row"></div>')
  const input = el('<input class="players-input" placeholder="Search by Roblox username…" autocomplete="off" />')
  const btn = el('<button class="btn">Look Up</button>')
  searchRow.appendChild(input)
  searchRow.appendChild(btn)
  wrap.appendChild(searchRow)

  const doSearch = () => { const u = input.value.trim(); if (u) openProfile(u) }
  btn.onclick = doSearch
  input.onkeydown = (e) => { if (e.key === 'Enter') doSearch() }

  const p = state.profileUser
  if (!p) { wrap.appendChild(el('<div class="empty" style="margin-top:40px">Enter a username to view their profile.</div>')); return wrap }

  if (p.loading) { wrap.appendChild(el('<div class="empty" style="margin-top:40px">Loading…</div>')); return wrap }
  if (p.error) { wrap.appendChild(el(`<div class="empty" style="margin-top:40px">User not found.</div>`)); return wrap }

  // Profile header
  const head = el(`<div class="profile-head">
    <div class="profile-name">${escHtml(p.username)}</div>
    <div class="profile-stats">
      <div class="profile-stat"><div class="profile-stat-val">${p.stats?.completedTrades ?? 0}</div><div class="profile-stat-label">Trades Completed</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${p.ads?.length ?? 0}</div><div class="profile-stat-label">Active Listings</div></div>
      <div class="profile-stat"><div class="profile-stat-val">${p.inventory?.length ?? 0}</div><div class="profile-stat-label">Items Held</div></div>
    </div>
    ${state.user && state.user.username !== p.username ? `<div class="profile-actions">
      <button class="btn" id="profOffer">🤝 Make Offer</button>
      <button class="btn ghost" id="profDm">💬 DM</button>
    </div>` : ''}
  </div>`)
  head.querySelector('#profOffer')?.addEventListener('click', () => openDirectOffer(p.username))
  head.querySelector('#profDm')?.addEventListener('click', () => openDmWith(null, p.username))
  wrap.appendChild(head)

  // Active trades
  wrap.appendChild(el('<h3 class="inv-h" style="margin:28px 0 12px">Active Trades</h3>'))
  if (!p.ads?.length) {
    wrap.appendChild(el('<div class="empty">No open trades.</div>'))
  } else {
    const grid = el('<div class="profile-ads"></div>')
    p.ads.forEach((ad) => grid.appendChild(adCard(ad)))
    wrap.appendChild(grid)
  }

  // Inventory
  wrap.appendChild(el('<h3 class="inv-h" style="margin:28px 0 12px">Inventory</h3>'))
  if (!p.inventory?.length) {
    wrap.appendChild(el('<div class="empty">No items.</div>'))
  } else {
    const grid = el('<div class="pickgrid"></div>')
    p.inventory.forEach((it) => {
      grid.appendChild(el(`<div class="pickcard">
        ${itemImg(it.item, 'pick-img')}
        <div class="pick-n">${it.item}</div>
        <div class="pick-r">${it.rarity ?? ''}${tierChip(it.item)} · ×${it.qty}</div>
      </div>`))
    })
    wrap.appendChild(grid)
  }

  return wrap
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function userPopover(e, username) {
  e.stopPropagation()
  document.getElementById('userPopover')?.remove()
  const pop = el(`<div id="userPopover" class="user-pop">
    <button class="user-pop-btn" id="upProfile">👤 View Profile</button>
    <button class="user-pop-btn" id="upOffer">🤝 Make Offer</button>
    <button class="user-pop-btn" id="upDm">💬 Send DM</button>
  </div>`)
  pop.style.top = (e.clientY + window.scrollY + 4) + 'px'
  pop.style.left = (e.clientX + window.scrollX) + 'px'
  document.body.appendChild(pop)
  pop.querySelector('#upProfile').onclick = () => { pop.remove(); openProfile(username) }
  pop.querySelector('#upOffer').onclick = () => { pop.remove(); openDirectOffer(username) }
  pop.querySelector('#upDm').onclick = () => { pop.remove(); openDmWith(null, username) }
  const dismiss = () => { pop.remove(); document.removeEventListener('click', dismiss) }
  setTimeout(() => document.addEventListener('click', dismiss), 0)
}

async function openDirectOffer(username) {
  if (!state.user) { toast('Log in to send offers', 'bad'); return }
  state.tradeAd = { username, id: null, direct: true }
  state.tradeBuilder = { offer: [], request: [] }
  state.tab = 'trade'
  try {
    const [mine, theirs] = await Promise.all([
      api.get(`/api/inventory?game=${state.game}`),
      api.get(`/api/inventory?game=${state.game}&user=${encodeURIComponent(username)}`),
    ])
    state.myInv = mine.items || []
    state.theirInv = theirs.items || []
  } catch (e) { toast(e.message, 'bad') }
  render()
}

// Open a DM conversation with a user by their id+name
async function openDmWith(userId, username) {
  if (!state.user) { toast('Log in to send messages', 'bad'); return }
  if (userId === state.user.id || username === state.user.username) return
  // If we don't have userId, look it up
  if (!userId) {
    try { const r = await api.get(`/api/users/lookup?username=${encodeURIComponent(username)}`); userId = r.user.id } catch { toast('User not found', 'bad'); return }
  }
  state.dms.activeId = userId
  state.dms.activeName = username
  state.tab = 'messages'
  refresh()
}

// ── Messages tab (DMs) ────────────────────────────────────────────────────────
function messagesView() {
  const c = el('<div class="dm-layout"></div>')

  // Sidebar: conversation list
  const sidebar = el('<div class="dm-sidebar"></div>')
  const sideHead = el('<div class="dm-sidebar-head">Messages</div>')
  sidebar.appendChild(sideHead)

  if (!state.dms.conversations.length && !state.dms.activeId) {
    sidebar.appendChild(el('<div class="empty" style="padding:20px 12px;font-size:13px">No conversations yet.<br>Click a username on any trade to start a DM.</div>'))
  } else {
    state.dms.conversations.forEach((conv) => {
      const active = conv.partner_id === state.dms.activeId
      const row = el(`<div class="dm-conv ${active ? 'dm-conv-active' : ''}">
        <div class="dm-conv-name">${escHtml(conv.partner_name)}</div>
        <div class="dm-conv-preview">${escHtml(conv.message || '')}</div>
      </div>`)
      row.onclick = () => { state.dms.activeId = conv.partner_id; state.dms.activeName = conv.partner_name; refresh() }
      sidebar.appendChild(row)
    })
  }
  c.appendChild(sidebar)

  // Thread panel
  const thread = el('<div class="dm-thread"></div>')
  if (!state.dms.activeId) {
    thread.appendChild(el('<div class="empty" style="margin-top:60px">Select a conversation or click a username to start chatting.</div>'))
  } else {
    const head = el(`<div class="dm-thread-head">${escHtml(state.dms.activeName)}</div>`)
    thread.appendChild(head)

    const msgs = el('<div class="dm-msgs" id="dmMsgs"></div>')
    state.dms.messages.forEach((m) => {
      const mine = m.from_id === state.user.id
      msgs.appendChild(el(`<div class="dm-msg ${mine ? 'dm-mine' : ''}">
        <div class="dm-bubble">${escHtml(m.message)}</div>
        <div class="dm-ts">${new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
      </div>`))
    })
    thread.appendChild(msgs)
    setTimeout(() => { const el2 = document.getElementById('dmMsgs'); if (el2) el2.scrollTop = el2.scrollHeight }, 0)

    const inputRow = el('<div class="dm-input-row"></div>')
    const input = el('<input class="dm-input" placeholder="Type a message..." maxlength="500" autocomplete="off" />')
    const sendBtn = el('<button class="btn">Send</button>')
    const sendDm = async () => {
      const msg = input.value.trim()
      if (!msg) return
      input.value = ''
      try {
        await api.post(`/api/chat/dms/${state.dms.activeId}`, { message: msg })
        refresh()
      } catch (e) { toast(e.message, 'bad') }
    }
    sendBtn.onclick = sendDm
    input.onkeydown = (e) => { if (e.key === 'Enter') sendDm() }
    inputRow.appendChild(input); inputRow.appendChild(sendBtn)
    thread.appendChild(inputRow)
  }
  c.appendChild(thread)
  return c
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  state.games = (await api.get('/api/games')).games
  state.user = (await api.get('/api/me')).user
  if (state.user) await refresh()
  else render()
}
boot()
