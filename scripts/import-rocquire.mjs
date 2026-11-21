// Import Rocquire game listings into rex_game_listings at a markup.
// Usage: DATABASE_URL=... node scripts/import-rocquire.mjs <listings.json> [--markup 0.10] [--dry]
import fs from 'fs'
import { neon } from '@neondatabase/serverless'
import { prepareRows, refreshFromRoblox, writeRows } from '../lib/import-rocquire.mjs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--'))
const dry = args.includes('--dry')
const mi = args.indexOf('--markup')
const MARKUP = mi >= 0 ? Number(args[mi + 1]) : 0.10
if (!file) { console.error('usage: node scripts/import-rocquire.mjs <listings.json> [--markup 0.10] [--dry]'); process.exit(1) }
if (!dry && !process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1) }

const rows = prepareRows(JSON.parse(fs.readFileSync(file, 'utf8')), MARKUP)
await refreshFromRoblox(rows)
console.log(`${rows.length} listings to import (markup ${(MARKUP * 100).toFixed(0)}%)`)
console.table(rows.slice(0, 5).map((r) => ({ title: r.title.slice(0, 30), cost: r.costUsd, price: r.priceUsd, ccu: r.ccu })))
if (dry) process.exit(0)
console.log(`upserted ${await writeRows(neon(process.env.DATABASE_URL), rows)} listings`)
