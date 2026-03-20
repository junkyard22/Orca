import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTime, getExactTime } from "./exactTime";

function getExpectedTimeZoneParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  });

  const partMap = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(partMap.year),
    month: Number(partMap.month),
    day: Number(partMap.day),
    hour: Number(partMap.hour),
    minute: Number(partMap.minute),
    second: Number(partMap.second),
    millisecond: date.getMilliseconds(),
    dayOfWeek: partMap.weekday,
  };
}

describe("exactTime", () => {
  const frozenNow = new Date("2026-06-15T23:45:30.456Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("uses custom timezone wall-clock components without changing the current instant", () => {
    const result = getExactTime({ timeZone: "Asia/Tokyo", format: "full" });
    const expected = getExpectedTimeZoneParts(frozenNow, "Asia/Tokyo");

    expect(result.date.getTime()).toBe(frozenNow.getTime());
    expect(result.timestamp).toBe(frozenNow.getTime());
    expect(result.isoString).toBe(frozenNow.toISOString());
    expect(result.components).toEqual(expected);
    expect(result.formatted).toBe("Tuesday, 6/16/2026 08:45:30.456");
  });

  it("formats custom patterns using timezone-aware components", () => {
    expect(formatTime("YYYY-MM-DD HH:mm:ss.SSS", { timeZone: "Asia/Tokyo" }))
      .toBe("2026-06-16 08:45:30.456");
  });

  it("falls back cleanly when a timezone is invalid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = getExactTime({ timeZone: "Mars/Olympus_Mons", format: "numeric" });
    const local = getExactTime({ format: "numeric" });

    expect(result.formatted).toBe(local.formatted);
    expect(warn).toHaveBeenCalledOnce();
  });
});
