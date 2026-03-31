import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { githubExtension } from "./index.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ctx = { workspaceRoot: process.cwd(), runId: "test-run" };

function tool(name: string) {
  const t = githubExtension.tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

// ── Mock fetch ────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    text: () => Promise.resolve(text),
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch([]));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── github_list_prs ───────────────────────────────────────────────────────────

describe("github_list_prs", () => {
  const listPrs = () => tool("github_list_prs");

  it("formats a list of PRs", async () => {
    vi.stubGlobal("fetch", mockFetch([
      { number: 1, title: "Fix bug", state: "open", user: { login: "alice" }, html_url: "https://github.com/a/b/pull/1" },
      { number: 2, title: "Add feature", state: "open", user: { login: "bob" }, html_url: "https://github.com/a/b/pull/2" },
    ]));
    const result = await listPrs().execute({ owner: "a", repo: "b" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Fix bug");
    expect(result.output).toContain("@alice");
    expect(result.output).toContain("#2");
  });

  it("returns message when no PRs exist", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    const result = await listPrs().execute({ owner: "a", repo: "b" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("No");
  });

  it("returns error when owner/repo missing", async () => {
    const result = await listPrs().execute({ owner: "a" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/repo/);
  });

  it("propagates API errors", async () => {
    vi.stubGlobal("fetch", mockFetch("Not Found", 404));
    const result = await listPrs().execute({ owner: "a", repo: "b" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("404");
  });
});

// ── github_get_pr ─────────────────────────────────────────────────────────────

describe("github_get_pr", () => {
  const getPr = () => tool("github_get_pr");

  const prDetail = {
    number: 42,
    title: "My PR",
    state: "open",
    body: "Description here",
    user: { login: "alice" },
    html_url: "https://github.com/a/b/pull/42",
    additions: 10,
    deletions: 3,
    changed_files: 2,
  };

  it("returns PR details and diff", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      const body = callCount === 1 ? JSON.stringify(prDetail) : "diff --git a/file.ts b/file.ts\n+new line";
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => "" }, text: () => Promise.resolve(body) });
    }));

    const result = await getPr().execute({ owner: "a", repo: "b", number: 42 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("PR #42");
    expect(result.output).toContain("My PR");
    expect(result.output).toContain("+10");
    expect(result.output).toContain("Description here");
  });

  it("returns error when number is missing", async () => {
    const result = await getPr().execute({ owner: "a", repo: "b" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/number/);
  });
});

// ── github_list_issues ────────────────────────────────────────────────────────

describe("github_list_issues", () => {
  const listIssues = () => tool("github_list_issues");

  it("lists issues, filtering out PRs", async () => {
    vi.stubGlobal("fetch", mockFetch([
      { number: 10, title: "Bug report", state: "open", user: { login: "alice" }, html_url: "https://github.com/a/b/issues/10", labels: [{ name: "bug" }] },
      { number: 11, title: "PR masquerading", state: "open", user: { login: "bob" }, html_url: "https://github.com/a/b/pull/11", labels: [], pull_request: {} },
    ]));
    const result = await listIssues().execute({ owner: "a", repo: "b" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Bug report");
    expect(result.output).toContain("[bug]");
    expect(result.output).not.toContain("PR masquerading");
  });

  it("returns message when no issues exist", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    const result = await listIssues().execute({ owner: "a", repo: "b" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("No");
  });

  it("returns error when owner/repo missing", async () => {
    const result = await listIssues().execute({ repo: "b" }, ctx);
    expect(result.ok).toBe(false);
  });
});

// ── github_list_repos ─────────────────────────────────────────────────────────

describe("github_list_repos", () => {
  const listRepos = () => tool("github_list_repos");

  it("formats a list of repos", async () => {
    vi.stubGlobal("fetch", mockFetch([
      { full_name: "alice/cool-lib", description: "A cool lib", html_url: "https://github.com/alice/cool-lib", language: "TypeScript", stargazers_count: 42, private: false, fork: false },
      { full_name: "alice/forked",   description: null,          html_url: "https://github.com/alice/forked",   language: null,         stargazers_count: 0,  private: false, fork: true  },
    ]));
    const result = await listRepos().execute({ owner: "alice" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("alice/cool-lib");
    expect(result.output).toContain("TypeScript");
    expect(result.output).toContain("★42");
    expect(result.output).toContain("(fork)");
  });

  it("falls back to /orgs endpoint on 404", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: false, status: 404, headers: { get: () => "" }, text: () => Promise.resolve("404 Not Found") });
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => "" }, text: () => Promise.resolve(JSON.stringify([
        { full_name: "myorg/repo", description: "org repo", html_url: "https://github.com/myorg/repo", language: "Go", stargazers_count: 5, private: false, fork: false },
      ])) });
    }));
    const result = await listRepos().execute({ owner: "myorg" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("myorg/repo");
    expect(callCount).toBe(2);
  });

  it("returns message when no repos found", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    const result = await listRepos().execute({ owner: "alice" }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("No repositories");
  });

  it("returns error when owner missing", async () => {
    const result = await listRepos().execute({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/owner/);
  });

  it("propagates API errors", async () => {
    vi.stubGlobal("fetch", mockFetch("Not Found", 404));
    const result = await listRepos().execute({ owner: "nobody" }, ctx);
    expect(result.ok).toBe(false);
  });
});

// ── Extension metadata ────────────────────────────────────────────────────────

describe("githubExtension", () => {
  it("has correct id and 5 tools", () => {
    expect(githubExtension.id).toBe("@clawde/ext-github");
    expect(githubExtension.tools).toHaveLength(5);
    expect(githubExtension.tools.map((t) => t.name)).toEqual([
      "github_list_prs",
      "github_get_pr",
      "github_list_issues",
      "github_list_repos",
      "github_clone_repo",
    ]);
  });
});
