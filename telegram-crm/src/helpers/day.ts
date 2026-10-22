/**
 * Calendar days ("YYYY-MM-DD"): the day a conversation took place, and the day to follow an
 * organization up. The team works in the Netherlands and Belgium, so "today" is a day there: a
 * conversation at 00:30 is not yesterday's.
 * team_members.time_zone is no longer asked (it was left out of the first steps), so one zone.
 */
const TEAM_TIME_ZONE = "Europe/Amsterdam";
const DAY_MS = 24 * 60 * 60 * 1000;

const DAY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: TEAM_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

// Today in the team's time zone, or daysAgo days before it.
export function teamDay(daysAgo = 0, now = new Date()): string {
  const today = DAY_FORMAT.format(now);
  if (daysAgo === 0) return today;
  return new Date(Date.parse(`${today}T00:00:00Z`) - daysAgo * DAY_MS).toISOString().slice(0, 10);
}

// "2026-10-14" when year, month and day make a real day ("2026-02-30" rolls over, so it is not).
function realDay(year: number, month: number, day: number): string | undefined {
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const time = Date.parse(`${iso}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === iso ? iso : undefined;
}

// A typed day as "YYYY-MM-DD", day first as the team writes it ("14-10", "14/10/2026",
// "14.10.26"; "2026-10-14" works too). Without a year: this year's, or the nearest one on the
// side of today that direction says when this year's lies on the other side.
function typedDay(input: string, today: string, direction: "past" | "future"): string | undefined {
  const text = input.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return realDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dayFirst = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?$/.exec(text);
  if (!dayFirst) return undefined;
  const [, d, m, y] = dayFirst;
  if (y) return realDay(y.length === 2 ? 2000 + Number(y) : Number(y), Number(m), Number(d));
  const thisYear = Number(today.slice(0, 4));
  const day = realDay(thisYear, Number(m), Number(d));
  if (direction === "past" && day && day > today) return realDay(thisYear - 1, Number(m), Number(d));
  if (direction === "future" && day && day < today) return realDay(thisYear + 1, Number(m), Number(d));
  return day;
}

/**
 * A typed day as "YYYY-MM-DD", or undefined when it is no real day or still to come. Without a
 * year it is this year's, or last year's when this year's has not come yet ("28-12" in January).
 */
export function parseDay(input: string, now = new Date()): string | undefined {
  const today = teamDay(0, now);
  const day = typedDay(input, today, "past");
  return day && day <= today ? day : undefined;
}

/**
 * A typed day to follow something up on, as "YYYY-MM-DD": today or later, or undefined. Without
 * a year it is this year's, or next year's when this year's has passed ("12-01" in December).
 */
export function parseFutureDay(input: string, now = new Date()): string | undefined {
  const today = teamDay(0, now);
  const day = typedDay(input, today, "future");
  return day && day >= today ? day : undefined;
}

// The day days after today in the team's time zone.
export const teamDayIn = (days: number, now = new Date()) => teamDay(-days, now);

// How a day is named in a message: "today", "yesterday" or "14-10-2026".
export function dayLabel(day: string, now = new Date()): string {
  if (day === teamDay(0, now)) return "today";
  if (day === teamDay(1, now)) return "yesterday";
  const [year, month, date] = day.split("-");
  return `${date}-${month}-${year}`;
}

// A follow-up day as the bot shows it: "12-01-2027", with "(overdue)" when it has passed, and
// "today" when it is today.
export function followUpLabel(day: string, now = new Date()) {
  const today = teamDay(0, now);
  if (day === today) return "today";
  const [year, month, date] = day.split("-");
  return `${date}-${month}-${year}${day < today ? " (overdue)" : ""}`;
}
