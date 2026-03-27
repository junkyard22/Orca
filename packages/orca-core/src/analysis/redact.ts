/**
 * redact.ts — Secret redaction for run analysis artifacts.
 *
 * Strips API keys, auth headers, and bearer tokens from any value before
 * it is written to disk.  Applied at artifact-write time so the
 * in-memory trace retains full fidelity for repair loops; only the
 * persisted output is sanitised.
 *
 * Default mode: always redact.
 * Full-trace mode (ORCA_FULL_TRACE=true): redaction is skipped so
 * developers can debug auth issues without losing the credential pattern.
 */

// Key-name patterns whose values should be masked
const SECRET_KEYS = /^(api[_-]?key|apikey|x[_-]?api[_-]?key|authorization|auth[_-]?token|token|secret|bearer|password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret)$/i;

// Value patterns that look like credentials regardless of key name
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9\-]{10,}/,          // OpenAI / OpenRouter style
  /\bBearer\s+[A-Za-z0-9\-._~+/]+/i,  // Authorization: Bearer …
  /\bghp_[A-Za-z0-9]{20,}/,           // GitHub PAT
  /\bsk-sp-[A-Za-z0-9]{10,}/,         // DashScope style
];

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.test(key);
}

function containsSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value));
}

const MASK = "[REDACTED]";

/**
 * Deep-clone an arbitrary value, redacting anything that looks like a secret.
 * Returns a new value; the original is not mutated.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (typeof value === "string") {
    return containsSecretValue(value) ? MASK : value;
  }

  if (depth > 8) return "[MaxDepth]";

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? MASK : redactValue(v, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * Returns true when the calling environment has opted in to full traces.
 * In this mode the markdown renderer still writes the file but skips
 * the redaction pass, preserving raw header/key values for debugging.
 */
export function isFullTraceMode(): boolean {
  return process.env["ORCA_FULL_TRACE"] === "true";
}
