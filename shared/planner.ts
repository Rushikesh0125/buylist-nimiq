import { validDate } from "./domain";

export type PlannerState =
  "planned" | "received" | "pending" | "refunded" | "reversed" | "optional";
export type PlannerEvent = {
  id: string;
  user_id: string;
  name: string;
  date: string;
  amount_cents: number;
  version: number;
  capture_id: string | null;
  state?: PlannerState;
  editable?: boolean;
};
export function eventState(event: PlannerEvent): PlannerState {
  return event.state || (event.capture_id ? "received" : "planned");
}
export function canMove(event: PlannerEvent, userId: string) {
  return (
    event.user_id === userId &&
    eventState(event) === "planned" &&
    !event.capture_id &&
    event.editable !== false
  );
}
export function calendarDate(value: string) {
  if (!validDate(value)) throw new Error("Invalid calendar date");
  const [y, m, d] = value.split("-").map(Number);
  const result = new Date(0);
  result.setHours(0, 0, 0, 0);
  result.setFullYear(y, m - 1, d);
  return result;
}
export function dateValue(value: Date) {
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
export function addDays(value: string, days: number) {
  const date = calendarDate(value);
  date.setDate(date.getDate() + days);
  return dateValue(date);
}
export function plannerRange(anchor: string, view: "week" | "month") {
  const date = calendarDate(anchor);
  if (view === "month") {
    date.setDate(1);
    const start = dateValue(date);
    date.setMonth(date.getMonth() + 1);
    return {
      start,
      end: dateValue(date),
    };
  }
  const start = addDays(anchor, -((date.getDay() + 6) % 7));
  return { start, end: addDays(start, 14) };
}
export function shiftAnchor(
  anchor: string,
  view: "week" | "month",
  direction: number,
) {
  if (view === "week") return addDays(anchor, direction * 14);
  const d = calendarDate(anchor);
  d.setDate(1);
  d.setMonth(d.getMonth() + direction);
  return dateValue(d);
}
export const stateLabel: Record<PlannerState, string> = {
  planned: "Planned",
  received: "Received",
  pending: "Pending",
  refunded: "Refunded",
  reversed: "Reversed",
  optional: "Optional plan",
};
