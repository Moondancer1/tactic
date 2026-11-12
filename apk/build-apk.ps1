# Build the signed release APK on Windows (local Node + JDK 21 + Android SDK if present, otherwise inside Docker).
#   powershell -ExecutionPolicy Bypass -File apk\build-apk.ps1
#   powershell -ExecutionPolicy Bypass -File apk\build-apk.ps1 -Server https://tactic.example.com
# Output: apk\out\tactic.apk  (served by the server at /tactic.apk)
#
# Signing key: apk\keystore\tactic-release.jks + TACTIC_KEYSTORE_PASSWORD / TACTIC_KEY_ALIAS / TACTIC_KEY_PASSWORD
# in .env.local. Created automatically on first run. BACK THEM UP (e.g. in your private config repo):
# without the same key, phones cannot install updates over the existing app.
param(
  [string]$Server = ''
)
$ErrorActionPreference = 'Continue'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$out = Join-Path $PSScriptRoot 'out'
New-Item -ItemType Directory -Force $out | Out-Null
$apk = Join-Path $out 'tactic.apk'
$envFile = Join-Path $root '.env.local'

function Fail($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Read-EnvFile {
  $vars = @{}
  if (Test-Path $envFile) {
    foreach ($line in (Get-Content $envFile -ErrorAction SilentlyContinue)) {
      if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$') { $vars[$Matches[1]] = $Matches[2] }
    }
  }
  return $vars
}

function New-Secret([int]$len) {
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  $b = New-Object byte[] $len
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return -join ($b | ForEach-Object { $chars[$_ % $chars.Length] })
}

$vars = Read-EnvFile
if (-not $Server) { $Server = $vars['PUBLIC_URL'] }
if ($Server) {
  Write-Host "Default server URL baked into APK: $Server" -ForegroundColor Cyan
} else {
  Write-Host 'Building universal APK (players enter their server URL on first launch)' -ForegroundColor Yellow
}

# ---------- signing key ----------
$keystore = Join-Path $root ($(if ($vars['TACTIC_KEYSTORE_FILE']) { $vars['TACTIC_KEYSTORE_FILE'] } else { 'apk\keystore\tactic-release.jks' }))
if (-not (Test-Path $keystore)) {
  if ($vars['TACTIC_KEYSTORE_PASSWORD']) { Fail "Keystore $keystore is missing but .env.local has its password. Restore the .jks from your backup." }
  Step 'Creating release signing key (first run)'
  New-Item -ItemType Directory -Force (Split-Path $keystore) | Out-Null
  $ksPass = New-Secret 24
  $alias = 'tactic'
  $dname = 'CN=Tactic, O=Tactic, C=AZ'
  $keytool = Get-Command keytool -ErrorAction SilentlyContinue
  if ($keytool) {
    & $keytool.Source -genkeypair -v -storetype PKCS12 -keystore $keystore -alias $alias -keyalg RSA -keysize 4096 -validity 10000 -storepass $ksPass -keypass $ksPass -dname $dname | Out-Null
  } else {
    $dir = Split-Path $keystore
    docker run --rm -v "${dir}:/ks" eclipse-temurin:21-jdk-jammy keytool -genkeypair -storetype PKCS12 -keystore "/ks/$(Split-Path $keystore -Leaf)" -alias $alias -keyalg RSA -keysize 4096 -validity 10000 -storepass $ksPass -keypass $ksPass -dname $dname | Out-Null
  }
  if (-not (Test-Path $keystore)) { Fail 'Could not create the signing key (need keytool or Docker).' }
  Add-Content -Encoding ascii -Path $envFile -Value @(
    '',
    '# Android release signing key (apk\keystore). Back up the .jks AND these values: losing them means',
    '# players must uninstall the app before they can install an update.',
    "TACTIC_KEYSTORE_PASSWORD=$ksPass",
    "TACTIC_KEY_ALIAS=$alias",
    "TACTIC_KEY_PASSWORD=$ksPass"
  )
  Write-Host "Signing key created: $keystore (passwords appended to .env.local) - BACK BOTH UP" -ForegroundColor Yellow
  $vars = Read-EnvFile
}
foreach ($k in 'TACTIC_KEYSTORE_PASSWORD', 'TACTIC_KEY_ALIAS', 'TACTIC_KEY_PASSWORD') {
  if (-not $vars[$k]) { Fail "$k is missing in .env.local" }
}

# ---------- toolchain ----------
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
  $secretEnv = Join-Path ([System.IO.Path]::GetTempPath()) ("tactic-ks-" + [guid]::NewGuid().ToString('N') + '.env')
  # LF line endings: the file is sourced by /bin/sh inside the build.
  [System.IO.File]::WriteAllText($secretEnv, ("TACTIC_KEYSTORE_PASSWORD=$($vars['TACTIC_KEYSTORE_PASSWORD'])`nTACTIC_KEY_ALIAS=$($vars['TACTIC_KEY_ALIAS'])`nTACTIC_KEY_PASSWORD=$($vars['TACTIC_KEY_PASSWORD'])`n"))
  try {
    $env:DOCKER_BUILDKIT = '1'
    docker build -f apk/Dockerfile --build-arg "VITE_DEFAULT_SERVER=$Server" --secret "id=keystore,src=$keystore" --secret "id=keystore_env,src=$secretEnv" -t tactic-apk-builder .
    $code = $LASTEXITCODE
  } finally {
    Remove-Item -Force $secretEnv -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) { Fail 'Docker APK build failed.' }
  $cid = (docker create tactic-apk-builder).Trim()
  docker cp "${cid}:/src/tactic.apk" $apk
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

Step 'Gradle assembleRelease'
$env:TACTIC_KEYSTORE = $keystore
$env:TACTIC_KEYSTORE_PASSWORD = $vars['TACTIC_KEYSTORE_PASSWORD']
$env:TACTIC_KEY_ALIAS = $vars['TACTIC_KEY_ALIAS']
$env:TACTIC_KEY_PASSWORD = $vars['TACTIC_KEY_PASSWORD']
Push-Location client\android
.\gradlew.bat --no-daemon assembleRelease
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail 'Gradle build failed, check output above.' }

Copy-Item -Force (Join-Path $root 'client\android\app\build\outputs\apk\release\app-release.apk') $apk
Write-Host ''
Write-Host "Done: $apk" -ForegroundColor Green
