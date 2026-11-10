import { useEffect, useRef, useState } from "react";
import { getHostNetwork, init } from "@nimiq/mini-app-sdk";
import { dateInTimezone } from "../shared/automatic";
import {
  purchaseUnstakePlan,
  unstakeBufferDays,
} from "../shared/nimiq-staking";
import { api } from "./api";
import { addressFromPublicKey } from "../shared/nimiq-address";

type Staking = {
  staker: {
    balance: number;
    delegation: string | null;
    inactiveBalance: number;
    retiredBalance: number;
  } | null;
  validators: string[];
  minimumStake: number;
  height: number;
  releaseBlock: number | null;
};
type Savings = {
  address: string;
  target_luna: number;
  earmarked_luna: number;
  purchase_date: string | null;
  final_contribution_luna: number;
  contribution_luna?: number;
  contribution_date?: string | null;
  balance: number | null;
  totalEarmarked: number;
};
type Action = "stake" | "deactivate" | "retire" | "withdraw";
const nim = (luna: number) =>
  (luna / 100_000).toLocaleString(undefined, { maximumFractionDigits: 5 });
const normalize = (address: string) => address.replace(/\s/g, "").toUpperCase();
const validHash = /^[a-f0-9]{64}$/i;

function amountLuna(input: string) {
  const parts = /^(\d{1,8})(?:\.(\d{1,5}))?$/.exec(input.trim());
  if (!parts)
    throw new Error("Enter a NIM amount with up to five decimal places.");
  const value =
    Number(parts[1]) * 100_000 + Number((parts[2] ?? "").padEnd(5, "0"));
  if (value <= 0) throw new Error("Enter a positive NIM amount.");
  return value;
}

