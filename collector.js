import 'dotenv/config';
import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';

// ── Environment ───────────────────────────────────────────────────────────────
const CMC_KEY  = process.env.CMC_API_KEY;
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
const ARB_RPC  = process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc';
const DRY_RUN  = process.env.DRY_RUN === 'true' || !SUPA_URL || !SUPA_KEY;

// ── Asset config ──────────────────────────────────────────────────────────────
// rwa_id: from /v5/real-world-assets/assets/list (confirmed via probe-output).
// preferToken: console summary only — every token gets its own row regardless.
// clAddress: Chainlink AggregatorV3 proxy on Arbitrum One.
//   Verified at startup via description().  null = no feed, gap_pct stays null.
//
// Weekend / holiday rule: gap_pct (vs Chainlink) is NULL on non-trading days.
//   The 24/7 XAU/USD feed is NOT used as a weekend reference because it may be
//   derived from PAXG/XAUt prices, which would be circular.
//   gap_vs_peers_pct (intra-token spread) is computed every day regardless.
//
// Alert threshold: 1%.  Equity feeds update on 0.5% moves → 1% = real signal.
const ASSETS = {
  GOLD: { rwa_id: 1,   preferToken: 'PAXG',  clAddress: '0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c' },
  NVDA: { rwa_id: 2,   preferToken: 'NVDAB', clAddress: '0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F' },
  TSLA: { rwa_id: 14,  preferToken: 'TSLAB', clAddress: '0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3' },
  SPY:  { rwa_id: 86,  preferToken: 'SPYB',  clAddress: '0x46306F3795342117721D8DEd50fbcF6DF2b3cc10' },
  QQQ:  { rwa_id: 118, preferToken: 'QQQB',  clAddress: null }, // no Arbitrum feed
};

// ── Chainlink (AggregatorV3) ───────────────────────────────────────────────────
const AGG_ABI = [
  'function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)',
  'function description()     view returns (string)',
  'function decimals()        view returns (uint8)',
];

let _arbProv;
const arbProv = () => (_arbProv ??= new ethers.JsonRpcProvider(ARB_RPC));

async function readFeed(sym, address) {
  const c = new ethers.Contract(address, AGG_ABI, arbProv());
  const [desc, dec, [, answer, , updatedAt]] = await Promise.all([
    c.description(),
    c.decimals(),
    c.latestRoundData(),
  ]);
  const price      = Number(answer) / 10 ** Number(dec);
  const updatedISO = new Date(Number(updatedAt) * 1000).toISOString();
  console.log(`  CL [${sym}] description()="${desc}"  $${price.toFixed(4)}  updated=${updatedISO}`);
  return { price, updatedAt: updatedISO, description: desc };
}

