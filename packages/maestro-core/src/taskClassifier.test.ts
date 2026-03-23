import { describe, it, expect } from "vitest";
import { classifyTask } from "./taskClassifier.js";
import { TaskType } from "./types/orchestration.js";

describe("classifyTask — type", () => {
  it("classifies packaging tasks", () => {
    expect(classifyTask("Build the electron installer").type).toBe(TaskType.PACKAGING);
    expect(classifyTask("Package into an NSIS exe").type).toBe(TaskType.PACKAGING);
    expect(classifyTask("Sign and notarize the app").type).toBe(TaskType.PACKAGING);
  });

  it("classifies infrastructure tasks", () => {
    expect(classifyTask("Set up the GitHub Actions CI/CD pipeline").type).toBe(TaskType.INFRASTRUCTURE);
    expect(classifyTask("Deploy to AWS production server").type).toBe(TaskType.INFRASTRUCTURE);
    expect(classifyTask("Configure Kubernetes cluster").type).toBe(TaskType.INFRASTRUCTURE);
  });

  it("classifies refactor tasks", () => {
    expect(classifyTask("Refactor the database layer").type).toBe(TaskType.REFACTOR);
    expect(classifyTask("Migrate from class components to hooks").type).toBe(TaskType.REFACTOR);
    expect(classifyTask("Restructure the project layout").type).toBe(TaskType.REFACTOR);
  });

  it("classifies small edit tasks", () => {
    expect(classifyTask("Fix typo in the error message").type).toBe(TaskType.SMALL_EDIT);
    expect(classifyTask("Add comment to explain this function").type).toBe(TaskType.SMALL_EDIT);
    expect(classifyTask("Rename variable fromCamel to camelCase").type).toBe(TaskType.SMALL_EDIT);
    expect(classifyTask("Run prettier and fix lint errors").type).toBe(TaskType.SMALL_EDIT);
  });

  it("classifies feature tasks", () => {
    expect(classifyTask("Implement a login endpoint").type).toBe(TaskType.FEATURE);
    expect(classifyTask("Add a new user registration module").type).toBe(TaskType.FEATURE);
    expect(classifyTask("Build the payment service").type).toBe(TaskType.FEATURE);
  });

  it("returns UNKNOWN for unclassified tasks", () => {
    // A completely generic instruction with no matching patterns
    expect(classifyTask("Do the thing with the frobnitz").type).toBe(TaskType.UNKNOWN);
  });

  it("packaging beats infrastructure (checked first)", () => {
    // Both packaging and infra patterns could match, but packaging is tested first
    const result = classifyTask("Build the installer for the Electron desktop app");
    expect(result.type).toBe(TaskType.PACKAGING);
  });
});

describe("classifyTask — multiStep", () => {
  it("detects multi-step via multiple verb phrases", () => {
    const result = classifyTask(
      "Add the feature, implement the handler, create the test, and update the docs",
    );
    expect(result.multiStep).toBe(true);
  });

  it("detects multi-step via numbered list signals", () => {
    const result = classifyTask("1. Fix the bug. 2. Add a test. 3. Deploy.");
    expect(result.multiStep).toBe(true);
  });

  it("detects multi-step via 'and then' connective", () => {
    const result = classifyTask("Create the file and then add the export");
    expect(result.multiStep).toBe(true);
  });

  it("does not flag single-step tasks as multi-step", () => {
    const result = classifyTask("Fix the typo on line 42");
    expect(result.multiStep).toBe(false);
  });
});

describe("classifyTask — estimatedImpact", () => {
  it("returns higher impact for broad/codebase-wide tasks", () => {
    const wide = classifyTask("Refactor the entire codebase to use the new module pattern");
    const narrow = classifyTask("Fix typo");
    expect(wide.estimatedImpact).toBeGreaterThan(narrow.estimatedImpact);
  });

  it("impact is clamped to [0, 1]", () => {
    // Pile on every high-weight keyword to ensure clamp works
    const maxed = classifyTask(
      "Refactor the entire codebase breaking change — redesign and rewrite the whole framework architecture across all multiple files",
    );
    expect(maxed.estimatedImpact).toBeLessThanOrEqual(1);
    expect(maxed.estimatedImpact).toBeGreaterThanOrEqual(0);
  });

  it("returns 0 impact for minimal tasks with no impact keywords", () => {
    const result = classifyTask("Fix typo");
    expect(result.estimatedImpact).toBe(0);
  });
});

describe("classifyTask — shape", () => {
  it("always returns type, estimatedImpact, and multiStep", () => {
    const result = classifyTask("Do something");
    expect(result).toHaveProperty("type");
    expect(result).toHaveProperty("estimatedImpact");
    expect(result).toHaveProperty("multiStep");
  });
});
