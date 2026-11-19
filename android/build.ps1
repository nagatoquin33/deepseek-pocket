# =============================================================================
# Android APK 手工构建（无需 Gradle / Android Studio）
#   aapt2 compile+link → javac → d8 → zip classes.dex → zipalign → apksigner
# 用法： powershell -ExecutionPolicy Bypass -File android\build.ps1
# 产物： android\dist\DeepSeekPocket-<package.json version>.apk
# =============================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # deepseek-mobile
try {
    $pkgText = [System.IO.File]::ReadAllText((Join-Path $root 'package.json'), [System.Text.Encoding]::UTF8)
    $APP_VERSION = ($pkgText | ConvertFrom-Json).version
} catch {
    $APP_VERSION = '1.0.0'
}
if (-not $APP_VERSION) { $APP_VERSION = '1.0.0' }
$app = Join-Path $PSScriptRoot 'app'
$sdk = 'D:\ai\apk-build\sdk'
# 优先使用 build-tools 36（其 D8 修复了旧版对 JDK 21 字节码的解析崩溃）
$btCandidates = @()
$btCandidates += Get-ChildItem (Join-Path $sdk 'build-tools-36') -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
$btCandidates += Get-ChildItem (Join-Path $sdk 'build-tools') -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
$bt = $btCandidates | Where-Object { Test-Path (Join-Path $_ 'lib\d8.jar') } | Select-Object -First 1
if (-not $bt) { throw '未找到 build-tools（需要 aapt2 与 lib\d8.jar）' }
$platformDir = Get-ChildItem (Join-Path $sdk 'platforms') -Directory | Select-Object -First 1
$androidJar = Join-Path $platformDir.FullName 'android.jar'
$javaHome = (Get-Command javac).Source | Split-Path -Parent | Split-Path -Parent
$env:JAVA_HOME = $javaHome

$build = Join-Path $PSScriptRoot 'build'
$dist = Join-Path $PSScriptRoot 'dist'
$assets = Join-Path $app 'assets\www'
$gen = Join-Path $build 'gen'
$classes = Join-Path $build 'classes'
$dexDir = Join-Path $build 'dex'

Write-Host "== SDK ==" -ForegroundColor Cyan
Write-Host "  build-tools: $bt"
Write-Host "  android.jar: $androidJar"
Write-Host "  JAVA_HOME  : $env:JAVA_HOME"

# ---------------------------------------------------------------- 清理
if (Test-Path $build) { Remove-Item $build -Recurse -Force }
New-Item -ItemType Directory -Force -Path $build, $dist, $gen, $classes, $dexDir, $assets | Out-Null

# ---------------------------------------------------------------- 1. 资源与图标
Write-Host "== 同步前端资源 ==" -ForegroundColor Cyan
robocopy (Join-Path $root 'public') $assets /MIR /NFL /NDL /NJH /NJS /NP /XF '*.map' | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败：$LASTEXITCODE" }
Write-Host ("  资产文件数: " + (Get-ChildItem $assets -Recurse -File).Count)

