import { z } from "zod";
import { insist, required } from "./http";
const base = "https://api-m.sandbox.paypal.com";
export function automaticSetupBody(p: {
  userId: string;
  goalName: string;
  amountCents: number;
  frequency: string;
  startDate: string;
  origin: string;
}) {
  return {
    customer: { merchant_customer_id: p.userId },
    payment_source: {
      paypal: {
        description:
          "Buylist automatic contributions · up to $" +
          (p.amountCents / 100).toFixed(2) +
          " " +
          p.frequency,
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: true,
        usage_pattern: "RECURRING_PREPAID",
        billing_plan: {
          name: (
            "Buylist: " + p.goalName.replace(/[^A-Za-z0-9() +',.:-]/g, " ")
          ).slice(0, 127),
          one_time_charges: {
            total_amount: { currency_code: "USD", value: "0.00" },
          },
          billing_cycles: [
            {
              tenure_type: "REGULAR",
              pricing_scheme: {
                pricing_model: "VARIABLE",
                price: {
                  currency_code: "USD",
                  value: (p.amountCents / 100).toFixed(2),
                },
              },
              frequency: {
                interval_unit: p.frequency === "monthly" ? "MONTH" : "WEEK",
                interval_count: p.frequency === "fortnightly" ? 2 : 1,
              },
              start_date: p.startDate,
              total_cycles: 0,
            },
          ],
        },
        experience_context: {
          brand_name: "Buylist",
          return_url: p.origin + "/#workspace",
          cancel_url: p.origin + "/#workspace",
          user_action: "SETUP_NOW",
          shipping_preference: "NO_SHIPPING",
        },
      },
    },
  };
}
const amount = z.object({
  currency_code: z.literal("USD"),
  value: z.string().regex(/^\d+\.\d{2}$/),
});
const capture = z.object({
  id: z.string(),
  status: z.string(),
  amount,
  final_capture: z.boolean().optional(),
});
// Creation defaults to PayPal's minimal representation; capture verification uses the full GET response.
export const createdOrderSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
});
export const orderSchema = z.object({
  id: z.string(),
  status: z.string(),
  purchase_units: z.array(
    z.object({
      custom_id: z.string().optional(),
      amount: amount.optional(),
      payee: z.object({ merchant_id: z.string().optional() }).optional(),
      payments: z.object({ captures: z.array(capture).optional() }).optional(),
    }),
  ),
});
export type PayPalOrder = z.infer<typeof orderSchema>;
export function parseCents(value: string) {
  insist(
    /^\d+\.\d{2}$/.test(value),
    502,
    "PROVIDER_AMOUNT",
    "PayPal returned an invalid amount.",
  );
  const [a, b] = value.split(".");
  const result = Number(a) * 100 + Number(b);
  insist(
    Number.isSafeInteger(result),
    502,
    "PROVIDER_AMOUNT",
    "PayPal amount is out of range.",
  );
  return result;
}
export async function paypal(
  env: Env,
  path: string,
  method = "GET",
  body?: unknown,
  requestId?: string,
): Promise<unknown> {
  required(env, [
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "PAYPAL_MERCHANT_ID",
  ]);
  insist(
    env.PAYPAL_MODE === "sandbox",
    503,
    "SANDBOX_ONLY",
    "Only PayPal sandbox is enabled.",
  );
  const tokenResponse = await fetch(base + "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10000),
  });
  insist(tokenResponse.ok, 502, "PAYPAL_AUTH", "PayPal authentication failed.");
  const token = z
    .object({ access_token: z.string() })
    .parse(await tokenResponse.json());
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: "Bearer " + token.access_token,
      "Content-Type": "application/json",
      ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  insist(
    response.ok,
    502,
    "PAYPAL_REQUEST",
    "PayPal could not complete the request. Its status will be reconciled before retrying.",
  );
  return response.json();
}
export function verifiedCapture(
  order: PayPalOrder,
  attempt: { id: string; amount_cents: number },
  merchantId: string,
) {
  insist(
    order.purchase_units.length === 1,
    502,
    "PAYPAL_MISMATCH",
    "Unexpected purchase units.",
  );
  const unit = order.purchase_units[0];
  insist(
    unit.custom_id === attempt.id && unit.payee?.merchant_id === merchantId,
    502,
    "PAYPAL_MISMATCH",
    "Payment recipient or reference does not match.",
  );
  const captures = unit.payments?.captures || [];
  insist(
    captures.length <= 1,
    502,
    "PAYPAL_MISMATCH",
    "Unexpected multiple captures.",
  );
  const c = captures[0];
  if (!c) return null;
  insist(
    parseCents(c.amount.value) === attempt.amount_cents,
    502,
    "PAYPAL_MISMATCH",
    "Payment amount does not match.",
  );
  return c;
}
