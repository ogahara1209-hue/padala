// ① ウォレット2つ（送り手=労働者 / 受け手=家族）を作り、devnetのSOLをもらう
// SOL = 手数料（ガス代）の支払いに使うコイン。devnetでは無料でもらえる
import { Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { connection, saveKeypair, loadKeypair, KEYS_DIR } from './lib.ts';

async function main() {
  // 既に鍵があれば再利用（何度実行しても壊れない）
  const names = ['sender', 'receiver'] as const;
  const wallets: Record<string, Keypair> = {};
  for (const name of names) {
    const file = path.join(KEYS_DIR, `${name}.json`);
    if (fs.existsSync(file)) {
      wallets[name] = loadKeypair(name);
      console.log(`${name}: 既存の鍵を再利用 → ${wallets[name].publicKey.toBase58()}`);
    } else {
      const kp = Keypair.generate();
      saveKeypair(name, kp);
      wallets[name] = kp;
      console.log(`${name}: 新規作成 → ${kp.publicKey.toBase58()}`);
    }
  }

  // devnetのSOLを無料でもらう（airdrop）。混雑時は429エラーになることがある
  for (const name of names) {
    const kp = wallets[name];
    const bal = await connection.getBalance(kp.publicKey);
    if (bal >= 0.5 * LAMPORTS_PER_SOL) {
      console.log(`${name}: 残高 ${bal / LAMPORTS_PER_SOL} SOL（十分・airdrop不要）`);
      continue;
    }
    try {
      const sig = await connection.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      const after = await connection.getBalance(kp.publicKey);
      console.log(`${name}: airdrop成功 → 残高 ${after / LAMPORTS_PER_SOL} SOL`);
    } catch (e: any) {
      console.error(`${name}: airdrop失敗（${e.message?.slice(0, 120)}）`);
      console.error(`  → 代替手段: https://faucet.solana.com でアドレス ${kp.publicKey.toBase58()} に手動で申請`);
    }
  }
}

main();
