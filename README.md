# RWA Watch: is the oracle telling the truth while the market is shut?

Tokenised stocks and gold keep trading when their real markets are closed. The Chainlink oracles that DeFi lending relies on mostly don't. RWA Watch measures that gap every 15 minutes from CoinMarketCap's RWA data and tells you when not to trust the oracle.

**Live dashboard:** https://rwa-watch.netlify.app  
**Oracle check API:** https://rwa-watch.netlify.app/api/check  
**Demo video:** coming soon  
Built by [FintechCheck](https://pegcheck.uk) · [@PegCheckApp](https://x.com/PegCheckApp)  
Track: Real World Assets · [#BuildwithCMC](https://x.com/hashtag/BuildwithCMC)

---

## Why it matters

Lending protocols value tokenised collateral using a Chainlink oracle. When NYSE or gold markets are shut, the oracle barely updates — but tokens keep trading 24/7.

If the real price moves while the oracle is frozen, the protocol is valuing collateral at a stale number. Too high means bad debt waiting to happen; too low means users get liquidated or under-borrow unfairly.

---

## What we found (17–24 Nov 2026)

### Caught live — 24 Nov, NVDA

At 09:32 UTC, with the US market shut, tokenised NVDA was trading 3.49% below a Chainlink price that had not updated for 762 minutes. RWA Watch opened a live alert. At the 14:30 opening bell the oracle moved to meet the tokens, and the alert closed itself at 14:32 UTC with the gap at +0.26%. Nobody touched it.

### 23 Nov — NVDA: tokens moved first, the oracle caught up at the bell

Tokens drifted upward all weekend while the oracle stayed put, reaching +9.45% above the oracle by Mon 09:17 UTC before any news broke. Nvidia reinstated Jensen Huang as CEO (news landed 13:46–14:02 UTC); at 14:16 UTC tokens were $160.66 vs oracle $143.52 (+11.94%, volume-weighted). The oracle caught up at 14:30:37. The backtest flags this weekend divergence as early as Sat 21 Nov 22:17 UTC.

### 20–22 Nov — gold: tokens and the oracle disagreed all weekend

Gold markets shut at 22:00 UTC on Friday. The oracle's last update, at 23:13 UTC, put gold at $3,575.31, and it stayed there until Sunday evening. Tokenised gold kept trading but never reached that price: it sat between $3,500 and $3,553, up to 2.12% below the oracle (Sat 21 Nov 04:30 UTC). When gold reopened at 23:00 UTC on Sunday it traded around $3,581, close to the oracle, and the tokens went back to their usual small discount (about 0.27%). This time it was the tokens, not the oracle, that were off.

That is the point: while the market is shut, nobody knows which price is right, and a lending protocol is relying on one of them.

### Real money

In the 24 hours to Sun 22 Nov 14:00 UTC, with markets shut, CoinMarketCap recorded **$91.6M** of tokenised NVDA, **$209.6M** of gold, **$26.1M** of TSLA, and **$21.9M** of SPY trading.

### Honest note

This covers a few closed-market periods, not years of data. The claim is not "tokens predict the open"; it is "while the market is shut, tokens and the oracle can disagree by several per cent, and nobody knows which is right until it reopens."

---

## How it works

```
Railway cron (every 15 min)
  → CMC /v5/real-world-assets/quotes/latest  (one API call, all assets)
  → Chainlink AggregatorV3 feeds on Arbitrum One  (one RPC call per feed)
  → Supabase: rwa_quotes + rwa_alerts tables
  → Netlify: static dashboard + serverless API functions
```

**Assets and Chainlink feeds on Arbitrum One:**

| Asset | CMC rwa\_id | Chainlink feed address |
|-------|------------|------------------------|
| GOLD  | 1   | `0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c` |
| NVDA  | 2   | `0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F` |
| TSLA  | 14  | `0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3` |
| SPY   | 86  | `0x46306F3795342117721D8DEd50fbcF6DF2b3cc10` |
| QQQ   | 118 | — no Arbitrum feed |

**Price calculation:** volume-weighted median across all tokens for the asset. Tokens are excluded if they are Hyperliquid perpetuals, have a price frozen for 8 consecutive polls, or have zero volume. Per-gram gold tokens are converted to troy ounces (×31.1035) before comparison.

**Market hours:** NYSE calendar for equities — open 14:30–21:00 UTC (18:00 UTC on early-close days). Gold: open Sun 23:00 – Fri 22:00 UTC with a daily break 22:00–23:00 UTC.

**Alert thresholds** (trigger / clear, `lib/thresholds.js`):

| Asset | Market open | Market closed |
|-------|-------------|---------------|
| SPY, NVDA, TSLA | 2.0% / 1.0% | 3.0% / 1.5% |
| GOLD | 1.5% / 0.75% | 1.5% / 0.75% |

Backtest replays the same alert rules over stored history and writes results to `dashboard/backtest-alerts.json`.

---

## Oracle check API

Returns a machine-readable trust verdict for any asset. Use it in bots, agents, or scripts before acting on a Chainlink price.

```
GET /api/check            → all assets (array)
GET /api/check?asset=NVDA → one asset
```

```bash
curl https://rwa-watch.netlify.app/api/check?asset=NVDA
```

**Verdicts:**

| Verdict | Meaning |
|---------|---------|
| `OK` | Gap is below half the trigger threshold. |
| `CAUTION` | Gap is at or above half the trigger threshold but below the trigger. |
| `DO_NOT_TRUST` | An active alert is open, or the gap meets or exceeds the trigger threshold. |
| `NO_ORACLE` | No Chainlink feed exists for this asset on Arbitrum One (QQQ). |
| `UNKNOWN` | Our latest poll is more than 35 minutes old, or the gap could not be computed. |

**Example response (real, 24 Nov 13:17 UTC, during the live alert):**

```json
{
  "asset": "NVDA",
  "verdict": "DO_NOT_TRUST",
  "reason": "An active divergence alert is open for NVDA (gap -2.35%, market closed).",
  "market": { "state": "closed" },
  "oracle": {
    "source": "Chainlink",
    "network": "Arbitrum One",
    "feed_address": "0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F",
    "price": 161.11,
    "updated_at": "2026-11-24T13:01:04+00:00",
    "age_minutes": 17
  },
  "tokens": { "median_price": 157.324094, "tokens_used": 7, "volume_24h_usd": 784236695.32, "excluded_count": 1 },
  "gap_pct": -2.3499,
  "alert_open": true,
  "data_as_of": "2026-11-24T13:02:37.286+00:00"
}
```

CORS is open. Cache: 60 seconds. Full spec: [`/openapi.json`](https://rwa-watch.netlify.app/openapi.json). Agent-friendly description: [`/llms.txt`](https://rwa-watch.netlify.app/llms.txt).

---

## What the CMC API made possible

**Cross-issuer volume-weighted price.** One call to `/v5/real-world-assets/quotes/latest` returns every issuer's token for an asset with price, 24h volume, and market cap. That is what makes a volume-weighted median across all issuers possible in a single request — no scraping, no joins.

**24/7 token pricing.** CMC's RWA data reports token prices continuously, not just during market hours. That continuous feed is the only way to observe what the market thinks while NYSE is shut.

---

## Where the CMC API got in the way

- **No per-token last-updated timestamp.** We detect frozen prices ourselves: eight consecutive polls with an identical price mark a token as stale. One SPY token sat at exactly $714.344610 for days.
- **Symbol collisions.** Three tokens are all called "SPY". `crypto_id` is the only safe unique key.
- **Non-tradable rows.** Hyperliquid perpetuals sit at frozen, stale prices (the TSLA and QQQ ones at roughly half the spot price) with zero volume. "NA (Derivatives)" rows show a sensible-looking price but zero volume. Both look like tokens but are not tradable spot prices, so both are excluded.
- **Mixed units for gold.** Some gold tokens are priced per gram, not per troy ounce. We detect and correct the discrepancy using the Chainlink reference price as a sanity check.
- **Wrong parameter name.** The quotes endpoint requires `rwa_id`, not `id` — this cost us a failed first call.
- **Rolling volume window.** `volume_24h` is always rolling, so measuring "volume while the market is shut" requires choosing the time window carefully.

---

## Run it yourself

**Requirements:** Node 22, a CoinMarketCap Pro API key with RWA endpoint access, a Supabase project, an Arbitrum RPC URL.

```bash
# 1. Clone and install
git clone https://github.com/matsblocknode1957-oss/cmc-rwa-watch.git
cd cmc-rwa-watch
npm install

# 2. Configure
cp .env.example .env
# edit .env and fill in CMC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

# 3. Set up the database
# In the Supabase SQL editor, run these in order:
#   schema.sql
#   sql/002_alerts.sql
#   sql/003_rwa_alerts.sql

# 4. Test without writing to the database
DRY_RUN=1 node collector.js

# 5. Run the dashboard locally
node scripts/serve-dashboard.js
# open http://localhost:8888

# 6. Replay alerts over stored history
node scripts/backtest-alerts.js
```

**Environment variables** (see `.env.example`):

| Variable | Required | Notes |
|----------|----------|-------|
| `CMC_API_KEY` | Yes | CoinMarketCap Pro key |
| `SUPABASE_URL` | Yes | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Yes | Anon key (insert + select only) |
| `ARBITRUM_RPC` | No | Defaults to `https://arb1.arbitrum.io/rpc` |
| `DRY_RUN` | No | Set to `1` to skip DB writes |

The Netlify dashboard deploys automatically on push to `main`. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` as environment variables in Netlify's site settings.

---

## Security note

The anon key can insert rows — this is a prototype where the collector and the public dashboard share one key. In production, writes would use a service-role key (never exposed to the browser) and the public would receive read-only access.

---

*Not financial advice.*
