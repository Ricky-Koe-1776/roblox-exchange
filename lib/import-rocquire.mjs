// Shared Rocquire import: used by scripts/import-rocquire.mjs and the one-time admin endpoint.
import crypto from 'crypto'
// Listings go under the house seller account. Sourcing fields (source_*) stay server-side only.
export const HOUSE = { id: 'house-roblox-exchange', username: 'RobloxExchange' }

export function prepareRows(raw, MARKUP = 0.10) {
  return raw
  .filter((x) => x.status === 'ACTIVE' && x.creator_type === 'GROUP' && x.place_id && x.universe_id)
  .map((x) => {
    const baseCents = Number(x.price_cents) > 0 ? Number(x.price_cents) : Number(x.floor_cents) || 0
    return {
      sourceId: x.id,
      sourceUrl: `https://rocquire.com/listing/${x.canonical_slug || x.id}`,
      groupId: String(x.creator_id),
      placeId: String(x.place_id),
      universeId: String(x.universe_id),
      title: String(x.title || '').trim().slice(0, 80),
      description: String(x.description || x.seller_description || '').trim().slice(0, 2000),
      costUsd: baseCents / 100,
      priceUsd: Math.round(baseCents * (1 + MARKUP)) / 100,
      thumb: x.hero_thumbnail_url || x.thumbnail_url || x.icon_url || null,
      ccu: x.playing || 0, visits: x.visits || 0, favorites: x.favorites_count || 0,
    }
  })
  .filter((r) => r.priceUsd > 0 && r.title)
}


async function getJson(url) { try { const r = await fetch(url); return r.ok ? await r.json() : null } catch { return null } }
export async function refreshFromRoblox(rows) {
for (let i = 0; i < rows.length; i += 50) {
  const chunk = rows.slice(i, i + 50), ids = chunk.map((r) => r.universeId).join(',')
  const games = (await getJson(`https://games.roblox.com/v1/games?universeIds=${ids}`))?.data || []
  const icons = (await getJson(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${ids}&size=512x512&format=Png`))?.data || []
  for (const r of chunk) {
    const g = games.find((x) => String(x.id) === r.universeId)
    if (g) { r.ccu = g.playing || 0; r.visits = g.visits || 0; r.favorites = g.favoritedCount || 0 }
    const ic = icons.find((x) => String(x.targetId) === r.universeId)
    if (ic?.imageUrl) r.thumb = ic.imageUrl
  }
}

}

export async function writeRows(sql, rows) {
  // Same shapes as ensureInit() in api/[...path].js, in case this DB predates the game-marketplace rewrite.
  await sql`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, roblox_id TEXT UNIQUE, avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`
  await sql`CREATE TABLE IF NOT EXISTS rex_game_listings (
    id TEXT PRIMARY KEY, seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, seller_username TEXT NOT NULL,
    group_id TEXT NOT NULL, place_id TEXT NOT NULL, universe_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT DEFAULT '',
    price_usdc NUMERIC NOT NULL, ccu INTEGER DEFAULT 0, visits BIGINT DEFAULT 0, favorites INTEGER DEFAULT 0, thumbnail_url TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  await sql`ALTER TABLE rex_game_listings ADD COLUMN IF NOT EXISTS source TEXT`
  await sql`ALTER TABLE rex_game_listings ADD COLUMN IF NOT EXISTS source_listing_id TEXT`
  await sql`ALTER TABLE rex_game_listings ADD COLUMN IF NOT EXISTS source_url TEXT`
  await sql`ALTER TABLE rex_game_listings ADD COLUMN IF NOT EXISTS source_price_usdc NUMERIC`
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS rex_listings_source_uq ON rex_game_listings (source, source_listing_id)`
  await sql`INSERT INTO users (id, username) VALUES (${HOUSE.id}, ${HOUSE.username}) ON CONFLICT (id) DO NOTHING`

  let n = 0
  for (const r of rows) {
    await sql`
      INSERT INTO rex_game_listings (id, seller_id, seller_username, group_id, place_id, universe_id, title, description, price_usdc, ccu, visits, favorites, thumbnail_url, source, source_listing_id, source_url, source_price_usdc)
      VALUES (${crypto.randomUUID()}, ${HOUSE.id}, ${HOUSE.username}, ${r.groupId}, ${r.placeId}, ${r.universeId}, ${r.title}, ${r.description}, ${r.priceUsd}, ${r.ccu}, ${r.visits}, ${r.favorites}, ${r.thumb}, 'rocquire', ${r.sourceId}, ${r.sourceUrl}, ${r.costUsd})
      ON CONFLICT (source, source_listing_id) DO UPDATE SET
        title = EXCLUDED.title, description = EXCLUDED.description, price_usdc = EXCLUDED.price_usdc,
        source_price_usdc = EXCLUDED.source_price_usdc, ccu = EXCLUDED.ccu, visits = EXCLUDED.visits,
        favorites = EXCLUDED.favorites, thumbnail_url = EXCLUDED.thumbnail_url`
    n++
  }
  return n
}
