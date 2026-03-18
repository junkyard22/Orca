/**
 * test-alibaba.mjs — smoke-test all Alibaba roles using the real encrypted key.
 *
 * Run from apps/desktop/:
 *   node_modules/.bin/electron test-alibaba.mjs
 */

import { app, safeStorage } from "electron";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const require    = createRequire(import.meta.url);

app.setPath("userData", join(app.getPath("appData"), "@clawde", "desktop"));

app.whenReady().then(async () => {
  const settingsFile = join(app.getPath("userData"), "orca-settings.json");
  if (!existsSync(settingsFile)) { console.error("No orca-settings.json"); app.quit(); return; }

  const raw = JSON.parse(readFileSync(settingsFile, "utf-8"));

  function decryptKey(stored) {
    if (!stored) return "";
    if (stored.startsWith("b64:")) return Buffer.from(stored.slice(4), "base64").toString("utf-8");
    if (stored.startsWith("enc:")) return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
    return stored;
  }

  const providers = Object.fromEntries(
    (raw.providers ?? []).map(p => [p.id, { ...p, apiKey: decryptKey(p.apiKey) }])
  );

  const { OpenAICompatAdapter } = require("./dist-main/test-alibaba-tmp.cjs");

  // Test each role that uses Alibaba (prov_6a87)
  const alibabaRoles = Object.entries(raw.roles ?? {})
    .filter(([, r]) => r.providerId === "prov_6a87");

  console.log(`Testing ${alibabaRoles.length} Alibaba role(s)...\n`);

  for (const [roleName, roleConfig] of alibabaRoles) {
    const provider = providers[roleConfig.providerId];
    const adapter = new OpenAICompatAdapter({
      baseUrl:      provider.baseUrl,
      apiKey:       provider.apiKey,
      defaultModel: roleConfig.model,
    });

    process.stdout.write(`  [${roleName.padEnd(14)}] model=${roleConfig.model}  → `);
    try {
      const result = await adapter.complete({
        messages: [{ role: "user", content: "Say hello in one sentence." }],
        temperature: 0.7,
        maxTokens: 32,
        model: roleConfig.model,
      });
      console.log(`✓ ${result.durationMs}ms  "${result.content.slice(0, 60)}"`);
    } catch (err) {
      console.log(`✗ FAILED: ${err.message.slice(0, 120)}`);
    }
  }

  app.quit();
});
