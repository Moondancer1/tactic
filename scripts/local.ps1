# Локальный запуск Tactic на Windows через Docker Desktop.
#   powershell -ExecutionPolicy Bypass -File scripts\local.ps1          # запуск
#   powershell -ExecutionPolicy Bypass -File scripts\local.ps1 -Down    # остановить
param([switch]$Down)
$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')
$compose = @('compose', '-f', 'docker-compose.local.yml')

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail 'Docker не найден. Установите Docker Desktop: https://www.docker.com/products/docker-desktop/'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop не запущен. Откройте его и дождитесь "Engine running".' }

# IPv4 адаптера с маршрутом по умолчанию (Wi-Fi или Ethernet)
$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
  Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
if (-not $route) { Fail 'Нет сетевого подключения.' }
$lan = (Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 | Select-Object -First 1).IPAddress
$env:LAN_IP = $lan

if ($Down) { docker @compose down; exit 0 }

Write-Host "IP компьютера в локальной сети: $lan"
Write-Host 'Сборка и запуск (первый раз 3-10 минут)...' -ForegroundColor Cyan
docker @compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail 'docker compose завершился с ошибкой, смотрите вывод выше.' }

Write-Host 'Жду сервер...'
$ok = $false
for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
  try { Invoke-RestMethod -Uri 'http://localhost:8088/api/health' -TimeoutSec 3 | Out-Null; $ok = $true } catch { Start-Sleep 2 }
}
if (-not $ok) { Fail 'Сервер не ответил. Логи: docker compose -f docker-compose.local.yml logs app' }

Write-Host 'Жду HTTPS-адрес туннеля...'
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  $log = (docker @compose logs tunnel 2>&1 | Out-String)
  $m = [regex]::Matches($log, 'https://[a-z0-9-]+\.trycloudflare\.com')
  if ($m.Count -gt 0) { $url = $m[$m.Count - 1].Value } else { Start-Sleep 2 }
}
if (-not $url) { Fail 'Туннель не поднялся. Логи: docker compose -f docker-compose.local.yml logs tunnel' }

$match = $null
try {
  $match = Invoke-RestMethod -Method Post -Uri 'http://localhost:8088/api/admin/matches' `
    -Headers @{ Authorization = 'Bearer local-admin' } -ContentType 'application/json' `
    -Body '{"name":"Local test","commandPin":"4321"}'
} catch { Write-Host "Матч не создан: $_" -ForegroundColor Yellow }

Write-Host ''
Write-Host '================ Tactic запущен ================' -ForegroundColor Green
Write-Host "Адрес сервера (вставить в APK и открыть в браузере):"
Write-Host "   $url" -ForegroundColor Yellow
if ($match) {
  Write-Host "Код матча:        $($match.code)" -ForegroundColor Yellow
  Write-Host 'PIN командира:    4321'
}
Write-Host 'Admin token:      local-admin'
Write-Host ''
Write-Host 'Голос работает, когда телефоны в той же Wi-Fi сети, что и компьютер.'
Write-Host 'Адрес туннеля меняется при каждом перезапуске.'
Write-Host 'Остановить: powershell -ExecutionPolicy Bypass -File scripts\local.ps1 -Down'
