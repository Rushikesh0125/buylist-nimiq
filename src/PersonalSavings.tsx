import { useRef, useState } from "react";
import {
  BaseError,
  formatUnits,
  isHash,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
} from "viem";
import { connectSavingsVault, vaultDeployment } from "./savingsVault";

type Connection = ReturnType<typeof connectSavingsVault>;
type Position = Awaited<ReturnType<Connection["read"]>>;
type Action = "openGoal" | "deposit" | "withdraw" | "abort";

function savingsAmount(input: string, decimals: number) {
  const parts = /^(\d{1,18})(?:\.(\d+))?$/.exec(input.trim());
  if (!parts || (parts[2]?.length ?? 0) > decimals)
    throw new Error("Enter a valid token amount.");
  const amount = parseUnits(input.trim(), decimals);
  if (amount <= 0n) throw new Error("Enter an amount greater than zero.");
  return amount;
}

export default function PersonalSavings({
  goalId,
  closed,
}: {
  goalId: string;
  closed: boolean;
}) {
  const [position, setPosition] = useState<Position>();
  const [amount, setAmount] = useState("");
  const [pending, setPending] = useState<Hash>();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const connection = useRef<{
    vault: Connection;
    owner: Address;
    pendingKey: string;
  }>(null);
  if (!vaultDeployment) return null;
  const deployment = vaultDeployment;

  const run = async (operation: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setStatus("");
    try {
      await operation();
    } catch (error) {
      setStatus(
        error instanceof BaseError
          ? error.shortMessage
          : error instanceof Error
            ? error.message
            : "Savings action failed.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  async function connect() {
    const provider = (window as Window & { ethereum?: EIP1193Provider })
      .ethereum;
    if (!provider)
      throw new Error(
        "Open Buylist inside Nimiq Pay to connect your savings wallet.",
      );
    const vault = connectSavingsVault(deployment, provider, goalId);
    setStatus("Approve wallet access in Nimiq Pay.");
    const owner = await vault.connect();
    const next = await vault.read(owner);
    const pendingKey = [
      "buylist.vault",
      deployment.chain.id,
      deployment.address,
      owner,
      goalId,
    ].join(":");
    connection.current = { vault, owner, pendingKey };
    const stored = localStorage.getItem(pendingKey);
    setPending(stored && isHash(stored) ? stored : undefined);
    setPosition(next);
    setStatus("");
  }

  async function refresh() {
    const current = connection.current;
    if (!current) return;
    if (pending) {
      const result = await current.vault.check(pending);
      if (!result) {
        setStatus("Transaction is still pending. Check again shortly.");
        return;
      }
      localStorage.removeItem(current.pendingKey);
      setPending(undefined);
      setStatus(
        result === "success"
          ? "Transaction confirmed. If this was a token approval, tap Deposit to continue."
          : "Transaction reverted. You can try again.",
      );
    }
    setPosition(await current.vault.read(current.owner));
  }

  async function transact(action: Action) {
    const current = connection.current;
    if (!current || !position || pending) return;
    const value =
      action === "deposit" || action === "openGoal"
        ? savingsAmount(amount, position.decimals)
        : 0n;
    if (action === "deposit" && value > position.target - position.funded)
      throw new Error("Enter an amount no greater than the remaining target.");
    setStatus("Approve the transaction in Nimiq Pay.");
    await current.vault.transact(
      current.owner,
      action,
      value,
      (hash) => {
        localStorage.setItem(current.pendingKey, hash);
        setPending(hash);
        setStatus("Waiting for on-chain confirmation…");
      },
      () => {
        localStorage.removeItem(current.pendingKey);
        setPending(undefined);
        setStatus("Approve the next transaction in Nimiq Pay.");
      },
    );
    setPosition(await current.vault.read(current.owner));
    setAmount("");
    setStatus(
      action === "abort"
        ? "Goal canceled. Your savings were returned to your wallet."
        : "Transaction confirmed.",
    );
  }

  const active = position?.status === 1;
  const complete = active && position.funded === position.target;
  const showAmount =
    position && ((position.status === 0 && !closed) || (active && !complete));
  const display = (value: bigint) =>
    position
      ? formatUnits(value, position.decimals) + " " + position.symbol
      : "";

  return (
    <section
      className="nimiq-contributions"
      aria-label="Personal savings vault"
    >
      <h3>Personal savings vault</h3>
      <p>
        {deployment.chain.name} · Your wallet controls deposits, withdrawals,
        and cancellation.
      </p>
      {!position ? (
        <button
          className="site-cta"
          disabled={busy}
          onClick={() => void run(connect)}
        >
          Connect savings wallet
        </button>
      ) : (
        <>
          {position.status > 0 && (
            <p>
              <strong>
                {display(position.funded)} / {display(position.target)}
              </strong>
            </p>
          )}
          {position.status === 2 && <p>Goal complete. Savings withdrawn.</p>}
          {position.status === 3 && (
            <p>Goal canceled. Savings returned to your wallet.</p>
          )}
          {active && !complete && (
            <p>
              Locked until the target is reached. Aborting closes the goal and
              refunds the full balance.
            </p>
          )}
          {pending ? (
            <button
              className="site-cta"
              disabled={busy}
              onClick={() => void run(refresh)}
            >
              Check transaction
            </button>
          ) : showAmount ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => transact(active ? "deposit" : "openGoal"));
              }}
            >
              <label>
                {active ? "Deposit amount" : "Savings target"} (
                {position.symbol})
                <input
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  inputMode="decimal"
                  required
                  disabled={busy}
                />
              </label>
              <button className="site-cta" type="submit" disabled={busy}>
                {active ? "Deposit" : "Open personal vault"}
              </button>
            </form>
          ) : (
            complete && (
              <button
                className="site-cta"
                disabled={busy}
                onClick={() => void run(() => transact("withdraw"))}
              >
                Withdraw full balance
              </button>
            )
          )}
          {active && !complete && !pending && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Close this savings goal and return its full balance to your wallet? This cannot be undone.",
                  )
                )
                  void run(() => transact("abort"));
              }}
            >
              Abort goal and refund savings
            </button>
          )}
          {!pending && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void run(refresh)}
            >
              Refresh savings
            </button>
          )}
        </>
      )}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
