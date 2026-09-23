// デュアルフォン・ステージビュー
// ロジックは v1 (public/app.js) で実証済みのフローを踏襲。計算はサーバーが返す1系統のレートのみで行う。
// 状態遷移: input →(CTA)→ sending →(確定)→ done ／ Rキーで input に戻る（収録リテイク用）
const $ = (id) => document.getElementById(id);
const jp = (n, d = 0) => n.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d });

const stage = $('stage');
const jpyInput = $('jpy');
const mirror = $('amt-mirror');
const preview = new URLSearchParams(location.search).get('preview'); // ?preview=input|sending|done（送金せず強制表示）

let rate = null;     // /api/rate の結果
let current = null;  // 直近の計算結果（送金時に使う）
let gen = 0;         // Rキーリセット後に届いた古い送金応答を無視するための世代カウンタ
let tick = null;     // ストップウォッチの interval

// ---- 1920×1080 固定キャンバスの中央フィット（§2 スケーリング） ----
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
  $('send-error').textContent = `⚠ ${msg}`; // [逸脱#3] 行頭に「⚠ 」
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

function calc(jpy) {
  const feeJpy = jpy * (rate.feePct / 100);
  const receivePhp = (jpy - feeJpy) * rate.phpPerJpy;
  const tradPhp = jpy * rate.phpPerJpy * (1 - rate.tradCostPct / 100);
  const usdc = (jpy - feeJpy) * rate.usdPerJpy;
  return { jpy, feeJpy, receivePhp, tradPhp, diffPhp: receivePhp - tradPhp, usdc };
}

// 明細の再計算・反映（入力のたび呼ぶ）
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
  $('php').textContent = `₱${jp(current.receivePhp)}`;
}

async function loadRate() {
  const res = await fetch('/api/rate');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  rate = await res.json();
  $('fee-badge').textContent = `${rate.feePct}%・全額開示`;
  $('rate-val').textContent = `1円 = ${rate.phpPerJpy.toFixed(4)}ペソ`;
  const t = new Date(rate.baseTime).toLocaleString('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  $('rate-sub').textContent = `仲値・open.er-api.com・基準 ${t}`;
  render();
}

// done 画面（左最下部＋右フォン）への反映。表示の正はサーバー実測 seconds（§2）
function fillDone(seconds, explorerUrl) {
  $('done-sec').textContent = seconds.toFixed(2);
  $('rx-php').textContent = `₱${jp(current.receivePhp)}`;
  $('rx-from').textContent = `mula sa Tokyo · ¥${jp(current.jpy)}`;
  $('rx-diff').textContent = `+₱${jp(current.diffPhp)}`;
  $('rx-sec').textContent = seconds.toFixed(2);
  $('rx-explorer').href = explorerUrl;
}

function startClock() {
  const t0 = performance.now();
  $('clock').textContent = '0.00';
  tick = setInterval(() => {
    $('clock').textContent = ((performance.now() - t0) / 1000).toFixed(2);
  }, 50);
}

async function send() {
  if (!current || stage.dataset.state !== 'input') return;
  hideError();
  const myGen = ++gen;
  setState('sending');
  startClock();
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jpy: current.jpy }),
    });
    const data = await res.json();
    if (myGen !== gen) return; // Rキーで既にリセット済み → 破棄
    clearInterval(tick);
    if (data.error) throw new Error(data.error);
    $('clock').textContent = data.seconds.toFixed(2); // カウンタをサーバー実測値にスナップ
    fillDone(data.seconds, data.explorer);
    // [逸脱#6] スナップ表示を1.6秒保持してから done へ（v1と同じ）
    setTimeout(() => { if (myGen === gen) setState('done'); }, 1600);
  } catch (e) {
    if (myGen !== gen) return;
    clearInterval(tick);
    setState('input');
    showError(e.message);
  }
}

// ---- イベント ----
jpyInput.addEventListener('input', () => {
  const digits = jpyInput.value.replace(/[^\d]/g, '');
  jpyInput.value = digits ? Number(digits).toLocaleString('ja-JP') : '';
  hideError();
  render();
});
$('send-btn').addEventListener('click', send);

// [逸脱#7]② 金額行のどこをクリックしても入力欄へフォーカス
document.querySelector('.amt-row').addEventListener('click', () => {
  if (stage.dataset.state !== 'input') return;
  jpyInput.focus();
});
// カスタムキャレットは常に末尾表示のため、実キャレットも常に末尾へ揃える（表示と入力位置の乖離防止）
jpyInput.addEventListener('focus', () => {
  requestAnimationFrame(() => jpyInput.setSelectionRange(jpyInput.value.length, jpyInput.value.length));
});

// Rキー: input 状態へ戻す（収録リテイク用・画面上にボタンは出さない）
addEventListener('keydown', (e) => {
  if (e.key !== 'r' && e.key !== 'R') return;
  gen++; // 飛行中の送金応答を無効化（表示のみ。チェーン上の送金自体は取り消せない）
  if (tick) clearInterval(tick);
  hideError();
  setState('input');
  render();
});

// ---- 起動 ----
jpyInput.focus(); // [逸脱#7]① 表示直後にフォーカス（レート取得を待たない。HTML側autofocusの保険）
(async () => {
  try {
    await loadRate();
  } catch (e) {
    showError(`レートを取得できません（${e.message}）。ネットワークを確認して再読み込みしてください。`);
  }
  if (preview) {
    console.log(`[preview] state=${preview} — プレビュー表示（実送金なし・検証用。§6-1）`);
    if (preview === 'sending') {
      setState('sending');
      startClock(); // 実経過秒（送金はしていない）
    } else if (preview === 'done' && current) {
      fillDone(0.79, '#'); // 秒数のみ 0.79 固定（§6-1）・実送金がないためリンク先はダミー
      setState('done');
    } else {
      setState('input');
    }
  } else {
    setState('input');
  }
  // Webフォント読込完了後に入力幅を再計測（フォールバック字形との幅差を吸収）
  if (document.fonts?.ready) document.fonts.ready.then(syncWidth);
})();
