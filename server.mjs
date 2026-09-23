// Padala — server
// Responsibilities (deliberately small, so the app itself never touches user funds):
//   1. serve static files
//   2. /api/rate   — mid-market JPY→PHP / JPY→USD (single source: open.er-api.com)
//   3. /api/fund   — DEVNET ONLY: top up a freshly created browser wallet with test SOL + test USDC.
//                   In the real product this step is "buy USDC at a licensed exchange and withdraw
//                   to your own address" — the app only shows the address, it never buys or holds.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, getAccount, transfer } = require('@solana/spl-token');

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey(process.env.MINT ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // Circle devnet USDC
const DECIMALS = 6;
const PORT = Number(process.env.PORT ?? 4173);
const FUND_SOL = 0.02;   // enough for ~1,000 transfers + a few token-account creations
const FUND_USDC = 20;    // ≈ ¥3,000 worth of test money
const PUBLIC = path.join(__dirname, 'public');

const connection = new Connection(RPC_URL, 'confirmed');
const faucetPath = path.join(__dirname, 'keys', 'sender.json');
const faucet = fs.existsSync(faucetPath)
  ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(faucetPath, 'utf8'))))
  : null;

// ---- rate (one source only; mixing sources produced negative "savings" in the Aug 1 test) ----
let rateCache = null;
async function getRate() {
  if (rateCache && Date.now() - rateCache.fetchedAt < 10 * 60 * 1000) return rateCache;
  const res = await fetch('https://open.er-api.com/v6/latest/JPY');
  if (!res.ok) throw new Error(`rate API HTTP ${res.status}`);
  const data = await res.json();
  if (!data.rates?.PHP || !data.rates?.USD) throw new Error('rate API: PHP/USD missing');
  rateCache = {
    phpPerJpy: data.rates.PHP,
    usdPerJpy: data.rates.USD,
    phpPerUsd: data.rates.PHP / data.rates.USD,
    baseTime: data.time_last_update_utc,
    source: 'open.er-api.com',
    fetchedAt: Date.now(),
  };
  return rateCache;
}

// ---- devnet faucet (per-address, once per 12h) ----
const funded = new Map();
async function fund(address) {
  if (!faucet) return { error: 'Faucet key not configured on this server.' };
  let owner;
  try { owner = new PublicKey(address); } catch { return { error: 'Invalid address.' }; }
  const last = funded.get(address) ?? 0;
  if (Date.now() - last < 12 * 3600 * 1000) return { error: 'This address was already funded today.' };

  const solTx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: faucet.publicKey, toPubkey: owner, lamports: Math.round(FUND_SOL * LAMPORTS_PER_SOL),
  }));
  await sendAndConfirmTransaction(connection, solTx, [faucet]);

  const fromAta = await getOrCreateAssociatedTokenAccount(connection, faucet, USDC_MINT, faucet.publicKey);
  const toAta = await getOrCreateAssociatedTokenAccount(connection, faucet, USDC_MINT, owner);
  const sig = await transfer(connection, faucet, fromAta.address, toAta.address, faucet, BigInt(FUND_USDC * 10 ** DECIMALS));
  funded.set(address, Date.now());
  const bal = Number((await getAccount(connection, toAta.address)).amount) / 10 ** DECIMALS;
  return { ok: true, sol: FUND_SOL, usdc: FUND_USDC, balance: bal, signature: sig };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (url.pathname === '/api/rate') return json(200, await getRate());
    if (url.pathname === '/api/fund' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { address } = JSON.parse(body || '{}');
      const result = await fund(String(address ?? ''));
      return json(result.error ? 400 : 200, result);
    }
    let file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (url.pathname === '/r') file = path.join(PUBLIC, 'receive.html');
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  } catch (e) {
    json(500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, async () => {
  console.log(`Padala: http://localhost:${PORT}  (RPC ${RPC_URL})`);
  if (faucet) {
    try {
      const ata = await getOrCreateAssociatedTokenAccount(connection, faucet, USDC_MINT, faucet.publicKey);
      const bal = Number((await getAccount(connection, ata.address)).amount) / 10 ** DECIMALS;
      const sol = (await connection.getBalance(faucet.publicKey)) / LAMPORTS_PER_SOL;
      console.log(`devnet faucet ${faucet.publicKey.toBase58()}: ${bal} USDC / ${sol.toFixed(3)} SOL`);
    } catch (e) { console.log(`faucet balance check failed: ${e.message}`); }
  } else {
    console.log('no keys/sender.json — /api/fund disabled');
  }
});
