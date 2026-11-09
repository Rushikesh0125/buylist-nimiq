import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  cookie,
  cookieValue,
  hash,
  id,
  insist,
  json,
  now,
  random,
  required,
  session,
} from "./http";
const keys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
export async function auth(
  r: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === "/api/auth/session" && r.method === "GET") {
    try {
      const user = await session(r, env);
      return json({
        user: { id: user.id, email: user.email, name: user.name },
        csrfToken: user.csrf,
      });
    } catch (e) {
      if (e instanceof Error && "status" in e && e.status === 401)
        return json({ user: null });
      throw e;
    }
  }
  if (path === "/api/auth/logout" && r.method === "POST") {
    await session(r, env, true);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
      .bind(await hash(cookie(r, "__Host-buylist")!))
      .run();
    return json({ ok: true }, 200, {
      "Set-Cookie": cookieValue("__Host-buylist", "", 0),
    });
  }
  if (path === "/api/auth/google/start" && r.method === "GET") {
    required(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    insist(
      new URL(r.url).origin === env.APP_ORIGIN,
      400,
      "WRONG_HOST",
      "Use the configured application URL.",
    );
    const state = random(),
      nonce = random(),
      verifier = random();
    const challenge = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
          ),
        ),
      ),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    await env.DB.prepare(
      "INSERT INTO oauth_states(state_hash,verifier,nonce,expires_at) VALUES(?,?,?,?)",
    )
      .bind(await hash(state), verifier, nonce, now() + 600)
      .run();
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    u.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: env.APP_ORIGIN + "/api/auth/google/callback",
      response_type: "code",
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: {
        Location: u.href,
        "Set-Cookie": cookieValue("__Host-buylist-oauth", state, 600),
        "Cache-Control": "no-store",
      },
    });
  }
  if (path === "/api/auth/google/callback" && r.method === "GET") {
    required(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    const u = new URL(r.url),
      state = u.searchParams.get("state"),
      code = u.searchParams.get("code");
    insist(
      state && code && state === cookie(r, "__Host-buylist-oauth"),
      400,
      "OAUTH_STATE",
      "Login expired or was cancelled.",
    );
    const flow = await env.DB.prepare(
      "DELETE FROM oauth_states WHERE state_hash=? AND expires_at>? RETURNING verifier,nonce",
    )
      .bind(await hash(state), now())
      .first<{ verifier: string; nonce: string }>();
    insist(flow, 400, "OAUTH_EXPIRED", "Restart sign-in.");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: env.APP_ORIGIN + "/api/auth/google/callback",
        grant_type: "authorization_code",
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    insist(res.ok, 502, "OAUTH_EXCHANGE", "Google sign-in could not complete.");
    const data = (await res.json()) as { id_token: string };
    const { payload } = await jwtVerify(data.id_token, keys, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ["RS256"],
    });
    insist(
      payload.nonce === flow.nonce &&
        payload.sub &&
        typeof payload.email === "string" &&
        payload.email_verified === true,
      401,
      "OAUTH_IDENTITY",
      "Google identity verification failed.",
    );
    const uid = id();
    await env.DB.prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,name=excluded.name",
    )
      .bind(
        uid,
        payload.sub,
        payload.email,
        typeof payload.name === "string" ? payload.name : payload.email,
        now(),
      )
      .run();
    const user = await env.DB.prepare("SELECT id FROM users WHERE google_sub=?")
      .bind(payload.sub)
      .first<{ id: string }>();
    insist(user, 500, "USER_CREATE", "Could not create user.");
    const token = random();
    await env.DB.prepare(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
    )
      .bind(await hash(token), user.id, random(), now() + 7 * 86400)
      .run();
    const headers = new Headers({
      Location: env.APP_ORIGIN + "/#workspace",
      "Cache-Control": "no-store",
    });
    headers.append(
      "Set-Cookie",
      cookieValue("__Host-buylist", token, 7 * 86400),
    );
    headers.append("Set-Cookie", cookieValue("__Host-buylist-oauth", "", 0));
    return new Response(null, { status: 302, headers });
  }
  return null;
}
