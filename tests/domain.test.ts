import { test } from "node:test";
import assert from "node:assert/strict";
import {
  equalShare,
  forecast,
  httpsUrl,
  nextDate,
  validDate,
} from "../shared/domain.ts";
import { normalizeProduct } from "../worker/products.ts";
import { dateInTimezone, nextFutureCycle } from "../shared/automatic.ts";
import { canMove, plannerRange, shiftAnchor } from "../shared/planner.ts";
test("planner navigation stays on calendar dates across month and year boundaries", () => {
  assert.deepEqual(plannerRange("2026-11-06", "week"), {
    start: "2026-11-02",
    end: "2026-11-16",
  });
  assert.deepEqual(plannerRange("2028-02-29", "month"), {
    start: "2028-02-01",
    end: "2028-03-01",
  });
  assert.equal(shiftAnchor("2026-12-31", "month", 1), "2027-01-01");
});
test("only own persisted unpaid planned contributions are movable", () => {
  const e = {
    id: "event",
    user_id: "alice",
    name: "Alice",
    date: "2026-11-09",
    amount_cents: 2500,
    version: 1,
    capture_id: null,
  };
  assert.equal(canMove(e, "alice"), true);
  assert.equal(canMove(e, "bob"), false);
  for (const state of ["received", "pending", "refunded", "optional"] as const)
    assert.equal(canMove({ ...e, state }, "alice"), false);
  assert.equal(canMove({ ...e, capture_id: "paid" }, "alice"), false);
  assert.equal(canMove({ ...e, editable: false }, "alice"), false);
});
test("automatic dates follow goal timezone and skip missed periods without monthly drift", () => {
  assert.equal(
    dateInTimezone("Asia/Kolkata", new Date("2026-11-02T20:00:00Z")),
    "2026-11-03",
  );
  assert.equal(
    dateInTimezone("America/Los_Angeles", new Date("2026-11-03T02:00:00Z")),
    "2026-11-02",
  );
  assert.deepEqual(nextFutureCycle("2027-01-31", 0, "monthly", "2027-03-02"), {
    index: 2,
    date: "2027-03-31",
  });
  assert.deepEqual(nextFutureCycle("2026-10-01", 0, "weekly", "2026-11-03"), {
    index: 5,
    date: "2026-11-05",
  });
});
test("monthly recurrence clamps without drifting after February", () => {
  assert.equal(nextDate("2028-01-31", 1, "monthly"), "2028-02-29");
  assert.equal(nextDate("2028-01-31", 2, "monthly"), "2028-03-31");
  assert.equal(nextDate("2027-01-31", 1, "monthly"), "2027-02-28");
});
test("rejects impossible dates and invalid frequencies", () => {
  assert.equal(validDate("2026-02-30"), false);
  assert.throws(() => forecast(1000, 100, "2026-02-30", "weekly"));
  assert.throws(() => forecast(1000, 100, "2026-11-01", "daily" as never));
});
test("final contribution uses exact integer remainder", () => {
  const p = forecast(10001, 3000, "2026-11-01", "weekly");
  assert.equal(p.count, 4);
  assert.deepEqual(
    p.events.map((e) => e.amountCents),
    [3000, 3000, 3000, 1001],
  );
  assert.equal(p.readyDate, "2026-11-22");
});
test("zero remainder is funded without an invented date", () =>
  assert.deepEqual(forecast(0, 100, "2026-11-01", "weekly"), {
    count: 0,
    readyDate: null,
    events: [],
  }));
test("equal shares sum exactly to target", () =>
  assert.deepEqual(
    [0, 1, 2].map((i) => equalShare(10000, 3, i)),
    [3334, 3333, 3333],
  ));
test("rejects unsafe merchant URLs", () => {
  assert.equal(httpsUrl("javascript:alert(1)"), null);
  assert.equal(httpsUrl("https://user:pass@example.com"), null);
  assert.equal(httpsUrl("http://example.com"), null);
});
test("normalizes documented Channel3 prices and selects available USD offer", () => {
  const p = normalizeProduct({
    id: "x",
    title: "Sofa",
    offers: [
      {
        url: "https://shop.example/eur",
        domain: "shop.example",
        price: { price: 1, currency: "EUR" },
        availability: "InStock",
      },
      {
        url: "https://shop.example/usd",
        domain: "shop.example",
        price: { price: 249.99, currency: "USD" },
        availability: "InStock",
      },
    ],
  });
  assert.equal(p.priceCents, 24999);
  assert.equal(p.merchantUrl, "https://shop.example/usd");
});
test("does not fabricate prices for unavailable products", () => {
  const p = normalizeProduct({ id: "x", title: "Sofa", offers: [] });
  assert.equal(p.available, false);
  assert.equal(p.priceCents, null);
});
