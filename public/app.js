// Padala — self-custody remittance wallet (Solana devnet)
// Everything that touches money happens here, in the browser, signed by a key that only this device holds.
// The server only serves files, quotes a rate, and (devnet only) hands out test money.
const W = window.solanaWeb3;
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = W;

const RPC = 'https://api.devnet.solana.com';
const USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'); // Circle devnet USDC
const DECIMALS = 6;
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const DEFAULT_BOOK = [{ name: 'Maria（マニラ）', address: 'nCn2gjJ6adzYTpyffweaS4s1tb9G39CpQV8EtDZYt4p' }];

const conn = new Connection(RPC, 'confirmed');
const $ = (id) => document.getElementById(id);
const jp = (n, d = 0) => Number(n).toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d });
const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const store = {
  get: (k, f) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let wallet = null;   // Keypair
let rate = null;     // /api/rate
let quote = null;    // current calculation
let recipient = null;

// ───────── wallet (self-custody) ─────────
function loadWallet() {
  const secret = store.get('padala.secret', null);
  if (!secret) return null;
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
function createWallet() {
  const kp = Keypair.generate();
  store.set('padala.secret', Array.from(kp.secretKey));
  return kp;
}
function ata(owner, mint = USDC_MINT) {
  return PublicKey.findProgramAddressSync([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
}
async function usdcBalance(owner) {
  try { const r = await conn.getTokenAccountBalance(ata(owner)); return Number(r.value.amount) / 10 ** DECIMALS; }
  catch { return 0; }
}
async function refreshBalances() {
  const [usdc, lamports] = await Promise.all([usdcBalance(wallet.publicKey), conn.getBalance(wallet.publicKey)]);
  $('bal-usdc').textContent = jp(usdc, 2);
  $('bal-jpy').textContent = rate ? jp(usdc / rate.usdPerJpy, 0) : '–';
  $('bal-sol').textContent = (lamports / 1e9).toFixed(4);
  return { usdc, sol: lamports / 1e9 };
}

// ───────── SPL token instructions (hand-encoded; no bundler needed) ─────────
function ixCreateAtaIdempotent(payer, owner, mint = USDC_MINT) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: new Uint8Array([1]), // 1 = CreateIdempotent
  });
}
function ixTransferChecked(owner, to, amountRaw, mint = USDC_MINT) {
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked
  let v = BigInt(amountRaw);
  for (let i = 0; i < 8; i++) { data[1 + i] = Number(v & 0xffn); v >>= 8n; }
  data[9] = DECIMALS;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: ata(to, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}
async function sendUsdc(toAddress, usdcAmount) {
  const to = new PublicKey(toAddress);
  const raw = BigInt(Math.round(usdcAmount * 10 ** DECIMALS));
  const tx = new Transaction().add(ixCreateAtaIdempotent(wallet.publicKey, to), ixTransferChecked(wallet.publicKey, to, raw));
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  tx.sign(wallet);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}

// ───────── rate & quote ─────────
async function loadRate() {
  const res = await fetch('/api/rate');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  rate = await res.json();
  $('q-mid').textContent = rate.phpPerJpy.toFixed(4);
  $('q-src').textContent = rate.source;
  $('q-time').textContent = new Date(rate.baseTime).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function calc(jpy) {
  const usdc = Math.floor(jpy * rate.usdPerJpy * 100) / 100;           // what goes on-chain
  const php = usdc * rate.phpPerUsd;                                     // what the family sees at mid-rate
  return { jpy, usdc, php, phpPerJpy: rate.phpPerJpy };
}
function renderQuote() {
  const jpy = Number(($('jpy').value || '').replace(/[^\d]/g, ''));
  if (!rate || !jpy || !recipient) {
    quote = null;
    $('q-usdc').textContent = '–'; $('q-php').textContent = '0';
    $('review-btn').disabled = true;
    return;
  }
  quote = calc(jpy);
  $('q-usdc').textContent = jp(quote.usdc, 2);
  $('q-php').textContent = jp(quote.php, 0);
  $('review-btn').disabled = false;
}

// ───────── address book ─────────
function book() { return store.get('padala.book', DEFAULT_BOOK); }
function renderBook() {
  const el = $('book');
  el.innerHTML = '';
  for (const p of book()) {
    const b = document.createElement('button');
    b.className = 'person' + (recipient && recipient.address === p.address ? ' on' : '');
    b.innerHTML = `<span class="p-name">${p.name}</span><span class="p-addr mono">${short(p.address)}</span>`;
    b.addEventListener('click', () => { recipient = p; $('q-to').textContent = `${p.name} · ${short(p.address)}`; renderBook(); renderQuote(); });
    el.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'person add';
  add.textContent = '＋ 追加';
  add.addEventListener('click', () => openSheet('sheet-add'));
  el.appendChild(add);
}

// ───────── history & receipt ─────────
function history() { return store.get('padala.history', []); }
function addHistory(entry) { const h = history(); h.unshift(entry); store.set('padala.history', h); return h; }
function receiptNo(d, n) { const p = (x) => String(x).padStart(2, '0'); return `PDL-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(n).padStart(3, '0')}`; }
function showReceipt(e) {
  $('r-no').textContent = e.no;
  $('r-time').textContent = new Date(e.time).toLocaleString('ja-JP');
  $('r-from').textContent = short(e.from);
  $('r-to').textContent = `${e.toName} · ${short(e.to)}`;
  $('r-jpy').textContent = jp(e.jpy, 0);
  $('r-usdc').textContent = jp(e.usdc, 2);
  $('r-rate').textContent = e.phpPerJpy.toFixed(4);
  $('r-php').textContent = jp(e.php, 0);
  $('r-sec').textContent = e.seconds.toFixed(2);
  $('r-sig').textContent = e.sig;
  $('r-explorer').href = `https://explorer.solana.com/tx/${e.sig}?cluster=devnet`;
  $('family-link').onclick = async () => {
    const u = new URL('/r', location.origin);
    u.searchParams.set('sig', e.sig); u.searchParams.set('php', Math.round(e.php)); u.searchParams.set('usdc', e.usdc);
    u.searchParams.set('name', e.toName); u.searchParams.set('from', e.fromName || 'Kanji');
    await navigator.clipboard.writeText(u.toString());
    $('family-link').textContent = 'コピーしました';
    setTimeout(() => { $('family-link').textContent = '家族に知らせるリンクをコピー'; }, 1800);
  };
  show('screen-receipt');
}
function renderHistory() {
  const h = history();
  const ul = $('hist');
  ul.innerHTML = '';
  const now = new Date();
  let month = 0;
  for (const e of h) {
    const d = new Date(e.time);
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) month += e.jpy;
    const li = document.createElement('li');
    li.innerHTML = `<button class="hist-row"><span class="h-l"><span class="h-name">${e.toName}</span><span class="h-date">${d.toLocaleDateString('ja-JP')}</span></span><span class="h-r"><span class="num">₱${jp(e.php, 0)}</span><span class="h-jpy">¥${jp(e.jpy, 0)}</span></span></button>`;
    li.querySelector('button').addEventListener('click', () => showReceipt(e));
    ul.appendChild(li);
  }
  $('h-month').textContent = jp(month, 0);
  $('h-count').textContent = h.length;
  $('hist-empty').hidden = h.length > 0;
}

// ───────── flow ─────────
const SCREENS = ['screen-onboard', 'screen-home', 'screen-send', 'screen-confirm', 'screen-status', 'screen-receipt', 'screen-history'];
function show(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  const tabbed = { 'screen-send': 0, 'screen-history': 1, 'screen-home': 2 };
  $('tabs').hidden = !(id in tabbed) ;
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('on', tabbed[id] === i));
  $('app').scrollTop = 0;
}
function openSheet(id) { $(id).hidden = false; }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; }); }

