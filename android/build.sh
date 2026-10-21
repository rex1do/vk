#!/usr/bin/env bash
# Сборка APK для Android (магнитолы Teyes и др.) без Gradle — утилитами Android SDK.
# Нужны: JDK 17+, Android SDK с platforms;android-34 и build-tools;35.0.0 (ANDROID_HOME).
# Результат: dist/VKPlayer-Android-<версия>.apk
set -euo pipefail
cd "$(dirname "$0")/.."
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}"
BT="$SDK/build-tools/${ANDROID_BUILD_TOOLS:-35.0.0}"
PLATFORM="$SDK/platforms/android-34/android.jar"
OUT=android/build
VERSION=$(node -p "require('./package.json').version")
IFS=. read -r MA MI PA <<<"$VERSION"
CODE=$((MA * 10000 + MI * 100 + PA))
KEYSTORE="${ANDROID_KEYSTORE:-android/release.keystore}"
KS_PASS="${ANDROID_KEYSTORE_PASS:-vkplayer}"

rm -rf "$OUT" && mkdir -p "$OUT/assets/app" "$OUT/assets/build" "$OUT/classes" "$OUT/dex" dist

# интерфейс — тот же, что в Windows-версии, плюс мост и стили для Android
cp -r shell/. "$OUT/assets/app/"
cp android/web/* "$OUT/assets/app/"
cp build/icon.png "$OUT/assets/build/"
sed "s/@VERSION_CODE@/$CODE/; s/@VERSION_NAME@/$VERSION/" android/AndroidManifest.xml > "$OUT/AndroidManifest.xml"

"$BT/aapt2" compile --dir android/res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/unsigned.apk" -I "$PLATFORM" --manifest "$OUT/AndroidManifest.xml" \
  --min-sdk-version 24 --target-sdk-version 29 --java "$OUT/gen" -A "$OUT/assets" "$OUT/res.zip"

javac -nowarn -source 8 -target 8 -bootclasspath "$PLATFORM" -classpath "$PLATFORM:$BT/core-lambda-stubs.jar" -encoding UTF-8 \
  -d "$OUT/classes" $(find android/src "$OUT/gen" -name '*.java') 2>&1 | grep -v 'warning: \[options\]' || true
[ -f "$OUT/classes/ru/rex1do/vkplayer/MainActivity.class" ] || { echo "javac failed"; exit 1; }
"$BT/d8" --min-api 24 --release --lib "$PLATFORM" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')
(cd "$OUT/dex" && zip -q -j ../unsigned.apk classes.dex)

"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias vkplayer \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=VK Player, O=rex1do"
fi
APK="dist/VKPlayer-Android-$VERSION.apk"
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --ks-key-alias vkplayer --out "$APK" "$OUT/aligned.apk"
"$BT/apksigner" verify "$APK"
echo "$APK"
