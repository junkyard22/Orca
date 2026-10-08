/**
 * Summit integration: Demo Mode settings drive the remediation's safeguards.
 *
 * main.ts computes `strictTools` from the *effective* settings (demoMode kept,
 * workspaceRoot replaced by the isolated demo workspace) and passes both to
 * enforceToolAuthorization. These tests pin that combination.
 */
import { describe, expect, it } from "vitest";
import { demoPaths, effectiveSettings } from "./demoMode";
import { authorizeToolCall } from "./toolAuthorization";
import type { OrcaSettings } from "./settings";

const userData = process.platform === "win32" ? "C:\\Users\\demo\\AppData\\Roaming\\@clawde\\desktop" : "/home/demo/.config/@clawde/desktop";
const realProject = process.platform === "win32" ? "C:\\Users\\demo\\projects\\real-app" : "/home/demo/projects/real-app";
const saved = { providers: [], roles: {}, budgetUsd: 3, maxRepairPasses: 2, verbose: false, workspaceRoot: realProject, demoMode: true } as OrcaSettings;

// Mirrors main.ts: const s = effectiveSettings(saved, userData); strictTools = s.demoMode === true
const s = effectiveSettings(saved, userData);
const strict = (s as { demoMode?: unknown }).demoMode === true;
const authorize = (tool: string, args: Record<string, unknown>) =>
  authorizeToolCall(tool, args, { workspaceRoot: s.workspaceRoot, strict });

describe("Live AI in Summit Demo Mode", () => {
  it("keeps demoMode in the effective settings, so strict mode is on", () => {
    expect(s.demoMode).toBe(true);
    expect(strict).toBe(true);
    expect(s.workspaceRoot).toBe(demoPaths(userData).workspace);
  });

  it("blocks external GitHub writes and Desktop Commander processes outright", () => {
    expect(authorize("github-mcp_push_files", { owner: "o", repo: "r", branch: "main", files: [{ path: "README.md", content: "x" }] }).decision).toBe("deny");
    expect(authorize("github-mcp_merge_pull_request", { owner: "o", repo: "r", pull_number: 1 }).decision).toBe("deny");
    expect(authorize("desktop-commander_start_process", { command: "powershell" }).decision).toBe("deny");
    expect(authorize("acme_unknown_tool", {}).decision).toBe("deny");
  });

  it("confines file and command access to the demo workspace, not the user's real project", () => {
    expect(authorize("write_file", { path: "src/bookings.js", content: "x" }).decision).toBe("allow");
    expect(authorize("read_file", { path: `${realProject}/secrets.env` }).decision).toBe("deny");
    expect(authorize("run_command", { command: `cat ${realProject}/secrets.env` }).decision).toBe("deny");
  });

  it("permits the demo's test command (run_command then asks the presenter)", () => {
    expect(authorize("run_command", { command: "npm test" }).decision).toBe("allow");
  });

  it("non-demo settings are not strict", () => {
    const normal = effectiveSettings({ ...saved, demoMode: false }, userData);
    expect((normal as { demoMode?: unknown }).demoMode === true).toBe(false);
    expect(normal.workspaceRoot).toBe(realProject);
  });
});
