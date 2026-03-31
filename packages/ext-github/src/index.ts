/**
 * @clawde/ext-github — Orca extension for GitHub integration
 *
 * Tools:
 *   github_list_prs    — list open/closed pull requests in a repository
 *   github_get_pr      — fetch PR details + unified diff
 *   github_list_issues — list open/closed issues in a repository
 *
 * Configuration:
 *   GITHUB_TOKEN env var — required for private repos; optional for public repos
 *   (unauthenticated calls are rate-limited to 60 req/hr per IP)
 *
 * Usage:
 *   import { githubExtension } from "@clawde/ext-github";
 *   const reg = await createExtensionRegistry([githubExtension]);
 */

import type { OrcaExtension, ExtTool, ExtToolRunCtx, ExtToolResult } from "@clawde/orca-core";

const GITHUB_API = "https://api.github.com";

function authHeaders(): Record<string, string> {
  const token = process.env["GITHUB_TOKEN"];
  return token
    ? { Authorization: `Bearer ${token}`, "User-Agent": "orca-bot/1.0" }
    : { "User-Agent": "orca-bot/1.0" };
}

async function ghFetch(path: string, acceptOverride?: string): Promise<{ ok: boolean; body: string }> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    Accept: acceptOverride ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  try {
    const res = await fetch(`${GITHUB_API}${path}`, { headers });
    const body = await res.text();
    if (!res.ok) {
      return { ok: false, body: `GitHub API error ${res.status}: ${body.slice(0, 400)}` };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, body: err instanceof Error ? err.message : String(err) };
  }
}

// ── Tool: github_list_prs ─────────────────────────────────────────────────

const listPrsTool: ExtTool = {
  name: "github_list_prs",
  description: "List pull requests in a GitHub repository.",
  schema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or org name)." },
      repo:  { type: "string", description: "Repository name." },
      state: { type: "string", description: "Filter by state.", enum: ["open", "closed", "all"] },
    },
    required: ["owner", "repo"],
  },

  async execute(
    input: Record<string, unknown>,
    _ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult> {
    const owner = input["owner"];
    const repo  = input["repo"];
    const state = typeof input["state"] === "string" ? input["state"] : "open";
    if (typeof owner !== "string" || typeof repo !== "string") {
      return { ok: false, output: "", error: '"owner" and "repo" are required strings.' };
    }

    const r = await ghFetch(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=20`);
    if (!r.ok) return { ok: false, output: "", error: r.body };

    const prs = JSON.parse(r.body) as Array<{
      number: number; title: string; state: string;
      user: { login: string }; html_url: string; created_at: string;
    }>;

    if (!prs.length) return { ok: true, output: `No ${state} pull requests found in ${owner}/${repo}.` };

    const lines = prs.map((p) =>
      `#${p.number} [${p.state}] "${p.title}" — @${p.user.login} — ${p.html_url}`,
    );
    return { ok: true, output: `Pull requests in ${owner}/${repo} (${state}):\n\n${lines.join("\n")}` };
  },
};

// ── Tool: github_get_pr ───────────────────────────────────────────────────

const getPrTool: ExtTool = {
  name: "github_get_pr",
  description: "Fetch details and the unified diff of a GitHub pull request.",
  schema: {
    type: "object",
    properties: {
      owner:  { type: "string", description: "Repository owner." },
      repo:   { type: "string", description: "Repository name." },
      number: { type: "number", description: "Pull request number." },
    },
    required: ["owner", "repo", "number"],
  },

  async execute(
    input: Record<string, unknown>,
    _ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult> {
    const owner  = input["owner"];
    const repo   = input["repo"];
    const number = input["number"];
    if (typeof owner !== "string" || typeof repo !== "string" || typeof number !== "number") {
      return { ok: false, output: "", error: '"owner", "repo" (strings) and "number" (number) are required.' };
    }

    const [detailsR, diffR] = await Promise.all([
      ghFetch(`/repos/${owner}/${repo}/pulls/${number}`),
      ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, "application/vnd.github.v3.diff"),
    ]);

    if (!detailsR.ok) return { ok: false, output: "", error: detailsR.body };

    const pr = JSON.parse(detailsR.body) as {
      number: number; title: string; state: string;
      body: string | null;
      user: { login: string }; html_url: string;
      additions: number; deletions: number; changed_files: number;
    };

    const diff = diffR.ok ? diffR.body.slice(0, 8_000) : "(diff unavailable)";
    const body = pr.body ? pr.body.slice(0, 2_000) : "(no description)";

    const output = [
      `PR #${pr.number}: ${pr.title} [${pr.state}]`,
      `Author: @${pr.user.login}  URL: ${pr.html_url}`,
      `Changes: +${pr.additions} -${pr.deletions} across ${pr.changed_files} file(s)`,
      "",
      "## Description",
      body,
      "",
      "## Diff (first 8 000 chars)",
      diff,
    ].join("\n");

    return { ok: true, output };
  },
};

