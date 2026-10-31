# Протокол

Источник истины: [`shared/src/index.ts`](../shared/src/index.ts). Все входящие сообщения валидируются zod.

## REST

| Метод | Путь | Auth | Назначение |
|---|---|---|---|
| GET | `/api/health` | — | статус, `voice`, число соединений |
| POST | `/api/join` | — | `{code, callsign, squad, role, pin?}` → `{token, self, match}` |
| POST | `/api/telemetry` | Bearer игрока | позиция или массив позиций (до 50) от Android-сервиса |
| GET | `/api/voice` | Bearer игрока | `{url, channels:[{channel, room, token}]}` для LiveKit |
| POST | `/api/admin/matches` | Bearer admin | `{name, commandPin, code?}` |
| GET | `/api/admin/matches` | Bearer admin | список матчей |
| POST | `/api/admin/matches/:id/end` | Bearer admin | завершить матч, отключить клиентов |
| GET | `/api/admin/matches/:id/tracks` | Bearer admin | треки для разбора |
| POST | `/api/admin/matches/:id/events` | Bearer admin | webhook: любое клиентское сообщение от имени `HQ-BOT` |

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

Первое сообщение клиента: `{"t":"hello","token":"<jwt>"}` в течение 5 секунд. Ответ: `snapshot` со всем состоянием матча.

Клиент → сервер: `pos`, `heading`, `status`, `chat`, `marker.upsert`, `marker.delete`, `zone.upsert`, `zone.delete`, `route.upsert`, `route.delete`, `briefing.set`, `ping`.

Сервер → клиент: `snapshot`, `players` (пачка изменённых игроков каждые 80 мс), `marker`, `marker.delete`, `zone`, `zone.delete`, `route`, `route.delete`, `chat`, `briefing`, `match.end`, `pong`, `error`.

Коды закрытия: `4001` нет hello, `4003` токен недействителен, `4004` матч завершён.

Лимит: 40 сообщений burst, 20/с.

## Голос

Комнаты LiveKit:

- `m-<matchId>-sq-<squad>` — отделение;
- `m-<matchId>-platoon` — все;
- `m-<matchId>-command` — только `leader`, `commander`, HQ.

Клиент подключается ко всем доступным комнатам и слушает их. Микрофон публикуется в одну выбранную комнату в состоянии mute. PTT снимает mute. Событие `TrackUnmuted` у слушателей включает индикатор RX и щелчок шумоподавителя.
