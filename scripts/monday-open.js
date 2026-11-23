import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPA_URL || !SUPA_KEY) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');
const ARB_RPC = process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc';

const sb = createClient(SUPA_URL, SUPA_KEY);

// ── Pagination ────────────────────────────────────────────────────────────────
async function fetchAll() {
  const PAGE = 1000;
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('rwa_quotes').select('*')
      .order('collected_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Supabase: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    process.stdout.write(`\r  Fetched ${rows.length} rows...`);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  process.stdout.write('\n');
  return rows;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function f(v, dp = 4) { return v == null ? '—' : Number(v).toFixed(dp); }

// ── Part A: stale detection ───────────────────────────────────────────────────
function findStale(rows) {
  const byCryptoId = {};
  for (const r of rows) {
    if (r.crypto_id == null) continue;
    (byCryptoId[r.crypto_id] ??= []).push(r);
  }

  const stale = [];
  for (const [cid, cr] of Object.entries(byCryptoId)) {
    cr.sort((a, b) => new Date(a.collected_at) - new Date(b.collected_at));

    let curStart = 0;
    let maxRun = { start: 0, len: 1 };
    for (let i = 1; i < cr.length; i++) {
      if (String(cr[i].token_price_usd) === String(cr[i - 1].token_price_usd)) {
        const len = i - curStart + 1;
        if (len > maxRun.len) maxRun = { start: curStart, len };
      } else {
        curStart = i;
      }
    }

    if (maxRun.len >= 8) {
      const run = cr.slice(maxRun.start, maxRun.start + maxRun.len);
      stale.push({
        crypto_id:         Number(cid),
        token_symbol:      run[0].token_symbol,
        issuer:            run[0].issuer ?? '—',
        asset:             run[0].asset,
        frozen_price:      Number(run[0].token_price_usd),
        first_seen:        run[0].collected_at,
        last_seen:         run[run.length - 1].collected_at,
        run_len:           maxRun.len,
        market_open_count: run.filter(r => r.market_open).length,
      });
    }
  }
  return stale.sort((a, b) => b.run_len - a.run_len);
}

// ── Unique identifier analysis ────────────────────────────────────────────────
function checkUnique(rows) {
  const symToCids = {};
  for (const r of rows) {
    if (r.crypto_id == null) continue;
    (symToCids[r.token_symbol] ??= new Set()).add(r.crypto_id);
  }
  const ambig = Object.entries(symToCids)
    .filter(([, ids]) => ids.size > 1)
    .map(([sym, ids]) => ({ sym, ids: [...ids] }));
  return {
    distinctCryptoIds:    new Set(rows.map(r => r.crypto_id).filter(Boolean)).size,
    distinctSymbols:      new Set(rows.map(r => r.token_symbol)).size,
    distinctSymbolIssuer: new Set(rows.map(r => `${r.token_symbol}||${r.issuer ?? ''}`)).size,
    ambigSymbols:         ambig,
  };
}

// ── Chainlink: find Monday-open boundary ─────────────────────────────────────
const AGG_ABI = [
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

const CL_FEEDS = {
  SPY:  '0x46306F3795342117721D8DEd50fbcF6DF2b3cc10',
  NVDA: '0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F',
  TSLA: '0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3',
};

const MON_OPEN_MS = new Date('2026-11-23T14:30:00.000Z').getTime();

async function findCLBoundary(sym, provider) {
  const contract = new ethers.Contract(CL_FEEDS[sym], AGG_ABI, provider);
  const [dec, latest] = await Promise.all([contract.decimals(), contract.latestRoundData()]);
  const decNum = Number(dec);

  // Walk back from latest; firstPost = earliest round >= MON_OPEN_MS, lastPre = latest round before it
  let firstPost = null;
  let lastPre   = null;

  process.stdout.write(`  Walking ${sym} rounds`);
  for (let i = 0n; i < 200n; i++) {
    const rid = latest.roundId - i;
    if (rid <= 0n) break;
    try {
      const r  = await contract.getRoundData(rid);
      const ts = Number(r.updatedAt) * 1000;
      if (ts === 0) continue;
      const price = Number(r.answer) / 10 ** decNum;
      if (ts >= MON_OPEN_MS) {
        firstPost = { price, updatedAt: new Date(ts), roundId: rid };
      } else {
        lastPre = { price, updatedAt: new Date(ts), roundId: rid };
        break;
      }
    } catch { break; }
    if (i % 20n === 19n) process.stdout.write('.');
  }
  process.stdout.write(' done\n');
  return { firstPost, lastPre };
}

// ── Target timestamps ─────────────────────────────────────────────────────────
const TARGETS = [
  { label: 'Fri 20:45', iso: '2026-11-20T20:45:00Z' },
  { label: 'Sat 12:00', iso: '2026-11-21T12:00:00Z' },
  { label: 'Sun 12:00', iso: '2026-11-22T12:00:00Z' },
  { label: 'Sun 22:00', iso: '2026-11-22T22:00:00Z' },
  { label: 'Mon 13:00', iso: '2026-11-23T13:00:00Z' },
  { label: 'Mon 14:15', iso: '2026-11-23T14:15:00Z' },
  { label: 'Mon 14:30', iso: '2026-11-23T14:30:00Z' },
  { label: 'Mon 14:45', iso: '2026-11-23T14:45:00Z' },
  { label: 'Mon 15:30', iso: '2026-11-23T15:30:00Z' },
];

function nearestPoll(sortedPolls, targetMs) {
  let best = null, bestDiff = Infinity;
  for (const ts of sortedPolls) {
    const diff = Math.abs(new Date(ts).getTime() - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = ts; }
    else if (diff > bestDiff) break;
  }
  return { ts: best, diffMin: bestDiff / 60_000 };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching all rows from rwa_quotes…');
  const allRows = await fetchAll();
  console.log(`Total rows: ${allRows.length}\n`);

  console.log('Part A: detecting stale tokens…');
  const staleList = findStale(allRows);
  const staleIds  = new Set(staleList.map(s => s.crypto_id));
  const unique    = checkUnique(allRows);
  console.log(`  Found ${staleList.length} stale token(s)\n`);

  const ASSETS_B = ['SPY', 'NVDA', 'TSLA'];
  const pollSet  = [...new Set(allRows.map(r => r.collected_at))].sort();

  // Index: "collectedAt|asset" → rows (non-stale, non-unit_mismatch)
  const idx = {};
  for (const r of allRows) {
    if (r.unit_mismatch || staleIds.has(r.crypto_id)) continue;
    if (!ASSETS_B.includes(r.asset)) continue;
    const k = `${r.collected_at}|${r.asset}`;
    (idx[k] ??= []).push(r);
  }

  // 9-timestamp table per asset
  const tableData = {};
  for (const asset of ASSETS_B) {
    tableData[asset] = TARGETS.map(tgt => {
      const { ts, diffMin } = nearestPoll(pollSet, new Date(tgt.iso).getTime());
      const rows = ts ? (idx[`${ts}|${asset}`] ?? []) : [];
      const med  = median(rows.map(r => Number(r.token_price_usd)));
      const ref  = rows.find(r => r.ref_price_usd != null)?.ref_price_usd ?? null;
      const refAt = rows.find(r => r.ref_updated_at != null)?.ref_updated_at ?? null;
      const gap  = med != null && ref != null ? (med - Number(ref)) / Number(ref) * 100 : null;
      return { label: tgt.label, nearestPoll: ts, diffMin, med, ref: ref != null ? Number(ref) : null, refAt, gap };
    });
  }

  // Friday-close CL from DB (last market_open poll before weekend)
  const FRI_BEFORE = new Date('2026-11-21T00:00:00Z').getTime();
  const friClose = {};
  for (const asset of ASSETS_B) {
    const sorted = allRows
      .filter(r => r.asset === asset && r.market_open && r.ref_price_usd != null)
      .sort((a, b) => new Date(b.collected_at) - new Date(a.collected_at));
    const r = sorted.find(r => new Date(r.collected_at).getTime() < FRI_BEFORE);
    friClose[asset] = r ? { ts: r.collected_at, price: Number(r.ref_price_usd) } : null;
  }

  // Monday-open CL from live Chainlink
  console.log('Fetching Monday-open CL boundaries from Arbitrum One…');
  const provider   = new ethers.JsonRpcProvider(ARB_RPC);
  const clBoundary = {};
  for (const asset of ASSETS_B) {
    clBoundary[asset] = await findCLBoundary(asset, provider);
  }

  // Move stats
  const moveStats = {};
  for (const asset of ASSETS_B) {
    const fri      = friClose[asset];
    const cl       = clBoundary[asset];
    const friCL    = fri?.price ?? null;
    const monCL    = cl?.firstPost?.price ?? null;
    const clMove   = friCL && monCL ? (monCL - friCL) / friCL * 100 : null;
    const friMed   = tableData[asset][0]?.med ?? null;   // index 0 = Fri 20:45
    const mon1415  = tableData[asset][5]?.med ?? null;   // index 5 = Mon 14:15
    const mon1430  = tableData[asset][6]?.med ?? null;   // index 6 = Mon 14:30
    const mon1430R = tableData[asset][6]?.ref ?? null;
    const tokMove  = friMed && mon1415 ? (mon1415 - friMed) / friMed * 100 : null;
    const pctIn    = clMove && tokMove != null ? tokMove / clMove * 100 : null;
    const gap1430  = mon1430 != null && mon1430R != null ? (mon1430 - mon1430R) / mon1430R * 100 : null;
    const secsToUpdate = cl?.firstPost
      ? Math.round((cl.firstPost.updatedAt.getTime() - MON_OPEN_MS) / 1000) : null;
    moveStats[asset] = { friCL, monCL, clMove, friMed, mon1415, tokMove, pctIn, gap1430, secsToUpdate };
  }

  // ref_updated_at check
  const refSample = allRows.find(r => r.ref_updated_at != null);
  const refCount  = allRows.filter(r => r.ref_updated_at != null).length;
  const refNull   = allRows.filter(r => r.ref_updated_at == null).length;

  const md = buildMd({ staleList, unique, tableData, moveStats, clBoundary, friClose, refSample, refCount, refNull });

  const OUT = join(__dirname, '..', 'data-out');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'monday-open.md'), md);

  console.log('\nWrote: data-out/monday-open.md\n');
  console.log(md);
}

// ── Markdown builder ──────────────────────────────────────────────────────────
function buildMd({ staleList, unique, tableData, moveStats, clBoundary, friClose, refSample, refCount, refNull }) {
  const lines = [];
  const p = (s = '') => lines.push(s);

  p('# Monday Open Analysis');
  p(`*Generated: ${new Date().toISOString()}*`);
  p();

  // ── Part A ────────────────────────────────────────────────────────────────
  p('## Part A — Stale Quotes');
  p();
  p('### Frozen Tokens (≥8 consecutive polls with identical `token_price_usd`)');
  p();
  if (staleList.length) {
    p('| crypto\\_id | symbol | issuer | asset | frozen price | first seen (UTC) | last seen (UTC) | run | mkt\\_open |');
    p('|------------|--------|--------|-------|-------------|-----------------|----------------|-----|-----------|');
    for (const s of staleList) {
      p(`| ${s.crypto_id} | ${s.token_symbol} | ${s.issuer} | ${s.asset} | $${f(s.frozen_price, 6)} | ${s.first_seen.slice(0, 16)} | ${s.last_seen.slice(0, 16)} | ${s.run_len} | ${s.market_open_count} |`);
    }
  } else {
    p('*No frozen tokens found.*');
  }
  p();

  p('### Which Columns Uniquely Identify a Token?');
  p();
  p('| Column(s) | Distinct values | Unique? |');
  p('|-----------|----------------|---------|');
  p(`| \`token_symbol\` | ${unique.distinctSymbols} | ${unique.ambigSymbols.length === 0 ? 'Yes ✓' : `No — ${unique.ambigSymbols.length} collision(s)`} |`);
  p(`| \`crypto_id\` | ${unique.distinctCryptoIds} | Yes ✓ (CMC numeric ID) |`);
  p(`| \`token_symbol\` + \`issuer\` | ${unique.distinctSymbolIssuer} | ${unique.distinctSymbolIssuer === unique.distinctCryptoIds ? 'Yes ✓' : 'No'} |`);
  p();
  if (unique.ambigSymbols.length) {
    p('Symbol collisions (same symbol, different crypto\\_id):');
    for (const a of unique.ambigSymbols) {
      p(`- \`${a.sym}\` → crypto_ids: ${a.ids.join(', ')}`);
    }
    p();
  }
  p('**Best unique key: `crypto_id`.** Symbols collide when two CMC entries share a ticker. `(token_symbol + issuer)` is a reliable human-readable fallback.');
  p();

  // ── Part B ────────────────────────────────────────────────────────────────
  p("## Part B — Did Weekend Token Prices Predict Monday's Open?");
  p();
  p('> Stale tokens (Part A) and `unit_mismatch` tokens excluded. Median over remaining tokens per asset per poll.');
  p();

  for (const asset of ['SPY', 'NVDA', 'TSLA']) {
    p(`### ${asset}`);
    p();
    p('#### 9-Timestamp Price Table');
    p();
    p('| Target (UTC) | Nearest poll (UTC) | Δ min | Median token $ | CL ref $ | Gap% |');
    p('|--------------|-------------------|-------|---------------|----------|------|');
    for (const row of tableData[asset]) {
      const med  = row.med != null ? `$${Number(row.med).toFixed(2)}` : '—';
      const ref  = row.ref != null ? `$${row.ref.toFixed(2)}` : '—';
      const gap  = row.gap != null ? `${row.gap.toFixed(3)}%` : '—';
      const poll = row.nearestPoll ? row.nearestPoll.slice(0, 16) : '—';
      p(`| **${row.label}** | ${poll} | ${row.nearestPoll ? row.diffMin.toFixed(1) : '—'} | ${med} | ${ref} | ${gap} |`);
    }
    p();

    const ms  = moveStats[asset];
    const fri = friClose[asset];
    const cl  = clBoundary[asset];

    p('#### Friday→Monday Move');
    p();
    p('| Item | Value |');
    p('|------|-------|');
    p(`| Friday-close CL (DB, last market\\_open poll) | $${ms.friCL != null ? ms.friCL.toFixed(2) : '—'} at ${fri?.ts?.slice(0, 16) ?? '—'} UTC |`);
    p(`| Monday-open CL (live Chainlink, first round ≥ 14:30) | $${ms.monCL != null ? ms.monCL.toFixed(2) : '—'} at ${cl?.firstPost?.updatedAt?.toISOString().slice(0, 19) ?? '—'} UTC |`);
    p(`| **Total Fri→Mon CL move** | **${ms.clMove != null ? ms.clMove.toFixed(3) + '%' : '—'}** |`);
    p(`| Token median at Fri 20:45 | $${ms.friMed != null ? ms.friMed.toFixed(2) : '—'} |`);
    p(`| Token median at Mon 14:15 (pre-open) | $${ms.mon1415 != null ? ms.mon1415.toFixed(2) : '—'} |`);
    p(`| Token move Fri 20:45 → Mon 14:15 | ${ms.tokMove != null ? ms.tokMove.toFixed(3) + '%' : '—'} |`);
    p(`| **% of CL move priced in by Mon 14:15** | **${ms.pctIn != null ? ms.pctIn.toFixed(1) + '%' : '—'}** |`);
    p(`| Gap at Mon 14:30 poll (token median vs stored CL) | ${ms.gap1430 != null ? ms.gap1430.toFixed(3) + '%' : '—'} |`);
    p(`| Seconds from 14:30:00 UTC until first CL post-open update | ${ms.secsToUpdate != null ? ms.secsToUpdate + 's' : '—'} |`);
    p();
  }

  p('### `ref_updated_at` Column');
  p();
  if (refSample) {
    p(`- **Stored: yes.** ${refCount.toLocaleString()} rows non-null; ${refNull.toLocaleString()} null (unit\\_mismatch tokens and QQQ, which has no Chainlink feed).`);
    p(`- Example value: \`${refSample.ref_updated_at}\` (collected\\_at: \`${refSample.collected_at.slice(0, 16)}\`)`);
  } else {
    p('- **Not found:** all `ref_updated_at` values are null in this dataset.');
  }
  p();

  return lines.join('\n') + '\n';
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
