# Builds the Android APK (tactic-debug.apk) inside Docker without requiring Node.js, JDK 21, or Android Studio on the host.
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

# 4. Build web client, sync Capacitor, and assemble APK
COPY shared shared
COPY client client
ARG VITE_DEFAULT_SERVER=""
ENV VITE_DEFAULT_SERVER=$VITE_DEFAULT_SERVER
RUN npm run build -w client && cd client && npx cap sync android
WORKDIR /src/client/android
RUN rm -f local.properties && sed -i 's/\r$//' gradlew && chmod +x gradlew && ./gradlew --no-daemon assembleDebug
