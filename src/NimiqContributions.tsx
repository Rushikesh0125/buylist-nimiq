import { useEffect, useRef, useState } from "react";
import { getHostNetwork, init, NimiqProviderError } from "@nimiq/mini-app-sdk";
import { api } from "./api";

type Summary = {
  enabled: boolean;
  config: {
    recipient: string;
    network: "mainnet" | "testnet";
    target_luna: number;
  } | null;
  confirmed: number;
  pending: { id: string; amount_luna: number; tx_hash: string | null } | null;
};

function toLuna(input: string) {
  const parts = /^(\d{1,8})(?:\.(\d{1,5}))?$/.exec(input.trim());
  if (!parts)
    throw new Error("Enter a NIM amount with up to five decimal places.");
  const luna =
    Number(parts[1]) * 100_000 + Number((parts[2] || "").padEnd(5, "0"));
  if (luna <= 0 || luna > 1_000_000_000_000)
    throw new Error("Enter an amount between 0.00001 and 10,000,000 NIM.");
  return luna;
}

const nim = (luna: number) =>
  (luna / 100_000).toLocaleString(undefined, { maximumFractionDigits: 5 });

export default function NimiqContributions({
  goalId,
  owner,
  closed,
  legacyOnly,
}: {
  goalId: string;
  owner: boolean;
  closed: boolean;
  legacyOnly: boolean;
}) {
  const path = "/api/goals/" + encodeURIComponent(goalId) + "/nimiq";
  const [summary, setSummary] = useState<Summary>();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
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
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setMessage(error.message);
      });
    return () => controller.abort();
  }, [path]);

  const refresh = async () => setSummary(await api<Summary>(path));
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not complete the request.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  async function verify(id: string, txHash: string) {
    const result = await api<{ status: string }>(path + "/" + id, "POST", {
      txHash: txHash.trim(),
    });
    await refresh();
    setMessage(
      result.status === "confirmed"
        ? "Contribution confirmed."
        : "Transfer pending. Check again after the next macro block.",
    );
  }

  const config = summary?.config;
  if (
    !summary ||
    (!config && (legacyOnly || !summary.enabled || !owner || closed))
  ) {
    return message ? <p role="status">{message}</p> : null;
  }

  return (
    <section className="nimiq-contributions" aria-label="Nimiq contributions">
      <h3>{legacyOnly ? "Previous NIM transfers" : "NIM savings"}</h3>
      {config ? (
        <>
          <p>
            <strong>
              {nim(summary.confirmed)} / {nim(config.target_luna)} NIM
            </strong>{" "}
            confirmed · {config.network}
          </p>
          <p>Funds go directly to the organizer, who controls this wallet.</p>
          <p className="nimiq-recipient">{config.recipient}</p>
          {summary.pending ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(() => verify(summary.pending!.id, hash));
              }}
            >
              <p>
                Pending contribution of {nim(summary.pending.amount_luna)} NIM.
              </p>
              <label>
                Transaction hash
                <input
                  value={hash}
                  onChange={(event) => setHash(event.target.value)}
                  required
                  pattern="[a-fA-F0-9]{64}"
                />
              </label>
              <button
                className="site-cta"
                type="submit"
                disabled={busy || !summary.enabled}
              >
                Check confirmation
              </button>
              {!summary.pending.tx_hash && !hash && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !summary.enabled}
                  onClick={() => {
                    if (
                      !window.confirm(
                        "Discard this attempt only if Nimiq Pay activity shows that no transfer was sent. A discarded attempt cannot be credited.",
                      )
                    )
                      return;
                    void run(async () => {
                      await api(path + "/" + summary.pending!.id, "DELETE");
                      await refresh();
                      setMessage("Attempt discarded.");
                    });
                  }}
                >
                  Discard unsent attempt
                </button>
              )}
            </form>
          ) : (
            !legacyOnly &&
            !closed &&
            summary.enabled && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async () => {
                    const amountLuna = toLuna(amount);
                    const wallet = await init();
                    if (getHostNetwork() !== config.network)
                      throw new Error(
                        "Open this goal in an updated Nimiq Pay app on " +
                          config.network +
                          ".",
                      );
                    const accounts = await wallet.listAccounts();
                    const intent = await api<{ id: string }>(path, "POST", {
                      amountLuna,
                      accounts,
                    });
                    setSummary({
                      ...summary,
                      pending: {
                        id: intent.id,
                        amount_luna: amountLuna,
                        tx_hash: null,
                      },
                    });
                    let txHash: string;
                    try {
                      txHash = await wallet.sendBasicTransactionWithData({
                        recipient: config.recipient,
                        value: amountLuna,
                        data: intent.id,
                      });
                    } catch (error) {
                      if (
                        NimiqProviderError.is(error) &&
                        error.type === "PERMISSION_DENIED"
                      ) {
                        await api(path + "/" + intent.id, "DELETE");
                        await refresh();
                        setMessage("Contribution canceled.");
                        return;
                      }
                      throw new Error(
                        "Check Nimiq Pay activity for the transfer. If it was sent, enter its transaction hash here.",
                      );
                    }
                    setHash(txHash);
                    await verify(intent.id, txHash);
                  });
                }}
              >
                <label>
                  Contribution amount (NIM)
                  <input
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    inputMode="decimal"
                    required
                  />
                </label>
                <button className="site-cta" type="submit" disabled={busy}>
                  Contribute with Nimiq Pay
                </button>
              </form>
            )
          )}
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api(path, "PUT", { recipient, targetLuna: toLuna(amount) });
              setAmount("");
              await refresh();
            });
          }}
        >
          <p>
            Set a NIM target and receiving address before making your first
            contribution. Both are fixed once enabled.
          </p>
          <label>
            Receiving Nimiq address
            <input
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              maxLength={48}
              required
            />
          </label>
          <label>
            Target (NIM)
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              required
            />
          </label>
          <button className="site-cta" type="submit" disabled={busy}>
            Enable NIM savings
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
