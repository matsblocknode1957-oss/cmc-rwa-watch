// lib/median.js — shared volume-weighted median for alerts.js and netlify/functions/data.js

function plainMedian(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function weightedMedian(pairs) {  // pairs: [{price, weight}]
  const sorted = [...pairs].sort((a, b) => a.price - b.price);
  const total  = sorted.reduce((s, p) => s + p.weight, 0);
  if (total === 0) return plainMedian(sorted.map(p => p.price));
  let cum = 0;
  for (const { price, weight } of sorted) {
    cum += weight;
    if (cum >= total / 2) return price;
  }
  return sorted.at(-1).price;
}

// Compute token median from a set of rwa_quotes rows for one asset/poll.
// Filters to excluded_reason == null && !unit_mismatch.
// Uses volume-weighted median when any token has volume > 0; falls back to plain median.
// Returns { tokenMedian, tokensUsed, peerSpread }.
export function computeTokenMedian(rows) {
  const valid = rows.filter(r => r.excluded_reason == null && !r.unit_mismatch);
  const pairs = valid
    .map(r => ({
      price:  Number(r.price_adj_usd ?? r.token_price_usd),
      weight: Number(r.token_volume_24h ?? 0),
    }))
    .filter(p => Number.isFinite(p.price) && p.price > 0);

  if (!pairs.length) return { tokenMedian: null, tokensUsed: 0, peerSpread: null };

  const hasVolume = pairs.some(p => p.weight > 0);
  const med = hasVolume ? weightedMedian(pairs) : plainMedian(pairs.map(p => p.price));

  const prices     = pairs.map(p => p.price);
  const peerSpread = prices.length >= 2
    ? (Math.max(...prices) - Math.min(...prices)) / med * 100
    : null;

  return { tokenMedian: med, tokensUsed: pairs.length, peerSpread };
}
