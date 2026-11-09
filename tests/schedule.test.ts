import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const origin = "http://localhost:8787";
async function request(
  path: string,
  method = "GET",
  body?: unknown,
  user = "alice",
  csrf = true,
) {
  return mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Cookie: "__Host-buylist=" + user,
      Origin: origin,
      ...(csrf ? { "X-CSRF-Token": user + "-csrf" } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "buylist-test",
      modules: true,
      scriptPath: ".wrangler/build/index.js",
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      durableObjects: {
        GOAL_COORDINATOR: { className: "GoalCoordinator", useSQLite: true },
      },
      queueProducers: { RECONCILE: "test-reconcile" },
      bindings: {
        APP_ORIGIN: origin,
        PAYPAL_MODE: "sandbox",
        PAYMENTS_ENABLED: "false",
        ENVIRONMENT: "local",
      },
    }),
  );
  db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations")).sort()) {
    const sql = await readFile("migrations/" + file, "utf8");
    for (const statement of sql.match(
      /CREATE TRIGGER[\s\S]*?END;|(?:ALTER TABLE|CREATE TABLE|CREATE INDEX|PRAGMA)[^;]*;/g,
    ) || [])
      await db.prepare(statement).run();
  }
  const now = Math.floor(Date.now() / 1000);
  for (const name of ["alice", "bob", "eve"]) {
    await db
      .prepare(
        "INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)",
      )
      .bind(name, name, name + "@example.test", name, now)
      .run();
    await db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
      )
      .bind(sha(name), name, name + "-csrf", now + 3600)
      .run();
  }
});
after(async () => mf?.dispose());
test("schedule reads use the goal timezone, net refunds, pending states and member edit permissions", async () => {
  const created = await request("/api/goals", "POST", {
    name: "Planner semantics",
    mode: "solo",
    targetCents: 10000,
    timezone: "Asia/Kolkata",
  });
  const { id } = (await created.json()) as { id: string };
  const attempt = crypto.randomUUID(),
    capture = crypto.randomUUID(),
    when = Math.floor(Date.parse("2026-11-05T20:00:00Z") / 1000);
  await db
    .prepare(
      "INSERT INTO payment_attempts(id,goal_id,user_id,request_key,amount_cents,currency,status,reserved,created_at,updated_at,capture_id) VALUES(?,?,'alice',?,5000,'USD','reversed',0,?,?,?)",
    )
    .bind(attempt, id, crypto.randomUUID(), when, when, capture)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger(id,goal_id,user_id,attempt_id,provider_id,kind,amount_cents,created_at) VALUES(?,?,'alice',?,?,'capture',5000,?)",
    )
    .bind(crypto.randomUUID(), id, attempt, capture, when)
    .run();
  await db
    .prepare(
      "INSERT INTO ledger(id,goal_id,user_id,attempt_id,provider_id,kind,amount_cents,created_at) VALUES(?,?,'alice',?,?,'refund',-2000,?)",
    )
    .bind(crypto.randomUUID(), id, attempt, crypto.randomUUID(), when)
    .run();
  await db
    .prepare(
      "INSERT INTO payment_attempts(id,goal_id,user_id,request_key,amount_cents,currency,status,created_at,updated_at) VALUES(?,?,'alice',?,1000,'USD','capture_pending',?,?)",
    )
    .bind(crypto.randomUUID(), id, crypto.randomUUID(), when, when)
    .run();
  const eventId = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO schedule_events(id,goal_id,user_id,date,amount_cents) VALUES(?,?,'alice','2026-11-09',2500)",
    )
    .bind(eventId, id)
    .run();
  await db
    .prepare(
      "INSERT INTO schedule_events(id,goal_id,user_id,date,amount_cents,capture_id) VALUES(?,?,'alice','2026-11-05',5000,?)",
    )
    .bind(crypto.randomUUID(), id, capture)
    .run();
  let schedule = (await (
    await request("/api/goals/" + id + "/schedule")
  ).json()) as any;
  const received = schedule.events.find((e: any) => e.state === "received");
  assert.equal(
    schedule.events.filter((e: any) => e.state === "received").length,
    1,
  );
  assert.equal(received.date, "2026-11-06");
  assert.equal(received.amount_cents, 3000);
  assert.equal(received.editable, false);
  assert.equal(
    schedule.events.find((e: any) => e.state === "pending").editable,
    false,
  );
  assert.equal(
    schedule.events.find((e: any) => e.id === eventId).editable,
    true,
  );
  assert.equal(
    (
      await request(
        "/api/goals/" + id + "/schedule/events/" + eventId,
        "PATCH",
        { version: 1, date: "2026-11-11" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        "/api/goals/" + id + "/schedule/events/" + eventId,
        "PATCH",
        { version: 1, date: "2026-11-12" },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request(
        "/api/goals/" + id + "/schedule/events/" + received.id,
        "PATCH",
        { version: 1, date: "2026-11-12" },
      )
    ).status,
    409,
  );
  assert.equal(
    (await request("/api/goals/" + id + "/schedule", "GET", undefined, "bob"))
      .status,
    404,
  );
  await db
    .prepare(
      "INSERT INTO ledger(id,goal_id,user_id,attempt_id,provider_id,kind,amount_cents,created_at) VALUES(?,?,'alice',?,?,'refund',-3000,?)",
    )
    .bind(crypto.randomUUID(), id, attempt, crypto.randomUUID(), when)
    .run();
  schedule = await (await request("/api/goals/" + id + "/schedule")).json();
  assert.equal(
    schedule.events.find((e: any) => e.id === received.id).state,
    "refunded",
  );
  await db
    .prepare(
      "UPDATE ledger SET kind='reversal' WHERE attempt_id=? AND kind='refund' AND amount_cents=-3000",
    )
    .bind(attempt)
    .run();
  const reversed = (await (
    await request("/api/goals/" + id + "/schedule")
  ).json()) as any;
  assert.equal(
    reversed.events.find((e: any) => e.id === received.id).state,
    "reversed",
  );
});
test("flexible saved plans appear only as optional read-only projections", async () => {
  const { id } = (await (
    await request("/api/goals", "POST", {
      name: "Optional planner",
      mode: "flexible",
      targetCents: 10000,
      timezone: "UTC",
    })
  ).json()) as { id: string };
  await request("/api/goals/" + id + "/personal-plan", "PUT", {
    version: 0,
    amountCents: 2500,
    frequency: "weekly",
    startDate: "2026-11-01",
  });
  const schedule = (await (
    await request("/api/goals/" + id + "/schedule")
  ).json()) as any;
  assert.ok(schedule.events.length > 0);
  assert.ok(
    schedule.events.every((e: any) => e.state === "optional" && !e.editable),
  );
  assert.equal(schedule.commitment, null);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM ledger WHERE goal_id=?")
        .bind(id)
        .first<{ n: number }>()
    )?.n,
    0,
  );
});
