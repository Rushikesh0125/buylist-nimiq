// Local visual/interaction fixture only. Not an application build entry.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import ContributionPlanner from "../src/ContributionPlanner";
import { ApiError, type EventRow } from "../src/api";
import type { DatePreview } from "../src/SchedulerView";
import "../src/prototype.css";
import "../src/website.css";
import "../src/plan-detail.css";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/bricolage-grotesque/800.css";
if (!import.meta.env.DEV) throw Error("Local fixture only");
const rows: EventRow[] = [
  {
    id: "you-paid",
    user_id: "you",
    name: "You",
    date: "2026-11-03",
    amount_cents: 2500,
    capture_id: "capture-a",
    version: 1,
    state: "received",
  },
  {
    id: "maya-paid",
    user_id: "maya",
    name: "Maya",
    date: "2026-11-04",
    amount_cents: 5000,
    capture_id: "capture-b",
    version: 1,
    state: "received",
  },
  {
    id: "dev-paid",
    user_id: "dev",
    name: "Dev",
    date: "2026-11-05",
    amount_cents: 3000,
    capture_id: "capture-c",
    version: 1,
    state: "received",
  },
  {
    id: "you-planned",
    user_id: "you",
    name: "You",
    date: "2026-11-09",
    amount_cents: 2500,
    capture_id: null,
    version: 1,
    state: "planned",
  },
  {
    id: "maya-planned",
    user_id: "maya",
    name: "Maya",
    date: "2026-11-10",
    amount_cents: 5000,
    capture_id: null,
    version: 1,
    state: "planned",
  },
  {
    id: "dev-planned",
    user_id: "dev",
    name: "Dev",
    date: "2026-11-12",
    amount_cents: 3000,
    capture_id: null,
    version: 1,
    state: "planned",
  },
  {
    id: "you-next",
    user_id: "you",
    name: "You",
    date: "2026-11-13",
    amount_cents: 2500,
    capture_id: null,
    version: 1,
    state: "planned",
  },
];
const query = new URLSearchParams(location.search);
function Fixture() {
  const [events, setEvents] = useState(query.has("empty") ? [] : rows),
    [preview, setPreview] = useState<DatePreview | null>(
      query.has("preview") ? { event: rows[3], date: "2026-11-11" } : null,
    );
  return (
    <main className="authenticated-workspace planner-fixture">
      <div className="plan-detail">
        <ContributionPlanner
          events={events}
          members={[
            { id: "you", name: "You", role: "owner", shareCents: null },
            { id: "maya", name: "Maya", role: "member", shareCents: null },
            { id: "dev", name: "Dev", role: "member", shareCents: null },
          ]}
          userId="you"
          timezone="Asia/Kolkata"
          mode="fixed"
          timelineEnabled={!query.has("disabled")}
          preview={preview}
          onPreview={(event, date) =>
            setPreview(event.date === date ? null : { event, date })
          }
          onDiscard={() => setPreview(null)}
          onSave={async () => {
            if (query.has("fail"))
              throw new ApiError(
                "EVENT_CONFLICT",
                "This event changed. Reload the schedule.",
                409,
              );
            if (preview)
              setEvents(
                events.map((e) =>
                  e.id === preview.event.id
                    ? { ...e, date: preview.date, version: e.version + 1 }
                    : e,
                ),
              );
            setPreview(null);
          }}
          onReload={async () => {
            setEvents(rows);
            setPreview(null);
          }}
        />
      </div>
    </main>
  );
}
const style = document.createElement("style");
style.textContent =
  ".planner-fixture.authenticated-workspace{padding:28px!important;max-width:none!important;margin:0!important}.planner-fixture .plan-detail{max-width:none}.planner-fixture .contribution-planner{margin:0}";
document.head.append(style);
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
import.meta.hot?.dispose(() => {
  root.unmount();
  style.remove();
});
