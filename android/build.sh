#!/usr/bin/env bash
# =============================================================================
# Android APK 构建（Linux / macOS / GitHub Actions，无需 Gradle）
#   aapt2 compile+link → javac → d8 → zip classes.dex → zipalign → apksigner
# 用法： bash android/build.sh
# 产物： android/dist/DeepSeekPocket-<version>.apk
# 依赖： JDK 17+、Android SDK（build-tools + platforms/android-34）
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT_DIR="$ROOT"
APP="$ROOT/android/app"
BUILD="$ROOT/android/build"
DIST="$ROOT/android/dist"
VERSION_NAME="${VERSION_NAME:-$(node -p "require(process.env.ROOT_DIR + '/package.json').version" 2>/dev/null || echo 1.0.0)}"
VERSION_CODE="${VERSION_CODE:-${GITHUB_RUN_NUMBER:-1}}"

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [ -z "$SDK" ] && [ -d /usr/local/lib/android/sdk ]; then SDK=/usr/local/lib/android/sdk; fi
if [ -z "$SDK" ]; then echo "错误：未找到 Android SDK，请设置 ANDROID_SDK_ROOT"; exit 1; fi

BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)"
PLATFORM="$(ls -d "$SDK"/platforms/android-* 2>/dev/null | sort -V | tail -1 || true)"
JAR="$PLATFORM/android.jar"
[ -n "$BT" ] && [ -f "$JAR" ] || { echo "错误：缺少 build-tools 或 platform android.jar"; exit 1; }
command -v javac >/dev/null || { echo "错误：缺少 javac（JDK 17+）"; exit 1; }

echo "== SDK =="
echo "  build-tools: $BT"
echo "  android.jar: $JAR"

rm -rf "$BUILD" "$DIST"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$DIST"

# ---------------------------------------------------------------- 1. 前端资源
echo "== 同步前端资源 =="
rm -rf "$APP/assets/www"
mkdir -p "$APP/assets/www"
( cd "$ROOT/public" && tar -cf - --exclude='node_modules' --exclude='*.map' . ) \
  | ( cd "$APP/assets/www" && tar -xf - )
echo "  资产文件数: $(find "$APP/assets/www" -type f | wc -l | tr -d ' ')"

# ---------------------------------------------------------------- 2. 资源
echo "== aapt2 编译资源 =="
"$BT/aapt2" compile --dir "$APP/res" -o "$BUILD/res.zip"

echo "== aapt2 链接资源 =="
DEBUG_FLAG=""
if [[ "${DEBUG_WEBVIEW:-0}" == 1 ]]; then DEBUG_FLAG="--debug-mode"; fi
"$BT/aapt2" link \
  $DEBUG_FLAG \
  -o "$BUILD/base.apk" \
  -I "$JAR" \
  --manifest "$APP/AndroidManifest.xml" \
  -A "$APP/assets" \
  --java "$BUILD/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay \
  "$BUILD/res.zip"

# ---------------------------------------------------------------- 3. Java
echo "== javac =="
mapfile -t SRCS < <(find "$APP/src" -name '*.java'; find "$BUILD/gen" -name 'R.java')
javac -encoding UTF-8 -source 8 -target 8 -nowarn -classpath "$JAR" -d "$BUILD/classes" "${SRCS[@]}"

# ---------------------------------------------------------------- 4. dex
echo "== d8 =="
mapfile -t CLASSES < <(find "$BUILD/classes" -name '*.class')
java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 \
  --release --lib "$JAR" --min-api 24 --output "$BUILD/dex" "${CLASSES[@]}"

# ---------------------------------------------------------------- 5. 合并 dex
echo "== 打包 classes.dex =="
( cd "$BUILD/dex" && zip -q "$BUILD/base.apk" classes.dex )

# ---------------------------------------------------------------- 6. 签名
echo "== zipalign + 签名 =="
"$BT/zipalign" -f 4 "$BUILD/base.apk" "$BUILD/aligned.apk"

KS="$ROOT/android/debug.keystore"
ALIAS="${KEY_ALIAS:-deepseek}"
STORE_PASS="${KEYSTORE_PASSWORD:-android}"
KEY_PASS="${KEY_PASSWORD:-$STORE_PASS}"

if [ -n "${KEYSTORE_BASE64:-}" ]; then
  echo "$KEYSTORE_BASE64" | base64 -d > "$BUILD/release.keystore"
  KS="$BUILD/release.keystore"
  echo "  使用仓库 secrets 中的签名证书"
elif [ ! -f "$KS" ]; then
  echo "  未提供签名证书，生成一次性调试证书"
  keytool -genkeypair -keystore "$KS" -alias "$ALIAS" -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
    -dname "CN=DeepSeek Pocket" >/dev/null 2>&1
fi

OUT="$DIST/DeepSeekPocket-${VERSION_NAME}.apk"
"$BT/apksigner" sign \
  --ks "$KS" --ks-pass "pass:$STORE_PASS" --key-pass "pass:$KEY_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$OUT" "$BUILD/aligned.apk"

echo "== 校验 =="
"$BT/apksigner" verify --print-certs "$OUT" | head -3
"$BT/aapt2" dump badging "$OUT" | head -4
ls -lh "$OUT"
echo "[OK] $OUT"
