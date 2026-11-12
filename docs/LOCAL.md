# Локальный запуск на своём компьютере

Тест без сервера и домена: всё работает на ПК, телефоны подключаются по временному HTTPS-адресу `https://*.trycloudflare.com` (Cloudflare quick tunnel, без регистрации).

## Windows

1. Установите [Docker Desktop](https://www.docker.com/products/docker-desktop/) и запустите его (внизу должно быть «Engine running»).
2. В PowerShell, в папке проекта:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\local.ps1
   ```

   Первый запуск собирает образ 3–10 минут. В конце скрипт печатает адрес сервера, код тестового матча и PIN командира (`4321`).
3. На телефоне: откройте APK (или адрес в Chrome), в поле сервера вставьте напечатанный адрес `https://….trycloudflare.com`, введите код матча.

Остановить:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\local.ps1 -Down
```

## Ограничения

- Адрес туннеля новый при каждом запуске, в APK его нужно ввести заново.
- Карта, позиции и чат работают с любого интернета. **Голос** работает, только когда телефоны в той же Wi-Fi сети, что и ПК: аудио идёт напрямую на ПК (UDP 40000–40100, TCP 7881), TURN в локальном режиме не поднимается. Если Windows спросит про доступ Docker к сети, разрешите для частных сетей.
- Секреты в `docker-compose.local.yml` тестовые. Для игры используйте сервер: [DEPLOY.md](DEPLOY.md).

## macOS / Linux

```bash
LAN_IP=192.168.1.50 docker compose -f docker-compose.local.yml up -d --build
docker compose -f docker-compose.local.yml logs tunnel | grep trycloudflare.com
```

`LAN_IP` — IP компьютера в Wi-Fi сети.
