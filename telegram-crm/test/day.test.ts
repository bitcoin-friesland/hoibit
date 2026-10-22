import { describe, expect, it } from "vitest";
import { dayLabel, parseDay, teamDay } from "../src/helpers/day";

// 22 October 2026, 00:30 in Leeuwarden (CEST, UTC+2): still the 21st in UTC.
const NIGHT = new Date("2026-10-21T22:30:00Z");
// 5 January 2026, noon in Leeuwarden.
const JANUARY = new Date("2026-01-05T11:00:00Z");

describe("teamDay", () => {
  it("counts days in the team's time zone, not in UTC", () => {
    expect(teamDay(0, NIGHT)).toBe("2026-10-22");
    expect(teamDay(1, NIGHT)).toBe("2026-10-21");
    expect(teamDay(1, new Date("2026-03-01T10:00:00Z"))).toBe("2026-02-28");
  });
});

describe("parseDay", () => {
  it("reads day-first dates with or without a year, and ISO dates", () => {
    expect(parseDay("14-10", NIGHT)).toBe("2026-10-14");
    expect(parseDay(" 14/10/2026 ", NIGHT)).toBe("2026-10-14");
    expect(parseDay("1.3.25", NIGHT)).toBe("2025-03-01");
    expect(parseDay("2026-10-22", NIGHT)).toBe("2026-10-22");
  });

  it("takes last year's day when this year's has not come yet", () => {
    expect(parseDay("28-12", JANUARY)).toBe("2025-12-28");
    expect(parseDay("5-1", JANUARY)).toBe("2026-01-05");
  });

  it("refuses days that do not exist, are still to come or are no date", () => {
    for (const input of ["30-02-2026", "23-10-2026", "2026-10-23", "32-1", "14-13", "yesterday", "14 oct", ""]) {
      expect(parseDay(input, NIGHT)).toBeUndefined();
    }
  });
});

describe("dayLabel", () => {
  it("names today and yesterday, and writes other days day-first", () => {
    expect(dayLabel("2026-10-22", NIGHT)).toBe("today");
    expect(dayLabel("2026-10-21", NIGHT)).toBe("yesterday");
    expect(dayLabel("2026-03-01", NIGHT)).toBe("01-03-2026");
  });
});
