import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Date parameter ────────────────────────────────────────────────────────────
// Usage: node scripts/monday-open.js [YYYY-MM-DD]
// YYYY-MM-DD = the Friday of the weekend to analyse.  Default: 2026-11-20
const FRI_DATE = process.argv[2] ?? '2026-11-20';
if (!/^\d{4}-\d{2}-\d{2}$/.test(FRI_DATE)) {
  console.error('Usage: node scripts/monday-open.js [YYYY-MM-DD]  (Friday date, e.g. 2026-11-20)');
  process.exit(1);
}

const friMs    = new Date(FRI_DATE + 'T00:00:00Z').getTime();
const monMs    = friMs + 3 * 86_400_000;
const MON_DATE = new Date(monMs).toISOString().slice(0, 10);

// NYSE schedule anchors (all UTC)
const FRI_CLOSE_MS = friMs + 21 * 3_600_000;                    // Fri 21:00:00 — NYSE close
const MON_OPEN_MS  = monMs + (14 * 60 + 30) * 60_000 + 30_000; // Mon 14:30:30 — open + 30 s buffer
const MON_1415_MS  = monMs + (14 * 60 + 15) * 60_000;          // Mon 14:15:00 — pre-open snapshot
const FRI_2045_MS  = friMs + (20 * 60 + 45) * 60_000;          // Fri 20:45:00 — token baseline
const MON_11_MS    = monMs + 11 * 3_600_000;                    // Mon 11:00:00 — 15-min resolution starts
const MON_15_MS    = monMs + 15 * 3_600_000;                    // Mon 15:00:00 — timeline end

const isoTs = ms => new Date(ms).toISOString();

// ── Environment ───────────────────────────────────────────────────────────────
const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPA_URL || !SUPA_KEY) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');
const ARB_RPC = process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc';

const sb = createClient(SUPA_URL, SUPA_KEY);

// ── Chainlink ─────────────────────────────────────────────────────────────────
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

