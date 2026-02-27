/**
 * Miranda Core — Text Section Validation
 * Validate that structured text contains all required headings.
 */

import type { ValidationResult } from "../pipeline/types.js";

const DEFAULT_MIN_LENGTH = 200;

/**
 * Validate that text contains all required headings and meets minimum length.
 */
export function validateTextSections(
  raw: string,
  requiredHeadings: string[],
  minLength: number = DEFAULT_MIN_LENGTH
): ValidationResult {
  // Empty or whitespace check
  if (!raw || !raw.trim()) {
    return {
      valid: false,
      errors: ["Output is empty or whitespace-only"],
    };
  }

  const text = raw.trim();
  const errors: string[] = [];

  // Check minimum length
  if (text.length < minLength) {
    errors.push(
      `Output is too short (${text.length} chars, minimum ${minLength})`
    );
  }

  // Check for required headings (case-insensitive)
  const textLower = text.toLowerCase();
  for (const heading of requiredHeadings) {
    const headingLower = heading.toLowerCase();
    if (!textLower.includes(headingLower)) {
      errors.push(`Missing required heading: "${heading}"`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, data: text };
}
