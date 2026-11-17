-- Run this in Supabase → SQL Editor → New query.
-- Creates one table, enables RLS, grants anon INSERT + SELECT only.
-- Touch nothing else.

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE rwa_quotes (
  id                   bigint       generated always as identity primary key,
  collected_at         timestamptz  not null,
  asset                text         not null,   -- 'GOLD' | 'NVDA' | 'TSLA' | 'SPY' | 'QQQ'
  token_symbol         text         not null,   -- e.g. 'PAXG', 'NVDAB', 'TSLAB'
  issuer               text,                    -- e.g. 'Paxos', 'bStocks'
  crypto_id            integer,                 -- CMC crypto_id for this token
  token_price_usd      numeric(18,6),           -- this token's market price
  token_market_cap     numeric(24,2),           -- token market cap in USD (null if unavailable)
  token_volume_24h     numeric(24,2),           -- 24h trading volume in USD
  avg_tokenized_price  numeric(18,6),           -- CMC market-cap-weighted average across all tokens for this RWA
  unit_mismatch        boolean      not null default false,
                                               -- true when token price appears to be in a
                                               -- different unit vs the asset average (>30% off)
                                               -- e.g. CGO/VNXAU price gold per gram, not per troy oz
  ref_price_usd        numeric(18,6),           -- Chainlink reference (null if feed MISSING or unit_mismatch)
  ref_updated_at       timestamptz,             -- Chainlink updatedAt timestamp
  chainlink_desc       text,                    -- confirmed description() e.g. 'XAU / USD'
  gap_pct              numeric(10,6),           -- (token_price - ref) / ref * 100
                                               -- null: market closed | no ref | unit_mismatch
  gap_vs_peers_pct     numeric(10,6),           -- (token_price - median_of_other_valid_tokens) / median * 100
                                               -- computed every poll including weekends; null for unit_mismatch
                                               -- or when fewer than 2 valid peers exist
  alert                boolean      not null default false,  -- abs(gap_pct) >= 1.0
  market_open          boolean      not null,  -- NYSE open at collection time (UTC)
  weekend              boolean      not null,  -- Saturday or Sunday UTC
  chainlink_feed       text                    -- Arbitrum One proxy address (null = not yet configured)
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_rwa_quotes_asset_time  ON rwa_quotes (asset, collected_at DESC);
CREATE INDEX idx_rwa_quotes_token_time  ON rwa_quotes (token_symbol, collected_at DESC);
CREATE INDEX idx_rwa_quotes_alerts      ON rwa_quotes (collected_at DESC) WHERE alert;

-- ── Row Level Security ────────────────────────────────────────────────────────
-- RLS is enabled.  No policy = no access.  Only the two policies below are granted.
ALTER TABLE rwa_quotes ENABLE ROW LEVEL SECURITY;

-- The collector runs with SUPABASE_ANON_KEY (the anon role).
-- INSERT: allow the collector to write rows.
CREATE POLICY "anon_insert"
  ON rwa_quotes
  AS PERMISSIVE FOR INSERT
  TO anon
  WITH CHECK (true);

-- SELECT: allow public read access (useful for dashboards and the hackathon demo).
CREATE POLICY "anon_select"
  ON rwa_quotes
  AS PERMISSIVE FOR SELECT
  TO anon
  USING (true);

-- No UPDATE or DELETE policies are created.
-- With RLS enabled, any operation without a matching policy is denied by default.
-- The service_role key bypasses RLS — keep it out of GitHub secrets entirely.

-- ── Views (optional, run separately if wanted) ─────────────────────────────────

-- Latest price per token (dashboard: current state at a glance)
-- CREATE VIEW rwa_latest AS
-- SELECT DISTINCT ON (asset, token_symbol)
--   collected_at, asset, token_symbol, issuer,
--   token_price_usd, ref_price_usd, gap_pct, gap_vs_peers_pct, alert, unit_mismatch, market_open, weekend
-- FROM rwa_quotes
-- ORDER BY asset, token_symbol, collected_at DESC;

-- Alerts in the last 24 h
-- CREATE VIEW rwa_alerts_24h AS
-- SELECT collected_at, asset, token_symbol, token_price_usd, ref_price_usd, gap_pct
-- FROM rwa_quotes
-- WHERE alert AND collected_at > now() - interval '24 hours'
-- ORDER BY collected_at DESC;
