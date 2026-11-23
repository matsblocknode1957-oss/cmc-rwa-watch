import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPA_URL = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
if (!SUPA_URL || !SUPA_KEY) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env');

const sb = createClient(SUPA_URL, SUPA_KEY);

// ── Pagination — Supabase max 1000 rows per request ───────────────────────────
async function fetchAll() {
  const PAGE = 1000;
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await sb
      .from('rwa_quotes')
      .select('*')
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

// ── Session classification (mirrors collector logic) ──────────────────────────
function sessionOf(row) {
  if (row.weekend)      return 'weekend';
  if (row.market_open)  return 'market_open';
  return 'overnight';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function f(v, dp = 4) {
  return v == null ? '' : Number(v).toFixed(dp);
}

function escCsv(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n'))
    return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function absStats(rows, field) {
  const vals = rows
    .filter(r => r[field] != null)
    .map(r => ({ v: Number(r[field]), ts: r.collected_at }));
  if (!vals.length) return null;
  const abs   = vals.map(x => Math.abs(x.v));
  const count = abs.length;
  const avg   = abs.reduce((s, v) => s + v, 0) / count;
  const maxIdx = abs.indexOf(Math.max(...abs));
  return { count, avgAbs: avg, maxAbs: abs[maxIdx], maxTs: vals[maxIdx].ts };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Fetching all rows from rwa_quotes…');
  const allRows = await fetchAll();
  console.log(`Total rows fetched: ${allRows.length}\n`);

  if (!allRows.length) {
    console.log('No data in the database yet.');
    return;
  }

  // ── a. Dataset overview ───────────────────────────────────────────────────
  const firstTs = allRows[0].collected_at;
  const lastTs  = allRows[allRows.length - 1].collected_at;

  const pollSet   = [...new Set(allRows.map(r => r.collected_at))].sort();
  const pollCount = pollSet.length;

  // Per-timestamp metadata (market_open, weekend) — same for all tokens in a poll
  const pollMeta = {};
  for (const r of allRows) {
    if (!pollMeta[r.collected_at])
      pollMeta[r.collected_at] = { market_open: r.market_open, weekend: r.weekend };
  }
  const polls = pollSet.map(ts => ({ ts, ...pollMeta[ts] }));

  // Gaps > 30 min between consecutive polls
  const longGaps = [];
  for (let i = 1; i < polls.length; i++) {
    const mins = (new Date(polls[i].ts) - new Date(polls[i - 1].ts)) / 60_000;
    if (mins > 30) longGaps.push({ start: polls[i - 1].ts, end: polls[i].ts, mins });
  }

  // ── b. Friday-close / Monday-open transition timestamps ──────────────────
  // Friday close: last market_open=true poll before each weekend gap
  // Monday open:  first market_open=true poll after each weekend gap
  const fridayCloseTs = [];
  const mondayOpenTs  = [];

  for (let i = 0; i < polls.length; i++) {
    const p    = polls[i];
    const next = polls[i + 1];
    const prev = polls[i - 1];

    if (p.market_open && next && !next.market_open) {
      // Look ahead until next market_open block; check if gap contains a weekend
      let j = i + 1;
      while (j < polls.length && !polls[j].market_open) j++;
      if (polls.slice(i + 1, j).some(x => x.weekend)) fridayCloseTs.push(p.ts);
    }

    if (p.market_open && prev && !prev.market_open) {
      // Look back until previous market_open block; check if gap contains a weekend
      let j = i - 1;
      while (j >= 0 && !polls[j].market_open) j--;
      if (polls.slice(j + 1, i).some(x => x.weekend)) mondayOpenTs.push(p.ts);
    }
  }

  const lastFriTs  = fridayCloseTs.at(-1) ?? null;
  const firstMonTs = mondayOpenTs.at(-1)  ?? null;

  // ── c/d. Per-token + per-session stats ────────────────────────────────────
  const byToken = {};
  for (const r of allRows) (byToken[r.token_symbol] ??= []).push(r);
  const tokens = Object.keys(byToken).sort();

  const SESSIONS = ['market_open', 'overnight', 'weekend'];
  const tableRows = [];

  for (const token of tokens) {
    const trows = byToken[token];
    const asset = trows[0].asset;

    const lastFriRow  = lastFriTs  ? trows.find(r => r.collected_at === lastFriTs)  : null;
    const firstMonRow = firstMonTs ? trows.find(r => r.collected_at === firstMonTs) : null;

    for (const sess of SESSIONS) {
      const srows = trows.filter(r => sessionOf(r) === sess);
      const clSt  = absStats(srows, 'gap_pct');
      const pSt   = absStats(srows, 'gap_vs_peers_pct');

      tableRows.push({
        asset, token, sess,
        total_rows:     srows.length,
        cl_count:       clSt?.count   ?? 0,
        cl_avg_abs:     clSt?.avgAbs  ?? null,
        cl_max_abs:     clSt?.maxAbs  ?? null,
        cl_max_ts:      clSt?.maxTs   ?? null,
        cl_last_fri:    lastFriRow?.gap_pct != null         ? Number(lastFriRow.gap_pct)        : null,
        cl_first_mon:   firstMonRow?.gap_pct != null        ? Number(firstMonRow.gap_pct)       : null,
        peer_count:     pSt?.count    ?? 0,
        peer_avg_abs:   pSt?.avgAbs   ?? null,
        peer_max_abs:   pSt?.maxAbs   ?? null,
        peer_max_ts:    pSt?.maxTs    ?? null,
        peer_last_fri:  lastFriRow?.gap_vs_peers_pct != null  ? Number(lastFriRow.gap_vs_peers_pct)  : null,
        peer_first_mon: firstMonRow?.gap_vs_peers_pct != null ? Number(firstMonRow.gap_vs_peers_pct) : null,
      });
    }
  }

  // ── e. Unit mismatches ────────────────────────────────────────────────────
  // Latest row per token where unit_mismatch=true
  const mismatchMap = {};
  for (const r of allRows) {
    if (!r.unit_mismatch) continue;
    if (!mismatchMap[r.token_symbol] || r.collected_at > mismatchMap[r.token_symbol].collected_at)
      mismatchMap[r.token_symbol] = r;
  }
  const mismatches = Object.values(mismatchMap)
    .sort((a, b) => a.token_symbol.localeCompare(b.token_symbol));

  // ── f. Top 10 biggest |gap_pct| ──────────────────────────────────────────
  const top10 = allRows
    .filter(r => r.gap_pct != null)
    .sort((a, b) => Math.abs(Number(b.gap_pct)) - Math.abs(Number(a.gap_pct)))
    .slice(0, 10);

  // ── Write output ──────────────────────────────────────────────────────────
  const OUT = join(__dirname, '..', 'data-out');
  mkdirSync(OUT, { recursive: true });

  writeCsv(OUT, tableRows, mismatches, top10);
  writeMd(OUT, {
    allRows, firstTs, lastTs, pollCount, longGaps,
    tableRows, tokens, byToken, mismatches, top10,
    lastFriTs, firstMonTs,
  });

  console.log('Wrote: data-out/weekend-report.csv');
  console.log('Wrote: data-out/weekend-summary.md');
  console.log('\n── Summary ──────────────────────────────────────────────────────\n');
  const { readFileSync } = await import('fs');
  console.log(readFileSync(join(OUT, 'weekend-summary.md'), 'utf8'));
}

// ── CSV writer ────────────────────────────────────────────────────────────────
function writeCsv(outDir, tableRows, mismatches, top10) {
  const lines = [];

  // Section 1: per-token+session stats
  lines.push([
    'asset','token','session','total_rows',
    'cl_count','cl_avg_abs_pct','cl_max_abs_pct','cl_max_ts',
    'cl_last_fri_close_pct','cl_first_mon_open_pct',
    'peer_count','peer_avg_abs_pct','peer_max_abs_pct','peer_max_ts',
    'peer_last_fri_close_pct','peer_first_mon_open_pct',
  ].join(','));

  for (const r of tableRows) {
    lines.push([
      r.asset, r.token, r.sess, r.total_rows,
      r.cl_count,   f(r.cl_avg_abs),   f(r.cl_max_abs),   r.cl_max_ts ?? '',
      f(r.cl_last_fri), f(r.cl_first_mon),
      r.peer_count, f(r.peer_avg_abs), f(r.peer_max_abs), r.peer_max_ts ?? '',
      f(r.peer_last_fri), f(r.peer_first_mon),
    ].map(escCsv).join(','));
  }

  // Section 2: unit mismatches
  lines.push('', '## unit_mismatches');
  lines.push(['asset','token','issuer','cmc_price_usd','avg_tokenized_price','last_seen'].join(','));
  for (const r of mismatches) {
    lines.push([
      r.asset, r.token_symbol, r.issuer ?? '',
      f(r.token_price_usd, 6), f(r.avg_tokenized_price, 6), r.collected_at,
    ].map(escCsv).join(','));
  }
  if (!mismatches.length) lines.push('(none)');

  // Section 3: top 10 gaps
  lines.push('', '## top_10_gaps_vs_chainlink');
  lines.push(['rank','token','asset','collected_at','session','gap_pct','cmc_price_usd','ref_price_usd'].join(','));
  top10.forEach((r, i) => {
    lines.push([
      i + 1, r.token_symbol, r.asset, r.collected_at,
      sessionOf(r), f(r.gap_pct), f(r.token_price_usd), f(r.ref_price_usd),
    ].map(escCsv).join(','));
  });
  if (!top10.length) lines.push('(no gap_pct data yet)');

  writeFileSync(join(outDir, 'weekend-report.csv'), lines.join('\n') + '\n');
}

// ── Markdown writer ───────────────────────────────────────────────────────────
function writeMd(outDir, {
  allRows, firstTs, lastTs, pollCount, longGaps,
  tableRows, tokens, byToken, mismatches, top10,
  lastFriTs, firstMonTs,
}) {
  const lines = [];
  const p = (s = '') => lines.push(s);

  p('# Weekend Report');
  p(`*Generated: ${new Date().toISOString()}*`);
  p();

  // ── Overview ──
  p('## Dataset Overview');
  p('| Item | Value |');
  p('|------|-------|');
  p(`| Total rows | ${allRows.length} |`);
  p(`| First poll | ${firstTs} |`);
  p(`| Last poll | ${lastTs} |`);
  p(`| Distinct polls | ${pollCount} |`);
  p(`| Long gaps (>30 min) | ${longGaps.length} |`);

  if (longGaps.length) {
    p();
    p('### Gaps > 30 min');
    p('| Start | End | Length (min) |');
    p('|-------|-----|-------------|');
    for (const g of longGaps) {
      p(`| ${g.start} | ${g.end} | ${g.mins.toFixed(0)} |`);
    }
  }
  p();

  // ── Per-asset, per-session ──
  const assets    = [...new Set(allRows.map(r => r.asset))].sort();
  const SESSIONS  = ['market_open', 'overnight', 'weekend'];
  const sessLabel = {
    market_open: 'Market Open',
    overnight:   'Overnight (weekday closed)',
    weekend:     'Weekend',
  };

  for (const asset of assets) {
    p(`## ${asset}`);
    for (const sess of SESSIONS) {
      p(`### ${sessLabel[sess]}`);
      const sRows = tableRows.filter(r => r.asset === asset && r.sess === sess);
      if (!sRows.length) { p('*No data.*'); p(); continue; }

      p('| Token | CL n | CL avg abs% | CL max abs% | CL max at | Peer n | Peer avg abs% | Peer max abs% | Peer max at |');
      p('|-------|------|-------------|-------------|-----------|--------|---------------|---------------|-------------|');
      for (const r of sRows) {
        const clMaxAt   = r.cl_max_ts   ? r.cl_max_ts.slice(0, 16)   : '—';
        const peerMaxAt = r.peer_max_ts ? r.peer_max_ts.slice(0, 16) : '—';
        p([
          '',
          r.token,
          r.cl_count,
          r.cl_avg_abs   != null ? f(r.cl_avg_abs)   : '—',
          r.cl_max_abs   != null ? f(r.cl_max_abs)   : '—',
          clMaxAt,
          r.peer_count,
          r.peer_avg_abs != null ? f(r.peer_avg_abs) : '—',
          r.peer_max_abs != null ? f(r.peer_max_abs) : '—',
          peerMaxAt,
          '',
        ].join(' | ').trim());
      }
      p();
    }
  }

  // ── Weekend transitions ──
  p('## Weekend Transitions (most recent)');
  if (!lastFriTs && !firstMonTs) {
    p('*No weekend transitions found in the dataset yet.*');
  } else {
    p(`- Last Friday-close poll: **${lastFriTs ?? 'none found'}**`);
    p(`- First Monday-open poll: **${firstMonTs ?? 'none found'}**`);
    p();
    p('| Token | Asset | CL gap% at Fri close | CL gap% at Mon open | Peer gap% at Fri close | Peer gap% at Mon open |');
    p('|-------|-------|----------------------|---------------------|------------------------|----------------------|');
    for (const token of tokens) {
      const trows = byToken[token];
      const asset = trows[0].asset;
      const fri   = lastFriTs  ? trows.find(r => r.collected_at === lastFriTs)  : null;
      const mon   = firstMonTs ? trows.find(r => r.collected_at === firstMonTs) : null;
      const clFri  = fri?.gap_pct              != null ? f(fri.gap_pct, 3) + '%'              : '—';
      const clMon  = mon?.gap_pct              != null ? f(mon.gap_pct, 3) + '%'              : '—';
      const pFri   = fri?.gap_vs_peers_pct     != null ? f(fri.gap_vs_peers_pct, 3) + '%'     : '—';
      const pMon   = mon?.gap_vs_peers_pct     != null ? f(mon.gap_vs_peers_pct, 3) + '%'     : '—';
      if ([clFri, clMon, pFri, pMon].every(v => v === '—')) continue;
      p(`| ${token} | ${asset} | ${clFri} | ${clMon} | ${pFri} | ${pMon} |`);
    }
  }
  p();

  // ── Unit mismatches ──
  p('## Unit Mismatches');
  if (mismatches.length) {
    p('*(token price appears to be in a different unit vs the asset average — likely per-gram gold)*');
    p();
    p('| Token | Asset | Issuer | CMC Price (USD) | Avg Tokenized (USD) | Last Seen |');
    p('|-------|-------|--------|-----------------|---------------------|-----------|');
    for (const r of mismatches) {
      p(`| ${r.token_symbol} | ${r.asset} | ${r.issuer ?? '—'} | $${f(r.token_price_usd, 2)} | $${f(r.avg_tokenized_price, 2)} | ${r.collected_at.slice(0, 16)} |`);
    }
  } else {
    p('*No unit mismatches found.*');
  }
  p();

  // ── Top 10 gaps ──
  p('## Top 10 Biggest Absolute Gap % (vs Chainlink)');
  if (top10.length) {
    p('| # | Token | Asset | Time (UTC) | Session | Gap % | CMC Price | CL Price |');
    p('|---|-------|-------|------------|---------|-------|-----------|----------|');
    top10.forEach((r, i) => {
      p(`| ${i + 1} | ${r.token_symbol} | ${r.asset} | ${r.collected_at.slice(0, 16)} | ${sessionOf(r)} | ${f(r.gap_pct, 3)}% | $${f(r.token_price_usd, 2)} | $${f(r.ref_price_usd, 2)} |`);
    });
  } else {
    p('*No gap\\_pct data found — Chainlink feeds may not have been read yet.*');
  }
  p();

  writeFileSync(join(outDir, 'weekend-summary.md'), lines.join('\n') + '\n');
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
