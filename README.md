# Buylist for Nimiq Pay

Track a personal NIM savings target alongside a purchase plan. Sign in with Nimiq Pay, open any goal, connect your wallet, and save how much of your wallet balance you want to earmark. Group members track their own savings. An optional check-in date shows a reminder inside the goal when due.

NIM stays in the wallet. The Worker verifies wallet balances on the configured Nimiq network, and Buylist records targets and earmarks separately from USD budgets and historical NIM transfers. Earmarks do not lock funds or create payments.

## Local setup

1. Run `npm ci` and `npm run build`.
2. Copy `.dev.vars.example` to `.dev.vars`. The example uses the NimiqWatch testnet RPC. Set `APP_ORIGIN` to the exact origin used by the app.
3. Run `npm run db:local` and `npm run worker:dev`. For a phone test, serve the Worker over HTTPS and use that HTTPS origin for `APP_ORIGIN`.
4. Open the HTTPS URL in Nimiq Pay under **Mini Apps > Custom URL**. Select testnet and claim test NIM before testing wallet balance tracking.
5. Run `npm run typecheck` and `npm test` for local verification.

For deployment, provision a dedicated D1 database, configure the application origin, apply migrations, and set `NIMIQ_NETWORK` and `NIMIQ_RPC_URL` for the same native Nimiq network.

See the [Nimiq Mini Apps documentation](https://nimiq.dev/mini-apps).
