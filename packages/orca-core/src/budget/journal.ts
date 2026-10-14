/**
 * Budget journal — survives a crash or restart.
 *
 * The task ledger lives in memory. If the process dies while requests are in
 * flight, their reservations (money that may have been charged) would be
 * forgotten. The journal writes the ledger's snapshot to disk on every change
 * and removes the task when it ends cleanly, so on the next start the app can
 * see which tasks never reconciled and treat their outstanding amounts as
 * spent-but-unconfirmed rather than silently dropping them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BudgetSnapshot } from "@clawde/miranda-core";

export interface UnresolvedBudgetTask {
  taskId: string;
  startedAt: string;
  updatedAt: string;
  snapshot: BudgetSnapshot;
  /** Upper bound of money that may have been charged: reservations in flight plus unreconciled requests. */
  exposureUsd: number;
}

export interface BudgetJournal {
  /** Record a task's first snapshot. */
  open(taskId: string, snapshot: BudgetSnapshot): void;
  /** Record the latest snapshot for an open task. */
  update(snapshot: BudgetSnapshot): void;
  /** The task ended; its final figures live in the run store, not here. */
  close(taskId: string): void;
  /** Tasks left open by a previous process, oldest first. Each is removed once returned. */
  recover(): UnresolvedBudgetTask[];
}

interface JournalFile {
  version: 1;
  tasks: Record<string, Omit<UnresolvedBudgetTask, "exposureUsd">>;
}

function exposure(snapshot: BudgetSnapshot): number {
  return Math.round((snapshot.reservedUsd + snapshot.unreconciledUsd) * 1e9) / 1e9;
}

export function createBudgetJournal(filePath: string): BudgetJournal {
  const read = (): JournalFile => {
    try {
      if (!existsSync(filePath)) return { version: 1, tasks: {} };
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<JournalFile>;
      return { version: 1, tasks: parsed.tasks && typeof parsed.tasks === "object" ? parsed.tasks : {} };
    } catch {
      return { version: 1, tasks: {} };
    }
  };
  const write = (file: JournalFile): void => {
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(file), "utf8");
      renameSync(tmp, filePath);
    } catch (error) {
      console.error("[orca-core] budget journal write failed:", error);
    }
  };
  return {
    open(taskId, snapshot) {
      const file = read();
      const now = new Date().toISOString();
      file.tasks[taskId] = { taskId, startedAt: now, updatedAt: now, snapshot };
      write(file);
    },
    update(snapshot) {
      const file = read();
      const task = file.tasks[snapshot.taskId];
      if (!task) return;
      task.snapshot = snapshot;
      task.updatedAt = new Date().toISOString();
      write(file);
    },
    close(taskId) {
      const file = read();
      if (!(taskId in file.tasks)) return;
      delete file.tasks[taskId];
      write(file);
    },
    recover() {
      const file = read();
      const tasks = Object.values(file.tasks)
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .map((t) => ({ ...t, exposureUsd: exposure(t.snapshot) }));
      if (tasks.length > 0) write({ version: 1, tasks: {} });
      return tasks;
    },
  };
}
