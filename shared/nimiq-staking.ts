import { validDate } from "./domain";

export const unstakeBufferDays = 5;

export function purchaseUnstakePlan(input: {
  purchaseDate: string;
  target: number;
  liquid: number;
  finalContribution: number;
  active: number;
  inactive: number;
  retired: number;
  minimum: number;
}) {
  if (!validDate(input.purchaseDate)) return null;
  const date = new Date(input.purchaseDate + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() - unstakeBufferDays);
  const gap = Math.max(
    0,
    input.target -
      input.liquid -
      input.finalContribution -
      input.inactive -
      input.retired,
  );
  let amount = Math.min(gap, input.active);
  if (amount > 0 && input.active - amount < input.minimum)
    amount = input.active;
  return {
    date: date.toISOString().slice(0, 10),
    amount,
    remainingGap: Math.max(0, gap - amount),
  };
}
