// Padala — デュアルフォン・ステージビュー（8/2 凍結デザインの転記）
// 画面と状態遷移は demo-ui/public/stage.js と同じ。送金だけを Ethereum Sepolia に差し替え:
//   ブラウザの鍵で EIP-3009 に署名 → /api/relay がガスを払って提出（送り先と金額は署名に固定）。
// 状態遷移: input →(CTA)→ sending →(確定)→ done ／ Rキーで input に戻る（収録リテイク用）
const E = window.ethers;
const $ = (id) => document.getElementById(id);
const jp = (n, d = 0) => n.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d });

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const CHAIN_ID = 11155111;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';   // Circle USDC on Sepolia
const DECIMALS = 6;
const EXPLORER = 'https://sepolia.etherscan.io';
const DOMAIN = { name: 'USDC', version: '2', chainId: CHAIN_ID, verifyingContract: USDC };
const TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};
// 受け手＝家族の GCrypto（USDC・Ethereum）の住所の代わりの試験用アドレス（app.js の DEFAULT_BOOK と同じ）
const FAMILY = '0x09C4Fa99386bf791AD96658B1ebf456DDDe4b33B';

const provider = new E.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const usdc = new E.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);

const stage = $('stage');
const jpyInput = $('jpy');
const mirror = $('amt-mirror');
const preview = new URLSearchParams(location.search).get('preview'); // ?preview=input|sending|done（送金せず強制表示）

let rate = null;     // /api/rate の結果
let current = null;  // 直近の計算結果（送金時に使う）
let gen = 0;         // Rキーリセット後に届いた古い送金応答を無視するための世代カウンタ
let tick = null;     // ストップウォッチの interval
let wallet = null;   // 送り手の財布（鍵はこのブラウザだけが持つ・/wallet と共有）
let balance = null;  // USDC

// ---- 1920×1080 固定キャンバスの中央フィット ----
function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  document.documentElement.style.setProperty('--stage-scale', s);
}
addEventListener('resize', fit);
fit();

// ---- 状態遷移 ----
function setState(s) {
  stage.dataset.state = s;
  jpyInput.readOnly = s !== 'input';
  if (s === 'input') jpyInput.focus();
}

function showError(msg) {
  $('send-error').textContent = `⚠ ${msg}`;
  $('send-error').hidden = false;
}
function hideError() {
  $('send-error').hidden = true;
}

// ---- 金額入力（数字のみ・3桁カンマ・幅追従＝カスタムキャレットが末尾に付く） ----
function syncWidth() {
  mirror.textContent = jpyInput.value;
  jpyInput.style.width = `${Math.ceil(mirror.getBoundingClientRect().width)}px`;
}

// app.js と同じ計算。送る円を USDC に（0.01 単位で切り捨て）→ そこからサービス手数料を引いた残りが家族へ。
// 金額は 1e-6 USDC 単位の整数で持つ（サーバーの手数料チェックと同じ丸め）
function calc(jpy) {
  const total = Math.floor(jpy * rate.usdPerJpy * 100) * 10000;
  const fee = Math.ceil((total * rate.feeBps) / 10000);
  const main = total - fee;
  return {
    jpy, totalMicro: total, feeMicro: fee, mainMicro: main,
    usdc: main / 1e6, feeJpy: fee / 1e6 / rate.usdPerJpy, php: (main / 1e6) * rate.phpPerUsd,
  };
}

function render() {
  syncWidth();
  if (!rate) return;
  const jpy = Number((jpyInput.value || '').replace(/[^\d]/g, ''));
  if (!jpy) {
    current = null;
    $('fee').textContent = '−¥0';
    $('usdc').textContent = '0.00';
    $('php').textContent = '₱0';
    return;
  }
  current = calc(jpy);
  $('fee').textContent = `−¥${jp(current.feeJpy)}`;
  $('usdc').textContent = jp(current.usdc, 2);
  $('php').textContent = `₱${jp(current.php)}`;
  if (balance !== null && current.totalMicro / 1e6 > balance) showError(`残高（${jp(balance, 2)} USDC）を超えています`);
  else hideError();
}

async function loadRate() {
  const res = await fetch('/api/rate');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  rate = await res.json();
  $('fee-badge').textContent = `${rate.feeBps / 100}%・全額開示`;
  $('rate-val').textContent = `1円 = ${rate.phpPerJpy.toFixed(4)}ペソ`;
  const t = new Date(rate.baseTime).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  $('rate-sub').textContent = `仲値・${rate.source}・基準 ${t}`;
  render();
}

// ---- 財布（/wallet と同じ localStorage の鍵を使う。無ければ作って試験用 USDC を受け取る） ----
function loadOrCreateWallet() {
  try {
    const pk = JSON.parse(localStorage.getItem('padala.eth.pk') || 'null');
    if (pk) return new E.Wallet(pk);
  } catch {}
  const w = E.Wallet.createRandom();
  try { localStorage.setItem('padala.eth.pk', JSON.stringify(w.privateKey)); } catch {}
  return new E.Wallet(w.privateKey);
}
async function refreshBalance() {
  balance = Number(E.formatUnits(await usdc.balanceOf(wallet.address), DECIMALS));
  return balance;
}
async function ensureFunds() {
  if ((await refreshBalance()) > 0) return;
  const res = await fetch('/api/fund', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: wallet.address }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  await refreshBalance();
}