// Walk back from latest to find:
//   friClose : last round with updatedAt ≤ FRI_CLOSE_MS  (Fri 21:00:00 UTC)
//   monOpen  : first round with updatedAt ≥ MON_OPEN_MS  (Mon 14:30:30 UTC)
async function findBoundaries(sym, provider) {
  const contract = new ethers.Contract(CL_FEEDS[sym], AGG_ABI, provider);
  const [dec, latest] = await Promise.all([contract.decimals(), contract.latestRoundData()]);
  const decNum = Number(dec);

  let monOpen  = null;  // kept as earliest round >= MON_OPEN_MS
  let friClose = null;  // first round found going back that is <= FRI_CLOSE_MS

  process.stdout.write(`  Walking ${sym}`);
  for (let i = 0n; i < 400n; i++) {
    const rid = latest.roundId - i;
    if (rid <= 0n) break;
    let r;
    try { r = await contract.getRoundData(rid); } catch { process.stdout.write('!'); break; }
    const ts = Number(r.updatedAt) * 1000;
    if (ts === 0) continue;
    const price = Number(r.answer) / 10 ** decNum;
    const entry = { price, updatedAt: isoTs(ts), ts };

    if (ts >= MON_OPEN_MS) {
      monOpen = entry;    // keep overwriting → ends as earliest round >= MON_OPEN_MS
    } else if (ts <= FRI_CLOSE_MS) {
      friClose = entry;   // first round walking back that is <= Fri 21:00:00; stop
      break;
    }
    // between FRI_CLOSE_MS and MON_OPEN_MS: skip (weekend + pre-market)
    if (i % 30n === 29n) process.stdout.write('.');
  }
  process.stdout.write(' done\n');
  return { monOpen, friClose };
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function fetchWindow(start, end) {
  const PAGE = 1000;
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('rwa_quotes')
      .select('collected_at,asset,token_symbol,crypto_id,token_price_usd,ref_price_usd,ref_updated_at,unit_mismatch')
      .gte('collected_at', start)
      .lte('collected_at', end)
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

// Stale Hyperliquid perpetuals (crypto_ids identified in earlier analysis)
const EXCL_IDS = new Set([39618, 39621, 39623]);

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function nearestPoll(rows, targetMs) {
  const polls = [...new Set(rows.map(r => r.collected_at))].sort();
  let best = null, bestDiff = Infinity;
  for (const ts of polls) {
    const diff = Math.abs(new Date(ts).getTime() - targetMs);
    if (diff < bestDiff) { bestDiff = diff; best = ts; }
    else if (diff > bestDiff) break;
  }
  return { ts: best, diffMin: bestDiff / 60_000 };
}

function snap(rows, pollTs, asset) {
  if (!pollTs) return null;
  const subset = rows.filter(r =>
    r.collected_at === pollTs &&
    r.asset === asset &&
    !r.unit_mismatch &&
    !EXCL_IDS.has(r.crypto_id)
  );
  const med    = median(subset.map(r => Number(r.token_price_usd)));
  const refRow = subset.find(r => r.ref_price_usd != null);
  return {
    med,
    ref:    refRow ? Number(refRow.ref_price_usd) : null,
    refAt:  refRow?.ref_updated_at ?? null,
    tokens: subset.map(r => r.token_symbol),
    count:  subset.length,
  };
}

function f(v, dp = 2) { return v == null ? '—' : Number(v).toFixed(dp); }
function pct(v, dp = 3) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(dp) + '%'; }

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Friday : ${FRI_DATE}  |  Monday: ${MON_DATE}`);
  console.log(`Fri close anchor : last CL round ≤ ${isoTs(FRI_CLOSE_MS)} (Fri 21:00 UTC)`);
  console.log(`Mon open anchor  : first CL round ≥ ${isoTs(MON_OPEN_MS)} (Mon 14:30:30 UTC, +30 s buffer)`);
  console.log();

  // 1. Walk Chainlink for all three assets
  console.log('Walking Chainlink round history…');
  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  const bounds   = {};
  for (const sym of ['SPY', 'NVDA', 'TSLA']) {
    bounds[sym] = await findBoundaries(sym, provider);
  }
  console.log();

  // 2. Single Supabase fetch: Fri 20:30 → Mon 15:15 UTC (covers all analysis windows)
  console.log('Fetching Supabase rows…');
  const allWin = await fetchWindow(
    isoTs(FRI_2045_MS - 15 * 60_000),  // Fri 20:30 UTC
    isoTs(MON_15_MS   + 15 * 60_000)   // Mon 15:15 UTC
  );
  console.log(`  ${allWin.length} rows in window\n`);

  // 3. Nearest polls for Mon 14:15 and Fri 20:45
  const { ts: poll1415, diffMin: diff1415 } = nearestPoll(allWin, MON_1415_MS);
  const { ts: pollFri,  diffMin: diffFri  } = nearestPoll(allWin, FRI_2045_MS);

  // 4. Per-asset results for SPY / NVDA / TSLA
  const ASSETS = ['SPY', 'NVDA', 'TSLA'];
  const results = {};
  for (const sym of ASSETS) {
    const { friClose, monOpen } = bounds[sym];
    const friCL  = friClose?.price ?? null;
    const monCL  = monOpen?.price  ?? null;
    const clMove = friCL && monCL ? (monCL - friCL) / friCL * 100 : null;

    const s1415 = snap(allWin, poll1415, sym);
    const sFri  = snap(allWin, pollFri,  sym);

    const tokMove = sFri?.med && s1415?.med
      ? (s1415.med - sFri.med) / sFri.med * 100 : null;
    const pctIn   = clMove && tokMove != null ? tokMove / clMove * 100 : null;
    const gap1415 = s1415?.med && s1415?.ref
      ? (s1415.med - s1415.ref) / s1415.ref * 100 : null;

    results[sym] = { friClose, monOpen, friCL, monCL, clMove, s1415, sFri, tokMove, pctIn, gap1415 };
  }

  // 5. NVDA timeline
  //    Hourly from Fri 21:00 to Mon 11:00, then every 15 min Mon 11:00 → Mon 15:00
  const timelineMs = [];
  for (let t = FRI_CLOSE_MS; t <= MON_15_MS; ) {
    timelineMs.push(t);
    t += (t >= MON_11_MS && t < MON_15_MS) ? 15 * 60_000 : 60 * 60_000;
  }

  const nvdaFriMed  = results['NVDA'].sFri?.med ?? null;
  const threshold3  = nvdaFriMed ? nvdaFriMed * 1.03 : null;

  const nvdaTimeline = timelineMs.map(tMs => {
    const { ts, diffMin } = nearestPoll(allWin, tMs);
    const s   = snap(allWin, ts, 'NVDA');
    const gap = s?.med && s?.ref ? (s.med - s.ref) / s.ref * 100 : null;
    return {
      targetTs: isoTs(tMs).slice(0, 16),
      pollTs:   ts ? ts.slice(0, 19) : '—',
      diffMin:  ts ? diffMin : null,
      med:      s?.med  ?? null,
      ref:      s?.ref  ?? null,
      refAt:    s?.refAt ?? null,
      gap,
    };
  });

  const first3pct = threshold3
    ? (nvdaTimeline.find(r => r.med != null && r.med > threshold3) ?? null)
    : null;

  // 6. Write outputs
  const md = buildMd(results, poll1415, diff1415, pollFri, diffFri, nvdaTimeline, nvdaFriMed, first3pct);
  const OUT = join(__dirname, '..', 'data-out');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'monday-open.md'), md);
  writeCsv(OUT, nvdaTimeline);

  console.log('Wrote: data-out/monday-open.md');
  console.log('Wrote: data-out/nvda-timeline.csv\n');
  console.log(md);
}

// ── CSV writer ────────────────────────────────────────────────────────────────
function writeCsv(outDir, timeline) {
  const rows = ['target_utc,nearest_poll_utc,delta_min,nvda_token_median,cl_ref_usd,ref_updated_at,gap_pct'];
  for (const r of timeline) {
    rows.push([
      r.targetTs,
      r.pollTs,
      r.diffMin != null ? r.diffMin.toFixed(1) : '',
      r.med     != null ? r.med.toFixed(4) : '',
      r.ref     != null ? r.ref.toFixed(4) : '',
      r.refAt   ?? '',
      r.gap     != null ? r.gap.toFixed(4) : '',
    ].join(','));
  }
  writeFileSync(join(outDir, 'nvda-timeline.csv'), rows.join('\n') + '\n');
}

// ── Markdown builder ──────────────────────────────────────────────────────────
function buildMd(results, poll1415, diff1415, pollFri, diffFri, nvdaTimeline, nvdaFriMed, first3pct) {
  const lines = [];
  const p = (s = '') => lines.push(s);

  p('# Monday Open Analysis');
  p(`*Generated: ${new Date().toISOString()}*`);
  p(`*Friday: ${FRI_DATE}  |  Monday: ${MON_DATE}*`);
  p();
  p('## Methodology');
  p();
  p(`- **Friday close**: last Chainlink round with \`updatedAt ≤ ${isoTs(FRI_CLOSE_MS)}\` (Fri 21:00 UTC, via \`getRoundData\`)`);
  p(`- **Monday open**: first Chainlink round with \`updatedAt ≥ ${isoTs(MON_OPEN_MS)}\` (Mon 14:30:30 UTC, +30 s buffer, via \`getRoundData\`)`);
  p(`- **Mon 14:15 DB poll**: nearest poll to ${isoTs(MON_1415_MS).slice(0, 16)} UTC — found \`${poll1415 ?? '—'}\` (Δ ${diff1415?.toFixed(1) ?? '—'} min)`);
  p(`- **Fri 20:45 DB poll**: nearest poll to ${isoTs(FRI_2045_MS).slice(0, 16)} UTC — found \`${pollFri ?? '—'}\` (Δ ${diffFri?.toFixed(1) ?? '—'} min)`);
  p(`- **Token median excludes**: crypto_ids 39618, 39621, 39623 (Hyperliquid Assets perpetuals) and all \`unit_mismatch\` rows`);
  p();

  // ── Per-asset summary ─────────────────────────────────────────────────────
  for (const sym of ['SPY', 'NVDA', 'TSLA']) {
    const r = results[sym];
    p(`## ${sym}`);
    p();
    p('| | Round / poll time (UTC) | Price |');
    p('|-|------------------------|-------|');
    p(`| **Fri close CL** (last round ≤ 21:00:00) | ${r.friClose?.updatedAt?.slice(0, 19) ?? '—'} | \$${f(r.friCL, 4)} |`);
    p(`| **Mon open CL** (first round ≥ 14:30:30) | ${r.monOpen?.updatedAt?.slice(0, 19) ?? '—'}  | \$${f(r.monCL, 4)} |`);
    p(`| **Total Fri→Mon CL move** | | **${pct(r.clMove)}** |`);
    p();
    p(`*Mon 14:15 DB poll: \`${poll1415?.slice(0, 19) ?? '—'}\` (Δ ${diff1415?.toFixed(1) ?? '—'} min) — ${r.s1415?.count ?? 0} tokens: ${r.s1415?.tokens?.join(', ') || '—'}*`);
    p();
    p('| Item | Value |');
    p('|------|-------|');
    p(`| Token median at Fri 20:45 (DB) | \$${f(r.sFri?.med, 4)} |`);
    p(`| Token median at Mon 14:15 (DB) | \$${f(r.s1415?.med, 4)} |`);
    p(`| Stored CL ref at Mon 14:15 | \$${f(r.s1415?.ref, 4)} *(updated ${r.s1415?.refAt?.slice(0, 19) ?? '—'})* |`);
    p(`| Token move Fri 20:45 → Mon 14:15 | ${pct(r.tokMove)} |`);
    p(`| **% of total CL move priced in by Mon 14:15** | **${r.pctIn != null ? r.pctIn.toFixed(1) + '%' : '—'}** |`);
    p(`| Gap: token median vs stored CL at Mon 14:15 | ${pct(r.gap1415)} |`);
    p();
  }

  // ── NVDA timeline ─────────────────────────────────────────────────────────
  p('## NVDA Timeline: Fri 21:00 → Mon 15:00 UTC');
  p();
  p(`*Fri close token baseline (Fri 20:45 DB poll): \$${nvdaFriMed != null ? nvdaFriMed.toFixed(4) : '—'}*`);
  p(`*+3% threshold: \$${nvdaFriMed != null ? (nvdaFriMed * 1.03).toFixed(4) : '—'}  — rows in **bold** have crossed it*`);
  p();
  p('| Target (UTC) | Nearest poll (UTC) | Δ min | NVDA median $ | CL ref $ | ref\\_updated\\_at | Gap% |');
  p('|-------------|-------------------|-------|--------------|----------|-----------------|------|');

  for (const row of nvdaTimeline) {
    const med   = row.med  != null ? `\$${row.med.toFixed(2)}`  : '—';
    const ref   = row.ref  != null ? `\$${row.ref.toFixed(2)}`  : '—';
    const refAt = row.refAt ? row.refAt.slice(0, 19) : '—';
    const gap   = pct(row.gap);
    const delta = row.diffMin != null ? row.diffMin.toFixed(1) : '—';
    const bold  = nvdaFriMed && row.med != null && row.med > nvdaFriMed * 1.03;
    const b     = bold ? '**' : '';
    p(`| ${b}${row.targetTs}${b} | ${row.pollTs} | ${delta} | ${b}${med}${b} | ${ref} | ${refAt} | ${gap} |`);
  }
  p();

  if (first3pct && nvdaFriMed) {
    const abovePct = ((first3pct.med - nvdaFriMed) / nvdaFriMed * 100).toFixed(2);
    p('### When did NVDA tokens first cross +3% above Friday\'s close?');
    p();
    p(`At the **${first3pct.targetTs} UTC** snapshot the token median reached ` +
      `**\$${f(first3pct.med, 2)}** (+${abovePct}% above the Friday baseline of \$${nvdaFriMed.toFixed(2)}).`);
    p();
    p(`At that moment Chainlink was showing **\$${f(first3pct.ref, 2)}** ` +
      `(last updated: \`${first3pct.refAt?.slice(0, 19) ?? '—'}\`), ` +
      `a gap of **${pct(first3pct.gap)}** between the token median and the stored CL reference. ` +
      `Tokens were pricing in a move that the CL feed had not yet confirmed.`);
  } else {
    p('*Token median never exceeded +3% above Friday\'s close within the timeline window.*');
  }
  p();

  return lines.join('\n') + '\n';
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
