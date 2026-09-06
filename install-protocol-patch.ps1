[CmdletBinding(SupportsShouldProcess=$true)]
param(
    [Parameter(Mandatory=$true)]
    [string]$RepoPath
)

$ErrorActionPreference = 'Stop'
$RepoPath = (Resolve-Path $RepoPath).Path
$Source = Join-Path $PSScriptRoot 'protocol-patch\scripts'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Backup = Join-Path $PSScriptRoot "protocol-backup-$Stamp"

$Files = @(
    'manager.js',
    'run-agent.js',
    'verify.js',
    'lib\manifest.cjs'
)

foreach ($Relative in $Files) {
    $From = Join-Path $Source $Relative
    $To = Join-Path (Join-Path $RepoPath 'scripts') $Relative
    if (-not (Test-Path $From)) { throw "Patch file not found: $From" }

    if (Test-Path $To) {
        $BackupFile = Join-Path $Backup $Relative
        New-Item -ItemType Directory -Force -Path (Split-Path $BackupFile) | Out-Null
        Copy-Item $To $BackupFile -Force
    }

    if ($PSCmdlet.ShouldProcess($To, "Install BarsaAgent protocol patch")) {
        New-Item -ItemType Directory -Force -Path (Split-Path $To) | Out-Null
        Copy-Item $From $To -Force
    }
}

Write-Host "Patch installed. Backup: $Backup"
Write-Host "Verify with: node scripts/manager.js status --json"