async function doSend() {
  const q = quote, to = recipient;
  show('screen-status');
  $('status-php').textContent = jp(q.php, 0);
  $('status-to').textContent = to.name;
  $('st-1').className = 'step on'; $('st-2').className = 'step'; $('st-3').className = 'step';
  $('clock-caption').textContent = 'あなたの端末で署名しています…';
  $('clock-caption').className = 'clock-caption';
  const t0 = performance.now();
  const tick = setInterval(() => { $('clock').textContent = ((performance.now() - t0) / 1000).toFixed(2); }, 50);
  try {
    $('st-1').className = 'step done'; $('st-2').className = 'step on';
    $('clock-caption').textContent = 'ブロックチェーンで確定中…';
    const sig = await sendUsdc(to.address, q.usdc);
    const seconds = (performance.now() - t0) / 1000;
    clearInterval(tick);
    $('clock').textContent = seconds.toFixed(2);
    $('clock-caption').textContent = '確定しました'; $('clock-caption').className = 'clock-caption ok';
    $('st-2').className = 'step done'; $('st-3').className = 'step done';
    const h = history();
    const entry = {
      no: receiptNo(new Date(), h.length + 1), time: Date.now(), from: wallet.publicKey.toBase58(), fromName: 'Kanji',
      to: to.address, toName: to.name, jpy: q.jpy, usdc: q.usdc, php: q.php, phpPerJpy: q.phpPerJpy, sig, seconds,
    };
    addHistory(entry);
    renderHistory();
    refreshBalances();
    setTimeout(() => showReceipt(entry), 1400);
  } catch (e) {
    clearInterval(tick);
    show('screen-send');
    $('send-error').textContent = friendlyError(e);
    $('send-error').hidden = false;
  }
}
function friendlyError(e) {
  const m = String(e?.message ?? e);
  if (/insufficient funds|0x1\b/.test(m)) return '残高が足りません。「財布」から入金してください。';
  if (/insufficient lamports|Attempt to debit/.test(m)) return '手数料用の SOL が足りません。「財布」から入金してください。';
  if (/blockhash|expired/i.test(m)) return 'ネットワークが混み合っています。もう一度お試しください。';
  return `送れませんでした: ${m}`;
}

