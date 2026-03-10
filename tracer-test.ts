/**
 * Greets a user by name.
 * @param name - The name of the person to greet.
 * @returns A greeting message in the format "Hello, {name}".
 * @example
 * ```ts
 * const message = greet("Alice");
 * console.log(message); // "Hello, Alice"
 * ```
 */
export function greet(name: string): string {
  return `Hello, ${name}`;
}

// Test functionality using Jest-style assertions
import { describe, it, expect } from '@jest/globals';

describe('greet function', () => {
  it('should return a greeting for a given name', () => {
    expect(greet("Alice")).toBe("Hello, Alice");
    expect(greet("Bob")).toBe("Hello, Bob");
  });

  it('should handle empty string input', () => {
    expect(greet("")).toBe("Hello, ");
  });
});
