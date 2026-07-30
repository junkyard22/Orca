import { afterEach, describe, expect, it, vi } from "vitest";
import { coerceAndValidate, convertSchema, extractText, mergeEnv } from "./index.js";

// ---------------------------------------------------------------------------
// convertSchema — MCP inputSchema → Orca ExtTool.schema
// ---------------------------------------------------------------------------

describe("convertSchema", () => {
  it("treats a missing schema as an empty object schema", () => {
    expect(convertSchema(undefined)).toEqual({
      type: "object",
      properties: {},
      required: [],
    });
  });

  it("maps integer and number to number, and unknown types to string", () => {
    const schema = convertSchema({
      type: "object",
      properties: {
        count: { type: "integer" },
        ratio: { type: "number" },
        note: { type: "string" },
        weird: { type: "null" },
        untyped: {},
      },
    });

    expect(schema.properties["count"]?.type).toBe("number");
    expect(schema.properties["ratio"]?.type).toBe("number");
    expect(schema.properties["note"]?.type).toBe("string");
    // Anything unrecognised degrades to string rather than being dropped.
    expect(schema.properties["weird"]?.type).toBe("string");
    expect(schema.properties["untyped"]?.type).toBe("string");
  });

  it("is case-insensitive about the declared type", () => {
    const schema = convertSchema({
      type: "object",
      properties: { flag: { type: "BOOLEAN" }, n: { type: "Integer" } },
    });

    expect(schema.properties["flag"]?.type).toBe("boolean");
    expect(schema.properties["n"]?.type).toBe("number");
  });

  it("falls back to the property name when no description is given", () => {
    const schema = convertSchema({
      type: "object",
      properties: { path: { type: "string" } },
    });

    expect(schema.properties["path"]?.description).toBe("path");
  });

  it("appends the nested shape to an object param's description", () => {
    const schema = convertSchema({
      type: "object",
      properties: {
        config: {
          type: "object",
          description: "Server config",
          properties: { host: { type: "string" }, port: { type: "integer" } },
        },
      },
    });

    expect(schema.properties["config"]?.type).toBe("object");
    expect(schema.properties["config"]?.description).toBe(
      "Server config — shape: {host: string, port: integer}",
    );
  });

  it("does not append a shape hint for an object with no declared properties", () => {
    const schema = convertSchema({
      type: "object",
      properties: { blob: { type: "object", description: "Freeform" } },
    });

    expect(schema.properties["blob"]?.description).toBe("Freeform");
  });

  it("annotates array params with their item type, defaulting to any", () => {
    const schema = convertSchema({
      type: "object",
      properties: {
        tags: { type: "array", description: "Tags", items: { type: "string" } },
        mixed: { type: "array", description: "Mixed" },
      },
    });

    expect(schema.properties["tags"]?.description).toBe("Tags — array of string");
    expect(schema.properties["mixed"]?.description).toBe("Mixed — array of any");
  });

  it("stringifies enum values, since servers may send numbers or booleans", () => {
    const schema = convertSchema({
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", 2, true] } },
    });

    expect(schema.properties["mode"]?.enum).toEqual(["fast", "2", "true"]);
  });

  it("omits enum entirely when the server sends an empty array", () => {
    const schema = convertSchema({
      type: "object",
      properties: { mode: { type: "string", enum: [] } },
    });

    expect(schema.properties["mode"]).not.toHaveProperty("enum");
  });

  it("preserves required, and defaults it to an empty array when malformed", () => {
    expect(
      convertSchema({ type: "object", properties: {}, required: ["a", "b"] }).required,
    ).toEqual(["a", "b"]);

    // A server sending a non-array `required` must not produce a broken schema.
    const malformed = convertSchema({
      type: "object",
      properties: {},
      required: "nope" as unknown as string[],
    });
    expect(malformed.required).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// coerceAndValidate — LLM-supplied args → typed args
// ---------------------------------------------------------------------------

describe("coerceAndValidate", () => {
  it("accepts input when no schema constraints are declared", () => {
    const result = coerceAndValidate({ anything: "goes" }, {});
    expect(result).toEqual({ ok: true, args: { anything: "goes" } });
  });

  it("reports every missing required param in one message", () => {
    const result = coerceAndValidate({}, { required: ["path", "content"] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain('missing required parameter "path"');
    expect(result.error).toContain('missing required parameter "content"');
  });

  it("treats an empty string as a missing required param", () => {
    const result = coerceAndValidate({ path: "" }, { required: ["path"] });
    expect(result.ok).toBe(false);
  });

  it("accepts false and 0 for required params", () => {
    // Guards against a truthiness check creeping in: both are legitimate values.
    const result = coerceAndValidate(
      { flag: false, count: 0 },
      {
        required: ["flag", "count"],
        properties: { flag: { type: "boolean" }, count: { type: "integer" } },
      },
    );
    expect(result.ok).toBe(true);
  });

  it("parses JSON strings into objects and arrays", () => {
    const result = coerceAndValidate(
      { config: '{"host":"localhost"}', tags: '["a","b"]' },
      {
        properties: { config: { type: "object" }, tags: { type: "array" } },
      },
    );

    expect(result).toEqual({
      ok: true,
      args: { config: { host: "localhost" }, tags: ["a", "b"] },
    });
  });

  it("passes already-structured objects and arrays through untouched", () => {
    const config = { host: "localhost" };
    const tags = ["a"];
    const result = coerceAndValidate(
      { config, tags },
      { properties: { config: { type: "object" }, tags: { type: "array" } } },
    );

    if (!result.ok) throw new Error(result.error);
    expect(result.args["config"]).toEqual(config);
    expect(result.args["tags"]).toEqual(tags);
  });

  it("rejects a JSON array supplied for an object param, and vice versa", () => {
    const asArray = coerceAndValidate(
      { config: "[1,2]" },
      { properties: { config: { type: "object" } } },
    );
    expect(asArray.ok).toBe(false);
    if (asArray.ok) throw new Error("expected failure");
    expect(asArray.error).toContain('"config" must be a JSON object, got array');

    const asObject = coerceAndValidate(
      { tags: '{"a":1}' },
      { properties: { tags: { type: "array" } } },
    );
    expect(asObject.ok).toBe(false);
    if (asObject.ok) throw new Error("expected failure");
    expect(asObject.error).toContain('"tags" must be a JSON array, got object');
  });

  it("reports unparseable JSON and truncates the echoed value", () => {
    const long = "x".repeat(200);
    const result = coerceAndValidate(
      { config: long },
      { properties: { config: { type: "object" } } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("is not valid JSON (expected object)");
    // Echoing the whole payload back into a prompt would be wasteful.
    expect(result.error).toContain("x".repeat(80));
    expect(result.error).not.toContain("x".repeat(81));
  });

  it("rejects a non-array, non-string value for an array param", () => {
    const result = coerceAndValidate(
      { tags: 42 },
      { properties: { tags: { type: "array" } } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain('"tags" must be an array');
  });

  it("coerces numeric strings and rejects non-numeric ones", () => {
    const ok = coerceAndValidate(
      { count: "42", ratio: "1.5" },
      { properties: { count: { type: "integer" }, ratio: { type: "number" } } },
    );
    expect(ok).toEqual({ ok: true, args: { count: 42, ratio: 1.5 } });

    const bad = coerceAndValidate(
      { count: "abc" },
      { properties: { count: { type: "integer" } } },
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error("expected failure");
    expect(bad.error).toContain('"count" must be a number, got "abc"');
  });

  it('coerces only exact "true"/"false" for booleans', () => {
    const ok = coerceAndValidate(
      { a: "true", b: "false" },
      { properties: { a: { type: "boolean" }, b: { type: "boolean" } } },
    );
    expect(ok).toEqual({ ok: true, args: { a: true, b: false } });

    // "TRUE" and "yes" are rejected rather than silently treated as true.
    for (const value of ["TRUE", "yes", "1"]) {
      const bad = coerceAndValidate(
        { a: value },
        { properties: { a: { type: "boolean" } } },
      );
      expect(bad.ok, `expected "${value}" to be rejected`).toBe(false);
    }
  });

  it("skips coercion for params that are absent or null", () => {
    const result = coerceAndValidate(
      { present: "1" },
      {
        properties: {
          present: { type: "integer" },
          absent: { type: "integer" },
          nulled: { type: "integer" },
        },
      },
    );

    expect(result).toEqual({ ok: true, args: { present: 1 } });
  });

  it("does not mutate the caller's input object", () => {
    const input = { count: "42" };
    coerceAndValidate(input, { properties: { count: { type: "integer" } } });
    expect(input.count).toBe("42");
  });

  it("returns required-param errors before attempting coercion", () => {
    // A missing required param short-circuits, so the caller sees the cause
    // rather than a downstream coercion complaint about the same field.
    const result = coerceAndValidate(
      { other: "not-a-number" },
      {
        required: ["path"],
        properties: { other: { type: "integer" } },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain('missing required parameter "path"');
    expect(result.error).not.toContain('"other"');
  });

  it("collects multiple coercion errors into one message", () => {
    const result = coerceAndValidate(
      { count: "abc", flag: "maybe" },
      { properties: { count: { type: "integer" }, flag: { type: "boolean" } } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain('"count"');
    expect(result.error).toContain('"flag"');
  });

  it("does not type-check non-string values for an object param", () => {
    // Known gap, documented rather than asserted as desirable: the array branch
    // rejects a non-array (see "rejects a non-array, non-string value"), but the
    // object branch only inspects strings, so a number passes straight through to
    // the MCP server.  If that asymmetry is fixed, this test should flip to
    // expecting ok === false.
    const result = coerceAndValidate(
      { config: 42 },
      { properties: { config: { type: "object" } } },
    );

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractText — MCP content array → plain text
// ---------------------------------------------------------------------------

describe("extractText", () => {
  it("returns an empty string for empty content", () => {
    expect(extractText([])).toBe("");
  });

  it("joins multiple text blocks with newlines", () => {
    expect(
      extractText([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("skips non-text content such as images and resources", () => {
    expect(
      extractText([
        { type: "image", data: "base64…", mimeType: "image/png" },
        { type: "text", text: "caption" },
        { type: "resource", uri: "file:///x" },
      ]),
    ).toBe("caption");
  });

  it("trims surrounding whitespace", () => {
    expect(extractText([{ type: "text", text: "  padded  " }])).toBe("padded");
  });

  it("returns an empty string when no block is text", () => {
    expect(extractText([{ type: "image", data: "x" }])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// mergeEnv
// ---------------------------------------------------------------------------

describe("mergeEnv", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("returns undefined when no extra vars are given", () => {
    // Undefined means "inherit the transport default" rather than "empty env".
    expect(mergeEnv(undefined)).toBeUndefined();
  });

  it("merges extra vars over process.env", () => {
    process.env["ORCA_TEST_BASE"] = "base";
    const merged = mergeEnv({ ORCA_TEST_EXTRA: "extra" });

    expect(merged?.["ORCA_TEST_BASE"]).toBe("base");
    expect(merged?.["ORCA_TEST_EXTRA"]).toBe("extra");
  });

  it("lets extra vars win over an existing process.env value", () => {
    process.env["ORCA_TEST_OVERRIDE"] = "original";
    expect(mergeEnv({ ORCA_TEST_OVERRIDE: "replaced" })?.["ORCA_TEST_OVERRIDE"]).toBe(
      "replaced",
    );
  });

  it("drops undefined process.env entries so the result is all strings", () => {
    process.env["ORCA_TEST_UNDEF"] = undefined as unknown as string;
    const merged = mergeEnv({ KEEP: "yes" });

    expect(Object.values(merged ?? {}).every((v) => typeof v === "string")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadMcpExtensions — orchestration
//
// connectMcpServer spawns a real subprocess, so the SDK is mocked at the module
// boundary.  The Client mock is controlled per-test via mockClientBehaviour.
// ---------------------------------------------------------------------------

const mockClientBehaviour: {
  connect: () => Promise<void>;
  listTools: () => Promise<{ tools: Array<{ name: string; description?: string }> }>;
} = {
  connect: async () => {},
  listTools: async () => ({ tools: [] }),
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect() {
      return mockClientBehaviour.connect();
    }
    listTools() {
      return mockClientBehaviour.listTools();
    }
    callTool() {
      return Promise.resolve({ content: [] });
    }
    close() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {},
}));

const { loadMcpExtensions } = await import("./index.js");

function config(over: Partial<Parameters<typeof loadMcpExtensions>[0][number]> = {}) {
  return {
    id: "srv",
    name: "Server",
    transport: "stdio" as const,
    command: "noop",
    ...over,
  };
}

describe("loadMcpExtensions", () => {
  const silent = () => {};

  afterEach(() => {
    mockClientBehaviour.connect = async () => {};
    mockClientBehaviour.listTools = async () => ({ tools: [] });
  });

  it("returns empty results without connecting when nothing is enabled", async () => {
    const connect = vi.fn(async () => {});
    mockClientBehaviour.connect = connect;

    const result = await loadMcpExtensions([config({ enabled: false })], silent);

    expect(result).toEqual({ extensions: [], failures: [] });
    expect(connect).not.toHaveBeenCalled();
  });

  it("treats a config with no enabled flag as enabled", async () => {
    const result = await loadMcpExtensions([config()], silent);
    expect(result.extensions).toHaveLength(1);
  });

  it("namespaces tool names with the server id by default", async () => {
    mockClientBehaviour.listTools = async () => ({ tools: [{ name: "read" }] });

    const result = await loadMcpExtensions([config({ id: "fs" })], silent);

    expect(result.extensions[0]?.tools.map((t) => t.name)).toEqual(["fs_read"]);
  });

  it("leaves tool names unprefixed when namespaceTools is false", async () => {
    mockClientBehaviour.listTools = async () => ({ tools: [{ name: "read" }] });

    const result = await loadMcpExtensions(
      [config({ id: "fs", namespaceTools: false })],
      silent,
    );

    expect(result.extensions[0]?.tools.map((t) => t.name)).toEqual(["read"]);
  });

  it("keeps a server that connects but exposes zero tools", async () => {
    const result = await loadMcpExtensions([config()], silent);

    expect(result.failures).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.tools).toEqual([]);
  });

  it("records a failure instead of throwing when connect rejects", async () => {
    mockClientBehaviour.connect = async () => {
      throw new Error("spawn ENOENT");
    };

    const result = await loadMcpExtensions([config({ id: "bad", name: "Bad" })], silent);

    expect(result.extensions).toEqual([]);
    expect(result.failures).toEqual([{ id: "bad", name: "Bad" }]);
  });

  it("records a failure when tool discovery rejects", async () => {
    mockClientBehaviour.listTools = async () => {
      throw new Error("protocol error");
    };

    const result = await loadMcpExtensions([config({ id: "bad", name: "Bad" })], silent);

    expect(result.extensions).toEqual([]);
    expect(result.failures).toEqual([{ id: "bad", name: "Bad" }]);
  });

  it("derives the extension id from the server id", async () => {
    const result = await loadMcpExtensions([config({ id: "github" })], silent);

    // tool-bootstrap matches on this prefix to identify MCP-sourced tools.
    expect(result.extensions[0]?.id).toBe("@clawde/mcp-github");
  });

  it("falls back to the tool name when the server gives no description", async () => {
    mockClientBehaviour.listTools = async () => ({
      tools: [{ name: "read" }, { name: "write", description: "Writes" }],
    });

    const result = await loadMcpExtensions([config({ namespaceTools: false })], silent);
    const [read, write] = result.extensions[0]!.tools;

    expect(read?.description).toBe("read");
    expect(write?.description).toBe("Writes");
  });
});
