# Padala — Ethereum (Sepolia) build plan (2026-10-03)

Decided (owner, 2026-10-03): fiat legs stay outside the app; chain = Ethereum; submit "a wallet where send → receive works", no extra headline feature.

## Money flow
JPY → [SBI VC Trade: buy USDC, withdraw to the user's own address — Ethereum only] → **Padala (self-custody EOA)** → family's GCash GCrypto USDC (Ethereum/ERC20) address → [GCash: sell to PHP]

Facts that shape the design (my-work `web3/ventures/padala/_route_direct_vs_wallet_20261003.md`):
- SBI VC cannot withdraw directly to PDAX/GCrypto (public rules) → the self-custody hop is required.
- SBI VC: "コントラクトアドレスへの出庫はできません" → the wallet must be a plain EOA, not a smart account.
- PDAX: deposits from contract-based wallets are processed manually and are delayed → again EOA.

## Gas
The user only holds USDC. The user signs an EIP-3009 `TransferWithAuthorization` (to, value, validAfter, validBefore, nonce are inside the signature); the Padala server submits it with its own ETH key. The server can only decide whether/when to submit; it cannot change recipient or amount and never holds user keys or funds.

## Testnet stand-ins
- SBI VC withdrawal → `/api/fund`: server sends 5 test USDC (Circle faucet USDC, Sepolia) once per 12 h per address.
- Family GCrypto address → a demo EOA (`keys/eth_family_demo.json`, gitignored; only the address is in the app).

## Acceptance checks (all must pass before calling it done)
1. Create wallet in the browser; key stays in the browser (server code never receives a private key).
2. "Top up" puts 5 USDC on the new address (tx confirmed on Sepolia).
3. Send ¥ amount → confirm screen → sign → server relays → USDC lands on the family address; tx hash verifiable on sepolia.etherscan.io; balances before/after match.
4. Family page `/r?...` reads the receipt from chain and shows "Confirmed".
5. Invalid address and over-balance amounts are rejected before signing.
6. Phone emulation (iPhone 15) screenshots of each screen, opened and checked.
7. No secrets in git (`keys/`, `.env` ignored; check `git status` before commit).
