import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronState = vi.hoisted(() => ({
  userDataPath: "",
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => electronState.userDataPath),
  },
}));

import {
  getAuthView,
  loadAuthConfig,
  saveAuthConfig,
  verifyAppPassword,
} from "./auth";

describe("local auth", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "orca-auth-"));
    electronState.userDataPath = userDataDir;
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("creates a local app lock and verifies the password", () => {
    const result = saveAuthConfig({
      enabled: true,
      newPassword: "correct horse battery staple",
      confirmPassword: "correct horse battery staple",
    });

    expect(result).toEqual({
      ok: true,
      auth: { enabled: true, hasPassword: true },
    });
    expect(verifyAppPassword("correct horse battery staple")).toBe(true);
    expect(verifyAppPassword("wrong password")).toBe(false);

    const stored = JSON.parse(readFileSync(join(userDataDir, "orca-auth.json"), "utf-8")) as {
      enabled: boolean;
      passwordHash: string;
      passwordSalt: string;
    };
    expect(stored.enabled).toBe(true);
    expect(stored.passwordHash).not.toBe("correct horse battery staple");
    expect(stored.passwordSalt.length).toBeGreaterThan(0);
  });

  it("requires the current password to disable an existing app lock", () => {
    saveAuthConfig({
      enabled: true,
      newPassword: "keep this local",
      confirmPassword: "keep this local",
    });

    expect(saveAuthConfig({ enabled: false })).toEqual({
      ok: false,
      error: "Current password is required to disable the app lock.",
    });

    expect(
      saveAuthConfig({
        enabled: false,
        currentPassword: "keep this local",
      }),
    ).toEqual({
      ok: true,
      auth: { enabled: false, hasPassword: false },
    });
    expect(verifyAppPassword("keep this local")).toBe(false);
  });

  it("keeps the current password when re-saving an enabled lock without a new password", () => {
    saveAuthConfig({
      enabled: true,
      newPassword: "existing local secret",
      confirmPassword: "existing local secret",
    });

    const result = saveAuthConfig({
      enabled: true,
      newPassword: "",
      confirmPassword: "",
    });

    expect(result).toEqual({
      ok: true,
      auth: { enabled: true, hasPassword: true },
    });
    expect(verifyAppPassword("existing local secret")).toBe(true);
    expect(getAuthView(loadAuthConfig())).toEqual({ enabled: true, hasPassword: true });
  });
});
