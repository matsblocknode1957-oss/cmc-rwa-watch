import 'dotenv/config';
import { ethers } from 'ethers';

const ARB_RPC = process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc';

const FEEDS = {
  SPY:  '0x46306F3795342117721D8DEd50fbcF6DF2b3cc10',
  NVDA: '0x4881A4418b5F2460B21d6F08CD5aA0678a7f262F',
  TSLA: '0x3609baAa0a9b1f0FE4d6CC01884585d0e191C3E3',
  XAU:  '0x1F954Dc24a49708C26E0C1777f16750B5C6d5a2c',
};

const AGG_ABI = [
  'function description()   view returns (string)',
  'function decimals()       view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 _roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
];

function minsAgo(isoTs) {
  return ((Date.now() - new Date(isoTs).getTime()) / 60_000).toFixed(1);
}

async function checkFeed(sym, address, provider) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Feed: ${sym}  (${address})`);

  const c = new ethers.Contract(address, AGG_ABI, provider);

  const [desc, dec, latest] = await Promise.all([
    c.description(),
    c.decimals(),
    c.latestRoundData(),
  ]);

  const decNum    = Number(dec);
  const price     = Number(latest.answer) / 10 ** decNum;
  const updatedTs = new Date(Number(latest.updatedAt) * 1000).toISOString();
  const latestId  = latest.roundId;   // BigInt

  console.log(`  description() : "${desc}"`);
  console.log(`  decimals()    : ${decNum}`);
  console.log(`  latestRoundData:`);
  console.log(`    roundId     : ${latestId}`);
  console.log(`    answer      : ${latest.answer} → $${price.toFixed(4)} (÷ 10^${decNum})`);
  console.log(`    updatedAt   : ${updatedTs}  (${minsAgo(updatedTs)} min ago)`);

  // ── Walk back last 10 rounds ──────────────────────────────────────────────
  console.log(`\n  Last 10 rounds (roundId → updatedAt, answer):`);
  const rows = [];
  for (let i = 0n; i < 10n; i++) {
    const rid = latestId - i;
    if (rid <= 0n) break;
    try {
      const r     = await c.getRoundData(rid);
      const ts    = new Date(Number(r.updatedAt) * 1000).toISOString();
      const p     = (Number(r.answer) / 10 ** decNum).toFixed(4);
      rows.push({ rid, ts, p });
    } catch {
      rows.push({ rid, ts: 'error', p: '—' });
    }
  }

  // Print + compute gaps between consecutive rounds
  for (let j = 0; j < rows.length; j++) {
    const r    = rows[j];
    const prev = rows[j + 1];
    let gap    = '';
    if (prev && prev.ts !== 'error' && r.ts !== 'error') {
      const diffMin = (new Date(r.ts) - new Date(prev.ts)) / 60_000;
      gap = `  (+${diffMin.toFixed(0)} min since prev)`;
    }
    console.log(`    [${j === 0 ? 'latest' : `  -${j}   `}] roundId=${r.rid}  ${r.ts}  $${r.p}${gap}`);
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  console.log(`RPC: ${ARB_RPC}`);
  console.log(`Time now: ${new Date().toISOString()}`);

  for (const [sym, addr] of Object.entries(FEEDS)) {
    await checkFeed(sym, addr, provider);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log('Done.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
