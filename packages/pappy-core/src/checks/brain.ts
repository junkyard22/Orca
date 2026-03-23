/**
 * Brain-specific QC checks.
 *
 * Fires only when `outputText` looks like a Brain routing response
 * (starts with `{` and contains a `"routing"` key).  All checks are
 * purely structural — they do not require LLM access.
 *
 * Issue codes emitted:
 *   BRAIN_OUTPUT_MALFORMED   — JSON invalid, wrong type, missing/bad routing enum, invalid dept shape
 *   BRAIN_INVALID_ROLE       — role / head not in the valid head-name set
 *   BRAIN_HALLUCINATED_FIELD — extra top-level or per-dept keys the schema doesn't allow
 *   BRAIN_NARRATIVE_BLEED    — non-JSON prose before or after the JSON object
 */

import type { PappyInput, Issue } from "../types.js";

// ---------------------------------------------------------------------------
// Valid roles — inlined from maestro-core to avoid a circular dependency.
// Keep in sync with VALID_HEAD_NAMES in packages/maestro-core/src/decompose.ts
// ---------------------------------------------------------------------------
const BRAIN_VALID_HEAD_NAMES = new Set([
  "brain",
  "coder_strong",
  "coder_cheap",
  "utility",
  "reviewer",
  "narrator",
  "planner_deep",
  "debugger",
  "reader",
]);

const DIRECT_VALID_KEYS    = new Set(["routing", "role"]);
const DECOMPOSE_VALID_KEYS = new Set(["routing", "departments"]);
const DEPT_VALID_KEYS      = new Set(["head", "task"]);

// ---------------------------------------------------------------------------
// Activation guard
// ---------------------------------------------------------------------------

function isBrainOutput(text: string): boolean {
  // Fires when text contains a brain routing JSON object — even if prose
  // surrounds it (narrative bleed).  Requiring the exact "routing" key
  // prevents false-positives on ordinary outputs that happen to include braces.
  return text.includes('"routing"') && text.includes('{');
}

// ---------------------------------------------------------------------------
// Main check function
// ---------------------------------------------------------------------------

