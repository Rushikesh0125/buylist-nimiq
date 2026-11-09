import { cookie, cookieValue, hash, json, session } from "./http";
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
  return null;
}
