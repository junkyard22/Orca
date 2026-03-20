# Orca 0.1.0 Release Notes

Release date: March 20, 2026

Orca 0.1.0 is the first packaged Windows desktop release of the Orca coding assistant.

## Highlights

- Windows desktop packaging now produces both an installer and a portable executable.
- The desktop app supports configurable providers and per-role model assignment.
- Role configuration includes fallback models, token limits, temperature, and optional thinking controls.
- Streaming task output is shown live in the chat UI while a run is in progress.
- Tool calls can be reviewed and approved from the desktop app before execution.
- Session history can be browsed, reopened, and deleted from the sidebar.
- API keys are stored with Electron `safeStorage` when available, with a compatibility fallback for environments without OS-backed encryption.
- The app includes a local lock screen with password protection for desktop access.
- Workspace selection is built into settings so tool runs stay scoped to the chosen codebase.
- Users can attach files and images to chat prompts.

## Supported Provider Types

- OpenRouter
- Ollama
- DeepSeek
- SiliconFlow
- OpenAI-compatible endpoints
- Anthropic
- Z.ai
- Alibaba DashScope compatible mode
- Custom provider endpoints

## Release Artifacts

- `apps/desktop/release/Orca Setup 0.1.0.exe`
- `apps/desktop/release/Orca 0.1.0.exe`

SHA256:

- `Orca Setup 0.1.0.exe`: `63f19080932f8ab1bf69ac160b5fe6a83dfff0ebe09e0fdb3362e0dadc49cd91`
- `Orca 0.1.0.exe`: `6b20d7a1b030fe4fc2574ecdbcbe4fc494efd31ed6e9aecf93c64460a3a80671`

## Validation

- All workspace tests passed before packaging.
- The repo build passed before packaging.
- Desktop packaging completed successfully from `apps/desktop`.

## Known Limitations

- This release is packaged for Windows x64.
- The generated executables are currently unsigned unless you sign them before publishing.
- First run still requires provider setup before Orca can execute model-backed tasks.