// ── CMC fetch (one call, all assets) ──────────────────────────────────────────
async function fetchCmc() {
  const url = new URL('https://pro-api.coinmarketcap.com/v5/real-world-assets/quotes/latest');
  url.searchParams.set('rwa_id', Object.values(ASSETS).map(a => a.rwa_id).join(','));
  const r = await fetch(url.toString(), { headers: { 'X-CMC_PRO_API_KEY': CMC_KEY } });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`CMC ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

// ── Market calendar ───────────────────────────────────────────────────────────
const isWeekend = () => { const d = new Date().getUTCDay(); return d === 0 || d === 6; };

// NYSE full-close holidays.  UTC dates (YYYY-MM-DD).  Add future years as needed.
const FULL_CLOSE = new Set([
  '2026-11-26', // Thanksgiving Thursday
  '2026-12-25', // Christmas Day
  '2027-01-01', // New Year's Day
]);
// Early-close days (1:00 PM ET).  UTC equivalents assume EST (UTC-5, Nov–Mar).
const EARLY_CLOSE = new Set([
  '2026-11-27', // Day after Thanksgiving — closes 1:00 PM ET = 18:00 UTC
]);

function isNYSEOpen() {
  if (isWeekend()) return false;
  const now     = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
  if (FULL_CLOSE.has(dateStr)) return false;
  const mins     = now.getUTCHours() * 60 + now.getUTCMinutes();
  const closeUTC = EARLY_CLOSE.has(dateStr) ? 1080 : 1260; // 18:00 or 21:00 UTC
  return mins >= 870 && mins < closeUTC; // open from 14:30 UTC (9:30 AM ET, EST)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function collect() {
  if (!CMC_KEY) { console.error('CMC_API_KEY is required'); process.exit(1); }

  const collectedAt = new Date().toISOString();
  const weekend     = isWeekend();
  const marketOpen  = isNYSEOpen();
  console.log(`\n[${collectedAt}]  weekend=${weekend}  market_open=${marketOpen}  dry_run=${DRY_RUN}`);

  // 1. Read all Chainlink feeds in parallel — description() printed per feed
  console.log('\nChainlink:');
  const cl = {};
  await Promise.allSettled(
    Object.entries(ASSETS).map(async ([sym, cfg]) => {
      if (!cfg.clAddress) {
        console.log(`  ${sym}: no Arbitrum feed — gap_pct will be null`);
        return;
      }
      try   { cl[sym] = await readFeed(sym, cfg.clAddress); }
      catch (e) { console.error(`  ${sym} feed error: ${e.message}`); }
    })
  );

  // 2. CMC quotes — one API credit
  const cmcJson = await fetchCmc();
  const rwaList  = cmcJson.data?.rwa_assets ?? [];

  // Pre-pass: build valid peer pool per asset.
  // "Valid" = non-unit_mismatch and non-null price/symbol.
  // Used to compute gap_vs_peers_pct for every token (weekends included).
  const validPeers = {};
  for (const [sym, cfg] of Object.entries(ASSETS)) {
    const rwa = rwaList.find(a => a.rwa_id === cfg.rwa_id);
    if (!rwa) continue;
    const avg = rwa.average_tokenized_price
             ?? rwa.quotes?.[0]?.average_tokenized_price
             ?? null;
    validPeers[sym] = (rwa.tokens ?? [])
      .filter(t => t.price != null && t.symbol != null)
      .filter(t => !(avg > 0 && Math.abs(t.price - avg) / avg > 0.30))
      .map(t => ({ crypto_id: t.crypto_id ?? null, symbol: t.symbol, price: t.price }));
  }

  // 3. Build rows — one row per token per poll
  const rows    = [];
  const summary = {};

  for (const [sym, cfg] of Object.entries(ASSETS)) {
    const rwa = rwaList.find(a => a.rwa_id === cfg.rwa_id);
    if (!rwa) { console.warn(`  ${sym} rwa_id=${cfg.rwa_id}: not in CMC response`); continue; }

    const avgPrice = rwa.average_tokenized_price
                  ?? rwa.quotes?.[0]?.average_tokenized_price
                  ?? null;
    const ref = cl[sym] ?? null;

    let stored = 0, skipped = 0, flagged = 0;
    const clGaps   = []; // for per-asset summary
    const peerGaps = [];

    for (const token of (rwa.tokens ?? [])) {
      if (token.price == null || token.symbol == null) { skipped++; continue; }

      // Tokens >30% from the asset average are almost certainly in a different unit
      // (e.g. CGO/VNXAU price gold per gram ~$123 vs per troy oz ~$3,840)
      const unitMismatch = avgPrice != null && avgPrice > 0
        && Math.abs(token.price - avgPrice) / avgPrice > 0.30;
      if (unitMismatch) flagged++;

      // Chainlink gap: null when market closed (weekends, holidays, off-hours),
      // null for unit_mismatch, null if no feed
      let gapPct = null;
      if (marketOpen && !unitMismatch && ref?.price != null && ref.price !== 0) {
        gapPct = ((token.price - ref.price) / ref.price) * 100;
      }
      const alert = gapPct != null && Math.abs(gapPct) >= 1.0;
      if (gapPct != null) clGaps.push(gapPct);

      // Peer gap: exclude self by crypto_id (fall back to symbol if id absent)
      let gapVsPeersPct = null;
      if (!unitMismatch) {
        const selfId   = token.crypto_id ?? null;
        const others   = (validPeers[sym] ?? [])
          .filter(p => selfId != null ? p.crypto_id !== selfId : p.symbol !== token.symbol)
          .map(p => p.price);
        const peerMed  = median(others);
        if (peerMed != null && peerMed !== 0) {
          gapVsPeersPct = (token.price - peerMed) / peerMed * 100;
        }
        if (gapVsPeersPct != null) peerGaps.push(gapVsPeersPct);
      }

      rows.push({
        collected_at:        collectedAt,
        asset:               sym,
        token_symbol:        token.symbol,
        issuer:              token.issuer_name ?? null,
        crypto_id:           token.crypto_id ?? null,
        token_price_usd:     token.price,
        token_market_cap:    token.market_cap ?? null,
        token_volume_24h:    token.volume_24h ?? null,
        avg_tokenized_price: avgPrice,
        unit_mismatch:       unitMismatch,
        ref_price_usd:       unitMismatch ? null : (ref?.price ?? null),
        ref_updated_at:      ref?.updatedAt ?? null,
        chainlink_desc:      ref?.description ?? null,
        gap_pct:             gapPct,
        gap_vs_peers_pct:    gapVsPeersPct,
        alert,
        market_open:         marketOpen,
        weekend,
        chainlink_feed:      cfg.clAddress ?? null,
      });
      stored++;
    }

    summary[sym] = { stored, skipped, flagged, cl: ref, clGaps, peerGaps };
  }

  // 4. Summary
  console.log('\nPer-asset results:');
  let total = 0;
  for (const [sym, s] of Object.entries(summary)) {
    const cfg     = ASSETS[sym];
    const prefRow = rows.find(r => r.asset === sym && r.token_symbol === cfg.preferToken);
    const clStr   = s.cl
      ? `cl=$${s.cl.price.toFixed(2)} (${s.cl.description})`
      : 'cl=no feed';
    const clGapStr = prefRow?.gap_pct != null
      ? `  ${cfg.preferToken}_gap=${prefRow.gap_pct.toFixed(3)}%`
      : '';
    const pgMin = s.peerGaps.length ? Math.min(...s.peerGaps).toFixed(3) + '%' : 'n/a';
    const pgMax = s.peerGaps.length ? Math.max(...s.peerGaps).toFixed(3) + '%' : 'n/a';
    console.log(
      `  ${sym.padEnd(4)}: ${String(s.stored).padStart(2)} rows` +
      (s.skipped ? ` | ${s.skipped} null-price skipped` : '') +
      (s.flagged ? ` | ${s.flagged} unit_mismatch` : '') +
      `  ${clStr}${clGapStr}  peer_gap=[${pgMin}, ${pgMax}]`
    );
    total += s.stored;
  }
  console.log(`  Total: ${total} rows`);

  // 5. Write
  if (DRY_RUN) {
    console.log('\n[DRY RUN] — no DB write (set SUPABASE_URL + SUPABASE_ANON_KEY to enable)');
  } else {
    const db = createClient(SUPA_URL, SUPA_KEY);
    const { error } = await db.from('rwa_quotes').insert(rows);
    if (error) throw new Error(`Supabase insert: ${error.message}`);
    console.log(`\nInserted ${rows.length} rows into rwa_quotes.`);
  }

  return rows;
}

collect().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
