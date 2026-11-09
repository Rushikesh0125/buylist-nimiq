export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function insist(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new HttpError(status, code, message);
}
export function cents(value: unknown) {
  insist(
    typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      value <= 100_000_000,
    400,
    "INVALID_AMOUNT",
    "Use a positive integer amount in cents, up to $1,000,000.",
  );
  return value;
}
export function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T00:00:00Z")) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
export type Frequency = "weekly" | "fortnightly" | "monthly";
export function nextDate(start: string, index: number, frequency: Frequency) {
  insist(validDate(start), 400, "INVALID_DATE", "Use a valid YYYY-MM-DD date.");
  const d = new Date(start + "T00:00:00Z");
  if (frequency === "monthly") {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + index);
    const last = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
    ).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  } else
    d.setUTCDate(d.getUTCDate() + index * (frequency === "weekly" ? 7 : 14));
  return d.toISOString().slice(0, 10);
}
export function forecast(
  remaining: number,
  amount: number,
  start: string,
  frequency: Frequency,
) {
  insist(
    Number.isSafeInteger(remaining) && remaining >= 0,
    400,
    "INVALID_REMAINDER",
    "Invalid remaining balance.",
  );
  cents(amount);
  insist(
    ["weekly", "fortnightly", "monthly"].includes(frequency),
    400,
    "INVALID_FREQUENCY",
    "Invalid frequency.",
  );
  insist(validDate(start), 400, "INVALID_DATE", "Invalid start date.");
  const count = Math.ceil(remaining / amount);
  insist(
    count <= 600,
    400,
    "PLAN_TOO_LONG",
    "Choose an amount that reaches the target within 600 contributions.",
  );
  return {
    count,
    readyDate: count ? nextDate(start, count - 1, frequency) : null,
    events: Array.from({ length: count }, (_, i) => ({
      date: nextDate(start, i, frequency),
      amountCents: Math.min(amount, remaining - i * amount),
    })),
  };
}
export function equalShare(total: number, count: number, index: number) {
  insist(
    Number.isSafeInteger(total) &&
      total > 0 &&
      Number.isInteger(count) &&
      count > 0 &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < count,
    400,
    "INVALID_SHARE",
    "Invalid share.",
  );
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}
export function httpsUrl(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
