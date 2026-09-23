// ⑤ 還流: 受け手→送り手へトークンを全額戻す（リハで残高を減らさないための巻き戻し）
// 使い方:
//   node scripts/05_sweep_back.ts          → devnet USDC を全額戻す
//   node scripts/05_sweep_back.ts <mint>   → 指定mintで戻す
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, transfer, getAccount, getMint } from '@solana/spl-token';
import { connection, loadKeypair, explorerTx, RPC_URL } from './lib.ts';

// devnet USDC（Circle配布）。03と同じ流儀で引数1により上書き可
const DEFAULT_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

// 受け手が手数料を払えるかの目安。これを下回れば送り手からSOLを補給する
const MIN_FEE_SOL = 0.002;
const TOPUP_SOL = 0.01;

async function main() {
  // mainnet誤爆の防止（還流は残高を戻す操作だが、本番資産には一切触れない）
  if (!RPC_URL.includes('devnet') && !RPC_URL.includes('127.0.0.1') && !RPC_URL.includes('localhost')) {
    throw new Error(`devnet以外のRPCでは実行できない（RPC_URL=${RPC_URL}）`);
  }

  const sender = loadKeypair('sender');
  const receiver = loadKeypair('receiver');

  const mint = new PublicKey(process.argv[2] ?? DEFAULT_MINT);
  const decimals = (await getMint(connection, mint)).decimals;
  const ui = (raw: bigint) => Number(raw) / 10 ** decimals;

  console.log(`mint: ${mint.toBase58()}（小数${decimals}桁）`);
  console.log(`送り手(sender):  ${sender.publicKey.toBase58()}`);
  console.log(`受け手(receiver): ${receiver.publicKey.toBase58()}`);

  // 両者のトークン口座（ATA）。作成が必要な場合の手数料は送り手が払う
  const receiverAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, receiver.publicKey);
  const senderAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey);

  const receiverBefore = (await getAccount(connection, receiverAta.address)).amount;
  const senderBefore = (await getAccount(connection, senderAta.address)).amount;
  const receiverSolBefore = await connection.getBalance(receiver.publicKey);
  const senderSolBefore = await connection.getBalance(sender.publicKey);

  console.log('--- 実行前 ---');
  console.log(`送り手: ${ui(senderBefore)} トークン / ${senderSolBefore / LAMPORTS_PER_SOL} SOL`);
  console.log(`受け手: ${ui(receiverBefore)} トークン / ${receiverSolBefore / LAMPORTS_PER_SOL} SOL`);

  if (receiverBefore === 0n) {
    console.log('還流対象なし（受け手の残高が0）');
    return;
  }

  // 受け手は自分で署名する＝自分でSOL手数料を払う。足りなければ送り手が先に補給する
  if (receiverSolBefore < MIN_FEE_SOL * LAMPORTS_PER_SOL) {
    console.log(`受け手のSOLが不足（${receiverSolBefore / LAMPORTS_PER_SOL} SOL < ${MIN_FEE_SOL}）→ 送り手から ${TOPUP_SOL} SOL を補給する`);
    const topupTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: receiver.publicKey,
        lamports: Math.round(TOPUP_SOL * LAMPORTS_PER_SOL),
      })
    );
    const topupSig = await sendAndConfirmTransaction(connection, topupTx, [sender], { commitment: 'confirmed' });
    console.log(`補給完了: ${explorerTx(topupSig)}`);
  }

  // 還流本体（署名者=受け手）
  const sig = await transfer(connection, receiver, receiverAta.address, senderAta.address, receiver, receiverBefore);

  const receiverAfter = (await getAccount(connection, receiverAta.address)).amount;
  const senderAfter = (await getAccount(connection, senderAta.address)).amount;
  const receiverSolAfter = await connection.getBalance(receiver.publicKey);
  const senderSolAfter = await connection.getBalance(sender.publicKey);

  console.log('--- 実行後 ---');
  console.log(`送り手: ${ui(senderAfter)} トークン / ${senderSolAfter / LAMPORTS_PER_SOL} SOL`);
  console.log(`受け手: ${ui(receiverAfter)} トークン / ${receiverSolAfter / LAMPORTS_PER_SOL} SOL`);
  console.log(`✅ 還流した額: ${ui(receiverBefore)} トークン`);
  console.log(`トランザクション: ${sig}`);
  console.log(`ブラウザで確認: ${explorerTx(sig)}`);
}

main().catch((e) => {
  console.error(`❌ 失敗: ${e?.message ?? e}`);
  process.exit(1);
});
