// Unpacked local staging only: reuse the release configuration without creating
// an installer, portable release, or modifying either Summit kit.
import { build, Platform, Arch } from "electron-builder";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(desktop, "package.json"), "utf8"));
const output = resolve(desktop, "release", `Orca-Summit-Staging-${pkg.version}`);
if (existsSync(output)) throw new Error(`Staging output already exists: ${output}`);

execFileSync(process.execPath, ["build-main.mjs"], { cwd: desktop, stdio: "inherit" });
await build({
  projectDir: desktop,
  targets: Platform.WINDOWS.createTarget(["dir"], Arch.x64),
  config: {
    ...pkg.build,
    appId: "com.clawde.orca.summit-staging",
    productName: "Orca Summit Staging",
    extraMetadata: { name: "orca-summit-staging", productName: "Orca Summit Staging" },
    directories: { ...pkg.build.directories, output },
    // Use the already-installed runtime; no Electron download is needed.
    electronDist: resolve(desktop, "node_modules", "electron", "dist"),
    win: { ...pkg.build.win, target: [{ target: "dir", arch: ["x64"] }] },
  },
});
copyFileSync(resolve(desktop, "dist-main", "build-info.json"), resolve(output, "build-info.json"));
console.log(`Staging application: ${resolve(output, "win-unpacked", "Orca Summit Staging.exe")}`);
console.log(`Isolated profile: ${resolve(output, "profile")}`);
