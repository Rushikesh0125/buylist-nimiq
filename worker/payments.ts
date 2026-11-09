import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { cents } from "../shared/domain";
import {
  balance,
  HttpError,
  id,
  insist,
  json,
  jsonBody,
  member,
  now,
  required,
  session,
} from "./http";
import {
  createdOrderSchema,
  orderSchema,
  paypal,
  parseCents,
  verifiedCapture,
} from "./paypal";
import { runAutomatic } from "./automatic";
import { applyRefund, executeRefund, requestRefund } from "./refunds";
type Attempt = {
  id: string;
  goal_id: string;
  user_id: string;
  amount_cents: number;
  order_id: string | null;
  capture_id: string | null;
  status: string;
  created_at: number;
};
export class GoalCoordinator extends DurableObject<Env> {
  async reserve(
    goalId: string,
    userId: string,
    amountCents: number,
    requestKey: string,
    limits?: { target: number; member: number },
  ) {
    const existing = await this.env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE user_id=? AND request_key=?",
    )
      .bind(userId, requestKey)
      .first<Attempt>();
    if (existing) {
      insist(
        existing.goal_id === goalId && existing.amount_cents === amountCents,
        409,
        "KEY_REUSED",
        "This request key was used for another payment.",
      );
      return existing;
    }
    const g = await member(this.env, goalId, userId);
    insist(!g.purchased, 409, "GOAL_CLOSED", "This goal is already purchased.");
    cents(amountCents);
    const attemptId = id();
    const result = await this.env.DB.prepare(
      `INSERT INTO payment_attempts(id,goal_id,user_id,request_key,amount_cents,currency,status,created_at,updated_at)
 SELECT ?,?,?,?,?,'USD','created',?,? WHERE ? <= MIN((SELECT target_cents FROM goals WHERE id=?),?) - COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE goal_id=?),0) - COALESCE((SELECT SUM(amount_cents) FROM payment_attempts WHERE goal_id=? AND reserved=1),0)
 AND ? <= ? - COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE goal_id=? AND user_id=?),0) - COALESCE((SELECT SUM(amount_cents) FROM payment_attempts WHERE goal_id=? AND user_id=? AND reserved=1),0)
 ON CONFLICT(user_id,request_key) DO NOTHING`,
    )
      .bind(
        attemptId,
        goalId,
        userId,
        requestKey,
        amountCents,
        now(),
        now(),
        amountCents,
        goalId,
        limits?.target || 100_000_000,
        goalId,
        goalId,
        amountCents,
        limits?.member || 100_000_000,
        goalId,
        userId,
        goalId,
        userId,
      )
      .run();
    if (result.meta.changes === 0) {
      const retry = await this.env.DB.prepare(
        "SELECT * FROM payment_attempts WHERE user_id=? AND request_key=?",
      )
        .bind(userId, requestKey)
        .first<Attempt>();
      if (retry) {
        insist(
          retry.goal_id === goalId && retry.amount_cents === amountCents,
          409,
          "KEY_REUSED",
          "Request key was reused with different payment data.",
        );
        return retry;
      }
    }
    insist(
      result.meta.changes === 1,
      409,
      "TARGET_RESERVED",
      "This amount exceeds the unreserved target. Refresh the goal.",
    );
    return (await this.env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE id=?",
    )
      .bind(attemptId)
      .first<Attempt>())!;
  }
  async create(
    goalId: string,
    userId: string,
    amountCents: number,
    requestKey: string,
    vaultId?: string,
    limits?: { target: number; member: number },
  ) {
    required(this.env, [
      "PAYPAL_CLIENT_ID",
      "PAYPAL_CLIENT_SECRET",
      "PAYPAL_MERCHANT_ID",
    ]);
    insist(
      String(this.env.PAYMENTS_ENABLED) === "true",
      503,
      "PAYMENTS_PAUSED",
      "Sandbox payment collection is paused.",
    );
    const a = await this.reserve(
      goalId,
      userId,
      amountCents,
      requestKey,
      limits,
    );
    if (a.order_id)
      return { attemptId: a.id, orderId: a.order_id, status: a.status };
    insist(
      a.status === "created",
      409,
      "PAYMENT_STATE",
      "This order attempt is no longer active.",
    );
    insist(
      now() - a.created_at < 6 * 3600,
      409,
      "PAYMENT_REVIEW_REQUIRED",
      "This uncertain order needs reconciliation before retrying.",
    );
    if (vaultId) {
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE payment_attempts SET status='capture_pending',updated_at=? WHERE id=? AND status='created'",
        ).bind(now(), a.id),
        this.env.DB.prepare(
          "UPDATE automatic_cycles SET attempt_id=? WHERE request_key=?",
        ).bind(a.id, requestKey),
      ]);
    }
    const o = createdOrderSchema.parse(
      await paypal(
        this.env,
        "/v2/checkout/orders",
        "POST",
        {
          intent: "CAPTURE",
          ...(vaultId
            ? {
                payment_source: {
                  paypal: {
                    vault_id: vaultId,
                    stored_credential: {
                      payment_initiator: "MERCHANT",
                      usage: "SUBSEQUENT",
                      usage_pattern: "RECURRING_PREPAID",
                    },
                  },
                },
              }
            : {}),
          purchase_units: [
            {
              custom_id: a.id,
              amount: {
                currency_code: "USD",
                value: (amountCents / 100).toFixed(2),
              },
              payee: { merchant_id: this.env.PAYPAL_MERCHANT_ID },
            },
          ],
        },
        a.id + "-create",
      ),
    );
    await this.env.DB.prepare(
      "UPDATE payment_attempts SET order_id=?,status=?,updated_at=? WHERE id=? AND order_id IS NULL AND status IN ('created','capture_pending') AND reserved=1",
    )
      .bind(
        o.id,
        vaultId ? "capture_pending" : "awaiting_approval",
        now(),
        a.id,
      )
      .run();
    return { attemptId: a.id, orderId: o.id, status: "awaiting_approval" };
  }
  async runAutomatic(planId: string) {
    return runAutomatic(this.env, this, planId);
  }
  async refund(
    attemptId: string,
    userId: string,
    amountCents: number,
    requestKey: string,
  ) {
    try {
      return await requestRefund(
        this.env,
        this,
        attemptId,
        userId,
        amountCents,
        requestKey,
      );
    } catch (e) {
      if (e instanceof HttpError)
        return {
          error: { status: e.status, code: e.code, message: e.message },
        };
      throw e;
    }
  }
  async reconcileRefund(refundId: string) {
    return executeRefund(this.env, this, refundId);
  }
  async applyRefund(refundId: string, captureId: string) {
    return applyRefund(this.env, this, refundId, captureId);
  }
  async capture(orderId: string, userId: string) {
    const a = await this.env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE order_id=? AND user_id=?",
    )
      .bind(orderId, userId)
      .first<Attempt>();
    insist(a, 404, "PAYMENT_NOT_FOUND", "Payment not found.");
    await member(this.env, a.goal_id, userId);
    if (a.status === "completed") return { status: a.status };
    insist(
      ["awaiting_approval", "capture_pending"].includes(a.status),
      409,
      "PAYMENT_STATE",
      "Payment cannot be captured in its current state.",
    );
    const started = await this.env.DB.prepare(
      "UPDATE payment_attempts SET status='capture_pending',updated_at=? WHERE id=? AND status IN ('awaiting_approval','capture_pending') AND reserved=1",
    )
      .bind(now(), a.id)
      .run();
    insist(
      started.meta.changes === 1,
      409,
      "PAYMENT_STATE",
      "Payment is no longer reserved.",
    );
    // A retry uses the original capture key. Never release a reservation after an uncertain capture.
    await paypal(
      this.env,
      "/v2/checkout/orders/" + encodeURIComponent(orderId) + "/capture",
      "POST",
      {},
      a.id + "-capture",
    );
    return this.reconcile(a.id);
  }
  async reconcile(attemptId: string) {
    const a = await this.env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE id=?",
    )
      .bind(attemptId)
      .first<Attempt>();
    insist(a, 404, "PAYMENT_NOT_FOUND", "Payment not found.");
    if (!a.order_id) return { status: a.status, requiresReview: true };
    const order = orderSchema.parse(
      await paypal(
        this.env,
        "/v2/checkout/orders/" + encodeURIComponent(a.order_id),
      ),
    );
    const c = verifiedCapture(order, a, this.env.PAYPAL_MERCHANT_ID);
    if (c?.status === "COMPLETED") {
      await this.ctx.blockConcurrencyWhile(() =>
        this.env.DB.batch([
          this.env.DB.prepare(
            "INSERT OR IGNORE INTO ledger(id,goal_id,user_id,attempt_id,provider_id,kind,amount_cents,created_at) VALUES(?,?,?,?,?,'capture',?,?)",
          ).bind(id(), a.goal_id, a.user_id, a.id, c.id, a.amount_cents, now()),
          this.env.DB.prepare(
            "UPDATE payment_attempts SET status=CASE WHEN EXISTS(SELECT 1 FROM ledger WHERE attempt_id=payment_attempts.id AND kind IN ('refund','reversal')) THEN 'reversed' ELSE 'completed' END,capture_id=?,reserved=0,updated_at=? WHERE id=?",
          ).bind(c.id, now(), a.id),
        ]),
      );
      return {
        status: "completed",
        savedCents: await balance(this.env, a.goal_id),
      };
    }
    if (
      (c && ["DECLINED", "FAILED"].includes(c.status)) ||
      order.status === "VOIDED"
    )
      await this.env.DB.prepare(
        "UPDATE payment_attempts SET status='failed',reserved=0,updated_at=? WHERE id=? AND status!='completed'",
      )
        .bind(now(), a.id)
        .run();
    return {
      status:
        c?.status === "PENDING"
          ? "capture_pending"
          : order.status.toLowerCase(),
    };
  }
  async adjust(
    captureId: string,
    providerId: string,
    amountCents: number,
    kind: "refund" | "reversal",
  ) {
    const a = await this.env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE capture_id=?",
    )
      .bind(captureId)
      .first<Attempt>();
    insist(
      a,
      409,
      "CAPTURE_NOT_RECONCILED",
      "Original capture must be reconciled first.",
    );
    cents(amountCents);
    const result = await this.env.DB.prepare(
      `INSERT OR IGNORE INTO ledger(id,goal_id,user_id,attempt_id,provider_id,kind,amount_cents,created_at) SELECT ?,?,?,?,?,?, ?,? WHERE ? <= COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE attempt_id=?),0)`,
    )
      .bind(
        id(),
        a.goal_id,
        a.user_id,
        a.id,
        providerId,
        kind,
        -amountCents,
        now(),
        amountCents,
        a.id,
      )
      .run();
    if (!result.meta.changes) {
      const duplicate = await this.env.DB.prepare(
        "SELECT id FROM ledger WHERE provider_id=?",
      )
        .bind(providerId)
        .first();
      insist(
        duplicate,
        409,
        "ADJUSTMENT_EXCEEDS_CAPTURE",
        "Adjustment exceeds the remaining captured amount.",
      );
      return { ok: true };
    }
    await this.env.DB.prepare(
      "UPDATE payment_attempts SET status='reversed',updated_at=? WHERE id=?",
    )
      .bind(now(), a.id)
      .run();
    return { ok: true };
  }
}
export function coordinator(env: Env, goalId: string) {
  return env.GOAL_COORDINATOR.get(env.GOAL_COORDINATOR.idFromName(goalId));
}
export async function paymentRoutes(
  r: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (path === "/api/payments/activity" && r.method === "GET") {
    const user = await session(r, env);
    return json({
      payments: (
        await env.DB.prepare(
          `SELECT a.id,a.goal_id,a.amount_cents,a.status,a.created_at,a.updated_at,
          MAX(0,COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE attempt_id=a.id),0)
          -COALESCE((SELECT SUM(amount_cents) FROM refund_requests r WHERE r.attempt_id=a.id AND r.state IN ('created','pending') AND NOT EXISTS(SELECT 1 FROM ledger WHERE provider_id=r.provider_id)),0)) AS refundable_cents,
          COALESCE((SELECT SUM(amount_cents) FROM refund_requests WHERE attempt_id=a.id AND state IN ('created','pending')),0) AS refund_pending_cents
          FROM payment_attempts a WHERE a.user_id=? ORDER BY a.created_at DESC LIMIT 100`,
        )
          .bind(user.id)
          .all()
      ).results,
    });
  }
  if (path === "/api/payments/config" && r.method === "GET") {
    await session(r, env);
    return json({
      clientId: env.PAYPAL_CLIENT_ID || null,
      currency: "USD",
      sandbox: true,
      enabled: String(env.PAYMENTS_ENABLED) === "true",
    });
  }
  if (path === "/api/payments/orders" && r.method === "POST") {
    const user = await session(r, env, true),
      v = z
        .object({
          goalId: z.string().uuid(),
          amountCents: z.number().int().positive(),
          requestKey: z.string().uuid(),
        })
        .parse(await jsonBody(r));
    await member(env, v.goalId, user.id);
    return json(
      await coordinator(env, v.goalId).create(
        v.goalId,
        user.id,
        v.amountCents,
        v.requestKey,
      ),
      201,
    );
  }
  const match = path.match(
    /^\/api\/payments\/orders\/([^/]+)\/(capture|status)$/,
  );
  if (match) {
    const user = await session(r, env, r.method !== "GET");
    const a = await env.DB.prepare(
      "SELECT goal_id,id,status FROM payment_attempts WHERE order_id=? AND user_id=?",
    )
      .bind(match[1], user.id)
      .first<{ goal_id: string; id: string; status: string }>();
    insist(a, 404, "PAYMENT_NOT_FOUND", "Payment not found.");
    if (match[2] === "capture" && r.method === "POST")
      return json(await coordinator(env, a.goal_id).capture(match[1], user.id));
    if (match[2] === "status" && r.method === "GET")
      return json(await coordinator(env, a.goal_id).reconcile(a.id));
  }
  if (path === "/api/webhooks/paypal" && r.method === "POST") {
    required(env, ["PAYPAL_WEBHOOK_ID"]);
    const event = z
      .object({
        id: z.string(),
        event_type: z.string(),
        resource: z.record(z.string(), z.unknown()),
      })
      .passthrough()
      .parse(await jsonBody(r));
    const verification = (await paypal(
      env,
      "/v1/notifications/verify-webhook-signature",
      "POST",
      {
        auth_algo: r.headers.get("paypal-auth-algo"),
        cert_url: r.headers.get("paypal-cert-url"),
        transmission_id: r.headers.get("paypal-transmission-id"),
        transmission_sig: r.headers.get("paypal-transmission-sig"),
        transmission_time: r.headers.get("paypal-transmission-time"),
        webhook_id: env.PAYPAL_WEBHOOK_ID,
        webhook_event: event,
      },
    )) as { verification_status?: string };
    insist(
      verification.verification_status === "SUCCESS",
      401,
      "WEBHOOK_SIGNATURE",
      "Invalid webhook signature.",
    );
    await env.DB.prepare(
      "INSERT OR IGNORE INTO provider_events(id,type,payload,received_at) VALUES(?,?,?,?)",
    )
      .bind(event.id, event.event_type, JSON.stringify(event), now())
      .run();
    await env.RECONCILE.send({ eventId: event.id });
    return json({ received: true });
  }
  return null;
}
export async function processEvent(env: Env, eventId: string) {
  const row = await env.DB.prepare(
    "SELECT payload,processed_at FROM provider_events WHERE id=?",
  )
    .bind(eventId)
    .first<{ payload: string; processed_at: number | null }>();
  if (!row || row.processed_at) return;
  const e = JSON.parse(row.payload) as {
    event_type: string;
    resource: Record<string, unknown>;
  };
  const supplementary = e.resource.supplementary_data as
    { related_ids?: { order_id?: string; capture_id?: string } } | undefined;
  const orderId = supplementary?.related_ids?.order_id;
  let attempt: Attempt | null = null;
  if (orderId)
    attempt = await env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE order_id=?",
    )
      .bind(orderId)
      .first<Attempt>();
  if (orderId && !attempt) {
    // A capture webhook can recover a successful order whose creation response was lost.
    const remote = orderSchema.parse(
      await paypal(env, "/v2/checkout/orders/" + encodeURIComponent(orderId)),
    );
    const customId = remote.purchase_units[0]?.custom_id;
    if (customId) {
      const candidate = await env.DB.prepare(
        "SELECT * FROM payment_attempts WHERE id=?",
      )
        .bind(customId)
        .first<Attempt>();
      if (candidate) {
        insist(
          !candidate.order_id || candidate.order_id === orderId,
          502,
          "ORDER_REFERENCE",
          "Order reference does not match.",
        );
        verifiedCapture(remote, candidate, env.PAYPAL_MERCHANT_ID);
        await env.DB.prepare(
          "UPDATE payment_attempts SET order_id=? WHERE id=? AND order_id IS NULL",
        )
          .bind(orderId, candidate.id)
          .run();
        attempt = { ...candidate, order_id: orderId };
      }
    }
  }
  if (!attempt && typeof e.resource.id === "string")
    attempt = await env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE capture_id=?",
    )
      .bind(e.resource.id)
      .first<Attempt>();
  if (e.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const refund = z
      .object({
        id: z.string(),
        status: z.string(),
        amount: z.object({
          value: z.string(),
          currency_code: z.literal("USD"),
        }),
        links: z.array(z.object({ rel: z.string(), href: z.string() })),
      })
      .parse(
        await paypal(
          env,
          "/v2/payments/refunds/" + encodeURIComponent(String(e.resource.id)),
        ),
      );
    const captureLink = refund.links.find((l) => l.rel === "up")?.href;
    const captureMatch = captureLink?.match(
      /^https:\/\/api-m\.sandbox\.paypal\.com\/v2\/payments\/captures\/([^/?#]+)$/,
    );
    insist(
      captureMatch,
      502,
      "REFUND_REFERENCE",
      "Refund capture reference missing.",
    );
    attempt = await env.DB.prepare(
      "SELECT * FROM payment_attempts WHERE capture_id=?",
    )
      .bind(captureMatch[1])
      .first<Attempt>();
    insist(
      attempt,
      409,
      "CAPTURE_PENDING",
      "Original capture is not yet reconciled.",
    );
    const requests = await env.DB.prepare(
      "SELECT id FROM refund_requests WHERE provider_id=?",
    )
      .bind(refund.id)
      .first();
    if (!requests) {
      // A webhook can arrive before the refund POST response. Match the provider's persisted idempotency result during reconciliation.
      const outstanding = await env.DB.prepare(
        "SELECT id FROM refund_requests WHERE attempt_id=? AND provider_id IS NULL AND state='created' LIMIT 1",
      )
        .bind(attempt.id)
        .first();
      if (outstanding)
        throw new Error(
          "Refund response must be reconciled before applying its webhook",
        );
    }
    await coordinator(env, attempt.goal_id).applyRefund(
      refund.id,
      captureMatch[1],
    );
  } else if (e.event_type === "PAYMENT.CAPTURE.REVERSED") {
    const captureId = String(e.resource.id);
    const detail = (await paypal(
      env,
      "/v2/payments/captures/" + encodeURIComponent(captureId),
    )) as {
      status?: string;
      amount?: { value: string; currency_code: string };
    };
    insist(
      attempt &&
        detail.status === "REVERSED" &&
        detail.amount?.currency_code === "USD",
      409,
      "REVERSAL_PENDING",
      "Reversal needs provider reconciliation.",
    );
    await coordinator(env, attempt.goal_id).adjust(
      captureId,
      eventId,
      parseCents(detail.amount.value),
      "reversal",
    );
  } else if (attempt)
    await coordinator(env, attempt.goal_id).reconcile(attempt.id);
  else if (e.event_type.startsWith("PAYMENT.CAPTURE."))
    throw new Error("Unmatched payment event requires retry and review");
  await env.DB.prepare("UPDATE provider_events SET processed_at=? WHERE id=?")
    .bind(now(), eventId)
    .run();
}
