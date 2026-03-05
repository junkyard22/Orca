import type { Issue, PappyInput } from "../types.js";
export type { Issue };

/**
 * Extract domain keywords from the task text for semantic completeness checks.
 * Returns a map of keyword → whether it was found in output.
 */
function extractDomainKeywords(task: string): Array<{ keyword: string; category: string }> {
  const keywords: Array<{ keyword: string; category: string }> = [];
  const lower = task.toLowerCase();

  // Code/implementation patterns
  if (/\b(login|form|input|submit|validat|button|field)\b/.test(lower)) {
    keywords.push({ keyword: "form", category: "UI component" });
    keywords.push({ keyword: "submit", category: "action" });
    keywords.push({ keyword: "validat", category: "validation" });
  }

  // API/HTTP patterns — avoid common English words like "get", "post", "put", "delete"
  // by requiring them to appear in an HTTP method context or alongside API-specific terms.
  if (
    /\b(api|endpoint|http|graphql|rest|webhook)\b|\b(fetch|axios|xhr|curl)\b|\bHTTP (GET|POST|PUT|DELETE|PATCH)\b|\/api\/|api[_\s-]?key/i.test(
      lower,
    )
  ) {
    keywords.push({ keyword: "api", category: "integration" });
    keywords.push({ keyword: "fetch", category: "data access" });
    keywords.push({ keyword: "response", category: "data handling" });
  }

  // Testing patterns
  if (/\b(test|spec|jest|vitest|describe|it|expect|assert)\b/.test(lower)) {
    keywords.push({ keyword: "test", category: "testing" });
    keywords.push({ keyword: "expect", category: "assertion" });
  }

  // File/system patterns — require filesystem context to avoid flagging
  // "write a function" or "read the docs" as I/O requirements.
  if (
    /\bfile\b/.test(lower) ||
    /\b(save|load|store|persist)\b/.test(lower) ||
    /\b(read|write)\b.{0,30}\b(file|disk|path|config|json|yaml|csv)\b/.test(lower) ||
    /\b(file|config|json|yaml|csv).{0,30}\b(read|write|load|save)\b/.test(lower)
  ) {
    keywords.push({ keyword: "file", category: "persistence" });
    keywords.push({ keyword: "read", category: "I/O" });
    keywords.push({ keyword: "write", category: "I/O" });
  }

  // Error handling patterns
  if (/\b(error|throw|catch|try|except|fail|handle)\b/.test(lower)) {
    keywords.push({ keyword: "error", category: "error handling" });
    keywords.push({ keyword: "catch", category: "error handling" });
  }

  // Component patterns
  if (/\b(component|react|vue|angular|element|render|props|state)\b/.test(lower)) {
    keywords.push({ keyword: "component", category: "architecture" });
    keywords.push({ keyword: "render", category: "UI" });
  }

  return keywords;
}

/**
 * Check if the output text OR any diff in filesChanged contains evidence of addressing a keyword.
 * Scanning diffs ensures we don't false-positive on agents that write all code to files and
 * produce minimal prose (e.g. "Done, changes applied.").
 */
function hasKeywordEvidence(
  outputText: string,
  keyword: string,
  filesChanged?: PappyInput["filesChanged"],
): boolean {
  const patterns = [
    new RegExp(`\\b${keyword}\\w*\\b`, "i"),
    new RegExp(`\\w*${keyword}\\b`, "i"),
  ];

  // Check prose output first
  if (patterns.some((p) => p.test(outputText))) return true;

  // Also scan diff content — agents often write everything to files with minimal prose
  if (filesChanged && filesChanged.length > 0) {
    const diffContent = filesChanged.map((f) => f.diff ?? "").join("\n");
    if (diffContent.length > 0 && patterns.some((p) => p.test(diffContent))) return true;
  }

  return false;
}

/**
 * Check if filesChanged contains evidence relevant to the task domain.
 */
function hasFileEvidence(filesChanged: PappyInput["filesChanged"], category: string): boolean {
  if (!filesChanged || filesChanged.length === 0) return false;

  const relevantExtensions: Record<string, string[]> = {
    "UI component": [".tsx", ".jsx", ".vue", ".svelte", ".html", ".css"],
    "testing": [".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.tsx"],
    "integration": [".ts", ".js", ".py", ".go", ".rs"],
    "persistence": [".ts", ".js", ".py", ".sql", ".json"],
    "error handling": [".ts", ".js", ".py", ".go", ".rs"],
    "architecture": [".ts", ".tsx", ".js", ".jsx", ".py"],
  };

  const relevantExts = relevantExtensions[category] ?? [".ts", ".js", ".py"];
  return filesChanged.some((f) =>
    relevantExts.some((ext) => f.path.toLowerCase().endsWith(ext)),
  );
}

