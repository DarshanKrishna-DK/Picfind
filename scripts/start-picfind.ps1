param([switch]$Safe, [switch]$NoBrowser)
foreach ($flag in $args) {
  switch -Exact ($flag) {
    '--safe' { $Safe = [switch]$true }
    '--no-browser' { $NoBrowser = [switch]$true }
    default { throw "Unknown launcher argument: $flag. Use -Safe or --safe, and -NoBrowser or --no-browser." }
  }
}
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $root
try {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 LTS from https://nodejs.org, then run Start-PicFind.bat again.' }
  $major = & node.exe -p 'process.versions.node.split(String.fromCharCode(46))[0]'
  if ($major -ne '24') { throw "PicFind requires Node.js 24 LTS. Found major version $major." }
  if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd is missing. Repair the Node.js 24 installation.' }
  if (-not (Test-Path -LiteralPath (Join-Path $root '.env'))) {
    Copy-Item -LiteralPath (Join-Path $root '.env.example') -Destination (Join-Path $root '.env')
    Write-Host 'Created .env from the example. Complete the provider settings in docs/SETUP-AND-LAUNCH.md.' -ForegroundColor Yellow
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules/vite/bin/vite.js'))) {
    Write-Host 'Installing locked dependencies. This needs an internet connection.'
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check your network connection and run the launcher again.' }
  }
  $arguments = @((Join-Path $root 'scripts/dev.mjs'))
  if ($Safe) { $arguments += '--safe' }
  if (-not $NoBrowser) { $arguments += '--open' }
  Write-Host 'Starting PicFind web + API. Keep this window open. Press Ctrl+C to stop both.' -ForegroundColor Cyan
  & node.exe @arguments
  exit $LASTEXITCODE
} catch {
  Write-Host "PicFind could not start: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Setup and troubleshooting: docs/SETUP-AND-LAUNCH.md'
  exit 1
}
