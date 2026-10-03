# Padala — a self-custody USDC wallet for Filipinos in Japan sending money home

Crypto World's Fair (Colosseum) 2026 entry. **Ethereum Sepolia** (test network).

## What it does
JPY → (SBI VC Trade: buy USDC, withdraw to your own address) → **Padala wallet** → family's GCash GCrypto USDC (Ethereum) address → (GCash: sell to PHP)

- The key is created and kept in the browser. Padala never holds keys or funds.
- Sending: the user signs an EIP-3009 `TransferWithAuthorization` (recipient, amount and expiry are inside the signature). The server submits it and pays the gas, so the user only needs USDC. The server cannot change the recipient or the amount.
- Why a plain wallet (EOA) and not a smart account: SBI VC Trade does not withdraw to contract addresses, and PDAX (GCrypto) processes deposits from contract-based wallets manually.
- Testnet stand-ins: `/api/fund` sends 5 test USDC in place of an SBI VC withdrawal; the default recipient is a test address in place of a real GCrypto address.

Plan and acceptance checks: `docs/ETH_PLAN.md`.

## Prior work disclosure
The following were created before the hackathon period (Aug 1–16, 2026) and are disclosed as pre-existing work:
- `scripts/01_wallet_setup.ts`, `02_mint_test_token.ts`, `03_send.ts`, `05_sweep_back.ts` — Solana devnet USDC transfer scripts (Aug 1–3)
- the original `server.mjs` and `public/` 3-screen demo UI on Solana (Aug 1–2, styling Aug 16)

All work from Sep 23, 2026 onward is hackathon-period work and is tracked in the commit history (Sep 23: 5-screen wallet + family page on Solana; Oct 3: rebuilt on Ethereum Sepolia with gasless EIP-3009 relay).

## Run
```
npm install
# keys/eth_ops.json = {"address": "...", "privateKey": "..."} — a Sepolia key holding test ETH (gas) and test USDC (top-ups). Not committed.
node server.mjs   # http://localhost:4173
```
