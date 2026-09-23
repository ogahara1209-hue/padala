// 共通処理: 接続先・鍵の保存/読込
import { Connection, Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

// devnet = 練習用ネットワーク（流れるのはニセ金・失敗しても損失ゼロ）
export const RPC_URL = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
export const connection = new Connection(RPC_URL, 'confirmed');

export const KEYS_DIR = path.join(import.meta.dirname, '..', 'keys');

export function saveKeypair(name: string, kp: Keypair): void {
  fs.writeFileSync(path.join(KEYS_DIR, `${name}.json`), JSON.stringify(Array.from(kp.secretKey)));
}

export function loadKeypair(name: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `${name}.json`), 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function loadJson(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `${name}.json`), 'utf8'));
}

export function saveJson(name: string, data: any): void {
  fs.writeFileSync(path.join(KEYS_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

export function explorerTx(sig: string): string {
  // ローカルバリデータ使用時はExplorerに「custom cluster」として繋ぐ
  if (RPC_URL.includes('127.0.0.1') || RPC_URL.includes('localhost')) {
    return `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
  }
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
