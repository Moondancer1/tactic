# Android APK

APK — тот же веб-клиент в Capacitor WebView плюс нативный плагин `Tactical`.

## Зачем нативный слой

Мобильный браузер усыпляет вкладку при заблокированном экране: GPS останавливается, WebSocket рвётся. APK решает это так:

| Задача | Решение |
|---|---|
| GPS при выключенном экране | `TacticalService` — Foreground Service типа `location`. Он сам получает координаты через FusedLocationProvider и отправляет их в `POST /api/telemetry`. Работает, даже если WebView заморожен. |
| Голос при выключенном экране | Тип сервиса `microphone`, `PARTIAL_WAKE_LOCK`, Wi-Fi lock `LOW_LATENCY`, приоритет рендерера WebView `IMPORTANT`. WebRTC-аудио продолжает идти. |
| PTT с гарнитуры | `MediaSession` в сервисе ловит `HEADSETHOOK` / `MEDIA_PLAY_PAUSE`. Проводная гарнитура даёт down/up, значит работает удержание. Bluetooth чаще шлёт одно нажатие, значит переключение. Режим выбирается в настройках. |
| PTT клавишей громкости | `MainActivity.dispatchKeyEvent`, только при включённом экране. Опция в настройках. |
| Combat mode | `FLAG_KEEP_SCREEN_ON` вместо Wake Lock API. WebView не поддерживает Wake Lock API. |

Тротлинг GPS в сервисе:

- экран включён и игрок движется: интервал Combat (2 с) или Eco (5 с);
- экран выключен или нет смещения больше 8 м за 30 с: интервал Idle (15 с);
- скачок больше 25 м отправляется сразу.

Пока нет сети, сервис хранит до 30 точек и отправит их пачкой.

## Сборка через GitHub Actions (рекомендуется)

Workflow `.github/workflows/android.yml` собирает APK при каждом push в `main` (изменения в `client/` или `shared/`) и по тегу `v*`.

1. Settings → Secrets and variables → Actions → Variables: `TACTIC_SERVER_URL=https://tactic.example.com`. Этот адрес подставится на экран входа.
2. Actions → `android-apk` → Run workflow.
3. Скачайте артефакт `tactic-apk`.

Без секретов собирается debug-APK. Он устанавливается напрямую, но подписан debug-ключом.

### Подписанный release

```bash
keytool -genkeypair -v -keystore tactic.jks -alias tactic -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 tactic.jks
```

Добавьте секреты: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. После тега `git tag v0.1.0 && git push --tags` APK прикрепится к GitHub Release.

Храните `tactic.jks` вне репозитория. Без него нельзя выпустить обновление поверх установленного APK.

## Локальная сборка

На Windows проще всего папка [`apk/`](../apk/README.md): двойной клик по `apk\build-apk.cmd`, результат в `apk\out\tactic-debug.apk`.

Вручную: нужны Android Studio (или SDK 35) и JDK 21.

```bash
npm install
VITE_DEFAULT_SERVER=https://tactic.example.com npm run build -w client
cd client && npx cap sync android && cd android
./gradlew assembleDebug
```

APK: `client/android/app/build/outputs/apk/debug/app-debug.apk`.

Сервер обязан работать по HTTPS: Android запрещает cleartext HTTP по умолчанию.

## Первая настройка на телефоне

1. Установите APK, разрешите установку из неизвестных источников.
2. Войдите в матч. Разрешите геолокацию («При использовании»), микрофон и уведомления.
3. Настройки → BACKGROUND → **ALLOW BACKGROUND RUN**. Это отключает оптимизацию батареи.
4. Xiaomi / Huawei / Samsung: дополнительно включите автозапуск и снимите ограничения фоновой активности для Tactic (см. dontkillmyapp.com).
5. Перед игрой скачайте офлайн-карту: Настройки → OFFLINE MAP. Скачивается текущий слой (SAT, 2D/3D или TOPO); для каждого нужного слоя повторите.

В шторке появится уведомление «Tactic: GPS … · radio listening». Кнопка Stop в уведомлении останавливает сервис.
