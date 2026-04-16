import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  AuditCommandDecision,
  AuditCommandPolicy,
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
  if (taskSpec.mode === "project_audit") return true;

  const text = [taskSpec.originalUserMessage, taskSpec.intent, ...(taskSpec.goals ?? [])].join(" ");
  const asksForAudit =
    /\b(check|review|audit|inspect|assess|evaluate)\b.{0,80}\b(app|repo|repository|project|codebase|code base)\b/i.test(text) ||
    /\b(app|repo|repository|project|codebase|code base)\b.{0,80}\b(check|review|audit|inspect|assess|evaluate)\b/i.test(text) ||
    /\b(production|prod|ship|release)\s+read(?:y|iness)\b/i.test(text) ||
    /\bready\s+for\s+(production|prod|release|ship|shipping)\b/i.test(text);

  return asksForAudit && !!extractAuditTargetPath(taskSpec, undefined);
}

export function extractAuditTargetPath(taskSpec: OrcaTaskSpec, workspaceRoot?: string): string | undefined {
  const contextPath = taskSpec.context?.["auditPath"] ?? taskSpec.context?.["workspaceRoot"];
  if (typeof contextPath === "string" && contextPath.trim()) {
    return contextPath.trim();
  }

  const text = [taskSpec.originalUserMessage, taskSpec.intent, ...(taskSpec.goals ?? [])].join("\n");
  for (const line of text.split(/\r?\n/)) {
    const windowsMatch = line.match(/\b[A-Za-z]:[\\/][^\r\n]+/);
    if (windowsMatch?.[0]) return windowsMatch[0].trim().replace(/[.,"'`]+$/, "");

    const posixMatch = line.match(/(?:^|\s)(\/[^\r\n]+)/);
    if (posixMatch?.[1]) return posixMatch[1].trim().replace(/[.,"'`]+$/, "");
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
  const probes: AuditProbeResult[] = [];

  probes.push(probe("inspect_directory_tree", tree.length > 0 ? "pass" : "missing", tree.slice(0, 20), tree.length === 0 ? ["No readable directory entries"] : [], { entries: tree }));

  const keyFiles = preflight.markers.filter((marker) => marker.kind === "file").map((marker) => marker.path);
  probes.push(probe("read_key_files", keyFiles.length > 0 ? "pass" : "missing", keyFiles, keyFiles.length === 0 ? ["No key marker files found"] : []));

  const packageManager =
    markers.has("pnpm-lock.yaml") ? "pnpm" :
    markers.has("package-lock.json") ? "npm" :
    markers.has("yarn.lock") ? "yarn" :
    markers.has("package.json") ? "npm_or_compatible" :
    undefined;
  probes.push(probe("detect_package_manager", packageManager ? "pass" : "not_applicable", packageManager ? [`${packageManager} marker detected`] : [], packageManager ? [] : ["No Node package manager lockfile found"], { packageManager }));

  const scriptNames = Object.keys(scripts);
  probes.push(probe("detect_scripts", scriptNames.length > 0 ? "pass" : markers.has("package.json") ? "missing" : "not_applicable", scriptNames.map((name) => `script:${name}`), markers.has("package.json") && scriptNames.length === 0 ? ["package.json has no scripts"] : [], { scripts }));

  const hasTests = scriptNames.some((name) => /test/i.test(name)) || markers.has("tests") || markers.has("__tests__") || markers.has("e2e");
  probes.push(probe("detect_test_setup", hasTests ? "pass" : "missing", hasTests ? ["Test script or test directory detected"] : [], hasTests ? [] : ["No test script or test directory detected"]));

  const hasBuild = scriptNames.some((name) => /build|compile/i.test(name)) || markers.has("tsconfig.json") || classification.categories.includes("rust_app") || classification.categories.includes("go_app");
  probes.push(probe("detect_build_setup", hasBuild ? "pass" : "missing", hasBuild ? ["Build script, compiler config, or compiled-language marker detected"] : [], hasBuild ? [] : ["No build script or compiler config detected"]));

  const hasRelease = markers.has(".github/workflows") || markers.has("Dockerfile") || markers.has("docker-compose.yml") || scriptNames.some((name) => /dist|release|pack|package/i.test(name));
  probes.push(probe("detect_release_setup", hasRelease ? "pass" : "missing", hasRelease ? ["Release, packaging, Docker, or workflow signal detected"] : [], hasRelease ? [] : ["No release or packaging signal detected"]));

  probes.push(probe("detect_ci_setup", markers.has(".github/workflows") ? "pass" : "missing", markers.has(".github/workflows") ? [".github/workflows present"] : [], markers.has(".github/workflows") ? [] : ["No GitHub Actions workflows detected"]));

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
  probes.push(probe("detect_docs_presence", docs.length > 0 ? "pass" : "missing", docs.map((marker) => marker.path), docs.length === 0 ? ["No README detected"] : []));

  const packagingEvidence = [
    ...(markers.has("Dockerfile") ? ["Dockerfile present"] : []),
    ...(markers.has("electron-builder.yml") || markers.has("electron-builder.json") || deps.has("electron-builder") ? ["electron-builder signal present"] : []),
    ...(scriptNames.filter((name) => /dist|pack|package|release/i.test(name)).map((name) => `script:${name}`)),
  ];
  probes.push(probe("detect_packaging_signals", packagingEvidence.length > 0 ? "pass" : "missing", packagingEvidence, packagingEvidence.length === 0 ? ["No packaging signal detected"] : []));

  const loggingEvidence = [
    ...[...deps].filter((dep) => /log|sentry|winston|pino|bunyan|debug/i.test(dep)).map((dep) => `dependency:${dep}`),
    ...tree.filter((entry) => /logger|logging|error|exception/i.test(entry)).slice(0, 6),
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

function scoreReadiness(preflight: AuditPreflight, classification: ProjectClassification, probes: AuditProbeResult[], failures: AuditFailure[]): ReadinessScore {
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
  const supportingEvidence = probes.flatMap((item) => item.evidence).slice(0, 20);
  const missingEvidence = probes.flatMap((item) => item.missing).slice(0, 20);
  const riskFlags = [
    ...(classification.primary === "unknown" ? ["unsupported_stack"] : []),
    ...(probeStatus(probes, "detect_test_setup") === "missing" ? ["no_test_evidence"] : []),
    ...(probeStatus(probes, "detect_build_setup") === "missing" ? ["no_build_evidence"] : []),
    ...(probeStatus(probes, "detect_ci_setup") === "missing" ? ["no_ci_evidence"] : []),
    ...(probeStatus(probes, "detect_env_hygiene") !== "pass" ? ["config_hygiene_incomplete"] : []),
  ];

  let readiness: ReadinessScore["readiness"];
  if (classification.primary === "unknown" && totalScore < 35) readiness = "insufficient_evidence";
  else if (totalScore >= 85 && riskFlags.length === 0) readiness = "ready";
  else if (totalScore >= 70) readiness = "mostly_ready";
  else if (totalScore >= 45) readiness = "prototype";
  else readiness = "not_production_ready";

  const confidence = Math.max(
    0.1,
    Math.min(0.95, 0.25 + classification.confidence * 0.35 + probes.filter((item) => item.status === "pass").length * 0.06 - failures.length * 0.08),
  );

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

  const recipes = [...new Set([
    ...(APPROVED_RECIPES[classification.primary] ?? []),
    ...classification.categories.flatMap((category) => APPROVED_RECIPES[category] ?? []),
  ])];

  const decisions: AuditCommandDecision[] = recipes.length > 0
    ? recipes.map((command) => ({
        command,
        status: "allowed_not_run",
        reason: "Approved recipe after preflight and classification, but audit mode is read-first and did not execute commands automatically.",
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

function collectFailures(preflight: AuditPreflight, classification: ProjectClassification, probes: AuditProbeResult[], commandPolicy: AuditCommandPolicy): AuditFailure[] {
  const failures = [...preflight.failures];
  if (preflight.exists && preflight.readable && preflight.kind === "directory" && preflight.markers.length === 0) {
    failures.push(failure("no_relevant_files", "No common project marker files or folders were found.", "Confirm this is the project root or provide a more specific path."));
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
  const readiness = scoreReadiness(preflight, classification, probes, failures);

  return {
    mode: "project_audit",
    task: input.taskSpec.originalUserMessage,
    preflight,
    classification,
    probes,
    commandPolicy,
    readiness,
    failures,
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

  return [
    `Readiness: ${label(result.readiness.readiness)}`,
    `Confidence: ${Math.round(result.readiness.confidence * 100)}%`,
    `Project: ${result.preflight.targetPath}`,
    `Classification: ${result.classification.primary} (${result.classification.categories.join(", ")})`,
    "",
    "Observed from files/config:",
    ...(observed.length > 0 ? observed.map((item) => `- ${item}`) : ["- No supporting evidence found."]),
    "",
    "Missing or unverified:",
    ...(missing.length > 0 ? missing.map((item) => `- ${item}`) : ["- No major missing file/config evidence from the read-only audit."]),
    "",
    "Runtime commands:",
    ...commands.map((decision) => `- ${decision.command}: ${label(decision.status)} - ${decision.reason}`),
    "",
    "Risk flags:",
    ...(result.readiness.riskFlags.length > 0 ? result.readiness.riskFlags.map((item) => `- ${label(item)}`) : ["- none from read-only evidence"]),
    "",
    "Structured failures:",
    ...(failures.length > 0
      ? failures.map((item) => `- ${item.category}: ${item.summary} Next: ${item.suggestedNextAction}`)
      : ["- none"]),
    "",
    "Note: This audit is read-first. It distinguishes file/config evidence from runtime verification; commands listed above were not executed automatically.",
  ].join("\n");
}
