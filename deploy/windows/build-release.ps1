[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $Version.Contains('..') -or $Version.EndsWith('.')) {
  throw 'Invalid release version.'
}
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory already exists.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("clarity-windows-release-" + [guid]::NewGuid().ToString('N'))
$workspace = Join-Path $tempRoot 'workspace'
$release = Join-Path $tempRoot 'release'
$app = Join-Path $release 'app'
$runtime = Join-Path $release 'runtime'
New-Item -ItemType Directory -Path (Join-Path $workspace 'apps/sync-service/dist'), (Join-Path $workspace 'libs/contracts/dist'), $runtime -Force | Out-Null
try {
  Push-Location $repoRoot
  try {
    if ((node --version) -ne 'v22.20.0') { throw 'Build requires Node v22.20.0.' }
    pnpm exec turbo run build --filter=@clarity/sync-service...
    if ($LASTEXITCODE -ne 0) { throw 'Workspace service build failed.' }
    Copy-Item apps/sync-service/package.json (Join-Path $workspace 'apps/sync-service/package.json')
    Copy-Item apps/sync-service/dist/* (Join-Path $workspace 'apps/sync-service/dist') -Recurse
    Copy-Item libs/contracts/package.json (Join-Path $workspace 'libs/contracts/package.json')
    Copy-Item libs/contracts/dist/* (Join-Path $workspace 'libs/contracts/dist') -Recurse
    Copy-Item pnpm-lock.yaml, pnpm-workspace.yaml $workspace
    Set-Content -Path (Join-Path $workspace 'package.json') -Value '{"name":"clarity-release-workspace","private":true,"packageManager":"pnpm@12.3.4"}'
    Push-Location $workspace
    try {
      pnpm --filter @clarity/sync-service deploy --prod --legacy --offline $app
      if ($LASTEXITCODE -ne 0) { throw 'Production workspace deploy failed.' }
    } finally { Pop-Location }
  } finally { Pop-Location }

  # Keep only executable code, runtime metadata, and production dependencies.
  Get-ChildItem -LiteralPath $app -Force | Where-Object {
    $_.Name -notin @('dist', 'node_modules', 'package.json')
  } | Remove-Item -Recurse -Force

  $base = 'https://nodejs.org/dist/v22.20.0'
  $archiveName = 'node-v22.20.0-win-x64.zip'
  $archive = Join-Path $tempRoot $archiveName
  $manifest = Join-Path $tempRoot 'SHASUMS256.txt'
  Invoke-WebRequest "$base/$archiveName" -OutFile $archive
  Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile $manifest
  $line = Get-Content $manifest | Where-Object { $_ -match ("\s" + [regex]::Escape($archiveName) + '$') } | Select-Object -First 1
  if (-not $line) { throw 'Node archive checksum missing from official manifest.' }
  $expectedHash = ($line -split '\s+')[0].ToLowerInvariant()
  $actualHash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw 'Node archive checksum mismatch.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $tempRoot
  Copy-Item (Join-Path $tempRoot 'node-v22.20.0-win-x64/node.exe') (Join-Path $runtime 'node.exe')
  Set-Content -NoNewline -Path (Join-Path $release 'RELEASE_VERSION') -Value $Version
  @("node=v22.20.0", "node_target=win-x64", "node_archive_sha256=$expectedHash") | Set-Content (Join-Path $release 'BUILD_INFO')

  $wrapperLock = Get-Content -Raw (Join-Path $PSScriptRoot 'WinSW.lock.json') | ConvertFrom-Json
  $wrapperDownload = Join-Path $tempRoot $wrapperLock.artifact
  Invoke-WebRequest -Uri $wrapperLock.url -OutFile $wrapperDownload
  $wrapperHash = (Get-FileHash $wrapperDownload -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($wrapperHash -ne $wrapperLock.sha256) { throw 'WinSW checksum mismatch.' }
  Add-Content -Path (Join-Path $release 'BUILD_INFO') -Value "winsw=$($wrapperLock.version)`nwinsw_sha256=$wrapperHash"
  Copy-Item $wrapperDownload (Join-Path $release 'ClaritySyncService.exe')
  Copy-Item (Join-Path $PSScriptRoot 'ClaritySyncService.xml') (Join-Path $release 'ClaritySyncService.xml')
  Copy-Item (Join-Path $PSScriptRoot 'WinSW.lock.json') $release

  $entry = Join-Path $app 'dist/main.js'
  if (-not (Test-Path $entry)) { throw 'Compiled service entry missing from deploy output.' }
  if (-not (Test-Path (Join-Path $app 'node_modules/@clarity/contracts/dist'))) { throw 'Compiled workspace dependencies missing from deploy output.' }
  & (Join-Path $runtime 'node.exe') $entry --config (Join-Path $tempRoot 'missing-config.json') 2>$null
  if ($LASTEXITCODE -ne 78) { throw "Compiled service smoke launch returned $LASTEXITCODE; expected 78." }
  New-Item -ItemType Directory -Path (Split-Path -Parent $OutputDirectory) -Force | Out-Null
  Move-Item -LiteralPath $release -Destination $OutputDirectory
  Write-Output "Built Windows x64 release $Version at $OutputDirectory"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
