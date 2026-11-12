# Развёртывание на VPS

Цель: `https://tactic.example.com` с TLS на одном VPS. Голос идёт через тот же HTTPS/WebSocket — отдельные UDP-порты не нужны.

## 1. Требования

- VPS: 1–2 vCPU, 1–2 GB RAM, Ubuntu 22.04/24.04 или Debian 12. На 30–60 игроков хватает 2 vCPU.
- Публичный IPv4.
- Домен с A-записью на этот IP.
- Открытые порты:

| Порт | Протокол | Сервис |
|---|---|---|
| 80, 443 | TCP | Caddy (HTTPS, ACME) |
| 443 | UDP | Caddy (HTTP/3) |

## 2. Подготовка сервера

```bash
sudo apt update && sudo apt install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

Файрвол:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw allow 443/udp
sudo ufw enable
```

У облачных провайдеров (Hetzner, AWS, Yandex Cloud) откройте те же порты в security group.

## 3. Код и секреты

```bash
git clone https://github.com/Moondancer1/tactic.git
cd tactic
chmod +x scripts/gen-env.sh
./scripts/gen-env.sh tactic.example.com you@example.com
```

Скрипт создаёт `.env` с правами `600` (случайные `JWT_SECRET`, `ADMIN_PASSWORD`, `ADMIN_TOKEN`) и печатает логин админ-панели. В production сервер не запустится с примерами из `.env.example`.

## 4. Запуск

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f caddy app
```

Caddy получает сертификат за 10–60 секунд. Проверка:

```bash
curl https://tactic.example.com/api/health
```

Ожидаемый ответ: `{"ok":true,"ts":...}`.

## 4a. Установка одной командой (в т.ч. на сервер, где уже есть другие контейнеры)

`scripts/install.sh` не трогает чужие контейнеры. Скрипт проверяет RAM, диск, занятые порты и DNS, генерирует `.env`, добавляет правила ufw (если ufw включён), поднимает стек и проверяет `/api/health`.

```bash
sudo ./scripts/install.sh --check tactic.example.com you@example.com   # только проверка, ничего не меняет
sudo ./scripts/install.sh         tactic.example.com you@example.com   # установка / обновление
```

Режим выбирается сам:

- **standalone**: 80/443 свободны, наш Caddy их занимает и сам получает сертификат Let's Encrypt.
- **proxy**: 80/443 уже заняты другим прокси (nginx, traefik и т.п.). Наш Caddy слушает `127.0.0.1:8088` (порт задаёт `TACTIC_HTTP_PORT`) по HTTP. Существующий прокси терминирует TLS для поддомена и проксирует на этот порт. Для ручного запуска: `docker compose -f docker-compose.yml -f docker-compose.proxy.yml up -d --build`.

Пример для nginx на хосте (сертификат: `certbot --nginx -d tactic.example.com`):

```nginx
server {
    server_name tactic.example.com;
    listen 443 ssl http2;
    # ssl_certificate ... (certbot)
    client_max_body_size 10m;
    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 3600s;
    }
}
```


## 5. Создание сетей

Через UI: экран входа → «Админ-панель» → логин/пароль из `.env` → «Новая сеть». Пароль сети обязателен, PIN командира генерируется автоматически и показан в списке сетей.

Через API:

```bash
curl -X POST https://tactic.example.com/api/admin/matches \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Op. Nightfall — BLUFOR","password":"<пароль сети BLUFOR>"}'
# ответ содержит commandPin
```

Создайте отдельную сеть для каждой стороны и раздайте каждой стороне только её пароль. Завершить сеть: `POST /api/admin/matches/<id>/end`.

## 6. Обновление

```bash
git pull
docker compose up -d --build app
```

Активные клиенты переподключаются сами. Сервис-воркер PWA обновляется при следующем открытии.

## 7. Резервные копии

Данные лежат в томе `tactic_app_data` (`/data/tactic.sqlite`).

```bash
docker compose exec app node -e "new (require('node:sqlite').DatabaseSync)('/data/tactic.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\")"
docker compose cp app:/data/backup.sqlite ./backup-$(date +%F).sqlite
```

## 8. Разбор после игры (AAR)

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://tactic.example.com/api/admin/matches/<id>/tracks > tracks.json
```

Формат: `{memberId: {callsign, squad, points: [[lat, lon, ts], ...]}}`. Точки пишутся раз в 10 секунд на игрока.

## Масштабирование

Один инстанс `app` держит сотни WebSocket-соединений. Redis уже передаёт события между инстансами. Однако SQLite локален для инстанса. Для нескольких реплик `app` замените `db.ts` на PostgreSQL.

## Диагностика

| Симптом | Причина |
|---|---|
| Красная точка и `NET…` в шапке не исчезают | WebSocket не проходит через прокси: нужен `Upgrade`/`Connection` (см. пример nginx). `docker compose logs caddy app`. |
| `app` перезапускается | В логе `... is a public example value`: в `.env` остались значения из примера. Перегенерируйте `./scripts/gen-env.sh`. |
| «Канал занят» при PTT | На этом канале уже говорит другой боец (рация полудуплексная). |
| Браузер не даёт GPS/микрофон | Страница открыта не по HTTPS. |
| `Location permission denied` | Разрешите геолокацию для сайта в настройках браузера. |
