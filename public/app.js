// Padala — self-custody remittance wallet (Ethereum Sepolia)
// Everything that touches money happens here, in the browser, signed by a key that only this device holds.
// The server only serves files, quotes a rate, hands out test money (testnet only), and submits the
// user's signed EIP-3009 authorization so the user does not need ETH for gas. Recipient and amount are
// inside the signature — the server cannot change them.
const E = window.ethers;

const RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const CHAIN_ID = 11155111;                                   // Ethereum Sepolia
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
// Test stand-in for a family member's GCash GCrypto USDC (Ethereum) address.
const DEFAULT_BOOK = [{ name: 'Maria (Manila)', address: '0x09C4Fa99386bf791AD96658B1ebf456DDDe4b33B' }];

const provider = new E.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
const usdc = new E.Contract(USDC, ['function balanceOf(address) view returns (uint256)'], provider);
const $ = (id) => document.getElementById(id);
const jp = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const store = {
  get: (k, f) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let wallet = null;   // ethers.Wallet (key never leaves this browser)
let rate = null;     // /api/rate
let quote = null;    // current calculation
let recipient = null;
let balance = 0;     // USDC

// ───────── wallet (self-custody) ─────────
function loadWallet() {
  const pk = store.get('padala.eth.pk', null);
  return pk ? new E.Wallet(pk) : null;
}
function createWallet() {
  const w = E.Wallet.createRandom();
  store.set('padala.eth.pk', w.privateKey);
  return new E.Wallet(w.privateKey);
}
async function usdcBalance(address) {
  return Number(E.formatUnits(await usdc.balanceOf(address), DECIMALS));
}
async function refreshBalances() {
  try {
    balance = await usdcBalance(wallet.address);
    $('bal-usdc').textContent = jp(balance, 2);
    $('bal-jpy').textContent = rate ? jp(balance / rate.usdPerJpy, 0) : '–';
  } catch (e) {
    $('bal-usdc').textContent = '–';
  }
  return { usdc: balance };
}

// ───────── send: sign two EIP-3009 authorizations (family + service fee), the server submits them ─────────
async function authorize(to, micro) {
  const message = {
    from: wallet.address, to: E.getAddress(to), value: BigInt(micro),
    validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: E.hexlify(E.randomBytes(32)),
  };
  const signature = await wallet.signTypedData(DOMAIN, TYPES, message);
  return { to: message.to, value: message.value.toString(), validAfter: '0', validBefore: message.validBefore.toString(), nonce: message.nonce, signature };
}
async function sendUsdc(toAddress, q) {
  const main = await authorize(toAddress, q.mainMicro);
  const fee = await authorize(rate.feeTo, q.feeMicro);
  const res = await fetch('/api/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: wallet.address, ...main, fee }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.hash;
}

// ───────── rate & quote ─────────
async function loadRate() {
  const res = await fetch('/api/rate');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  rate = await res.json();
  $('q-mid').textContent = rate.phpPerJpy.toFixed(4);
  $('q-src').textContent = rate.source;
  $('q-time').textContent = new Date(rate.baseTime).toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// amounts in 1e-6 USDC integers (same rounding as the server's fee check)
function calc(jpy) {
  const total = Math.floor(jpy * rate.usdPerJpy * 100) * 10000;        // what leaves the wallet
  const fee = Math.max(Math.ceil((total * rate.feeBps) / 10000), rate.minFeeMicro || 0); // 0.95%、ただしその時のガス代を下限に                  // service fee to Padala
  const main = total - fee;                                              // what the family receives
  const usdc = main / 1e6;
  return { jpy, totalMicro: total, feeMicro: fee, mainMicro: main, usdc, feeJpy: fee / 1e6 / rate.usdPerJpy, php: usdc * rate.phpPerUsd, phpPerJpy: rate.phpPerJpy };
}
function renderQuote() {
  const jpy = Number(($('jpy').value || '').replace(/[^\d]/g, ''));
  if (!rate || !jpy || !recipient) {
    quote = null;
    $('q-usdc').textContent = '–'; $('q-php').textContent = '0'; $('q-fee').textContent = '¥0';
    $('review-btn').disabled = true;
    return;
  }
  quote = calc(jpy);
  $('q-usdc').textContent = jp(quote.usdc, 2);
  $('q-php').textContent = jp(quote.php, 0);
  $('q-fee').textContent = `¥${jp(quote.feeJpy, 0)}`;
  const over = quote.totalMicro / 1e6 > balance;
  const tooSmall = quote.mainMicro <= 0;
  $('review-btn').disabled = over || tooSmall;
  $('send-error').hidden = !(over || tooSmall);
  if (tooSmall) $('send-error').textContent = 'This amount does not cover the network fee.';
  else if (over) $('send-error').textContent = `This exceeds your balance (${jp(balance, 2)} USDC). Deposit from "Wallet".`;
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
  add.textContent = '+ Add';
  add.addEventListener('click', () => openSheet('sheet-add'));
  el.appendChild(add);
}

// ───────── history & receipt ─────────
function history() { return store.get('padala.history', []); }
function addHistory(entry) { const h = history(); h.unshift(entry); store.set('padala.history', h); return h; }
function receiptNo(d, n) { const p = (x) => String(x).padStart(2, '0'); return `PDL-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(n).padStart(3, '0')}`; }
function showReceipt(e) {
  $('r-no').textContent = e.no;
  $('r-time').textContent = new Date(e.time).toLocaleString('en-US');
  $('r-from').textContent = short(e.from);
  $('r-to').textContent = `${e.toName} · ${short(e.to)}`;
  $('r-jpy').textContent = jp(e.jpy, 0);
  $('r-usdc').textContent = jp(e.usdc, 2);
  $('r-rate').textContent = e.phpPerJpy.toFixed(4);
  $('r-php').textContent = jp(e.php, 0);
  $('r-sec').textContent = e.seconds.toFixed(2);
  $('r-sig').textContent = e.sig;
  $('r-explorer').href = `${EXPLORER}/tx/${e.sig}`;
  $('family-link').onclick = async () => {
    const u = new URL('/r', location.origin);
    u.searchParams.set('sig', e.sig); u.searchParams.set('php', Math.round(e.php)); u.searchParams.set('usdc', e.usdc);
    u.searchParams.set('name', e.toName); u.searchParams.set('from', e.fromName || 'Kanji');
    await navigator.clipboard.writeText(u.toString()).catch(() => {});
    $('family-link').textContent = 'Copied';
    setTimeout(() => { $('family-link').textContent = 'Copy link for your family'; }, 1800);
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
    li.innerHTML = `<button class="hist-row"><span class="h-l"><span class="h-name">${e.toName}</span><span class="h-date">${d.toLocaleDateString('en-US')}</span></span><span class="h-r"><span class="num">₱${jp(e.php, 0)}</span><span class="h-jpy">¥${jp(e.jpy, 0)}</span></span></button>`;
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
  $('clock-caption').textContent = 'Signing on your device…';
  $('clock-caption').className = 'clock-caption';
  const t0 = performance.now();
  const tick = setInterval(() => { $('clock').textContent = ((performance.now() - t0) / 1000).toFixed(2); }, 50);
  try {
    $('st-1').className = 'step done'; $('st-2').className = 'step on';
    $('clock-caption').textContent = 'Confirming on Ethereum… (about 15–30 s)';
    const sig = await sendUsdc(to.address, q);
    const seconds = (performance.now() - t0) / 1000;
    clearInterval(tick);
    $('clock').textContent = seconds.toFixed(2);
    $('clock-caption').textContent = 'Confirmed'; $('clock-caption').className = 'clock-caption ok';
    $('st-2').className = 'step done'; $('st-3').className = 'step done';
    const h = history();
    const entry = {
      no: receiptNo(new Date(), h.length + 1), time: Date.now(), from: wallet.address, fromName: 'Kanji',
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
  if (/Insufficient balance/i.test(m)) return 'Insufficient balance. Deposit from "Wallet".';
  if (/expired/i.test(m)) return 'Too much time has passed. Please send again.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Cannot reach the network. Please try again.';
  return `Could not send: ${m}`;
}

// ───────── wire up ─────────
$('create-wallet').addEventListener('click', async () => {
  wallet = createWallet();
  await boot();
  show('screen-home');
  openSheet('sheet-topup');
});
$('copy-addr').addEventListener('click', async () => {
  await navigator.clipboard.writeText(wallet.address).catch(() => {});
  $('copy-addr').textContent = 'Copied'; setTimeout(() => { $('copy-addr').textContent = 'Copy'; }, 1500);
});
$('show-topup').addEventListener('click', () => openSheet('sheet-topup'));
$('fund-btn').addEventListener('click', async () => {
  $('fund-btn').disabled = true; $('fund-btn').textContent = 'Receiving… (about 30 s)'; $('fund-error').hidden = true;
  try {
    const res = await fetch('/api/fund', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: wallet.address }) });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await refreshBalances();
    closeSheets();
  } catch (e) {
    $('fund-error').textContent = e.message; $('fund-error').hidden = false;
  } finally { $('fund-btn').disabled = false; $('fund-btn').textContent = 'Receive 5 test USDC'; }
});
$('jpy').addEventListener('input', () => {
  const digits = $('jpy').value.replace(/[^\d]/g, '');
  $('jpy').value = digits ? Number(digits).toLocaleString('en-US') : '';
  renderQuote();
});
document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => { $('jpy').value = Number(c.dataset.jpy).toLocaleString('en-US'); renderQuote(); }));
$('review-btn').addEventListener('click', () => {
  $('c-name').textContent = recipient.name; $('c-addr').textContent = recipient.address;
  $('c-jpy').textContent = jp(quote.jpy, 0); $('c-php').textContent = jp(quote.php, 0);
  const sentBefore = history().some((h) => h.to.toLowerCase() === recipient.address.toLowerCase());
  $('c-first').hidden = sentBefore;
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
  if (!E.isAddress(addr)) { $('add-error').textContent = 'This is not a valid address. In GCrypto, open Receive, choose USDC on Ethereum (ERC20), and copy the address that starts with 0x.'; $('add-error').hidden = false; return; }
  if (addr.toLowerCase() === wallet.address.toLowerCase()) { $('add-error').textContent = 'You cannot send to your own address.'; $('add-error').hidden = false; return; }
  if (!name) { $('add-error').textContent = 'Please enter a name.'; $('add-error').hidden = false; return; }
  const b = book(); b.push({ name, address: E.getAddress(addr) }); store.set('padala.book', b);
  $('add-name').value = ''; $('add-addr').value = '';
  closeSheets(); renderBook();
});

async function boot() {
  $('my-addr').textContent = wallet.address;
  try { await loadRate(); } catch (e) { $('send-error').textContent = `Could not load the rate (${e.message})`; $('send-error').hidden = false; }
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
