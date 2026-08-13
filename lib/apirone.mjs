// Apirone client — crypto payment processing for the game marketplace escrow.
// https://apirone.com/docs/
//
// Apirone holds the wallet infrastructure; we just call their REST API. Two
// env vars required at runtime:
//   APIRONE_ACCOUNT       the "apr-..." account id
//   APIRONE_TRANSFER_KEY  the transfer-key issued when that account was created
//
// The account itself is a ONE-TIME manual signup step — create it yourself at
// apirone.com (or via `POST /accounts` with your own profile info) and paste
// the resulting account id + transfer-key into the environment. This module
// never creates an Apirone account on its own.
//
// Order finalization in this app is MANUAL (an admin confirms the Roblox
// transfer happened and releases the seller's payout) — this module only
// handles taking the buyer's payment and, later, sending payouts once an
// admin approves a withdrawal. It does not auto-release funds.
//
// Note: the invoice create/status endpoints below are directly from Apirone's
// docs and are solid. The payout/transfer endpoint shape is reconstructed
// from partial docs + SDK snippets and hasn't been hit against the live API —
// verify it against your Apirone dashboard/docs before relying on it, and
// until then just process withdrawal requests by hand from the Apirone
// dashboard and mark the ledger row 'sent' (see /marketplace/wallet/withdraw
// in api/[...path].js).

const BASE = 'https://apirone.com/api/v2'
const CURRENCY = process.env.APIRONE_CURRENCY || 'usdc@trx' // usdc@trx | usdc@eth | usdc@bnb | usdt@trx etc.

function creds() {
  const account = process.env.APIRONE_ACCOUNT
  const transferKey = process.env.APIRONE_TRANSFER_KEY
  if (!account || !transferKey) throw new Error('Apirone is not configured (APIRONE_ACCOUNT / APIRONE_TRANSFER_KEY missing)')
  return { account, transferKey }
}

// Apirone amounts are integers in the currency's minor units. USDC has 6 decimals.
function toMinorUnits(amountUsdc) { return Math.round(Number(amountUsdc) * 1_000_000) }
function fromMinorUnits(minor) { return Number(minor) / 1_000_000 }

export async function createInvoice({ amountUsdc, orderId, callbackUrl }) {
  const { account } = creds()
  const res = await fetch(`${BASE}/accounts/${account}/invoices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      currency: CURRENCY,
      amount: toMinorUnits(amountUsdc),
      'callback-url': callbackUrl,
      'user-data': { title: `Rocblox Exchange order ${orderId}`, order_id: orderId },
    }),
  })
  if (!res.ok) throw new Error(`Apirone invoice create failed: ${res.status} ${await res.text().catch(() => '')}`)
  const data = await res.json()
  return { invoiceId: data.invoice, address: data.address, status: data.status, currency: data.currency }
}

export async function getInvoiceStatus(invoiceId) {
  const { account, transferKey } = creds()
  const res = await fetch(`${BASE}/accounts/${account}/invoices/${invoiceId}?transfer-key=${encodeURIComponent(transferKey)}`)
  if (!res.ok) throw new Error(`Apirone invoice lookup failed: ${res.status} ${await res.text().catch(() => '')}`)
  const data = await res.json()
  return { status: data.status, amount: fromMinorUnits(data.amount), history: data.history || [] }
}

// Best-effort payout call — see the note at the top of this file. Wrap calls
// to this in try/catch; on failure, fall back to sending the payout manually
// from the Apirone dashboard and marking the withdrawal row 'sent'.
export async function sendPayout(toAddress, amountUsdc) {
  const { account, transferKey } = creds()
  const res = await fetch(`${BASE}/accounts/${account}/payments/${CURRENCY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'transfer-key': transferKey,
      destinations: [{ address: toAddress, amount: toMinorUnits(amountUsdc) }],
    }),
  })
  if (!res.ok) throw new Error(`Apirone payout failed: ${res.status} ${await res.text().catch(() => '')}`)
  return await res.json()
}
