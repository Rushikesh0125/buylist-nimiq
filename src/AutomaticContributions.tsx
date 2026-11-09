import { useEffect, useRef, useState } from "react";
import { PayPalButtons, PayPalScriptProvider } from "@paypal/react-paypal-js";
import { api, inputCents, usd, type PersonalPlan } from "./api";
import { dateInTimezone } from "../shared/automatic";

type Plan = {
  id: string;
  amountCents: number;
  frequency: string;
  startDate: string;
  nextDate: string;
  timezone: string;
  state: string;
  reason: string | null;
  targetCents: number;
  limitCents: number;
};
export default function AutomaticContributions({
  goalId,
  timezone,
  clientId,
  enabled,
  saved,
  onChange,
}: {
  goalId: string;
  timezone: string;
  clientId: string | null;
  enabled: boolean;
  saved: PersonalPlan | null | undefined;
  onChange: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [consent, setConsent] = useState(false);
  const [amount, setAmount] = useState(
      String((saved?.amount_cents || 2500) / 100),
    ),
    [frequency, setFrequency] = useState(saved?.frequency || "weekly"),
    [start, setStart] = useState(dateInTimezone(timezone));
  const requestKey = useRef(crypto.randomUUID());
  const reload = async () =>
    setPlan(
      (await api<{ plan: Plan | null }>("/api/goals/" + goalId + "/automatic"))
        .plan,
    );
  useEffect(() => {
    let current = true;
    void api<{ plan: Plan | null }>("/api/goals/" + goalId + "/automatic")
      .then((r) => {
        if (current) setPlan(r.plan);
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [goalId]);
  const action = async (name: string) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/goals/" + goalId + "/automatic/" + name, "POST", {});
      await reload();
      setEditing(false);
      setConsent(false);
      onChange();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not update automatic contributions.",
      );
    } finally {
      setBusy(false);
    }
  };
  const live = plan && !["cancelled", "finished"].includes(plan.state);
  return (
    <section className="automatic-card" aria-label="Automatic contributions">
      <div className="automatic-heading">
        <div>
          <span className="eyebrow">YOUR PACE, AUTOMATICALLY</span>
          <h3>Automatic contributions</h3>
        </div>
        {live && (
          <span className="automatic-state">
            {plan.state === "pending" ? "Awaiting approval" : plan.state}
          </span>
        )}
      </div>
      {loading ? (
        <p role="status">Loading payment preferences…</p>
      ) : (
        <>
          {live && (
            <>
              <strong>
                {usd(plan.amountCents)} <small>{plan.frequency}</small>
              </strong>
              <p>
                {plan.state === "active"
                  ? "Next contribution: " +
                    plan.nextDate +
                    " · " +
                    plan.timezone
                  : plan.reason ||
                    "No new automatic contributions will start until this plan is active."}
              </p>
              <div className="automatic-actions">
                {plan.state === "active" && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void action("pause")}
                  >
                    Pause
                  </button>
                )}
                {plan.state === "paused" && (
                  <button
                    className="secondary"
                    disabled={busy || !enabled}
                    onClick={() => void action("resume")}
                  >
                    Resume contributions
                  </button>
                )}
                <button
                  className="text-action"
                  disabled={busy}
                  onClick={() => void action("cancel")}
                >
                  Cancel automatic plan
                </button>
              </div>
              <p className="automatic-note">
                Authorized goal target: {usd(plan.targetCents)}. Your
                contribution cap: {usd(plan.limitCents)}. Changes to your saved
                schedule do not change this authorization. A payment already
                started may still complete.
              </p>
            </>
          )}
          {!live && !editing && (
            <>
              <p>
                Choose an amount and let PayPal contribute on your behalf.
                Always optional.
              </p>
              <button
                className="secondary"
                disabled={!enabled || !clientId || busy}
                onClick={() => {
                  setEditing(true);
                  requestKey.current = crypto.randomUUID();
                }}
              >
                Set up automatic contributions
              </button>
            </>
          )}
          {editing && !live && (
            <div className="automatic-form">
              <label>
                Maximum per contribution (USD)
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={consent}
                />
              </label>
              <div className="automatic-fields">
                <label>
                  Frequency
                  <select
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value)}
                    disabled={consent}
                  >
                    <option value="weekly">Weekly</option>
                    <option value="fortnightly">Fortnightly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </label>
                <label>
                  First contribution
                  <input
                    type="date"
                    min={dateInTimezone(timezone)}
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    disabled={consent}
                  />
                </label>
              </div>
              <p>
                Up to{" "}
                {inputCents(amount)
                  ? usd(inputCents(amount)!)
                  : "your chosen amount"}{" "}
                {frequency}, starting {start} ({timezone}). The final
                contribution may be smaller. Stops at the goal target or your
                remaining fixed share. Missed dates are skipped.
              </p>
              <label className="automatic-consent">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={!inputCents(amount) || !start}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  I authorize Buylist to charge my saved PayPal payment method
                  under these terms. I can pause or cancel future contributions.
                </span>
              </label>
              {consent && clientId && (
                <PayPalScriptProvider
                  options={{
                    clientId,
                    components: "buttons",
                    vault: true,
                    intent: "token",
                    dataNamespace: "paypalVault",
                  }}
                >
                  <PayPalButtons
                    fundingSource="paypal"
                    createVaultSetupToken={async () => {
                      setError("");
                      try {
                        const result = await api<{ setupToken: string }>(
                          "/api/goals/" + goalId + "/automatic/setup",
                          "POST",
                          {
                            amountCents: inputCents(amount),
                            frequency,
                            startDate: start,
                            consent: true,
                            requestKey: requestKey.current,
                          },
                        );
                        return result.setupToken;
                      } catch (e) {
                        setError(
                          e instanceof Error
                            ? e.message
                            : "Could not start PayPal authorization.",
                        );
                        throw e;
                      }
                    }}
                    onApprove={async (data) => {
                      setBusy(true);
                      try {
                        if (!data.vaultSetupToken)
                          throw new Error(
                            "PayPal did not return an approved setup token.",
                          );
                        await api(
                          "/api/goals/" + goalId + "/automatic/approve",
                          "POST",
                          { setupToken: data.vaultSetupToken },
                        );
                        await reload();
                        setEditing(false);
                        onChange();
                      } catch (e) {
                        setError(
                          e instanceof Error
                            ? e.message
                            : "Could not confirm authorization.",
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                    onCancel={() => {
                      setConsent(false);
                      void reload();
                    }}
                    onError={() => {
                      setError(
                        (previous) =>
                          previous ||
                          "PayPal authorization could not finish. Try again or cancel the pending setup.",
                      );
                      void reload();
                    }}
                  />
                </PayPalScriptProvider>
              )}
              <button
                className="text-action"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setConsent(false);
                  void reload();
                }}
              >
                Close setup
              </button>
            </div>
          )}
          <p className="automatic-note">PayPal sandbox · test funds only.</p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
