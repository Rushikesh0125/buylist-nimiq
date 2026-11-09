import { ZodError } from "zod";
import { auth } from "./auth";
import { goals } from "./goals";
import { products } from "./products";
import { assistant } from "./assistant";
import { coordinator, paymentRoutes, processEvent } from "./payments";
import { HttpError, hash, id, json, now } from "./http";
import { automaticRoutes } from "./automatic";
import { refundRoutes } from "./refunds";
import { nimiqRoutes } from "./nimiq";
import { nimiqAuth } from "./nimiq-auth";
export { GoalCoordinator } from "./payments";
export default {
  async fetch(r: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(r.url).pathname;
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(r);
    const requestId = id();
    try {
      if (path === "/api/health")
        return json({
          status: "ok",
          environment: env.ENVIRONMENT,
          sandbox: true,
        });
      if (path === "/api/config")
        return json({
          nimiqEnabled: !!env.NIMIQ_RPC_URL &&
            (env.NIMIQ_NETWORK === "mainnet" || env.NIMIQ_NETWORK === "testnet"),
          googleConfigured: !!(
            env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ),
          channel3Configured: !!env.CHANNEL3_API_KEY,
          paypalConfigured: !!(
            env.PAYPAL_CLIENT_ID &&
            env.PAYPAL_CLIENT_SECRET &&
            env.PAYPAL_MERCHANT_ID
          ),
          paymentsEnabled: String(env.PAYMENTS_ENABLED) === "true",
          bryntumEnabled: String(env.BRYNTUM_LICENSE_CONFIRMED) === "true",
        });
      if (path !== "/api/webhooks/paypal") {
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
        automaticRoutes,
        refundRoutes,
        nimiqRoutes,
        paymentRoutes,
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
  async queue(
    batch: MessageBatch<{
      eventId?: string;
      attemptId?: string;
      goalId?: string;
      planId?: string;
      refundId?: string;
    }>,
    env: Env,
  ) {
    for (const m of batch.messages) {
      try {
        if (m.body.eventId) await processEvent(env, m.body.eventId);
        else if (m.body.planId && m.body.goalId)
          await coordinator(env, m.body.goalId).runAutomatic(m.body.planId);
        else if (m.body.refundId && m.body.goalId)
          await coordinator(env, m.body.goalId).reconcileRefund(
            m.body.refundId,
          );
        else if (m.body.attemptId && m.body.goalId)
          await coordinator(env, m.body.goalId).reconcile(m.body.attemptId);
        m.ack();
      } catch {
        m.retry({ delaySeconds: 60 });
      }
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM request_limits WHERE expires_at<?").bind(
            now(),
          ),
          env.DB.prepare("DELETE FROM sessions WHERE expires_at<?").bind(now()),
          env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<?").bind(
            now(),
          ),
          env.DB.prepare(
            "UPDATE payment_attempts SET status='cancelled',reserved=0,updated_at=? WHERE status IN ('created','awaiting_approval') AND created_at<? AND NOT EXISTS(SELECT 1 FROM automatic_cycles WHERE attempt_id=payment_attempts.id)",
          ).bind(now(), now() - 1800),
        ]);
        const attempts = (
          await env.DB.prepare(
            "SELECT id,goal_id FROM payment_attempts WHERE status IN ('capture_pending','awaiting_approval') AND order_id IS NOT NULL ORDER BY updated_at LIMIT 100",
          ).all<{ id: string; goal_id: string }>()
        ).results;
        for (const a of attempts)
          await env.RECONCILE.send({ attemptId: a.id, goalId: a.goal_id });
        const events = (
          await env.DB.prepare(
            "SELECT id FROM provider_events WHERE processed_at IS NULL ORDER BY received_at LIMIT 100",
          ).all<{ id: string }>()
        ).results;
        for (const e of events) await env.RECONCILE.send({ eventId: e.id });
        const plans = (
          await env.DB.prepare(
            "SELECT id,goal_id FROM automatic_plans WHERE state='active' ORDER BY updated_at LIMIT 100",
          ).all<{ id: string; goal_id: string }>()
        ).results;
        for (const p of plans)
          await env.RECONCILE.send({ planId: p.id, goalId: p.goal_id });
        const refunds = (
          await env.DB.prepare(
            "SELECT r.id,a.goal_id FROM refund_requests r JOIN payment_attempts a ON a.id=r.attempt_id WHERE r.state IN ('created','pending') ORDER BY r.updated_at LIMIT 100",
          ).all<{ id: string; goal_id: string }>()
        ).results;
        for (const r of refunds)
          await env.RECONCILE.send({ refundId: r.id, goalId: r.goal_id });
      })(),
    );
  },
} satisfies ExportedHandler<
  Env,
  {
    eventId?: string;
    attemptId?: string;
    goalId?: string;
    planId?: string;
    refundId?: string;
  }
>;
