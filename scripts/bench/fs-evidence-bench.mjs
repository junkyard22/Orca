#!/usr/bin/env node
/**
 * Measures the per-tool-execution cost of the runtime's filesystem observer
 * (createWorkspaceEvidenceCollector().observeExecution) on temporary Git
 * repositories of three sizes. Everything is created under the OS temp
 * directory and removed afterwards. Build orca-core first (`pnpm -r build`).
 *
 *   node scripts/bench/fs-evidence-bench.mjs [small,medium,large]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { createWorkspaceEvidenceCollector } = await import(join(here, "..", "..", "packages", "orca-core", "dist", "index.js"));

const SIZES = { small: { files: 300, bytes: 2_000 }, medium: { files: 5_000, bytes: 4_000 }, large: { files: 40_000, bytes: 4_000 } };
const wanted = (process.argv[2] ?? "small,medium,large").split(",");
const ms = (start) => Number(process.hrtime.bigint() - start) / 1e6;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const git = (root, ...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });

function makeRepo(name, { files, bytes }) {
  const root = mkdtempSync(join(tmpdir(), `orca-bench-${name}-`));
  const body = "x".repeat(bytes - 20);
  for (let i = 0; i < files; i++) {
    const dir = join(root, "src", `d${Math.floor(i / 200)}`);
    if (i % 200 === 0) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `f${i}.ts`), `// file ${i}\n${body}\n`);
  }
  // Git-ignored output: present on disk, outside the inventory.
  writeFileSync(join(root, ".gitignore"), "ignored/\n*.log\n");
  mkdirSync(join(root, "ignored"));
  for (let i = 0; i < 50; i++) writeFileSync(join(root, "ignored", `g${i}.bin`), body);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.email=bench@example.invalid", "-c", "user.name=bench", "commit", "-q", "-m", "init");
  return root;
}

const rows = [];
for (const name of wanted) {
  const spec = SIZES[name];
  if (!spec) continue;
  const root = makeRepo(name, spec);
  try {
    let t = process.hrtime.bigint();
    const collector = createWorkspaceEvidenceCollector(root);
    const baselineMs = ms(t); // full hash of every tracked file

    // mtimes older than the 2 s "racily clean" window are trusted on stat; wait once so steady state is measured too.
    const observe = async (label, run) => {
      const start = process.hrtime.bigint();
      const { evidence } = await collector.observeExecution({ tool: label }, run);
      return { ms: ms(start), evidence };
    };
    const firstNoop = await observe("noop-immediately-after-baseline", async () => undefined);
    await new Promise((r) => setTimeout(r, 2_200));
    const steady = [];
    for (let i = 0; i < 5; i++) steady.push((await observe("noop", async () => undefined)).ms);
    const oneFile = await observe("write-one", async () => { writeFileSync(join(root, "src", "d0", "f1.ts"), "// changed\n"); });
    const hundred = await observe("write-100", async () => { for (let i = 0; i < 100; i++) writeFileSync(join(root, "src", "d0", `f${i}.ts`), `// changed ${i}\n`); });
    const ignored = await observe("write-ignored", async () => { writeFileSync(join(root, "ignored", "g0.bin"), "changed"); writeFileSync(join(root, "build.log"), "log"); });
    const untracked = await observe("write-new-untracked", async () => { writeFileSync(join(root, "src", "brand-new.ts"), "export {};\n"); });
    // A change made by something else while a tool that changes nothing is running.
    const concurrent = await observe("noop-with-external-writer", async () => { writeFileSync(join(root, "src", "d0", "f2.ts"), "// someone else\n"); });
    // Two observed executions overlapping.
    let release; const held = new Promise((r) => { release = r; });
    const slow = collector.observeExecution({ tool: "slow" }, async () => { await held; });
    const fast = await collector.observeExecution({ tool: "fast" }, async () => { writeFileSync(join(root, "src", "d0", "f3.ts"), "// overlap\n"); });
    release(); const slowDone = await slow;

    rows.push({
      repo: name, files: spec.files, megabytes: +(spec.files * spec.bytes / 1e6).toFixed(1),
      baselineHashAllMs: +baselineMs.toFixed(0),
      firstObserveWithin2sMs: +firstNoop.ms.toFixed(0),
      steadyNoopObserveMs: +median(steady).toFixed(0),
      steadyPerSnapshotMs: +(median(steady) / 2).toFixed(0),
      oneFileChangedMs: +oneFile.ms.toFixed(0), oneFile: `${oneFile.evidence.status}/${oneFile.evidence.changes.length}`,
      hundredFilesChangedMs: +hundred.ms.toFixed(0), hundred: `${hundred.evidence.status}/${hundred.evidence.changes.length}`,
      ignoredOnly: `${ignored.evidence.status}/${ignored.evidence.changes.length}`,
      newUntracked: `${untracked.evidence.status}/${untracked.evidence.changes.length}`,
      externalWriterDuringTool: `${concurrent.evidence.status}/${concurrent.evidence.changes.length}`,
      overlapping: `${fast.evidence.status},${slowDone.evidence.status}`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(rows, null, 1));
