// Padala — server (Ethereum Sepolia)
// Responsibilities (deliberately small, so the app itself never touches user funds or keys):
//   1. serve static files
//   2. /api/rate   — mid-market JPY→PHP / JPY→USD (single source: open.er-api.com)
//   3. /api/fund   — TESTNET ONLY: stands in for "withdraw USDC from SBI VC Trade to your own address".
//                   Sends 5 test USDC to a freshly created browser wallet.
//   4. /api/relay  — submits the user's signed EIP-3009 TransferWithAuthorization and pays the gas.
//                   The recipient and amount are inside the user's signature; the server can only
//                   decide whether to submit it. It never receives a private key.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { JsonRpcProvider, Wallet, Contract, Signature, verifyTypedData, getAddress, isAddress, formatUnits, formatEther } = require('ethers');

const RPC_URL = process.env.RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const CHAIN_ID = 11155111;                                            // Ethereum Sepolia
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';            // Circle USDC on Sepolia
const DECIMALS = 6;
const PORT = Number(process.env.PORT ?? 4173);
const FUND_USDC = 5n * 10n ** 6n;                                     // 5 test USDC per top-up
const PUBLIC = path.join(__dirname, 'public');

const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
];
// Must match the browser exactly (public/app.js).
const DOMAIN = { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const opsPath = path.join(__dirname, 'keys', 'eth_ops.json');
const ops = fs.existsSync(opsPath) ? new Wallet(JSON.parse(fs.readFileSync(opsPath, 'utf8')).privateKey, provider) : null;
const usdc = new Contract(USDC, USDC_ABI, ops ?? provider);

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

// ---- one transaction at a time from the ops key (avoids nonce collisions) ----
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

// ---- testnet top-up (per-address, once per 12h) ----
const funded = new Map();
async function fund(address) {
  if (!ops) return { error: 'Test funds are not configured on this server.' };
  if (!isAddress(address)) return { error: 'Invalid address.' };
  const to = getAddress(address);
  const last = funded.get(to) ?? 0;
  if (Date.now() - last < 12 * 3600 * 1000) return { error: 'This address was already topped up today.' };
  funded.set(to, Date.now());
  try {
    const receipt = await serial(async () => (await usdc.transfer(to, FUND_USDC)).wait(1));
    return { ok: true, usdc: Number(formatUnits(FUND_USDC, DECIMALS)), hash: receipt.hash };
  } catch (e) {
    funded.delete(to);
    throw e;
  }
}

// ---- relay a signed EIP-3009 authorization ----
const relayedPerAddress = new Map();
async function relay(body) {
  if (!ops) return { error: 'Relayer is not configured on this server.' };
  const { from, to, value, validAfter, validBefore, nonce, signature } = body ?? {};
  if (![from, to].every(isAddress)) return { error: 'Invalid address.' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(nonce))) return { error: 'Invalid nonce.' };
  const message = { from: getAddress(from), to: getAddress(to), value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce };
  if (message.value <= 0n) return { error: 'Amount must be positive.' };
  const signer = verifyTypedData(DOMAIN, TYPES, message, signature);
  if (signer !== message.from) return { error: 'Signature does not match the sender.' };
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now >= message.validBefore) return { error: 'This authorization has expired. Please send again.' };
  if (await usdc.authorizationState(message.from, nonce)) return { error: 'This authorization was already used.' };
  const balance = await usdc.balanceOf(message.from);
  if (balance < message.value) return { error: 'Insufficient balance.' };
  // light abuse guard for the shared testnet gas wallet
  const times = (relayedPerAddress.get(message.from) ?? []).filter((t) => Date.now() - t < 3600 * 1000);
  if (times.length >= 20) return { error: 'Too many transfers from this address in the last hour.' };
  relayedPerAddress.set(message.from, [...times, Date.now()]);

  const { v, r, s } = Signature.from(signature);
  const receipt = await serial(async () => {
    const tx = await usdc.transferWithAuthorization(message.from, message.to, message.value, message.validAfter, message.validBefore, nonce, v, r, s);
    return tx.wait(1);
  });
  if (receipt.status !== 1) return { error: 'The transfer failed on-chain.', hash: receipt.hash };
  return { ok: true, hash: receipt.hash, blockNumber: receipt.blockNumber };
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
};

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 10_000) throw new Error('Request too large.'); }
  return JSON.parse(body || '{}');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (url.pathname === '/api/rate') return json(200, await getRate());
    if (url.pathname === '/api/fund' && req.method === 'POST') {
      const { address } = await readJson(req);
      const result = await fund(String(address ?? ''));
      return json(result.error ? 400 : 200, result);
    }
    if (url.pathname === '/api/relay' && req.method === 'POST') {
      const result = await relay(await readJson(req));
      return json(result.error ? 400 : 200, result);
    }
    // "/" = the approved dual-phone stage (Aug 2 design freeze); "/wallet" = the full wallet app
    let file = path.join(PUBLIC, url.pathname === '/' ? 'stage.html' : url.pathname);
    if (url.pathname === '/wallet') file = path.join(PUBLIC, 'index.html');
    if (url.pathname === '/r') file = path.join(PUBLIC, 'receive.html');
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  } catch (e) {
    json(500, { error: String(e.shortMessage ?? e.message ?? e) });
  }
});

server.listen(PORT, async () => {
  console.log(`Padala: http://localhost:${PORT}  (Ethereum Sepolia via ${RPC_URL})`);
  if (ops) {
    try {
      const [u, eth] = await Promise.all([usdc.balanceOf(ops.address), provider.getBalance(ops.address)]);
      console.log(`ops ${ops.address}: ${formatUnits(u, DECIMALS)} USDC / ${formatEther(eth)} ETH`);
    } catch (e) { console.log(`ops balance check failed: ${e.message}`); }
  } else {
    console.log('no keys/eth_ops.json — /api/fund and /api/relay disabled');
  }
});
