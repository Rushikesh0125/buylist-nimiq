import { z } from "zod";
import {
  cookie,
  cookieValue,
  hash,
  id,
  insist,
  json,
  jsonBody,
  now,
  origin,
  random,
} from "./http";

const proof = z.object({
  publicKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .transform((value) => value.toLowerCase()),
  signature: z.string().regex(/^[a-f0-9]{128}$/i),
});
const challengeCookie = "__Host-buylist-nimiq";
const message = (origin: string, nonce: string) =>
  "Sign in to Buylist at " + origin + "\n\nChallenge: " + nonce;
const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));

export async function nimiqAuth(request: Request, env: Env, path: string) {
  if (
    request.method !== "POST" ||
    !["/api/auth/nimiq/start", "/api/auth/nimiq/verify"].includes(path)
  )
    return;
  origin(request, env);
  insist(
    env.NIMIQ_RPC_URL &&
      (env.NIMIQ_NETWORK === "mainnet" || env.NIMIQ_NETWORK === "testnet"),
    503,
    "NIMIQ_DISABLED",
    "Nimiq sign-in is unavailable.",
  );
  if (path.endsWith("/start")) {
    const nonce = random();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM nimiq_signin WHERE expires_at<=?").bind(
        now(),
      ),
      env.DB.prepare(
        "INSERT INTO nimiq_signin(token_hash,expires_at) VALUES(?,?)",
      ).bind(await hash(nonce), now() + 300),
    ]);
    return json({ message: message(env.APP_ORIGIN, nonce) }, 200, {
      "Set-Cookie": cookieValue(challengeCookie, nonce, 300),
    });
  }

  const nonce = cookie(request, challengeCookie);
  insist(
    nonce && /^[a-zA-Z0-9_-]{43}$/.test(nonce),
    401,
    "NIMIQ_CHALLENGE",
    "Start a new wallet sign-in.",
  );
  const { publicKey, signature } = proof.parse(await jsonBody(request));
  const text = message(env.APP_ORIGIN, nonce);
  const encoder = new TextEncoder();
  // Match the Nimiq Pay host's domain prefix and UTF-8 byte count.
  const prefixed = encoder.encode(
    "\x16Nimiq Signed Message:\n" + encoder.encode(text).byteLength + text,
  );
  const digest = await crypto.subtle.digest("SHA-256", prefixed);
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(publicKey),
    "Ed25519",
    false,
    ["verify"],
  );
  insist(
    await crypto.subtle.verify("Ed25519", key, bytes(signature), digest),
    401,
    "NIMIQ_SIGNATURE",
    "Wallet signature verification failed.",
  );

  const consumed = await env.DB.prepare(
    "DELETE FROM nimiq_signin WHERE token_hash=? AND expires_at>?",
  )
    .bind(await hash(nonce), now())
    .run();
  insist(
    consumed.meta.changes === 1,
    401,
    "NIMIQ_CHALLENGE",
    "Start a new wallet sign-in.",
  );

  const subject = "nimiq:" + publicKey;
  await env.DB.prepare(
    "INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?) ON CONFLICT(google_sub) DO NOTHING",
  )
    .bind(id(), subject, "", "Nimiq " + publicKey.slice(0, 8), now())
    .run();
  const user = await env.DB.prepare("SELECT id FROM users WHERE google_sub=?")
    .bind(subject)
    .first<{ id: string }>();
  insist(user, 500, "USER_CREATE", "Could not create user.");
  const token = random();
  const age = 7 * 86400;
  await env.DB.prepare(
    "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
  )
    .bind(await hash(token), user.id, random(), now() + age)
    .run();
  const headers = new Headers();
  headers.append("Set-Cookie", cookieValue("__Host-buylist", token, age));
  headers.append("Set-Cookie", cookieValue(challengeCookie, "", 0));
  return json({ ok: true }, 200, headers);
}
