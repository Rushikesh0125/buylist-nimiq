import { useEffect, useRef, useState } from "react";
import { dateInTimezone } from "../shared/automatic";
import { api } from "./api";
import NimiqStaking from "./NimiqStaking";

type Savings = {
  address: string;
  target_luna: number;
  earmarked_luna: number;
  review_date: string | null;
  purchase_date: string | null;
  final_contribution_luna: number;
  schedule_usd_rate: number | null;
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
  scheduleAccepted,
}: {
  goalId: string;
  closed: boolean;
  timezone: string;
  scheduleAccepted: boolean;
}) {
  const path = "/api/goals/" + encodeURIComponent(goalId) + "/nimiq";
  const [summary, setSummary] = useState<Summary>();
  const [earmarked, setEarmarked] = useState("0");
  const [hash, setHash] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api<Summary>(path, "GET", undefined, controller.signal)
      .then(async (value) => {
        setSummary(value);
        if (
          scheduleAccepted &&
          !closed &&
          value.enabled &&
          !value.savings?.schedule_usd_rate
        ) {
          await api(path, "PATCH", { fromSchedule: true }, controller.signal);
          value = await api<Summary>(path, "GET", undefined, controller.signal);
          if (controller.signal.aborted) return;
          setSummary(value);
        }
        setHash(value.pending?.tx_hash ?? "");
        if (value.savings) {
          setEarmarked(String(value.savings.earmarked_luna / 100_000));
        }
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setMessage(error.message);
      });
    return () => controller.abort();
  }, [path, scheduleAccepted, closed]);

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

  async function linkSchedule() {
    await api(path, "PATCH", { fromSchedule: true });
    await refresh();
    setMessage("NIM plan created from your schedule. No NIM was moved.");
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
      {summary.enabled &&
        summary.network &&
        savings?.schedule_usd_rate &&
        scheduleAccepted && (
          <NimiqStaking
            key={summary.network + ":" + savings.address}
            path={path}
            network={summary.network}
            savings={savings}
            timezone={timezone}
            refreshSavings={refresh}
          />
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
          {underfunded && (
            <p role="status">
              Your wallet balance is lower than the total earmarked across your
              goals. Add NIM to your wallet or reduce an earmark.
            </p>
          )}
          {!underfunded &&
            savings.balance !== null &&
            savings.earmarked_luna >= savings.target_luna && (
              <p>
                Your NIM target is covered by spendable funds in your wallet.
              </p>
            )}
          {due && (
            <p role="status">
              Savings check-in due. Review your balance and update what you’ve
              set aside.
            </p>
          )}
        </>
      )}
      {summary.enabled && !closed && !scheduleAccepted && (
        <p>
          Save your contribution schedule to set up NIM savings and staking.
        </p>
      )}
      {summary.enabled && !closed && scheduleAccepted && (
        <>
          {!savings?.schedule_usd_rate && (
            <>
              <p>Your NIM target and timing come from your saved schedule.</p>
              {message && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void run(linkSchedule)}
                >
                  Retry schedule setup
                </button>
              )}
            </>
          )}
          {savings?.schedule_usd_rate && (
            <>
              <details>
                <summary>Budget and wallet details</summary>
                <p>
                  {savings.balance === null
                    ? "Wallet balance unavailable."
                    : "Wallet balance: " + nim(savings.balance) + " NIM"}
                </p>

                <p>
                  Estimated from your schedule at $
                  {savings.schedule_usd_rate.toPrecision(5)} per NIM
                  {summary.network === "testnet"
                    ? " · testnet planning only"
                    : ""}
                  .
                </p>
                {savings.purchase_date && (
                  <p>
                    Final scheduled contribution:{" "}
                    {nim(savings.final_contribution_luna)} NIM on{" "}
                    {savings.purchase_date}.
                  </p>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      await api(path, "PATCH", {
                        fromSchedule: true,
                        earmarkedLuna: toLuna(earmarked),
                      });
                      await refresh();
                      setMessage("Earmark updated. No NIM was moved.");
                    });
                  }}
                >
                  <label>
                    Amount already set aside (NIM)
                    <input
                      value={earmarked}
                      onChange={(event) => setEarmarked(event.target.value)}
                      inputMode="decimal"
                      disabled={busy}
                      required
                    />
                  </label>
                  <button type="submit" className="secondary" disabled={busy}>
                    Update earmark
                  </button>
                </form>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => void run(refresh)}
                >
                  Refresh wallet balance
                </button>
              </details>
            </>
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
