[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$archiveRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$manifest = Get-Content -LiteralPath (Join-Path $archiveRoot 'archive-manifest.json') -Raw | ConvertFrom-Json

function Resolve-ArchiveFile([string]$relativePath) {
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $archiveRoot $relativePath))
    if (-not $resolved.StartsWith($archiveRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes rehearsal archive: $relativePath"
    }
    return $resolved
}

foreach ($entry in $manifest.files) {
    if (-not $entry.parts) { continue }
    $target = Resolve-ArchiveFile $entry.path
    if (Test-Path -LiteralPath $target) {
        $existing = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        if ($existing -ne $entry.sha256) { throw "Existing file differs; refusing overwrite: $($entry.path)" }
        Write-Output "Already restored: $($entry.path)"
        continue
    }
    $temporary = $target + '.restoring'
    $output = [System.IO.File]::Open($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    try {
        foreach ($part in $entry.parts) {
            $partPath = Resolve-ArchiveFile $part.path
            if ((Get-Item -LiteralPath $partPath).Length -ne $part.bytes -or
                (Get-FileHash -LiteralPath $partPath -Algorithm SHA256).Hash -ne $part.sha256) {
                throw "Part verification failed: $($part.path)"
            }
            $inputStream = [System.IO.File]::OpenRead($partPath)
            try { $inputStream.CopyTo($output) } finally { $inputStream.Dispose() }
        }
    } finally {
        $output.Dispose()
    }
    if ((Get-Item -LiteralPath $temporary).Length -ne $entry.bytes -or
        (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $entry.sha256) {
        throw "Restored file verification failed: $($entry.path)"
    }
    Move-Item -LiteralPath $temporary -Destination $target
    Write-Output "Restored and SHA-256 verified: $($entry.path)"
}

Write-Output 'Both historical applications are restored. No application was launched.'
