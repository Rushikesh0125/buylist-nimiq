import { useEffect, useRef } from "react";
import {
  Scheduler,
  ColumnStore,
  Column,
  type Model,
} from "@bryntum/scheduler-trial";
import "@bryntum/scheduler-trial/scheduler.css";
import "@bryntum/scheduler-trial/fontawesome/css/fontawesome.css";
import "@bryntum/scheduler-trial/fontawesome/css/solid.css";
import "@bryntum/scheduler-trial/stockholm-dark.css";
import type { EventRow, Member } from "./api";
import { usd } from "./api";
import {
  addDays,
  calendarDate,
  canMove,
  dateValue,
  eventState,
  stateLabel,
} from "../shared/planner";

export type DatePreview = { event: EventRow; date: string };
export default function SchedulerView({
  events,
  members,
  userId,
  today,
  start,
  end,
  view,
  selectedId,
  preview,
  onSelect,
  onPreview,
}: {
  events: EventRow[];
  members: Member[];
  userId: string;
  today: string;
  start: string;
  end: string;
  view: "week" | "month";
  selectedId: string | null;
  preview: DatePreview | null;
  onSelect: (id: string) => void;
  onPreview: (event: EventRow, date: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    instance = useRef<Scheduler | null>(null);
  const current = useRef({ events, onSelect, onPreview, userId });
  current.current = { events, onSelect, onPreview, userId };
  useEffect(() => {
    if (!host.current) return;
    const scheduler = new Scheduler({
      appendTo: host.current,
      cls: "buylist-scheduler view-" + view,
      height: Math.min(
        650,
        Math.max(264, members.length * 124 + (view === "month" ? 148 : 112)),
      ),
      startDate: calendarDate(start),
      endDate: calendarDate(end),
      rowHeight: 124,
      barMargin: 41,
      eventStyle: "outlined",
      multiEventSelect: false,
      tickSize: view === "week" ? 78 : 52,
      viewPreset: {
        id: "buylist-" + view,
        base: "dayAndWeek",
        tickWidth: view === "week" ? 78 : 52,
        timeResolution: { unit: "day", increment: 1 },
        headers: [
          ...(view === "month"
            ? [{ unit: "week" as const, dateFormat: "MMM D" }]
            : []),
          {
            unit: "day",
            increment: 1,
            renderer: (date: Date) => {
              const value = dateValue(date),
                weekday = new Intl.DateTimeFormat("en-US", {
                  weekday: "short",
                }).format(date);
              return `<span class="planner-day ${value === today ? "is-today" : ""}"><span>${weekday}</span><strong>${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)}</strong>${value === today ? "<small>TODAY</small>" : ""}</span>`;
            },
          },
        ],
      },
      columns: [
        {
          id: "member",
          text: "Your people",
          field: "name",
          width: host.current.clientWidth < 700 ? 112 : 210,
          minWidth: 96,
          htmlEncode: false,
          sortable: false,
          renderer: ({ record }: { record: Model }) => ({
            className: "planner-member",
            children: [
              {
                tag: "span",
                className: "planner-avatar tone-" + record.get("tone"),
                text: String(record.get("name")).slice(0, 1).toUpperCase(),
              },
              {
                tag: "span",
                className: "planner-member-copy",
                children: [
                  { tag: "strong", text: record.get("name") },
                  { tag: "small", text: record.get("note") },
                ],
              },
            ],
          }),
        },
      ],
      features: {
        eventEdit: false,
        eventCopyPaste: false,
        eventTooltip: false,
        eventResize: false,
        eventDragCreate: false,
        eventMenu: false,
        scheduleMenu: false,
        headerMenu: false,
        cellEdit: false,
        eventDrag: { constrainDragToResource: true },
        timeAxisHeaderMenu: false,
        timeRanges: { showHeaderElements: false },
      },
      eventRenderer: ({ eventRecord, renderData }) => {
        const state = eventRecord.get(
          "paymentState",
        ) as keyof typeof stateLabel;
        renderData.ariaLabel = String(eventRecord.get("label"));
        return {
          className: "planner-pill-content",
          children: [
            {
              tag: "i",
              className:
                "b-icon " +
                (state === "received"
                  ? "b-icon-check"
                  : state === "pending"
                    ? "b-icon-clock"
                    : "b-icon-calendar"),
              "aria-hidden": "true",
            },
            { tag: "span", text: eventRecord.name },
            ...(eventRecord.get("movable")
              ? [
                  {
                    tag: "i",
                    className: "fa-solid fa-grip-vertical planner-grip",
                    "aria-hidden": "true",
                  },
                ]
              : []),
          ],
        };
      },
      listeners: {
        beforeEventDelete: () => false,
        eventClick: ({ eventRecord }) =>
          current.current.onSelect(
            String(eventRecord.id).replace(/^preview:/, ""),
          ),
        beforeEventDropFinalize: ({ context }) => {
          const row = current.current.events.find(
            (e) => e.id === String(context.eventRecords[0]?.id),
          );
          if (row && canMove(row, current.current.userId))
            current.current.onPreview(row, dateValue(context.startDate));
          context.async = true;
          context.finalize(false);
        },
      },
    });
    instance.current = scheduler;
    const resize = new ResizeObserver(() => {
      const column =
        scheduler.columns instanceof ColumnStore
          ? scheduler.columns.getById("member")
          : null;
      if (column instanceof Column && host.current)
        column.width = host.current.clientWidth < 700 ? 112 : 210;
    });
    resize.observe(host.current);
    return () => {
      resize.disconnect();
      instance.current = null;
      scheduler.destroy();
    };
  }, [start, end, view, today, members.length]);
  useEffect(() => {
    const s = instance.current;
    if (!s) return;
    s.resourceStore.data = members.map((m, i) => ({
      id: m.id,
      name: m.id === userId ? "You" : m.name,
      tone: i % 3,
      note: m.shareCents === null ? "" : usd(m.shareCents) + " share",
    }));
    const data = events.map((e) => {
      const state = eventState(e),
        tone = members.findIndex((m) => m.id === e.user_id) % 3;
      const ghost = preview?.event.id === e.id;
      return {
        id: e.id,
        resourceId: e.user_id,
        name: usd(e.amount_cents).replace(/\.00$/, ""),
        startDate: calendarDate(e.date),
        duration: 1,
        durationUnit: "day",
        readOnly: !canMove(e, userId),
        cls: `planner-event state-${state} tone-${tone}${ghost ? " is-ghost" : ""}${selectedId === e.id ? " is-selected" : ""}`,
        paymentState: state,
        movable: canMove(e, userId),
        label: `${e.name}, ${usd(e.amount_cents)}, ${stateLabel[state]}, ${e.date}`,
      };
    });
    if (preview && canMove(preview.event, userId)) {
      const original = data.find((e) => e.id === preview.event.id);
      if (original)
        data.push({
          ...original,
          id: "preview:" + original.id,
          startDate: calendarDate(preview.date),
          readOnly: true,
          cls: "planner-event is-preview tone-0",
          label: `Preview: ${preview.event.name}, ${usd(preview.event.amount_cents)}, Planned, ${preview.date}`,
        });
    }
    s.eventStore.data = data;
    const selected = events.find((e) => e.id === selectedId);
    s.timeRangeStore.data = [
      {
        id: "today",
        startDate: calendarDate(today),
        endDate: calendarDate(addDays(today, 1)),
        cls: "planner-today-column",
      },
      ...(preview || selected
        ? [
            {
              id: "selection",
              startDate: calendarDate(preview?.date || selected!.date),
              endDate: calendarDate(
                addDays(preview?.date || selected!.date, 1),
              ),
              cls: "planner-selected-column",
            },
          ]
        : []),
    ];
  }, [events, members, userId, preview, selectedId, start, end, view, today]);
  return (
    <div
      className="bryntum-host"
      ref={host}
      aria-label="Contribution timeline"
    />
  );
}
