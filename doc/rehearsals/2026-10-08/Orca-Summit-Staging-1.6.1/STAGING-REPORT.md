ORCA 1.6.1 local staging passed preflight and the packaged offline smoke test. It is ready for one supervised Find & Fix Live AI rehearsal when separately authorized. Provider authentication, account model access, network behavior, and real model output remain untested: this work made no provider API calls.

Application: `win-unpacked/Orca Summit Staging.exe` beside this report. Launch that executable directly; keep `win-unpacked` and its sibling `profile` together. There is no installer or portable release package. The app was closed after testing, and normal launches do not enable the temporary test debugger ports or network interception.

Source: `recovery/summit-demo-mode-1.6`, exact commit `33d02633b8e490c8cda8c20bcd98e7a34e23b403`, clean working tree at build time. Both `build-info.json` beside this report and the copy inside `app.asar` record that commit. The earlier recovery commit `47baa77fcef9267c32b6a2684ebf96bed9d0a621` and the first preflight commit `09147476bec33fbbad342240336d6daf1db3d590` remain ancestors. The initial staging artifact is preserved separately as `../Orca-Summit-Staging-1.6.1-initial-09147476`.

The staging build reuses the existing esbuild and electron-builder configuration, the installed Electron 41.10.5 runtime, bundled demo project, ASAR integrity, and Electron fuses. Its separate product name and app ID are `Orca Summit Staging` and `com.clawde.orca.summit-staging`. Settings, browser data, Dewey context, pipeline traces, database, demo workspace, and run analysis use the sibling `profile` directory. The production settings file and the encrypted profile metadata required to decrypt its unchanged keys were copied into that profile. No keys were printed, re-entered, or changed. Production auth configuration was not imported into staging.

Demo Mode supplies an empty MCP server list before bootstrap, even when GitHub MCP and Desktop Commander are enabled in saved settings. It also withholds the GitHub token from the runtime environment. The normal configuration applies outside Demo Mode; the existing disabled-server filter still applies. Regression tests prove no marker process launches in Demo Mode or for disabled servers, and an enabled control process launches outside Demo Mode. Existing execution-time permissions remain strict in Demo Mode.

Anthropic does not document `enable_thinking` as a supported field. Its compatibility API documents `thinking` and generally ignores unsupported fields; there is no documented guarantee that `enable_thinking` controls Claude thinking. The smallest correction omits that field for direct Anthropic providers and custom endpoints at `api.anthropic.com`, in both completion and streaming requests, including request-level overrides. Other providers retain their existing field behavior. Anthropic now uses its API default thinking behavior; the role's `enableThinking` toggle does not control Anthropic. This deliberately avoids adding model-specific thinking modes or token budgets. [Anthropic compatibility documentation](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk).

The existing temperature compatibility fix remains active. No further request-body incompatibility was identified offline. Documented compatibility-layer limitations remain, including ignored `reasoning_effort`, `response_format`, and function `strict`, and lack of returned Claude thinking. ORCA's execution-time permissions are enforced locally and do not depend on the provider's function `strict`. Account-specific model availability and credentials cannot be validated without a later authorized request.

Read-only settings audit:

| Setting | Finding / action |
| --- | --- |
| `prov_d833` | Anthropic, `https://api.anthropic.com/v1`; encrypted key loaded successfully. |
| `prov_edd8` | OpenRouter; encrypted key loaded successfully. |
| Brain / reviewer | `prov_d833`, `claude-opus-5-5`. |
| Utility / strong_model | `prov_d833`, `claude-sonnet-5-5`. |
| Narrator / cheap_model | `prov_d833`, `claude-haiku-5-5`. |
| Debugger | Unassigned; the existing runtime falls back to Brain. Recommended before rehearsal: assign Debugger to `prov_d833` / `claude-sonnet-5-5` to make Find & Fix worker selection explicit. |
| Legacy `coder_strong` | References missing `prov_b942`; remove or reassign if retaining this inactive legacy entry. The current desktop runtime uses `strong_model` instead. |
| Legacy `coder_cheap` | Associates an OpenAI model with Anthropic; remove or reassign if retaining this inactive legacy entry. The current runtime uses `cheap_model` instead. |
| Demo Mode / pipeline | Demo Mode is enabled. Saved `showPipeline:false` is preserved; Demo Mode forces pipeline visibility for display only. |

No active provider ID is missing. No settings edit is necessary for Offline Demo. No active-role correction is required for the targeted rehearsal using the existing Brain fallback; the explicit Debugger assignment and legacy cleanup above are recommended and were not applied.

Regression results:

| Suite | Result |
| --- | --- |
| Desktop | 307 passed, 23 files. Includes request bodies, MCP startup, Demo Mode, offline playback, routing, Pappy integration, and strict permissions. |
| Miranda | 163 passed, 1 skipped, 8 files. |
| MCP client | 44 passed, 1 file. |
| ORCA core | 248 passed, 15 files. |
| Workbench | 55 passed, 2 files. |
| Dewey | 32 passed, 2 files. |
| Total | 849 passed, 1 skipped. |

Miranda TypeScript compilation and both unpacked staging builds succeeded. Desktop and affected persistence/request suites were rerun after the final source changes. Test discovery now excludes `release/**`, whose packaged demo fixture is intentionally broken and is verified separately by the offline scenario tests.

Packaged smoke results: startup, isolated settings/profile loading, encrypted credential loading without exposure, Demo Mode and Offline Demo selection, Find & Fix playback, expanded pipeline visualization, and simulated Pappy verdict display all passed. The scenario finished with `PASS`, 4 of 4 acceptance criteria, and 5 visible Pappy checks. There were 29 process samples, zero newly detected MCP/Docker/npx processes, zero provider fetch attempts, zero HTTP(S) renderer requests, and zero renderer exceptions. HTTP(S) requests were blocked and main-process fetch attempts were intercepted during the smoke test. Pappy's verdict is explicitly labelled simulated; this was not a real AI repair or live verification.

Evidence: `../preflight-1.6.1/offline-smoke.json`, `startup.png`, `pipeline.png`, `pappy-verdict.png`, `preservation-check.json`, and the smoke script/logs. The final preservation check found no changes in 48 protected files, including production settings/auth, production encryption metadata/context, and the inventoried Summit kit/patch files. `main` remains at `0058052a28d5ee28ec01fc4aeac130fccacc69f6`. No original kit or installed application was replaced. No push, merge, Live AI run, API spending, installer creation, or release packaging was performed.