export function runCompletenessChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];

  // ── required files from constraints ──────────────────────────────────────
  const requiredFiles = input.constraints?.requireFiles ?? [];
  const touched = new Set((input.filesChanged ?? []).map((f) => f.path));

  for (const requiredPath of requiredFiles) {
    if (!touched.has(requiredPath)) {
      issues.push({
        severity: "HIGH",
        code: "COMPLETENESS_MISSING_FILE",
        category: "Completeness",
        description: `Required file "${requiredPath}" was not changed or created.`,
        expected_receipt: `file_exists or diff showing changes to "${requiredPath}"`,
        evidence: "No entry for this path in filesChanged.",
        fix_hint: `Create or modify "${requiredPath}" and include it in the changeset.`,
        message: `Required file "${requiredPath}" was not present in filesChanged.`,
        suggestedFix: `Ensure "${requiredPath}" is created or modified as part of this task.`,
      });
    }
  }

  // ── task goals completeness: warn if no output and no files ──────────────
  const hasOutput = (input.outputText?.trim().length ?? 0) > 0;
  const hasFiles  = (input.filesChanged?.length ?? 0) > 0;
  const hasTools  = (input.toolEvents?.length ?? 0) > 0;

  if (!hasOutput && !hasFiles && !hasTools) {
    issues.push({
      severity: "HIGH",
      code: "COMPLETENESS_NO_OUTPUT",
      category: "Completeness",
      description: "No output, no file changes, and no tool events were produced.",
      expected_receipt: "At least one of: outputText, filesChanged, or toolEvents must be non-empty.",
      evidence: "outputText is empty, filesChanged is empty, toolEvents is empty.",
      fix_hint: "Re-run the task and capture output/artifacts.",
      message: "Run produced no output of any kind.",
    });
  }

  // ── 4.1 Task-aware semantic completeness checks ──────────────────────────
  // Compare what was asked against what was delivered using domain keywords.
  const keywords = extractDomainKeywords(input.task);

  if (keywords.length > 0 && (hasOutput || hasFiles)) {
    const missingKeywords = keywords.filter(
      (k) => !hasKeywordEvidence(input.outputText ?? "", k.keyword, input.filesChanged),
    );

    // If >50% of domain keywords are missing, that's a completeness issue
    if (missingKeywords.length > keywords.length * 0.5) {
      const missingTerms = missingKeywords.map((k) => k.keyword).join(", ");
      const categories = [...new Set(missingKeywords.map((k) => k.category))].join(", ");

      issues.push({
        severity: "MEDIUM",
        code: "COMPLETENESS_MISSING_DOMAIN_TERMS",
        category: "Completeness",
        description: `Output does not address key domain concepts from the task: ${missingTerms}.`,
        expected_receipt: `Output should discuss or implement: ${categories}.`,
        evidence: `Task mentions: ${keywords.map((k) => k.keyword).join(", ")}. Output contains none of: ${missingTerms}.`,
        fix_hint: `Revise the output to address the missing concepts: ${missingTerms}.`,
        message: `Output is missing domain-relevant content for: ${missingTerms}.`,
        suggestedFix: `Include implementation or discussion of: ${missingTerms}.`,
      });
    }
  }

  // Check if files changed are relevant to the task domain
  if (keywords.length > 0 && hasFiles) {
    const categoriesWithoutEvidence = keywords.filter(
      (k) => !hasFileEvidence(input.filesChanged, k.category),
    );

    // If task implies file work but no relevant files changed
    const fileWorkCategories = ["UI component", "testing", "persistence", "architecture"];
    const hasMissingFileWork = categoriesWithoutEvidence.some((k) =>
      fileWorkCategories.includes(k.category),
    );

    if (hasMissingFileWork && categoriesWithoutEvidence.length === keywords.length) {
      issues.push({
        severity: "LOW",
        code: "COMPLETENESS_FILE_MISMATCH",
        category: "Completeness",
        description: "Files changed do not match the task's domain requirements.",
        expected_receipt: "Files with extensions relevant to the task domain.",
        evidence: `Task implies work in: ${keywords.map((k) => k.category).join(", ")}. Changed files may not be relevant.`,
        fix_hint: "Ensure file changes are relevant to the task domain.",
        message: "Changed files may not address the task requirements.",
        suggestedFix: "Modify or create files that are relevant to the task domain.",
      });
    }
  }

  // ── 4.2 File change verification — verify diffs contain actual content ───
  // Check that file changes contain meaningful diff content, not just metadata.
  for (const file of input.filesChanged ?? []) {
    if (file.changeType === "M" || file.changeType === "A") {
      // Modified or added files should have diff content
      if (!file.diff || file.diff.trim().length === 0) {
        issues.push({
          severity: "MEDIUM",
          code: "COMPLETENESS_EMPTY_DIFF",
          category: "Completeness",
          description: `File "${file.path}" was ${file.changeType === "A" ? "created" : "modified"} but no diff content was provided.`,
          expected_receipt: `diff showing actual content changes in "${file.path}"`,
          evidence: `filesChanged entry for "${file.path}" has no diff or empty diff.`,
          fix_hint: `Include the actual diff/content for "${file.path}" in the file change.`,
          message: `File "${file.path}" has no diff content to verify.`,
          suggestedFix: `Provide the actual content changes for "${file.path}".`,
        });
      } else if (file.diff && file.diff.length < 20) {
        // Suspiciously short diff might indicate placeholder content
        issues.push({
          severity: "LOW",
          code: "COMPLETENESS_SUSPICIOUS_DIFF",
          category: "Completeness",
          description: `File "${file.path}" has a very short diff (${file.diff.length} chars) — may be incomplete.`,
          expected_receipt: `diff with meaningful content for "${file.path}"`,
          evidence: `diff for "${file.path}" is only ${file.diff.length} characters.`,
          fix_hint: `Ensure the diff contains the actual implementation.`,
          message: `Diff for "${file.path}" may be incomplete or placeholder.`,
          suggestedFix: `Include complete implementation in the diff.`,
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Satisfaction checks — does the output actually deliver what was asked?
// ---------------------------------------------------------------------------

/**
 * Detect the primary deliverable the task is requesting.
 * Returns one of: "code" | "fix" | "list" | "explanation" | null
 */
function detectDeliverable(
  task: string,
): { kind: "code" | "fix" | "list" | "explanation"; artifact: string } | null {
  const lower = task.toLowerCase();

  // Code deliverable — explicit verb + code artifact noun
  const codeVerb   = /\b(write|implement|create|build|make|add|code|generate|define)\b/;
  const codeNoun   = /\b(function|method|class|hook|component|algorithm|handler|helper|utility|script|module|interface|type|enum|struct|api|endpoint|middleware|route|service|controller|reducer|action|selector|mixin|decorator|plugin)\b/;
  const codeMatch  = codeNoun.exec(lower);
  if (codeVerb.test(lower) && codeMatch) {
    return { kind: "code", artifact: codeMatch[0] };
  }

  // Fix / debug deliverable
  const fixVerbPlusNoun = /\b(fix|resolve|debug|correct|patch|repair)\b.{0,50}\b(bug|error|issue|problem|crash|exception|failure|fault|defect)\b/;
  const nounPlusFixVerb = /\b(bug|error|issue|problem|crash|exception)\b.{0,50}\b(fix|resolve|debug|correct|patch)\b/;
  if (fixVerbPlusNoun.test(lower) || nounPlusFixVerb.test(lower)) {
    return { kind: "fix", artifact: "bug/error" };
  }

  // List deliverable — task starts with list intent or has explicit list phrase
  if (
    /^(list|enumerate|what are|show all|find all|give me a list)\b/i.test(task.trim()) ||
    /\b(list all|enumerate all|show all|what are (all |the )?(available |possible )?\w+s?)\b/.test(lower)
  ) {
    return { kind: "list", artifact: "items" };
  }

  // Explanation deliverable — caught as a baseline fallback later
  if (/\b(explain|describe|what is|what are|how does|how do|why does|why is|summarize|overview|tell me (about|how))\b/.test(lower)) {
    return { kind: "explanation", artifact: "explanation" };
  }

  return null;
}

/**
 * Run satisfaction checks: does the output actually deliver what the task requested?
 *
 * These complement structural / keyword checks by looking at the deliverable
 * *type* the user intended — code snippet, bug fix, list, explanation — and
 * verifying evidence of that type exists in the output or filesChanged.
 */
export function runSatisfactionChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const issues: Omit<Issue, "issueId">[] = [];
  const output   = input.outputText ?? "";
  const hasFiles = (input.filesChanged?.length ?? 0) > 0;
  const deliverable = detectDeliverable(input.task);

  if (!deliverable) return issues;

  if (deliverable.kind === "code") {
    // Evidence of code: fenced block, inline code, common code keywords, or a file change
    const hasCodeBlock    = /```/.test(output);
    const hasInlineCode   = /`[^`\n]+`/.test(output);
    const hasCodeKeywords = /\b(def |function |class |const |let |var |export |import |public |private |protected |async |fn |func |procedure )/.test(output);
    const hasCode = hasCodeBlock || hasInlineCode || hasCodeKeywords || hasFiles;

    if (!hasCode) {
      issues.push({
        severity: "HIGH",
        code: "SATISFACTION_CODE_MISSING",
        category: "Completeness",
        description: `Task requests a ${deliverable.artifact} but the output contains no code.`,
        expected_receipt: "Output must contain a code block (```) or a function/class definition, OR filesChanged must be non-empty.",
        evidence: `Task: "${input.task.slice(0, 100)}". No code block, inline code, code keywords, or file changes found.`,
        fix_hint: `Include the requested ${deliverable.artifact} implementation in a fenced code block.`,
        message: `No code was delivered for a task that requests a ${deliverable.artifact}.`,
        suggestedFix: "Provide the implementation in a fenced code block.",
      });
    }
  }

  if (deliverable.kind === "fix") {
    // Evidence of a fix: code in output, file changes, or resolution language
    const hasFixEvidence =
      /```/.test(output) ||
      hasFiles ||
      /\b(fixed?|resolved?|patched?|updated?|changed?|corrected?|removed?)\b/i.test(output);

    if (!hasFixEvidence) {
      issues.push({
        severity: "HIGH",
        code: "SATISFACTION_FIX_MISSING",
        category: "Completeness",
        description: "Task requests a fix/debug but the output contains no fix evidence.",
        expected_receipt: "Output must contain a corrected code block, OR filesChanged must include the fixed file.",
        evidence: `Task: "${input.task.slice(0, 100)}". No code change, file change, or fix language detected.`,
        fix_hint: "Show the specific change that resolves the problem in a code block.",
        message: "No fix was delivered for a fix/debug task.",
        suggestedFix: "Provide the corrected code or an explicit description of the change applied.",
      });
    }
  }

  if (deliverable.kind === "list") {
    // Evidence of a list: bullet/numbered list items in output
    const hasList =
      /^[ \t]*[-*•]\s+/m.test(output) ||
      /^[ \t]*\d+[.)\s]/.test(output) ||
      hasFiles;

    if (!hasList) {
      issues.push({
        severity: "MEDIUM",
        code: "SATISFACTION_LIST_MISSING",
        category: "Completeness",
        description: "Task requests a list but the output contains no list formatting.",
        expected_receipt: "Output must contain a bulleted or numbered list.",
        evidence: `Task: "${input.task.slice(0, 100)}". No list markers (-, *, 1.) found in output.`,
        fix_hint: "Format the items as a bullet or numbered list.",
        message: "No list structure found for a list task.",
        suggestedFix: "Format the response items as a bulleted or numbered list.",
      });
    }
  }

  if (deliverable.kind === "explanation") {
    // An explanation should have at least a minimal substantive response
    const substantive = output.trim().length >= 80;
    if (!substantive && !hasFiles) {
      issues.push({
        severity: "MEDIUM",
        code: "SATISFACTION_EXPLANATION_THIN",
        category: "Completeness",
        description: "Task requests an explanation but the output is too brief to be substantive.",
        expected_receipt: "Output must contain at least 100 characters of explanatory text.",
        evidence: `Task: "${input.task.slice(0, 100)}". Output is only ${output.trim().length} chars.`,
        fix_hint: "Expand the response to fully address the explanation requested.",
        message: "Explanation response is too brief.",
        suggestedFix: "Provide a more detailed explanation.",
      });
    }
  }

  return issues;
}
