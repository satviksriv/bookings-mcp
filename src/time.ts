/**
 * All times are the business's local wall-clock time, stored as
 * "YYYY-MM-DDTHH:MM" strings. That format sorts and compares correctly
 * as plain text, which keeps overlap checks in SQL simple.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function isDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isDateTime(s: string): boolean {
  if (!DATETIME_RE.test(s)) return false;
  const [date, time] = s.split("T");
  const [h, min] = time.split(":").map(Number);
  return isDate(date) && h < 24 && min < 60;
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function minutesOfDay(dateTime: string): number {
  const [h, m] = dateTime.slice(11, 16).split(":").map(Number);
  return h * 60 + m;
}

export function atMinutes(date: string, minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${date}T${h}:${m}`;
}

export function addMinutes(dateTime: string, minutes: number): string {
  const [date] = dateTime.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const total = minutesOfDay(dateTime) + minutes;
  const dt = new Date(Date.UTC(y, mo - 1, d, 0, total));
  return dt.toISOString().slice(0, 16);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Current local wall-clock time in the "YYYY-MM-DDTHH:MM" format. */
export function localNow(): string {
  const n = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
}
