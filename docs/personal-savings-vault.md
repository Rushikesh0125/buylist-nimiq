# Personal savings vault design

## Scope and mapping

- Buylist sign-in and plans remain in the existing Worker and D1. The wallet connected through Nimiq Pay's EVM provider owns each vault position.
- A Buylist goal ID maps to a hashed identifier scoped by the EVM owner address. The contract stores one position per owner and identifier. It stores the target, funded amount and final disposition. Reloading the plan reads that same position from the chain.
- A deployment is bound to a single approved ERC-20. Buylist uses USDT on a configured Polygon deployment and a test ERC-20 on Sepolia. The native NIM transfer history is separate and remains accessible for previously enabled plans. Existing NIM balances, transfers and purchase budgets do not migrate.
- The browser reads and submits contract calls through Nimiq Pay. The backend has no EVM key or spending authority. A position is opened when its owner approves creation on chain, after setting a target.

## Invariants

- Repeated deposits are approved by the owner and may fund up to the immutable target. Credit equals the verified token amount received. A target funded in full can be withdrawn in one operation.
- Before the target, only the owner can abort. Abort returns the full funded amount to the originating wallet and closes the position permanently. No partial withdrawals, admins, alternate payout addresses, or upgrade controls exist.
- Each contract call operates on the caller's own position. Separate users can use the same goal ID without sharing funds. Closure is final and replaying a creation or withdrawal fails.
- Stablecoin transfers are atomic with position updates. Unsupported token behavior, such as incoming transfer fees, reverts. The deployment must use an approved non-rebasing token. Deposits use the contract method so they can be attributed to a position. A direct ERC-20 transfer has no position identifier and is unsupported.
- There is no migration of balances. Native NIM contributions never acquire a vault lock retroactively. New vaults are exposed only when a contract address and chain are configured.

## Validation

Compile with pinned dependencies. Run on an isolated local EVM with two funded accounts, test token, and the real vault contract. Verify early withdrawal, unauthorized operations, repeated deposits, overfunding, exact refunds, account separation, terminal states and reverted transfers. Verify the UI through the normal goal detail route with a test provider, then verify native approval and test-token transfers on Sepolia before any mainnet use.
