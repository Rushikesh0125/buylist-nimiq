import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const orders = new Map<
  string,
  { id: string; customId: string; value: string; captured: boolean }
>();
let sequence = 0;
const uncertainCaptures = new Set<string>();
const setups = new Map<
  string,
  { id: string; customer: string; approved: boolean; body: any }
>();
const refunds = new Map<
  string,
  { id: string; captureId: string; value: string; status: string }
>();
const refundKeys = new Map<string, string>();
let pendingRefund = false,
  uncertainRefund = false,
  uncertainAutomatic = false;
const origin = "http://localhost:8787";
async function request(
  path: string,
  body?: unknown,
  method = "POST",
  user = "alice",
) {
  return mf.dispatchFetch(origin + path, {
    method,
    headers: {
      Cookie: "__Host-buylist=" + user,
      Origin: origin,
      "X-CSRF-Token": "csrf",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
before(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "buylist-payment-test",
      modules: true,
      scriptPath: ".wrangler/build/index.js",
      compatibilityDate: "2026-10-30",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      durableObjects: {
        GOAL_COORDINATOR: { className: "GoalCoordinator", useSQLite: true },
      },
      queueProducers: { RECONCILE: "payment-tests" },
      bindings: {
        APP_ORIGIN: origin,
        PAYPAL_MODE: "sandbox",
        PAYMENTS_ENABLED: "true",
        PAYPAL_CLIENT_ID: "test-only",
        PAYPAL_CLIENT_SECRET: "test-only",
        PAYPAL_MERCHANT_ID: "test-merchant",
      },
      outboundService: async (r) => {
        const u = new URL(r.url);
        assert.equal(u.origin, "https://api-m.sandbox.paypal.com");
        if (u.pathname === "/v1/oauth2/token")
          return Response.json({ access_token: "fixture-token" });
        if (u.pathname === "/v3/vault/setup-tokens" && r.method === "POST") {
          const body = (await r.json()) as any;
          assert.equal(
            body.payment_source.paypal.usage_pattern,
            "RECURRING_PREPAID",
          );
          const setup = {
            id: "SETUP-" + ++sequence,
            customer: body.customer.merchant_customer_id,
            approved: false,
            body,
          };
          setups.set(setup.id, setup);
          return Response.json({
            id: setup.id,
            status: "PAYER_ACTION_REQUIRED",
          });
        }
        if (u.pathname.startsWith("/v3/vault/setup-tokens/")) {
          const s = setups.get(u.pathname.split("/").pop()!)!;
          return Response.json({
            id: s.id,
            status: s.approved ? "APPROVED" : "PAYER_ACTION_REQUIRED",
            customer: {
              id: "CUSTOMER-" + s.customer,
              merchant_customer_id: s.customer,
            },
          });
        }
        if (u.pathname === "/v3/vault/payment-tokens") {
          const body = (await r.json()) as any;
          const s = setups.get(body.payment_source.token.id)!;
          assert.ok(s.approved);
          return Response.json({
            id: "TOKEN-" + s.id,
            customer: { id: "CUSTOMER-" + s.customer },
            payment_source: { paypal: {} },
          });
        }
        const refundPost = u.pathname.match(
          /^\/v2\/payments\/captures\/([^/]+)\/refund$/,
        );
        if (refundPost) {
          const body = (await r.json()) as any,
            key = r.headers.get("PayPal-Request-Id")!;
          let providerId = refundKeys.get(key);
          if (!providerId) {
            providerId = "REFUND-" + ++sequence;
            refundKeys.set(key, providerId);
            refunds.set(providerId, {
              id: providerId,
              captureId: refundPost[1],
              value: body.amount.value,
              status: pendingRefund ? "PENDING" : "COMPLETED",
            });
          }
          if (uncertainRefund) {
            uncertainRefund = false;
            return Response.json(
              { name: "INTERNAL_SERVER_ERROR" },
              { status: 503 },
            );
          }
          return Response.json({ id: providerId });
        }
        const refundGet = u.pathname.match(
          /^\/v2\/payments\/refunds\/([^/]+)$/,
        );
        if (refundGet) {
          const f = refunds.get(refundGet[1])!;
          return Response.json({
            id: f.id,
            status: f.status,
            amount: { currency_code: "USD", value: f.value },
            links: [
              {
                rel: "up",
                href:
                  "https://api-m.sandbox.paypal.com/v2/payments/captures/" +
                  f.captureId,
              },
            ],
          });
        }
        if (u.pathname === "/v2/checkout/orders" && r.method === "POST") {
          const b = (await r.json()) as {
            purchase_units: { custom_id: string; amount: { value: string } }[];
            payment_source?: {
              paypal: {
                vault_id: string;
                stored_credential: { payment_initiator: string };
              };
            };
          };
          const existing = [...orders.values()].find(
            (o) => o.customId === b.purchase_units[0].custom_id,
          );
          const o = existing || {
            id: "ORDER-" + ++sequence,
            customId: b.purchase_units[0].custom_id,
            value: b.purchase_units[0].amount.value,
            captured: !!b.payment_source,
          };
          orders.set(o.id, o);
          if (b.payment_source) {
            assert.ok(
              b.payment_source.paypal.vault_id.startsWith("TOKEN-SETUP-"),
            );
            assert.equal(
              b.payment_source.paypal.stored_credential.payment_initiator,
              "MERCHANT",
            );
            if (uncertainAutomatic) {
              uncertainAutomatic = false;
              return Response.json(
                { name: "INTERNAL_SERVER_ERROR" },
                { status: 503 },
              );
            }
          }
          return Response.json(
            { id: o.id, status: "CREATED", links: [] },
            { status: 201 },
          );
        }
        const match = u.pathname.match(
          /^\/v2\/checkout\/orders\/(ORDER-\d+)(\/capture)?$/,
        );
        assert.ok(match, "Unexpected provider request");
        const o = orders.get(match[1])!;
        if (match[2]) {
          o.captured = true;
          if (uncertainCaptures.delete(o.id))
            return Response.json(
              { name: "INTERNAL_SERVER_ERROR" },
              { status: 503 },
            );
        }
        return Response.json(render(o));
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
  await db
    .prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)",
    )
    .bind("alice", "alice", "alice@example.test", "Alice", now)
    .run();
  await db
    .prepare(
      "INSERT INTO users(id,google_sub,email,name,created_at) VALUES(?,?,?,?,?)",
    )
    .bind("bob", "bob", "bob@example.test", "Bob", now)
    .run();
  await db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
    )
    .bind(
      createHash("sha256").update("bob").digest("hex"),
      "bob",
      "csrf",
      now + 3600,
    )
    .run();
  await db
    .prepare(
      "INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES(?,?,?,?)",
    )
    .bind(
      createHash("sha256").update("alice").digest("hex"),
      "alice",
      "csrf",
      now + 3600,
    )
    .run();
});
function render(o: {
  id: string;
  customId: string;
  value: string;
  captured: boolean;
}) {
  return {
    id: o.id,
    status: o.captured ? "COMPLETED" : "CREATED",
    purchase_units: [
      {
        custom_id: o.customId,
        payee: { merchant_id: "test-merchant" },
        amount: { value: o.value, currency_code: "USD" },
        ...(o.captured
          ? {
              payments: {
                captures: [
                  {
                    id: "CAPTURE-" + o.id,
                    status: "COMPLETED",
                    amount: { value: o.value, currency_code: "USD" },
                  },
                ],
              },
            }
          : {}),
      },
    ],
  };
}
after(async () => mf?.dispose());
test("minimal PayPal creation responses support retry and capture credits the ledger once", async () => {
  const { id } = (await (
    await request("/api/goals", {
      name: "PayPal fixture goal",
      mode: "solo",
      targetCents: 10000,
      timezone: "UTC",
    })
  ).json()) as { id: string };
  const body = {
    goalId: id,
    amountCents: 2500,
    requestKey: crypto.randomUUID(),
  };
  const first = await request("/api/payments/orders", body);
  assert.equal(first.status, 201);
  const a = (await first.json()) as { orderId: string };
  const b = (await (await request("/api/payments/orders", body)).json()) as {
    orderId: string;
  };
  assert.equal(a.orderId, b.orderId);
  assert.equal(orders.size, 1);
  assert.equal(
    (await request("/api/payments/orders/" + a.orderId + "/capture", {}))
      .status,
    200,
  );
  assert.equal(
    (await request("/api/payments/orders/" + a.orderId + "/capture", {}))
      .status,
    200,
  );
  const sum = await db
    .prepare(
      "SELECT COUNT(*) AS count,SUM(amount_cents) AS total FROM ledger WHERE goal_id=?",
    )
    .bind(id)
    .first<{ count: number; total: number }>();
  assert.deepEqual(sum, { count: 1, total: 2500 });
  const attempt = await db
    .prepare("SELECT reserved,status FROM payment_attempts WHERE order_id=?")
    .bind(a.orderId)
    .first<{ reserved: number; status: string }>();
  assert.equal(attempt?.reserved, 0);
  assert.equal(attempt?.status, "completed");
});
test("duplicate refund adjustments cannot subtract twice or exceed received funds", async () => {
  const a = await db
    .prepare(
      "SELECT id,goal_id,capture_id FROM payment_attempts WHERE capture_id IS NOT NULL LIMIT 1",
    )
    .first<{ id: string; goal_id: string; capture_id: string }>();
  assert.ok(a);
  const ns = await mf.getDurableObjectNamespace("GOAL_COORDINATOR");
  const stub = ns.get(ns.idFromName(a.goal_id)) as unknown as {
    adjust: (c: string, p: string, a: number, k: string) => Promise<unknown>;
  };
  await stub.adjust(a.capture_id, "refund-test", 1000, "refund");
  await stub.adjust(a.capture_id, "refund-test", 1000, "refund");
  const net = await db
    .prepare("SELECT SUM(amount_cents) AS total FROM ledger WHERE goal_id=?")
    .bind(a.goal_id)
    .first<{ total: number }>();
  assert.equal(net?.total, 1500);
  await assert.rejects(async () =>
    stub.adjust(a.capture_id, "refund-too-large", 2000, "refund"),
  );
  const still = await db
    .prepare("SELECT SUM(amount_cents) AS total FROM ledger WHERE goal_id=?")
    .bind(a.goal_id)
    .first<{ total: number }>();
  assert.equal(still?.total, 1500);
});
test("uncertain capture remains reserved until provider reconciliation credits it once", async () => {
  const { id } = (await (
    await request("/api/goals", {
      name: "Uncertain capture",
      mode: "solo",
      targetCents: 5000,
      timezone: "UTC",
    })
  ).json()) as { id: string };
  const { orderId, attemptId } = (await (
    await request("/api/payments/orders", {
      goalId: id,
      amountCents: 3000,
      requestKey: crypto.randomUUID(),
    })
  ).json()) as { orderId: string; attemptId: string };
  uncertainCaptures.add(orderId);
  assert.equal(
    (await request("/api/payments/orders/" + orderId + "/capture", {})).status,
    502,
  );
  const held = await db
    .prepare("SELECT reserved,status FROM payment_attempts WHERE id=?")
    .bind(attemptId)
    .first();
  assert.deepEqual(held, { reserved: 1, status: "capture_pending" });
  const before = await db
    .prepare("SELECT COUNT(*) AS count FROM ledger WHERE goal_id=?")
    .bind(id)
    .first();
  assert.deepEqual(before, { count: 0 });
  const ns = await mf.getDurableObjectNamespace("GOAL_COORDINATOR");
  const stub = ns.get(ns.idFromName(id)) as unknown as {
    reconcile: (id: string) => Promise<unknown>;
  };
  await stub.reconcile(attemptId);
  await stub.reconcile(attemptId);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT COUNT(*) AS count,SUM(amount_cents) AS total FROM ledger WHERE goal_id=?",
      )
      .bind(id)
      .first(),
    { count: 1, total: 3000 },
  );
  assert.deepEqual(
    await db
      .prepare("SELECT reserved,status FROM payment_attempts WHERE id=?")
      .bind(attemptId)
      .first(),
    { reserved: 0, status: "completed" },
  );
});
test("late capture reconciliation cannot restore refunded money or clear reversal state", async () => {
  const a = await db
    .prepare(
      "SELECT id,goal_id FROM payment_attempts WHERE status='reversed' LIMIT 1",
    )
    .first<{ id: string; goal_id: string }>();
  assert.ok(a);
  const ns = await mf.getDurableObjectNamespace("GOAL_COORDINATOR");
  const stub = ns.get(ns.idFromName(a.goal_id)) as unknown as {
    reconcile: (id: string) => Promise<unknown>;
  };
  await stub.reconcile(a.id);
  assert.deepEqual(
    await db
      .prepare("SELECT SUM(amount_cents) AS total FROM ledger WHERE goal_id=?")
      .bind(a.goal_id)
      .first(),
    { total: 1500 },
  );
  assert.deepEqual(
    await db
      .prepare("SELECT status FROM payment_attempts WHERE id=?")
      .bind(a.id)
      .first(),
    { status: "reversed" },
  );
});

