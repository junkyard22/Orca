# Summit rehearsal archive — 2026-10-08

This directory commits the reports, evidence, and **both historical staging
applications** that were previously only in the ignored `apps/desktop/release/`
directory. It was archived on 2026-10-09 on
`fix/live-rehearsal-remediation-1.6.1`.

| Directory | Contents |
|---|---|
| `live-rehearsal-2026-10-08/` | Failed rehearsal report, redacted traces/receipts, screenshots, timeline, source difference, original/final demo workspace evidence, and supporting scripts/logs |
| `preflight-1.6.1/` | Offline smoke results, screenshots, preservation checks, and supporting script/logs |
| `remediation-1.6.1/` | Full workspace test logs, all three Pappy corpus logs, contract check, and preservation checks |
| `Orca-Summit-Staging-1.6.1/` | Staging application from source commit `33d02633b8e490c8cda8c20bcd98e7a34e23b403`, original build metadata, artifact hashes, and staging report |
| `Orca-Summit-Staging-1.6.1-initial-09147476/` | Initial staging application from source commit `09147476bec33fbbad342240336d6daf1db3d590`, with original build metadata |

## Restore the executables

All application files are committed here. Each large `Orca Summit Staging.exe`
is stored in five parts of at most 48 MiB so the branch can be transferred
through regular Git without an oversized individual object or external LFS
storage. All other application files are ordinary tracked files. Git attributes
preserve the exact bytes on Windows and other platforms.

From the repository root, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\doc\rehearsals\2026-10-08\Restore-StagingExecutables.ps1
```

The script validates each part, reconstructs both executables in their respective
`win-unpacked` directories, and checks the original SHA-256 hashes. It refuses
to overwrite a different existing executable and does not launch either app.
Reconstructed executables and application profiles are ignored locally.

`archive-manifest.json` records every archived file's SHA-256 and size,
plus the part hashes for split executables. Sanitized evidence also records
the original hash and size for comparison. All application files retain their
original bytes. No original release file was moved, rebuilt, or overwritten.

## Interpretation and excluded private data

These binaries predate remediation commit
`507abde92869321d7e45acca4b6eddc58786312f`. They are preserved historical
artifacts and do not contain the new budget, approval, or baseline guards.
Read the [remediation report](../../../docs/ORCA_1_6_1_LIVE_REMEDIATION.md)
and the [failed rehearsal report](live-rehearsal-2026-10-08/REHEARSAL-REPORT.md)
before evaluating them. No new Live AI rehearsal was authorized or performed.

Machine-specific `profile/` directories, encrypted settings snapshots,
browser encryption metadata, and private user-context backups are excluded.
Their exclusion overrides the older staging report's instruction to copy an
existing profile. On another computer, a historical app would create its own
fresh profile; no credentials are included in this archive.

Archived reports and traces have personal context, user-home paths, and
credential fields redacted. Some UTF-16 evidence logs were normalized to UTF-8
during sanitization. The manifest identifies each changed evidence file.
Credential-pattern scans cover the archived evidence, application binaries,
and executable parts; screenshots were reviewed visually. The scan summary
is recorded in `security-review.json` without storing any credential values.
The unchanged binaries include public credential examples and historical
developer paths in bundled test fixtures, plus Chromium diagnostic examples.
Those scan matches were reviewed; they are not configured account credentials.

Supporting automation scripts are retained as historical evidence only.
They were not rerun, and this archive does not authorize using them to conduct
another Live AI rehearsal or grant presenter approvals.
