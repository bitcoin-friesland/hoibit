/**
 * Calendar days ("YYYY-MM-DD") for the day a conversation took place. The team works in the
 * Netherlands and Belgium, so "today" is a day there: a conversation at 00:30 is not yesterday's.
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

/**
 * A typed day as "YYYY-MM-DD", or undefined when it is no real day or still to come. Day first,
 * as the team writes it: "14-10", "14/10/2026", "14.10.26"; "2026-10-14" works too. Without a
 * year it is this year's, or last year's when this year's has not come yet ("28-12" in January).
 */
export function parseDay(input: string, now = new Date()): string | undefined {
  const today = teamDay(0, now);
  const text = input.trim();
  let day: string | undefined;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const dayFirst = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{4}|\d{2}))?$/.exec(text);
  if (iso) {
    day = realDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  } else if (dayFirst) {
    const [, d, m, y] = dayFirst;
    const thisYear = Number(today.slice(0, 4));
    if (y) {
      day = realDay(y.length === 2 ? 2000 + Number(y) : Number(y), Number(m), Number(d));
    } else {
      day = realDay(thisYear, Number(m), Number(d));
      if (day && day > today) day = realDay(thisYear - 1, Number(m), Number(d));
    }
  }
  return day && day <= today ? day : undefined;
}

// How a day is named in a message: "today", "yesterday" or "14-10-2026".
export function dayLabel(day: string, now = new Date()): string {
  if (day === teamDay(0, now)) return "today";
  if (day === teamDay(1, now)) return "yesterday";
  const [year, month, date] = day.split("-");
  return `${date}-${month}-${year}`;
}