// ───────── wire up ─────────
$('create-wallet').addEventListener('click', async () => {
  wallet = createWallet();
  await boot();
  show('screen-home');
  openSheet('sheet-topup');
});
$('copy-addr').addEventListener('click', async () => {
  await navigator.clipboard.writeText(wallet.publicKey.toBase58());
  $('copy-addr').textContent = 'コピーしました'; setTimeout(() => { $('copy-addr').textContent = 'コピー'; }, 1500);
});
$('show-topup').addEventListener('click', () => openSheet('sheet-topup'));
$('fund-btn').addEventListener('click', async () => {
  $('fund-btn').disabled = true; $('fund-btn').textContent = '受け取っています…'; $('fund-error').hidden = true;
  try {
    const res = await fetch('/api/fund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: wallet.publicKey.toBase58() }) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await refreshBalances();
    closeSheets();
  } catch (e) {
    $('fund-error').textContent = e.message; $('fund-error').hidden = false;
  } finally { $('fund-btn').disabled = false; $('fund-btn').textContent = '試験用の 20 USDC を受け取る'; }
});
$('jpy').addEventListener('input', () => {
  const digits = $('jpy').value.replace(/[^\d]/g, '');
  $('jpy').value = digits ? Number(digits).toLocaleString('ja-JP') : '';
  renderQuote();
});
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { $('jpy').value = Number(c.dataset.jpy).toLocaleString('ja-JP'); renderQuote(); }));
$('review-btn').addEventListener('click', () => {
  $('c-name').textContent = recipient.name; $('c-addr').textContent = recipient.address;
  $('c-jpy').textContent = jp(quote.jpy, 0); $('c-php').textContent = jp(quote.php, 0);
  show('screen-confirm');
});
$('back-btn').addEventListener('click', () => show('screen-send'));
$('send-btn').addEventListener('click', doSend);
$('print-btn').addEventListener('click', () => window.print());
$('to-history').addEventListener('click', () => { renderHistory(); show('screen-history'); });
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { if (t.dataset.screen === 'screen-history') renderHistory(); if (t.dataset.screen === 'screen-home') refreshBalances(); show(t.dataset.screen); }));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
$('add-save').addEventListener('click', () => {
  const name = $('add-name').value.trim(), addr = $('add-addr').value.trim();
  $('add-error').hidden = true;
  try { new PublicKey(addr); } catch { $('add-error').textContent = 'アドレスの形式が正しくありません。GCrypto の Receive 画面からコピーしてください。'; $('add-error').hidden = false; return; }
  if (!name) { $('add-error').textContent = '名前を入れてください。'; $('add-error').hidden = false; return; }
  const b = book(); b.push({ name, address: addr }); store.set('padala.book', b);
  $('add-name').value = ''; $('add-addr').value = '';
  closeSheets(); renderBook();
});

async function boot() {
  $('my-addr').textContent = wallet.publicKey.toBase58();
  try { await loadRate(); } catch (e) { $('send-error').textContent = `レートを取得できません（${e.message}）`; $('send-error').hidden = false; }
  renderBook();
  renderHistory();
  await refreshBalances();
}

(async () => {
  wallet = loadWallet();
  if (!wallet) { show('screen-onboard'); return; }
  await boot();
  show('screen-send');
})();
