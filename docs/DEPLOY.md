# Развёртывание на VPS

Цель: `https://tactic.example.com` с TLS, голосом и TURN на одном VPS.

## 1. Требования

- VPS: 1–2 vCPU, 1–2 GB RAM, Ubuntu 22.04/24.04 или Debian 12. На 30–60 игроков хватает 2 vCPU.
- Публичный IPv4.
- Домен с A-записью на этот IP.
- Открытые порты:

| Порт | Протокол | Сервис |
|---|---|---|
| 80, 443 | TCP | Caddy (HTTPS, ACME) |
| 443 | UDP | Caddy (HTTP/3) |
| 7881 | TCP | LiveKit ICE/TCP (fallback) |
| 50000–50100 | UDP | LiveKit RTP медиа |
| 3478 | UDP + TCP | Coturn |
| 49160–49200 | UDP | Coturn relay |

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
sudo ufw allow 7881/tcp
sudo ufw allow 50000:50100/udp
sudo ufw allow 3478
sudo ufw allow 49160:49200/udp
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

Скрипт создаёт `.env` с правами `600` и печатает `ADMIN_TOKEN`. Сохраните токен: он нужен для создания матчей. Проверьте, что `PUBLIC_IP` в `.env` совпадает с публичным IP сервера.

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

Ожидаемый ответ: `{"ok":true,...,"voice":true,...}`.

## 5. Создание матча

Через UI: экран входа, ссылка «HQ: create a match», ввести `ADMIN_TOKEN`.

Через API:

```bash
curl -X POST https://tactic.example.com/api/admin/matches \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Op. Nightfall — BLUFOR","commandPin":"4321"}'
```

Создайте отдельный матч для каждой стороны. Завершить матч: `POST /api/admin/matches/<id>/end`.

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
| `NET ERR` в шапке, голоса нет | Закрыты UDP 50000–50100 или 7881; неверный `PUBLIC_IP`. Смотрите `docker compose logs livekit`. |
| Голос есть по Wi-Fi, нет по LTE | Не работает TURN: проверьте 3478 и 49160–49200/udp, `docker compose logs coturn`. |
| Браузер не даёт GPS/микрофон | Страница открыта не по HTTPS. |
| `Location permission denied` | Разрешите геолокацию для сайта в настройках браузера. |
