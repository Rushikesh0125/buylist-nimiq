import { useRef, useState } from "react";
import { api, inputCents, usd } from "./api";

export default function RefundContribution({
  paymentId,
  availableCents,
  onChange,
}: {
  paymentId: string;
  availableCents: number;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false),
    [amount, setAmount] = useState(String(availableCents / 100)),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  return (
    <div className="refund-control">
      {!editing ? (
        <button
          className="text-action"
          disabled={busy}
          onClick={() => {
            setAmount(String(availableCents / 100));
            key.current = crypto.randomUUID();
            setEditing(true);
            setMessage("");
            setError("");
          }}
        >
          Refund contribution
        </button>
      ) : (
        <div className="refund-review">
          <label>
            Refund amount (USD)
            <input
              inputMode="decimal"
              value={amount}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <p>
            Up to {usd(availableCents)} will return through the original PayPal
            payment. Your automatic plan will pause.
          </p>
          <button
            className="secondary"
            disabled={
              busy ||
              !inputCents(amount) ||
              inputCents(amount)! > availableCents
            }
            onClick={() => {
              setBusy(true);
              setError("");
              void api<{ status: string }>(
                "/api/payments/" + paymentId + "/refunds",
                "POST",
                { amountCents: inputCents(amount), requestKey: key.current },
              )
                .then((r) => {
                  setMessage(
                    r.status === "completed"
                      ? "Refund confirmed."
                      : "Refund pending. Your balance updates after PayPal confirms it.",
                  );
                  setEditing(false);
                  onChange();
                })
                .catch((e) => {
                  setError(e.message);
                  onChange();
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy
              ? "Processing…"
              : "Confirm refund " +
                (inputCents(amount) ? usd(inputCents(amount)!) : "")}
          </button>
          <button
            className="text-action"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
