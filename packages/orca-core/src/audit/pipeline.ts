import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type {
  AuditCommandDecision,
  AuditCommandPolicy,
  AuditCommandResult,
  AuditFailure,
  AuditMarker,
  AuditPathKind,
  AuditPreflight,
  AuditProbeName,
  AuditProbeResult,
  ProjectAuditInput,
  ProjectAuditResult,
  ProjectCategory,
  ProjectClassification,
  ReadinessScore,
} from "./types.js";
import type { OrcaTaskSpec } from "../types.js";

const MARKER_PATHS: Array<{ name: string; path: string; kind: "file" | "directory" }> = [
  { name: "package.json", path: "package.json", kind: "file" },
  { name: "pnpm-lock.yaml", path: "pnpm-lock.yaml", kind: "file" },
  { name: "package-lock.json", path: "package-lock.json", kind: "file" },
  { name: "yarn.lock", path: "yarn.lock", kind: "file" },
  { name: "pnpm-workspace.yaml", path: "pnpm-workspace.yaml", kind: "file" },
  { name: "tsconfig.json", path: "tsconfig.json", kind: "file" },
  { name: "src/", path: "src", kind: "directory" },
  { name: "app/", path: "app", kind: "directory" },
  { name: "public/", path: "public", kind: "directory" },
  { name: ".env.example", path: ".env.example", kind: "file" },
  { name: ".env", path: ".env", kind: "file" },
  { name: ".github/workflows/", path: ".github/workflows", kind: "directory" },
  { name: "tests/", path: "tests", kind: "directory" },
  { name: "__tests__/", path: "__tests__", kind: "directory" },
  { name: "e2e/", path: "e2e", kind: "directory" },
  { name: "pyproject.toml", path: "pyproject.toml", kind: "file" },
  { name: "requirements.txt", path: "requirements.txt", kind: "file" },
  { name: "Cargo.toml", path: "Cargo.toml", kind: "file" },
  { name: "go.mod", path: "go.mod", kind: "file" },
  { name: "Dockerfile", path: "Dockerfile", kind: "file" },
  { name: "docker-compose.yml", path: "docker-compose.yml", kind: "file" },
  { name: "electron-builder.yml", path: "electron-builder.yml", kind: "file" },
  { name: "electron-builder.json", path: "electron-builder.json", kind: "file" },
];

const CONFIG_PREFIXES = ["vite.config.", "webpack.config."];
const IGNORED_TREE_DIRS = new Set([".git", "node_modules", "dist", "build", "release", "coverage", ".next", ".turbo"]);
const CHILD_REPO_MARKERS = [".git", "package.json", "pnpm-workspace.yaml", "pyproject.toml", "Cargo.toml", "go.mod"];
const SOURCE_ROOTS = ["src", "app", "frontend", "backend", "lib", "server", "client"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".cs", ".css"]);
const MAX_SOURCE_FILES = 120;
const MAX_SOURCE_READS = 45;

const APPROVED_RECIPES: Partial<Record<ProjectCategory, string[]>> = {
  node_app: ["npm run build", "npm test", "npm run lint"],
  electron_app: ["npm run build", "npm test", "npm run lint"],
  react_app: ["npm run build", "npm test", "npm run lint"],
  vite_app: ["npm run build", "npm test", "npm run lint"],
  monorepo: ["npm run build", "npm test", "npm run lint"],
  python_app: ["pytest", "python -m build"],
  rust_app: ["cargo test", "cargo build"],
  go_app: ["go test ./...", "go build ./..."],
  static_site: [],
};

export function isProjectAuditTask(taskSpec: OrcaTaskSpec): boolean {
  if (asksForRuntimeVerification(taskSpec)) return false;

  if (taskSpec.mode === "project_audit") return true;

  const text = [taskSpec.originalUserMessage, taskSpec.intent, ...(taskSpec.goals ?? [])].join(" ");
  const asksForAudit =
    /\b(check|review|audit|inspect|assess|evaluate)\b.{0,80}\b(app|repo|repository|project|codebase|code base)\b/i.test(text) ||
    /\b(app|repo|repository|project|codebase|code base)\b.{0,80}\b(check|review|audit|inspect|assess|evaluate)\b/i.test(text) ||
    /\b(production|prod|ship|release)\s+read(?:y|iness)\b/i.test(text) ||
    /\bready\s+for\s+(production|prod|release|ship|shipping)\b/i.test(text);

  return asksForAudit && !!extractAuditTargetPath(taskSpec, undefined);
}

function asksForRuntimeVerification(taskSpec: OrcaTaskSpec): boolean {
  const text = [taskSpec.originalUserMessage, taskSpec.intent, ...(taskSpec.goals ?? [])].join(" ");
  return (
    /\b(?:actually\s+)?run\b.{0,120}\b(?:commands?|tests?|build|lint|verification|contract:check)\b/i.test(text) ||
    /\bdo\s+not\s+do\s+a\s+read[-\s]?only\s+(?:project\s+)?audit\b/i.test(text) ||
    /\b(?:pnpm|npm|yarn|bun|cargo|go|pytest|python)\s+(?:run\s+)?[\w:.-]+/i.test(text)
  );
}

