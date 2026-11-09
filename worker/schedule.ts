import { nextDate, type Frequency } from "../shared/domain";
import { dateInTimezone } from "../shared/automatic";
import type { PlannerEvent } from "../shared/planner";
import type { GoalRow } from "./http";

export async function readSchedule(env: Env, goal: GoalRow, userId: string) {
  const planned = (
    await env.DB.prepare(
      "SELECT e.*,u.name FROM schedule_events e JOIN users u ON e.user_id=u.id WHERE e.goal_id=? AND (e.capture_id IS NULL OR NOT EXISTS(SELECT 1 FROM ledger l WHERE l.kind='capture' AND l.provider_id=e.capture_id))",
    )
      .bind(goal.id)
      .all<PlannerEvent>()
  ).results;
  const events: PlannerEvent[] = planned.map((e) => ({
    ...e,
    state: e.capture_id ? "received" : "planned",
    editable: !e.capture_id && e.user_id === userId,
  }));
  const captures = (
    await env.DB.prepare(
      `SELECT l.id,l.user_id,u.name,l.created_at,l.provider_id,l.amount_cents,
    COALESCE((SELECT SUM(amount_cents) FROM ledger WHERE attempt_id=l.attempt_id),0) AS net_cents,
    EXISTS(SELECT 1 FROM ledger WHERE attempt_id=l.attempt_id AND kind='reversal') AS has_reversal
    FROM ledger l JOIN users u ON u.id=l.user_id WHERE l.goal_id=? AND l.kind='capture'`,
    )
      .bind(goal.id)
      .all<{
        id: string;
        user_id: string;
        name: string;
        created_at: number;
        provider_id: string;
        amount_cents: number;
        net_cents: number;
        has_reversal: number;
      }>()
  ).results;
  for (const c of captures)
    events.push({
      id: c.id,
      user_id: c.user_id,
      name: c.name,
      date: dateInTimezone(goal.timezone, new Date(c.created_at * 1000)),
      amount_cents: Math.max(0, c.net_cents),
      version: 1,
      capture_id: c.provider_id,
      state:
        c.net_cents > 0 ? "received" : c.has_reversal ? "reversed" : "refunded",
      editable: false,
    });
  const pending = (
    await env.DB.prepare(
      "SELECT a.id,a.user_id,u.name,a.amount_cents,a.created_at FROM payment_attempts a JOIN users u ON u.id=a.user_id WHERE a.goal_id=? AND a.status='capture_pending' AND NOT EXISTS(SELECT 1 FROM ledger WHERE attempt_id=a.id AND kind='capture')",
    )
      .bind(goal.id)
      .all<{
        id: string;
        user_id: string;
        name: string;
        amount_cents: number;
        created_at: number;
      }>()
  ).results;
  for (const p of pending)
    events.push({
      id: "pending-" + p.id,
      user_id: p.user_id,
      name: p.name,
      date: dateInTimezone(goal.timezone, new Date(p.created_at * 1000)),
      amount_cents: p.amount_cents,
      version: 1,
      capture_id: null,
      state: "pending",
      editable: false,
    });
  if (goal.mode === "flexible") {
    const plans = (
      await env.DB.prepare(
        "SELECT p.*,u.name FROM personal_plans p JOIN users u ON u.id=p.user_id WHERE goal_id=?",
      )
        .bind(goal.id)
        .all<{
          user_id: string;
          name: string;
          amount_cents: number;
          frequency: Frequency;
          start_date: string;
          version: number;
        }>()
    ).results;
    const received = await env.DB.prepare(
      "SELECT COALESCE(SUM(amount_cents),0) AS n FROM ledger WHERE goal_id=?",
    )
      .bind(goal.id)
      .first<{ n: number }>();
    const remaining = Math.max(0, goal.target_cents - (received?.n || 0));
    const today = dateInTimezone(goal.timezone);
    for (const p of plans) {
      const start = new Date(p.start_date + "T00:00:00Z"),
        current = new Date(today + "T00:00:00Z");
      let index = Math.max(
        0,
        p.frequency === "monthly"
          ? (current.getUTCFullYear() - start.getUTCFullYear()) * 12 +
              current.getUTCMonth() -
              start.getUTCMonth()
          : Math.floor(
              (current.getTime() - start.getTime()) /
                (86400000 * (p.frequency === "weekly" ? 7 : 14)),
            ),
      );
      while (nextDate(p.start_date, index, p.frequency) < today) index++;
      for (let i = 0; i < 8 && i * p.amount_cents < remaining; i++) {
        const date = nextDate(p.start_date, index + i, p.frequency);
        events.push({
          id: "optional-" + p.user_id + "-" + date,
          user_id: p.user_id,
          name: p.name,
          date,
          amount_cents: Math.min(
            p.amount_cents,
            remaining - i * p.amount_cents,
          ),
          version: p.version,
          capture_id: null,
          state: "optional",
          editable: false,
        });
      }
    }
  }
  events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.user_id.localeCompare(b.user_id) ||
      a.id.localeCompare(b.id),
  );
  return {
    events,
    mode: goal.mode,
    commitment: await env.DB.prepare(
      "SELECT * FROM commitments WHERE goal_id=? AND user_id=?",
    )
      .bind(goal.id, userId)
      .first(),
  };
}
