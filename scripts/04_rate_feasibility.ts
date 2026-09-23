// ④ レート表示の「目処」検証（UIなし・データ層のみ）
// 問い: 「本当のレートが最初に見える」に必要なデータを、無料APIからリアルタイムに取れるか？
// 出力はコンソールのみ。UIデザインは別工程（frontend-designスキルで設計してから）
//
// データ源（いずれも無料・キー不要）:
//   - 為替ミッドレート JPY→PHP: open.er-api.com（出典表示して使う）
//   - USDC/JPY・USDC/PHP: CoinGecko simple price API

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const sendJpy = 30000; // 例: 3万円を送る

  // 1) 為替ミッドレート（市場の「本当のレート」の基準）
  const fx = await fetchJson('https://open.er-api.com/v6/latest/JPY');
  const jpyToPhp = fx.rates?.PHP;
  const fxTime = fx.time_last_update_utc;

  // 2) USDC建ての経路レート（円→USDC→ペソ）
  const cg = await fetchJson(
    'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=jpy,php'
  );
  const usdcJpy = cg['usd-coin']?.jpy;
  const usdcPhp = cg['usd-coin']?.php;

  if (!jpyToPhp || !usdcJpy || !usdcPhp) throw new Error('レート取得に失敗（レスポンス構造を確認）');

  // 3) 計算: 円 → USDC → ペソ
  const usdcAmount = sendJpy / usdcJpy;
  const phpViaUsdc = usdcAmount * usdcPhp;
  const phpAtMid = sendJpy * jpyToPhp;
  const routeCostPct = ((phpAtMid - phpViaUsdc) / phpAtMid) * 100;

  console.log('--- レートデータ取得検証（リアルタイム） ---');
  console.log(`為替ミッドレート: 1 JPY = ${jpyToPhp} PHP（${fxTime}・open.er-api.com）`);
  console.log(`USDC/JPY: ¥${usdcJpy} ／ USDC/PHP: ₱${usdcPhp}（CoinGecko）`);
  console.log('');
  console.log(`送金額: ¥${sendJpy.toLocaleString()}`);
  console.log(`  → USDC換算: ${usdcAmount.toFixed(2)} USDC`);
  console.log(`  → ペソ受取（USDC経由・市場レートベース）: ₱${phpViaUsdc.toFixed(2)}`);
  console.log(`  ミッドレートなら: ₱${phpAtMid.toFixed(2)}`);
  console.log(`  経路の実勢乖離: ${routeCostPct.toFixed(3)}%`);
  console.log('');
  console.log('⚠️ 上記は市場レートのみ（fiat両端の業者手数料・スプレッドは含まない）');
  console.log('⚠️ 「従来型6〜7%」との比較をUIに載せる時は「業界平均で」を必ず付ける（設計図§3）');
}

main();
