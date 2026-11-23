// alerts.js — divergence and stale alert logic.
// Used by collector.js (live) and scripts/backtest-alerts.js (replay).

export const TROY_OZ_PER_GRAM = 31.1035;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Compute gap from a set of rows for one asset.
// Requires at least 3 rows with excluded_reason null and unit_mismatch false.
// Returns { tokenMedian, gap, tokensUsed } or null.
function computeGapFromRows(rows, clPrice) {
  if (!clPrice || clPrice === 0) return null;
  const prices = rows
    .filter(r => r.excluded_reason == null && !r.unit_mismatch)
    .map(r => Number(r.price_adj_usd ?? r.token_price_usd))
    .filter(v => Number.isFinite(v));
  if (prices.length < 3) return null;
  const med = median(prices);
  return { tokenMedian: med, gap: (med - clPrice) / clPrice * 100, tokensUsed: prices.length };
}

// Rehydrate rows that are missing excluded_reason or price_adj_usd (old rows pre-migration).
// staleIds: Set<number> of crypto_ids whose last 8 prices were identical.
export function rehydrateRows(rows, staleIds) {
  return rows.map(row => {
    const needsExcluded = row.excluded_reason == null;
    const needsAdj      = row.price_adj_usd == null;
    if (!needsExcluded && !needsAdj) return row;

    let excludedReason = row.excluded_reason;
    let unitMismatch   = row.unit_mismatch ?? false;
    let priceAdjUsd    = row.price_adj_usd != null
      ? Number(row.price_adj_usd)
      : Number(row.token_price_usd);

    if (needsExcluded) {
      if (row.issuer === 'Hyperliquid Assets') {
        excludedReason = 'hyperliquid_perp';
      } else if (row.crypto_id != null && staleIds.has(Number(row.crypto_id))) {
        excludedReason = 'stale';
      }
    }

    if (needsAdj) {
      if (row.asset === 'GOLD' && unitMismatch && row.ref_price_usd != null) {
        const adjusted = Number(row.token_price_usd) * TROY_OZ_PER_GRAM;
        const refPrice = Number(row.ref_price_usd);
        if (refPrice > 0 && Math.abs(adjusted - refPrice) / refPrice <= 0.03) {
          priceAdjUsd  = adjusted;
          unitMismatch = false;
        }
      }
    }

    return { ...row, excluded_reason: excludedReason, price_adj_usd: priceAdjUsd, unit_mismatch: unitMismatch };
  });
}

// Compute stale crypto_ids from historical rows before a given timestamp.
// Mirrors the live fetchStalePrices logic: 8 consecutive identical prices = stale.
export function computeStaleIds(allRows, beforeTimestamp) {
  const byId = new Map();
  for (const row of allRows) {
    if (row.crypto_id == null || row.collected_at >= beforeTimestamp) continue;
    const id = Number(row.crypto_id);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(row);
  }
  const staleIds = new Set();
  for (const [id, rows] of byId) {
    const sorted = rows
      .sort((a, b) => (b.collected_at > a.collected_at ? 1 : -1))
      .slice(0, 8);
    if (sorted.length === 8) {
      const p0 = Number(sorted[0].token_price_usd);
      if (sorted.every(r => Number(r.token_price_usd) === p0)) staleIds.add(id);
    }
  }
  return staleIds;
}