// ---- 送金: 家族への送金と手数料を、それぞれ EIP-3009 で署名 → サーバーが提出 ----
async function authorize(to, micro) {
  const message = {
    from: wallet.address, to, value: BigInt(micro),
    validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: E.hexlify(E.randomBytes(32)),
  };
  const signature = await wallet.signTypedData(DOMAIN, TYPES, message);
  return { to, value: message.value.toString(), validAfter: '0', validBefore: message.validBefore.toString(), nonce: message.nonce, signature };
}
async function sendUsdc(q) {
  const main = await authorize(FAMILY, q.mainMicro);
  const fee = await authorize(rate.feeTo, q.feeMicro);
  const res = await fetch('/api/relay', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: wallet.address, ...main, fee }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.hash;
}

// done 画面（左最下部＋右フォン）への反映
function fillDone(seconds, hash) {
  $('done-sec').textContent = seconds.toFixed(2);
  $('rx-php').textContent = `≈₱${jp(current.php)}`;
  $('rx-from').textContent = `mula sa Tokyo · ¥${jp(current.jpy)}`;
  $('rx-usdc').textContent = `${jp(current.usdc, 2)} USDC`;
  $('rx-sec').textContent = seconds.toFixed(2);
  $('rx-explorer').href = hash ? `${EXPLORER}/tx/${hash}` : '#';
}

function startClock() {
  const t0 = performance.now();
  $('clock').textContent = '0.00';
  tick = setInterval(() => {
    $('clock').textContent = ((performance.now() - t0) / 1000).toFixed(2);
  }, 50);
  return t0;
}

function friendlyError(e) {
  const m = String(e?.message ?? e);
  if (/Insufficient balance/i.test(m)) return '残高が足りません';
  if (/expired/i.test(m)) return '時間が経ちすぎました。もう一度送ってください';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'ネットワークにつながりません。もう一度お試しください';
  return `送れませんでした: ${m}`;
}

async function send() {
  if (!current || !wallet || stage.dataset.state !== 'input') return;
  if (balance !== null && current.totalMicro / 1e6 > balance) return;
  hideError();
  const myGen = ++gen;
  setState('sending');
  const t0 = startClock();
  try {
    const hash = await sendUsdc(current);
    if (myGen !== gen) return; // Rキーで既にリセット済み → 破棄
    clearInterval(tick);
    const seconds = (performance.now() - t0) / 1000;
    $('clock').textContent = seconds.toFixed(2); // カウンタを確定時点にスナップ
    fillDone(seconds, hash);
    refreshBalance().catch(() => {});
    setTimeout(() => { if (myGen === gen) setState('done'); }, 1600);
  } catch (e) {
    if (myGen !== gen) return;
    clearInterval(tick);
    setState('input');
    showError(friendlyError(e));
  }
}

// ---- イベント ----
jpyInput.addEventListener('input', () => {
  const digits = jpyInput.value.replace(/[^\d]/g, '');
  jpyInput.value = digits ? Number(digits).toLocaleString('ja-JP') : '';
  render();
});
$('send-btn').addEventListener('click', send);

// 金額行のどこをクリックしても入力欄へフォーカス
document.querySelector('.amt-row').addEventListener('click', () => {
  if (stage.dataset.state !== 'input') return;
  jpyInput.focus();
});
// カスタムキャレットは常に末尾表示のため、実キャレットも常に末尾へ揃える
jpyInput.addEventListener('focus', () => {
  requestAnimationFrame(() => jpyInput.setSelectionRange(jpyInput.value.length, jpyInput.value.length));
});

// Rキー: input 状態へ戻す（収録リテイク用・画面上にボタンは出さない）
addEventListener('keydown', (e) => {
  if (e.key !== 'r' && e.key !== 'R') return;
  if (stage.dataset.state === 'input') return; // 入力中の「r」は無視
  gen++; // 飛行中の送金応答を無効化（表示のみ。チェーン上の送金自体は取り消せない）
  if (tick) clearInterval(tick);
  hideError();
  setState('input');
  render();
});

// ---- 起動 ----
jpyInput.focus(); // 表示直後にフォーカス（レート取得を待たない）
(async () => {
  try {
    await loadRate();
  } catch (e) {
    showError(`レートを取得できません（${e.message}）。再読み込みしてください`);
  }
  if (preview) {
    console.log(`[preview] state=${preview} — プレビュー表示（実送金なし・検証用）`);
    if (preview === 'sending') { setState('sending'); startClock(); }
    else if (preview === 'done' && current) { fillDone(18.42, null); setState('done'); }
    else setState('input');
  } else {
    setState('input');
    try {
      wallet = loadOrCreateWallet();
      await ensureFunds();
      render();
    } catch (e) {
      showError(`財布の準備ができません（${e.message}）`);
    }
  }
  if (document.fonts?.ready) document.fonts.ready.then(syncWidth);
})();
