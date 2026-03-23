# Orca 0.1.0 Ship Checklist

Release date target: March 20, 2026

Artifacts verified from this workspace build:

- `apps/desktop/release/Orca Setup 0.1.0.exe`
- `apps/desktop/release/Orca 0.1.0.exe`

SHA256:

- `Orca Setup 0.1.0.exe`: `63f19080932f8ab1bf69ac160b5fe6a83dfff0ebe09e0fdb3362e0dadc49cd91`
- `Orca 0.1.0.exe`: `6b20d7a1b030fe4fc2574ecdbcbe4fc494efd31ed6e9aecf93c64460a3a80671`

Build validation already completed in this repo:

- `npm.cmd test` passed for all workspaces
- `npm.cmd run build` passed at the repo root
- `npm.cmd run dist` passed in `apps/desktop`

## Pre-publish

- [x] Decide whether to ship unsigned binaries or sign both `.exe` files
      → Decision: ship unsigned for 0.1.0. RELEASE-NOTES-0.1.0.md already
        includes the SmartScreen disclaimer. Code signing revisit deferred to 0.2.0.
- [x] Confirm the version is still `0.1.0` in `apps/desktop/package.json`
- [x] Commit the packaging fix in `apps/desktop/build-main.mjs`
- [x] Commit the ignore cleanup in `.gitignore`
- [x] Update or ignore the stale `secretary-core` reference in `ROADMAP.md`
      → Fixed in commit 79fec1d: replaced with dewey-core, updated desktop status.

## Installer Smoke Test

Run on a clean Windows x64 machine or VM.

1. Launch `Orca Setup 0.1.0.exe`.
2. Install to a non-default path once to verify the NSIS custom-directory flow.
3. Confirm the app starts after install.
4. Close the window.
5. Confirm the app hides to tray instead of exiting.
6. Reopen from the tray menu.
7. Use the tray menu `Quit` action and confirm the process exits.

Expected result:

- Installer completes without missing-file errors
- App icon loads correctly
- Tray behavior works on first launch

## Portable Smoke Test

1. Launch `Orca 0.1.0.exe`.
2. Confirm first-run boot succeeds without installer dependencies.
3. Close and relaunch the app.
4. Confirm settings and session data survive relaunch.

Expected result:

- No crash on startup
- No missing resource errors
- Local app data is created normally

## Core Product Smoke Test

1. Open Settings.
2. Add one provider.
3. Fetch models for that provider.
4. Assign a brain model and save settings.
5. Pick a workspace folder.
6. Send a simple prompt that should not require tools.
7. Send a prompt that should require tool approval, such as reading files from the chosen workspace.
8. Use `Stop` during one running task.

Expected result:

- Settings save and Orca re-initializes cleanly
- Streaming output appears while a task is running
- Tool approval dialog appears when tools are requested
- Abort stops the active run cleanly

## Feature Smoke Test

1. Attach one text file and one image to a message.
2. Send the message and confirm the attachments appear in the chat transcript.
3. Open session history from the sidebar.
4. Reload a previous session.
5. Delete a previous session.
6. Enable the local app lock with a password of at least 8 characters.
7. Lock the app and verify settings/history/actions are blocked until unlock.
8. Toggle the theme.

Expected result:

- Attachments are reflected in the outgoing prompt context
- History loads and deletes correctly
- Lock and unlock work without corrupting settings
- Theme choice persists across restarts

## Publish Steps

1. Upload both `.exe` artifacts.
2. Upload or publish the SHA256 hashes.
3. Add release notes from `apps/desktop/RELEASE-NOTES-0.1.0.md`.
4. If unsigned, warn users that Windows SmartScreen may appear.
5. Tag the shipping commit.

## If You Want One More Check Before Publish

Run this exact sequence after the final commit:

1. `npm.cmd test`
2. `npm.cmd run build`
3. `cd apps/desktop`
4. `npm.cmd run dist`

