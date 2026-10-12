# Padala

_A self-custody USDC wallet for Filipino workers in Japan sending money to family in GCash._

## Summary

Padala is a self-custody USDC wallet. The sender buys USDC at SBI VC Trade (a registered Japanese exchange), withdraws it to their own Padala wallet, and sends it to the family's GCash GCrypto USDC address. The sender only signs an EIP-3009 authorization; Padala's relayer submits it and pays the gas. Padala never holds keys or funds.

## Target users

Filipino migrant workers in Japan sending money to family who use GCash in the Philippines

## Problem

Under SBI VC Trade's published withdrawal rules, USDC cannot be withdrawn directly to PDAX, which runs GCash's GCrypto. A sender who wants to send USDC to family needs their own wallet in between.

## Solution

Padala is that wallet. The sender alone holds the key, needs only USDC (no ETH), and sees the pesos the family will receive before sending.

## MVP features

- Self-custody USDC wallet where the user alone holds the private key
- EIP-3009 signature flow restricted to a fixed recipient address and amount
- Node.js relayer server that submits the signed transfer and pays gas
- Plain HTML/JS + ethers.js frontend, no custom smart contract
- Family-facing confirmation page showing the received transfer on Sepolia

## Chains

Ethereum (Sepolia testnet)

## Tech

ethers.js, EIP-3009, USDC testnet contract, Node.js, HTML/CSS/JS, Claude Code

## Category

Payments

## Why now

SBI VC Trade lists USDC on Ethereum, and GCash's GCrypto accepts USDC on Ethereum. A self-custody wallet with gasless sending can connect the two.

## Roadmap

- Send a small real transfer to a GCrypto address to confirm how deposits from a self-custody wallet are handled
- Test the flow with Filipino workers in Japan and their families
- Move from the Sepolia testnet to Ethereum mainnet
