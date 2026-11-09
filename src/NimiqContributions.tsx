import { useEffect, useRef, useState } from "react";
import { getHostNetwork, init } from "@nimiq/mini-app-sdk";
import { dateInTimezone } from "../shared/automatic";
import { api } from "./api";

type Savings = {
  address: string;
  target_luna: number;
  earmarked_luna: number;
  review_date: string | null;
  balance: number | null;
  totalEarmarked: number;
};
type Summary = {
  enabled: boolean;
  network: "testnet" | "mainnet" | null;
  savings: Savings | null;
  config: { recipient: string; network: string } | null;
  confirmed: number;
  pending: { id: string; amount_luna: number; tx_hash: string | null } | null;
};

function toLuna(input: string) {
  const parts = /^(\d{1,8})(?:\.(\d{1,5}))?$/.exec(input.trim());
  if (!parts)
    throw new Error("Enter a NIM amount with up to five decimal places.");
  return Number(parts[1]) * 100_000 + Number((parts[2] || "").padEnd(5, "0"));
}

const nim = (luna: number) =>
  (luna / 100_000).toLocaleString(undefined, { maximumFractionDigits: 5 });

export default function NimiqContributions({
  goalId,
  closed,
  timezone,
}: {
  goalId: string;
  closed: boolean;
  timezone: string;
}) {
  const path = "/api/goals/" + encodeURIComponent(goalId) + "/nimiq";
  const [summary, setSummary] = useState<Summary>();
  const [accounts, setAccounts] = useState<string[]>([]);
  const [address, setAddress] = useState("");
  const [target, setTarget] = useState("");
  const [earmarked, setEarmarked] = useState("0");
  const [reviewDate, setReviewDate] = useState("");
  const [hash, setHash] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api<Summary>(path, "GET", undefined, controller.signal)
      .then((value) => {
        setSummary(value);
        setHash(value.pending?.tx_hash ?? "");
        if (value.savings) {
          setAddress(value.savings.address);
          setTarget(String(value.savings.target_luna / 100_000));
          setEarmarked(String(value.savings.earmarked_luna / 100_000));
          setReviewDate(value.savings.review_date ?? "");
        }
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setMessage(error.message);
      });
    return () => controller.abort();
  }, [path]);

  const refresh = async () => setSummary(await api<Summary>(path));
  async function run(operation: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      await operation();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not complete the request.",
      );
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  const savings = summary?.savings;
  const due =
    !closed &&
    savings?.review_date &&
    savings.review_date <= dateInTimezone(timezone);
  const underfunded =
    savings &&
    savings.balance !== null &&
    savings.balance < savings.totalEarmarked;

  if (!summary) return message ? <p role="status">{message}</p> : null;

  return (
    <section className="nimiq-contributions" aria-label="Personal NIM savings">
      <h3>Personal NIM savings</h3>
      <p>
        Track what you’ve set aside for this goal. Your NIM stays spendable in
        your wallet.
      </p>
      {!summary.enabled && (
        <p>Wallet balance tracking is unavailable right now.</p>
      )}
      {savings && (
        <>
          <p>
            <strong>
              {nim(savings.earmarked_luna)} / {nim(savings.target_luna)} NIM
              earmarked
            </strong>{" "}
            · {summary.network}
          </p>
          <progress
            aria-label="NIM earmarked toward goal"
            value={savings.earmarked_luna}
            max={savings.target_luna}
          />
          <p>
            {savings.balance === null
              ? "Wallet balance unavailable."
              : "Wallet balance: " + nim(savings.balance) + " NIM"}
          </p>
          {underfunded && (
            <p role="status">
              Your wallet balance is lower than the total earmarked across your
              goals. Add NIM to your wallet or reduce an earmark.
            </p>
          )}
          {due && (
            <p role="status">
              Savings check-in due. Review your balance and update what you’ve
              set aside.
            </p>
          )}
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            Refresh wallet balance
          </button>
        </>
      )}
      {summary.enabled && !closed && (
        <>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const wallet = await init({ timeout: 3000 }).catch(() => {
                  throw new Error(
                    "Open Buylist inside Nimiq Pay to connect your wallet.",
                  );
                });
                if (getHostNetwork() !== summary.network)
                  throw new Error(
                    "Switch Nimiq Pay to " +
                      summary.network +
                      " and reopen Buylist.",
                  );
                const shared = await wallet.listAccounts();
                if (!shared.length)
                  throw new Error("Nimiq Pay did not share a wallet address.");
                setAccounts(shared);
                setAddress(shared.includes(address) ? address : shared[0]);
              })
            }
          >
            {address ? "Choose wallet" : "Connect Nimiq Pay wallet"}
          </button>
          {address && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await api(path, "PATCH", {
                    address,
                    targetLuna: toLuna(target),
                    earmarkedLuna: toLuna(earmarked),
                    reviewDate: reviewDate || null,
                  });
                  await refresh();
                  setMessage("Savings plan updated. No NIM was moved.");
                });
              }}
            >
              {accounts.length > 1 ? (
                <label>
                  Wallet address
                  <select
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                    disabled={busy}
                  >
                    {accounts.map((account) => (
                      <option key={account} value={account}>
                        {account}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="nimiq-recipient">{address}</p>
              )}
              <label>
                Savings target (NIM)
                <input
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  inputMode="decimal"
                  disabled={busy}
                  required
                />
              </label>
              <label>
                Amount set aside (NIM)
                <input
                  value={earmarked}
                  onChange={(event) => setEarmarked(event.target.value)}
                  inputMode="decimal"
                  disabled={busy}
                  required
                />
              </label>
              <label>
                Check-in date (optional)
                <input
                  type="date"
                  value={reviewDate}
                  onChange={(event) => setReviewDate(event.target.value)}
                  disabled={busy}
                />
              </label>
              <button type="submit" className="site-cta" disabled={busy}>
                Save NIM plan
              </button>
            </form>
          )}
        </>
      )}
      {summary.config && (
        <>
          <h4>Previous NIM transfers</h4>
          <p>
            {nim(summary.confirmed)} NIM confirmed · {summary.config.network}
          </p>
          {summary.pending && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const result = await api<{ status: string }>(
                    path + "/" + summary.pending!.id,
                    "POST",
                    { txHash: hash.trim() },
                  );
                  await refresh();
                  setMessage(
                    result.status === "confirmed"
                      ? "Previous transfer confirmed."
                      : "Transfer pending. Check again after the next macro block.",
                  );
                });
              }}
            >
              <p>Pending transfer of {nim(summary.pending.amount_luna)} NIM.</p>
              <label>
                Transaction hash
                <input
                  value={hash}
                  onChange={(event) => setHash(event.target.value)}
                  pattern="[a-fA-F0-9]{64}"
                  required
                />
              </label>
              <button
                className="site-cta"
                type="submit"
                disabled={busy || !summary.enabled}
              >
                Check previous transfer
              </button>
              {!summary.pending.tx_hash && (
                <button
                  className="secondary"
                  type="button"
                  disabled={busy || !summary.enabled}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Discard this record only if your wallet shows no transfer was sent.",
                      )
                    )
                      return;
                    void run(async () => {
                      await api(path + "/" + summary.pending!.id, "DELETE");
                      await refresh();
                      setMessage("Previous transfer record discarded.");
                    });
                  }}
                >
                  Discard unsent transfer
                </button>
              )}
            </form>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