async function newGoal(mode = "solo", target = 10000) {
  const r = await request("/api/goals", {
    name: "Payment integration test",
    mode,
    targetCents: target,
    timezone: "UTC",
  });
  assert.equal(r.status, 201);
  return ((await r.json()) as { id: string }).id;
}
async function automatic(goalId: string, amount = 2500) {
  const path = "/api/goals/" + goalId + "/automatic";
  const r = await request(path + "/setup", {
    amountCents: amount,
    frequency: "weekly",
    startDate: new Date().toISOString().slice(0, 10),
    requestKey: crypto.randomUUID(),
    consent: true,
  });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const { setupToken } = (await r.json()) as { setupToken: string };
  return { path, setupToken };
}
async function approve(path: string, setupToken: string) {
  setups.get(setupToken)!.approved = true;
  const r = await request(path + "/approve", { setupToken });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  return ((await r.json()) as { plan: { id: string } }).plan.id;
}
async function service(goalId: string) {
  const ns = await mf.getDurableObjectNamespace("GOAL_COORDINATOR");
  return ns.get(ns.idFromName(goalId)) as unknown as {
    runAutomatic(id: string): Promise<unknown>;
    reconcileRefund(id: string): Promise<unknown>;
  };
}
test("automatic contributions require explicit consent and matching PayPal approval; tokens stay private", async () => {
  const gid = await newGoal("flexible");
  const path = "/api/goals/" + gid + "/automatic";
  assert.equal(
    (await request(path + "/setup", { consent: false })).status,
    400,
  );
  const { setupToken } = await automatic(gid);
  assert.equal((await request(path + "/approve", { setupToken })).status, 409);
  assert.equal(
    (await request(path + "/approve", { setupToken: "FOREIGN" })).status,
    403,
  );
  assert.equal((await request(path, undefined, "GET", "bob")).status, 404);
  const planId = await approve(path, setupToken);
  const state = (await (await request(path, undefined, "GET")).json()) as any;
  assert.equal(state.plan.state, "active");
  assert.equal(state.plan.token_id, undefined);
  assert.equal(state.plan.setup_id, undefined);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM commitments WHERE goal_id=?")
        .bind(gid)
        .first<{ n: number }>()
    )?.n,
    0,
  );
  await (await service(gid)).runAutomatic(planId);
});
test("duplicate automatic queue messages charge once, cap the final contribution, and skip missed dates", async () => {
  const gid = await newGoal("solo", 1800),
    { path, setupToken } = await automatic(gid, 2500),
    planId = await approve(path, setupToken);
  const svc = await service(gid);
  await Promise.all([svc.runAutomatic(planId), svc.runAutomatic(planId)]);
  assert.deepEqual(
    await db
      .prepare(
        "SELECT COUNT(*) AS n,SUM(amount_cents) AS total FROM ledger WHERE goal_id=?",
      )
      .bind(gid)
      .first(),
    { n: 1, total: 1800 },
  );
  const p = await db
    .prepare("SELECT next_date,state FROM automatic_plans WHERE id=?")
    .bind(planId)
    .first<{ next_date: string; state: string }>();
  assert.ok(p!.next_date > new Date().toISOString().slice(0, 10));
  await db
    .prepare("UPDATE automatic_plans SET next_date='2020-01-01' WHERE id=?")
    .bind(planId)
    .run();
  await svc.runAutomatic(planId);
  assert.deepEqual(
    await db
      .prepare("SELECT state FROM automatic_plans WHERE id=?")
      .bind(planId)
      .first(),
    { state: "finished" },
  );
});
test("pause/cancel stop future starts; saved schedule edits cannot change authorized terms", async () => {
  const gid = await newGoal(),
    { path, setupToken } = await automatic(gid),
    planId = await approve(path, setupToken),
    svc = await service(gid);
  assert.equal((await request(path + "/pause", {})).status, 200);
  await svc.runAutomatic(planId);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM payment_attempts WHERE goal_id=?")
        .bind(gid)
        .first<{ n: number }>()
    )?.n,
    0,
  );
  await request(
    "/api/goals/" + gid + "/schedule",
    {
      version: 0,
      amountCents: 1000,
      frequency: "monthly",
      startDate: new Date().toISOString().slice(0, 10),
    },
    "PUT",
  );
  assert.equal(
    (
      await db
        .prepare("SELECT amount_cents FROM automatic_plans WHERE id=?")
        .bind(planId)
        .first<{ amount_cents: number }>()
    )?.amount_cents,
    2500,
  );
  assert.equal((await request(path + "/resume", {})).status, 200);
  assert.equal((await request(path + "/cancel", {})).status, 200);
  await svc.runAutomatic(planId);
  assert.equal((await request(path + "/resume", {})).status, 409);
  // Reauthorization has a new consent generation without discarding old cycle history.
  const again = await automatic(gid, 1200);
  await approve(again.path, again.setupToken);
  const history = (
    await db
      .prepare(
        "SELECT terms_json,approved_at,cancelled_at FROM automatic_authorizations WHERE plan_id=? ORDER BY created_at,authorization_key",
      )
      .bind(planId)
      .all<{
        terms_json: string;
        approved_at: number | null;
        cancelled_at: number | null;
      }>()
  ).results;
  assert.equal(history.length, 2);
  assert.deepEqual(
    history
      .map((h) => JSON.parse(h.terms_json).amountCents)
      .sort((a, b) => a - b),
    [1200, 2500],
  );
  assert.ok(history.every((h) => h.approved_at));
  assert.equal(history.filter((h) => h.cancelled_at).length, 1);
});
test("fixed automatic contributions respect equal shares; manual reservations reduce available target", async () => {
  const gid = await newGoal("fixed", 10001);
  await db
    .prepare(
      "INSERT INTO memberships(goal_id,user_id,role,joined_at) VALUES(?,'bob','member',?)",
    )
    .bind(gid, Math.floor(Date.now() / 1000))
    .run();
  const { path, setupToken } = await automatic(gid, 9000),
    planId = await approve(path, setupToken);
  await (await service(gid)).runAutomatic(planId);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT SUM(amount_cents) AS n FROM ledger WHERE goal_id=? AND user_id=?",
        )
        .bind(gid, "alice")
        .first<{ n: number }>()
    )?.n,
    5001,
  );
  const other = await newGoal("solo", 10000);
  await request("/api/payments/orders", {
    goalId: other,
    amountCents: 8500,
    requestKey: crypto.randomUUID(),
  });
  const auto = await automatic(other, 4000),
    autoId = await approve(auto.path, auto.setupToken);
  await (await service(other)).runAutomatic(autoId);
  assert.equal(
    (
      await db
        .prepare("SELECT SUM(amount_cents) AS n FROM ledger WHERE goal_id=?")
        .bind(other)
        .first<{ n: number }>()
    )?.n,
    1500,
  );
});
test("uncertain automatic order creation remains reserved and pauses without a second charge", async () => {
  const gid = await newGoal(),
    { path, setupToken } = await automatic(gid),
    planId = await approve(path, setupToken),
    svc = await service(gid);
  uncertainAutomatic = true;
  await svc.runAutomatic(planId);
  await svc.runAutomatic(planId);
  assert.deepEqual(
    await db
      .prepare("SELECT status,reserved FROM payment_attempts WHERE goal_id=?")
      .bind(gid)
      .first(),
    { status: "capture_pending", reserved: 1 },
  );
  assert.equal((await request(path + "/resume", {})).status, 409);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM automatic_cycles WHERE plan_id=?")
        .bind(planId)
        .first<{ n: number }>()
    )?.n,
    1,
  );
});
async function captured(gid: string, amount = 5000) {
  const r = await request("/api/payments/orders", {
    goalId: gid,
    amountCents: amount,
    requestKey: crypto.randomUUID(),
  });
  assert.equal(r.status, 201);
  const a = (await r.json()) as { attemptId: string; orderId: string };
  assert.equal(
    (await request("/api/payments/orders/" + a.orderId + "/capture", {}))
      .status,
    200,
  );
  return a.attemptId;
}
test("full/partial refunds require payment ownership and deduplicate requests and ledger adjustments", async () => {
  const gid = await newGoal(),
    aid = await captured(gid),
    path = "/api/payments/" + aid + "/refunds";
  assert.equal(
    (
      await request(
        path,
        { amountCents: 1000, requestKey: crypto.randomUUID() },
        "POST",
        "bob",
      )
    ).status,
    404,
  );
  const body = { amountCents: 2000, requestKey: crypto.randomUUID() };
  const first = await request(path, body);
  assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
  assert.equal((await request(path, body)).status, 200);
  assert.equal(
    (await request(path, { ...body, amountCents: 2001 })).status,
    409,
  );
  assert.equal(
    (
      await request(path, {
        amountCents: 3001,
        requestKey: crypto.randomUUID(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(path, {
        amountCents: 3000,
        requestKey: crypto.randomUUID(),
      })
    ).status,
    200,
  );
  assert.deepEqual(
    await db
      .prepare(
        "SELECT SUM(amount_cents) AS n,COUNT(*) AS count FROM ledger WHERE goal_id=?",
      )
      .bind(gid)
      .first(),
    { n: 0, count: 3 },
  );
});
test("pending and concurrent refunds reserve funds, pause automation, and credit only after confirmation", async () => {
  const gid = await newGoal(),
    aid = await captured(gid),
    auto = await automatic(gid),
    planId = await approve(auto.path, auto.setupToken);
  pendingRefund = true;
  const path = "/api/payments/" + aid + "/refunds";
  const results = await Promise.all([
    request(path, { amountCents: 3000, requestKey: crypto.randomUUID() }),
    request(path, { amountCents: 3000, requestKey: crypto.randomUUID() }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (
      await db
        .prepare("SELECT SUM(amount_cents) AS n FROM ledger WHERE goal_id=?")
        .bind(gid)
        .first<{ n: number }>()
    )?.n,
    5000,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT state FROM automatic_plans WHERE id=?")
        .bind(planId)
        .first<{ state: string }>()
    )?.state,
    "paused",
  );
  assert.equal((await request(auto.path + "/resume", {})).status, 409);
  const row = await db
    .prepare("SELECT id,provider_id FROM refund_requests WHERE attempt_id=?")
    .bind(aid)
    .first<{ id: string; provider_id: string }>();
  refunds.get(row!.provider_id)!.status = "COMPLETED";
  pendingRefund = false;
  const svc = await service(gid);
  await svc.reconcileRefund(row!.id);
  await svc.reconcileRefund(row!.id);
  assert.equal(
    (
      await db
        .prepare("SELECT SUM(amount_cents) AS n FROM ledger WHERE goal_id=?")
        .bind(gid)
        .first<{ n: number }>()
    )?.n,
    2000,
  );
});
test("uncertain refund response uses the same persisted provider key on reconciliation", async () => {
  const gid = await newGoal(),
    aid = await captured(gid);
  uncertainRefund = true;
  assert.equal(
    (
      await request("/api/payments/" + aid + "/refunds", {
        amountCents: 1000,
        requestKey: crypto.randomUUID(),
      })
    ).status,
    502,
  );
  const row = await db
    .prepare("SELECT id FROM refund_requests WHERE attempt_id=?")
    .bind(aid)
    .first<{ id: string }>();
  const before = refunds.size;
  const svc = await service(gid);
  await svc.reconcileRefund(row!.id);
  assert.equal(refunds.size, before);
  assert.equal(
    (
      await db
        .prepare("SELECT SUM(amount_cents) AS n FROM ledger WHERE goal_id=?")
        .bind(gid)
        .first<{ n: number }>()
    )?.n,
    4000,
  );
});
test("automatic authorization cannot expand when the goal target increases, including concurrent reservations", async () => {
  const gid = await newGoal("solo", 3000),
    auto = await automatic(gid, 5000),
    planId = await approve(auto.path, auto.setupToken);
  await db
    .prepare("UPDATE goals SET target_cents=9000 WHERE id=?")
    .bind(gid)
    .run();
  await (await service(gid)).runAutomatic(planId);
  assert.equal(
    (
      await db
        .prepare("SELECT SUM(amount_cents) AS n FROM ledger WHERE goal_id=?")
        .bind(gid)
        .first<{ n: number }>()
    )?.n,
    3000,
  );
  const p = (await (await request(auto.path, undefined, "GET")).json()) as any;
  assert.equal(p.plan.targetCents, 3000);
  assert.equal(p.plan.limitCents, 3000);
});
test("automatic recovery after a crash advances an already paid cycle without charging again", async () => {
  const gid = await newGoal(),
    auto = await automatic(gid),
    planId = await approve(auto.path, auto.setupToken),
    svc = await service(gid);
  await svc.runAutomatic(planId);
  await db
    .prepare(
      "UPDATE automatic_plans SET next_index=0,next_date='2020-01-01' WHERE id=?",
    )
    .bind(planId)
    .run();
  await svc.runAutomatic(planId);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) AS n FROM ledger WHERE goal_id=?")
        .bind(gid)
        .first<{ n: number }>()
    )?.n,
    1,
  );
  const p = await db
    .prepare("SELECT next_index FROM automatic_plans WHERE id=?")
    .bind(planId)
    .first<{ next_index: number }>();
  assert.ok(p!.next_index > 0);
});
test("refunds and automatic authorizations reject missing CSRF; expired uncertain refunds cannot be replayed", async () => {
  const gid = await newGoal(),
    aid = await captured(gid);
  for (const path of [
    "/api/payments/" + aid + "/refunds",
    "/api/goals/" + gid + "/automatic/setup",
  ]) {
    const r = await mf.dispatchFetch(origin + path, {
      method: "POST",
      headers: {
        Cookie: "__Host-buylist=alice",
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(r.status, 403);
  }
  const rid = crypto.randomUUID();
  await db
    .prepare(
      "INSERT INTO refund_requests(id,attempt_id,user_id,request_key,amount_cents,state,created_at,updated_at) VALUES(?,?,'alice',?,1000,'created',?,?)",
    )
    .bind(
      rid,
      aid,
      crypto.randomUUID(),
      Math.floor(Date.now() / 1000) - 4 * 3600,
      Math.floor(Date.now() / 1000),
    )
    .run();
  const before = refunds.size;
  await assert.rejects(() => service(gid).then((s) => s.reconcileRefund(rid)));
  assert.equal(refunds.size, before);
});