function cleanPathCandidate(value: string): string {
  return value.trim().replace(/[\s.,;'"`)\]}]+$/g, "");
}

function existingPathPrefix(candidate: string): string | undefined {
  const cleaned = cleanPathCandidate(candidate);
  const boundaries = new Set<number>([cleaned.length]);

  for (let index = 0; index < cleaned.length; index += 1) {
    const character = cleaned[index];
    if (character && /\s/.test(character)) boundaries.add(index);
  }

  for (const boundary of [...boundaries].sort((a, b) => b - a)) {
    const prefix = cleanPathCandidate(cleaned.slice(0, boundary));
    if (!prefix) continue;
    if (existsSync(resolve(prefix))) return prefix;
  }

  return undefined;
}

function firstPathToken(candidate: string): string | undefined {
  return cleanPathCandidate(candidate).match(/^\S+/)?.[0];
}

function extractUnquotedPathCandidate(rawCandidate: string): string | undefined {
  const cleaned = cleanPathCandidate(rawCandidate);
  return existingPathPrefix(cleaned) ?? firstPathToken(cleaned);
}

export function extractAuditTargetPath(taskSpec: OrcaTaskSpec, workspaceRoot?: string): string | undefined {
  const contextPath = taskSpec.context?.["auditPath"] ?? taskSpec.context?.["workspaceRoot"];
  if (typeof contextPath === "string" && contextPath.trim()) {
    return contextPath.trim();
  }

  const text = [taskSpec.originalUserMessage, taskSpec.intent, ...(taskSpec.goals ?? [])].join("\n");
  for (const line of text.split(/\r?\n/)) {
    const quotedMatch = line.match(/["'`]((?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]+)["'`]/);
    if (quotedMatch?.[1]) return cleanPathCandidate(quotedMatch[1]);

    const windowsMatch = line.match(/\b[A-Za-z]:[\\/][^\r\n]+/);
    if (windowsMatch?.[0]) return extractUnquotedPathCandidate(windowsMatch[0]);

    const posixMatch = line.match(/(?:^|\s)(\/[^\r\n]+)/);
    if (posixMatch?.[1]) return extractUnquotedPathCandidate(posixMatch[1]);
  }

  return workspaceRoot;
}

function failure(category: AuditFailure["category"], summary: string, suggestedNextAction: string, retryable = false, detail?: string): AuditFailure {
  return { category, retryable, summary, suggestedNextAction, ...(detail ? { detail } : {}) };
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function pathKind(path: string): AuditPathKind {
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function markerExists(root: string, marker: { path: string; kind: "file" | "directory" }): boolean {
  const fullPath = join(root, marker.path);
  if (!existsSync(fullPath)) return false;
  const stat = lstatSync(fullPath);
  return marker.kind === "directory" ? stat.isDirectory() : stat.isFile();
}

function detectMarkers(root: string): AuditMarker[] {
  const markers = MARKER_PATHS
    .filter((marker) => markerExists(root, marker))
    .map((marker) => ({ name: marker.name, path: marker.path, kind: marker.kind }));

  for (const entry of safeReadDir(root)) {
    if (/^README(?:\..+)?$/i.test(entry)) {
      markers.push({ name: "README*", path: entry, kind: "file" });
    }
    if (CONFIG_PREFIXES.some((prefix) => entry.startsWith(prefix))) {
      markers.push({ name: entry.startsWith("vite.") ? "vite.config.*" : "webpack.config.*", path: entry, kind: "file" });
    }
  }

  return markers;
}

function markerPaths(markers: AuditMarker[]): Set<string> {
  return new Set(markers.map((marker) => marker.path.replace(/\\/g, "/")));
}

function inspectPreflight(targetPath: string): AuditPreflight {
  const resolved = resolve(targetPath);
  const exists = existsSync(resolved);
  const kind = pathKind(resolved);
  const readable = exists && isReadable(resolved);
  const failures: AuditFailure[] = [];

  if (!exists) {
    failures.push(failure("missing_path", `Path does not exist: ${resolved}`, "Check the path and rerun the audit with an existing local project path."));
  } else if (!readable) {
    failures.push(failure("unreadable_path", `Path is not readable: ${resolved}`, "Grant read access or choose a readable project path.", true));
  } else if (kind !== "directory") {
    failures.push(failure("bad_workdir", `Audit target is a ${kind}, not a directory.`, "Point the audit at the project directory rather than a single file."));
  }

  const markers = exists && readable && kind === "directory" ? detectMarkers(resolved) : [];
  const isRepo = exists && readable && kind === "directory" && existsSync(join(resolved, ".git"));

  return {
    targetPath: resolved,
    exists,
    readable,
    kind,
    isRepo,
    markers,
    failures,
  };
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function safeReadText(path: string, maxChars = 30_000): string | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1_500_000) return undefined;
    const text = readFileSync(path, "utf8");
    if (text.includes("\0")) return undefined;
    return text.slice(0, maxChars);
  } catch {
    return undefined;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function envKeys(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
    .filter((key): key is string => typeof key === "string");
}

function workflowFiles(root: string): string[] {
  const dir = join(root, ".github", "workflows");
  return safeReadDir(dir)
    .filter((entry) => /\.(ya?ml)$/i.test(entry))
    .map((entry) => `.github/workflows/${entry}`);
}

function packageJson(root: string): Record<string, unknown> | undefined {
  return readJsonFile(join(root, "package.json"));
}

function dependencyNames(pkg: Record<string, unknown> | undefined): Set<string> {
  const deps = new Set<string>();
  for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const value = pkg?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const dep of Object.keys(value)) deps.add(dep);
    }
  }
  return deps;
}

function hasWorkspaceConfig(pkg: Record<string, unknown> | undefined): boolean {
  const workspaces = pkg?.["workspaces"];
  return Array.isArray(workspaces) || (workspaces !== undefined && workspaces !== null && typeof workspaces === "object");
}

function classifyProject(preflight: AuditPreflight): ProjectClassification {
  if (!preflight.exists || !preflight.readable || preflight.kind !== "directory") {
    return { primary: "unknown", categories: ["unknown"], confidence: 0, evidence: [] };
  }

  const markers = markerPaths(preflight.markers);
  const pkg = packageJson(preflight.targetPath);
  const deps = dependencyNames(pkg);
  const categories = new Set<ProjectCategory>();
  const evidence: string[] = [];

  if (markers.has("package.json")) {
    categories.add("node_app");
    evidence.push("package.json present");
  }
  if (markers.has("pnpm-workspace.yaml") || hasWorkspaceConfig(pkg)) {
    categories.add("monorepo");
    evidence.push(markers.has("pnpm-workspace.yaml") ? "pnpm-workspace.yaml present" : "package.json workspaces present");
  }
  if (deps.has("electron") || deps.has("electron-builder") || markers.has("electron-builder.yml") || markers.has("electron-builder.json")) {
    categories.add("electron_app");
    evidence.push("electron/electron-builder signal present");
  }
  if (deps.has("react") || markers.has("app") || markers.has("src")) {
    if (deps.has("react")) {
      categories.add("react_app");
      evidence.push("react dependency present");
    }
  }
  if ([...markers].some((path) => basename(path).startsWith("vite.config.")) || deps.has("vite")) {
    categories.add("vite_app");
    evidence.push("vite config or dependency present");
  }
  if (markers.has("pyproject.toml") || markers.has("requirements.txt")) {
    categories.add("python_app");
    evidence.push("Python project marker present");
  }
  if (markers.has("Cargo.toml")) {
    categories.add("rust_app");
    evidence.push("Cargo.toml present");
  }
  if (markers.has("go.mod")) {
    categories.add("go_app");
    evidence.push("go.mod present");
  }
  if (!markers.has("package.json") && markers.has("public")) {
    categories.add("static_site");
    evidence.push("public/ present without package.json");
  }

  if (categories.size === 0) {
    return { primary: "unknown", categories: ["unknown"], confidence: 0.1, evidence: ["No known stack markers found"] };
  }

  const ordered: ProjectCategory[] = ["electron_app", "vite_app", "react_app", "node_app", "monorepo", "python_app", "rust_app", "go_app", "static_site"];
  const primary = ordered.find((category) => categories.has(category)) ?? "unknown";
  const list = [...categories];
  const confidence = Math.min(0.95, 0.35 + evidence.length * 0.12);
  return { primary, categories: list, confidence, evidence };
}

function listTree(root: string, maxDepth = 2, maxEntries = 80): string[] {
  const output: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (output.length >= maxEntries || depth > maxDepth) return;
    const entries = safeReadDir(dir).sort((a, b) => a.localeCompare(b));
    for (const entry of entries) {
      if (output.length >= maxEntries) return;
      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      const rel = fullPath.slice(root.length + 1).replace(/\\/g, "/");
      if (stat.isDirectory()) {
        if (IGNORED_TREE_DIRS.has(entry)) continue;
        output.push(`${rel}/`);
        walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        output.push(rel);
      }
    }
  };

  walk(root, 0);
  return output;
}

function collectSourceFiles(root: string): string[] {
  const files: string[] = [];
  const roots = SOURCE_ROOTS.filter((dir) => {
    const fullPath = join(root, dir);
    try {
      return lstatSync(fullPath).isDirectory();
    } catch {
      return false;
    }
  });
  const startDirs = roots.length > 0 ? roots : ["."];

  const walk = (dir: string, depth: number): void => {
    if (files.length >= MAX_SOURCE_FILES || depth > 5) return;
    for (const entry of safeReadDir(join(root, dir)).sort((a, b) => a.localeCompare(b))) {
      if (files.length >= MAX_SOURCE_FILES) return;
      if (IGNORED_TREE_DIRS.has(entry)) continue;
      const rel = dir === "." ? entry : `${dir}/${entry}`;
      const fullPath = join(root, rel);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(rel, depth + 1);
      } else if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) {
        files.push(rel.replace(/\\/g, "/"));
      }
    }
  };

  for (const dir of startDirs) walk(dir, 0);
  return unique(files);
}

