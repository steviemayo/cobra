# Public API (v1)

Read-only access to an organisation's rooms and problems, for its own systems: a building management system, a dashboard, a script. It comes with the plans that include monitoring.

## Keys

An owner makes keys in **Settings > API keys**. A key looks like `kst_1a2b3c4d_...`. It is shown once, when it is made; Kestrel keeps only a hash of it, so a lost key cannot be recovered, only replaced. Each key belongs to one organisation, can have an expiry, and can be revoked at any time (it stops working at once). An organisation can have 10 working keys.

Send the key on every request:

```
Authorization: Bearer kst_1a2b3c4d_<secret>
```

Keys can only read. Nothing in this API changes a room.

## Limits and errors

- 120 requests a minute per key. Past that: `429` with a `Retry-After` header (seconds). The count is kept per server process, so treat it as a guard against a runaway script rather than an exact figure
- Errors are JSON: `{ "error": "..." }`
- `401` a missing, wrong, revoked or expired key (all look the same); `402` the plan does not include the API; `404` no such room (or one that is not yours); `400` a bad query
- Responses are never cached (`Cache-Control: no-store`)

## Endpoints

Every success response is `{ "data": ... }`.

### `GET /api/v1/rooms`

Every room, by name.

```json
{
  "data": [
    {
      "id": "3f2a…",
      "name": "Boardroom",
      "type": "meeting",
      "kind": "standard",
      "site": { "id": "9c1b…", "name": "HQ" },
      "gateway": { "id": "77aa…", "name": "Level 2", "status": "online" },
      "release": { "running": 3, "target": 4 },
      "status": "on",
      "reportedAt": "2026-09-27T09:00:00.000Z"
    }
  ]
}
```

- `kind`: `standard`, `combined` (a room that exists while a group's rooms are joined) or `staging` (a copy for trying changes)
- `gateway.status`: `pending` (not enrolled yet), `online` or `offline`
- `release.running` is the release number the gateway last said it is running; `release.target` is the one the room is set to run. They differ while a deployment is on its way, or after a failure. Both are `null` when nothing has been deployed
- `status`: what the gateway last said the room was doing: `off`, `starting`, `on` or `fault`. `null` before it has reported

### `GET /api/v1/rooms/{roomId}`

One room, with the same fields plus its devices and the number of open problems.

```json
{
  "data": {
    "id": "3f2a…",
    "name": "Boardroom",
    "…": "…",
    "devices": [
      { "id": "dsp", "name": "DSP", "online": false, "since": "2026-09-27T08:00:00.000Z" }
    ],
    "openIncidents": 1
  }
}
```

`since` is when the device last changed between online and offline.

### `GET /api/v1/incidents`

Problems (a device stopped answering, a gateway went quiet, a room fault, a failed deployment), newest first.

Query: `status` = `open` or `resolved`; `room` = a room id; `limit` = 1 to 200 (default 50).

```json
{
  "data": [
    {
      "id": "b1c2…",
      "kind": "device_offline",
      "severity": "warning",
      "status": "open",
      "title": "DSP is offline",
      "detail": "DSP in Boardroom has not answered since 2026-09-27T08:00:00.000Z.",
      "room": { "id": "3f2a…", "name": "Boardroom" },
      "openedAt": "2026-09-27T08:05:00.000Z",
      "resolvedAt": null,
      "acknowledged": false
    }
  ]
}
```

`kind` is one of `device_offline`, `gateway_offline`, `room_fault`, `deploy_failed`. `severity` is `info`, `warning` or `critical`. `room` is `null` for a gateway problem.

## What is never returned

Device addresses and logins, panel PINs, webhook secrets, room designs and anything about other organisations.

## Getting problems pushed to you

To have Kestrel call your system when something goes wrong, use an alert channel of type **Webhook** (Alerts page) rather than polling this API. It sends each problem as it opens, a reminder if you set one, and when it clears, signed with a secret you choose.

## Not built yet

Room control from the API, usage and report data, and pushing events other than problems (deployments, room on/off). Ask for what you need.

## For developers

- Keys: `apps/web/src/server/api-keys.ts` (create, authenticate, revoke, rate limit)
- Response shapes: `apps/web/src/server/public-api.ts`, written out on purpose so a database change cannot change the API by accident
- Routes: `apps/web/src/app/api/v1/`, each wrapped in `withApiKey` (`apps/web/src/server/api-http.ts`)
- Table: `ApiKey` (migration `20260927110000_api_keys`)
