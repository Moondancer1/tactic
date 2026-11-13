# Протокол

Источник истины: [`shared/src/index.ts`](../shared/src/index.ts). Все входящие сообщения валидируются zod.

## Токены

| Токен | Где берётся | Срок | Для чего |
|---|---|---|---|
| **тикет** (`typ:u`) | `POST /api/auth/verify` | 7 дней | список сетей и вход в сеть; заменяет хранение пароля на устройстве |
| **сессия** (`typ:s`) | `POST /api/auth/join` | 24 ч, продлевается при каждом WS-подключении (`self.token`) | WebSocket, телеметрия, выход |

Оба токена содержат `uid` и `tv` (token_version пользователя). Смена пароля, КИК и удаление бойца увеличивают `tv` — все его токены сразу становятся недействительными.

## REST

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| GET | `/api/health` | — | `{ok, ts}` |
| POST | `/api/auth/verify` | — | `{callsign, password}` → `{user, networks, ticket}`. 10 ошибок / 15 мин на пару «позывной + адрес клиента» |
| GET | `/api/networks` | тикет | список активных сетей (без кодов) |
| POST | `/api/auth/join` | тикет | `{matchId, matchPassword?}` → `{token, self, match}`. 8 неверных паролей сети / 15 мин |
| POST | `/api/leave` | сессия | выйти из сети |
| POST | `/api/telemetry` | сессия | позиция или массив (до 50) от Android-сервиса. `401` — сессия отозвана, `410` — сеть завершена или боец из неё вышел |
| GET | `/tactic.apk` | — | подписанный release-APK |
| GET | `/api/admin/matches` | admin | сети, включая PIN командира |
| POST | `/api/admin/matches` | admin | `{name, password (≥4), commandPin? (6–12 цифр), code?}`; без PIN — случайный 6-значный |
| POST | `/api/admin/matches/:id/end` | admin | завершить сеть, отключить клиентов (`4004`) |
| GET | `/api/admin/matches/:id/tracks` | admin | треки для разбора |
| POST | `/api/admin/matches/:id/events` | admin | webhook от имени `HQ-BOT`: `chat`, `marker.*`, `zone.*`, `route.*`, `briefing.set` |
| GET / POST | `/api/admin/users` | admin | список / создать или обновить бойца (`password` ≥ 6; обновление сбрасывает его сессии) |
| POST | `/api/admin/users/:callsign/kick` | admin | отключить и отозвать все токены |
| DELETE | `/api/admin/users/:callsign` | admin | удалить аккаунт (и отключить) |

Admin auth: `Authorization: Bearer ADMIN_USER:ADMIN_PASSWORD` (не-латиница — `u8.<base64>`) или `Bearer ADMIN_TOKEN`. 10 неверных попыток блокируют адрес клиента на 15 минут (`429`).

### Webhook-примеры

Объявление всем:

```bash
curl -X POST https://tactic.example.com/api/admin/matches/$ID/events \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"t":"chat","channel":"all","text":"ENDEX через 10 минут"}'
```

Цель захвачена (например, от электронного флага):

```bash
curl -X POST https://tactic.example.com/api/admin/matches/$ID/events \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"t":"marker.upsert","marker":{"id":"obj-alpha","kind":"objective","label":"ALPHA","lat":55.7512,"lon":37.6184,"status":"captured"}}'
```

## WebSocket `/ws`

Первое сообщение клиента: `{"t":"hello","token":"<сессия>"}` в течение 10 секунд. Ответ: `snapshot` со всем состоянием сети, затем `self` с новым токеном.

Клиент → сервер: `pos`, `heading`, `status`, `squad.set`, `leave`, `voice.tx`, `chat`, `marker.upsert`, `marker.delete`, `zone.upsert`, `zone.delete`, `route.upsert`, `route.delete`, `briefing.set`, `ping`.

Сервер → клиент: `snapshot`, `self`, `players` (пачка изменённых бойцов каждые 80 мс), `player.leave`, `voice.rx`, `voice.busy`, `marker`, `marker.delete`, `zone`, `zone.delete`, `route`, `route.delete`, `chat`, `briefing`, `match.end`, `pong`, `error`.

Коды закрытия: `4001` нет hello, `4003` токен недействителен/отозван, `4004` сеть завершена или вы из неё вышли.

### Правила

- **Идемпотентность:** клиент сам присваивает `id` чату, меткам, зонам и маршрутам, поэтому повтор из офлайн-очереди не создаёт дублей.
- **Метки:** бойцы ставят `contact` / `medic` / `danger`, остальное — командиры (`leader`, `commander`). Изменить или удалить метку может только автор или командир. Чужой `contact` можно только подтвердить (продлить TTL). Объекты изолированы по сетям.
- **Позиции:** время берётся по часам сервера (часам телефона не доверяем). Отбрасываются: `acc > 1000 м`, `0,0`, скачки быстрее 40 м/с (в пределах минуты).
- **PIN командира:** `squad.set` в роль `leader`/`commander` или отряд `command` требует PIN. 5 ошибок — блокировка на 15 минут. Роль, полученная по PIN, действует только в этой сети: в аккаунт сохраняется лишь отряд.
- **Лимиты:** на сокет 60 сообщений burst / 30 в секунду. На бойца: чат 5 / 1 в секунду, статус 2 / раз в 2 с, метки 10 / 1 в секунду, зоны/маршруты/брифинг 5 / раз в 2 с; не больше 40 своих меток, 1500 объектов на сеть.

## Голос

PTT идёт через тот же WebSocket бинарными кадрами: `[0x56 'V', channelIdx (0 squad, 1 platoon, 2 command), ...G.711 µ-law 16 кГц]`, по 40 мс. Сервер проверяет право на канал и рассылает кадр тем, кто его слышит (`canHearVoice`). Канал полудуплексный: пока говорит один, кадры второго отбрасываются, ему приходит `voice.busy`.
