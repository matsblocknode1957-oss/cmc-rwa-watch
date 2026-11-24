// lib/thresholds.js — per-asset divergence thresholds shared by alerts.js and netlify/functions/check.js

export const THRESHOLDS = {
  SPY:  { marketOpen: { trig: 2.0, shut: 1.0  }, marketClosed: { trig: 3.0, shut: 1.5  } },
  NVDA: { marketOpen: { trig: 2.0, shut: 1.0  }, marketClosed: { trig: 3.0, shut: 1.5  } },
  TSLA: { marketOpen: { trig: 2.0, shut: 1.0  }, marketClosed: { trig: 3.0, shut: 1.5  } },
  GOLD: { marketOpen: { trig: 1.5, shut: 0.75 }, marketClosed: { trig: 1.5, shut: 0.75 } },
};

export const DEFAULT_THRESHOLDS = { marketOpen: { trig: 2.0, shut: 1.0 }, marketClosed: { trig: 3.0, shut: 1.5 } };
