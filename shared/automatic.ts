import { nextDate, type Frequency } from "./domain";

export function dateInTimezone(timezone: string, instant = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// Always anchor monthly recurrences on the original date; skip missed periods without back-billing.
export function nextFutureCycle(
  start: string,
  index: number,
  frequency: Frequency,
  today: string,
) {
  let next = index + 1;
  while (nextDate(start, next, frequency) <= today) next++;
  return { index: next, date: nextDate(start, next, frequency) };
}
