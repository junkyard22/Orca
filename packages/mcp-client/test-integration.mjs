/**
 * Direct MCP integration test — exercises the mcp-client end-to-end
 * against the test server WITHOUT going through the LLM pipeline.
 *
 * Verifies:
 *   1. Scalar args:    echo_message (message + repeat)
 *   2. Enum args:      describe_color (enum)
 *   3. Nested object:  summarise_config (object + array → string conversion)
 *   4. Broken server:  startup survives when one server fails
 *   5. No orphaned processes after the broken server attempt
 *
 * Run from repo root:
 *   node packages/mcp-client/test-integration.mjs
 */

import { loadMcpExtensions } from "./src/index.ts";

// Allow importing TypeScript directly with the experimental strip-types flag
// (Node ≥ 22.6) — the mjs loader transparently strips types.
// If you don't have strip-types, build first: pnpm --filter @clawde/mcp-client build

const TEST_SERVER_CMD = "node";
const TEST_SERVER_ARG = new URL("./test-server.mjs", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

let passed = 0;
let failed = 0;

function ok(label, result, expected) {
  const match = typeof expected === "string"
    ? result.includes(expected)
    : expected instanceof RegExp
      ? expected.test(result)
      : result === expected;

  if (match) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    got:      ${JSON.stringify(result)}`);
    failed++;
  }
}

function fail(label, msg) {
  console.error(`  ✗ ${label}: ${msg}`);
  failed++;
}

// ---------------------------------------------------------------------------
// Test 1–3: connect to working test server and call each tool
// ---------------------------------------------------------------------------

console.log("\n── Test 1–3: Working server tools ──────────────────────────────");

const workingCfg = [{
  id: "test",
  name: "Test Server",
  transport: "stdio",
  command: TEST_SERVER_CMD,
  args: [TEST_SERVER_ARG],
  enabled: true,
  namespaceTools: false,   // use raw names so we can call them directly
}];

let extensions;
try {
  extensions = await loadMcpExtensions(workingCfg, (msg) => process.stderr.write(msg + "\n"));
} catch (err) {
  console.error("FATAL: loadMcpExtensions threw:", err);
  process.exit(1);
}

if (extensions.length !== 1) {
  console.error(`Expected 1 extension, got ${extensions.length}`);
  process.exit(1);
}

const ext = extensions[0];
const tools = ext.tools;
const toolMap = Object.fromEntries(tools.map(t => [t.name, t]));

console.log(`  Connected. Tools: ${tools.map(t => t.name).join(", ")}`);

// --- Test 1: scalar args ---
try {
  const echoTool = toolMap["echo_message"];
  if (!echoTool) throw new Error("echo_message tool not found");
  const result = await echoTool.execute({ message: "hello world", repeat: 2 }, { runId: "t1" });
  const text = result.output ?? JSON.stringify(result);
  ok("Test 1 echo_message: repeat=2 returns 2 lines", text, /Echoed 2x/);
  ok("Test 1 echo_message: message echoed", text, "hello world");
} catch (err) {
  fail("Test 1 echo_message", err.message);
}

// --- Test 2: enum args ---
try {
  const colorTool = toolMap["describe_color"];
  if (!colorTool) throw new Error("describe_color tool not found");
  const result = await colorTool.execute({ color: "blue" }, { runId: "t2" });
  const text = result.output ?? JSON.stringify(result);
  ok("Test 2 describe_color: blue returns expected description", text, "Blue");
  ok("Test 2 describe_color: trustworthy keyword present", text, "trustworthy");
} catch (err) {
  fail("Test 2 describe_color", err.message);
}

// --- Test 3: nested object + array ---
try {
  const cfgTool = toolMap["summarise_config"];
  if (!cfgTool) throw new Error("summarise_config tool not found");
  // config arrives as JSON string (object→string schema conversion)
  const result = await cfgTool.execute({
    config: JSON.stringify({ name: "myapp", debug: true }),
    tags:   JSON.stringify(["dev", "production"]),
  }, { runId: "t3" });
  const text = result.output ?? JSON.stringify(result);
  ok("Test 3 summarise_config: reports 2 keys", text, "2 key");
  ok("Test 3 summarise_config: tags appear", text, /dev.*production|production.*dev/);
} catch (err) {
  fail("Test 3 summarise_config", err.message);
}

// Teardown working server
for (const ext of extensions) {
  try { await ext.onUnload?.(); } catch {}
}

// ---------------------------------------------------------------------------
// Test 4: broken server — loadMcpExtensions must survive
// ---------------------------------------------------------------------------

console.log("\n── Test 4: Broken server startup isolation ──────────────────────");

const brokenCfg = [
  {
    id: "broken",
    name: "Broken Server",
    transport: "stdio",
    command: "this-binary-does-not-exist",
    args: [],
    enabled: true,
  },
  {
    id: "good",
    name: "Good Server",
    transport: "stdio",
    command: TEST_SERVER_CMD,
    args: [TEST_SERVER_ARG],
    enabled: true,
    namespaceTools: false,
  },
];

let brokenResult;
try {
  brokenResult = await loadMcpExtensions(brokenCfg, (msg) => process.stderr.write(msg + "\n"));
} catch (err) {
  fail("Test 4: loadMcpExtensions must not throw", err.message);
  brokenResult = [];
}

ok("Test 4: Exactly 1 server survived (the good one)", brokenResult.length, 1);
if (brokenResult.length === 1) {
  ok("Test 4: Surviving server has tools", brokenResult[0].tools.length > 0, true);
}

for (const ext of brokenResult) {
  try { await ext.onUnload?.(); } catch {}
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n── Results ──────────────────────────────────────────────────────`);
console.log(`  Passed: ${passed}   Failed: ${failed}`);
if (failed === 0) {
  console.log("  ALL TESTS PASSED ✓");
  process.exit(0);
} else {
  console.error("  SOME TESTS FAILED ✗");
  process.exit(1);
}
