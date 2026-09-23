# Jev’s Mailroom — build plan

## Concept

A shared, top-down pixel-art mailroom where visitors submit short messages and watch Jev, a little sprite, read each envelope and carry it to a category bin. Every bin is clickable and contains a browsable history of its messages. Everyone visiting the site sees the same room and sorting activity.

Jev uses the OpenRouter API to choose the destination and supply a short in-character reaction. Programmed animation handles Jev’s movement, including throwing screened-out envelopes into a trash can. There is no manual correction button or user recategorization flow.

## MVP decisions

- One public room, one Jev, anonymous submissions, no accounts.
- Four fixed, browsable bins: Compliments, Ideas, Complaints, and Misc. Keep labels and classification definitions in a shared configuration file.
- A separate trash can receives screened-out envelopes with a visible toss animation. Its contents are not publicly browsable; the four category bins remain the public message archive.
- Messages are plain text, 1–280 characters. Clearly state beside the composer that accepted messages are public.
- Classify each publishable message into exactly one bin according to its primary intent. Compliments covers praise and appreciation; Ideas covers suggestions and feature requests; Complaints covers dissatisfaction and bug reports; Misc covers questions, neutral notes, and messages without a clear fit. Negative feedback is valid content for Complaints, not grounds for throwing a message away.
- Every bin shows a delivered-message count and opens its history. History persists across visits and deployments.
- All visitors can watch the room and read all published messages without submitting anything.
- No voting, player controls, multiple rooms, attachments, accounts, or accuracy dashboard in the first version.

## Visitor experience

### Arriving

Show the mailroom immediately, with an incoming tray, Jev’s reading desk, four clearly labeled bins, and a distinct trash can arranged around the room. Use warm colors, crisp pixel sprites, gentle idle animation, and readable regular UI text outside the scene.

Below the room, provide a message field and a “Send to Jev” button. Show a small queue count and Jev’s current activity: waiting, reading, delivering, or discarding. A quiet room remains inviting through idle animation and example prompts in the composer; do not invent live visitor activity.

### Sending and sorting

1. The visitor submits a message and receives a receipt with its current status.
2. The server validates and saves it, then queues background processing. Public content screening happens before its text is broadcast or added to public history. The sender sees “Checking your message” during this stage.
3. A neutral, sealed envelope enters the shared incoming tray without exposing its text, including when screening selects the trash outcome. Highlight the sender’s envelope in their browser. Requests rejected by validation, rate limits, or queue capacity do not enter the room.
4. Jev walks to the tray, picks up the next envelope, and returns to the reading desk.
5. Jev displays a reading animation while processing is pending. For a publishable result, show a brief authored reaction such as “An idea for the next update!”
6. Jev carries a publishable envelope to its chosen bin. On the server’s scheduled delivery time, that bin’s count increases and the message appears in its history. For screened-out content, Jev walks to the trash can and tosses the envelope in, with a fixed reaction such as “This one goes in the trash.” Never quote or paraphrase the screened-out text publicly.
7. The sender receives “Filed under Ideas” with a link that opens the bin and highlights their message, or a private “Jev discarded your message” status with a brief screening explanation. Everyone else sees only the anonymous discard animation.

Aim for roughly 4–7 seconds of animation per delivery after classification is available. Keep AI processing independent from animation so several messages can be prepared while Jev delivers one at a time. Display an honest queue position and cap the waiting queue rather than accepting an unlimited backlog.

### Browsing bins

- Clicking or tapping any bin opens a side panel on desktop and a bottom sheet on mobile. The room keeps running behind it.
- The panel shows the category name, total count, and newest messages first, with cursor-based pagination and a “Load more” control.
- Each entry shows the full original message, delivery time, and Jev’s short reaction. Preserve line breaks and render everything as text.
- Newly delivered messages appear immediately when the viewer is at the top. If they are reading older entries, show a “New messages” indicator instead of moving the scroll position.
- Provide a category switcher in the panel and an empty state for bins that have no messages yet.
- Give bins shareable URLs such as `?bin=ideas`, with an optional message identifier for the sender’s receipt.
- Provide ordinary keyboard-accessible bin buttons alongside the canvas. A reduced-motion view uses the same status and history data without walking animations.

## Implementation approach

Use TypeScript throughout. Build the interface with React and Vite, and use Canvas 2D for the small tile-based room. A fixed room with scripted walking paths does not need a full game engine. Keep the composer, bin labels/buttons, and history panel in HTML for accessibility and responsive layout.

