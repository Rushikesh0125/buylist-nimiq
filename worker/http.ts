import { HttpError, insist } from "../shared/domain";
export { HttpError, insist };
export const now = () => Math.floor(Date.now() / 1000);
export const id = () => crypto.randomUUID();
export async function hash(s: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export function random() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function jsonBody(r: Request): Promise<unknown> {
  insist(
    r.headers.get("content-type")?.includes("application/json"),
    415,
    "JSON_REQUIRED",
    "Send application/json.",
  );
  const reader = r.body?.getReader();
  insist(reader, 400, "BODY_REQUIRED", "Request body required.");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > 32768) {
      await reader.cancel();
      throw new HttpError(413, "BODY_TOO_LARGE", "Request too large.");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(all));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON.");
  }
}
export function json(value: unknown, status = 200, headers: HeadersInit = {}) {
  const h = new Headers(headers);
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  return Response.json(value, { status, headers: h });
}
export function cookie(r: Request, name: string) {
  return (r.headers.get("cookie") || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + "="))
    ?.slice(name.length + 1);
}
export function cookieValue(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function origin(r: Request, env: Env) {
  insist(
    new URL(r.url).origin === env.APP_ORIGIN,
    400,
    "WRONG_HOST",
    "Use the configured application URL.",
  );
  insist(
    r.headers.get("Origin") === env.APP_ORIGIN,
    403,
    "ORIGIN_REJECTED",
    "Request origin is not allowed.",
  );
}
export async function session(r: Request, env: Env, mutation = false) {
  const token = cookie(r, "__Host-buylist");
  insist(token, 401, "LOGIN_REQUIRED", "Sign in to continue.");
  const user = await env.DB.prepare(
    "SELECT u.id,u.email,u.name,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
  )
    .bind(await hash(token), now())
    .first<{ id: string; email: string; name: string; csrf: string }>();
  insist(user, 401, "SESSION_EXPIRED", "Sign in again.");
  if (mutation) {
    origin(r, env);
    insist(
      r.headers.get("X-CSRF-Token") === user.csrf,
      403,
      "CSRF_REJECTED",
      "Refresh your session and try again.",
    );
  }
  return user;
}
export async function member(
  env: Env,
  goalId: string,
  userId: string,
  owner = false,
) {
  const row = await env.DB.prepare(
    "SELECT g.*,m.role FROM goals g JOIN memberships m ON m.goal_id=g.id WHERE g.id=? AND m.user_id=?",
  )
    .bind(goalId, userId)
    .first<GoalRow>();
  insist(row, 404, "GOAL_NOT_FOUND", "Goal not found.");
  if (owner)
    insist(
      row.role === "owner",
      403,
      "OWNER_REQUIRED",
      "Only the owner can change this.",
    );
  return row;
}
export type GoalRow = {
  id: string;
  owner_id: string;
  name: string;
  target_cents: number;
  currency: string;
  mode: "solo" | "fixed" | "flexible";
  timezone: string;
  version: number;
  purchased: number;
  product_json: string | null;
  role: string;
};
export async function balance(env: Env, goalId: string) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS total FROM ledger WHERE goal_id=?",
  )
    .bind(goalId)
    .first<{ total: number }>();
  return row?.total || 0;
}
export function required(env: Env, keys: (keyof Env)[]) {
  const missing = keys.filter((k) => !env[k]);
  insist(
    !missing.length,
    503,
    "INTEGRATION_NOT_CONFIGURED",
    `Integration needs setup: ${missing.join(", ")}.`,
  );
}
