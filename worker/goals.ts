import { z } from "zod";
import { equalShare, forecast, validDate } from "../shared/domain";
import { readSchedule } from "./schedule";
import {
  balance,
  hash,
  id,
  insist,
  json,
  jsonBody,
  member,
  now,
  random,
  session,
} from "./http";
const amount = z.number().int().min(1).max(100_000_000);
const goalInput = z.object({
  name: z.string().trim().min(1).max(120),
  targetCents: amount,
  mode: z.enum(["solo", "fixed", "flexible"]),
  timezone: z.string().max(80),
  productId: z.string().max(200).optional(),
});
export async function goals(
  r: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  if (!path.startsWith("/api/goals") && !path.startsWith("/api/invitations/"))
    return null;
  const user = await session(r, env, r.method !== "GET");
  if (path === "/api/goals" && r.method === "GET")
    return json({
      goals: (
        await env.DB.prepare(
          "SELECT g.*,m.role,COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE goal_id=g.id),0) AS saved_cents,s.review_date AS nimiq_review_date FROM goals g JOIN memberships m ON m.goal_id=g.id LEFT JOIN personal_nim_savings s ON s.goal_id=g.id AND s.user_id=m.user_id AND s.network=? WHERE m.user_id=? ORDER BY g.created_at DESC",
        )
          .bind(env.NIMIQ_NETWORK ?? null, user.id)
          .all()
      ).results,
    });
  if (path === "/api/goals" && r.method === "POST") {
    const v = goalInput.parse(await jsonBody(r));
    try {
      new Intl.DateTimeFormat("en", { timeZone: v.timezone });
    } catch {
      insist(false, 400, "INVALID_TIMEZONE", "Choose a valid timezone.");
    }
    let product: string | null = null;
    if (v.productId) {
      const snap = await env.DB.prepare(
        "SELECT payload FROM product_snapshots WHERE id=?",
      )
        .bind(v.productId)
        .first<{ payload: string }>();
      insist(
        snap,
        400,
        "PRODUCT_NOT_FOUND",
        "Search and select the product again.",
      );
      product = snap.payload;
      const parsed = JSON.parse(product);
      insist(
        parsed.currency === "USD",
        400,
        "CURRENCY_UNSUPPORTED",
        "Only USD goals are supported.",
      );
    }
    const gid = id();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO goals(id,owner_id,name,product_json,target_cents,currency,mode,timezone,created_at) VALUES(?,?,?,?,?,'USD',?,?,?)",
      ).bind(
        gid,
        user.id,
        v.name,
        product,
        v.targetCents,
        v.mode,
        v.timezone,
        now(),
      ),
      env.DB.prepare(
        "INSERT INTO memberships(goal_id,user_id,role,joined_at) VALUES(?,?,'owner',?)",
      ).bind(gid, user.id, now()),
    ]);
    return json({ id: gid }, 201);
  }
  const accept = path.match(/^\/api\/invitations\/([^/]+)\/accept$/);
  if (accept && r.method === "POST") {
    const tokenHash = await hash(accept[1]);
    const invitation = await env.DB.prepare(
      "SELECT goal_id FROM invitations WHERE token_hash=? AND accepted_by IS NULL AND expires_at>?",
    )
      .bind(tokenHash, now())
      .first<{ goal_id: string }>();
    insist(
      invitation,
      410,
      "INVITATION_EXPIRED",
      "This invitation has expired or was already accepted.",
    );
    const locked = await env.DB.prepare(
      "SELECT 1 FROM goals g WHERE g.id=? AND (g.owner_id=? OR (g.mode='fixed' AND EXISTS(SELECT 1 FROM commitments WHERE goal_id=g.id)))",
    )
      .bind(invitation.goal_id, user.id)
      .first();
    insist(
      !locked,
      409,
      "GROUP_LOCKED",
      "You already own this goal, or the fixed group has accepted its schedule. Join before schedules are accepted.",
    );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE invitations SET accepted_by=? WHERE token_hash=? AND accepted_by IS NULL AND expires_at>?",
      ).bind(user.id, tokenHash, now()),
      env.DB.prepare(
        "INSERT OR IGNORE INTO memberships(goal_id,user_id,role,joined_at) SELECT goal_id,?,'member',? FROM invitations WHERE token_hash=? AND accepted_by=?",
      ).bind(user.id, now(), tokenHash, user.id),
    ]);
    const accepted = await env.DB.prepare(
      "SELECT accepted_by FROM invitations WHERE token_hash=?",
    )
      .bind(tokenHash)
      .first<{ accepted_by: string }>();
    insist(
      accepted?.accepted_by === user.id,
      410,
      "INVITATION_USED",
      "This invitation was accepted by someone else.",
    );
    return json({ goalId: invitation.goal_id });
  }
  const eventMatch = path.match(
    /^\/api\/goals\/([^/]+)\/schedule\/events\/([^/]+)$/,
  );
  if (eventMatch && r.method === "PATCH") {
    await member(env, eventMatch[1], user.id);
    const v = z
      .object({ version: z.number().int().positive(), date: z.string() })
      .parse(await jsonBody(r));
    insist(validDate(v.date), 400, "INVALID_DATE", "Choose a valid date.");
    const result = await env.DB.prepare(
      "UPDATE schedule_events SET date=?,version=version+1 WHERE id=? AND goal_id=? AND user_id=? AND capture_id IS NULL AND version=?",
    )
      .bind(v.date, eventMatch[2], eventMatch[1], user.id, v.version)
      .run();
    insist(
      result.meta.changes === 1,
      409,
      "EVENT_CONFLICT",
      "This event changed or cannot be edited. Refresh your agenda.",
    );
    return json({ ok: true });
  }
  const match = path.match(
    /^\/api\/goals\/([^/]+)(?:\/(invitations|schedule|forecast|personal-plan))?$/,
  );
  if (!match) return null;
  const gid = match[1],
    action = match[2],
    g = await member(env, gid, user.id);
  if (action === "personal-plan") {
    insist(
      g.mode === "flexible",
      400,
      "FLEXIBLE_ONLY",
      "Personal optional plans are for flexible groups.",
    );
    if (r.method === "GET")
      return json({
        plan: await env.DB.prepare(
          "SELECT amount_cents,frequency,start_date,version FROM personal_plans WHERE goal_id=? AND user_id=?",
        )
          .bind(gid, user.id)
          .first(),
      });
    if (r.method === "PUT") {
      const v = z
        .object({
          version: z.number().int().nonnegative(),
          amountCents: amount,
          frequency: z.enum(["weekly", "fortnightly", "monthly"]),
          startDate: z.string(),
        })
        .parse(await jsonBody(r));
      insist(
        validDate(v.startDate),
        400,
        "INVALID_DATE",
        "Choose a valid date.",
      );
      const changed = await env.DB.prepare(
        `INSERT INTO personal_plans(goal_id,user_id,amount_cents,frequency,start_date,version,updated_at)
        SELECT ?,?,?,?,?,1,? WHERE ?=0 OR EXISTS(SELECT 1 FROM personal_plans WHERE goal_id=? AND user_id=? AND version=?)
        ON CONFLICT(goal_id,user_id) DO UPDATE SET amount_cents=excluded.amount_cents,frequency=excluded.frequency,start_date=excluded.start_date,version=personal_plans.version+1,updated_at=excluded.updated_at WHERE personal_plans.version=? RETURNING version`,
      )
        .bind(
          gid,
          user.id,
          v.amountCents,
          v.frequency,
          v.startDate,
          now(),
          v.version,
          gid,
          user.id,
          v.version,
          v.version,
        )
        .first<{ version: number }>();
      insist(
        changed,
        409,
        "VERSION_CONFLICT",
        "Your personal plan changed. Refresh before saving.",
      );
      return json({ ok: true, version: changed.version });
    }
  }
  if (!action && r.method === "GET") {
    const members = (
      await env.DB.prepare(
        "SELECT u.id,u.name,m.role,m.joined_at FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.goal_id=? ORDER BY m.joined_at,u.id",
      )
        .bind(gid)
        .all<{ id: string; name: string; role: string; joined_at: number }>()
    ).results;
    const commitments = (
      await env.DB.prepare("SELECT * FROM commitments WHERE goal_id=?")
        .bind(gid)
        .all()
    ).results;
    const ledger = (
      await env.DB.prepare(
        "SELECT user_id,amount_cents,kind,created_at FROM ledger WHERE goal_id=? ORDER BY created_at DESC",
      )
        .bind(gid)
        .all()
    ).results;
    return json({
      goal: { ...g, saved_cents: await balance(env, gid) },
      members: members.map((m, i) => ({
        ...m,
        shareCents:
          g.mode === "fixed"
            ? equalShare(g.target_cents, members.length, i)
            : null,
      })),
      commitments,
      ledger,
    });
  }
  if (!action && r.method === "PATCH") {
    await member(env, gid, user.id, true);
    const v = z
      .object({
        version: z.number().int().positive(),
        name: z.string().trim().min(1).max(120).optional(),
        purchased: z.boolean().optional(),
        targetCents: amount.optional(),
      })
      .parse(await jsonBody(r));
    if (v.targetCents !== undefined) {
      insist(
        !g.purchased,
        409,
        "GOAL_CLOSED",
        "Purchased goals cannot change their target.",
      );
      const changed = await env.DB.prepare(
        `UPDATE goals SET target_cents=?,version=version+1 WHERE id=? AND version=?
         AND NOT EXISTS(SELECT 1 FROM commitments WHERE goal_id=?)
         AND NOT EXISTS(SELECT 1 FROM payment_attempts WHERE goal_id=? AND reserved=1)
         AND ? >= COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE goal_id=?),0)`,
      )
        .bind(v.targetCents, gid, v.version, gid, gid, v.targetCents, gid)
        .run();
      insist(
        changed.meta.changes === 1,
        409,
        "TARGET_LOCKED",
        "Refresh the goal. Target changes require no accepted schedules or pending payments and cannot reduce received funds.",
      );
      return json({ ok: true });
    }
    if (v.purchased)
      insist(
        (await balance(env, gid)) >= g.target_cents,
        409,
        "GOAL_NOT_FUNDED",
        "The goal must be funded before marking it purchased.",
      );
    const result = await env.DB.prepare(
      "UPDATE goals SET name=?,purchased=?,version=version+1 WHERE id=? AND version=?",
    )
      .bind(
        v.name ?? g.name,
        v.purchased === undefined ? g.purchased : Number(v.purchased),
        gid,
        v.version,
      )
      .run();
    insist(
      result.meta.changes === 1,
      409,
      "VERSION_CONFLICT",
      "This goal changed. Refresh and try again.",
    );
    return json({ ok: true });
  }
  if (action === "invitations" && r.method === "POST") {
    await member(env, gid, user.id, true);
    insist(
      g.mode !== "solo",
      400,
      "SOLO_GOAL",
      "Solo goals cannot invite members.",
    );
    const token = random();
    await env.DB.prepare(
      "INSERT INTO invitations(token_hash,goal_id,created_by,expires_at) VALUES(?,?,?,?)",
    )
      .bind(await hash(token), gid, user.id, now() + 7 * 86400)
      .run();
    return json(
      {
        url: env.APP_ORIGIN + "/#invite/" + token,
        expiresAt: now() + 7 * 86400,
      },
      201,
    );
  }
  if (action === "schedule" && r.method === "GET")
    return json(await readSchedule(env, g, user.id));
  if (action === "forecast" && r.method === "POST") {
    const v = z
      .object({
        amountCents: amount,
        startDate: z.string(),
        frequency: z.enum(["weekly", "fortnightly", "monthly"]),
      })
      .parse(await jsonBody(r));
    return json({
      ...forecast(
        Math.max(0, g.target_cents - (await balance(env, gid))),
        v.amountCents,
        v.startDate,
        v.frequency,
      ),
      scenario: g.mode === "flexible" ? "what-if" : "planned",
      notGuaranteed: true,
    });
  }
  if (action === "schedule" && r.method === "PUT") {
    insist(
      g.mode !== "flexible",
      400,
      "FLEXIBLE_NO_COMMITMENT",
      "Flexible groups do not have mandatory schedules. Use what-if planning.",
    );
    const v = z
      .object({
        version: z.number().int().nonnegative(),
        amountCents: amount,
        frequency: z.enum(["weekly", "fortnightly", "monthly"]),
        startDate: z.string(),
      })
      .parse(await jsonBody(r));
    insist(validDate(v.startDate), 400, "INVALID_DATE", "Choose a valid date.");
    const members = (
      await env.DB.prepare(
        "SELECT user_id FROM memberships WHERE goal_id=? ORDER BY joined_at,user_id",
      )
        .bind(gid)
        .all<{ user_id: string }>()
    ).results;
    const received = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS total FROM ledger WHERE goal_id=? AND user_id=?",
    )
      .bind(gid, user.id)
      .first<{ total: number }>();
    const share =
      g.mode === "fixed"
        ? equalShare(
            g.target_cents,
            members.length,
            members.findIndex((m) => m.user_id === user.id),
          )
        : g.target_cents;
    const plan = forecast(
      Math.max(0, share - (received?.total || 0)),
      v.amountCents,
      v.startDate,
      v.frequency,
    );
    // A transactional version guard protects both commitment and generated events.
    const current = await env.DB.prepare(
      "SELECT version FROM commitments WHERE goal_id=? AND user_id=?",
    )
      .bind(gid, user.id)
      .first<{ version: number }>();
    insist(
      (current?.version || 0) === v.version,
      409,
      "VERSION_CONFLICT",
      "Your schedule changed. Refresh before saving.",
    );
    const newVersion = v.version + 1;
    const guard = id();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO commitments(goal_id,user_id,amount_cents,frequency,start_date,version,accepted_at,mutation_id) SELECT ?,?,?,?,?,1,?,? WHERE EXISTS(SELECT 1 FROM goals WHERE id=? AND version=?) ON CONFLICT(goal_id,user_id) DO UPDATE SET amount_cents=excluded.amount_cents,frequency=excluded.frequency,start_date=excluded.start_date,version=commitments.version+1,accepted_at=excluded.accepted_at,mutation_id=excluded.mutation_id WHERE commitments.version=? AND EXISTS(SELECT 1 FROM goals WHERE id=? AND version=?)",
      ).bind(
        gid,
        user.id,
        v.amountCents,
        v.frequency,
        v.startDate,
        now(),
        guard,
        gid,
        g.version,
        v.version,
        gid,
        g.version,
      ),
      env.DB.prepare(
        "INSERT INTO audit_events(id,user_id,goal_id,action,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM commitments WHERE goal_id=? AND user_id=? AND version=? AND mutation_id=?)",
      ).bind(
        guard,
        user.id,
        gid,
        "schedule.accepted",
        now(),
        gid,
        user.id,
        newVersion,
        guard,
      ),
      env.DB.prepare(
        "DELETE FROM schedule_events WHERE goal_id=? AND user_id=? AND capture_id IS NULL AND EXISTS(SELECT 1 FROM audit_events WHERE id=?)",
      ).bind(gid, user.id, guard),
      ...plan.events.map((e) =>
        env.DB.prepare(
          "INSERT INTO schedule_events(id,goal_id,user_id,date,amount_cents) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM audit_events WHERE id=?)",
        ).bind(id(), gid, user.id, e.date, e.amountCents, guard),
      ),
    ]);
    const wrote = await env.DB.prepare("SELECT id FROM audit_events WHERE id=?")
      .bind(guard)
      .first();
    insist(
      wrote,
      409,
      "VERSION_CONFLICT",
      "Your schedule changed. Refresh and try again.",
    );
    return json({ version: newVersion, ...plan });
  }
  return null;
}
