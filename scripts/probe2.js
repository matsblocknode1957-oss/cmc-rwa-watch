import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'probe-output');
mkdirSync(OUT, { recursive: true });

const KEY = process.env.CMC_API_KEY;
if (!KEY) throw new Error('CMC_API_KEY not set');

const BASE = 'https://pro-api.coinmarketcap.com';
const H = { 'X-CMC_PRO_API_KEY': KEY, Accept: 'application/json' };

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: H });
  return { status: res.status, body: await res.json() };
}

function save(name, data) {
  writeFileSync(join(OUT, name), JSON.stringify(data, null, 2));
  const topKeys = data.body?.data ? Object.keys(data.body.data).join(', ') : '(no data key)';
  console.log(`[${data.status}] ${name}  — top-level data keys: ${topKeys}`);
}

// Call 1: market-pairs for Gold (rwa_id=1)
const goldPairs = await get('/v5/real-world-assets/market-pairs/list', { id: 1, limit: 20 });
save('04-market-pairs-gold.json', goldPairs);

// Call 2: market-pairs for NVDA (rwa_id=2)
const nvdaPairs = await get('/v5/real-world-assets/market-pairs/list', { id: 2, limit: 20 });
save('05-market-pairs-nvda.json', nvdaPairs);

// Call 3: issuers/list — find tokenised gold and stock issuers
const issuers = await get('/v5/real-world-assets/issuers/list', { limit: 50 });
save('06-issuers-list.json', issuers);

// Call 4: standard crypto quotes for PAXG and XAUT (tokenised gold, well-known)
const cryptoQ = await get('/v2/cryptocurrency/quotes/latest', { symbol: 'PAXG,XAUT' });
save('07-crypto-quotes-paxg-xaut.json', cryptoQ);

// Call 5: rwa quotes/latest for Gold + NVDA — check every field (looking for TradFi ref price)
const rwaQ = await get('/v5/real-world-assets/quotes/latest', { id: '1,2' });
save('08-rwa-quotes-gold-nvda.json', rwaQ);

// Call 6: check if historical endpoint exists for rwa
const hist = await get('/v5/real-world-assets/quotes/historical', { id: 1, time_start: '2026-11-08', time_end: '2026-11-10', interval: '1h' });
save('09-rwa-historical-gold.json', hist);

console.log('\nprobe2 complete');
