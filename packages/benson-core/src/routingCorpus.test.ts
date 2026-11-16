import { describe, expect, it } from "vitest";
import { classifyIntent } from "./index.js";
import { parseIntent } from "./intent.js";
import type { IntentClass } from "./classify.js";

const ROUTING_CORPUS: Array<{ category: string; request: string; expected: IntentClass }> = [
  ...[
    "hi", "hello", "Hey!", "thanks!", "thank you", "cheers", "ok", "okay", "got it", "sounds good",
    "good morning", "how are you?", "who are you?", "what can you do?", "what is your name?", "that's helpful.",
  ].map((request) => ({ category: "social", request, expected: "CONVERSATIONAL" as const })),
  ...[
    "Why is the login test in auth.test.ts failing?",
    "Can you explain how the auth module in this repo works?",
    "What is in package.json?",
    "Tell me about the retry logic in src/http.ts",
    "How does it handle cancellation in runtime.ts?",
    "Find where parseConfig is defined",
    "Explain auth middleware in src/auth.ts",
    "What do you think about retry logic in src/http.ts?",
  ].map((request) => ({ category: "codebase", request, expected: "EXECUTABLE" as const })),
  ...[
    "What is a monad?", "Can you explain recursion?", "Tell me about closures.",
    "Do you think immutability is useful?", "What is your opinion on dependency injection?",
    "How does this work?", "Why are there leap years?", "Could you explain how lists work?",
  ].map((request) => ({ category: "general", request, expected: "EXECUTABLE" as const })),
  ...[
    "Fix the failing login test", "Update README.md with examples", "Create a file named report.md",
    "Refactor src/http.ts", "Run the unit test suite", "Correct the typo in README.md",
  ].map((request) => ({ category: "edit/execute", request, expected: "EXECUTABLE" as const })),
  ...[
    "Hi, explain src/auth.ts.", "Thanks! Fix the failing login test.", "ok, run the test suite",
    "What is a monad? Then add a usage example to README.md.",
    "Tell me about src/http.ts and fix its retry loop.", "Explain add(), don't change anything.",
  ].map((request) => ({ category: "mixed", request, expected: "EXECUTABLE" as const })),
  ...["", " ", "help", "fix it", "build it", "do it", "yes", "maybe"].map((request) => ({
    category: "ambiguous", request, expected: "NEEDS_CLARIFICATION" as const,
  })),
];

describe("Assignment 1 intake routing", () => {
  it.each([
    "Why is the login test in auth.test.ts failing?",
    "Can you explain how the auth module in this repo works?",
    "What is in package.json?",
    "Tell me about the retry logic in src/http.ts",
    "How does it handle cancellation in runtime.ts?",
  ])("routes the audit regression to the pipeline: %s", (request) => {
    const result = classifyIntent(request);
    expect(result.kind).toBe("EXECUTABLE");
    if (result.kind === "EXECUTABLE") expect(result.spec.originalUserMessage).toBe(request);
  });

  it.each(["hi", "thanks!", "ok", "sounds good"])("keeps the closed social shortcut: %s", (request) => {
    expect(classifyIntent(request).kind).toBe("CONVERSATIONAL");
  });

  it("T2 guard: inferred permissions for the package.json inspection remain read-only", () => {
    const parsed = parseIntent("What is in package.json?");
    expect(parsed.kind).toBe("TASK");
    if (parsed.kind === "TASK") expect(parsed.spec.permissions).toEqual(["read"]);
    const routed = classifyIntent("What is in package.json?");
    expect(routed.kind).toBe("EXECUTABLE");
    if (routed.kind === "EXECUTABLE") expect(routed.spec.permissions).toEqual(["read"]);
  });

  it.each(ROUTING_CORPUS)("corpus [$category]: $request -> $expected", ({ request, expected }) => {
    const result = classifyIntent(request);
    expect(result.kind).toBe(expected);
    if (result.kind === "EXECUTABLE") expect(result.spec.originalUserMessage).toBe(request);
  });
});
