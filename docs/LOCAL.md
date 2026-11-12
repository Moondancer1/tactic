# Локальный запуск на своём компьютере

Сервер работает на ПК, телефоны подключаются по HTTPS через Cloudflare Tunnel: свой домен (именованный туннель) или временный адрес `https://*.trycloudflare.com` (quick tunnel, без регистрации). Порты на роутере открывать не нужно.

## Windows

1. Установите [Docker Desktop](https://www.docker.com/products/docker-desktop/) и запустите его (внизу должно быть «Engine running»).
2. В PowerShell, в папке проекта:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\local.ps1
   ```

   При первом запуске скрипт спросит домен и токен туннеля (Enter — временный адрес) и создаст `.env.local` со **случайными** `JWT_SECRET` и паролем админа. Сборка образа занимает 3–10 минут. В конце скрипт печатает адрес сервера и логин админа.
3. Откройте адрес → «Админ-панель» → создайте сеть (с паролем) и бойцов. PIN командира показан в списке сетей.
4. На телефоне: APK (`https://<адрес>/tactic.apk`) или адрес в Chrome → позывной и пароль → сеть → пароль сети.

Остановить (база в `./data` сохраняется):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local.ps1 -Down
```

## Ограничения

- Временный адрес `trycloudflare.com` меняется при каждом перезапуске туннеля: в APK его нужно ввести заново. Для постоянной игры используйте свой домен (именованный туннель) или VPS: [DEPLOY.md](DEPLOY.md).
- Caddy слушает только `127.0.0.1:8088`. Доступ по `http://<IP ПК>` из Wi-Fi закрыт намеренно: без HTTPS браузер не даёт ни GPS, ни микрофон, а APK принимает только HTTPS.
- `.env.local` содержит секреты: держите его вне публичного git (он в `.gitignore`).

## macOS / Linux

```bash
cp .env.local.example .env.local   # впишите случайные JWT_SECRET (≥32) и ADMIN_PASSWORD (≥10)
set -a; . ./.env.local; set +a
docker compose -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.local.yml logs tunnel | grep trycloudflare.com
```
