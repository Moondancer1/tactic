# Сборка APK

## Что нужно один раз

1. **Node.js 22+**: https://nodejs.org
2. **Android Studio**: https://developer.android.com/studio. Откройте его один раз, чтобы он скачал Android SDK. JDK 21 входит в Android Studio, отдельно ставить не нужно.

## Сборка

Двойной клик по `build-apk.cmd` или в PowerShell из корня проекта:

```powershell
powershell -ExecutionPolicy Bypass -File apk\build-apk.ps1
```

Чтобы адрес сервера уже стоял на экране входа:

```powershell
powershell -ExecutionPolicy Bypass -File apk\build-apk.ps1 -Server https://tactic.example.com
```

Готовый файл: `apk\out\tactic.apk` (release, подписан вашим ключом). Первая сборка занимает 5–10 минут (Gradle скачивает зависимости), следующие около минуты.

Скрипт сам находит JDK (из `JAVA_HOME` или из Android Studio) и Android SDK (`%LOCALAPPDATA%\Android\Sdk`).

## Установка на телефон

Скопируйте APK на телефон, откройте файл и разрешите установку из неизвестных источников. Дальше по [docs/ANDROID.md](../docs/ANDROID.md#первая-настройка-на-телефоне): разрешения, фоновая работа, офлайн-карта.

При первой сборке создаётся ключ подписи `apk\keystore\tactic-release.jks`, а его пароли дописываются в `.env.local`. **Сохраните оба** (например, в приватный репозиторий): без того же ключа обновление не встанет поверх установленного приложения. Подробнее: [docs/ANDROID.md](../docs/ANDROID.md).
