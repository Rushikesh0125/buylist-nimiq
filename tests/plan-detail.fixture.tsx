// Isolated local QA data. Never an application build entry or a live API request.
import React from "react";
import { createRoot } from "react-dom/client";
import Website from "../src/Website";
import "../src/prototype.css";
import "../src/website.css";
import "../src/plan-detail.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/bricolage-grotesque/800.css";
if (!import.meta.env.DEV) throw Error("Local fixtures only");
const mode = new URLSearchParams(location.search).get("mode") || "solo";
const plannerEnabled = new URLSearchParams(location.search).has("planner");
let plannerEvents = plannerEnabled
  ? [
      {
        id: "fixture-event",
        user_id: "fixture-user",
        name: "You",
        date: "2026-11-09",
        amount_cents: 2500,
        capture_id: null,
        version: 1,
        state: "planned",
      },
      {
        id: "fixture-event-other",
        user_id: "fixture-member",
        name: "Alex",
        date: "2026-11-10",
        amount_cents: 5000,
        capture_id: null,
        version: 1,
        state: "planned",
      },
    ]
  : [];
const product = {
  id: "fixture-tv",
  title: "55-inch OLED Smart TV",
  imageUrl: "/assets/tv.svg",
  merchant: "Example merchant",
};
const goal = {
  id: "fixture-goal",
  name: "Movie nights, upgraded.",
  target_cents: 49900,
  saved_cents: 12500,
  mode,
  timezone: "Asia/Kolkata",
  version: 1,
  purchased: 0,
  role: "owner",
  product_json: JSON.stringify(product),
};
const members = [
  {
    id: "fixture-user",
    name: "You",
    role: "owner",
    shareCents: mode === "fixed" ? 24950 : null,
  },
  ...(mode === "solo"
    ? []
    : [
        {
          id: "fixture-member",
          name: "Alex",
          role: "member",
          shareCents: mode === "fixed" ? 24950 : null,
        },
      ]),
];
let fixtureSignedIn = true;
let automaticPlan: any =
  new URLSearchParams(location.search).get("automatic") === "active"
    ? {
        id: "fixture-auto",
        amountCents: 2500,
        frequency: "weekly",
        startDate: "2026-11-09",
        nextDate: "2026-11-09",
        timezone: "Asia/Kolkata",
        state: "active",
        reason: null,
        targetCents: 49900,
        limitCents: 49900,
      }
    : null;
let refundable = 12500;
let commitment: any =
  mode !== "flexible" &&
  new URLSearchParams(location.search).get("saved") === "1"
    ? {
        version: 1,
        amount_cents: 2500,
        frequency: "weekly",
        start_date: "2026-11-02",
      }
    : null;
let personalPlan: any =
  mode === "flexible" &&
  new URLSearchParams(location.search).get("saved") === "1"
    ? {
        version: 1,
        amount_cents: 2500,
        frequency: "weekly",
        start_date: "2026-11-02",
      }
    : null;
window.fetch = async (input, options) => {
  const path = String(input);
  if (path === "/api/config")
    return Response.json({
      nimiqEnabled: true,
      bryntumEnabled: plannerEnabled,
    });
  if (path === "/api/auth/session")
    return Response.json({
      user: fixtureSignedIn
        ? {
            id: "fixture-user",
            name: "Local QA",
            email: "fixture@example.test",
          }
        : null,
      csrfToken: "fixture-only",
    });
  if (path === "/api/auth/logout") {
    fixtureSignedIn = false;
    return Response.json({ ok: true });
  }
  if (path === "/api/goals") return Response.json({ goals: [goal] });
  if (path === "/api/payments/activity")
    return Response.json({
      payments:
        new URLSearchParams(location.search).get("payments") === "1"
          ? [
              {
                id: "fixture-payment",
                goal_id: goal.id,
                amount_cents: 12500,
                status: refundable === 12500 ? "completed" : "reversed",
                refundable_cents: refundable,
                refund_pending_cents: 0,
              },
            ]
          : [],
    });
  if (path === "/api/payments/fixture-payment/refunds") {
    const body = JSON.parse(String(options?.body));
    refundable -= body.amountCents;
    goal.saved_cents -= body.amountCents;
    return Response.json({ status: "completed" });
  }
  if (path === "/api/goals/fixture-goal/automatic")
    return Response.json({ plan: automaticPlan });
  if (
    path.match(/^\/api\/goals\/fixture-goal\/automatic\/(pause|resume|cancel)$/)
  ) {
    automaticPlan = {
      ...automaticPlan,
      state: path.endsWith("/pause")
        ? "paused"
        : path.endsWith("/cancel")
          ? "cancelled"
          : "active",
    };
    return Response.json({ plan: automaticPlan });
  }
  if (path === "/api/payments/config")
    return Response.json({
      clientId: "fixture-only-not-a-provider-key",
      enabled: true,
    });
  if (path === "/api/goals/fixture-goal")
    return Response.json({
      goal,
      members,
      commitments: [],
      ledger: [
        {
          user_id: "fixture-user",
          amount_cents: 12500,
          kind: "capture",
          created_at: 1793606400,
        },
      ],
    });
  if (
    path === "/api/goals/fixture-goal/schedule" &&
    options?.method === "PUT"
  ) {
    if (new URLSearchParams(location.search).get("fail") === "1")
      return Response.json(
        { error: { code: "FIXTURE_FAILURE", message: "Schedule save failed" } },
        { status: 503 },
      );
    const body = JSON.parse(String(options.body));
    commitment = {
      version: 1,
      amount_cents: body.amountCents,
      frequency: body.frequency,
      start_date: body.startDate,
    };
    return Response.json({ ok: true });
  }
  if (path === "/api/goals/fixture-goal/schedule/events/fixture-event") {
    const body = JSON.parse(String(options?.body));
    plannerEvents = plannerEvents.map((e) =>
      e.id === "fixture-event"
        ? { ...e, date: body.date, version: e.version + 1 }
        : e,
    );
    return Response.json({ ok: true });
  }
  if (path === "/api/goals/fixture-goal/schedule")
    return Response.json({ mode, commitment, events: plannerEvents });
  if (
    path === "/api/goals/fixture-goal/personal-plan" &&
    options?.method === "PUT"
  ) {
    const body = JSON.parse(String(options.body));
    personalPlan = {
      version: (personalPlan?.version || 0) + 1,
      amount_cents: body.amountCents,
      frequency: body.frequency,
      start_date: body.startDate,
    };
    return Response.json({ ok: true, version: personalPlan.version });
  }
  if (path === "/api/goals/fixture-goal/personal-plan")
    return Response.json({ plan: personalPlan });
  if (path === "/api/goals/fixture-goal/forecast")
    return Response.json({ readyDate: "2027-02-08", count: 15, events: [] });
  throw Error("Unexpected local fixture request: " + path);
};
location.hash = "workspace";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Website />
  </React.StrictMode>,
);
