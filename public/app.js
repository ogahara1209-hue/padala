// 画面遷移: Send → Status → Receive。計算はサーバーが返す1系統のレートのみで行う。
const $ = (id) => document.getElementById(id);
const jp = (n, d = 0) => n.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d });

let rate = null;      // /api/rate の結果
let current = null;   // 直近の計算結果（送金時に使う）

function calc(jpy) {
  const feeJpy = jpy * (rate.feePct / 100);
  const receivePhp = (jpy - feeJpy) * rate.phpPerJpy;
  const tradPhp = jpy * rate.phpPerJpy * (1 - rate.tradCostPct / 100);
  const usdc = (jpy - feeJpy) * rate.usdPerJpy;
  return { jpy, feeJpy, receivePhp, tradPhp, diffPhp: receivePhp - tradPhp, usdc };
}

function render() {
  const jpy = Number(($('jpy').value || '').replace(/[^\d]/g, ''));
  if (!rate) return;
  if (!jpy) {
    current = null;
    $('fee').textContent = '–';
    $('usdc').textContent = '–';
    $('php').textContent = '0';
    $('trad').textContent = '₱0';
    $('diff').textContent = '+₱0';
    $('send-btn').disabled = true;
    return;
  }
  current = calc(jpy);
  $('fee').textContent = `−¥${jp(current.feeJpy, 0)}`;
  $('usdc').textContent = jp(current.usdc, 2);
  $('php').textContent = jp(current.receivePhp, 0);
  $('trad').textContent = `₱${jp(current.tradPhp, 0)}`;
  $('diff').textContent = `+₱${jp(current.diffPhp, 0)}`;
  $('send-btn').disabled = false;
}

async function loadRate() {
  try {
    const res = await fetch('/api/rate');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    rate = await res.json();
    $('mid').textContent = rate.phpPerJpy.toFixed(4);
    $('rate-time').textContent = new Date(rate.baseTime).toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    render();
  } catch (e) {
    $('rate-time').textContent = '取得できませんでした';
    $('send-error').textContent = `レートを取得できません（${e.message}）。ネットワークを確認して再読み込みしてください。`;
    $('send-error').hidden = false;
  }
}

function show(screen) {
  for (const id of ['screen-send', 'screen-status', 'screen-receive']) $(id).hidden = id !== screen;
}

async function send() {
  if (!current) return;
  $('send-error').hidden = true;
  show('screen-status');
  $('status-php').textContent = jp(current.receivePhp, 0);
  $('st-1').className = 'step done';
  $('st-2').className = 'step on';
  $('st-3').className = 'step';
  $('clock-caption').textContent = 'ブロックチェーンで確定中…';
  $('clock-caption').className = 'clock-caption';

  // ストップウォッチは実経過を表示し、確定後にサーバー実測値（正）へスナップする
  const t0 = performance.now();
  const tick = setInterval(() => {
    $('clock').textContent = ((performance.now() - t0) / 1000).toFixed(2);
  }, 50);

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jpy: current.jpy }),
    });
    const data = await res.json();
    clearInterval(tick);
    if (data.error) throw new Error(data.error);

    $('clock').textContent = data.seconds.toFixed(2);
    $('clock-caption').textContent = '確定しました';
    $('clock-caption').className = 'clock-caption ok';
    $('st-2').className = 'step done';
    $('st-3').className = 'step done';

    $('rx-php').textContent = jp(current.receivePhp, 0);
    $('rx-sec').textContent = data.seconds.toFixed(2);
    $('rx-explorer').href = data.explorer;
    setTimeout(() => show('screen-receive'), 1600);
  } catch (e) {
    clearInterval(tick);
    show('screen-send');
    $('send-error').textContent = e.message;
    $('send-error').hidden = false;
  }
}

$('jpy').addEventListener('input', () => {
  const digits = $('jpy').value.replace(/[^\d]/g, '');
  $('jpy').value = digits ? Number(digits).toLocaleString('ja-JP') : '';
  render();
});
$('send-btn').addEventListener('click', send);
$('again').addEventListener('click', () => { show('screen-send'); render(); });
for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => { $('jpy').value = Number(chip.dataset.jpy).toLocaleString('ja-JP'); render(); });
}
loadRate();
