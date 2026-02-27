/**
 * Input Validation — Pure validation logic with no VS Code dependencies.
 *
 * The VS Code extension's validation.ts passed vscode.WorkspaceFolder; here
 * we use a plain string workspacePath instead.
 * Extracted from maestro-vscode/src/validation.ts.
 */

import * as path from 'path';
import { Logger } from './interfaces';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class InputValidator {
  private static readonly MAX_TASK_LENGTH = 10000;
  private static readonly MAX_FILE_PATH_LENGTH = 4096;

  private static readonly SUSPICIOUS_PATTERNS = [
    /__import__/i,
    /eval\s*\(/i,
    /exec\s*\(/i,
    /system\s*\(/i,
    /subprocess\./i,
    /os\.(system|popen|spawn)/i,
    /`[^`]*;/,
    /\$\(/,
  ];

  /**
   * Validate a task description.
   */
  static validateTask(task: string, logger?: Logger): { valid: boolean; error?: string } {
    if (!task || !task.trim()) {
      return { valid: false, error: 'Task cannot be empty' };
    }

    if (task.length > this.MAX_TASK_LENGTH) {
      return {
        valid: false,
        error: `Task too long (max ${this.MAX_TASK_LENGTH} characters)`
      };
    }

    for (const pattern of this.SUSPICIOUS_PATTERNS) {
      if (pattern.test(task)) {
        logger?.warn(`Suspicious pattern detected in task: ${pattern}`);
        return {
          valid: false,
          error: `Task contains potentially unsafe content`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Validate a file path.
   * @param workspacePath - Optional absolute path string (replaces vscode.WorkspaceFolder)
   */
  static validateFilePath(filePath: string, workspacePath?: string, logger?: Logger): {
    valid: boolean;
    error?: string;
  } {
    if (!filePath || !filePath.trim()) {
      return { valid: false, error: 'File path cannot be empty' };
    }

    if (filePath.length > this.MAX_FILE_PATH_LENGTH) {
      return {
        valid: false,
        error: `File path too long (max ${this.MAX_FILE_PATH_LENGTH} characters)`
      };
    }

    try {
      const normalized = path.normalize(filePath);

      const sensitivePatterns = [
        /\.ssh[\/\\]id_rsa/,
        /\.aws[\/\\]credentials/,
        /\.env$/,
        /shadow$/,
        /passwd$/
      ];

      for (const pattern of sensitivePatterns) {
        if (pattern.test(normalized)) {
          logger?.error(`Attempt to access sensitive file blocked: ${filePath}`);
          return {
            valid: false,
            error: 'Access to sensitive files is not allowed'
          };
        }
      }

      if (workspacePath) {
        const resolvedPath = path.resolve(normalized);
        if (!resolvedPath.startsWith(workspacePath)) {
          logger?.warn(`File path outside workspace: ${filePath}`);
        }
      }

      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        error: `Invalid file path: ${error.message}`
      };
    }
  }

  /**
   * Validate an API key format.
   */
  static validateApiKey(apiKey: string): { valid: boolean; error?: string } {
    if (!apiKey || !apiKey.trim()) {
      return { valid: false, error: 'API key cannot be empty' };
    }

    if (apiKey.length < 10) {
      return { valid: false, error: 'API key too short' };
    }

    if (apiKey.length > 500) {
      return { valid: false, error: 'API key too long' };
    }

    if (apiKey.includes(' ') && !apiKey.startsWith('Bearer ')) {
      return { valid: false, error: 'API key contains unexpected whitespace' };
    }

    return { valid: true };
  }

  /**
   * Sanitize a task description.
   */
  static sanitizeTask(task: string): string {
    return task.trim().replace(/\s+/g, ' ');
  }

  /**
   * Validate and sanitize all inputs for a task execution.
   */
  static validateTaskInputs(
    task: string,
    filePath?: string,
    workspacePath?: string,
    logger?: Logger,
  ): { task: string; filePath?: string } {
    const taskValidation = this.validateTask(task, logger);
    if (!taskValidation.valid) {
      logger?.error(`Task validation failed: ${taskValidation.error}`);
      throw new ValidationError(taskValidation.error || 'Invalid task');
    }

    const sanitizedTask = this.sanitizeTask(task);

    if (filePath) {
      const pathValidation = this.validateFilePath(filePath, workspacePath, logger);
      if (!pathValidation.valid) {
        logger?.error(`File path validation failed: ${pathValidation.error}`);
        throw new ValidationError(pathValidation.error || 'Invalid file path');
      }
    }

    logger?.info(`Input validation successful | task_length=${sanitizedTask.length} has_file=${!!filePath}`);

    return { task: sanitizedTask, filePath };
  }
}
