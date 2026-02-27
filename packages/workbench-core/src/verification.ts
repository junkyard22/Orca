/**
 * Verification Layer - Structured tool result outcomes
 * 
 * Phase 1: Wrap existing success/failure into PASS/FAIL structure
 * No new logic. No behavior changes. Just structured results.
 * 
 * WARN semantics not introduced yet - only PASS/FAIL for Phase 1
 */

export type VerificationStatus = 'PASS' | 'FAIL';

export interface VerificationOutcome {
  status: VerificationStatus;
  reason?: string;
  suggestion?: string;
}

/**
 * Tool execution result with verification
 * 
 * Wraps existing tool results with verification metadata.
 * Preserves all existing fields for backward compatibility.
 */
export interface VerifiedToolResult {
  // Verification (new)
  verification: VerificationOutcome;
  
  // Existing fields (preserved)
  success: boolean;      // Legacy field - kept for UI compatibility
  output?: any;          // Tool-specific output
  stdout?: string;       // Process stdout
  stderr?: string;       // Process stderr
  exitCode?: number;     // Process exit code
  error?: string;        // Error message if failed
  duration?: number;     // Execution time in ms
  
  // Metadata
  timestamp?: number;
  toolName?: string;
}

/**
 * Create verification from existing success/failure result
 * 
 * Phase 1: Simple mapping - no new logic
 * - success === true → PASS
 * - success === false → FAIL
 */
export function createVerification(
  success: boolean,
  error?: string,
  exitCode?: number
): VerificationOutcome {
  if (success) {
    return {
      status: 'PASS',
      reason: exitCode !== undefined ? `Exit code ${exitCode}` : undefined
    };
  }
  
  return {
    status: 'FAIL',
    reason: error || (exitCode !== undefined ? `Non-zero exit code: ${exitCode}` : 'Execution failed'),
    suggestion: error ? 'Check error details' : 'Check stderr for details'
  };
}

/**
 * Wrap existing tool result with verification
 * 
 * Phase 1: Pure wrapper - preserves all existing fields
 */
export function wrapToolResult(
  existingResult: any,
  toolName?: string
): VerifiedToolResult {
  const success = existingResult.success !== false; // Default to true for backward compat
  
  return {
    // Add verification
    verification: createVerification(
      success,
      existingResult.error,
      existingResult.exitCode
    ),
    
    // Preserve all existing fields
    success,
    output: existingResult.output,
    stdout: existingResult.stdout,
    stderr: existingResult.stderr,
    exitCode: existingResult.exitCode,
    error: existingResult.error,
    duration: existingResult.duration,
    
    // Metadata
    timestamp: Date.now(),
    toolName: toolName
  };
}

/**
 * Check if result is verified (has verification field)
 */
export function isVerifiedResult(result: any): result is VerifiedToolResult {
  return result && typeof result === 'object' && 'verification' in result;
}

/**
 * Extract verification status from any result format
 * 
 * Handles both legacy (success: boolean) and new (verification: {...}) formats
 */
export function getVerificationStatus(result: any): VerificationStatus {
  if (isVerifiedResult(result)) {
    return result.verification.status;
  }
  
  // Legacy format
  return result.success !== false ? 'PASS' : 'FAIL';
}