// Core alert computation — pure, no DB calls.
//
// openAlerts: Map<string, boolean>  key='ASSET:divergence' or 'stale:CRYPTOID'
//   true = alert currently open, false/absent = closed.
//   Mutated in place to reflect state after this poll.
//
// Returns array of alert event objects ready for rwa_alerts insertion.
export function computeAlerts({ currentRows, prevRows, clData, openAlerts, marketOpenMap }) {
  const events = [];

  // ── Divergence alerts ───────────────────────────────────────────────────────
  for (const [asset, cl] of Object.entries(clData)) {
    const currAssetRows = currentRows.filter(r => r.asset === asset);
    const prevAssetRows = (prevRows ?? []).filter(r => r.asset === asset);

    const isMarketOpen = marketOpenMap[asset] ?? false;
    const marketState  = isMarketOpen ? 'open' : 'closed';
    const openThresh   = isMarketOpen ? 2 : 3;
    const closeThresh  = isMarketOpen ? 1 : 1.5;

    const curr = computeGapFromRows(currAssetRows, cl.price);
    if (!curr) continue;

    const alertKey    = `${asset}:divergence`;
    const isAlertOpen = openAlerts.get(alertKey) === true;

    if (!isAlertOpen) {
      if (Math.abs(curr.gap) >= openThresh) {
        // Confirm same condition held in previous poll (two-polls-in-a-row rule)
        const prevRefRow = prevAssetRows.find(r => r.ref_price_usd != null);
        const prevPrice  = prevRefRow ? Number(prevRefRow.ref_price_usd) : cl.price;
        const prev       = computeGapFromRows(prevAssetRows, prevPrice);
        if (prev && Math.abs(prev.gap) >= openThresh) {
          events.push({
            asset, alert_type: 'divergence', event: 'open', market_state: marketState,
            token_median: curr.tokenMedian, chainlink_price: cl.price,
            chainlink_updated_at: cl.updatedAt ?? null,
            gap_pct: curr.gap, tokens_used: curr.tokensUsed, crypto_id: null, note: null,
          });
          openAlerts.set(alertKey, true);
        }
      }
    } else {
      if (Math.abs(curr.gap) < closeThresh) {
        events.push({
          asset, alert_type: 'divergence', event: 'close', market_state: marketState,
          token_median: curr.tokenMedian, chainlink_price: cl.price,
          chainlink_updated_at: cl.updatedAt ?? null,
          gap_pct: curr.gap, tokens_used: curr.tokensUsed, crypto_id: null, note: null,
        });
        openAlerts.set(alertKey, false);
      }
    }
  }

  // ── Stale alerts ────────────────────────────────────────────────────────────
  const staleNow = new Map(); // crypto_id (number) → row
  for (const row of currentRows) {
    if (row.excluded_reason === 'stale' && row.crypto_id != null) {
      const id = Number(row.crypto_id);
      if (!staleNow.has(id)) staleNow.set(id, row);
    }
  }

  // Open for newly stale tokens
  for (const [cryptoId, row] of staleNow) {
    const alertKey = `stale:${cryptoId}`;
    if (openAlerts.get(alertKey) !== true) {
      events.push({
        asset: row.asset, alert_type: 'stale', event: 'open', market_state: null,
        token_median: null, chainlink_price: null, chainlink_updated_at: null,
        gap_pct: null, tokens_used: null, crypto_id: cryptoId,
        note: `${row.token_symbol ?? row.asset} price stale`,
      });
      openAlerts.set(alertKey, true);
    }
  }

  // Close for tokens no longer stale (must still appear in current poll)
  for (const [key, isOpen] of openAlerts) {
    if (!key.startsWith('stale:') || !isOpen) continue;
    const cryptoId = Number(key.split(':')[1]);
    if (staleNow.has(cryptoId)) continue;
    const row = currentRows.find(r => Number(r.crypto_id) === cryptoId);
    if (!row) continue; // not in this poll — leave open
    events.push({
      asset: row.asset, alert_type: 'stale', event: 'close', market_state: null,
      token_median: null, chainlink_price: null, chainlink_updated_at: null,
      gap_pct: null, tokens_used: null, crypto_id: cryptoId,
      note: `${row.token_symbol ?? row.asset} price no longer stale`,
    });
    openAlerts.set(key, false);
  }

  return events;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

// Returns Map<string, boolean> of currently-open alerts from rwa_alerts.
// Returns empty Map if the table doesn't exist yet.
export async function loadOpenAlerts(supabase) {
  const openAlerts = new Map();
  if (!supabase) return openAlerts;
  try {
    const { data, error } = await supabase
      .from('rwa_alerts')
      .select('asset, alert_type, event, crypto_id, created_at')
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('rwa_alerts') || msg.includes('does not exist') || msg.includes('relation')) {
        console.warn('  rwa_alerts table not found — treating all alerts as closed');
      } else {
        console.warn(`  loadOpenAlerts: ${msg}`);
      }
      return openAlerts;
    }
    const seen = new Set();
    for (const row of (data ?? [])) {
      const key = row.crypto_id != null
        ? `stale:${Number(row.crypto_id)}`
        : `${row.asset}:${row.alert_type}`;
      if (!seen.has(key)) {
        seen.add(key);
        openAlerts.set(key, row.event === 'open');
      }
    }
  } catch (e) {
    console.warn(`  loadOpenAlerts error: ${e.message}`);
  }
  return openAlerts;
}

