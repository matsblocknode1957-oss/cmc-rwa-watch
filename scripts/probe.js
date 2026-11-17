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
const HEADERS = { 'X-CMC_PRO_API_KEY': KEY, Accept: 'application/json' };

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: HEADERS });
  const json = await res.json();
  return { status: res.status, body: json };
}

function save(name, data) {
  const file = join(OUT, name);
  writeFileSync(file, JSON.stringify(data, null, 2));
  const preview = JSON.stringify(data).slice(0, 120);
  console.log(`saved ${name} (HTTP ${data.status}) — ${preview}`);
}

// Call 1: map with no filter — see what comes back and inspect structure
const map = await get('/v5/real-world-assets/map', { limit: 20 });
save('01-map-no-filter.json', map);

// Call 2: assets/list with no filter, top 20 by tokenized_market_cap
const assets = await get('/v5/real-world-assets/assets/list', {
  limit: 20,
  sort: 'tokenized_market_cap',
  sort_dir: 'desc',
});
save('02-assets-list-top20.json', assets);

// Call 3: quotes/latest by symbol for known tokenised treasury tokens
const quotes = await get('/v5/real-world-assets/quotes/latest', {
  symbol: 'BUIDL,USYC,USTB,BENJI,OUSG,TBILL,STBT,ONDO',
});
save('03-quotes-known-symbols.json', quotes);

console.log('probe complete — check probe-output/');
