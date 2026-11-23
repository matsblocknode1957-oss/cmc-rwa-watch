-- Migration: add excluded_reason and price_adj_usd to rwa_quotes.
-- Safe to run twice (ADD COLUMN IF NOT EXISTS).

ALTER TABLE rwa_quotes
  ADD COLUMN IF NOT EXISTS excluded_reason  text;
  -- 'hyperliquid_perp' | 'stale' | null

ALTER TABLE rwa_quotes
  ADD COLUMN IF NOT EXISTS price_adj_usd    numeric(18,6);
  -- Equals token_price_usd * 31.1035 when a per-gram gold token is corrected
  -- to troy-oz units; otherwise equals token_price_usd.
