// scripts/backtest-alerts.js
// Replays all rwa_quotes rows through the alert logic in-memory (no DB writes).
// Saves output to data-out/backtest-alerts.md
// Pass --json to also write dashboard/backtest-alerts.json

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { computeAlerts, computeStaleIds, rehydrateRows } from '../alerts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_WITH_CL = ['SPY', 'NVDA', 'TSLA', 'GOLD'];
const writeJson = process.argv.includes('--json');

function fmtAge(pollTime, updatedAt) {
  if (!updatedAt || !pollTime) return '—';
  const ms   = new Date(pollTime) - new Date(updatedAt);
  if (ms < 0) return '—';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

async function main() {
  const SUPA_URL = process.env.SUPABASE_URL;
  const SUPA_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPA_URL || !SUPA_KEY) {
    console.error('SUPABASE_URL and SUPABASE_ANON_KEY are required');
    process.exit(1);
  }

  const supabase = createClient(SUPA_URL, SUPA_KEY);

  // Load all rows with pagination (Supabase limit is 1000 per request)
  console.log('Loading rwa_quotes...');
  let all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('rwa_quotes')
      .select('*')
      .order('collected_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) { console.error('Query error:', error.message); process.exit(1); }
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Loaded ${all.length} rows.`);

  // Group by collected_at
  const byPoll = new Map();
  for (const row of all) {
    if (!byPoll.has(row.collected_at)) byPoll.set(row.collected_at, []);
    byPoll.get(row.collected_at).push(row);
  }
  const pollTimes = [...byPoll.keys()].sort();
  console.log(`Found ${pollTimes.length} distinct polls.\n`);

  if (!pollTimes.length) { console.log('No data to replay.'); return; }

  const lines = [];
  const emit  = (s) => { console.log(s); lines.push(s); };
  const jsonEvents = [];

  emit(`# Backtest: Alert Replay`);
  emit(`\nReplayed **${pollTimes.length}** polls — ${pollTimes[0]} → ${pollTimes.at(-1)}`);
  emit(``);
  emit(`| Time (UTC) | Asset | Type | Event | Market | Gap % | Median | CL Price | CL Age |`);
  emit(`|---|---|---|---|---|---|---|---|---|`);

  const openAlerts = new Map();
  let totalEvents  = 0;
  let prevPollRows = [];

  for (const pollTime of pollTimes) {
    const rawRows = byPoll.get(pollTime);

    // Replicate live stale detection: 8 identical prices in rows BEFORE this poll
    const staleIds = computeStaleIds(all, pollTime);

    // Fill in price_adj_usd / excluded_reason for rows that pre-date migration 002
    const rows = rehydrateRows(rawRows, staleIds);

    // Build clData from the stored ref_price_usd for this poll
    const clData = {};
    for (const asset of ASSETS_WITH_CL) {
      const refRow = rows.find(r => r.asset === asset && r.ref_price_usd != null);
      if (refRow) {
        clData[asset] = {
          price:       Number(refRow.ref_price_usd),
          updatedAt:   refRow.ref_updated_at ?? null,
          description: refRow.chainlink_desc ?? null,
        };
      }
    }

    // Build market-open map from rows' market_open field
    const marketOpenMap = {};
    for (const asset of ASSETS_WITH_CL) {
      const r = rows.find(row => row.asset === asset);
      marketOpenMap[asset] = r?.market_open ?? false;
    }

    if (!Object.keys(clData).length) {
      prevPollRows = rows;
      continue;
    }

    const events = computeAlerts({
      currentRows: rows,
      prevRows: prevPollRows,
      clData,
      openAlerts,
      marketOpenMap,
    });

    for (const e of events) {
      totalEvents++;
      const gapStr = e.gap_pct     != null ? e.gap_pct.toFixed(2) + '%'    : '—';
      const medStr = e.token_median != null ? '$' + e.token_median.toFixed(2) : '—';
      const clStr  = e.chainlink_price != null ? '$' + e.chainlink_price.toFixed(2) : '—';
      const ageStr = fmtAge(pollTime, e.chainlink_updated_at);
      emit(`| ${pollTime} | ${e.asset} | ${e.alert_type} | **${e.event}** | ${e.market_state ?? '—'} | ${gapStr} | ${medStr} | ${clStr} | ${ageStr} |`);
      if (writeJson) {
        const ageMs = e.chainlink_updated_at ? new Date(pollTime) - new Date(e.chainlink_updated_at) : null;
        jsonEvents.push({
          time:              pollTime,
          asset:             e.asset,
          alert_type:        e.alert_type,
          event:             e.event,
          market_state:      e.market_state ?? null,
          gap_pct:           e.gap_pct != null ? Math.round(e.gap_pct * 10000) / 10000 : null,
          token_median:      e.token_median != null ? Math.round(e.token_median * 100) / 100 : null,
          chainlink_price:   e.chainlink_price != null ? Math.round(e.chainlink_price * 100) / 100 : null,
          chainlink_age_min: ageMs != null ? Math.round(ageMs / 60000) : null,
        });
      }
    }

    prevPollRows = rows;
  }

  emit(``);
  emit(`**Total alerts fired: ${totalEvents}**`);

  const outPath = join(__dirname, '..', 'data-out', 'backtest-alerts.md');
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
  console.log(`\nSaved to ${outPath}`);

  if (writeJson) {
    const jsonPath = join(__dirname, '..', 'dashboard', 'backtest-alerts.json');
    writeFileSync(jsonPath, JSON.stringify(jsonEvents, null, 2) + '\n', 'utf8');
    console.log(`Saved JSON to ${jsonPath} (${jsonEvents.length} events)`);
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
