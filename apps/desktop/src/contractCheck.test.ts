import { describe, expect, it } from "vitest";
import { checkRule2, checkRule3, extractAddedLines } from "../../../scripts/contract-check";

describe("contract-check call-site analysis", () => {
  it("accepts live LLM calls wrapped by the fail-closed gate helper", () => {
    const source = `
      import { runGatedLLMCall } from "./llmGate";
      await runGatedLLMCall(ctx, options, () => llm.complete(prompt));
    `;

    expect(checkRule2("apps/desktop/orca-tracer.ts", source, source)).toBeNull();
  });

  it("still blocks a newly added raw LLM call", () => {
    const source = "await llm.complete(prompt);";

    expect(checkRule2("apps/desktop/src/unsafe.ts", source, source)?.severity).toBe("BLOCKED");
  });

  it("does not reclassify an unchanged tool delegation as a new bypass", () => {
    const source = "return tools.execute(name, input);";

    expect(checkRule3("packages/orca-core/src/runtime.ts", source, "")).toBeNull();
  });

  it("still blocks a newly added ungated tool execution", () => {
    const source = "return tools.execute(name, input);";

    expect(checkRule3("packages/new-runtime.ts", source, source)?.severity).toBe("BLOCKED");
  });

  it("extracts additions without treating diff headers as source", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,0 +2,2 @@",
      "+const value = 1;",
      "+llm.complete(prompt);",
    ].join("\n");

    expect(extractAddedLines(diff)).toBe("const value = 1;\nllm.complete(prompt);");
  });
});
