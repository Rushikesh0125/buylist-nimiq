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
      bindings: {
        APP_ORIGIN: origin,
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
test("flexible members can save versioned personal plans without commitments or shared ownership", async () => {
  const { id } = (await (
    await request("/api/goals", "POST", {
      name: "Voluntary group",
      targetCents: 10000,
      mode: "flexible",
      timezone: "UTC",
    })
  ).json()) as { id: string };
  const endpoint = "/api/goals/" + id + "/personal-plan";
  const draft = {
    version: 0,
    amountCents: 2500,
    frequency: "weekly",
    startDate: "2026-11-09",
  };
  assert.equal((await request(endpoint, "GET", undefined, "bob")).status, 404);
  assert.equal(
    (await request(endpoint, "PUT", { ...draft, version: 1 })).status,
    409,
  );
  assert.equal((await request(endpoint, "PUT", draft)).status, 200);
  assert.equal((await request(endpoint, "PUT", draft)).status, 409);
  const { url } = (await (
    await request("/api/goals/" + id + "/invitations", "POST", {})
  ).json()) as { url: string };
  assert.equal(
    (
      await request(
        "/api/invitations/" + url.split("/").pop() + "/accept",
        "POST",
        {},
        "bob",
      )
    ).status,
    200,
  );
  assert.deepEqual(
    await (await request(endpoint, "GET", undefined, "bob")).json(),
    { plan: null },
  );
  assert.equal(
    (
      await request(
        endpoint,
        "PUT",
        { ...draft, amountCents: 7000, userId: "alice" },
        "bob",
      )
    ).status,
    200,
  );
  const own = (await (await request(endpoint)).json()) as {
    plan: { amount_cents: number; version: number };
  };
  assert.equal(own.plan.amount_cents, 2500);
  assert.equal(own.plan.version, 1);
  assert.equal(
    (
      await request(endpoint, "PUT", {
        ...draft,
        version: 1,
        amountCents: 3000,
      })
    ).status,
    200,
  );
  const updated = (await (await request(endpoint)).json()) as {
    plan: { amount_cents: number; version: number };
  };
  assert.equal(updated.plan.amount_cents, 3000);
  assert.equal(updated.plan.version, 2);
  assert.deepEqual(
    await db
      .prepare("SELECT COUNT(*) AS count FROM commitments WHERE goal_id=?")
      .bind(id)
      .first(),
    { count: 0 },
  );
  assert.deepEqual(
    await db
      .prepare("SELECT COUNT(*) AS count FROM ledger WHERE goal_id=?")
      .bind(id)
      .first(),
    { count: 0 },
  );
  assert.equal(
    (
      await request(endpoint, "PUT", {
        ...draft,
        version: 2,
        startDate: "2026-02-30",
      })
    ).status,
    400,
  );
});
test("personal optional plans cannot replace solo or fixed accepted schedules", async () => {
  for (const mode of ["solo", "fixed"]) {
    const { id } = (await (
      await request("/api/goals", "POST", {
        name: "Accepted schedule",
        targetCents: 10000,
        mode,
        timezone: "UTC",
      })
    ).json()) as { id: string };
    assert.equal(
      (
        await request("/api/goals/" + id + "/personal-plan", "PUT", {
          version: 0,
          amountCents: 2500,
          frequency: "weekly",
          startDate: "2026-11-09",
        })
      ).status,
      400,
    );
  }
});
test("unauthenticated access is denied and unconfigured OAuth fails closed", async () => {
  assert.equal(
    (await request("/api/goals", "GET", undefined, "unknown")).status,
    401,
  );
  const response = await request("/api/auth/google/start");
  assert.equal(response.status, 503);
});
test("CSRF token required for creating a goal", async () =>
  assert.equal(
    (
      await request(
        "/api/goals",
        "POST",
        { name: "Nope", targetCents: 1000, mode: "solo", timezone: "UTC" },
        "alice",
        false,
      )
    ).status,
    403,
  ));
test("goals start with zero and cannot be accessed by another user", async () => {
  const created = await request("/api/goals", "POST", {
    name: "Private goal",
    targetCents: 10000,
    mode: "solo",
    timezone: "UTC",
  });
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };
  const detail = (await (await request("/api/goals/" + id)).json()) as {
    goal: { saved_cents: number };
  };
  assert.equal(detail.goal.saved_cents, 0);
  assert.equal(
    (await request("/api/goals/" + id, "GET", undefined, "eve")).status,
    404,
  );
});
test("invites are single use and fixed schedule version conflicts are rejected", async () => {
  const { id } = (await (
    await request("/api/goals", "POST", {
      name: "Group",
      targetCents: 10001,
      mode: "fixed",
      timezone: "UTC",
    })
  ).json()) as { id: string };
  const { url } = (await (
    await request("/api/goals/" + id + "/invitations", "POST", {})
  ).json()) as { url: string };
  const token = url.split("/").pop();
  assert.equal(
    (await request("/api/invitations/" + token + "/accept", "POST", {}, "bob"))
      .status,
    200,
  );
  assert.equal(
    (await request("/api/invitations/" + token + "/accept", "POST", {}, "eve"))
      .status,
    410,
  );
  const body = {
    version: 0,
    amountCents: 2000,
    frequency: "monthly",
    startDate: "2026-11-30",
  };
  assert.equal(
    (await request("/api/goals/" + id + "/schedule", "PUT", body)).status,
    200,
  );
  assert.equal(
    (await request("/api/goals/" + id + "/schedule", "PUT", body)).status,
    409,
  );
  assert.equal(
    (
      await request("/api/goals/" + id + "/schedule", "PUT", {
        ...body,
        version: 1,
      })
    ).status,
    200,
  );
  const schedule = (await (
    await request("/api/goals/" + id + "/schedule")
  ).json()) as { events: { user_id: string; amount_cents: number }[] };
  assert.equal(
    schedule.events.reduce((sum, e) => sum + e.amount_cents, 0),
    5001,
  );
  assert.ok(schedule.events.every((e) => e.user_id === "alice"));
});
test("flexible groups reject mandatory schedules but support forecasts", async () => {
  const { id } = (await (
    await request("/api/goals", "POST", {
      name: "Flexible",
      targetCents: 9000,
      mode: "flexible",
      timezone: "UTC",
    })
  ).json()) as { id: string };
  const body = {
    version: 0,
    amountCents: 2000,
    frequency: "weekly",
    startDate: "2026-11-01",
  };
  assert.equal(
    (await request("/api/goals/" + id + "/schedule", "PUT", body)).status,
    400,
  );
  const result = (await (
    await request("/api/goals/" + id + "/forecast", "POST", body)
  ).json()) as { count: number; scenario: string };
  assert.equal(result.count, 5);
  assert.equal(result.scenario, "what-if");
});
test("retired payment routes cannot create an order or ledger entry", async () => {
  const result = await request("/api/payments/orders", "POST", {
    goalId: crypto.randomUUID(),
    amountCents: 1000,
    requestKey: crypto.randomUUID(),
  });
  assert.equal(result.status, 404);
  const count = await db
    .prepare("SELECT COUNT(*) AS count FROM ledger")
    .first<{ count: number }>();
  assert.equal(count?.count, 0);
});
test("logout requires CSRF and invalidates only the current session", async () => {
  assert.equal(
    (await request("/api/auth/logout", "POST", {}, "eve", false)).status,
    403,
  );
  assert.equal(
    (await request("/api/auth/logout", "POST", {}, "eve")).status,
    200,
  );
  assert.equal(
    (await request("/api/goals", "GET", undefined, "eve")).status,
    401,
  );
  assert.equal(
    (await request("/api/goals", "GET", undefined, "alice")).status,
    200,
  );
});
test("only owners can update unlocked targets and pending reservations block updates", async () => {
  const { id } = (await (
    await request("/api/goals", "POST", {
      name: "Price update",
      targetCents: 10000,
      mode: "solo",
      timezone: "UTC",
    })
  ).json()) as { id: string };
  let detail = (await (await request("/api/goals/" + id)).json()) as {
    goal: { version: number };
  };
  assert.equal(
    (
      await request(
        "/api/goals/" + id,
        "PATCH",
        { version: detail.goal.version, targetCents: 12000 },
        "bob",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await request("/api/goals/" + id, "PATCH", {
        version: detail.goal.version,
        targetCents: 12000,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/goals/" + id, "PATCH", {
        version: detail.goal.version,
        targetCents: 13000,
      })
    ).status,
    409,
  );
  detail = (await (await request("/api/goals/" + id)).json()) as {
    goal: { version: number };
  };
  await db.prepare(
    "INSERT INTO payment_attempts(id,goal_id,user_id,request_key,amount_cents,currency,status,reserved,created_at,updated_at) VALUES(?,?,'alice',?,2000,'USD','capture_pending',1,0,0)",
  ).bind(crypto.randomUUID(), id, crypto.randomUUID()).run();
  assert.equal(
    (
      await request("/api/goals/" + id, "PATCH", {
        version: detail.goal.version,
        targetCents: 13000,
      })
    ).status,
    409,
  );
});
