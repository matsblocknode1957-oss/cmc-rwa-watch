// netlify/functions/check.js — oracle health check endpoint, no npm deps
import { computeTokenMedian } from '../../lib/median.js';
import { THRESHOLDS, DEFAULT_THRESHOLDS } from '../../lib/thresholds.js';

const ASSETS = ['SPY', 'NVDA', 'TSLA', 'GOLD', 'QQQ'];
const NO_FEED = new Set(['QQQ']);
const STALE_THRESHOLD_MIN = 35;
const enc = encodeURIComponent;

async function fetchOne(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

function computeVerdict(asset, { gapPct, alertOpen, isMarketOpen, dataAgeMin }) {
  if (dataAgeMin > STALE_THRESHOLD_MIN) {
    return {
      verdict: 'UNKNOWN',
      reason: `Our latest poll is ${dataAgeMin} minutes old (>${STALE_THRESHOLD_MIN} min limit); data may be stale.`,
    };
  }
  if (NO_FEED.has(asset)) {
    return {
      verdict: 'NO_ORACLE',
      reason: 'No Chainlink feed exists for QQQ on Arbitrum One; only token peer spread is available.',
    };
  }
  if (gapPct == null) {
    return {
      verdict: 'UNKNOWN',
      reason: 'Gap could not be computed — insufficient valid tokens or no oracle price.',
    };
  }

  const thresholds = THRESHOLDS[asset] ?? DEFAULT_THRESHOLDS;
  const openThresh = isMarketOpen ? thresholds.marketOpen.trig : thresholds.marketClosed.trig;
  const absGap = Math.abs(gapPct);
  const sign = gapPct >= 0 ? '+' : '';
  const marketLabel = isMarketOpen ? 'open' : 'closed';

  if (alertOpen || absGap >= openThresh) {
    return {
      verdict: 'DO_NOT_TRUST',
      reason: alertOpen
        ? `An active divergence alert is open for ${asset} (gap ${sign}${gapPct.toFixed(2)}%, market ${marketLabel}).`
        : `Gap of ${sign}${gapPct.toFixed(2)}% meets or exceeds the ${openThresh}% trigger threshold (market ${marketLabel}).`,
    };
  }
  if (absGap >= openThresh / 2) {
    return {
      verdict: 'CAUTION',
      reason: `Gap of ${sign}${gapPct.toFixed(2)}% is above half the ${openThresh}% trigger threshold (market ${marketLabel}).`,
    };
  }
  return {
    verdict: 'OK',
    reason: `Gap of ${sign}${gapPct.toFixed(2)}% is within normal bounds (market ${marketLabel}, threshold ${openThresh}%).`,
  };
}

function buildAssetResult(asset, { latestRows, alertsData, latestTime, now }) {
  const rows = latestRows.filter(r => r.asset === asset);
  const dataAgeMin = Math.round((now - new Date(latestTime).getTime()) / 60000);

  const thresholds = THRESHOLDS[asset] ?? DEFAULT_THRESHOLDS;
  const refRow = rows.find(r => r.ref_price_usd != null) ?? null;
  const clPrice = refRow ? Number(refRow.ref_price_usd) : null;
  const refUpdatedAt = refRow?.ref_updated_at ?? null;
  const feedAddress = refRow?.chainlink_feed ?? null;
  const clAgeMin = refUpdatedAt
    ? Math.round((now - new Date(refUpdatedAt).getTime()) / 60000)
    : null;
  const isMarketOpen = rows[0]?.market_open ?? false;

  const { tokenMedian, tokensUsed } = computeTokenMedian(rows);
  const volumeRows = rows.filter(r => r.excluded_reason == null && !r.unit_mismatch);
  const volume24h = volumeRows.reduce((s, r) => s + Number(r.token_volume_24h ?? 0), 0);
  const excludedCount = rows.filter(r => r.excluded_reason != null || r.unit_mismatch).length;

  const gapPct = !NO_FEED.has(asset) && clPrice && tokenMedian != null
    ? (tokenMedian - clPrice) / clPrice * 100
    : null;

  const latestAlert = alertsData.find(a => a.asset === asset && a.alert_type === 'divergence') ?? null;
  const alertOpen = latestAlert ? latestAlert.event === 'open' : false;

  const { verdict, reason } = computeVerdict(asset, { gapPct, alertOpen, isMarketOpen, dataAgeMin });

  return {
    asset,
    checked_at: new Date(now).toISOString(),
    verdict,
    reason,
    market: { state: isMarketOpen ? 'open' : 'closed' },
    oracle: NO_FEED.has(asset) ? null : {
      source: 'Chainlink',
      network: 'Arbitrum One',
      feed_address: feedAddress,
      price: clPrice,
      updated_at: refUpdatedAt,
      age_minutes: clAgeMin,
    },
    tokens: {
      median_price: tokenMedian,
      tokens_used: tokensUsed,
      volume_24h_usd: volume24h || null,
      excluded_count: excludedCount,
    },
    gap_pct: gapPct != null ? Math.round(gapPct * 10000) / 10000 : null,
    alert_open: alertOpen,
    thresholds_used: NO_FEED.has(asset) ? null : thresholds,
    data_as_of: latestTime,
  };
}

export const handler = async (event) => {
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify({ error: 'Missing Supabase configuration' }),
    };
  }

  const params = event?.queryStringParameters ?? {};
  const assetParam = params.asset ? params.asset.toUpperCase() : null;

  if (assetParam && !ASSETS.includes(assetParam)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify({ error: `Unknown asset "${assetParam}". Valid assets: ${ASSETS.join(', ')}.` }),
    };
  }

  const h = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
  const base = `${SUPABASE_URL}/rest/v1`;

  try {
    const now = Date.now();

    const [tsData, alertsData] = await Promise.all([
      fetchOne(`${base}/rwa_quotes?select=collected_at&order=collected_at.desc&limit=1`, h),
      fetchOne(`${base}/rwa_alerts?select=*&order=created_at.desc&limit=50`, h),
    ]);

    if (!tsData.length) throw new Error('No rows in rwa_quotes');
    const latestTime = tsData[0].collected_at;

    const lCols = 'asset,token_price_usd,price_adj_usd,excluded_reason,unit_mismatch,ref_price_usd,ref_updated_at,market_open,token_volume_24h,chainlink_feed';
    const assetsToFetch = assetParam ? [assetParam] : ASSETS;

    const rowsByAsset = await Promise.all(
      assetsToFetch.map(a =>
        fetchOne(
          `${base}/rwa_quotes?select=${lCols}&asset=eq.${a}&collected_at=eq.${enc(latestTime)}`,
          h
        )
      )
    );

    const latestRows = rowsByAsset.flat();
    const alerts = Array.isArray(alertsData) ? alertsData : [];

    const results = assetsToFetch.map(asset =>
      buildAssetResult(asset, { latestRows, alertsData: alerts, latestTime, now })
    );

    const body = assetParam ? results[0] : results;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify(body),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
