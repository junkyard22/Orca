import { describe, it, expect } from "vitest";
import { createToolService } from "./toolService.js";
import type { ToolRegistry, Tool, ToolRunCtx } from "@yakstacks/workbench-core";

// ── Minimal ToolRegistry stub ─────────────────────────────────────────────────

function makeTool(name: string, output: string, fail = false): Tool {
  return {
    name,
    description: `Mock ${name}`,
    schema: { type: "object", properties: { input: { type: "string", description: "Input value" } }, required: [] },
    execute: async (_input: Record<string, unknown>, _ctx: ToolRunCtx) =>
      fail
        ? { ok: false, output: "", error: `${name} failed` }
        : { ok: true, output },
  };
}

function makeRegistry(tools: Tool[]): ToolRegistry {
  const map = new Map(tools.map((t) => [t.name, t]));
  const registry: ToolRegistry = {
    get: (name: string) => map.get(name),
    list: () => tools,
    register: (_tool: Tool) => registry,
    formatForPrompt: () => tools.map((t) => `- ${t.name}: ${t.description}`).join("\n"),
  };
  return registry;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createToolService", () => {
  it("executes a known tool and returns its output", async () => {
    const registry = makeRegistry([makeTool("echo", "hello")]);
    const svc = createToolService(registry, "/workspace");
    const result = await svc.execute("echo", { input: "hi" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
  });

  it("returns error for unknown tool with available list", async () => {
    const registry = makeRegistry([makeTool("echo", "hello")]);
    const svc = createToolService(registry, "/workspace");
    const result = await svc.execute("nonexistent", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("nonexistent");
    expect(result.error).toContain("echo");
  });

  it("propagates tool execution errors", async () => {
    const registry = makeRegistry([makeTool("broken", "", true)]);
    const svc = createToolService(registry, "/workspace");
    const result = await svc.execute("broken", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("broken failed");
  });

  it("formatForPrompt returns tool descriptions", () => {
    const registry = makeRegistry([makeTool("foo", "out"), makeTool("bar", "out")]);
    const svc = createToolService(registry, "/workspace");
    const prompt = svc.formatForPrompt();
    expect(prompt).toContain("foo");
    expect(prompt).toContain("bar");
  });

  it("getSchema returns schema for known tool", () => {
    const registry = makeRegistry([makeTool("echo", "hello")]);
    const svc = createToolService(registry, "/workspace");
    const schema = svc.getSchema("echo");
    expect(schema).toBeDefined();
    expect(schema?.type).toBe("object");
  });

  it("getSchema returns undefined for unknown tool", () => {
    const registry = makeRegistry([]);
    const svc = createToolService(registry, "/workspace");
    expect(svc.getSchema("missing")).toBeUndefined();
  });

  it("defaults workspaceRoot to process.cwd()", () => {
    const registry = makeRegistry([makeTool("echo", "hello")]);
    // Should not throw when workspaceRoot is omitted
    expect(() => createToolService(registry)).not.toThrow();
  });
});
