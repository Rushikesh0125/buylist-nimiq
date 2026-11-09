import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  Check,
  Clock,
  LockSimple,
  X,
} from "@phosphor-icons/react";
import { ApiError, usd, type EventRow, type Member } from "./api";
import {
  addDays,
  calendarDate,
  canMove,
  eventState,
  plannerRange,
  shiftAnchor,
  stateLabel,
} from "../shared/planner";
import { dateInTimezone } from "../shared/automatic";
import type { DatePreview } from "./SchedulerView";
import "./contribution-planner.css";
const SchedulerView = lazy(() => import("./SchedulerView"));
class TimelineBoundary extends Component<
  { children: ReactNode; onFallback: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="planner-empty">
        <p>The timeline could not load.</p>
        <button className="secondary" onClick={this.props.onFallback}>
          Open agenda
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function shortDate(date: string) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(calendarDate(date));
}
function StateIcon({ state }: { state: ReturnType<typeof eventState> }) {
  return state === "received" ? (
    <Check size={17} />
  ) : state === "pending" ? (
    <Clock size={17} />
  ) : (
    <CalendarBlank size={17} />
  );
}
export default function ContributionPlanner({
  events,
  members,
  userId,
  timezone,
  mode,
  timelineEnabled,
  preview,
  onPreview,
  onDiscard,
  onSave,
  onReload,
}: {
  events: EventRow[];
  members: Member[];
  userId: string;
  timezone: string;
  mode: "solo" | "fixed" | "flexible";
  timelineEnabled: boolean;
  preview: DatePreview | null;
  onPreview: (event: EventRow, date: string) => void;
  onDiscard: () => void;
  onSave: () => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const today = dateInTimezone(timezone);
  const [anchor, setAnchor] = useState(today),
    [period, setPeriod] = useState<"week" | "month">("week"),
    [display, setDisplay] = useState<"timeline" | "agenda">(() =>
      timelineEnabled && !window.matchMedia("(max-width: 700px)").matches
        ? "timeline"
        : "agenda",
    );
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [draft, setDraft] = useState(""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false),
    [success, setSuccess] = useState(""),
    [visibleCount, setVisibleCount] = useState(12);
  const range = useMemo(() => plannerRange(anchor, period), [anchor, period]);
  const selected = events.find((e) => e.id === selectedId) || null;
  const ranged = useMemo(
    () => events.filter((e) => e.date >= range.start && e.date < range.end),
    [events, range],
  );
  useEffect(() => {
    setDraft(selected?.date || "");
    setError("");
    setConflict(false);
  }, [selected?.id, selected?.date]);
  useEffect(() => {
    setVisibleCount(12);
  }, [range.start, range.end]);
  const choose = (id: string) => {
    setSelectedId(id);
    setSuccess("");
  };
  const propose = (event: EventRow, date: string) => {
    choose(event.id);
    setDraft(date);
    onPreview(event, date);
    setError("");
    setConflict(false);
  };
  const navigate = (direction: number) => {
    setAnchor(shiftAnchor(anchor, period, direction));
    setSelectedId(null);
  };
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave();
      setSuccess("Contribution date saved.");
      setSelectedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The date could not be saved.");
      setConflict(e instanceof ApiError && e.status === 409);
    } finally {
      setSaving(false);
    }
  };
  const jump = () => {
    const next = events.find(
      (e) => e.user_id === userId && e.date >= today && canMove(e, userId),
    );
    if (next) {
      setAnchor(next.date);
      choose(next.id);
    } else {
      setAnchor(today);
      setSelectedId(null);
      setSuccess("No upcoming editable contributions.");
    }
  };
  return (
    <section className="contribution-planner" aria-label="Contribution planner">
      <div className="planner-heading">
        <div>
          <span className="planner-context">
            {mode === "solo"
              ? "YOUR CONTRIBUTIONS"
              : mode === "fixed"
                ? "TOGETHER · FIXED GROUP"
                : "TOGETHER · FLEXIBLE GROUP"}
          </span>
          <h2>
            {mode === "solo"
              ? "A little closer, every time."
              : "A little closer, together."}
          </h2>
        </div>
        <div className="planner-navigation">
          <div className="planner-date-controls">
            <button
              aria-label="Previous date range"
              onClick={() => navigate(-1)}
            >
              <ArrowLeft size={19} />
            </button>
            <button
              onClick={() => {
                setAnchor(today);
                setSelectedId(null);
              }}
            >
              Today
            </button>
            <button aria-label="Next date range" onClick={() => navigate(1)}>
              <ArrowRight size={19} />
            </button>
          </div>
          <div className="planner-toggle" aria-label="Calendar range">
            <button
              aria-pressed={period === "week"}
              onClick={() => setPeriod("week")}
            >
              2 weeks
            </button>
            <button
              aria-pressed={period === "month"}
              onClick={() => setPeriod("month")}
            >
              Month
            </button>
          </div>
        </div>
      </div>
      <div className="planner-subheading">
        <div>
          <strong>
            {shortDate(range.start)} – {shortDate(addDays(range.end, -1))}
          </strong>
          <span>{timezone}</span>
        </div>
        <div className="planner-toggle" aria-label="Planner presentation">
          <button
            disabled={!timelineEnabled}
            aria-pressed={display === "timeline"}
            onClick={() => setDisplay("timeline")}
          >
            Timeline
          </button>
          <button
            aria-pressed={display === "agenda"}
            onClick={() => setDisplay("agenda")}
          >
            Agenda
          </button>
        </div>
      </div>
      {mode === "flexible" && (
        <p className="planner-help">
          Optional plans show possibilities, not commitments or a promised
          completion date.
        </p>
      )}
      {display === "timeline" && timelineEnabled ? (
        <TimelineBoundary onFallback={() => setDisplay("agenda")}>
          <Suspense
            fallback={
              <p className="planner-empty" role="status">
                Loading your timeline…
              </p>
            }
          >
            <SchedulerView
              events={events}
              members={members}
              userId={userId}
              today={today}
              start={range.start}
              end={range.end}
              view={period}
              selectedId={selectedId}
              preview={preview}
              onSelect={choose}
              onPreview={propose}
            />
          </Suspense>
        </TimelineBoundary>
      ) : (
        <div className="planner-agenda">
          {ranged.length ? (
            ranged.slice(0, visibleCount).map((e) => (
              <button
                key={e.id}
                className={
                  "planner-agenda-row " +
                  (selectedId === e.id ? "is-selected" : "")
                }
                aria-pressed={selectedId === e.id}
                onClick={() => choose(e.id)}
              >
                <span className="planner-agenda-date">
                  <strong>{calendarDate(e.date).getDate()}</strong>
                  <small>
                    {new Intl.DateTimeFormat("en-US", {
                      month: "short",
                    }).format(calendarDate(e.date))}
                  </small>
                </span>
                <span className="planner-agenda-person">
                  {e.user_id === userId ? "You" : e.name}
                  <small>
                    <StateIcon state={eventState(e)} />
                    {stateLabel[eventState(e)]}
                  </small>
                </span>
                <strong>{usd(e.amount_cents)}</strong>
                {!canMove(e, userId) && (
                  <LockSimple size={16} aria-label="Read only" />
                )}
              </button>
            ))
          ) : (
            <div className="planner-empty">
              <CalendarBlank size={28} />
              <h3>No contributions in this window.</h3>
              <p>
                {events.length
                  ? "Try another date range or jump to your next contribution."
                  : "Save a contribution plan to start shaping your timeline."}
              </p>
            </div>
          )}
          {ranged.length > visibleCount && (
            <button
              className="text-action"
              onClick={() => setVisibleCount((n) => n + 12)}
            >
              Show more contributions
            </button>
          )}
        </div>
      )}
      {!preview && selected && (
        <div className="planner-selection">
          <div>
            <span className="planner-selection-date">
              {shortDate(selected.date)}
            </span>
            <strong>
              {selected.user_id === userId ? "Your" : selected.name + "’s"}{" "}
              {usd(selected.amount_cents)} contribution
            </strong>
            <span>
              <StateIcon state={eventState(selected)} />
              {stateLabel[eventState(selected)]}
              {eventState(selected) === "optional"
                ? " · change this through your personal plan"
                : ""}
            </span>
          </div>
          {canMove(selected, userId) ? (
            <div className="planner-date-editor">
              <label>
                New contribution date
                <input
                  type="date"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onInput={(e) => setDraft(e.currentTarget.value)}
                />
              </label>
              <button
                className="primary"
                disabled={!draft || draft === selected.date}
                onClick={() => propose(selected, draft)}
              >
                Preview date
              </button>
            </div>
          ) : (
            <p>
              <LockSimple size={18} />
              {selected.user_id !== userId
                ? "Only this member can edit their planned contributions."
                : "This contribution is read-only."}
            </p>
          )}
          <button
            className="planner-close"
            aria-label="Close contribution details"
            onClick={() => setSelectedId(null)}
          >
            <X size={18} />
          </button>
        </div>
      )}
      {preview && (
        <div
          className="planner-preview"
          role="region"
          aria-label="Preview date change"
        >
          <CalendarBlank size={31} />
          <div>
            <h3>
              Move your {usd(preview.event.amount_cents).replace(/\.00$/, "")}{" "}
              contribution
            </h3>
            <p>
              {shortDate(preview.event.date)} <ArrowRight size={17} />{" "}
              {shortDate(preview.date)}
            </p>
          </div>
          <div className="planner-preview-actions">
            <button
              className="secondary"
              disabled={saving}
              onClick={() => {
                onDiscard();
                setDraft(preview.event.date);
                setError("");
                setConflict(false);
              }}
            >
              Discard
            </button>
            <button
              className="primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save date"}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="planner-error" role="alert">
          <p>{error}</p>
          {conflict && (
            <button
              className="secondary"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void onReload()
                  .then(() => {
                    setError("");
                    setConflict(false);
                    setSelectedId(null);
                  })
                  .catch((e) => setError(e.message))
                  .finally(() => setSaving(false));
              }}
            >
              Reload schedule
            </button>
          )}
        </div>
      )}
      {success && (
        <p className="planner-success" role="status">
          <Check size={17} />
          {success}
        </p>
      )}
      <div className="planner-footer">
        <p>
          <LockSimple size={16} />
          Planning only. Editing a date does not send funds.
        </p>
        <div className="planner-legend">
          <span className="legend-received">
            <Check size={16} />
            Received
          </span>
          <span>
            <CalendarBlank size={16} />
            Planned
          </span>
          <span>
            <Clock size={16} />
            Pending
          </span>
        </div>
      </div>
      <button className="planner-jump text-action" onClick={jump}>
        Jump to my next contribution <ArrowRight size={17} />
      </button>
    </section>
  );
}
