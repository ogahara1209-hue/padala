// ② テスト用トークンを自分で発行する（コード検証用）
// USDCと同じ「SPLトークン」規格・同じ小数6桁。送金コードの検証はこれで完結する。
// ※本物のdevnet USDC（Circle配布）を使う場合はREADMEの手順で入手し、03の引数にmintを渡す
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { connection, loadKeypair, saveJson } from './lib.ts';

async function main() {
  const sender = loadKeypair('sender');

  // トークンの「原盤」(mint) を作る。decimals=6 はUSDCと同じ
  console.log('テスト用トークンを発行中...');
  const mint = await createMint(connection, sender, sender.publicKey, null, 6);
  console.log(`mint作成: ${mint.toBase58()}`);

  // 送り手のトークン口座（ATA=そのトークン専用の財布ポケット）を作る
  const senderAta = await getOrCreateAssociatedTokenAccount(connection, sender, mint, sender.publicKey);

  // 100トークン（=100.000000）を送り手に発行
  await mintTo(connection, sender, mint, senderAta.address, sender, 100_000_000n);
  console.log(`送り手に 100 トークンを発行完了`);

  saveJson('test_mint', { mint: mint.toBase58(), decimals: 6, note: '自己発行のテスト用SPLトークン（USDC同規格）' });
  console.log('mintアドレスを keys/test_mint.json に保存した');
}

main();