interface SourceInspection {
  files: string[];
  inspected: number;
  testFiles: string[];
  loggingSignals: string[];
  errorHandlingSignals: string[];
}

function inspectSourceSample(root: string): SourceInspection {
  const files = collectSourceFiles(root);
  const testFiles = files.filter((file) => /(^|\/)(__tests__|tests?|e2e)(\/|$)|\.(test|spec|e2e)\./i.test(file));
  const loggingSignals: string[] = [];
  const errorHandlingSignals: string[] = [];

  for (const file of files.slice(0, MAX_SOURCE_READS)) {
    const text = safeReadText(join(root, file), 40_000);
    if (!text) continue;
    if (/\b(console\.(warn|error)|logger\.|createLogger|pino\(|winston|debug\(|Sentry\.)/i.test(text)) {
      loggingSignals.push(`logging signal in ${file}`);
    }
    if (/\b(try\s*\{|catch\s*\(|throw\s+new|console\.error|process\.on\(["'](?:uncaughtException|unhandledRejection)|window\.onerror|addEventListener\(["']error)/i.test(text)) {
      errorHandlingSignals.push(`error-handling signal in ${file}`);
    }
  }

  return {
    files,
    inspected: Math.min(files.length, MAX_SOURCE_READS),
    testFiles: testFiles.slice(0, 8),
    loggingSignals: unique(loggingSignals).slice(0, 8),
    errorHandlingSignals: unique(errorHandlingSignals).slice(0, 8),
  };
}

function scriptsFromPackage(pkg: Record<string, unknown> | undefined): Record<string, string> {
  const scripts = pkg?.["scripts"];
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
  return Object.fromEntries(
    Object.entries(scripts as Record<string, unknown>)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => [key, value as string]),
  );
}

function probe(name: AuditProbeName, status: AuditProbeResult["status"], evidence: string[] = [], missing: string[] = [], data?: Record<string, unknown>): AuditProbeResult {
  return { name, status, evidence, missing, ...(data ? { data } : {}) };
}

function runProbes(preflight: AuditPreflight, classification: ProjectClassification): AuditProbeResult[] {
  if (!preflight.exists || !preflight.readable || preflight.kind !== "directory") return [];

  const root = preflight.targetPath;
  const markers = markerPaths(preflight.markers);
  const pkg = packageJson(root);
  const scripts = scriptsFromPackage(pkg);
  const deps = dependencyNames(pkg);
  const tree = listTree(root);
  const sourceInspection = inspectSourceSample(root);
  const probes: AuditProbeResult[] = [];

  probes.push(probe("inspect_directory_tree", tree.length > 0 ? "pass" : "missing", [`Directory inventory collected (${tree.length} entries, ignored generated folders)`], tree.length === 0 ? ["No readable directory entries"] : [], { entries: tree }));

  const keyFiles = preflight.markers.filter((marker) => marker.kind === "file").map((marker) => marker.path);
  const scriptNames = Object.keys(scripts);
  const readmePath = keyFiles.find((path) => /^README(?:\..+)?$/i.test(path));
  const readmeText = readmePath ? safeReadText(join(root, readmePath), 20_000) : undefined;
  const workflowNames = workflowFiles(root);
  const envExampleKeys = envKeys(safeReadText(join(root, ".env.example"), 20_000));
  const envKeysPresent = envKeys(safeReadText(join(root, ".env"), 20_000));
  const keyFileEvidence = [
    ...(pkg ? [`package.json read: ${scriptNames.length} script(s), ${deps.size} dependency name(s)`] : []),
    ...(scriptNames.length > 0 ? [`package scripts: ${scriptNames.slice(0, 8).join(", ")}`] : []),
    ...(readmeText ? [`${readmePath} read: ${readmeText.split(/\r?\n/).filter((line) => line.trim().length > 0).length} non-empty line(s)`] : []),
    ...(workflowNames.length > 0 ? [`workflow files read: ${workflowNames.slice(0, 6).join(", ")}`] : []),
    ...(envExampleKeys.length > 0 ? [`.env.example read: ${envExampleKeys.length} key(s) documented`] : []),
    ...(envKeysPresent.length > 0 ? [`.env read: ${envKeysPresent.length} key name(s) present; values not displayed`] : []),
  ];
  probes.push(probe("read_key_files", keyFileEvidence.length > 0 ? "pass" : "missing", keyFileEvidence, keyFileEvidence.length === 0 ? ["No key marker files could be read"] : [], { keyFiles }));

  const packageManager =
    markers.has("pnpm-lock.yaml") ? "pnpm" :
    markers.has("package-lock.json") ? "npm" :
    markers.has("yarn.lock") ? "yarn" :
    markers.has("package.json") ? "npm_or_compatible" :
    undefined;
  probes.push(probe("detect_package_manager", packageManager ? "pass" : "not_applicable", packageManager ? [`${packageManager} marker detected`] : [], packageManager ? [] : ["No Node package manager lockfile found"], { packageManager }));

  probes.push(probe("detect_scripts", scriptNames.length > 0 ? "pass" : markers.has("package.json") ? "missing" : "not_applicable", scriptNames.map((name) => `script:${name}`), markers.has("package.json") && scriptNames.length === 0 ? ["package.json has no scripts"] : [], { scripts }));

  const hasTests = scriptNames.some((name) => /test/i.test(name)) || markers.has("tests") || markers.has("__tests__") || markers.has("e2e") || sourceInspection.testFiles.length > 0;
  probes.push(probe("detect_test_setup", hasTests ? "pass" : "missing", [
    ...(scriptNames.some((name) => /test/i.test(name)) ? ["Test script detected in package.json"] : []),
    ...(sourceInspection.testFiles.length > 0 ? [`test file sample: ${sourceInspection.testFiles.slice(0, 4).join(", ")}`] : []),
    ...((markers.has("tests") || markers.has("__tests__") || markers.has("e2e")) ? ["Test directory marker detected"] : []),
  ], hasTests ? [] : ["No test script, test directory, or test file sample detected"]));

  const hasBuild = scriptNames.some((name) => /build|compile/i.test(name)) || markers.has("tsconfig.json") || classification.categories.includes("rust_app") || classification.categories.includes("go_app");
  probes.push(probe("detect_build_setup", hasBuild ? "pass" : "missing", [
    ...(scriptNames.filter((name) => /build|compile/i.test(name)).map((name) => `build script:${name}`)),
    ...(markers.has("tsconfig.json") ? ["tsconfig.json present"] : []),
    ...((classification.categories.includes("rust_app") || classification.categories.includes("go_app")) ? ["compiled-language project marker detected"] : []),
  ], hasBuild ? [] : ["No build script or compiler config detected"]));

  const hasRelease = workflowNames.length > 0 || markers.has("Dockerfile") || markers.has("docker-compose.yml") || scriptNames.some((name) => /dist|release|pack|package/i.test(name));
  probes.push(probe("detect_release_setup", hasRelease ? "pass" : "missing", [
    ...(workflowNames.length > 0 ? [`workflow signal: ${workflowNames.slice(0, 4).join(", ")}`] : []),
    ...(markers.has("Dockerfile") ? ["Dockerfile present"] : []),
    ...(markers.has("docker-compose.yml") ? ["docker-compose.yml present"] : []),
    ...(scriptNames.filter((name) => /dist|release|pack|package/i.test(name)).map((name) => `release script:${name}`)),
  ], hasRelease ? [] : ["No release, packaging, Docker, or workflow signal detected"]));

  probes.push(probe("detect_ci_setup", workflowNames.length > 0 ? "pass" : "missing", workflowNames.length > 0 ? [`GitHub Actions workflows present: ${workflowNames.slice(0, 4).join(", ")}`] : [], workflowNames.length > 0 ? [] : ["No GitHub Actions workflows detected"]));

  const envExample = markers.has(".env.example");
  const envPresent = markers.has(".env");
  probes.push(probe("detect_env_hygiene", envExample && !envPresent ? "pass" : envExample ? "partial" : "missing", [
    ...(envExample ? [".env.example present"] : []),
    ...(envPresent ? [".env file present"] : []),
  ], [
    ...(!envExample ? ["No .env.example detected"] : []),
    ...(envPresent ? [".env exists and should be checked for secrets"] : []),
  ]));

  const docs = preflight.markers.filter((marker) => marker.name === "README*");
  probes.push(probe("detect_docs_presence", docs.length > 0 ? "pass" : "missing", docs.map((marker) => `${marker.path} present`), docs.length === 0 ? ["No README detected"] : []));

  const packagingEvidence = [
    ...(markers.has("Dockerfile") ? ["Dockerfile present"] : []),
    ...(markers.has("electron-builder.yml") || markers.has("electron-builder.json") || deps.has("electron-builder") ? ["electron-builder signal present"] : []),
    ...(scriptNames.filter((name) => /dist|pack|package|release/i.test(name)).map((name) => `script:${name}`)),
  ];
  probes.push(probe("detect_packaging_signals", packagingEvidence.length > 0 ? "pass" : "missing", packagingEvidence, packagingEvidence.length === 0 ? ["No packaging signal detected"] : []));

  probes.push(probe("inspect_source_sample", sourceInspection.files.length > 0 ? "pass" : "missing", sourceInspection.files.length > 0 ? [
    `Source sample inspected: ${sourceInspection.inspected} of ${sourceInspection.files.length} source-like file(s)`,
  ] : [], sourceInspection.files.length === 0 ? ["No source files found in common source directories"] : [], {
    totalSourceFiles: sourceInspection.files.length,
    inspectedSourceFiles: sourceInspection.inspected,
    sample: sourceInspection.files.slice(0, 20),
  }));

  const loggingEvidence = [
    ...[...deps].filter((dep) => /log|sentry|winston|pino|bunyan|debug/i.test(dep)).map((dep) => `dependency:${dep}`),
    ...sourceInspection.loggingSignals,
    ...sourceInspection.errorHandlingSignals,
  ];
  probes.push(probe("detect_logging_or_error_handling_signals", loggingEvidence.length > 0 ? "partial" : "missing", loggingEvidence, loggingEvidence.length === 0 ? ["No obvious logging or error-handling signal detected"] : []));

  return probes;
}

function probeStatus(probes: AuditProbeResult[], name: AuditProbeName): AuditProbeResult["status"] {
  return probes.find((probeResult) => probeResult.name === name)?.status ?? "missing";
}

function scoreFromStatus(status: AuditProbeResult["status"], full: number, partial = Math.round(full / 2)): number {
  if (status === "pass") return full;
  if (status === "partial") return partial;
  return 0;
}

function scoreReadiness(preflight: AuditPreflight, classification: ProjectClassification, probes: AuditProbeResult[], failures: AuditFailure[], commandPolicy: AuditCommandPolicy): ReadinessScore {
  if (!preflight.exists || !preflight.readable || preflight.kind !== "directory") {
    return {
      readiness: "insufficient_evidence",
      confidence: 0.15,
      totalScore: 0,
      categories: {},
      supportingEvidence: [],
      missingEvidence: failures.map((item) => item.summary),
      riskFlags: failures.map((item) => item.category),
    };
  }

  const categories = {
    structure: preflight.markers.length > 0 ? 10 : 0,
    buildability: scoreFromStatus(probeStatus(probes, "detect_build_setup"), 15),
    testEvidence: scoreFromStatus(probeStatus(probes, "detect_test_setup"), 15),
    packagingRelease: scoreFromStatus(probeStatus(probes, "detect_release_setup"), 15),
    cicd: scoreFromStatus(probeStatus(probes, "detect_ci_setup"), 10),
    docsMaintainability: scoreFromStatus(probeStatus(probes, "detect_docs_presence"), 10),
    configHygiene: scoreFromStatus(probeStatus(probes, "detect_env_hygiene"), 10),
    securityConfigRisk: probeStatus(probes, "detect_env_hygiene") === "pass" ? 5 : 2,
    observability: scoreFromStatus(probeStatus(probes, "detect_logging_or_error_handling_signals"), 10, 5),
  };
  const totalScore = Object.values(categories).reduce((sum, value) => sum + value, 0);
  const runtimeUnverified = commandPolicy.decisions.some((decision) => decision.status === "allowed_not_run");
  const runtimeFailed = commandPolicy.decisions.some((decision) => decision.status === "failed" || decision.status === "timed_out");
  const runtimePassed = commandPolicy.decisions.filter((decision) => decision.status === "passed").length;
  const supportingEvidence = unique([
    ...classification.evidence,
    ...probes
      .filter((item) => item.name !== "inspect_directory_tree")
      .flatMap((item) => item.evidence),
  ]).slice(0, 20);
  const missingEvidence = unique([
    ...probes.flatMap((item) => item.missing),
    ...(runtimeUnverified ? ["Runtime build/test/lint commands were not run in this read-first audit"] : []),
    ...(runtimeFailed ? [`${commandPolicy.decisions.filter((d) => d.status === "failed" || d.status === "timed_out").length} runtime command(s) failed`] : []),
  ]).slice(0, 20);
  const riskFlags = [
    ...(classification.primary === "unknown" ? ["unsupported_stack"] : []),
    ...(probeStatus(probes, "detect_test_setup") === "missing" ? ["no_test_evidence"] : []),
    ...(probeStatus(probes, "detect_build_setup") === "missing" ? ["no_build_evidence"] : []),
    ...(probeStatus(probes, "detect_ci_setup") === "missing" ? ["no_ci_evidence"] : []),
    ...(probeStatus(probes, "detect_env_hygiene") !== "pass" ? ["config_hygiene_incomplete"] : []),
    ...(runtimeUnverified ? ["runtime_not_verified"] : []),
    ...(runtimeFailed ? ["runtime_command_failed"] : []),
  ];

  let readiness: ReadinessScore["readiness"];
  if (classification.primary === "unknown" && totalScore < 35) readiness = "insufficient_evidence";
  else if (totalScore >= 85 && riskFlags.length === 0) readiness = "ready";
  else if (totalScore >= 70) readiness = "mostly_ready";
  else if (totalScore >= 45) readiness = "prototype";
  else readiness = "not_production_ready";

  const meaningfulPasses = probes.filter((item) => item.name !== "inspect_directory_tree" && item.status === "pass").length;
  const partials = probes.filter((item) => item.status === "partial").length;
  const sourceWasInspected = probeStatus(probes, "inspect_source_sample") === "pass";
  let confidence = 0.18 + classification.confidence * 0.28 + meaningfulPasses * 0.045 + partials * 0.025 - failures.length * 0.08 - riskFlags.length * 0.03;
  // Bonus for passing runtime commands.
  confidence += runtimePassed * 0.04;
  if (runtimeUnverified) confidence = Math.min(confidence, 0.74);
  if (runtimeFailed) confidence = Math.min(confidence, 0.68);
  if (!sourceWasInspected) confidence = Math.min(confidence, 0.58);
  if (probeStatus(probes, "detect_env_hygiene") !== "pass") confidence = Math.min(confidence, 0.72);
  confidence = Math.max(0.1, Math.min(0.95, confidence));

  return {
    readiness,
    confidence: Number(confidence.toFixed(2)),
    totalScore,
    categories,
    supportingEvidence,
    missingEvidence,
    riskFlags,
  };
}

function buildCommandPolicy(preflight: AuditPreflight, classification: ProjectClassification): AuditCommandPolicy {
  if (!preflight.exists || !preflight.readable || preflight.kind !== "directory") {
    return {
      shellAllowed: false,
      approvedRecipes: [],
      decisions: [{
        command: "shell",
        status: "blocked",
        reason: "Preflight failed before command gating.",
        failure: failure("bad_workdir", "Cannot run audit commands without a valid readable project directory.", "Fix the project path and rerun the audit."),
      }],
    };
  }

  if (classification.primary === "unknown") {
    return {
      shellAllowed: false,
      approvedRecipes: [],
      decisions: [{
        command: "shell",
        status: "blocked",
        reason: "Project stack is unknown, so no command recipe can be selected safely.",
        failure: failure("unsupported_stack", "Stack classification is unknown.", "Add recognizable project markers or provide the stack explicitly."),
      }],
    };
  }

  const markers = markerPaths(preflight.markers);
  const packageManager = markers.has("pnpm-lock.yaml") ? "pnpm" :
                         markers.has("yarn.lock") ? "yarn" : "npm";

  const rawRecipes = [...new Set([
    ...(APPROVED_RECIPES[classification.primary] ?? []),
    ...classification.categories.flatMap((category) => APPROVED_RECIPES[category] ?? []),
  ])];

  const recipes = rawRecipes.map((recipe) => {
    if (recipe.startsWith("npm ") && packageManager !== "npm") {
      return recipe.replace(/^npm /, `${packageManager} `);
    }
    return recipe;
  });

  const decisions: AuditCommandDecision[] = recipes.length > 0
    ? recipes.map((command) => ({
        command,
        status: "allowed_not_run",
        reason: "Approved recipe after preflight and classification; audit mode is read-first, so this command was not run in this pass.",
      }))
    : [{
        command: "shell",
        status: "not_applicable",
        reason: "No shell recipe is needed for this project category.",
      }];

  return {
    shellAllowed: recipes.length > 0,
    approvedRecipes: recipes,
    decisions,
  };
}

/**
 * Scan the immediate children of `root` for directories that look like a
 * project repository (have a .git folder or a key root-level marker file).
 * Only goes one level deep — no recursive walk — so it's cheap and safe.
 */
function findChildRepos(root: string): string[] {
  return safeReadDir(root)
    .map((entry) => join(root, entry))
    .filter((child) => {
      try {
        if (!lstatSync(child).isDirectory()) return false;
      } catch {
        return false;
      }
      return CHILD_REPO_MARKERS.some((marker) => existsSync(join(child, marker)));
    });
}

function collectFailures(preflight: AuditPreflight, classification: ProjectClassification, probes: AuditProbeResult[], commandPolicy: AuditCommandPolicy): AuditFailure[] {
  const failures = [...preflight.failures];
  if (preflight.exists && preflight.readable && preflight.kind === "directory" && preflight.markers.length === 0) {
    const childRepos = findChildRepos(preflight.targetPath);
    const suggestedNextAction =
      childRepos.length === 1
        ? `Possible repo found at ${childRepos[0]}. Try auditing that path instead.`
        : childRepos.length > 1
          ? `Possible repos found one level down: ${childRepos.slice(0, 3).join(", ")}. Try auditing one of those paths instead.`
          : "Confirm this is the project root or provide a more specific path.";
    failures.push(failure("no_relevant_files", "No common project marker files or folders were found.", suggestedNextAction));
  }
  if (classification.primary === "unknown") {
    failures.push(failure("unsupported_stack", "Project stack could not be classified from marker files.", "Provide stack details or add recognizable project files."));
  }
  if (probes.length > 0 && probes.every((item) => item.status === "missing" || item.status === "not_applicable")) {
    failures.push(failure("insufficient_evidence", "Audit probes did not find enough evidence to assess readiness.", "Add project metadata, docs, test/build scripts, or CI config."));
  }
  for (const decision of commandPolicy.decisions) {
    if (decision.failure) failures.push(decision.failure);
  }
  return failures;
}

export function runProjectAudit(input: ProjectAuditInput): ProjectAuditResult {
  const targetPath = extractAuditTargetPath(input.taskSpec, input.workspaceRoot) ?? process.cwd();
  const preflight = inspectPreflight(targetPath);
  const classification = classifyProject(preflight);
  const probes = runProbes(preflight, classification);
  const commandPolicy = buildCommandPolicy(preflight, classification);
  const failures = collectFailures(preflight, classification, probes, commandPolicy);
  const readiness = scoreReadiness(preflight, classification, probes, failures, commandPolicy);

  return {
    mode: "project_audit",
    task: input.taskSpec.originalUserMessage,
    preflight,
    classification,
    probes,
    commandPolicy,
    readiness,
    failures,
    runtimeVerified: false,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Runtime command execution
// ---------------------------------------------------------------------------

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 4096;

function truncateOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + `\n[truncated after ${MAX_OUTPUT_BYTES} chars]`;
}

function runSingleCommand(command: string, cwd: string, abortSignal?: AbortSignal): Promise<AuditCommandResult> {
  return new Promise<AuditCommandResult>((resolveResult) => {
    const start = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;

    const child = spawn(command, [], {
      cwd,
      env: { ...process.env },
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);

    // Abort support
    const onAbort = (): void => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolveResult({
        exitCode: -1,
        stdout: truncateOutput(Buffer.concat(stdoutChunks).toString("utf8")),
        stderr: truncateOutput(Buffer.concat(stderrChunks).toString("utf8")),
        durationMs: Date.now() - start,
        error: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      const stdout = truncateOutput(Buffer.concat(stdoutChunks).toString("utf8"));
      const stderr = truncateOutput(Buffer.concat(stderrChunks).toString("utf8"));
      const exitCode = code ?? -1;

      if (timedOut) {
        resolveResult({
          exitCode: -1,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          error: `Command timed out after ${COMMAND_TIMEOUT_MS}ms`,
        });
      } else {
        resolveResult({
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - start,
        });
      }
    });
  });
}

async function executeApprovedRecipes(
  commandPolicy: AuditCommandPolicy,
  targetPath: string,
  abortSignal?: AbortSignal,
): Promise<AuditCommandPolicy> {
  if (!commandPolicy.shellAllowed || commandPolicy.approvedRecipes.length === 0) {
    return commandPolicy;
  }

  const updatedDecisions: AuditCommandDecision[] = [];

  for (const decision of commandPolicy.decisions) {
    if (decision.status !== "allowed_not_run") {
      updatedDecisions.push(decision);
      continue;
    }

    console.error(`[audit] Running: ${decision.command} in ${targetPath}`);
    const result = await runSingleCommand(decision.command, targetPath, abortSignal);

    let status: AuditCommandDecision["status"];
    let reason: string;

    if (result.error && result.error.includes("timed out")) {
      status = "timed_out";
      reason = `Timed out after ${COMMAND_TIMEOUT_MS}ms`;
    } else if (result.exitCode === 0) {
      status = "passed";
      reason = `Exited 0 in ${result.durationMs}ms`;
    } else {
      status = "failed";
      reason = `Exit code ${result.exitCode} in ${result.durationMs}ms`;
    }

    console.error(`[audit]   ${decision.command}: ${status} (${reason})`);

    updatedDecisions.push({
      command: decision.command,
      status,
      reason,
      result,
      failure: status === "failed" || status === "timed_out"
        ? failure(
            status === "timed_out" ? "timeout" : "command_exit_nonzero",
            `${decision.command}: ${reason}`,
            status === "timed_out"
              ? "Increase timeout or investigate why this command hangs."
              : "Fix the failing command and rerun the audit.",
            true,
            result.stderr ? truncateOutput(result.stderr) : undefined,
          )
        : undefined,
    });
  }

  return {
    shellAllowed: commandPolicy.shellAllowed,
    approvedRecipes: commandPolicy.approvedRecipes,
    decisions: updatedDecisions,
  };
}

export async function runProjectAuditAsync(input: ProjectAuditInput): Promise<ProjectAuditResult> {
  // Phase 1: read-first audit (unchanged)
  const readResult = runProjectAudit(input);

  // Phase 2: execute approved recipes if requested
  if (!input.runCommands || !readResult.commandPolicy.shellAllowed) {
    return readResult;
  }

  const targetPath = readResult.preflight.targetPath;
  const updatedCommandPolicy = await executeApprovedRecipes(
    readResult.commandPolicy,
    targetPath,
    input.abortSignal,
  );

  // Re-collect failures with updated command policy
  const updatedFailures = collectFailures(
    readResult.preflight,
    readResult.classification,
    readResult.probes,
    updatedCommandPolicy,
  );

  // Re-score readiness with runtime verification
  const updatedReadiness = scoreReadiness(
    readResult.preflight,
    readResult.classification,
    readResult.probes,
    updatedFailures,
    updatedCommandPolicy,
  );

  return {
    ...readResult,
    commandPolicy: updatedCommandPolicy,
    readiness: updatedReadiness,
    failures: updatedFailures,
    runtimeVerified: true,
  };
}

function label(status: string): string {
  return status.replace(/_/g, " ");
}

export function formatProjectAuditResult(result: ProjectAuditResult): string {
  const observed = result.readiness.supportingEvidence.slice(0, 8);
  const missing = result.readiness.missingEvidence.slice(0, 8);
  const commands = result.commandPolicy.decisions;
  const failures = result.failures.slice(0, 6);
  const isVerified = result.runtimeVerified === true;

  const commandLines = commands.map((decision) => {
    const statusLabel = label(decision.status);
    let line = `- ${decision.command}: ${statusLabel} - ${decision.reason}`;
    if (decision.result && decision.status === "failed" && decision.result.stderr) {
      const stderrPreview = decision.result.stderr.split("\n").slice(0, 3).join("\n    ");
      line += `\n    stderr: ${stderrPreview}`;
    }
    return line;
  });

  return [
    `Readiness: ${label(result.readiness.readiness)}`,
    `Confidence: ${Math.round(result.readiness.confidence * 100)}%`,
    `Project: ${result.preflight.targetPath}`,
    `Classification: ${result.classification.primary} (${result.classification.categories.join(", ")})`,
    `Runtime verified: ${isVerified ? "yes" : "no"}`,
    "",
    "Observed from files/config:",
    ...(observed.length > 0 ? observed.map((item) => `- ${item}`) : ["- No supporting evidence found."]),
    "",
    "Missing or unverified:",
    ...(missing.length > 0 ? missing.map((item) => `- ${item}`) : ["- No major missing file/config evidence."]),
    "",
    `Runtime commands${isVerified ? " (executed)" : ""}:`,
    ...commandLines,
    "",
    "Risk flags:",
    ...(result.readiness.riskFlags.length > 0 ? result.readiness.riskFlags.map((item) => `- ${label(item)}`) : ["- none"]),
    "",
    "Structured failures:",
    ...(failures.length > 0
      ? failures.map((item) => `- ${item.category}: ${item.summary} Next: ${item.suggestedNextAction}`)
      : ["- none"]),
    "",
    ...(isVerified
      ? ["Note: This audit includes both file/config inspection and runtime command verification."]
      : ["Note: This audit is read-first. It separates file/config evidence from runtime verification; listed commands were not run in this pass."]),
  ].join("\n");
}
