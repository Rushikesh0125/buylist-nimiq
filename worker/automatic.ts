import { z } from "zod";
import { equalShare, validDate, type Frequency } from "../shared/domain";
import { dateInTimezone, nextFutureCycle } from "../shared/automatic";
import { id, insist, json, jsonBody, member, now, session } from "./http";
import { automaticSetupBody, paypal } from "./paypal";
import { coordinator, type GoalCoordinator } from "./payments";

export type AutomaticPlan = {
  id: string;
  goal_id: string;
  user_id: string;
  authorization_key: string;
  setup_id: string | null;
  token_id: string | null;
  amount_cents: number;
  target_cents: number;
  limit_cents: number;
  frequency: Frequency;
  start_date: string;
  timezone: string;
  next_index: number;
  next_date: string;
  state: string;
  reason: string | null;
  created_at: number;
};
const consentVersion = "buylist-auto-v1";
function enabled(env: Env) {
  insist(
    String(env.PAYMENTS_ENABLED) === "true",
    503,
    "PAYMENTS_PAUSED",
    "Contributions are temporarily paused.",
  );
}
export function publicPlan(p: AutomaticPlan | null) {
  if (!p) return null;
  return {
    id: p.id,
    amountCents: p.amount_cents,
    frequency: p.frequency,
    startDate: p.start_date,
    nextDate: p.next_date,
    timezone: p.timezone,
    state: p.state,
    reason: p.reason,
    targetCents: p.target_cents,
    limitCents: p.limit_cents,
  };
}
export async function automaticRoutes(
  r: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const match = path.match(
    /^\/api\/goals\/([^/]+)\/automatic(?:\/(setup|approve|pause|resume|cancel))?$/,
  );
  if (!match) return null;
  const user = await session(r, env, r.method !== "GET");
  const goal = await member(env, match[1], user.id);
  const load = () =>
    env.DB.prepare(
      "SELECT * FROM automatic_plans WHERE goal_id=? AND user_id=?",
    )
      .bind(goal.id, user.id)
      .first<AutomaticPlan>();
  const action = match[2];
  if (!action && r.method === "GET")
    return json({ plan: publicPlan(await load()) });
  if (r.method !== "POST") return null;
  if (action === "setup") {
    enabled(env);
    const v = z
      .object({
        amountCents: z.number().int().positive().max(100_000_000),
        frequency: z.enum(["weekly", "fortnightly", "monthly"]),
        startDate: z.string().refine(validDate),
        requestKey: z.string().uuid(),
        consent: z.literal(true),
      })
      .parse(await jsonBody(r));
    const today = dateInTimezone(goal.timezone);
    insist(
      v.startDate >= today &&
        v.startDate <=
          new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 10),
      400,
      "START_DATE",
      "Choose today or a future date within one year.",
    );
    insist(
      !goal.purchased,
      409,
      "GOAL_CLOSED",
      "This goal is already purchased.",
    );
    const members = (
      await env.DB.prepare(
        "SELECT user_id FROM memberships WHERE goal_id=? ORDER BY joined_at,user_id",
      )
        .bind(goal.id)
        .all<{ user_id: string }>()
    ).results;
    const limit =
      goal.mode === "fixed"
        ? equalShare(
            goal.target_cents,
            members.length,
            members.findIndex((m) => m.user_id === user.id),
          )
        : goal.target_cents;
    // A pending cycle must be resolved before a mandate can be replaced.
    const pending = await env.DB.prepare(
      "SELECT 1 FROM automatic_cycles c JOIN automatic_plans p ON p.id=c.plan_id LEFT JOIN payment_attempts a ON a.id=c.attempt_id WHERE p.goal_id=? AND p.user_id=? AND (a.id IS NULL OR a.reserved=1) LIMIT 1",
    )
      .bind(goal.id, user.id)
      .first();
    insist(
      !pending,
      409,
      "PAYMENT_PENDING",
      "An automatic contribution is still being reconciled.",
    );
    let p = await load();
    if (p?.authorization_key !== v.requestKey) {
      p = await env.DB.prepare(
        `INSERT INTO automatic_plans(id,goal_id,user_id,authorization_key,amount_cents,target_cents,limit_cents,frequency,start_date,timezone,next_date,state,consent_version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT(goal_id,user_id) DO UPDATE SET
        authorization_key=excluded.authorization_key,setup_id=NULL,token_id=NULL,amount_cents=excluded.amount_cents,frequency=excluded.frequency,
        start_date=excluded.start_date,timezone=excluded.timezone,next_date=excluded.next_date,next_index=0,state='pending',reason=NULL,
        consent_version=excluded.consent_version,target_cents=excluded.target_cents,limit_cents=excluded.limit_cents,created_at=excluded.created_at,updated_at=excluded.updated_at
        WHERE automatic_plans.state IN ('cancelled','finished') RETURNING *`,
      )
        .bind(
          id(),
          goal.id,
          user.id,
          v.requestKey,
          v.amountCents,
          goal.target_cents,
          limit,
          v.frequency,
          v.startDate,
          goal.timezone,
          v.startDate,
          consentVersion,
          now(),
          now(),
        )
        .first<AutomaticPlan>();
      insist(
        p,
        409,
        "AUTOMATIC_EXISTS",
        "Pause or cancel your current automatic plan before changing its terms.",
      );
    }
    insist(
      p.state === "pending" &&
        p.amount_cents === v.amountCents &&
        p.frequency === v.frequency &&
        p.start_date === v.startDate,
      409,
      "AUTOMATIC_STATE",
      "Authorization terms changed. Start again.",
    );
    await env.DB.prepare(
      "INSERT OR IGNORE INTO automatic_authorizations(authorization_key,plan_id,terms_json,created_at) VALUES(?,?,?,?)",
    )
      .bind(
        p.authorization_key,
        p.id,
        JSON.stringify({
          amountCents: p.amount_cents,
          frequency: p.frequency,
          startDate: p.start_date,
          timezone: p.timezone,
          targetCents: p.target_cents,
          limitCents: p.limit_cents,
          consentVersion,
        }),
        p.created_at,
      )
      .run();
    if (p.setup_id) return json({ setupToken: p.setup_id });
    insist(
      now() - p.created_at < 3 * 3600,
      409,
      "SETUP_EXPIRED",
      "Cancel this setup and authorize a new plan.",
    );
    const setup = z.object({ id: z.string() }).parse(
      await paypal(
        env,
        "/v3/vault/setup-tokens",
        "POST",
        automaticSetupBody({
          userId: user.id,
          goalName: goal.name,
          amountCents: p.amount_cents,
          frequency: p.frequency,
          startDate: p.start_date,
          origin: env.APP_ORIGIN,
        }),
        p.authorization_key,
      ),
    );
    const stored = await env.DB.prepare(
      "UPDATE automatic_plans SET setup_id=?,updated_at=? WHERE id=? AND authorization_key=? AND state='pending'",
    )
      .bind(setup.id, now(), p.id, p.authorization_key)
      .run();
    insist(
      stored.meta.changes === 1,
      409,
      "AUTOMATIC_STATE",
      "This authorization was cancelled.",
    );
    return json({ setupToken: setup.id });
  }
  const p = await load();
  insist(p, 404, "AUTOMATIC_NOT_FOUND", "No automatic plan exists.");
  if (action === "approve") {
    enabled(env);
    const v = z
      .object({ setupToken: z.string().min(1) })
      .parse(await jsonBody(r));
    insist(
      v.setupToken === p.setup_id,
      403,
      "SETUP_OWNER",
      "This authorization does not belong to your plan.",
    );
    if (p.state === "active") return json({ plan: publicPlan(p) });
    insist(
      p.state === "pending" && now() - p.created_at < 3 * 3600,
      409,
      "SETUP_EXPIRED",
      "Cancel this setup and authorize a new plan.",
    );
    const setup = z
      .object({
        id: z.string(),
        status: z.string(),
        customer: z.object({
          id: z.string(),
          merchant_customer_id: z.string().optional(),
        }),
      })
      .parse(
        await paypal(
          env,
          "/v3/vault/setup-tokens/" + encodeURIComponent(v.setupToken),
        ),
      );
    insist(
      setup.id === p.setup_id &&
        setup.status === "APPROVED" &&
        (!setup.customer.merchant_customer_id ||
          setup.customer.merchant_customer_id === user.id),
      409,
      "APPROVAL_REQUIRED",
      "Complete PayPal approval for this plan.",
    );
    const token = z
      .object({
        id: z.string(),
        customer: z.object({ id: z.string() }),
        payment_source: z.object({ paypal: z.object({}).passthrough() }),
      })
      .parse(
        await paypal(
          env,
          "/v3/vault/payment-tokens",
          "POST",
          {
            payment_source: { token: { id: p.setup_id, type: "SETUP_TOKEN" } },
          },
          p.authorization_key + "-token",
        ),
      );
    insist(
      token.customer.id === setup.customer.id,
      502,
      "TOKEN_OWNER",
      "PayPal customer did not match the authorization.",
    );
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE automatic_authorizations SET approved_at=COALESCE(approved_at,?) WHERE authorization_key=?",
      ).bind(now(), p.authorization_key),
      env.DB.prepare(
        "UPDATE automatic_plans SET token_id=?,state='active',reason=NULL,updated_at=? WHERE id=? AND authorization_key=? AND state='pending' AND EXISTS(SELECT 1 FROM automatic_authorizations WHERE authorization_key=? AND approved_at IS NOT NULL)",
      ).bind(token.id, now(), p.id, p.authorization_key, p.authorization_key),
    ]);
    const changed = results[1];
    insist(
      changed.meta.changes === 1,
      409,
      "AUTOMATIC_STATE",
      "This authorization is no longer pending.",
    );
    return json({ plan: publicPlan(await load()) });
  }
  if (action === "pause" || action === "cancel") {
    await env.DB.prepare(
      "UPDATE automatic_plans SET state=?,reason=NULL,updated_at=? WHERE id=? AND authorization_key=? AND state NOT IN ('cancelled','finished')",
    )
      .bind(
        action === "pause" ? "paused" : "cancelled",
        now(),
        p.id,
        p.authorization_key,
      )
      .run();
    if (action === "cancel")
      await env.DB.prepare(
        "UPDATE automatic_authorizations SET cancelled_at=COALESCE(cancelled_at,?) WHERE authorization_key=?",
      )
        .bind(now(), p.authorization_key)
        .run();
    return json({ plan: publicPlan(await load()) });
  }
  if (action === "resume") {
    enabled(env);
    insist(
      p.state === "paused" && p.token_id,
      409,
      "AUTOMATIC_STATE",
      "Authorize a payment method before resuming.",
    );
    const unresolved = await env.DB.prepare(
      "SELECT 1 FROM automatic_cycles c LEFT JOIN payment_attempts a ON a.id=c.attempt_id WHERE c.plan_id=? AND (a.id IS NULL OR a.reserved=1) LIMIT 1",
    )
      .bind(p.id)
      .first();
    const refunds = await env.DB.prepare(
      "SELECT 1 FROM refund_requests r JOIN payment_attempts a ON a.id=r.attempt_id WHERE a.goal_id=? AND a.user_id=? AND r.state IN ('created','pending') LIMIT 1",
    )
      .bind(goal.id, user.id)
      .first();
    insist(
      !unresolved && !refunds,
      409,
      "PAYMENT_PENDING",
      "A payment or refund is still being reconciled.",
    );
    const next = nextFutureCycle(
      p.start_date,
      p.next_index - 1,
      p.frequency,
      dateInTimezone(p.timezone),
    );
    await env.DB.prepare(
      "UPDATE automatic_plans SET state='active',reason=NULL,next_index=?,next_date=?,updated_at=? WHERE id=? AND authorization_key=? AND state='paused'",
    )
      .bind(next.index, next.date, now(), p.id, p.authorization_key)
      .run();
    return json({ plan: publicPlan(await load()) });
  }
  return null;
}

