# Personal NIM savings design

- Replace the EVM vault with a personal NIM target and an earmarked amount per member, goal, and native network. The user selects an address shared by Nimiq Pay. The Worker validates a current basic-account balance against the configured native RPC. Neither the app nor its server signs or submits a transfer.
- Add a separate D1 table. Keep USD budgets, schedules, membership, historic native transfer receipts, and in-flight native transfers. Retire creation of new transfer intents and organizer recipients. Existing amounts cannot be reclassified as personal savings.
- The database atomically checks that the sum earmarked by this user across goals for the same address and network fits the observed balance. The NIM remains spendable. A later balance decrease is surfaced when the balance is refreshed.
- Users may set an optional check-in date. The reminder is displayed in Buylist when due. It does not send external notifications or move funds.
- Validate existing receipt recovery, wallet/network mismatches, authorization, concurrent allocations, insufficient balance and mobile setup. Roll out via an additive local D1 migration. No contract or chain migration is needed.