// ── Tool: github_list_issues ──────────────────────────────────────────────

const listIssuesTool: ExtTool = {
  name: "github_list_issues",
  description: "List issues in a GitHub repository.",
  schema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner." },
      repo:  { type: "string", description: "Repository name." },
      state: { type: "string", description: "Filter by state.", enum: ["open", "closed", "all"] },
    },
    required: ["owner", "repo"],
  },

  async execute(
    input: Record<string, unknown>,
    _ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult> {
    const owner = input["owner"];
    const repo  = input["repo"];
    const state = typeof input["state"] === "string" ? input["state"] : "open";
    if (typeof owner !== "string" || typeof repo !== "string") {
      return { ok: false, output: "", error: '"owner" and "repo" are required strings.' };
    }

    // GitHub issues endpoint returns both issues AND PRs. Filter out PRs.
    const r = await ghFetch(`/repos/${owner}/${repo}/issues?state=${state}&per_page=20&pulls=false`);
    if (!r.ok) return { ok: false, output: "", error: r.body };

    const all = JSON.parse(r.body) as Array<{
      number: number; title: string; state: string;
      user: { login: string }; html_url: string;
      labels: Array<{ name: string }>;
      pull_request?: unknown;
    }>;

    const issues = all.filter((i) => !i.pull_request);
    if (!issues.length) return { ok: true, output: `No ${state} issues found in ${owner}/${repo}.` };

    const lines = issues.map((i) => {
      const tags = i.labels.map((l) => `[${l.name}]`).join(" ");
      return `#${i.number} [${i.state}] "${i.title}" ${tags} — @${i.user.login} — ${i.html_url}`;
    });
    return { ok: true, output: `Issues in ${owner}/${repo} (${state}):\n\n${lines.join("\n")}` };
  },
};

// ── Tool: github_list_repos ───────────────────────────────────────────────

const listReposTool: ExtTool = {
  name: "github_list_repos",
  description: "List repositories for a GitHub user or organisation.",
  schema: {
    type: "object",
    properties: {
      owner: { type: "string", description: "GitHub username or organisation name." },
      sort:  { type: "string", description: "Sort order.", enum: ["updated", "created", "pushed", "full_name"] },
    },
    required: ["owner"],
  },

  async execute(
    input: Record<string, unknown>,
    _ctx: ExtToolRunCtx,
  ): Promise<ExtToolResult> {
    const owner = input["owner"];
    const sort  = typeof input["sort"] === "string" ? input["sort"] : "updated";
    if (typeof owner !== "string") {
      return { ok: false, output: "", error: '"owner" is a required string.' };
    }

    // Try /users/{owner}/repos first; fall back to /orgs/{owner}/repos for organisations.
    let r = await ghFetch(`/users/${owner}/repos?sort=${sort}&per_page=30`);
    if (!r.ok && r.body.includes("404")) {
      r = await ghFetch(`/orgs/${owner}/repos?sort=${sort}&per_page=30`);
    }
    if (!r.ok) return { ok: false, output: "", error: r.body };

    const repos = JSON.parse(r.body) as Array<{
      full_name: string; description: string | null;
      html_url: string; language: string | null;
      stargazers_count: number; private: boolean; fork: boolean;
    }>;

    if (!repos.length) return { ok: true, output: `No repositories found for ${owner}.` };

    const lines = repos.map((repo) => {
      const lang    = repo.language   ? ` [${repo.language}]` : "";
      const stars   = repo.stargazers_count > 0 ? ` ★${repo.stargazers_count}` : "";
      const privacy = repo.private    ? " (private)" : "";
      const fork    = repo.fork       ? " (fork)" : "";
      const desc    = repo.description ? ` — ${repo.description}` : "";
      return `${repo.full_name}${lang}${stars}${privacy}${fork}${desc} — ${repo.html_url}`;
    });
    return { ok: true, output: `Repositories for ${owner}:\n\n${lines.join("\n")}` };
  },
};

// ── Extension export ──────────────────────────────────────────────────────

export const githubExtension: OrcaExtension = {
  id:      "@clawde/ext-github",
  name:    "GitHub",
  version: "0.1.0",
  tools:   [listPrsTool, getPrTool, listIssuesTool, listReposTool],

  async onLoad() {
    if (!process.env["GITHUB_TOKEN"]) {
      console.warn(
        "[ext-github] GITHUB_TOKEN not set. " +
        "Public API calls are limited to 60 req/hr. " +
        "Set GITHUB_TOKEN for higher limits and private repo access.",
      );
    }
  },
};

export default githubExtension;
