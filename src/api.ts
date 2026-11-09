export type User = { id: string; name: string; email: string };
export type Config = {
  nimiqEnabled: boolean;
  googleConfigured: boolean;
  channel3Configured: boolean;
  paypalConfigured: boolean;
  paymentsEnabled: boolean;
  bryntumEnabled: boolean;
};
export type Goal = {
  id: string;
  name: string;
  target_cents: number;
  saved_cents: number;
  mode: "solo" | "fixed" | "flexible";
  timezone: string;
  version: number;
  purchased: number;
  role: string;
  product_json: string | null;
};
export type Product = {
  id: string;
  title: string;
  imageUrl: string | null;
  priceCents: number | null;
  currency: string | null;
  merchantUrl: string | null;
  merchant: string | null;
  available: boolean;
  observedAt: number;
  offers: {
    url: string;
    priceCents: number;
    currency: string;
    merchant: string;
    available: boolean;
  }[];
};
export type Member = {
  id: string;
  name: string;
  role: string;
  shareCents: number | null;
};
export type EventRow = {
  id: string;
  user_id: string;
  name: string;
  date: string;
  amount_cents: number;
  version: number;
  capture_id: string | null;
  state?: import("../shared/planner").PlannerState;
  editable?: boolean;
};
export type Schedule = {
  events: EventRow[];
  mode: string;
  commitment: {
    version: number;
    amount_cents: number;
    frequency: string;
    start_date: string;
  } | null;
};
export type PersonalPlan = NonNullable<Schedule["commitment"]>;
export type Detail = {
  goal: Goal;
  members: Member[];
  commitments: unknown[];
  ledger: {
    user_id: string;
    amount_cents: number;
    kind: string;
    created_at: number;
  }[];
};
let csrf = "";
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const content = r.headers.get("content-type") || "";
  if (!content.includes("application/json"))
    throw new ApiError(
      "API_UNAVAILABLE",
      "The API is not running. Open the Cloudflare Worker preview.",
      503,
    );
  const data = await r.json();
  if (!r.ok)
    throw new ApiError(
      data.error?.code || "REQUEST_FAILED",
      data.error?.message || "Request failed.",
      r.status,
    );
  return data as T;
}
export async function loadSession() {
  const result = await api<{ user: User | null; csrfToken?: string }>(
    "/api/auth/session",
  );
  csrf = result.csrfToken || "";
  return result.user;
}
export const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export function inputCents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [a, b = ""] = value.split(".");
  const n = Number(a) * 100 + Number(b.padEnd(2, "0"));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