export async function runAutomatic(
  env: Env,
  service: GoalCoordinator,
  planId: string,
) {
  if (String(env.PAYMENTS_ENABLED) !== "true") return;
  const p = await env.DB.prepare("SELECT * FROM automatic_plans WHERE id=?")
    .bind(planId)
    .first<AutomaticPlan>();
  if (!p || p.state !== "active" || !p.token_id) return;
  // Rotate bounded cron batches even when a candidate is not yet due in its local timezone.
  await env.DB.prepare("UPDATE automatic_plans SET updated_at=? WHERE id=?")
    .bind(now(), p.id)
    .run();
  if (p.next_date > dateInTimezone(p.timezone)) return;
  const g = await member(env, p.goal_id, p.user_id);
  const currentCycle = await env.DB.prepare(
    "SELECT a.status,a.reserved FROM automatic_cycles c LEFT JOIN payment_attempts a ON a.id=c.attempt_id WHERE c.plan_id=? AND c.authorization_key=? AND c.cycle_index=?",
  )
    .bind(p.id, p.authorization_key, p.next_index)
    .first<{ status: string | null; reserved: number | null }>();
  if (currentCycle?.status === "completed") {
    const next = nextFutureCycle(
      p.start_date,
      p.next_index,
      p.frequency,
      dateInTimezone(p.timezone),
    );
    await env.DB.prepare(
      "UPDATE automatic_plans SET next_index=?,next_date=?,updated_at=? WHERE id=? AND state='active' AND next_index=? AND authorization_key=?",
    )
      .bind(
        next.index,
        next.date,
        now(),
        p.id,
        p.next_index,
        p.authorization_key,
      )
      .run();
    return;
  }
  const pending = await env.DB.prepare(
    "SELECT 1 FROM automatic_cycles c LEFT JOIN payment_attempts a ON a.id=c.attempt_id WHERE c.plan_id=? AND (a.id IS NULL OR a.reserved=1) LIMIT 1",
  )
    .bind(p.id)
    .first();
  if (pending) return;
  const total = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS n FROM ledger WHERE goal_id=?",
  )
    .bind(g.id)
    .first<{ n: number }>();
  const ownPaid = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount_cents),0) AS n FROM ledger WHERE goal_id=? AND user_id=?",
  )
    .bind(g.id, p.user_id)
    .first<{ n: number }>();
  let cap = Math.min(g.target_cents, p.target_cents) - (total?.n || 0);
  cap = Math.min(cap, p.limit_cents - (ownPaid?.n || 0));
  if (g.mode === "fixed") {
    const members = (
      await env.DB.prepare(
        "SELECT user_id FROM memberships WHERE goal_id=? ORDER BY joined_at,user_id",
      )
        .bind(g.id)
        .all<{ user_id: string }>()
    ).results;
    const paid = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS n FROM ledger WHERE goal_id=? AND user_id=?",
    )
      .bind(g.id, p.user_id)
      .first<{ n: number }>();
    cap = Math.min(
      cap,
      equalShare(
        g.target_cents,
        members.length,
        members.findIndex((m) => m.user_id === p.user_id),
      ) - (paid?.n || 0),
    );
  }
  if (g.purchased || cap <= 0) {
    await env.DB.prepare(
      "UPDATE automatic_plans SET state='finished',reason='Target reached',updated_at=? WHERE id=? AND authorization_key=? AND state='active'",
    )
      .bind(now(), p.id, p.authorization_key)
      .run();
    return;
  }
  const requestKey = p.authorization_key + ":" + p.next_index;
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO automatic_cycles(id,plan_id,cycle_index,authorization_key,request_key,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM automatic_plans WHERE id=? AND state='active' AND next_index=? AND authorization_key=?)`,
  )
    .bind(
      id(),
      p.id,
      p.next_index,
      p.authorization_key,
      requestKey,
      now(),
      p.id,
      p.next_index,
      p.authorization_key,
    )
    .run();
  if (!claim.meta.changes) return;
  try {
    const held = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS n FROM payment_attempts WHERE goal_id=? AND reserved=1",
    )
      .bind(g.id)
      .first<{ n: number }>();
    const ownHeld = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS n FROM payment_attempts WHERE goal_id=? AND user_id=? AND reserved=1",
    )
      .bind(g.id, p.user_id)
      .first<{ n: number }>();
    const available = Math.min(
      cap - (ownHeld?.n || 0),
      Math.min(g.target_cents, p.target_cents) -
        (total?.n || 0) -
        (held?.n || 0),
    );
    insist(
      available > 0,
      409,
      "TARGET_RESERVED",
      "The remaining target is reserved by another contribution.",
    );
    const result = await service.create(
      g.id,
      p.user_id,
      Math.min(p.amount_cents, available),
      requestKey,
      p.token_id,
      { target: p.target_cents, member: p.limit_cents },
    );
    await env.DB.prepare(
      "UPDATE automatic_cycles SET attempt_id=? WHERE request_key=?",
    )
      .bind(result.attemptId, requestKey)
      .run();
    await service.reconcile(result.attemptId);
    const a = await env.DB.prepare(
      "SELECT status FROM payment_attempts WHERE id=?",
    )
      .bind(result.attemptId)
      .first<{ status: string }>();
    insist(
      a?.status === "completed",
      409,
      "PAYMENT_PENDING",
      "Automatic payment needs review. Check payment history before resuming.",
    );
    const next = nextFutureCycle(
      p.start_date,
      p.next_index,
      p.frequency,
      dateInTimezone(p.timezone),
    );
    await env.DB.prepare(
      "UPDATE automatic_plans SET next_index=?,next_date=?,updated_at=? WHERE id=? AND state='active' AND next_index=? AND authorization_key=?",
    )
      .bind(
        next.index,
        next.date,
        now(),
        p.id,
        p.next_index,
        p.authorization_key,
      )
      .run();
  } catch {
    console.error(
      JSON.stringify({
        operation: "automatic-contribution",
        planId: p.id,
        code: "PAYMENT_REVIEW_REQUIRED",
      }),
    );
    // Link even an uncertain provider operation before pausing; reconciliation must resolve it first.
    await env.DB.prepare(
      "UPDATE automatic_cycles SET attempt_id=(SELECT id FROM payment_attempts WHERE user_id=? AND request_key=?) WHERE request_key=?",
    )
      .bind(p.user_id, requestKey, requestKey)
      .run();
    await env.DB.prepare(
      "UPDATE automatic_plans SET state='paused',reason='Review the latest contribution before resuming.',updated_at=? WHERE id=? AND authorization_key=? AND state='active'",
    )
      .bind(now(), p.id, p.authorization_key)
      .run();
    // If no payment was reserved, this cycle has no financial side effect and can be retried after explicit resume.
    await env.DB.prepare(
      "DELETE FROM automatic_cycles WHERE request_key=? AND attempt_id IS NULL",
    )
      .bind(requestKey)
      .run();
  }
}
