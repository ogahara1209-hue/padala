// ③ 送金本体: 送り手→受け手へ SPLトークン（USDC同規格）を1本送り、着金までの秒数を測る
// 使い方:
//   node scripts/03_send.ts            → keys/test_mint.json のテスト用トークンで 5.0 を送る
//   node scripts/03_send.ts <mint> <額> → 指定mint（例: devnet USDC）で送る
import { PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, transfer, getAccount } from '@solana/spl-token';
import { connection, loadKeypair, loadJson, explorerTx } from './lib.ts';

async function main() {
  const sender = loadKeypair('sender');
  const receiver = loadKeypair('receiver');

  const mintArg = process.argv[2];
  const amountArg = Number(process.argv[3] ?? '5');
  const mintInfo = mintArg ? { mint: mintArg, decimals: 6 } : loadJson('test_mint');
  const mint = new PublicKey(mintInfo.mint);
  const rawAmount = BigInt(Math.round(amountArg * 10 ** mintInfo.decimals));

  console.log(`mint: ${mint.toBase58()}`);
  console.log(`送金額: ${amountArg}（raw=${rawAmount}）`);

  // 両者のトークン口座（ATA）を準備（受け手の分の作成手数料は送り手が払う設計）
  const senderAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey);
  const receiverAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, receiver.publicKey);

  const before = (await getAccount(connection, receiverAta.address)).amount;

  // ここが送金の瞬間 → 確定（confirmed）までの時間を計測
  const t0 = performance.now();
  const sig = await transfer(connection, sender, senderAta.address, receiverAta.address, sender, rawAmount);
  const elapsedSec = ((performance.now() - t0) / 1000).toFixed(2);

  const after = (await getAccount(connection, receiverAta.address)).amount;

  console.log('--- 結果 ---');
  console.log(`✅ 送金確定までの時間: ${elapsedSec} 秒`);
  console.log(`受け手の残高: ${Number(before) / 10 ** mintInfo.decimals} → ${Number(after) / 10 ** mintInfo.decimals}`);
  console.log(`トランザクション: ${sig}`);
  console.log(`ブラウザで確認: ${explorerTx(sig)}`);
}

main();