export default function NimiqStaking({
  path,
  network,
  savings,
  timezone,
  refreshSavings,
  takeFirstContribution,
}: {
  path: string;
  network: "mainnet" | "testnet";
  savings: Savings;
  timezone: string;
  refreshSavings: () => Promise<unknown>;
  takeFirstContribution: () => boolean;
}) {
  const [status, setStatus] = useState<Staking>();
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const key = "buylist.stake." + network + "." + normalize(savings.address);
  const [pending, setPending] = useState(() => localStorage.getItem(key) ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const load = () => api<Staking>(path + "?staking=1");
  async function refresh() {
    const hash = localStorage.getItem(key) ?? "";
    setPending(hash);
    if (hash) {
      const result = await api<{ status: "pending" | "confirmed" | "failed" }>(
        path + "?stakingTx=" + encodeURIComponent(hash),
      );
      if (result.status !== "pending") {
        localStorage.removeItem(key);
        setPending("");
      }
      setMessage(
        result.status === "confirmed"
          ? "Staking transaction confirmed."
          : result.status === "failed"
            ? "The staking transaction failed on-chain."
            : "Waiting for on-chain finality.",
      );
      if (result.status === "pending") return;
    }
    const [next] = await Promise.all([load(), refreshSavings()]);
    setStatus(next);
  }

  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Staking request failed.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  async function submit(action: Action) {
    const execute = async () => {
      if (network !== "testnet")
        throw new Error(
          "Wallet staking actions are currently enabled on Nimiq Testnet.",
        );
      if (localStorage.getItem(key))
        throw new Error(
          "Check the pending staking transaction before sending another.",
        );
      setMessage("Checking your contribution and wallet balance…");
      const current = await api<{ savings: Savings | null }>(
        path,
        "GET",
        undefined,
        AbortSignal.timeout(20_000),
      );
      if (
        !current.savings ||
        normalize(current.savings.address) !== normalize(savings.address)
      )
        throw new Error("The saved wallet changed. Reopen the staking panel.");
      if (action === "stake") {
        const { balance, totalEarmarked, contribution_luna } = current.savings;
        if (balance === null)
          throw new Error(
            "Your wallet balance is temporarily unavailable. Try again shortly.",
          );
        if ((contribution_luna ?? 0) > balance - totalEarmarked) {
          throw new Error(
            "Available: " +
              nim(Math.max(0, balance - totalEarmarked)) +
              " NIM in testnet wallet ending " +
              current.savings.address.slice(-4) +
              ". This contribution needs " +
              nim(contribution_luna!) +
              " NIM. Check that this is the address holding your testnet NIM.",
          );
        }
      }
      const latest = await api<Staking>(
        path + "?staking=1",
        "GET",
        undefined,
        AbortSignal.timeout(30_000),
      );
      setMessage("Connecting to Nimiq Pay…");
      const wallet = await init({ timeout: 3000 });
      if (getHostNetwork() !== network)
        throw new Error(
          "Switch Nimiq Pay to " + network + " and reopen Buylist.",
        );
      setMessage("Allow wallet access in Nimiq Pay if prompted.");
      const accounts = await wallet.listAccounts();
      if (
        !accounts.some(
          (account) => normalize(account) === normalize(savings.address),
        )
      ) {
        throw new Error(
          "Open this plan with the Nimiq Pay wallet you signed in with.",
        );
      }
      if (accounts.length > 1) {
        setMessage("Confirm the active wallet in Nimiq Pay.");
        const proof = await wallet.sign(
          "Confirm the active wallet for a Buylist staking action at " +
            location.origin,
        );
        if (
          normalize(addressFromPublicKey(proof.publicKey)) !==
          normalize(savings.address)
        ) {
          throw new Error(
            "Select the wallet you signed in with before staking.",
          );
        }
      }

      const staker = latest.staker;
      let request: () => Promise<string>;
      if (action === "stake") {
        const value = current.savings.contribution_luna ?? 0;
        if (
          !current.savings.contribution_date ||
          current.savings.contribution_date > dateInTimezone(timezone)
        )
          throw new Error(
            "Your first contribution is scheduled for a later date.",
          );
        if (!value)
          throw new Error("There is no scheduled contribution to stake.");
        const balance = current.savings.balance;
        if (
          balance === null ||
          value > balance - current.savings.totalEarmarked
        )
          throw new Error(
            "Stake only NIM that is available outside your liquid earmarks.",
          );
        if (staker) {
          if (
            staker.balance + staker.inactiveBalance + value <
            latest.minimumStake
          )
            throw new Error(
              "Keep at least " +
                nim(latest.minimumStake) +
                " NIM in non-retired stake.",
            );
          request = () => wallet.sendStakeTransaction({ value });
        } else {
          if (value < latest.minimumStake)
            throw new Error(
              "First stake must be at least " +
                nim(latest.minimumStake) +
                " NIM.",
            );
          const validator = "NQ57 2F6C X3GB Y9B7 04U5 2BVA 4BVC M2T0 ELRL";
          if (!latest.validators.includes(validator))
            throw new Error(
              "The preview validator is unavailable. Your NIM has not moved.",
            );
          request = () =>
            wallet.sendNewStakerTransaction({ value, delegation: validator });
        }
      } else {
        if (!staker) throw new Error("This wallet has no staking position.");
        if (action === "deactivate") {
          const value = amountLuna(withdrawAmount);
          const next = staker.balance - value;
          if (
            staker.inactiveBalance ||
            next < 0 ||
            (next > 0 && next < latest.minimumStake)
          )
            throw new Error(
              "Choose a valid amount that leaves the minimum active stake, or deactivate the full balance.",
            );
          request = () =>
            wallet.sendSetActiveStakeTransaction({ newActiveBalance: next });
        } else if (action === "retire") {
          if (
            !staker.inactiveBalance ||
            latest.releaseBlock === null ||
            latest.height < latest.releaseBlock
          )
            throw new Error("Inactive NIM has not been released yet.");
          request = () =>
            wallet.sendRetireStakeTransaction({
              retireStake: staker.inactiveBalance,
            });
        } else {
          if (!staker.retiredBalance)
            throw new Error("No retired NIM is ready to withdraw.");
          request = () =>
            wallet.sendRemoveStakeTransaction({ value: staker.retiredBalance });
        }
      }
      setMessage("Approve the transaction in Nimiq Pay.");
      const hash = await request();
      if (!validHash.test(hash))
        throw new Error(
          "Check Nimiq Pay activity before retrying. No transaction hash was returned.",
        );
      setPending(hash);
      localStorage.setItem(key, hash);
      setMessage(
        "Transaction submitted. Check confirmation before sending another.",
      );
    };
    await run(execute);
  }

  const contribution = savings.contribution_luna ?? 0;
  const due =
    !!savings.contribution_date &&
    savings.contribution_date <= dateInTimezone(timezone);
  const canContribute =
    savings.balance !== null &&
    contribution <= savings.balance - savings.totalEarmarked;

  useEffect(() => {
    if (!takeFirstContribution()) return;
    if (
      network === "testnet" &&
      due &&
      contribution > 0 &&
      canContribute &&
      !pending
    )
      void submit("stake");
  });

  const staker = status?.staker;
  const liquid =
    savings.balance === null
      ? null
      : Math.max(
          0,
          Math.min(
            savings.earmarked_luna,
            savings.balance - (savings.totalEarmarked - savings.earmarked_luna),
          ),
        );
  const plan =
    status && staker && liquid !== null && savings.purchase_date
      ? purchaseUnstakePlan({
          purchaseDate: savings.purchase_date,
          target: savings.target_luna,
          liquid,
          finalContribution: savings.final_contribution_luna,
          active: staker.balance,
          inactive: staker.inactiveBalance,
          retired: staker.retiredBalance,
          minimum: status.minimumStake,
        })
      : null;

  return (
    <section
      className="nimiq-contributions"
      aria-label="Scheduled contribution"
    >
      {network === "testnet" &&
        (pending ? (
          <button
            className="site-cta"
            type="button"
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            Check contribution
          </button>
        ) : (
          due &&
          contribution > 0 && (
            <>
              <button
                className="site-cta"
                type="button"
                disabled={busy}
                onClick={() => void submit("stake")}
              >
                Contribute {nim(savings.contribution_luna!)} NIM
              </button>
              <p>
                {savings.balance === null
                  ? "Refresh your wallet balance to contribute."
                  : savings.contribution_luna! >
                      savings.balance - savings.totalEarmarked
                    ? "Add testnet NIM in Nimiq Pay to cover this contribution."
                    : "Approve this contribution in Nimiq Pay."}
              </p>
            </>
          )
        ))}
      {!due && savings.contribution_date && !pending && (
        <p>First contribution scheduled for {savings.contribution_date}.</p>
      )}
      <details>
        <summary>Withdrawal details</summary>
        <p>
          Contributions are delegated to a validator through Nimiq Pay. You
          still control your funds. Withdrawals take time and rewards vary.
        </p>
        {!status ? (
          <>
            {pending && (
              <p className="nimiq-recipient">
                Submitted transaction: {pending}
              </p>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void run(refresh)}
            >
              {pending
                ? "Check staking confirmation"
                : "Check withdrawal status"}
            </button>
          </>
        ) : (
          <>
            {staker && (
              <p>
                Active: {nim(staker.balance)} NIM · Inactive:{" "}
                {nim(staker.inactiveBalance)} NIM · Retired:{" "}
                {nim(staker.retiredBalance)} NIM
              </p>
            )}
            {staker?.delegation && (
              <p className="nimiq-recipient">Validator: {staker.delegation}</p>
            )}
            {plan && (plan.amount > 0 || plan.remainingGap > 0) && (
              <p>
                {plan.date <= dateInTimezone(timezone)
                  ? "Unstake reminder: "
                  : "Suggested unstake date: "}
                {plan.date}.{" "}
                {plan.amount > 0 &&
                  "Consider deactivating " + nim(plan.amount) + " NIM. "}
                {plan.remainingGap > 0 &&
                  nim(plan.remainingGap) + " NIM would still be needed. "}
                The estimate allows {unstakeBufferDays} days; release timing can
                vary.
              </p>
            )}
            {staker &&
              staker.inactiveBalance > 0 &&
              status.releaseBlock !== null &&
              status.height < status.releaseBlock && (
                <p>
                  Inactive NIM can be retired at block{" "}
                  {status.releaseBlock.toLocaleString()} or later. Current
                  block: {status.height.toLocaleString()}.
                </p>
              )}
            {network !== "testnet" ? (
              <p>Staking actions are available on Nimiq Testnet for now.</p>
            ) : pending ? (
              <p className="nimiq-recipient">
                Submitted transaction: {pending}
              </p>
            ) : (
              <>
                {staker && staker.balance > 0 && !staker.inactiveBalance && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submit("deactivate");
                    }}
                  >
                    <label>
                      NIM to deactivate
                      <input
                        value={withdrawAmount}
                        onChange={(event) =>
                          setWithdrawAmount(event.target.value)
                        }
                        inputMode="decimal"
                        required
                        disabled={busy}
                      />
                    </label>
                    {plan && plan.amount > 0 && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          setWithdrawAmount(String(plan.amount / 100_000))
                        }
                      >
                        Use suggested amount
                      </button>
                    )}
                    <button type="submit" className="site-cta" disabled={busy}>
                      Start unstaking
                    </button>
                  </form>
                )}
                {staker &&
                  staker.inactiveBalance > 0 &&
                  status.releaseBlock !== null &&
                  status.height >= status.releaseBlock && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void submit("retire")}
                    >
                      Retire inactive NIM
                    </button>
                  )}
                {staker && staker.retiredBalance > 0 && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void submit("withdraw")}
                  >
                    Withdraw retired NIM
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => void run(refresh)}
            >
              {pending ? "Check staking confirmation" : "Refresh status"}
            </button>
          </>
        )}
      </details>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
