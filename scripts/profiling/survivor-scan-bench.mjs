#!/usr/bin/env node
/**
 * Process-survivor scan overhead on realistic command workloads (phase 6.6).
 *
 *   pnpm --filter @yakstacks/workbench-core build
 *   node scripts/profiling/survivor-scan-bench.mjs [--samples 10] [--json out.json]
 *
 * Every command is disposable (`node -e`), runs in a scratch directory and
 * touches nothing. Measured per command: the command's own time (until the
 * tool result resolves), the survivor scan (until pendingResources
 * resolves), and end-to-end (max of both, since the scan is asynchronous).
 * Scenarios also measure parallel commands, a build-like tree, a detached
 * grandchild, a scan forced to "unknown", and how long workspace protection
 * takes to settle after a survivor exits.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SAMPLES = Number(opt("--samples", "10"));
const jsonOut = opt("--json", "");

const wb = await import(pathToFileURL(join(process.cwd(), "packages/workbench-core/dist/index.js")).href);
const oc = await import(pathToFileURL(join(process.cwd(), "packages/orca-core/dist/index.js")).href);
const { runCommandTool, createSandboxPolicy, probeProcess } = wb;
const { TaskLifecycle, createWorkspaceGuard } = oc;

const dir = mkdtempSync(join(tmpdir(), "orca-survivor-bench-"));
writeFileSync(join(dir, "short.js"), "console.log('ok')");
writeFileSync(join(dir, "build.js"), `
  // a build-like tree: three children that each do a little work and exit
  const { spawnSync } = require("node:child_process");
  for (let i = 0; i < 3; i++) spawnSync(process.execPath, ["-e", "let s=0; for (let i=0;i<2e6;i++) s+=i; console.log(s)"], { stdio: "ignore" });
  console.log("built");
`);
writeFileSync(join(dir, "grandchild.js"), `
  const { spawn } = require("node:child_process");
  const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { detached: true, stdio: "ignore", windowsHide: true });
  g.unref(); console.log("grandchild " + g.pid);
`);
const ctx = () => ({ workspaceRoot: dir, runId: "bench", sandbox: createSandboxPolicy({ extraAllowedCommands: ["node"] }), requestApproval: async () => true });

const stats = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  return { n: a.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +a[a.length - 1].toFixed(1) };
};
const mem = () => Math.round(process.memoryUsage().rss / 1048576);

/** Run one command; returns { command, scan, endToEnd, scanStatus, survivors }. */
async function runOne(command) {
  const t0 = performance.now();
  const result = await runCommandTool.execute({ command, timeout: 60_000 }, ctx());
  const commandMs = performance.now() - t0;
  const pending = result.pendingResources;
  const scan = pending ? await pending : { status: "none", resources: [] };
  const endToEnd = performance.now() - t0;
  return { command: commandMs, scan: endToEnd - commandMs, endToEnd, scanStatus: scan.status, survivors: scan.resources, output: result.output };
}

const report = { host: `${process.platform} node ${process.version}`, samples: SAMPLES, scenarios: {} };
const cpu0 = process.cpuUsage(); const rss0 = mem(); const wall0 = performance.now();

// 1. one short command, N samples
{
  const rows = []; for (let i = 0; i < SAMPLES; i++) rows.push(await runOne("node short.js"));
  report.scenarios["one short command"] = { commandMs: stats(rows.map((r) => r.command)), scanMs: stats(rows.map((r) => r.scan)), endToEndMs: stats(rows.map((r) => r.endToEnd)), scanStatus: rows.map((r) => r.scanStatus).join(",") };
}
// 2/3. ten and twenty sequential commands (as a worker would: next command after the previous result, scans overlap)
for (const n of [10, 20]) {
  const t0 = performance.now(); const pendings = [];
  for (let i = 0; i < n; i++) { const r = await runCommandTool.execute({ command: "node short.js" }, ctx()); pendings.push(r.pendingResources); }
  const commandsDone = performance.now() - t0;
  const scans = await Promise.all(pendings);
  const all = performance.now() - t0;
  report.scenarios[`${n} sequential commands`] = { commandsMs: +commandsDone.toFixed(0), untilLastScanMs: +all.toFixed(0), perCommandMs: +(all / n).toFixed(0), scanStatuses: scans.map((s) => s.status).join(",") };
}
// 4. ten independent parallel commands
{
  const t0 = performance.now();
  const results = await Promise.all(Array.from({ length: 10 }, () => runCommandTool.execute({ command: "node short.js" }, ctx())));
  const commandsDone = performance.now() - t0;
  const scans = await Promise.all(results.map((r) => r.pendingResources));
  const all = performance.now() - t0;
  report.scenarios["10 parallel commands"] = { commandsMs: +commandsDone.toFixed(0), untilLastScanMs: +all.toFixed(0), scanStatuses: scans.map((s) => s.status).join(",") };
}
// 5. build-like tree
{
  const rows = []; for (let i = 0; i < Math.max(3, Math.floor(SAMPLES / 2)); i++) rows.push(await runOne("node build.js"));
  report.scenarios["build creating children"] = { commandMs: stats(rows.map((r) => r.command)), scanMs: stats(rows.map((r) => r.scan)), survivors: rows.map((r) => r.survivors.length).join(",") };
}
// 6. detached grandchild + protection settlement time
{
  const r = await runOne("node grandchild.js");
  const gpid = Number(r.output.match(/grandchild (\d+)/)?.[1]);
  const seen = r.survivors.some((s) => s.pid === gpid);
  const lifecycle = new TaskLifecycle({ taskId: "bench" });
  lifecycle.addResources(r.survivors);
  const guard = createWorkspaceGuard({ probe: (res) => probeProcess({ pid: res.pid, identity: res.identity }) });
  guard.protect(dir, { taskId: "bench", reason: "ended, but a process it started is still running", lifecycle });
  const protectedBefore = (await guard.status(dir)).length;
  try { process.kill(gpid); } catch {}
  const t0 = performance.now();
  let settled = 0; while ((await guard.status(dir)).length > 0 && performance.now() - t0 < 20000) { await new Promise((x) => setTimeout(x, 100)); } settled = performance.now() - t0;
  report.scenarios["detached grandchild"] = { commandMs: +r.command.toFixed(0), scanMs: +r.scan.toFixed(0), grandchildSeen: seen, survivorsReported: r.survivors.map((s) => `${s.pid}:${s.label}`), protectedWhileAlive: protectedBefore, settleAfterExitMs: +settled.toFixed(0) };
}
// 7. normal exit, no descendants (same as 1; recorded separately for the table)
{
  const r = await runOne("node -e \"console.log(1)\"");
  report.scenarios["normal exit, no descendants"] = { commandMs: +r.command.toFixed(0), scanMs: +r.scan.toFixed(0), scanStatus: r.scanStatus, survivors: r.survivors.length };
}
// 8. scan unavailable
{
  process.env.ORCA_PROCESS_SCAN = "off";
  const r = await runOne("node short.js");
  delete process.env.ORCA_PROCESS_SCAN;
  report.scenarios["scan unavailable"] = { commandMs: +r.command.toFixed(0), scanMs: +r.scan.toFixed(0), scanStatus: r.scanStatus };
}
const cpu = process.cpuUsage(cpu0);
report.overhead = { wallMs: +(performance.now() - wall0).toFixed(0), nodeCpuMs: Math.round((cpu.user + cpu.system) / 1000), rssBeforeMb: rss0, rssAfterMb: mem(), note: "PowerShell enumerations run in child processes; their CPU is not in nodeCpuMs" };
console.log(JSON.stringify(report, null, 2));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
