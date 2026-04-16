import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatProjectAuditResult, runProjectAudit } from "./pipeline.js";
import type { OrcaTaskSpec } from "../types.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "orca-audit-"));
}

function task(path: string): OrcaTaskSpec {
  return {
    originalUserMessage: `Check this app for production readiness\n${path}`,
    intent: "check this app",
    goals: ["Assess production readiness"],
    mode: "project_audit",
    permissions: { fileRead: true, fileWrite: false, shellExec: false },
    context: { auditPath: path },
  };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("project audit pipeline", () => {
  it("reports missing local paths with structured failure typing", () => {
    const missing = join(tmpdir(), `orca-missing-${Date.now()}`);
    const result = runProjectAudit({ taskSpec: task(missing) });

    expect(result.preflight.exists).toBe(false);
    expect(result.failures.some((failure) => failure.category === "missing_path")).toBe(true);
    expect(result.failures[0]).toMatchObject({
      retryable: false,
      suggestedNextAction: expect.stringContaining("existing"),
    });
    expect(result.readiness.readiness).toBe("insufficient_evidence");
  });

  it("distinguishes directory targets from file targets", () => {
    const root = tempRoot();
    const file = join(root, "package.json");
    writeJson(file, { name: "demo" });

    try {
      const directoryResult = runProjectAudit({ taskSpec: task(root) });
      const fileResult = runProjectAudit({ taskSpec: task(file) });

      expect(directoryResult.preflight.kind).toBe("directory");
      expect(fileResult.preflight.kind).toBe("file");
      expect(fileResult.failures.some((failure) => failure.category === "bad_workdir")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies marker files into explicit project categories", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"));
    writeJson(join(root, "package.json"), {
      name: "electron-demo",
      dependencies: { react: "^19.0.0", electron: "^39.0.0" },
      devDependencies: { vite: "^7.0.0", "electron-builder": "^26.0.0" },
      scripts: { build: "vite build", test: "vitest", dist: "electron-builder" },
    });
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "vite.config.ts"), "export default {}\n");

    try {
      const result = runProjectAudit({ taskSpec: task(root) });

      expect(result.classification.primary).toBe("electron_app");
      expect(result.classification.categories).toEqual(expect.arrayContaining(["node_app", "react_app", "vite_app", "electron_app"]));
      expect(result.classification.evidence.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs a read-only audit flow and does not execute shell commands", () => {
    const root = tempRoot();
    writeJson(join(root, "package.json"), {
      name: "node-demo",
      scripts: { build: "tsc", test: "vitest" },
    });
    mkdirSync(join(root, "src"));

    try {
      const result = runProjectAudit({ taskSpec: task(root) });

      expect(result.commandPolicy.approvedRecipes).toContain("npm run build");
      expect(result.commandPolicy.decisions.every((decision) => decision.status !== "blocked")).toBe(true);
      expect(result.commandPolicy.decisions.every((decision) => decision.status === "allowed_not_run")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks command execution when the stack is unknown", () => {
    const root = tempRoot();
    writeFileSync(join(root, "notes.txt"), "not a project\n");

    try {
      const result = runProjectAudit({ taskSpec: task(root) });

      expect(result.classification.primary).toBe("unknown");
      expect(result.commandPolicy.shellAllowed).toBe(false);
      expect(result.commandPolicy.decisions[0]).toMatchObject({
        status: "blocked",
        failure: { category: "unsupported_stack" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scores partial evidence as prototype or not production ready", () => {
    const root = tempRoot();
    writeJson(join(root, "package.json"), {
      name: "partial-demo",
      scripts: { start: "vite" },
      dependencies: { vite: "^7.0.0" },
    });

    try {
      const result = runProjectAudit({ taskSpec: task(root) });

      expect(["prototype", "not_production_ready", "insufficient_evidence"]).toContain(result.readiness.readiness);
      expect(result.readiness.missingEvidence).toEqual(expect.arrayContaining([
        expect.stringContaining("No test"),
      ]));
      expect(result.readiness.riskFlags).toContain("no_test_evidence");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("samples key files and source before assigning read-first confidence", () => {
    const root = tempRoot();
    mkdirSync(join(root, "src"));
    writeJson(join(root, "package.json"), {
      name: "sampled-demo",
      scripts: { build: "tsc", test: "vitest", lint: "eslint ." },
      dependencies: { express: "^5.0.0" },
    });
    writeFileSync(join(root, "README.md"), "# Sampled Demo\n\nRun build and tests before release.\n");
    writeFileSync(join(root, ".env.example"), "API_URL=\nTOKEN=\n");
    writeFileSync(join(root, ".env"), "API_URL=http://localhost\nTOKEN=secret\n");
    writeFileSync(join(root, "src", "index.ts"), [
      "try {",
      "  console.error('startup failed');",
      "} catch (error) {",
      "  throw new Error(String(error));",
      "}",
    ].join("\n"));

    try {
      const result = runProjectAudit({ taskSpec: task(root) });
      const output = formatProjectAuditResult(result);

      expect(result.readiness.supportingEvidence).toEqual(expect.arrayContaining([
        expect.stringContaining("package.json read"),
        expect.stringContaining("Source sample inspected"),
        expect.stringContaining("error-handling signal"),
      ]));
      expect(result.readiness.missingEvidence).toContain("Runtime build/test/lint commands were not run in this read-first audit");
      expect(result.readiness.riskFlags).toContain("runtime_not_verified");
      expect(result.readiness.confidence).toBeLessThanOrEqual(0.74);
      expect(output).not.toContain("- src/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("formats incomplete evidence honestly", () => {
    const root = tempRoot();
    writeFileSync(join(root, "notes.txt"), "not a project\n");

    try {
      const result = runProjectAudit({ taskSpec: task(root) });
      const output = formatProjectAuditResult(result);

      expect(output).toContain("Runtime commands:");
      expect(output).toContain("not run in this pass");
      expect(output).toContain("Structured failures:");
      expect(output).toContain("unsupported_stack");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
