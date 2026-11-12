# Build Android APK on Windows (uses local Node + Android SDK if present, otherwise builds inside Docker).
#   powershell -ExecutionPolicy Bypass -File apk\build-apk.ps1
#   powershell -ExecutionPolicy Bypass -File apk\build-apk.ps1 -Server https://tactic.example.com
# Output: apk\out\tactic-debug.apk
param(
  [string]$Server = ''
)
$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$apk = Join-Path $out 'tactic-debug.apk'

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

if (-not $Server) {
  $envFile = Join-Path $root '.env.local'
  if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile -ErrorAction SilentlyContinue)) {
      if ($line -match '^\s*PUBLIC_URL\s*=\s*(.+)\s*$') {
        $Server = $Matches[1].Trim()
      }
    }
  }
}
if ($Server) {
  Write-Host "Default server URL baked into APK: $Server" -ForegroundColor Cyan
} else {
  Write-Host 'Building universal APK (players enter their server URL on first launch)' -ForegroundColor Yellow
}

function JavaMajor($jdk) {
  $line = Get-Content "$jdk\release" -ErrorAction SilentlyContinue | Where-Object { $_ -like 'JAVA_VERSION=*' } | Select-Object -First 1
  if ($line -notmatch '"(\d+)(?:\.(\d+))?') { return 0 }
  if ($Matches[1] -eq '1') { return [int]$Matches[2] }
  return [int]$Matches[1]
}

$hasNode = [bool](Get-Command node -ErrorAction SilentlyContinue)
$javaHome = $null
foreach ($cand in @($env:JAVA_HOME, "$env:ProgramFiles\Android\Android Studio\jbr", "$env:LOCALAPPDATA\Programs\Android Studio\jbr")) {
  if ($cand -and (Test-Path "$cand\bin\java.exe") -and (JavaMajor $cand) -ge 21) { $javaHome = $cand; break }
}
$sdk = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk") | Where-Object { $_ -and (Test-Path "$_\platforms") } | Select-Object -First 1

if (-not ($hasNode -and $javaHome -and $sdk)) {
  Step 'Local Node.js / JDK 21 / Android SDK not found - building APK via Docker...'
  Set-Location $root
  docker build -f apk/Dockerfile --build-arg "VITE_DEFAULT_SERVER=$Server" -t tactic-apk-builder .
  if ($LASTEXITCODE -ne 0) { Fail 'Docker APK build failed.' }
  $cid = (docker create tactic-apk-builder).Trim()
  docker cp "${cid}:/src/client/android/app/build/outputs/apk/debug/app-debug.apk" $apk
  docker rm -f $cid *> $null
  Write-Host ''
  Write-Host "Done: $apk" -ForegroundColor Green
  exit 0
}

$env:JAVA_HOME = $javaHome
Write-Host "JDK: $javaHome"
$env:ANDROID_HOME = $sdk
Set-Content -Encoding ascii -Path (Join-Path $root 'client\android\local.properties') -Value ("sdk.dir=" + ($sdk -replace '\\', '\\'))
Write-Host "Android SDK: $sdk"

Set-Location $root
if (-not (Test-Path 'node_modules')) {
  Step 'npm install'
  npm install
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed.' }
}

Step 'Building web client'
$env:VITE_DEFAULT_SERVER = $Server
npm run build -w client
if ($LASTEXITCODE -ne 0) { Fail 'Client build failed.' }

Step 'Capacitor sync'
Push-Location client
npx cap sync android
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail 'cap sync failed.' }

Step 'Gradle assembleDebug'
Push-Location client\android
.\gradlew.bat --no-daemon assembleDebug
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail 'Gradle build failed, check output above.' }

Copy-Item -Force (Join-Path $root 'client\android\app\build\outputs\apk\debug\app-debug.apk') $apk
Write-Host ''
Write-Host "Done: $apk" -ForegroundColor Green
