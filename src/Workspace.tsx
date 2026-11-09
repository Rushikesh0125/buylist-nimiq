import { useCallback, useEffect, useState } from "react";
import {
  api,
  loadSession,
  usd,
  inputCents,
  type Config,
  type Detail,
  type EventRow,
  type Goal,
  type Product,
  type Schedule,
  type PersonalPlan,
  type User,
} from "./api";
import ProductSearch from "./ProductSearch";
import AccountMenu from "./AccountMenu";
import NimiqContributions from "./NimiqContributions";
import PersonalSavings from "./PersonalSavings";
import { vaultDeployment } from "./savingsVault";
import NimiqSignIn from "./NimiqSignIn";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarBlank,
  ClockCounterClockwise,
  Users,
  CheckCircle,
  PencilSimple,
} from "@phosphor-icons/react";
import ContributionPlanner from "./ContributionPlanner";
import { canMove } from "../shared/planner";
export default function Workspace() {
  const [user, setUser] = useState<User | null>(null),
    [config, setConfig] = useState<Config | null>(null),
    [goals, setGoals] = useState<Goal[]>([]),
    [detail, setDetail] = useState<Detail | null>(null),
    [schedule, setSchedule] = useState<Schedule | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [view, setView] = useState("plans"),
    [detailTab, setDetailTab] = useState("schedule");
  const [editingSchedule, setEditingSchedule] = useState(false);
  const [personalPlan, setPersonalPlan] = useState<PersonalPlan | null>(null);
  const [product, setProduct] = useState<Product | null>(null),
    [name, setName] = useState(""),
    [target, setTarget] = useState(""),
    [mode, setMode] = useState<"solo" | "fixed" | "flexible">("solo");
  const [amount, setAmount] = useState("25"),
    [frequency, setFrequency] = useState("weekly"),
    [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10)),
    [preview, setPreview] = useState<{
      readyDate: string | null;
      count: number;
      events: { date: string; amountCents: number }[];
      explanation?: string;
    } | null>(null),
    [invite, setInvite] = useState(""),
    [editEvent, setEditEvent] = useState<{
      event: EventRow;
      date: string;
    } | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    const result = await api<{ goals: Goal[] }>("/api/goals");
    setGoals(result.goals);
  };
  const open = async (id: string) => {
    if (detail?.goal.id !== id) {
      setDetailTab("schedule");
      setInvite("");
    }
    const [d, s] = await Promise.all([
      api<Detail>("/api/goals/" + id),
      api<Schedule>("/api/goals/" + id + "/schedule"),
    ]);
    const personal =
      d.goal.mode === "flexible"
        ? (
            await api<{ plan: PersonalPlan | null }>(
              "/api/goals/" + id + "/personal-plan",
            )
          ).plan
        : null;
    setPersonalPlan(personal);
    setDetail(d);
    setSchedule(s);
    setEditingSchedule(false);
    setView("detail");
    setPreview(null);
    setEditEvent(null);
    const saved = personal || s.commitment;
    if (saved) {
      setAmount(String(saved.amount_cents / 100));
      setFrequency(saved.frequency);
      setStartDate(saved.start_date);
    }
  };
  useEffect(() => {
    void run(async () => {
      const c = await api<Config>("/api/config");
      setConfig(c);
      const u = await loadSession();
      setUser(u);
      if (u) {
        await refresh();
      }
    }).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!user || !detail?.goal.id) return;
    const gid = detail.goal.id;
    const timer = setInterval(() => {
      void Promise.all([
        api<Detail>("/api/goals/" + gid),
        api<Schedule>("/api/goals/" + gid + "/schedule"),
      ])
        .then(([d, s]) => {
          setDetail((current) => (current?.goal.id === gid ? d : current));
          // Keep the editor's accepted version snapshot while refreshing shared events.
          setSchedule((current) =>
            !current
              ? s
              : JSON.stringify(current.events) === JSON.stringify(s.events)
                ? current
                : { ...current, events: s.events },
          );
        })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [user, detail?.goal.id]);
  const onPreview = useCallback(
    (event: EventRow, date: string) =>
      setEditEvent(date === event.date ? null : { event, date }),
    [],
  );
  const pendingInvite = sessionStorage.getItem("buylist.pending-invite");
  const body = () => {
    if (loading) return <p role="status">Loading your plans…</p>;
    if (!user)
      return (
        <section className="account-empty">
          <span className="eyebrow">YOUR BUYLIST ACCOUNT</span>
          <h1>
            Your people.
            <br />
            Your next plan.
          </h1>
          <p>Sign in to see your plans or start a new one.</p>
          {config?.nimiqEnabled ? (
            <NimiqSignIn onSuccess={() => location.reload()} />
          ) : (
            <p>Sign-in is temporarily unavailable. Please try again later.</p>
          )}
        </section>
      );
    if (view === "create")
      return (
        <section className="account-editor">
          <button className="text-action" onClick={() => setView("plans")}>
            Back to plans
          </button>
          <span className="eyebrow">A WISHLIST WITH A PLAN</span>
          <h1>What’s next?</h1>
          <ProductSearch
            selected={product}
            onSelect={(p) => {
              setProduct(p);
              setTarget(String(p.priceCents! / 100));
            }}
          />
          <label>
            Goal name
            <input
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Target in USD
            <input
              inputMode="decimal"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
          <fieldset className="group-style">
            <legend>How will you save?</legend>
            <div className="choices">
              {(["solo", "fixed", "flexible"] as const).map((m) => (
                <button
                  key={m}
                  aria-pressed={mode === m}
                  onClick={() => setMode(m)}
                >
                  {m === "solo"
                    ? "Solo"
                    : m === "fixed"
                      ? "Group · Fixed"
                      : "Group · Flexible"}
                </button>
              ))}
            </div>
            <p>
              {mode === "fixed"
                ? "Members accept an equal share and their own contribution schedule."
                : mode === "flexible"
                  ? "No promises or due amounts. Everyone chips in when they choose."
                  : "A plan at your own pace."}
            </p>
          </fieldset>
          <button
            className="primary"
            disabled={busy || !name.trim() || !inputCents(target)}
            onClick={() =>
              void run(async () => {
                const result = await api<{ id: string }>("/api/goals", "POST", {
                  name,
                  targetCents: inputCents(target),
                  mode,
                  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                  ...(product ? { productId: product.id } : {}),
                });
                await refresh();
                await open(result.id);
              })
            }
          >
            Create plan
          </button>
        </section>
      );
    if (detail && view === "detail") {
      const g = detail.goal;
      const remaining = Math.max(0, g.target_cents - g.saved_cents);
      const percent = Math.min(
        100,
        Math.max(0, Math.floor((g.saved_cents / g.target_cents) * 100)),
      );
      const p = g.product_json ? (JSON.parse(g.product_json) as Product) : null;
      const savedPlan =
        g.mode === "flexible" ? personalPlan : schedule?.commitment;
      const showScheduleEditor = !savedPlan || editingSchedule;
      const restoreSchedule = () => {
        if (savedPlan) {
          setAmount(String(savedPlan.amount_cents / 100));
          setFrequency(savedPlan.frequency);
          setStartDate(savedPlan.start_date);
        }
        setPreview(null);
      };
      return (
        <section
          className={
            "account-detail plan-detail " +
            (g.mode === "solo" ? "solo-detail" : "group-detail")
          }
        >
          <button
            className="detail-back"
            onClick={() => {
              setView("plans");
              setDetail(null);
              void run(refresh);
            }}
          >
            <ArrowLeft size={16} />
            All plans
          </button>
          <header className="detail-heading">
            <span className="detail-mode">
              {g.mode === "solo"
                ? "SOLO PLAN"
                : "GROUP · " + g.mode.toUpperCase()}
            </span>
            <h1>{g.name}</h1>
            {p && <p>{p.title}</p>}
          </header>
          <div className="detail-layout">
            <div className="detail-main">
              <section className="detail-progress" aria-label="Goal progress">
                <div className="detail-progress-top">
                  <div className="detail-progress-copy">
                    <span>RECEIVED SO FAR</span>
                    <strong data-long-amount={usd(g.saved_cents).length > 9}>
                      {usd(g.saved_cents)}
                    </strong>
                    <p>of {usd(g.target_cents)} target</p>
                  </div>
                  {p?.imageUrl && (
                    <div className="detail-image">
                      <img src={p.imageUrl} alt={p.title} />
                    </div>
                  )}
                </div>
                <div className="detail-progress-label">
                  <span>
                    {remaining ? usd(remaining) + " to go" : "Target reached"}
                  </span>
                  <strong>{percent}%</strong>
                </div>
                <progress
                  value={Math.max(0, g.saved_cents)}
                  max={g.target_cents}
                  aria-label="Goal funded"
                />
                <div className="detail-progress-footer">
                  <span>
                    {g.mode === "solo"
                      ? "At your own pace"
                      : detail.members.length + " people, one goal"}
                  </span>
                  <span>
                    {g.mode === "flexible"
                      ? "Contribute when you choose"
                      : "One step closer"}
                    <ArrowUpRight size={16} />
                  </span>
                </div>
              </section>
              <aside
                className="detail-contribute"
                aria-label="NIM savings and retailer offer"
              >
                {p && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const fresh = (
                          await api<{ product: Product }>(
                            "/api/products/" + encodeURIComponent(p.id),
                          )
                        ).product;
                        setProduct(fresh);
                        if (!fresh.available || fresh.currency !== "USD")
                          throw new Error(
                            "There is no currently available USD offer.",
                          );
                        setView("merchant");
                      })
                    }
                  >
                    Check current merchant offer
                  </button>
                )}
                <PersonalSavings
                  key={"vault:" + g.id}
                  goalId={g.id}
                  closed={!!g.purchased}
                />
                <NimiqContributions
                  key={g.id}
                  goalId={g.id}
                  owner={g.role === "owner"}
                  closed={!!g.purchased}
                  legacyOnly={!!vaultDeployment}
                />
              </aside>
              <nav className="detail-tabs" aria-label="Plan sections">
                <button
                  aria-pressed={detailTab === "schedule"}
                  onClick={() => setDetailTab("schedule")}
                >
                  <CalendarBlank size={18} />
                  {g.mode === "flexible" ? "Your plan" : "Schedule"}
                </button>
                <button
                  aria-pressed={detailTab === "activity"}
                  onClick={() => setDetailTab("activity")}
                >
                  <ClockCounterClockwise size={18} />
                  Activity
                </button>
                {g.mode !== "solo" && (
                  <button
                    aria-pressed={detailTab === "people"}
                    onClick={() => setDetailTab("people")}
                  >
                    <Users size={18} />
                    People <span>{detail.members.length}</span>
                  </button>
                )}
              </nav>
              {detailTab === "schedule" && (
                <>
                  <section
                    className="account-schedule detail-panel"
                    aria-label="Contribution schedule"
                  >
                    <h2>
                      {g.mode === "flexible"
                        ? "Your contribution plan"
                        : "Your contribution schedule"}
                    </h2>
                    {savedPlan && !editingSchedule && (
                      <div className="saved-schedule-summary">
                        <div>
                          <span>
                            <CheckCircle size={17} />
                            {g.mode === "flexible"
                              ? "Optional plan saved"
                              : "Schedule saved"}
                          </span>
                          <strong>
                            {usd(savedPlan.amount_cents)}{" "}
                            <small>{savedPlan.frequency}</small>
                          </strong>
                          <p>
                            Starts{" "}
                            {new Date(
                              savedPlan.start_date + "T12:00:00",
                            ).toLocaleDateString(undefined, {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </p>
                        </div>
                        <button
                          className="secondary"
                          aria-label="Edit schedule"
                          onClick={() => {
                            restoreSchedule();
                            setEditingSchedule(true);
                          }}
                        >
                          <PencilSimple size={15} />
                          Edit
                        </button>
                      </div>
                    )}
                    {showScheduleEditor && (
                      <div className="schedule-editor">
                        <p>
                          {g.mode === "flexible"
                            ? "Your personal plan is optional. Contributions remain voluntary."
                            : "Plan your next steps. Scheduled contributions are separate from received funds."}
                        </p>
                        {g.mode === "fixed" && (
                          <p className="detail-fixed-note">
                            Your share:{" "}
                            {usd(
                              detail.members.find((m) => m.id === user.id)
                                ?.shareCents || 0,
                            )}
                            . Everyone must join before schedules are accepted.
                          </p>
                        )}
                        <div className="schedule-inputs">
                          <label>
                            Amount per contribution
                            <input
                              inputMode="decimal"
                              value={amount}
                              onChange={(e) => setAmount(e.target.value)}
                            />
                          </label>
                          <label>
                            Frequency
                            <select
                              value={frequency}
                              onChange={(e) => setFrequency(e.target.value)}
                            >
                              <option value="weekly">Weekly</option>
                              <option value="fortnightly">Fortnightly</option>
                              <option value="monthly">Monthly</option>
                            </select>
                          </label>
                          <label>
                            Start date
                            <input
                              type="date"
                              value={startDate}
                              onChange={(e) => setStartDate(e.target.value)}
                            />
                          </label>
                        </div>
                        <div className="account-actions">
                          <button
                            className="secondary"
                            disabled={busy || !inputCents(amount)}
                            onClick={() =>
                              void run(async () =>
                                setPreview(
                                  await api(
                                    "/api/goals/" + g.id + "/forecast",
                                    "POST",
                                    {
                                      amountCents: inputCents(amount),
                                      frequency,
                                      startDate,
                                    },
                                  ),
                                ),
                              )
                            }
                          >
                            {g.mode === "flexible"
                              ? "Preview what-if"
                              : "Preview schedule"}
                          </button>
                          <button
                            className="secondary"
                            disabled={busy || !inputCents(amount)}
                            onClick={() =>
                              void run(async () =>
                                setPreview(
                                  await api("/api/assistant/plan", "POST", {
                                    goalId: g.id,
                                    budgetCents: inputCents(amount),
                                    frequency,
                                    startDate,
                                  }),
                                ),
                              )
                            }
                          >
                            Suggest a plan
                          </button>
                        </div>
                        {preview && (
                          <div className="summary-block">
                            <strong>
                              {preview.readyDate || "Already funded"}
                            </strong>
                            <p>
                              {preview.count} contributions · estimated
                              scenario, not guaranteed.
                            </p>
                            {preview.explanation && (
                              <p>{preview.explanation}</p>
                            )}
                          </div>
                        )}
                        <button
                          className="primary"
                          disabled={busy || !inputCents(amount)}
                          onClick={() =>
                            void run(async () => {
                              await api(
                                "/api/goals/" +
                                  g.id +
                                  (g.mode === "flexible"
                                    ? "/personal-plan"
                                    : "/schedule"),
                                "PUT",
                                {
                                  version: savedPlan?.version || 0,
                                  amountCents: inputCents(amount),
                                  frequency,
                                  startDate,
                                },
                              );
                              await open(g.id);
                            })
                          }
                        >
                          {g.mode === "fixed"
                            ? "Accept my schedule"
                            : g.mode === "flexible"
                              ? "Save my plan"
                              : "Save my schedule"}
                        </button>
                        {editingSchedule && savedPlan && (
                          <button
                            className="text-action cancel-schedule-edit"
                            disabled={busy}
                            onClick={() => {
                              restoreSchedule();
                              setEditingSchedule(false);
                            }}
                          >
                            Cancel changes
                          </button>
                        )}
                      </div>
                    )}
                  </section>
                  {schedule && (
                    <ContributionPlanner
                      events={schedule.events}
                      members={detail.members}
                      userId={user.id}
                      timezone={g.timezone}
                      mode={g.mode}
                      timelineEnabled={!!config?.bryntumEnabled}
                      preview={editEvent}
                      onPreview={onPreview}
                      onDiscard={() => setEditEvent(null)}
                      onSave={async () => {
                        if (!editEvent || !canMove(editEvent.event, user.id))
                          throw new Error(
                            "This contribution can no longer be moved. Reload the schedule.",
                          );
                        await api(
                          "/api/goals/" +
                            g.id +
                            "/schedule/events/" +
                            editEvent.event.id,
                          "PATCH",
                          {
                            version: editEvent.event.version,
                            date: editEvent.date,
                          },
                        );
                        await open(g.id);
                        await refresh();
                      }}
                      onReload={async () => {
                        await open(g.id);
                        await refresh();
                      }}
                    />
                  )}
                </>
              )}
              {detailTab === "people" && g.mode !== "solo" && (
                <section
                  className="detail-panel detail-people"
                  aria-label="Group members"
                >
                  <h2>Your people</h2>
                  {detail.members.map((m) => (
                    <div className="person-row" key={m.id}>
                      <strong>{m.name}</strong>
                      <small>
                        {m.role}
                        {m.shareCents !== null
                          ? " · share " + usd(m.shareCents)
                          : ""}
                      </small>
                    </div>
                  ))}
                  {g.role === "owner" && (
                    <>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const result = await api<{ url: string }>(
                              "/api/goals/" + g.id + "/invitations",
                              "POST",
                              {},
                            );
                            setInvite(result.url);
                          })
                        }
                      >
                        Create invitation link
                      </button>
                      {invite && (
                        <label>
                          Share this single-use link
                          <input readOnly value={invite} />
                          <button
                            onClick={() =>
                              void navigator.clipboard
                                .writeText(invite)
                                .catch(() =>
                                  setError("Copy the selected link manually."),
                                )
                            }
                          >
                            Copy link
                          </button>
                        </label>
                      )}
                      {invite && config?.nimiqEnabled && (
                        <label>
                          Nimiq Pay invitation
                          <input
                            readOnly
                            value={
                              "nimiqpay://miniapp?url=" +
                              encodeURIComponent(invite)
                            }
                            onFocus={(event) => event.currentTarget.select()}
                          />
                        </label>
                      )}
                    </>
                  )}
                </section>
              )}
              {detailTab === "activity" && (
                <section
                  className="detail-panel detail-activity"
                  aria-label="Contribution activity"
                >
                  <h2>Received activity</h2>
                  {detail.ledger.length ? (
                    detail.ledger.map((l, i) => (
                      <div className="person-row" key={i}>
                        <span>
                          {detail.members.find((m) => m.id === l.user_id)
                            ?.name || "Member"}{" "}
                          ·{" "}
                          {l.kind === "capture"
                            ? "contributed"
                            : l.kind === "refund"
                              ? "refunded"
                              : "reversed"}
                        </span>
                        <strong>{usd(l.amount_cents)}</strong>
                      </div>
                    ))
                  ) : (
                    <p>No confirmed contributions yet.</p>
                  )}
                </section>
              )}
            </div>
          </div>
        </section>
      );
    }
    if (view === "merchant" && product && detail)
      return (
        <section className="account-editor">
          <button className="text-action" onClick={() => setView("detail")}>
            Back to goal
          </button>
          <span className="eyebrow">EXTERNAL MERCHANT HANDOFF</span>
          <h1>{product.title}</h1>
          <p>
            Current price:{" "}
            {product.priceCents ? usd(product.priceCents) : "Unknown"} ·{" "}
            {product.merchant}
          </p>
          <p>
            Observed {new Date(product.observedAt * 1000).toLocaleString()}.
            Confirm shipping, taxes and returns at the merchant.
          </p>
          {product.priceCents !== detail.goal.target_cents && (
            <div>
              <p role="alert">
                The merchant price differs from your saved target. Review your
                budget before continuing.
              </p>
              {detail.goal.role === "owner" &&
                product.priceCents &&
                product.currency === "USD" && (
                  <>
                    <p>
                      A target update requires no accepted schedules or pending
                      payments. It cannot reduce funds already received.
                    </p>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await api("/api/goals/" + detail.goal.id, "PATCH", {
                            version: detail.goal.version,
                            targetCents: product.priceCents,
                          });
                          await refresh();
                          await open(detail.goal.id);
                        })
                      }
                    >
                      Confirm target update to {usd(product.priceCents)}
                    </button>
                  </>
                )}
            </div>
          )}
          <p>
            NIM contributions go to the goal organizer. Purchases are completed
            with the retailer.
          </p>
          {product.merchantUrl && (
            <a
              className="site-cta"
              href={product.merchantUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open merchant website
            </a>
          )}
        </section>
      );
    return (
      <section className="account-plans">
        <span className="eyebrow">WELCOME, {user.name.toUpperCase()}</span>
        <h1>
          Your good things,
          <br />
          <span className="lime-text">in motion.</span>
        </h1>
        <button
          className="site-cta"
          onClick={() => {
            setView("create");
            setName("");
            setTarget("");
            setProduct(null);
          }}
        >
          Start a new plan
        </button>
        {pendingInvite && (
          <div className="summary-block">
            <h2>You have a group invitation</h2>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await api<{ goalId: string }>(
                    "/api/invitations/" +
                      encodeURIComponent(pendingInvite) +
                      "/accept",
                    "POST",
                    {},
                  );
                  sessionStorage.removeItem("buylist.pending-invite");
                  await refresh();
                  await open(result.goalId);
                })
              }
            >
              Accept invitation
            </button>
          </div>
        )}
        <div className="account-goal-grid">
          {goals.map((g) => (
            <button
              key={g.id}
              className={
                "account-goal " + (g.mode === "solo" ? "lime" : "coral")
              }
              onClick={() => void run(() => open(g.id))}
            >
              <span className="pill">{g.mode.toUpperCase()}</span>
              <h2>{g.name}</h2>
              <strong>{usd(g.saved_cents)}</strong>
              <span>of {usd(g.target_cents)} received</span>
              <progress value={g.saved_cents} max={g.target_cents} />
            </button>
          ))}
        </div>
        {!goals.length && (
          <div className="empty">
            <h2>A fresh start.</h2>
            <p>Create a goal or accept an invitation to begin.</p>
          </div>
        )}
      </section>
    );
  };
  return (
    <main
      className={
        "authenticated-workspace" +
        (detail && view === "detail" ? " has-plan-detail" : "")
      }
      aria-busy={busy}
    >
      {user && (
        <AccountMenu
          user={user}
          busy={busy}
          onLogout={() =>
            void run(async () => {
              await api("/api/auth/logout", "POST", {});
              await loadSession();
              setUser(null);
              setGoals([]);
              setDetail(null);
              setSchedule(null);
              setPersonalPlan(null);
              setView("plans");
            })
          }
        />
      )}
      {error && (
        <div className="api-error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {busy && !loading && <p role="status">Working…</p>}
      {body()}
    </main>
  );
}
