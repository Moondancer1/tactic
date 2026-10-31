# Tactic

Self-hosted система ситуационной осведомлённости и PTT-радиосвязи для страйкбола.

- **Тактическая карта**: спутник / OSM / топо, офлайн-кэш тайлов, позиции игроков с азимутом и позывными, APP-6-подобные символы по ролям и отделениям, зоны со штриховкой, маршруты-стрелки, цели OBJ, метки противника с TTL, измерение дистанции/азимута, сетка MGRS.
- **Голос**: Push-To-Talk по каналам *Squad / Platoon All-Call / Command* через LiveKit SFU (WebRTC, Opus + DTX + RED), roger beep и шум шумоподавителя, гарнитура и клавиша громкости как PTT.
- **Чат и донесения**: каналы ALL / SQUAD / CMD, быстрые фразы, SPOT-донесение в один тап (тип, количество, движение, TTL), брифинг (SMEAC), состав и статусы (OK / HIT / MEDIC / OUT), заряд батарей.
- **Клиенты**: PWA для браузера (телефон и ПК, сплит-вид на десктопе) и **Android APK** (Capacitor) с Foreground Service: GPS и голос работают при выключенном экране.
- **Батарея**: режимы *Combat* (экран не гаснет, GPS 2 с) и *Eco* (экран гаснет, GPS 5 с). При заблокированном экране или если игрок стоит на месте GPS переходит на 15 с.

## Стек

| Слой | Технология |
|---|---|
| Backend | Node.js 24, Fastify 5, `@fastify/websocket`, zod, jose (JWT) |
| Хранилище | SQLite (встроенный `node:sqlite`, WAL) — матчи, участники, объекты, чат, треки; Redis — последние позиции и pub/sub |
| Голос | LiveKit SFU (self-hosted) + Coturn (TURN для CGNAT мобильных операторов) |
| Прокси/TLS | Caddy 2 (автоматический Let's Encrypt — нужен для GPS/микрофона в браузере) |
| Клиент | React 18 + Vite + TypeScript, Leaflet, zustand, livekit-client, vite-plugin-pwa |
| Android | Capacitor 7, нативный плагин `Tactical` (Java): Foreground Service `location\|microphone`, FusedLocationProvider, MediaSession, WakeLock |
| CI | GitHub Actions: typecheck + build + smoke + Docker build; сборка APK (debug или подписанный release) |

## Структура

```
tactic/
├── docker-compose.yml          # caddy + app + redis + livekit + coturn
├── .env.example                # переменные окружения
├── deploy/Caddyfile            # TLS, /rtc -> LiveKit, остальное -> app
├── scripts/gen-env.sh          # генерация .env со случайными секретами
├── shared/src/index.ts         # протокол: типы, zod-схемы, права, каналы
├── server/
│   ├── Dockerfile              # собирает сервер + веб-клиент в один образ
│   └── src/
│       ├── index.ts            # Fastify, CORS, статика PWA, graceful shutdown
│       ├── config.ts
│       ├── db.ts               # SQLite: схема и запросы
│       ├── bus.ts              # Redis pub/sub + кэш позиций (или in-process)
│       ├── hub.ts              # комнаты матчей, права, батчинг позиций, TTL
│       ├── ws.ts               # WebSocket: hello/auth, rate limit
│       ├── routes.ts           # REST: join, telemetry, voice, admin, webhook
│       ├── voice.ts            # токены LiveKit по каналам
│       └── auth.ts             # JWT
├── client/
│   ├── capacitor.config.ts
│   ├── vite.config.ts          # PWA manifest + service worker
│   ├── src/
│   │   ├── App.tsx             # сессия, PTT с клавиатуры/гарнитуры
│   │   ├── store.ts            # zustand: состояние, настройки
│   │   ├── lib/
│   │   │   ├── socket.ts       # WS: реконнект, офлайн-очередь
│   │   │   ├── tracking.ts     # GPS-тротлинг, компас, wake lock
│   │   │   ├── voice.ts        # LiveKit: каналы, PTT
│   │   │   ├── audio.ts        # тоны рации, фоновый keep-alive, MediaSession
│   │   │   ├── tiles.ts        # офлайн-тайлы (Cache Storage)
│   │   │   ├── symbols.ts      # военные символы (SVG)
│   │   │   ├── native.ts       # мост к Android-плагину
│   │   │   ├── geo.ts          # дистанция, азимут, MGRS
│   │   │   └── api.ts
│   │   └── components/         # MapView, TopBar, ToolBar, PttButton, Drawer, *Panel
│   └── android/                # Capacitor-проект
│       └── app/src/main/java/io/github/moondancer1/tactic/
│           ├── MainActivity.java     # клавиши громкости/гарнитуры
│           ├── TacticalPlugin.java   # JS-мост
│           └── TacticalService.java  # Foreground Service: GPS, WakeLock, MediaSession
├── docs/
│   ├── DEPLOY.md               # развёртывание на VPS
│   ├── ANDROID.md              # сборка APK, фоновая работа
│   ├── TESTING.md              # проверки перед игрой
│   └── PROTOCOL.md             # WS/REST протокол, webhook
└── .github/workflows/          # ci.yml, android.yml
```

## Быстрый старт (локально)

```bash
npm install
npm run dev
```

Сервер: `http://localhost:3000`. Клиент (Vite): `http://localhost:5173`, проксирует `/api` и `/ws` на сервер. Admin-токен в dev: `dev-admin`.

Создать матч:

```bash
curl -X POST http://localhost:3000/api/admin/matches -H "Authorization: Bearer dev-admin" -H "Content-Type: application/json" -d '{"name":"Op. Nightfall BLUFOR","commandPin":"4321"}'
```

Ответ содержит `code`. Игроки вводят его на экране входа. Роли `leader` и `commander`, а также отделение HQ требуют `commandPin`.

Голос в dev требует LiveKit: `docker run --rm -p 7880:7880 -p 7881:7881 -p 50000-50100:50000-50100/udp livekit/livekit-server:v1.8 --dev --bind 0.0.0.0`. Затем запустите сервер с `LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret`.

## Модель

- **Один матч = одна сторона.** У каждой команды свой код матча. Противник не видит ваших позиций.
- Редактировать зоны, маршруты, цели и брифинг могут только `leader` и `commander`. Метки противника, медика и опасности ставит любой игрок.
- Squad-чат видит только своё отделение и `commander`. CMD видят командиры и HQ.

Дальше: [docs/DEPLOY.md](docs/DEPLOY.md), [docs/ANDROID.md](docs/ANDROID.md), [docs/TESTING.md](docs/TESTING.md), [docs/PROTOCOL.md](docs/PROTOCOL.md).
