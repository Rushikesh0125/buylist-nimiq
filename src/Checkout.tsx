import { useRef, useState } from "react";
import { PayPalScriptProvider, PayPalButtons } from "@paypal/react-paypal-js";
import { api, usd } from "./api";
export default function Checkout({
  goalId,
  amountCents,
  clientId,
  onComplete,
}: {
  goalId: string;
  amountCents: number;
  clientId: string;
  onComplete: () => void;
}) {
  const key = useRef(crypto.randomUUID()),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  return (
    <section className="checkout-panel">
      <h3>Contribute {usd(amountCents)}</h3>
      <p>PayPal sandbox · test funds only.</p>
      {error && <p role="alert">{error}</p>}
      {status && <p role="status">{status}</p>}
      <PayPalScriptProvider
        options={{
          clientId,
          currency: "USD",
          intent: "capture",
          components: "buttons",
        }}
      >
        <PayPalButtons
          createOrder={async () => {
            setError("");
            try {
              const order = await api<{ orderId: string }>(
                "/api/payments/orders",
                "POST",
                { goalId, amountCents, requestKey: key.current },
              );
              return order.orderId;
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not create order.",
              );
              throw e;
            }
          }}
          onApprove={async (data) => {
            try {
              setStatus("Verifying payment…");
              const result = await api<{ status: string }>(
                "/api/payments/orders/" + data.orderID + "/capture",
                "POST",
                {},
              );
              setStatus(
                result.status === "completed"
                  ? "Payment confirmed."
                  : "Payment pending. Your balance updates after confirmation.",
              );
              onComplete();
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : "Payment status could not be confirmed.",
              );
              setStatus(
                "Do not pay again while this payment is being reconciled.",
              );
            }
          }}
          onCancel={() =>
            setStatus("Approval cancelled. No contribution was recorded.")
          }
          onError={() =>
            setError(
              (previous) =>
                previous ||
                "PayPal could not complete checkout. Check activity before retrying.",
            )
          }
        />
      </PayPalScriptProvider>
    </section>
  );
}
