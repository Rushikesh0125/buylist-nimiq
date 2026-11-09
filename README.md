# Buylist for Nimiq Pay

Plan a group purchase and contribute NIM from Nimiq Pay. Start with a flexible group goal, then enable NIM savings in the goal detail. The organizer sets a separate NIM target and receiving address. Members can join by invitation and send a manual contribution. The receiving wallet belongs to the organizer, who controls the funds.

## How it works

- Nimiq Pay signs a short-lived Buylist sign-in challenge. The Worker verifies the Ed25519 signature, consumes the challenge once, and issues the normal Buylist session. Wallet and Google sign-in create separate identities.
- The Worker creates one pending contribution per member per goal. Nimiq Pay approves and sends the transfer with a random public reference. The reference contains no Buylist account or goal details.
- The Worker verifies the active chain, transaction hash, sender, recipient, exact amount in Luna, successful execution, and reference. A matching transfer credits the goal once the batch's macro block has finalized it. Members can check confirmation again after reopening the app.
- If the wallet submitted a transfer and Buylist did not receive the hash, copy it from Nimiq Pay activity into the pending contribution. Only discard the attempt after checking that no transfer was sent.
- The NIM target and confirmed total are separate from the existing USD goal, schedule, and PayPal ledger.

## Local setup

1. Run `npm ci`, then `npm run build`.
2. Copy `.dev.vars.example` to `.dev.vars`. Set `NIMIQ_NETWORK=testnet` and `NIMIQ_RPC_URL` to a trusted testnet history node exposing the Nimiq JSON-RPC API. Wallet sign-in does not require Google credentials.
3. Run `npm run db:local` and `npm run worker:dev`. To use a phone, serve the Worker over HTTPS and set `APP_ORIGIN` to that exact origin so login cookies and CSRF checks work.
4. Open the HTTPS URL through **Nimiq Pay → Mini Apps → Custom URL** with the app on testnet. Use **Continue with Nimiq Pay**, create a flexible goal, and enable NIM savings. Invite another test wallet and check canceled, pending, and confirmed transfers.
5. Run `npm run typecheck` and `npm test` for the local checks. The Worker tests use RPC fixtures and generated signing keys.

## Deployment

Provision dedicated D1 and Queue resources for this repository and replace the sample database IDs and application origins in `wrangler.jsonc`. Apply the migrations to the new D1 database. Set `NIMIQ_RPC_URL` as a Worker secret and configure `NIMIQ_NETWORK` for the intended environment. Use a trusted history node that serves the same chain as the wallet. A deployed mainnet instance and a public MIT-licensed repository are required for competition submission.

See the [Nimiq Mini Apps documentation](https://nimiq.dev/mini-apps) and [Nimiq RPC integration guide](https://nimiq.dev/migration/migration-integrators).
