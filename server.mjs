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
const FEE_BPS = 95n;
const GAS_PER_SEND = 2n * 86000n;                                     // family transfer + fee transfer (measured 85,732 each)                                                  // service fee 0.95% of the total (provisional, as in the Aug 2 design)
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
  const withFee = async (r) => ({ ...r, feeBps: Number(FEE_BPS), feeTo: ops?.address ?? null, minFeeMicro: Number(await minFeeMicro()) });
  if (rateCache && Date.now() - rateCache.fetchedAt < 10 * 60 * 1000) return withFee(rateCache);
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
  return withFee(rateCache);
}

// ---- minimum fee = what the two submissions cost in gas right now (so a small transfer never runs at a loss) ----
const mainnet = new JsonRpcProvider(process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com', 1, { staticNetwork: true });
let ethCache = null;
async function minFeeMicro() {
  if (!ethCache || Date.now() - ethCache.at > 10 * 60 * 1000) {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const usd = (await res.json())?.ethereum?.usd;
    if (!usd) throw new Error('ETH price unavailable');
    ethCache = { usd, at: Date.now() };
  }
  // priced at Ethereum MAINNET gas (what a real send costs); Sepolia gas has no real-world price
  const [block, tip] = await Promise.all([mainnet.getBlock('latest'), mainnet.send('eth_maxPriorityFeePerGas', [])]);
  const weiPerGas = (block.baseFeePerGas ?? 0n) + BigInt(tip);
  const wei = GAS_PER_SEND * weiPerGas;
  // wei → USDC micro units: wei / 1e18 * usd * 1e6, rounded up
  const usdMicro = BigInt(Math.round(ethCache.usd * 1e6));
  return (wei * usdMicro + 10n ** 18n - 1n) / 10n ** 18n;
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

// ---- relay a signed EIP-3009 authorization (+ the service fee, signed separately) ----
// The user signs two authorizations: the transfer to the family, and the fee to Padala's address.
// Both recipients and amounts are fixed by the user's signatures; the server can only submit or refuse.
async function checkAuth(message, signature) {
  const signer = verifyTypedData(DOMAIN, TYPES, message, signature);
  if (signer !== message.from) return 'Signature does not match the sender.';
  if (BigInt(Math.floor(Date.now() / 1000)) >= message.validBefore) return 'This authorization has expired. Please send again.';
  if (await usdc.authorizationState(message.from, message.nonce)) return 'This authorization was already used.';
  return null;
}
const toMessage = (from, a) => ({
  from: getAddress(from), to: getAddress(a.to), value: BigInt(a.value),
  validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce,
});
const submit = (m, signature) => serial(async () => {
  const { v, r, s } = Signature.from(signature);
  const tx = await usdc.transferWithAuthorization(m.from, m.to, m.value, m.validAfter, m.validBefore, m.nonce, v, r, s);
  return tx.wait(1);
});

const relayedPerAddress = new Map();
async function relay(body) {
  if (!ops) return { error: 'Relayer is not configured on this server.' };
  const { from, fee } = body ?? {};
  if (!isAddress(from) || !isAddress(body.to) || !isAddress(fee?.to)) return { error: 'Invalid address.' };
  if (![body.nonce, fee.nonce].every((n) => /^0x[0-9a-fA-F]{64}$/.test(String(n)))) return { error: 'Invalid nonce.' };
  const main = toMessage(from, body);
  const feeMsg = toMessage(from, fee);
  if (main.value <= 0n) return { error: 'Amount must be positive.' };
  if (feeMsg.to !== ops.address) return { error: 'The fee must be paid to Padala.' };
  if (feeMsg.value * 10000n < (main.value + feeMsg.value) * FEE_BPS) return { error: 'The fee is lower than shown.' };
  // gas moves between quote and send: accept down to half of the current gas floor
  if (feeMsg.value * 2n < await minFeeMicro()) return { error: 'The fee does not cover the network cost. Please send again.' };
  for (const [m, sig] of [[main, body.signature], [feeMsg, fee.signature]]) {
    const err = await checkAuth(m, sig);
    if (err) return { error: err };
  }
  const balance = await usdc.balanceOf(main.from);
  if (balance < main.value + feeMsg.value) return { error: 'Insufficient balance.' };
  // light abuse guard for the shared testnet gas wallet
  const times = (relayedPerAddress.get(main.from) ?? []).filter((t) => Date.now() - t < 3600 * 1000);
  if (times.length >= 20) return { error: 'Too many transfers from this address in the last hour.' };
  relayedPerAddress.set(main.from, [...times, Date.now()]);

  // the family's transfer first: the fee is only taken after the money has gone out
  const receipt = await submit(main, body.signature);
  if (receipt.status !== 1) return { error: 'The transfer failed on-chain.', hash: receipt.hash };
  // the fee goes on-chain in the background so the sender is not kept waiting for a second block
  submit(feeMsg, fee.signature)
    .then((r) => console.log(`fee ${r.status === 1 ? 'collected' : 'FAILED'} for ${receipt.hash}: ${r.hash}`))
    .catch((e) => console.log(`fee not collected for ${receipt.hash}: ${e.shortMessage ?? e.message}`));
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