Run an Express web service that serves the built frontend, HTTP endpoints, and WebSocket connections. Run a separate Node background worker for screening, classification, and the shared delivery schedule. Use BullMQ with Render Key Value for jobs and notifications, and Postgres as the durable source of truth.

| Component | Responsibility | Render service |
| --- | --- | --- |
| Web server | Frontend, submissions, bin history, room snapshots, live updates | Web Service |
| Worker | Content screening, AI classification, retries, delivery scheduling | Background Worker |
| Job queue | Pending jobs and worker-to-web notifications | Key Value |
| Database | Messages, results, room state, durable events | Postgres |

Start with one web instance and one worker instance. The worker must hold a database-backed room lease so only one coordinator schedules Jev, including during overlapping deployments. Classification can have bounded concurrency; deliveries remain serial.

This deployment demonstrates a continuously running server, independent background processing, persistent data, and shared live updates. Include a small optional “How it works” panel describing these components. Keep infrastructure details out of the normal message flow.

## AI behavior

Call OpenRouter from the background worker using `POST https://openrouter.ai/api/v1/chat/completions`. Configure `OPENROUTER_API_KEY` as a server-only secret and `OPENROUTER_MODEL` as a configurable model ID. Never send the key to the browser.

Provide explicit category definitions and request a validated structured result with a category enum (`compliments`, `ideas`, `complaints`, `misc`) and a short public reaction. Use `response_format: { type: "json_schema", ... }` with strict schema settings and `provider.require_parameters: true`, selecting an endpoint that supports structured output. Validate the returned data in the worker as provider enforcement can vary. Treat the submitted message as untrusted content to classify, never as instructions to execute. The model has no tools or access to secrets.

Example result:

```json
{
  "category": "ideas",
  "reaction": "Dark mode? Filing that with the ideas!"
}
```

Use a small, fast model available through OpenRouter that supports structured output; choose the model during implementation after trying a representative sample of messages. Keep Jev’s personality prompt independent of the model selection so models can be swapped through configuration. Do not display a confidence percentage: a model-generated number would not be a measured accuracy score.

Screen the reaction as well as the submitted text before publication. If only the generated reaction fails screening, replace it with a fixed safe category acknowledgment; do not discard an otherwise publishable submission. Enforce category and length limits server-side. On invalid output or a timeout, retry a bounded number of times. If screening or classification remains unavailable, hold the message for retry and show a delay to its sender; Jev can continue with other ready messages. Do not silently route service failures into Misc or Trash.

Screening is a separate application step with an explicit policy, not an assumed feature of the OpenRouter gateway. Implement it as a separate structured screening call through OpenRouter, with its model independently configurable through `OPENROUTER_SCREENING_MODEL`. Screened-out submissions bypass category classification and become ready for the trash animation. Keep their text and screening explanation private; public snapshots and events contain only the envelope identifier, trash destination, timing, and fixed safe reaction. Misc is for publishable content without a better category, not rejected content.

## Durable state and synchronization

Use an explicit lifecycle: `pending_review → queued → classifying → ready → delivering → delivered`. Screened-out submissions branch from `pending_review → ready_to_discard → discarding → discarded`. Also support `failed`, with sender-visible status and bounded retry metadata. Store screening outcome separately from animation status so content remains private throughout the discard path.

Store message ID, original text, status, category, reaction, submission time, delivery time, and a private receipt-token hash. Keep private processing metadata out of public responses. Public bin queries return only delivered, publishable messages.

Store the active room sequence separately: current message, destination (one of the four bins or trash), phase, path identifier, phase start/end times, and a monotonically increasing room version. Broadcast state transitions and timestamps; browsers interpolate Jev’s position locally. Do not broadcast position updates every animation frame. Trash is an animation destination, not a public category or history endpoint.

The worker selects ready messages and ready-to-discard envelopes in arrival order, skipping ones awaiting a delayed retry. Once it schedules delivery or discard, the server clock determines completion; browser animation callbacks never decide whether a message is filed or discarded. After a restart, resume the recorded schedule and finalize overdue actions exactly once. A discard never increments a category bin’s count.

Commit message updates and an event/outbox record in one database transaction. Dispatch queue work and notifications from that outbox with retries. Use stable job IDs and idempotent state transitions to prevent duplicate classification results, envelopes, or bin counts when jobs are redelivered.

