# syntax=docker/dockerfile:1.7
# Builds the signed release APK inside Docker (no Node.js / JDK 21 / Android Studio needed on the host).
# The signing key is passed as BuildKit secrets and never lands in an image layer:
#   docker build -f apk/Dockerfile --secret id=keystore,src=<jks> --secret id=keystore_env,src=<env file> .
# apk/build-apk.ps1 does all of this (and creates the key on first run).
FROM eclipse-temurin:21-jdk-jammy

# 1. Copy Node.js 22 + npm + npx directly from official node image
COPY --from=node:22-bookworm-slim /usr/local /usr/local

# 2. Cached Android SDK 35 layer
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    rm -rf /var/lib/apt/lists/*

ENV ANDROID_HOME=/opt/android-sdk
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    curl -fsSL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -o /tmp/tools.zip && \
    unzip -q /tmp/tools.zip -d ${ANDROID_HOME}/cmdline-tools && \
    mv ${ANDROID_HOME}/cmdline-tools/cmdline-tools ${ANDROID_HOME}/cmdline-tools/latest && \
    rm /tmp/tools.zip && \
    yes | ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager --licenses >/dev/null && \
    ${ANDROID_HOME}/cmdline-tools/latest/bin/sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

# 3. Cached npm dependencies layer
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --no-audit --no-fund

# 4. Build web client, sync Capacitor, and assemble the signed release APK
COPY shared shared
COPY client client
ARG VITE_DEFAULT_SERVER=""
ENV VITE_DEFAULT_SERVER=$VITE_DEFAULT_SERVER
RUN npm run build -w client && cd client && npx cap sync android
WORKDIR /src/client/android
RUN --mount=type=secret,id=keystore,required=true \
    --mount=type=secret,id=keystore_env,required=true \
    rm -f local.properties && sed -i 's/\r$//' gradlew && chmod +x gradlew && \
    set -a && . /run/secrets/keystore_env && set +a && \
    TACTIC_KEYSTORE=/run/secrets/keystore ./gradlew --no-daemon assembleRelease && \
    cp app/build/outputs/apk/release/app-release.apk /src/tactic.apk
