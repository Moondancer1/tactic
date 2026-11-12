# Local Tactic launcher on Windows via Docker Desktop.
#   powershell -ExecutionPolicy Bypass -File scripts\local.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\local.ps1 -Down
param([switch]$Down)
$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

# Cryptographically random URL-safe secret (Get-Random is neither random enough nor long enough).
function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return ([Convert]::ToBase64String($b) -replace '[+/=]', '').Substring(0, [Math]::Min(64, [int]($bytes * 1.3)))
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail 'Docker not found. Install Docker Desktop: https://www.docker.com/products/docker-desktop/'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Fail 'Docker Desktop is not running. Open Docker Desktop and wait for Engine running.'
}

$envFile = '.env.local'
if (-not (Test-Path $envFile)) {
  Write-Host '=== First-time Tactic local setup (.env.local) ===' -ForegroundColor Cyan
  $pubUrl = Read-Host 'Enter your domain URL (e.g. https://tactic.example.com) or press Enter for free Quick Tunnel'
  $cfToken = ''
  if ($pubUrl.Trim()) {
    $cfToken = Read-Host 'Enter your Cloudflare Tunnel token (or press Enter if not using named tunnel)'
  }
  $admPass = Read-Host 'Set Admin Panel password, min 10 chars (press Enter to generate a random one)'
  if ($admPass.Trim().Length -lt 10) { $admPass = New-Secret 12 }
  $jwt = New-Secret 48
  $lines = @(
    "PUBLIC_URL=$($pubUrl.Trim())",
    "CLOUDFLARE_TUNNEL_TOKEN=$($cfToken.Trim())",
    "ADMIN_USER=administrator",
    "ADMIN_PASSWORD=$($admPass.Trim())",
    "JWT_SECRET=$jwt"
  )
  Set-Content -Encoding ascii -Path $envFile -Value $lines
  Write-Host "Saved configuration to $envFile" -ForegroundColor Green
}

foreach ($line in (Get-Content $envFile -ErrorAction SilentlyContinue)) {
  $t = $line.Trim()
  if (-not $t -or $t.StartsWith('#')) { continue }
  $idx = $t.IndexOf('=')
  if ($idx -gt 0) {
    $k = $t.Substring(0, $idx).Trim()
    $v = $t.Substring($idx + 1).Trim()
    [System.Environment]::SetEnvironmentVariable($k, $v, 'Process')
  }
}

$compose = @('compose', '-f', 'docker-compose.local.yml')

if ($Down) {
  docker @compose stop app redis caddy
  Write-Host 'Server stopped (tunnel and ./data database preserved).' -ForegroundColor Yellow
  exit 0
}

if ($env:CLOUDFLARE_TUNNEL_TOKEN) {
  $env:TUNNEL_ARGS = "tunnel --no-autoupdate --metrics 0.0.0.0:20241 run --token $($env:CLOUDFLARE_TUNNEL_TOKEN)"
} else {
  $env:TUNNEL_ARGS = 'tunnel --no-autoupdate --metrics 0.0.0.0:20241 --url http://caddy:80'
}

if (-not (Test-Path 'data')) { New-Item -ItemType Directory -Path 'data' | Out-Null }
if (-not (Test-Path 'apk\out')) { New-Item -ItemType Directory -Force -Path 'apk\out' | Out-Null }

Write-Host 'Building and starting containers...' -ForegroundColor Cyan
docker @compose up -d --build --remove-orphans app redis caddy tunnel
if ($LASTEXITCODE -ne 0) { Fail 'docker compose failed, check output above.' }

Write-Host 'Waiting for server healthcheck...'
$ok = $false
for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
  try { Invoke-RestMethod -Uri 'http://localhost:8088/api/health' -TimeoutSec 3 | Out-Null; $ok = $true } catch { Start-Sleep 2 }
}
if (-not $ok) { Fail 'Server did not respond. Logs: docker compose -f docker-compose.local.yml logs app' }

$url = $env:PUBLIC_URL
if (-not $url) {
  for ($i = 0; $i -lt 20 -and -not $url; $i++) {
    $logs = docker @compose logs tunnel 2>&1 | Out-String
    if ($logs -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0] } else { Start-Sleep 2 }
  }
}
if (-not $url) { $url = 'http://localhost:8088' }

Write-Host ''
Write-Host '================ Tactic is running ================' -ForegroundColor Green
Write-Host 'Server URL:'
Write-Host "   $url" -ForegroundColor Yellow
Write-Host "Admin login: $($env:ADMIN_USER) / $($env:ADMIN_PASSWORD)" -ForegroundColor Cyan
Write-Host ''
Write-Host 'Stop server: powershell -ExecutionPolicy Bypass -File scripts\local.ps1 -Down'
