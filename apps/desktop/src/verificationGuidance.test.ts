import { describe, expect, it } from "vitest";
import { verificationGuidance } from "./verificationGuidance";

describe("verificationGuidance", () => {
  it("tells a bug-fix worker to reproduce, re-run the suite, or document an alternative verification", () => {
    const goals = verificationGuidance("Fix the overlap bug in src/bookings.js: a meeting cannot start exactly when the previous one ends. Do not modify the existing tests.");
    expect(goals.join("\n")).toMatch(/record that the reported failure reproduces/);
    expect(goals.join("\n")).toMatch(/Alternative verification:/);
    expect(goals.join("\n")).toMatch(/Do not modify, delete, skip, or weaken/);
  });

  it("tells a feature worker that the presence of code is not evidence it works", () => {
    const goals = verificationGuidance("Add a cancelBooking(id) function to src/bookings.js that removes the booking.");
    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatch(/add a test with assertions/i);
    expect(goals[0]).toMatch(/presence of the code is not evidence/);
  });

  it("tells a refactor worker to show behaviour is preserved and a docs worker that the file is checked", () => {
    expect(verificationGuidance("Refactor src/bookings.js to extract the overlap check into a helper. Do not change behaviour.").join("\n")).toMatch(/before and after the refactor/);
    expect(verificationGuidance("Update docs/booking.md to document the back-to-back rule.").join("\n")).toMatch(/final file is checked/);
  });

  it("adds nothing for inspection or other requests", () => {
    expect(verificationGuidance("Explain how the booking overlap check works in src/bookings.js.")).toEqual([]);
    expect(verificationGuidance("What time is it?")).toEqual([]);
  });
});
