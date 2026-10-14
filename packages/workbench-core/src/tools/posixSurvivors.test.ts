/**
 * The POSIX survivor scan, parsed from `ps -eo pid=,ppid=,pgid=,comm=,lstart=`
 * output. The real-process case (survivingProcesses.test.ts) runs on every
 * platform; this pins the parsing rules with a fixed enumeration so the Linux
 * behaviour is checked on Windows too: a detached grandchild leaves the
 * command's process group (setsid) and is reparented to init, so group
 * membership alone misses it — CI on Linux showed exactly that.
 */
import { describe, expect, it } from "vitest";
import { parsePosixSurvivors } from "./processIdentity.js";

const SPAWNED_AT = "2026-10-14T12:52:00.000Z";
const before = new Date(Date.parse(SPAWNED_AT) - 60_000);
const during = new Date(Date.parse(SPAWNED_AT) + 500);
// `lstart` prints like "Tue Oct 14 12:52:00 2026" (local time); Date.parse accepts it.
const lstart = (d: Date) => d.toString().replace(/ GMT.*$/, "").replace(/^(\w{3}) (\w{3}) (\d{2}) (\d{4}) (\d{2}:\d{2}:\d{2})$/, "$1 $2 $3 $5 $4");

const ROOT = 500; // the command's shell, group leader (already exited: absent from the listing)
const SELF = 42;

const PS = [
  `  1     0     1 systemd ${lstart(before)}`,
  `${SELF}     1 ${SELF} node ${lstart(before)}`,                 // the test runner itself, long-lived
  `  777     1   777 sshd ${lstart(before)}`,                     // unrelated daemon started long before
  `  501 ${ROOT} ${ROOT} node ${lstart(during)}`,                  // child still in the group (descendant)
  `  502     1   502 node ${lstart(during)}`,                      // detached grandchild: own group, reparented to init
  `  503   777   777 bash ${lstart(during)}`,                      // started during the window but its parent is alive and unrelated
].join("\n");

describe("POSIX survivor parsing", () => {
  const alive = (pid: number) => ([501, 502, 503, 777, SELF, 1].includes(pid) ? "alive" : "gone") as "alive" | "gone";

  it("reports group members as descendants and a reparented process created during the command as an orphan", () => {
    const found = parsePosixSurvivors(PS, ROOT, SPAWNED_AT, SELF, alive);
    expect(found.map((f) => [f.pid, f.relation, f.name])).toEqual([[501, "descendant", "node"], [502, "orphan", "node"]]);
    expect(found[1]!.identity).toBe(lstart(during));
  });

  it("never reports itself, processes created before the command, or children of a live unrelated parent", () => {
    const pids = parsePosixSurvivors(PS, ROOT, SPAWNED_AT, SELF, alive).map((f) => f.pid);
    expect(pids).not.toContain(SELF);
    expect(pids).not.toContain(777);
    expect(pids).not.toContain(503);
    expect(pids).not.toContain(1);
  });

  it("an orphan that has exited since the enumeration is not reported", () => {
    const gone = (pid: number) => (pid === 502 ? "gone" : alive(pid));
    expect(parsePosixSurvivors(PS, ROOT, SPAWNED_AT, SELF, gone).map((f) => f.pid)).toEqual([501]);
  });

  it("tolerates unparseable lines and an unparseable start time for init's children", () => {
    const noisy = `garbage line\n  600     1   600 node not-a-date at all\n${PS}`;
    const pids = parsePosixSurvivors(noisy, ROOT, SPAWNED_AT, SELF, (pid) => (pid === 600 ? "alive" : alive(pid))).map((f) => f.pid);
    expect(pids).toEqual([501, 502]);
  });
});
