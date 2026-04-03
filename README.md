# VAPI Webhook Server

Express.js webhook server for VAPI voice call events. Receives webhooks, stores raw payloads as a safety net, and asynchronously processes end-of-call reports.

## Features

- **POST /webhook/vapi** — Receives VAPI webhook events
- **x-vapi-secret** header verification
- Immediate raw payload insert (safety net)
- Returns 200 within 5 seconds (VAPI timeout compliance)
- Async processing of `end-of-call-report` events
- DNC opt-out detection (verbal phrases + endCallPhrases)
- Idempotent inserts (ON CONFLICT DO NOTHING)
- **GET /health** — DB connection status

## Quick Start

```bash
cp .env.example .env
# Edit .env with your DATABASE_URL and VAPI_WEBHOOK_SECRET
npm install
npm start
```

## Docker (Coolify)

```bash
docker build -t vapi-webhook-server .
docker run -p 3400:3400 --env-file .env vapi-webhook-server
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| DATABASE_URL | PostgreSQL connection string | required |
| VAPI_WEBHOOK_SECRET | Secret for x-vapi-secret header verification | changeme |
| PORT | Server port | 3400 |

## Architecture

```
VAPI Call → POST /webhook/vapi
  → Verify x-vapi-secret
  → INSERT webhook_events_raw (immediate, idempotent)
  → Return 200 OK
  → Async: process end-of-call-report
    → UPDATE call_attempts (duration, cost, reason)
    → INSERT transcripts
    → Check DNC opt-out → INSERT dnc_list
```

## Confer Solutions
Part of the VAPI Voice Bot Platform.
