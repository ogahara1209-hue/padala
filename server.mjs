// 日比SC送金 デモUI サーバー
// 役割: ①静的ファイル配信 ②レート取得(/api/rate) ③devnet USDC送金(/api/send)
// 送金ロジックは mvp-kit（8/1検証済み）の依存パッケージと鍵をそのまま再利用する
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MVP_KIT = path.join(__dirname, '..', 'mvp-kit');
const require = createRequire(path.join(MVP_KIT, 'package.json'));
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { getOrCreateAssociatedTokenAccount, getAccount, transfer } = require('@solana/spl-token');

const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const USDC_MINT = process.env.MINT ?? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'; // devnet USDC（Circle公式）
const DECIMALS = 6;
const FEE_PCT = 0.95;      // サービス手数料。デモ設定値＝UI側にも「デモ設定値」と明記して表示する
const TRAD_COST_PCT = 6.5; // 従来型の総コスト。業界横断モデル値＝UI側は必ず「業界平均」表記
const PORT = Number(process.env.PORT ?? 4173);

const connection = new Connection(RPC_URL, 'confirmed');
const loadKeypair = (name) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(MVP_KIT, 'keys', `${name}.json`), 'utf8'))));

// レートは open.er-api.com の1系統のみで計算する。
// （為替APIとCoinGeckoを混ぜると系統間誤差で経路乖離がマイナス表示になる＝8/1実測で判明した注意事項）
let rateCache = null;
async function getRate() {
  if (rateCache && Date.now() - rateCache.fetchedAt < 10 * 60 * 1000) return rateCache;
  const res = await fetch('https://open.er-api.com/v6/latest/JPY');
  if (!res.ok) throw new Error(`レートAPI HTTP ${res.status}`);
  const data = await res.json();
  if (!data.rates?.PHP || !data.rates?.USD) throw new Error('レートAPI: PHP/USDが取得できません');
  rateCache = {
    phpPerJpy: data.rates.PHP,
    usdPerJpy: data.rates.USD,
    baseTime: data.time_last_update_utc,
    feePct: FEE_PCT,
    tradCostPct: TRAD_COST_PCT,
    fetchedAt: Date.now(),
  };
  return rateCache;
}

async function handleSend(jpy) {
  if (!Number.isFinite(jpy) || jpy <= 0) return { error: '金額を入力してください。' };
  const rate = await getRate();
  // 手数料差引後の金額をUSDC（1 USDC = 1米ドルとして換算）でチェーンに乗せる
  const usdcAmount = Math.round(jpy * (1 - FEE_PCT / 100) * rate.usdPerJpy * 100) / 100;
  const raw = BigInt(Math.round(usdcAmount * 10 ** DECIMALS));
  const sender = loadKeypair('sender');
  const receiver = loadKeypair('receiver');
  const mint = new PublicKey(USDC_MINT);

  const senderAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey);
  const receiverAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, receiver.publicKey);

  const senderBal = Number((await getAccount(connection, senderAta.address)).amount) / 10 ** DECIMALS;
  if (senderBal < usdcAmount) {
    const maxJpy = Math.floor(senderBal / rate.usdPerJpy / (1 - FEE_PCT / 100));
    return {
      error: `devnetの残高が足りません（必要 ${usdcAmount} USDC・残高 ${senderBal} USDC）。` +
             `¥${maxJpy.toLocaleString('ja-JP')} 以下にするか、faucet.circle.com（Solana Devnet）で補充してください。`,
    };
  }

  const before = Number((await getAccount(connection, receiverAta.address)).amount) / 10 ** DECIMALS;
  const t0 = performance.now();
  const sig = await transfer(connection, sender, senderAta.address, receiverAta.address, sender, raw);
  const seconds = Number(((performance.now() - t0) / 1000).toFixed(2));
  const after = Number((await getAccount(connection, receiverAta.address)).amount) / 10 ** DECIMALS;

  return {
    signature: sig,
    seconds,
    usdcAmount,
    receiverBefore: before,
    receiverAfter: after,
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
  };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const PUBLIC = path.join(__dirname, 'public');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (url.pathname === '/api/rate') return json(200, await getRate());
    if (url.pathname === '/api/send' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { jpy } = JSON.parse(body || '{}');
      const result = await handleSend(Number(jpy));
      return json(result.error ? 400 : 200, result);
    }
    // 静的配信
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } catch (e) {
    json(500, { error: String(e.message ?? e) });
  }
});

server.listen(PORT, async () => {
  console.log(`デモUI: http://localhost:${PORT}（RPC: ${RPC_URL}）`);
  try {
    const sender = loadKeypair('sender');
    const ata = await getOrCreateAssociatedTokenAccount(connection, sender, new PublicKey(USDC_MINT), sender.publicKey);
    const bal = Number((await getAccount(connection, ata.address)).amount) / 10 ** DECIMALS;
    console.log(`sender USDC残高: ${bal}（送金可能の目安: ¥${Math.floor(bal / (await getRate()).usdPerJpy).toLocaleString('ja-JP')}）`);
  } catch (e) {
    console.log(`⚠️ 残高確認に失敗: ${e.message}`);
  }
});
