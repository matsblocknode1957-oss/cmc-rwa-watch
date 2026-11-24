// netlify/functions/data.js — Supabase data aggregator, no npm deps, Node 22 native fetch
import { computeTokenMedian } from '../../lib/median.js';

async function fetchAll(url, headers) {
  const rows = [];
  let offset = 0;
  const sep = url.includes('?') ? '&' : '?';
  while (true) {
    const r = await fetch(`${url}${sep}limit=1000&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`Supabase ${r.status} at ${url}: ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

function buildSeriesFromRows(rows) {
  const byTime = new Map();
  for (const r of rows) {
    if (!byTime.has(r.collected_at)) byTime.set(r.collected_at, []);
    byTime.get(r.collected_at).push(r);
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([time, pollRows]) => {
      const { tokenMedian } = computeTokenMedian(pollRows);
      const refRow = pollRows.find(r => r.ref_price_usd != null);
      return { time, tokenMedian, clPrice: refRow ? Number(refRow.ref_price_usd) : null };
    });
}

const ASSETS = ['SPY', 'NVDA', 'TSLA', 'GOLD', 'QQQ'];
const enc = encodeURIComponent;

export const handler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing Supabase configuration' }),
    };
  }

  const h = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  const base = `${SUPABASE_URL}/rest/v1`;

  try {
    // Get latest timestamp first (all subsequent queries depend on it or run in parallel)
    const tsR = await fetch(`${base}/rwa_quotes?select=collected_at&order=collected_at.desc&limit=1`, { headers: h });
    if (!tsR.ok) throw new Error(`latest timestamp: HTTP ${tsR.status}`);
    const tsData = await tsR.json();
    if (!tsData.length) throw new Error('No rows found in rwa_quotes');
    const latestTime = tsData[0].collected_at;

    const since72h = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    const sCols = 'collected_at,asset,token_price_usd,price_adj_usd,excluded_reason,unit_mismatch,ref_price_usd,token_volume_24h';
    const lCols = 'asset,token_symbol,issuer,crypto_id,token_price_usd,price_adj_usd,excluded_reason,unit_mismatch,ref_price_usd,ref_updated_at,market_open,token_volume_24h';

    // Parallel: alerts, per-asset 72h series, NVDA case study, GOLD case study, weekend vol
    const [alertsData, ...assetRows] = await Promise.all([
      fetch(`${base}/rwa_alerts?select=*&order=created_at.desc&limit=50`, { headers: h }).then(r => r.json()),
      ...ASSETS.map(a =>
        fetchAll(`${base}/rwa_quotes?select=${sCols}&asset=eq.${a}&collected_at=gte.${enc(since72h)}&order=collected_at.asc`, h)
      ),
      fetchAll(
        `${base}/rwa_quotes?select=${sCols}&asset=eq.NVDA` +
        `&collected_at=gte.${enc('2026-11-20T20:00:00.000Z')}` +
        `&collected_at=lte.${enc('2026-11-23T15:30:00.000Z')}&order=collected_at.asc`,
        h
      ),
      fetchAll(
        `${base}/rwa_quotes?select=${sCols}&asset=eq.GOLD` +
        `&collected_at=gte.${enc('2026-11-20T20:00:00.000Z')}` +
        `&collected_at=lte.${enc('2026-11-23T02:00:00.000Z')}&order=collected_at.asc`,
        h
      ),
      fetchAll(
        `${base}/rwa_quotes?select=${sCols}` +
        `&collected_at=gte.${enc('2026-11-22T12:00:00.000Z')}` +
        `&collected_at=lte.${enc('2026-11-22T16:00:00.000Z')}&order=collected_at.asc`,
        h
      ),
    ]);

    const seriesByAsset = assetRows.slice(0, ASSETS.length);
    const csRows     = assetRows[ASSETS.length];
    const csGoldRows = assetRows[ASSETS.length + 1];
    const wvRows     = assetRows[ASSETS.length + 2];

    // Latest rows + meta (can run in parallel now)
    const [latestRows, firstPollR, countR] = await Promise.all([
      fetchAll(`${base}/rwa_quotes?select=${lCols}&collected_at=eq.${enc(latestTime)}`, h),
      fetch(`${base}/rwa_quotes?select=collected_at&order=collected_at.asc&limit=1`, { headers: h }).then(r => r.json()),
      fetch(`${base}/rwa_quotes?select=id`, {
        headers: { ...h, Prefer: 'count=exact', Range: '0-0', 'Range-Unit': 'items' },
      }),
    ]);

    const cr = countR.headers.get('content-range') ?? '';
    const total = cr.includes('/') ? parseInt(cr.split('/')[1], 10) : null;
    const firstPoll = firstPollR[0]?.collected_at ?? null;

    const alerts = Array.isArray(alertsData) ? alertsData : [];

    // Build latest per asset
    const latest = {};
    for (let i = 0; i < ASSETS.length; i++) {
      const asset = ASSETS[i];
      const rows = latestRows.filter(r => r.asset === asset);
      if (!rows.length) continue;
      const { tokenMedian, tokensUsed, peerSpread } = computeTokenMedian(rows);
      const refRow = rows.find(r => r.ref_price_usd != null) ?? rows[0];
      const clPrice = refRow?.ref_price_usd != null ? Number(refRow.ref_price_usd) : null;
      const refUpdatedAt = refRow?.ref_updated_at ?? null;
      const clAgeMin = refUpdatedAt
        ? Math.round((Date.now() - new Date(refUpdatedAt).getTime()) / 60000)
        : null;
      const gap = asset !== 'QQQ' && clPrice && tokenMedian != null
        ? (tokenMedian - clPrice) / clPrice * 100
        : null;
      const inclRows = rows.filter(r => r.excluded_reason == null && !r.unit_mismatch);
      const volume24h = inclRows.reduce((s, r) => s + Number(r.token_volume_24h ?? 0), 0) || null;
      const latestAlert = alerts.find(a => a.asset === asset && a.alert_type === 'divergence');
      latest[asset] = {
        market_open: rows[0].market_open,
        tokenMedian,
        clPrice,
        refUpdatedAt,
        clAgeMin,
        gap,
        tokensUsed,
        peerSpread,
        volume24h,
        alertOpen: latestAlert ? latestAlert.event === 'open' : false,
      };
    }

    // Build 72h series per asset
    const series = {};
    for (let i = 0; i < ASSETS.length; i++) {
      series[ASSETS[i]] = buildSeriesFromRows(seriesByAsset[i]);
    }

    // Build excluded from latest poll
    const excludedMap = new Map();
    for (const r of latestRows) {
      if (r.excluded_reason == null) continue;
      const key = r.crypto_id ?? r.token_symbol;
      if (!excludedMap.has(key)) {
        excludedMap.set(key, {
          crypto_id: r.crypto_id,
          symbol: r.token_symbol,
          issuer: r.issuer,
          asset: r.asset,
          excluded_reason: r.excluded_reason,
        });
      }
    }

    // Weekend volume at poll nearest Sun 2026-11-22 14:00 UTC
    const wvTarget = new Date('2026-11-22T14:00:00Z').getTime();
    const wvTimes = [...new Set(wvRows.map(r => r.collected_at))].sort();
    const wvNearest = wvTimes.length
      ? wvTimes.reduce((best, t) =>
          Math.abs(new Date(t) - wvTarget) < Math.abs(new Date(best) - wvTarget) ? t : best
        )
      : null;
    const weekendVol = {};
    for (const asset of ASSETS) {
      const ar = wvRows.filter(r => r.collected_at === wvNearest && r.asset === asset);
      const incl = ar.filter(r => r.excluded_reason == null && !r.unit_mismatch);
      weekendVol[asset] = incl.reduce((s, r) => s + Number(r.token_volume_24h ?? 0), 0) || null;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
      body: JSON.stringify({
        latest,
        series,
        alerts,
        excluded: [...excludedMap.values()],
        casestudy: buildSeriesFromRows(csRows),
        casestudy_gold: buildSeriesFromRows(csGoldRows),
        weekendVol,
        meta: { total, firstPoll, lastPoll: latestTime },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
