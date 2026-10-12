import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskBudgetLedger } from "@clawde/miranda-core";
import { createBudgetJournal } from "./journal.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tempFile = () => { const d = mkdtempSync(join(tmpdir(), "orca-journal-")); dirs.push(d); return join(d, "budget-journal.json"); };
const ANTHROPIC = { type: "anthropic", baseUrl: "https://api.anthropic.com/v1" };
const req = { provider: ANTHROPIC, model: "claude-sonnet-5-5", messages: [{ role: "user" as const, content: "hello" }], maxTokens: 256 };

describe("budget journal", () => {
  it("records a task while it runs and forgets it when it ends cleanly", () => {
    const journal = createBudgetJournal(tempFile());
    const ledger = new TaskBudgetLedger({ taskId: "t1", limitUsd: 1, onChange: (s) => journal.update(s) });
    journal.open("t1", ledger.snapshot());
    const r = ledger.reserve(req);
    ledger.settle(r, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    journal.close("t1");
    expect(journal.recover()).toEqual([]);
  });

  it("recovers a task the process never closed, with the exposure its open reservations and unreconciled charges represent", () => {
    const path = tempFile();
    const journal = createBudgetJournal(path);
    const ledger = new TaskBudgetLedger({ taskId: "t2", limitUsd: 1, onChange: (s) => journal.update(s) });
    journal.open("t2", ledger.snapshot());
    const inFlight = ledger.reserve(req);
    ledger.markUnreconciled(ledger.reserve(req), "network");
    // ... the process dies here; a new one reads the same file.
    const next = createBudgetJournal(path);
    const unresolved = next.recover();
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.taskId).toBe("t2");
    expect(unresolved[0]!.snapshot.requests.inFlight).toBe(1);
    expect(unresolved[0]!.exposureUsd).toBeCloseTo(inFlight.reservationUsd * 2, 9);
    // Returned once, then cleared.
    expect(next.recover()).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8")).tasks).toEqual({});
  });

  it("tolerates a missing or corrupt file", () => {
    const path = tempFile();
    expect(createBudgetJournal(path).recover()).toEqual([]);
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(path, "{not json");
    expect(createBudgetJournal(path).recover()).toEqual([]);
  });
});
