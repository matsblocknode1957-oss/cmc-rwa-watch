-- Migration: create rwa_alerts table for divergence and stale alerts.
-- Safe to run twice: CREATE TABLE IF NOT EXISTS, DROP POLICY IF EXISTS before CREATE POLICY.

-- ── Table ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rwa_alerts (
  id                   bigserial    primary key,
  created_at           timestamptz  not null default now(),
  asset                text         not null,   -- 'GOLD' | 'NVDA' | 'TSLA' | 'SPY'
  alert_type           text         not null,   -- 'divergence' | 'stale'
  event                text         not null,   -- 'open' | 'close'
  market_state         text,                    -- 'open' | 'closed' | null for stale alerts
  token_median         numeric,                 -- median of valid token prices at alert time
  chainlink_price      numeric,                 -- Chainlink price at alert time
  chainlink_updated_at timestamptz,             -- when the Chainlink answer was last updated
  gap_pct              numeric,                 -- (median - chainlink) / chainlink * 100
  tokens_used          integer,                 -- number of valid tokens in the median
  crypto_id            bigint,                  -- stale alerts only: the affected token's crypto_id
  note                 text
);

-- ── Index ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_rwa_alerts_asset_type_time
  ON rwa_alerts (asset, alert_type, created_at DESC);

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE rwa_alerts ENABLE ROW LEVEL SECURITY;

-- Drop before recreate so the script is safe to run twice
DROP POLICY IF EXISTS "anon_insert" ON rwa_alerts;
DROP POLICY IF EXISTS "anon_select" ON rwa_alerts;

CREATE POLICY "anon_insert"
  ON rwa_alerts
  AS PERMISSIVE FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "anon_select"
  ON rwa_alerts
  AS PERMISSIVE FOR SELECT
  TO anon
  USING (true);
