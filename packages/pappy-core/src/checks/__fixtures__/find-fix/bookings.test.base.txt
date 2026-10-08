import { test } from "node:test";
import assert from "node:assert/strict";
import { bookRoom, findConflicts, parseTime } from "../src/bookings.js";

const schedule = [
  { room: "Hangar", title: "Standup", start: "09:00", end: "10:00" },
  { room: "Hangar", title: "Design review", start: "13:00", end: "14:30" },
  { room: "Tower", title: "1:1", start: "09:30", end: "10:00" },
];

test("parses 24-hour times", () => {
  assert.equal(parseTime("00:00"), 0);
  assert.equal(parseTime("09:30"), 570);
  assert.equal(parseTime("23:59"), 1439);
});

test("rejects malformed times", () => {
  assert.throws(() => parseTime("9:30"));
  assert.throws(() => parseTime("24:00"));
  assert.throws(() => parseTime("noon"));
});

test("books a free slot", () => {
  const result = bookRoom(schedule, { room: "Hangar", title: "Planning", start: "11:00", end: "12:00" });
  assert.equal(result.ok, true);
  assert.equal(result.schedule.length, schedule.length + 1);
});

test("rejects a booking that overlaps an existing meeting", () => {
  const result = bookRoom(schedule, { room: "Hangar", title: "Sync", start: "09:30", end: "10:30" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Standup/);
});

test("rejects a booking inside an existing meeting", () => {
  const conflicts = findConflicts(schedule, { room: "Hangar", title: "Huddle", start: "13:15", end: "13:45" });
  assert.equal(conflicts.length, 1);
});

test("the same time in a different room is fine", () => {
  const result = bookRoom(schedule, { room: "Tower", title: "Sync", start: "13:00", end: "14:00" });
  assert.equal(result.ok, true);
});

// Reproduces ISSUE.md: reported by users, added by QA. Fails until the bug is fixed.
test("a meeting can start exactly when the previous one ends (ISSUE.md)", () => {
  const result = bookRoom(schedule, { room: "Hangar", title: "Planning", start: "10:00", end: "11:00" });
  assert.equal(result.ok, true, result.reason);
});

test("rejects bookings that end before they start", () => {
  assert.throws(() => bookRoom(schedule, { room: "Hangar", title: "Backwards", start: "15:00", end: "14:00" }));
});
