import { z } from "zod";
import {
  HttpError,
  id,
  insist,
  json,
  jsonBody,
  member,
  now,
  session,
} from "./http";
import { paypal, parseCents } from "./paypal";
import { coordinator, type GoalCoordinator } from "./payments";

type RefundRequest = {
  id: string;
  attempt_id: string;
  user_id: string;
  request_key: string;
  amount_cents: number;
  provider_id: string | null;
  state: string;
  created_at: number;
};
const refundSchema = z.object({
  id: z.string(),
  status: z.string(),
  amount: z.object({ currency_code: z.literal("USD"), value: z.string() }),
  links: z.array(z.object({ rel: z.string(), href: z.string() })),
});
export async function applyRefund(
  env: Env,
  service: GoalCoordinator,
  refundId: string,
  captureId: string,
  expectedCents?: number,
) {
  const refund = refundSchema.parse(
    await paypal(env, "/v2/payments/refunds/" + encodeURIComponent(refundId)),
  );
  const up = refund.links.find((l) => l.rel === "up")?.href;
  insist(
    refund.id === refundId &&
      up ===
        "https://api-m.sandbox.paypal.com/v2/payments/captures/" +
          encodeURIComponent(captureId),
    502,
    "REFUND_REFERENCE",
    "Refund capture reference does not match.",
  );
  const amount = parseCents(refund.amount.value);
  insist(
    expectedCents === undefined || amount === expectedCents,
    502,
    "REFUND_AMOUNT",
    "Refund amount does not match the request.",
  );
  if (refund.status === "COMPLETED")
    await service.adjust(captureId, refund.id, amount, "refund");
  const state =
    refund.status === "COMPLETED"
      ? "completed"
      : ["FAILED", "CANCELLED"].includes(refund.status)
        ? "failed"
        : "pending";
  await env.DB.prepare(
    "UPDATE refund_requests SET state=?,updated_at=? WHERE provider_id=?",
  )
    .bind(state, now(), refundId)
    .run();
  return { status: state };
}
export async function executeRefund(
  env: Env,
  service: GoalCoordinator,
  requestId: string,
) {
  const row = await env.DB.prepare("SELECT * FROM refund_requests WHERE id=?")
    .bind(requestId)
    .first<RefundRequest>();
  insist(row, 404, "REFUND_NOT_FOUND", "Refund not found.");
  if (row.state === "completed" || row.state === "failed")
    return { status: row.state };
  const a = await env.DB.prepare(
    "SELECT capture_id FROM payment_attempts WHERE id=?",
  )
    .bind(row.attempt_id)
    .first<{ capture_id: string }>();
  insist(
    a?.capture_id,
    409,
    "CAPTURE_REQUIRED",
    "A verified captured payment is required.",
  );
  let providerId = row.provider_id;
  if (!providerId) {
    insist(
      now() - row.created_at < 3 * 3600,
      409,
      "REFUND_REVIEW",
      "This uncertain refund needs manual reconciliation before another refund can be issued.",
    );
    const result = z.object({ id: z.string() }).parse(
      await paypal(
        env,
        "/v2/payments/captures/" + encodeURIComponent(a.capture_id) + "/refund",
        "POST",
        {
          amount: {
            currency_code: "USD",
            value: (row.amount_cents / 100).toFixed(2),
          },
          note_to_payer: "Buylist contribution refund",
        },
        row.id,
      ),
    );
    providerId = result.id;
    await env.DB.prepare(
      "UPDATE refund_requests SET provider_id=?,state='pending',updated_at=? WHERE id=? AND provider_id IS NULL",
    )
      .bind(providerId, now(), row.id)
      .run();
  }
  return applyRefund(env, service, providerId, a.capture_id, row.amount_cents);
}
export async function requestRefund(
  env: Env,
  service: GoalCoordinator,
  attemptId: string,
  userId: string,
  amountCents: number,
  requestKey: string,
) {
  const a = await env.DB.prepare(
    "SELECT goal_id,user_id,capture_id FROM payment_attempts WHERE id=? AND user_id=?",
  )
    .bind(attemptId, userId)
    .first<{ goal_id: string; user_id: string; capture_id: string | null }>();
  insist(a, 404, "PAYMENT_NOT_FOUND", "Payment not found.");
  const g = await member(env, a.goal_id, userId);
  insist(
    !g.purchased,
    409,
    "GOAL_CLOSED",
    "This goal is already purchased. Contact support about its payment.",
  );
  insist(
    a.capture_id,
    409,
    "CAPTURE_REQUIRED",
    "Only confirmed contributions can be refunded.",
  );
  let row = await env.DB.prepare(
    "SELECT * FROM refund_requests WHERE user_id=? AND request_key=?",
  )
    .bind(userId, requestKey)
    .first<RefundRequest>();
  if (row)
    insist(
      row.attempt_id === attemptId && row.amount_cents === amountCents,
      409,
      "KEY_REUSED",
      "This request key belongs to another refund.",
    );
  else {
    row = await env.DB.prepare(
      `INSERT INTO refund_requests(id,attempt_id,user_id,request_key,amount_cents,state,created_at,updated_at)
      SELECT ?,?,?,?,?,'created',?,? WHERE ? <= COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE attempt_id=?),0)
      - COALESCE((SELECT SUM(amount_cents) FROM refund_requests WHERE attempt_id=? AND state IN ('created','pending') AND NOT EXISTS(SELECT 1 FROM ledger WHERE provider_id=refund_requests.provider_id)),0)
      ON CONFLICT(user_id,request_key) DO NOTHING RETURNING *`,
    )
      .bind(
        id(),
        attemptId,
        userId,
        requestKey,
        amountCents,
        now(),
        now(),
        amountCents,
        attemptId,
        attemptId,
      )
      .first<RefundRequest>();
    if (!row)
      row = await env.DB.prepare(
        "SELECT * FROM refund_requests WHERE user_id=? AND request_key=?",
      )
        .bind(userId, requestKey)
        .first<RefundRequest>();
    insist(
      row,
      409,
      "REFUND_EXCEEDS_PAYMENT",
      "The amount exceeds the available refundable contribution.",
    );
    insist(
      row.attempt_id === attemptId && row.amount_cents === amountCents,
      409,
      "KEY_REUSED",
      "This request key belongs to another refund.",
    );
  }
  await env.DB.prepare(
    "UPDATE automatic_plans SET state='paused',reason='Paused after a refund request.',updated_at=? WHERE goal_id=? AND user_id=? AND state='active'",
  )
    .bind(now(), a.goal_id, userId)
    .run();
  await env.RECONCILE.send({ refundId: row.id, goalId: a.goal_id });
  return { ...(await executeRefund(env, service, row.id)), refundId: row.id };
}
export async function refundRoutes(
  r: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const match = path.match(/^\/api\/payments\/([^/]+)\/refunds$/);
  if (!match) return null;
  const user = await session(r, env, r.method !== "GET");
  const a = await env.DB.prepare(
    "SELECT goal_id FROM payment_attempts WHERE id=? AND user_id=?",
  )
    .bind(match[1], user.id)
    .first<{ goal_id: string }>();
  insist(a, 404, "PAYMENT_NOT_FOUND", "Payment not found.");
  await member(env, a.goal_id, user.id);
  if (r.method === "GET")
    return json({
      refunds: (
        await env.DB.prepare(
          "SELECT id,amount_cents,state,created_at FROM refund_requests WHERE attempt_id=? ORDER BY created_at DESC",
        )
          .bind(match[1])
          .all()
      ).results,
    });
  if (r.method === "POST") {
    const v = z
      .object({
        amountCents: z.number().int().positive().max(100_000_000),
        requestKey: z.string().uuid(),
      })
      .parse(await jsonBody(r));
    const result = await coordinator(env, a.goal_id).refund(
      match[1],
      user.id,
      v.amountCents,
      v.requestKey,
    );
    if ("error" in result)
      throw new HttpError(
        result.error.status,
        result.error.code,
        result.error.message,
      );
    return json(result);
  }
  return null;
}