On initial connection or reconnection, return the current room snapshot, server time, counts, and state version. Subscribe before assembling the snapshot and buffer/version events to avoid gaps. Clients discard duplicate or older events and fetch a fresh snapshot when they detect a gap. Periodic version checks recover a missed notification even when no later event arrives. A visitor joining halfway through a walk sees Jev at the current position.

## HTTP and live interface

- `POST /api/messages`: validate and persist a submission; return its ID and private status receipt. Support a client submission ID so retries do not create duplicate messages.
- `GET /api/submissions/:id`: return the sender’s processing status when accompanied by the private receipt token.
- `GET /api/room`: return the public room snapshot and bin counts.
- `GET /api/bins/:category/messages?cursor=...`: return paginated public history and the next cursor.
- `GET /api/messages/:id`: return a single delivered public message for direct links.
- `/ws`: broadcast versioned room transitions, bin updates, and connection status.
- `/healthz` and `/readyz`: expose process health and dependency readiness without secrets.

## Operating limits

Start with configurable submission limits per anonymous session and IP, a global waiting-queue cap, bounded AI concurrency, and a daily AI budget. Return useful retry/delay messages when a limit is reached. Do not expose unreviewed message text through room snapshots, events, or logs.

Provide an operator-only command to remove a published message if needed; removal is separate from categorization and does not add a correction UI. Keep private receipt tokens and model credentials on the server. Render message text without HTML or automatic link embedding.

Record queue age, job errors, processing duration, and AI usage for operations. Keep full message bodies out of routine logs. Archive policy and more advanced moderation can be revisited after usage is understood.

## Build sequence and completion checks

### 1. Interactive visual prototype

Create the room, sprite animations, incoming envelopes, four bins, trash can, composer, and responsive history panel using clearly marked local fixture messages. Implement reduced motion and keyboard access. Complete when a simulated submission travels to a bin and can be read there on desktop and mobile, and a screened-out envelope follows the distinct trash-toss path without revealing its text.

### 2. Persistent shared room

Add Postgres migrations, the HTTP API, WebSockets, room coordinator, and a fake classifier behind the same interface as the eventual AI provider. Complete when two browser sessions see the same delivery and counts, can browse saved bin contents, and can reconnect without duplicating messages.

### 3. Background AI processing

Add the queue, separate worker, OpenRouter integration, screening, schema-validated classification, retries, and outbox dispatch. Complete when real messages reach the correct bin or trash animation, provider failures produce private delay statuses, and screened-out text is absent from all public APIs, events, and bin histories.

### 4. Reliability and visual polish

Add submission limits, queue capacity handling, receipt recovery, new-message indicators, empty states, and polished Jev reactions. Verify reloads midway through delivery or discard, worker restarts, duplicate jobs, missing notifications, and browsing old messages while new ones arrive. Evaluate a small labeled set of clear, ambiguous, and instruction-like messages to tune category definitions, including legitimate complaints that must remain publishable.

### 5. Render deployment

Create `render.yaml` for the four services, environment-variable documentation, database migration steps, health checks, and local development instructions. Place services in the same region and use internal datastore connections. Use paid always-on compute/persistent backing services for the shared demo; review current plans and costs before provisioning.

Deploy and verify with two independent browser sessions: submit, watch a shared delivery, open the matching bin, refresh, and confirm the message persists. Restart the worker during processing and redeploy the web service to verify recovery. The implementation should be usable locally before deployment credentials or resources are needed.

## Definition of done

A visitor can submit a short message, watch OpenRouter-powered Jev carry it to Compliments, Ideas, Complaints, or Misc, click any category bin to read its public messages, and share a bin/message link. Screened-out messages trigger a shared trash-toss animation without exposing their contents. Another visitor sees the same shared activity. Published history survives a restart or deploy, failures do not stall all deliveries, and there is no manual correction or recategorization control.

## Hosting and API references

- [Render WebSockets](https://render.com/docs/websocket): inbound WebSocket support and reconnect considerations.
- [Render background workers](https://render.com/docs/background-workers): continuously running workers for queue and AI tasks.
- [Render Key Value](https://render.com/docs/key-value): Redis-compatible job storage and persistence options.
- [OpenRouter API reference](https://openrouter.ai/docs/api_reference/overview): chat completion requests and model configuration.
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs): JSON Schema responses and compatible endpoint routing.

These capabilities support the proposed architecture; the service split and implementation details above are design choices for this app.