// Returns rows from the most recent complete poll before currentCollectedAt.
export async function loadPrevPollRows(supabase, currentCollectedAt) {
  if (!supabase) return [];
  try {
    const { data: ts, error: te } = await supabase
      .from('rwa_quotes')
      .select('collected_at')
      .lt('collected_at', currentCollectedAt)
      .order('collected_at', { ascending: false })
      .limit(1);
    if (te || !ts?.length) return [];
    const prevTime = ts[0].collected_at;
    const { data, error } = await supabase
      .from('rwa_quotes')
      .select('asset, excluded_reason, unit_mismatch, price_adj_usd, token_price_usd, ref_price_usd, ref_updated_at, crypto_id, issuer, token_symbol, market_open, chainlink_desc')
      .eq('collected_at', prevTime);
    if (error) { console.warn(`  loadPrevPollRows: ${error.message}`); return []; }
    return data ?? [];
  } catch (e) {
    console.warn(`  loadPrevPollRows error: ${e.message}`);
    return [];
  }
}

// Insert alert events into rwa_alerts, or print them if dryRun.
// Silently skips with a warning if the table doesn't exist yet.
export async function insertAlerts(supabase, events, dryRun) {
  if (!events.length) return;
  if (dryRun || !supabase) {
    console.log(`\n[DRY RUN] Would raise ${events.length} alert(s):`);
    for (const e of events) {
      const gapStr = e.gap_pct != null ? ` gap=${e.gap_pct.toFixed(2)}%` : '';
      console.log(`  [${e.event.toUpperCase()}] ${e.asset} ${e.alert_type}${gapStr} market=${e.market_state ?? 'n/a'}`);
    }
    return;
  }
  try {
    const { error } = await supabase.from('rwa_alerts').insert(events);
    if (error) {
      const msg = error.message ?? '';
      if (msg.includes('rwa_alerts') || msg.includes('does not exist') || msg.includes('relation')) {
        console.warn(`\nWarning: rwa_alerts table not found — run sql/003_rwa_alerts.sql. ${events.length} alert(s) skipped.`);
      } else {
        console.warn(`\nWarning: rwa_alerts insert error: ${msg}`);
      }
      return;
    }
    console.log(`\nRaised ${events.length} alert(s):`);
    for (const e of events) {
      const gapStr = e.gap_pct != null ? ` gap=${e.gap_pct.toFixed(2)}%` : '';
      console.log(`  [${e.event.toUpperCase()}] ${e.asset} ${e.alert_type}${gapStr} market=${e.market_state ?? 'n/a'}`);
    }
  } catch (e) {
    console.warn(`\nWarning: alert insert error: ${e.message}`);
  }
}

// Orchestrates alert processing for one poll.
// Called by collector.js after rows are built (before or after DB insert, doesn't matter —
// loadPrevPollRows queries collected_at < currentCollectedAt so won't see current rows).
export async function processAlerts({ rows, clData, supabase, dryRun, collectedAt }) {
  // Build per-asset market-open map from the rows' market_open field
  const marketOpenMap = {};
  for (const asset of Object.keys(clData)) {
    const r = rows.find(row => row.asset === asset);
    marketOpenMap[asset] = r?.market_open ?? false;
  }

  const openAlerts = await loadOpenAlerts(supabase);
  const prevRows   = await loadPrevPollRows(supabase, collectedAt);

  const events = computeAlerts({ currentRows: rows, prevRows, clData, openAlerts, marketOpenMap });

  if (!events.length) {
    console.log('\nAlerts: none to raise or close.');
    return;
  }
  await insertAlerts(supabase, events, dryRun);
}
