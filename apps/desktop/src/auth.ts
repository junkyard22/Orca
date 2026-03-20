import { app } from "electron";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalAuthConfig {
  enabled: boolean;
  passwordHash: string;
  passwordSalt: string;
}

export interface LocalAuthView {
  enabled: boolean;
  hasPassword: boolean;
}

export interface SaveLocalAuthInput {
  enabled: boolean;
  currentPassword?: string;
  newPassword?: string;
  confirmPassword?: string;
}

export type SaveLocalAuthResult =
  | { ok: true; auth: LocalAuthView }
  | { ok: false; error: string };

const DEFAULT_AUTH: LocalAuthConfig = {
  enabled: false,
  passwordHash: "",
  passwordSalt: "",
};

const PASSWORD_KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 8;

function authPath(): string {
  return join(app.getPath("userData"), "orca-auth.json");
}

function derivePasswordHash(password: string, salt: string): string {
  return scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString("hex");
}

function normalizeAuthConfig(raw: unknown): LocalAuthConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AUTH };
  const record = raw as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    passwordHash: typeof record.passwordHash === "string" ? record.passwordHash : "",
    passwordSalt: typeof record.passwordSalt === "string" ? record.passwordSalt : "",
  };
}

export function loadAuthConfig(): LocalAuthConfig {
  const path = authPath();
  if (!existsSync(path)) return { ...DEFAULT_AUTH };

  try {
    return normalizeAuthConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { ...DEFAULT_AUTH };
  }
}

export function getAuthView(config: LocalAuthConfig = loadAuthConfig()): LocalAuthView {
  return {
    enabled: config.enabled,
    hasPassword: Boolean(config.passwordHash && config.passwordSalt),
  };
}

export function verifyAppPassword(
  password: string,
  config: LocalAuthConfig = loadAuthConfig(),
): boolean {
  if (!config.enabled || !config.passwordHash || !config.passwordSalt) {
    return false;
  }

  const expected = Buffer.from(config.passwordHash, "hex");
  const actual = Buffer.from(derivePasswordHash(password, config.passwordSalt), "hex");
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

function writeAuthConfig(config: LocalAuthConfig): void {
  writeFileSync(authPath(), JSON.stringify(config, null, 2), "utf-8");
}

export function saveAuthConfig(input: SaveLocalAuthInput): SaveLocalAuthResult {
  const existing = loadAuthConfig();
  const hasExistingPassword = Boolean(existing.passwordHash && existing.passwordSalt);

  if (!input.enabled) {
    if (hasExistingPassword && existing.enabled) {
      if (!input.currentPassword || !verifyAppPassword(input.currentPassword, existing)) {
        return { ok: false, error: "Current password is required to disable the app lock." };
      }
    }

    writeAuthConfig({ ...DEFAULT_AUTH });
    return { ok: true, auth: getAuthView(DEFAULT_AUTH) };
  }

  const newPassword = input.newPassword ?? "";
  const confirmPassword = input.confirmPassword ?? "";

  if (hasExistingPassword && existing.enabled && newPassword.length === 0) {
    const preserved = { ...existing, enabled: true };
    writeAuthConfig(preserved);
    return { ok: true, auth: getAuthView(preserved) };
  }

  if (hasExistingPassword && existing.enabled) {
    if (!input.currentPassword || !verifyAppPassword(input.currentPassword, existing)) {
      return { ok: false, error: "Current password is required to change the app lock." };
    }
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Use a password with at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  if (newPassword !== confirmPassword) {
    return { ok: false, error: "New password and confirmation do not match." };
  }

  const passwordSalt = randomBytes(16).toString("hex");
  const nextConfig: LocalAuthConfig = {
    enabled: true,
    passwordSalt,
    passwordHash: derivePasswordHash(newPassword, passwordSalt),
  };

  writeAuthConfig(nextConfig);
  return { ok: true, auth: getAuthView(nextConfig) };
}
