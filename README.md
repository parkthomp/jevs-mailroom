# Jev’s Mailroom

A shared pixel-art mailroom that fills the screen and that you walk around in. Every visitor gets a little character: walk with the arrow keys or WASD (or the on-screen pad and A button on touch screens, or by clicking where to go). Walk up to the **INCOMING** desk to leave Jev a short message, watch him carry the envelope to **Compliments, Ideas, Complaints, or Misc**, then walk up to a bin to read its messages. Everyone in the room sees everyone else's character. The **Menu** button offers the same actions without walking. Screened-out messages get a visible toss into the trash; their contents stay private. There are no correction or recategorization controls.

React and Canvas draw the room. An Express/WebSocket server shares its state (character positions are relayed over the same socket and kept only in the web server's memory), and a worker asks [Jev](https://openrouter.ai/typesafe/jev-1.13), TypeSafe’s decision model, through OpenRouter to screen messages, pick their bin, and pick Jev’s reaction. The server controls delivery timing so every visitor watches the same Jev.

## Run locally

Requires Node.js 22 or later.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open the Vite URL printed in the terminal (normally `http://localhost:5173`). Without an API key, the room clearly runs in **demo mode**: a deterministic keyword sorter, local JSON persistence at `.data/state.json`, and an embedded worker. Send `[trash] test envelope` to try the discard animation. Demo mode is for development and is not a content-screening service.

To use real Jev, set these server-only values in `.env`, then restart:

```dotenv
OPENROUTER_API_KEY=your-key
OPENROUTER_MODEL=typesafe/jev-1.13
```

The model must be a System One decision model called through OpenRouter’s [System One API](https://openrouter.ai/docs/guides/community/typesafe-sdk) (`POST /api/v1/systemone`); ordinary chat models will not work. Never prefix these secrets with `VITE_` or put them in frontend code.

Live sorting makes one call per attempt. The message is sent only as state, alongside typed questions: one yes/no question per screening hazard, a choice of bin, and a choice of reaction for each bin. A hazard at or above 70% probability sends the envelope to the trash. Jev does not write text, so every reaction comes from the pre-written list in `server/ai.ts`. Provider failures leave the submission waiting for worker retry instead of silently filing or discarding it. Retries back off, with at most five attempts per message per UTC day before holding it until the next day. A request timeout defaults to 15 seconds and is capped at 30 seconds. Production refuses to start without live AI credentials and a model.

## Local Postgres and queue

To test the separate processes used on Render, run:

```sh
docker compose up -d --wait
```

Uncomment `DATABASE_URL` and `REDIS_URL` in `.env`, and set `RECEIPT_SECRET` to a random value of at least 32 characters (`openssl rand -hex 32` generates one). Then:

```sh
npm run db:migrate
npm run dev
```

In another terminal, start the worker:

```sh
npx tsx watch server/worker.ts
```

This can use demo AI while `NODE_ENV` is not `production`, or real OpenRouter credentials. Setting `DATABASE_URL` disables the embedded worker. Postgres and Redis data persist in Docker named volumes; `docker compose down` stops the services without deleting those volumes. Local JSON messages are not automatically imported into Postgres.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Server-only OpenRouter credential; required in production |
| `OPENROUTER_MODEL` | System One model ID, e.g. `typesafe/jev-1.13`; required for live mode |
| `OPENROUTER_TIMEOUT_MS` | `15000`; each API request is capped at 30 seconds |
| `AI_MODE` | Auto-detected; optional `live` or development-only `demo` |
| `DATABASE_URL` | Postgres connection; required in production |
| `REDIS_URL` | BullMQ connection; required in production |
| `RECEIPT_SECRET` | Stable server secret, at least 32 characters in production |
| `DATA_FILE` | `.data/state.json`; local development persistence |
| `PORT` | `3001`; HTTP/WebSocket server (Vite proxies here in development) |
| `MAX_QUEUE` | `40`; maximum waiting submissions |
| `SUBMISSIONS_PER_MINUTE` | `5`; per-IP limit |
| `AI_CONCURRENCY` | `2`; concurrent jobs |
| `DAILY_AI_LIMIT` | `500`; message processing attempts per day (up to three API calls each), not a dollar spending cap |

## Deploy on Render

`render.yaml` defines an always-on web service, a separate worker, Postgres, and persistent Key Value, all in Ohio. Database and queue connections use Render’s private network. The Blueprint uses paid plans; review the quoted costs before creating it.

1. Push the app to a Git repository connected to Render.
2. Create a new Blueprint from that repository and select `render.yaml`.
3. Fill in `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` when prompted. The worker references those values from the web service. Render generates the shared receipt secret.
4. Review and deploy. Both services build with `npm ci --include=dev && npm run build` and run the idempotent migration before starting.
5. Open the web URL in two browsers. Submit a message, watch the same delivery in both, open its bin, and refresh to verify saved history. Check `/healthz` (process) and `/readyz` (storage), then restart the worker during a delivery and confirm the room recovers. Queue outages do not fail readiness because the coordinator can reconcile pending work from Postgres.

When changing Blueprint-referenced credentials or model settings, resync the Blueprint so the worker receives the new values. Keep `RECEIPT_SECRET` stable so existing sender receipts continue to work. Do not use the local JSON store on an ephemeral production filesystem.

The repository contains deployment configuration; creating or deploying these services still requires your Render account. Render’s [Blueprint reference](https://render.com/docs/blueprint-spec) describes the service wiring and [WebSocket documentation](https://render.com/docs/websocket) describes long-lived client connections.

## Checks

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

AI unit tests mock OpenRouter and do not spend credits. They cover the request shape, answer validation, private discard results, the screening threshold, preservation of negative feedback, reaction fallback, and provider errors. Live model quality and real Render restart behavior should be checked after configuring credentials and deploying.

## Publication behavior

Accepted messages are public and remain browsable in their bin. The sender’s receipt token reveals private status; it is not part of public room events. Screening considers targeted abuse, exposed personal information or credentials, explicit content, threats, and spam or junk (ads, scams, gibberish, and empty test notes such as “test”). Ordinary complaints, criticism, and disagreement are publishable. The public trash animation uses fixed text and never exposes the original message or screening explanation.

An operator with access to the app environment can remove a published message by ID:

```sh
npx tsx server/remove-message.ts <message-id>
```

This deletes that stored message; it does not move it between bins. There is no public moderation control.

After fixing an AI configuration problem, messages that used up their five daily attempts can be released for an immediate retry:

```sh
npx tsx server/retry-held.ts
```

On Render, run `node dist/server/retry-held.js` as a one-off job on the worker.

This MVP stores the single room in a transactional Postgres JSONB row and broadcasts complete snapshots. Pending records serve as a durable work outbox, with periodic reconciliation recovering lost queue hints. This favors simple recovery for a small demo; a busy room with a large archive should move messages into indexed rows and use incremental notifications before scaling horizontally.

`PLAN.md` records the fuller design and rollout checklist.