Write-Host "== 生成启动图标 ==" -ForegroundColor Cyan
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Join-Path $root 'public\icons\icon-512.png'))
$sizes = @{ 'mdpi' = 48; 'hdpi' = 72; 'xhdpi' = 96; 'xxhdpi' = 144; 'xxxhdpi' = 192 }
foreach ($k in $sizes.Keys) {
    $dir = Join-Path $app "res\mipmap-$k"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $bmp = New-Object System.Drawing.Bitmap($sizes[$k], $sizes[$k])
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.SmoothingMode = 'HighQuality'
    $g.DrawImage($src, 0, 0, $sizes[$k], $sizes[$k])
    $g.Dispose()
    $bmp.Save((Join-Path $dir 'ic_launcher.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
$src.Dispose()

# ---------------------------------------------------------------- 2. aapt2
Write-Host "== aapt2 编译资源 ==" -ForegroundColor Cyan
$aapt2 = Join-Path $bt 'aapt2.exe'
$resZip = Join-Path $build 'res.zip'
& $aapt2 compile --dir (Join-Path $app 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }

$baseApk = Join-Path $build 'base.apk'
Write-Host "== aapt2 链接资源 ==" -ForegroundColor Cyan
& $aapt2 link `
    -o $baseApk `
    -I $androidJar `
    --manifest (Join-Path $app 'AndroidManifest.xml') `
    -A (Join-Path $app 'assets') `
    --java $gen `
    --min-sdk-version 24 `
    --target-sdk-version 34 `
    --version-code 1 `
    --version-name $APP_VERSION `
    --auto-add-overlay `
    $resZip
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

# ---------------------------------------------------------------- 2.5 修正 assets 路径分隔符
# Windows 版 aapt2 会把 assets 条目写成 "assets/www\..."，设备上 AssetManager 只认 "/"，
# 这里在 zip 层把反斜杠条目重命名为正斜杠。
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fixZip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
$badNames = @()
foreach ($e in $fixZip.Entries) { if ($e.FullName.Contains('\')) { $badNames += $e.FullName } }
foreach ($oldName in $badNames) {
    $oldEntry = $fixZip.GetEntry($oldName)
    $newName = $oldName.Replace('\', '/')
    $newEntry = $fixZip.CreateEntry($newName, [System.IO.Compression.CompressionLevel]::Optimal)
    $src = $oldEntry.Open()
    $dst = $newEntry.Open()
    $src.CopyTo($dst)
    $dst.Dispose()
    $src.Dispose()
    $oldEntry.Delete()
}
$fixZip.Dispose()
Write-Host ("  修正 assets 条目: " + $badNames.Count)

# ---------------------------------------------------------------- 3. javac
Write-Host "== javac 编译 Java ==" -ForegroundColor Cyan
$javaSources = @()
$javaSources += @(Get-ChildItem (Join-Path $app 'src') -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$javaSources += @(Get-ChildItem $gen -Recurse -Filter R.java | ForEach-Object { $_.FullName })
Write-Host ("  源文件: " + $javaSources.Count)
& javac -encoding UTF-8 -source 8 -target 8 -nowarn -classpath $androidJar -d $classes @javaSources
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

# ---------------------------------------------------------------- 4. d8
Write-Host "== d8 生成 dex ==" -ForegroundColor Cyan
$classFiles = @(Get-ChildItem $classes -Recurse -Filter *.class | ForEach-Object { $_.FullName })
$d8 = Join-Path $bt 'lib\d8.jar'
& java -cp $d8 com.android.tools.r8.D8 --release --lib $androidJar --min-api 24 --output $dexDir @classFiles
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

# ---------------------------------------------------------------- 5. 合并 dex 进 APK
Write-Host "== 打包 classes.dex ==" -ForegroundColor Cyan
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dex = Join-Path $dexDir 'classes.dex'
if (-not (Test-Path $dex)) { throw "未生成 classes.dex" }
$zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
$entry = $zip.CreateEntry('classes.dex', [System.IO.Compression.CompressionLevel]::NoCompression)
$stream = $entry.Open()
$bytes = [System.IO.File]::ReadAllBytes($dex)
$stream.Write($bytes, 0, $bytes.Length)
$stream.Dispose()
$zip.Dispose()

# ---------------------------------------------------------------- 6. 签名
Write-Host "== 签名 ==" -ForegroundColor Cyan
$ks = Join-Path $PSScriptRoot 'debug.keystore'
if (-not (Test-Path $ks)) {
    & keytool -genkeypair -v -keystore $ks -alias deepseek -keyalg RSA -keysize 2048 `
        -validity 10000 -storepass android -keypass android `
        -dname "CN=DeepSeek Pocket, OU=Personal, O=DeepSeekPocket, L=Shanghai, C=CN" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "keytool 失败" }
}
$zipalign = Join-Path $bt 'zipalign.exe'
$aligned = Join-Path $build 'aligned.apk'
& $zipalign -f 4 $baseApk $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }

$apk = Join-Path $dist "DeepSeekPocket-$APP_VERSION.apk"
$apksigner = Join-Path $bt 'apksigner.bat'
& $apksigner sign --ks $ks --ks-pass pass:android --key-pass pass:android `
    --v1-signing-enabled true --v2-signing-enabled true --out $apk $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner 失败" }

Write-Host "== 校验 ==" -ForegroundColor Cyan
& $apksigner verify --print-certs $apk
& $aapt2 dump badging $apk | Select-Object -First 4

$size = [math]::Round((Get-Item $apk).Length / 1MB, 2)
Write-Host "`n[OK] $apk  (${size} MB)" -ForegroundColor Green
