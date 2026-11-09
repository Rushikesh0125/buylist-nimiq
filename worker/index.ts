import { ZodError } from "zod";
import { auth } from "./auth";
import { goals } from "./goals";
import { products } from "./products";
import { assistant } from "./assistant";
import { HttpError, hash, id, json, now } from "./http";
import { nimiqRoutes } from "./nimiq";
import { nimiqAuth } from "./nimiq-auth";
export default {
  async fetch(r: Request, env: Env) {
    const path = new URL(r.url).pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(r);
    const requestId = id();
    try {
      if (path === "/api/health")
        return json({
          status: "ok",
          environment: env.ENVIRONMENT,
        });
      if (path === "/api/config")
        return json({
          nimiqEnabled:
            !!env.NIMIQ_RPC_URL &&
            (env.NIMIQ_NETWORK === "mainnet" ||
              env.NIMIQ_NETWORK === "testnet"),
          channel3Configured: !!env.CHANNEL3_API_KEY,
          bryntumEnabled: String(env.BRYNTUM_LICENSE_CONFIRMED) === "true",
        });
      {
        const bucket = await hash(
          (r.headers.get("CF-Connecting-IP") || "local") +
            ":" +
            path.split("/").slice(0, 3).join("/") +
            ":" +
            Math.floor(now() / 60),
        );
        const count = await env.DB.prepare(
          "INSERT INTO request_limits(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count",
        )
          .bind(bucket, now() + 120)
          .first<{ count: number }>();
        if ((count?.count || 0) > 60)
          return json(
            {
              error: {
                code: "RATE_LIMITED",
                message: "Too many requests. Try again shortly.",
                requestId,
              },
            },
            429,
            { "Retry-After": "60" },
          );
      }
      for (const handler of [
        auth,
        nimiqAuth,
        goals,
        products,
        assistant,
        nimiqRoutes,
      ]) {
        const response = await handler(r, env, path);
        if (response) {
          response.headers.set("X-Request-Id", requestId);
          return response;
        }
      }
      return json(
        {
          error: {
            code: "NOT_FOUND",
            message: "API route not found.",
            requestId,
          },
        },
        404,
      );
    } catch (e) {
      const status =
        e instanceof HttpError ? e.status : e instanceof ZodError ? 400 : 502;
      console.error(
        JSON.stringify({
          requestId,
          path: path.replace(/(\/api\/invitations\/)[^/]+/, "$1[redacted]"),
          status,
          code:
            e instanceof HttpError
              ? e.code
              : e instanceof ZodError
                ? "VALIDATION"
                : "PROVIDER_OR_INTERNAL_ERROR",
        }),
      );
      return json(
        {
          error: {
            code:
              e instanceof HttpError
                ? e.code
                : e instanceof ZodError
                  ? "VALIDATION"
                  : "SERVICE_UNAVAILABLE",
            message:
              e instanceof HttpError
                ? e.message
                : e instanceof ZodError
                  ? "Request data is invalid."
                  : "The service could not complete this request. Please try again.",
            requestId,
          },
        },
        status,
      );
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    const cutoff = now();
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare("DELETE FROM request_limits WHERE expires_at<?").bind(
          cutoff,
        ),
        env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(cutoff),
        env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(
          cutoff,
        ),
        env.DB.prepare("DELETE FROM nimiq_signin WHERE expires_at<?").bind(
          cutoff,
        ),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