export function runBrainChecks(input: PappyInput): Omit<Issue, "issueId">[] {
  const raw = input.outputText ?? "";
  if (!isBrainOutput(raw)) return [];

  const issues: Omit<Issue, "issueId">[] = [];
  const trimmed = raw.trim();

  // ------------------------------------------------------------------
  // 1. BRAIN_NARRATIVE_BLEED — prose outside the JSON object
  // ------------------------------------------------------------------
  const firstBrace = raw.indexOf("{");
  const lastBrace  = raw.lastIndexOf("}");
  const beforeJson = raw.slice(0, firstBrace);
  const afterJson  = lastBrace >= 0 ? raw.slice(lastBrace + 1) : "";

  if (beforeJson.trim().length > 0 || afterJson.trim().length > 0) {
    const parts: string[] = [];
    if (beforeJson.trim()) parts.push(`prefix: "${beforeJson.trim().slice(0, 80)}"`);
    if (afterJson.trim())  parts.push(`suffix: "${afterJson.trim().slice(0, 80)}"`);
    issues.push({
      severity: "HIGH",
      code: "BRAIN_NARRATIVE_BLEED",
      category: "Consistency",
      description: "Non-JSON text appears before or after the routing JSON object.",
      expected_receipt: "outputText must be a bare JSON object with no surrounding prose.",
      evidence: parts.join("; "),
      fix_hint: "Return only the raw JSON object — no preamble, no explanation, no trailing text.",
      message: "Brain output contains text outside the JSON object.",
      suggestedFix: "Strip all text before '{' and after the final '}'.",
    });
  }

  // ------------------------------------------------------------------
  // 2. JSON parse
  // ------------------------------------------------------------------
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    issues.push({
      severity: "HIGH",
      code: "BRAIN_OUTPUT_MALFORMED",
      category: "Consistency",
      description: "Brain routing output is not valid JSON.",
      expected_receipt: "outputText must be a valid JSON object.",
      evidence: `JSON.parse error: ${(e as Error).message}`,
      fix_hint: "Fix the JSON syntax — check for unescaped characters, trailing commas, or missing braces.",
      message: "Brain output failed JSON.parse.",
      suggestedFix: "Return a syntactically valid JSON object.",
    });
    return issues; // no point continuing without parseable JSON
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    issues.push({
      severity: "HIGH",
      code: "BRAIN_OUTPUT_MALFORMED",
      category: "Consistency",
      description: "Brain routing output parsed to a non-object value.",
      expected_receipt: "outputText must parse to a plain JSON object (not an array or primitive).",
      evidence: `Parsed type: ${Array.isArray(parsed) ? "array" : typeof parsed}`,
      fix_hint: "Return a JSON object, not an array or bare value.",
      message: "Brain output is not a JSON object.",
      suggestedFix: "Wrap the value in a JSON object with the required `routing` key.",
    });
    return issues;
  }

  const obj = parsed as Record<string, unknown>;

  // ------------------------------------------------------------------
  // 3. `routing` field — required, must be "direct" | "decompose"
  // ------------------------------------------------------------------
  if (!("routing" in obj)) {
    issues.push({
      severity: "HIGH",
      code: "BRAIN_OUTPUT_MALFORMED",
      category: "Consistency",
      description: 'Brain routing output is missing the required "routing" field.',
      expected_receipt: '"routing" must be present and set to "direct" or "decompose".',
      evidence: `Keys present: ${Object.keys(obj).join(", ") || "(none)"}`,
      fix_hint: 'Add "routing": "direct" or "routing": "decompose" to the output.',
      message: 'Brain output missing "routing" field.',
      suggestedFix: 'Add "routing": "direct" to the JSON object.',
    });
    return issues; // routing value is needed for all downstream checks
  }

  const routing = obj.routing;
  if (routing !== "direct" && routing !== "decompose") {
    issues.push({
      severity: "HIGH",
      code: "BRAIN_OUTPUT_MALFORMED",
      category: "Consistency",
      description: `Brain "routing" field has invalid value ${JSON.stringify(routing)}.`,
      expected_receipt: '"routing" must be exactly "direct" or "decompose".',
      evidence: `routing = ${JSON.stringify(routing)}`,
      fix_hint: 'Set "routing" to "direct" or "decompose".',
      message: '"routing" field has invalid value.',
      suggestedFix: 'Change "routing" to "direct" or "decompose".',
    });
    // Continue checking remaining fields even with a bad routing value
  }

  // ------------------------------------------------------------------
  // 4. BRAIN_HALLUCINATED_FIELD — unknown top-level keys
  // ------------------------------------------------------------------
  const validKeys   = routing === "decompose" ? DECOMPOSE_VALID_KEYS : DIRECT_VALID_KEYS;
  const unknownKeys = Object.keys(obj).filter(k => !validKeys.has(k));
  if (unknownKeys.length > 0) {
    issues.push({
      severity: "HIGH",
      code: "BRAIN_HALLUCINATED_FIELD",
      category: "Consistency",
      description: `Brain output contains extra fields not in the schema: ${unknownKeys.join(", ")}.`,
      expected_receipt: `Only [${[...validKeys].join(", ")}] are allowed for routing="${routing}".`,
      evidence: `Unknown keys: ${unknownKeys.join(", ")}`,
      fix_hint: `Remove the extra fields: ${unknownKeys.join(", ")}.`,
      message: "Brain output has hallucinated extra fields.",
      suggestedFix: `Remove these keys from the output: ${unknownKeys.join(", ")}.`,
    });
  }

  // ------------------------------------------------------------------
  // 5. Role / department checks
  // ------------------------------------------------------------------
  if (routing === "direct") {
    const role = obj.role;
    if (role === undefined || role === null || String(role).trim() === "") {
      issues.push({
        severity: "HIGH",
        code: "BRAIN_INVALID_ROLE",
        category: "Consistency",
        description: 'Direct routing output is missing the required "role" field.',
        expected_receipt: '"role" must be a valid head name.',
        evidence: `Keys present: ${Object.keys(obj).join(", ")}`,
        fix_hint: `Add "role": "<head_name>". Valid values: ${[...BRAIN_VALID_HEAD_NAMES].join(", ")}.`,
        message: 'Brain direct-routing output missing "role".',
        suggestedFix: 'Add "role": "coder_strong" (or the appropriate role).',
      });
    } else if (!BRAIN_VALID_HEAD_NAMES.has(String(role))) {
      issues.push({
        severity: "HIGH",
        code: "BRAIN_INVALID_ROLE",
        category: "Consistency",
        description: `Brain "role" value ${JSON.stringify(role)} is not a valid routing target.`,
        expected_receipt: `"role" must be one of: ${[...BRAIN_VALID_HEAD_NAMES].join(", ")}.`,
        evidence: `role = ${JSON.stringify(role)}`,
        fix_hint: `Use one of the valid roles: ${[...BRAIN_VALID_HEAD_NAMES].join(", ")}.`,
        message: '"role" is not a valid routing target.',
        suggestedFix: `Change "role" to one of: ${[...BRAIN_VALID_HEAD_NAMES].join(", ")}.`,
      });
    }
  } else if (routing === "decompose") {
    const departments = obj.departments;
    if (!Array.isArray(departments) || departments.length === 0) {
      issues.push({
        severity: "HIGH",
        code: "BRAIN_OUTPUT_MALFORMED",
        category: "Consistency",
        description: 'Decompose routing output must have a non-empty "departments" array.',
        expected_receipt: '"departments" must be an array of {head, task} objects with at least one entry.',
        evidence: `departments = ${JSON.stringify(departments)}`,
        fix_hint: 'Add at least one {"head": "<role>", "task": "<task>"} entry to "departments".',
        message: 'Brain decompose output has empty or missing "departments".',
        suggestedFix: 'Add "departments": [{"head": "<role>", "task": "<task>"}].',
      });
    } else {
      for (let i = 0; i < departments.length; i++) {
        const dept = departments[i] as unknown;
        if (typeof dept !== "object" || dept === null || Array.isArray(dept)) {
          issues.push({
            severity: "HIGH",
            code: "BRAIN_OUTPUT_MALFORMED",
            category: "Consistency",
            description: `departments[${i}] is not an object.`,
            expected_receipt: "Each department entry must be a {head, task} object.",
            evidence: `departments[${i}] = ${JSON.stringify(dept)}`,
            fix_hint: `Replace departments[${i}] with {"head": "<role>", "task": "<task>"}.`,
            message: `departments[${i}] is not a valid object.`,
            suggestedFix: `departments[${i}] must be {"head": "<role>", "task": "<task>"}.`,
          });
          continue;
        }
        const deptObj = dept as Record<string, unknown>;

        // Unknown keys in dept entry
        const unknownDeptKeys = Object.keys(deptObj).filter(k => !DEPT_VALID_KEYS.has(k));
        if (unknownDeptKeys.length > 0) {
          issues.push({
            severity: "HIGH",
            code: "BRAIN_HALLUCINATED_FIELD",
            category: "Consistency",
            description: `departments[${i}] contains extra fields: ${unknownDeptKeys.join(", ")}.`,
            expected_receipt: "Department entries must only have: head, task.",
            evidence: `Unknown keys in departments[${i}]: ${unknownDeptKeys.join(", ")}`,
            fix_hint: `Remove ${unknownDeptKeys.join(", ")} from departments[${i}].`,
            message: `departments[${i}] has extra fields.`,
            suggestedFix: `Strip extra fields from departments[${i}].`,
          });
        }

        // head — required and must be a valid role
        const head = deptObj.head;
        if (head === undefined || head === null || String(head).trim() === "") {
          issues.push({
            severity: "HIGH",
            code: "BRAIN_INVALID_ROLE",
            category: "Consistency",
            description: `departments[${i}] is missing the "head" field.`,
            expected_receipt: `Each department must have a "head" field with a valid role.`,
            evidence: `departments[${i}] keys: ${Object.keys(deptObj).join(", ")}`,
            fix_hint: `Add "head": "<role>" to departments[${i}]. Valid values: ${[...BRAIN_VALID_HEAD_NAMES].join(", ")}.`,
            message: `departments[${i}] missing "head".`,
            suggestedFix: `Add "head": "coder_strong" to departments[${i}].`,
          });
        } else if (!BRAIN_VALID_HEAD_NAMES.has(String(head))) {
          issues.push({
            severity: "HIGH",
            code: "BRAIN_INVALID_ROLE",
            category: "Consistency",
            description: `departments[${i}].head ${JSON.stringify(head)} is not a valid routing target.`,
            expected_receipt: `head must be one of: ${[...BRAIN_VALID_HEAD_NAMES].join(", ")}.`,
            evidence: `departments[${i}].head = ${JSON.stringify(head)}`,
            fix_hint: `Use a valid role for departments[${i}].head.`,
            message: `departments[${i}].head is not a valid routing target.`,
            suggestedFix: `Change departments[${i}].head to one of: ${[...BRAIN_VALID_HEAD_NAMES].join(", ")}.`,
          });
        }

        // task — required, non-empty string
        const task = deptObj.task;
        if (task === undefined || task === null || typeof task !== "string" || task.trim() === "") {
          issues.push({
            severity: "HIGH",
            code: "BRAIN_OUTPUT_MALFORMED",
            category: "Consistency",
            description: `departments[${i}] is missing a non-empty "task" string.`,
            expected_receipt: `Each department must have a non-empty "task" string.`,
            evidence: `departments[${i}].task = ${JSON.stringify(task)}`,
            fix_hint: `Add "task": "<description>" to departments[${i}].`,
            message: `departments[${i}] missing or empty "task".`,
            suggestedFix: `Add "task": "<description>" to departments[${i}].`,
          });
        }
      }
    }
  }

  return issues;
}
