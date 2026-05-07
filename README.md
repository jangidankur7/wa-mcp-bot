# WA MCP Bot (Legacy Baileys) - Detailed Technical Documentation

This document explains what was built in `wa-mcp-bot-legacy-baileys`, how it works internally, and how to discuss it in interviews (architecture, trade-offs, reliability, security, and scaling).

---

## 1) Problem Statement and Goal

The system enables WhatsApp group users to interact with internal payment support tools via natural language.

Primary goals:
- Listen to WhatsApp group messages from a linked-device account.
- Respond only when the bot account is explicitly @mentioned.
- Route requests in two modes:
  - `/tool ...` -> direct MCP tool execution.
  - normal text -> chatbot `/api/chat` with MCP server mention context.
- Return responses back to the same WhatsApp group.

High-level value:
- Gives business and ops teams a chat-native interface for payment insights.
- Preserves access control by making bot participation explicit (`@mention` + optional webhook secret).

---

## Project Section (Resume-Ready)

Use this as-is in resume project sections:

- Built a WhatsApp group assistant using Node.js (Baileys) + FastAPI that processes @mentions, routes `/tool` commands to MCP tools, and handles natural-language queries via chatbot fallback for payment support workflows.
- Engineered production-grade reliability with mention-resolution across WA identity formats, duplicate-message suppression, reconnect handling, webhook authentication, and MCP Streamable HTTP protocol/session orchestration.

Short version (if you only have one line):

- Developed a WhatsApp support automation system (Baileys + FastAPI + MCP) that converted group @mentions into tool-driven and conversational responses with secure webhook gating and resilient event processing.

---

## 2) Repository Layout

- `bot/bot.js`
  - Node.js process using Baileys (linked-device WhatsApp Web session).
  - Handles QR auth, event stream, mention detection, dedupe, and forwarding.
- `backend/app.py`
  - FastAPI service receiving webhook-style requests from bot process.
  - Routes text to MCP tools or chatbot endpoint.
- `backend/request.py`
  - Protocol adapters:
    - MCP Streamable HTTP handshake (`initialize`, `notifications/initialized`, `tools/call`).
    - Chatbot SSE parsing and response extraction.
- `backend/.env.example`, `bot/.env.example`
  - Runtime configuration and secrets placeholders.
- `help.md`
  - Basic runbook for local startup.

---

## 3) End-to-End Architecture

Logical flow:
1. WhatsApp group user posts message and @mentions linked bot account.
2. Baileys bot receives message event.
3. Bot validates message context:
   - group message only,
   - not from self,
   - mentions this bot identity (with PN/LID compatibility),
   - not duplicate delivery.
4. Bot strips `@...` tokens and forwards query to backend (`POST /webhook/message`).
5. Backend parses query:
   - if `/tool ...`: call MCP directly.
   - else: call chatbot `/api/chat`.
6. Backend returns final text.
7. Bot posts response back into same group, quoting original message.

Supporting systems:
- `mcp_server` (Streamable HTTP endpoint, typically `/mcp`).
- `chatbot` app (`/api/chat` SSE response stream).

---

## 4) Component Deep Dive

## 4.1 Bot Process (`bot/bot.js`)

Core responsibilities:
- Session/auth management via `useMultiFileAuthState(AUTH_STATE_DIR)`.
- Connection lifecycle with reconnect logic.
- Group metadata cache and participant resolution for mention checks.
- Group list sync to backend (`/webhook/groups`) on connect.
- Message deduplication across `notify` and `append` events.
- Request forwarding + response posting.

Important behaviors:
- Policy is group-only + mention-only (implemented in event handling logic).
- Sends a small sample @reply before final reply when tagger identity is available.
- Uses one Axios client with optional `X-Webhook-Secret`.

Reliability details:
- Reconnects on disconnect unless explicitly logged out.
- Detects forbidden/loggedOut reasons and logs actionable messages.
- Deduper prevents duplicate backend/tool invocations.

Mention detection details:
- Parses `contextInfo.mentionedJid` from multiple message carriers.
- Resolves mismatches between LID and PN identities using group participant metadata.
- Uses `areJidsSameUser` for robust identity matching.

---

## 4.2 Backend Process (`backend/app.py`)

Core responsibilities:
- Accept and validate requests from bot process.
- Parse commands and decide route (MCP direct vs chatbot).
- Standardize error handling to user-friendly WhatsApp-safe text.

Routes:
- `GET /` -> health (`{"status":"ok"}`).
- `POST /webhook/groups` -> optional telemetry of participating groups.
- `POST /webhook/message` -> main request path.

Request path (`/webhook/message`):
1. Validate body and non-empty query.
2. Parse tool command using `parse_tool_command`.
3. Branch:
   - no command -> `fetch_chatbot_response`.
   - command present -> `mcp_call_tool_streamable_http`.
4. Return reply string payload.

Security control:
- Optional `WEBHOOK_SECRET`: if set, backend requires header `X-Webhook-Secret`.

---

## 4.3 Protocol Adapter (`backend/request.py`)

### MCP call path
Implements a minimal Streamable HTTP JSON-RPC lifecycle:
1. `initialize`
2. `notifications/initialized`
3. `tools/call`

It propagates:
- `mcp-session-id` (when provided),
- `mcp-protocol-version` (from initialize result),
- accepts both JSON and SSE-like response payloads.

### Chatbot call path
Posts to chatbot `/api/chat` with:
- user message,
- model metadata (`provider`, `model`),
- MCP mention context (`mcpServer` object),
- optional auth cookie.

Then parses SSE text-delta chunks to produce final assistant text.

---

## 5) Command and Routing Model

Input patterns:
- `/tool <tool_name>`
- `/tool <tool_name> {"json":"args"}`
- any other text -> chatbot route

Why this split:
- `/tool` mode gives deterministic, explicit tool execution.
- natural text mode gives conversational experience backed by chatbot orchestration.

---

## 6) Configuration Model

Bot `.env` key points:
- `BACKEND_BASE_URL`
- `WEBHOOK_SECRET` (must match backend if enabled)
- `WA_LOG_INBOUND`, `WA_DEBUG_UPSERT`, `WA_LOG_OUTPUT`, `SYNC_GROUPS_TO_BACKEND`

Backend `.env` key points:
- MCP config: `MCP_URL`, timeout, client identity
- Chatbot config: `CHATBOT_API_URL`, model settings, optional auth token
- Security: `WEBHOOK_SECRET`
- MCP server mention metadata: `CHATBOT_MCP_SERVER_ID`, `CHATBOT_MCP_SERVER_NAME`

---

## 7) Reliability and Failure Modes

Handled failure classes:
- Baileys disconnects / transient connection drops.
- Duplicate message deliveries.
- MCP HTTP errors vs network errors.
- Chatbot SSE parse or empty-response issues.
- Invalid `/tool` JSON.

Current fallback behavior:
- Backend returns user-safe warning text (`⚠️ ...`) instead of raw stack traces.
- Bot sends error reply to group if backend call fails.

Known operational risks:
- Linked-device sessions can expire or get invalidated.
- Group metadata can be stale (code refreshes when needed for mention resolution).
- Downstream dependencies (`mcp_server`, `chatbot`) are runtime critical.

---

## 8) Security Posture

Implemented controls:
- Optional shared secret header (`X-Webhook-Secret`) between bot and backend.
- Secrets externalized via env files.
- Bot only reacts to group + @mention pattern by design.

Gaps / improvement opportunities:
- Add request signing with timestamp/nonce for replay resistance.
- Add rate limiting and bot-level abuse controls.
- Add structured audit logging with correlation IDs.
- Add secret rotation runbook.

---

## 9) Performance and Scale Considerations

Current profile:
- Single-node bot process + single backend process.
- Event-driven, async I/O for external calls.
- Per-request `httpx.AsyncClient` in backend adapters.

Scale bottlenecks:
- One WhatsApp session and one event loop for bot.
- Sequential handling at message granularity.
- Backend and dependencies co-location assumptions for latency.

Scale-up options:
- Shard by account/number and isolate sessions.
- Queue-based processing between bot and backend.
- Cache hot group metadata with TTL + proactive refresh.
- Add metrics-driven autoscaling (CPU, event lag, downstream latency).

---

## 10) Observability and Operations

What exists:
- Structured-ish console logs with prefixes.
- Debug toggles via env.
- Clear logs for connection state and message flow.

What to add for production:
- JSON logs + centralized ingestion.
- Metrics: message throughput, mention hit rate, downstream latency, error ratio.
- Alerts: reconnect loops, MCP/chatbot failures, auth/session invalidation.
- Tracing across bot -> backend -> MCP/chatbot.

---

## 11) Design Trade-offs (Interview Talking Points)

Why Baileys linked-device (legacy):
- Fast prototyping and low setup friction.
- Works before formal Cloud API onboarding.

Trade-off:
- Less enterprise-grade than official WhatsApp Cloud API.
- Session stability and policy constraints can be harder operationally.

Why mention-only in groups:
- Reduces noisy bot replies.
- Gives users explicit control over invocation.

Trade-off:
- Heavier mention-parsing logic and participant identity reconciliation.

Why split bot + backend:
- Bot remains transport-focused (WhatsApp IO).
- Backend remains domain/protocol-focused (MCP/chatbot routing).

Trade-off:
- More moving parts and cross-process reliability needs.

---

## 12) Interview Q&A Prep

### Q1: What is the hardest part technically?
Robust mention detection across WhatsApp identity forms (PN/LID/device variants), while avoiding duplicate triggers and preserving group-only behavior.

### Q2: How do you avoid duplicate replies?
Deduplication set keyed by `(remoteJid|messageId)` to suppress repeated `notify/append` events.

### Q3: How do you keep MCP calls protocol-compliant?
Explicit Streamable HTTP handshake sequence with session/protocol header propagation.

### Q4: How is safety handled?
Optional webhook secret, mention-gated invocation, and error sanitization before replying to users.

### Q5: What would you improve first for production?
Move to official WhatsApp Cloud API, add queue/worker architecture, formal observability, and stronger request signing/rate limits.

---

## 13) How to Run (Legacy)

From repo root:

1) Backend
- `cd wa-mcp-bot-legacy-baileys/backend`
- `cp .env.example .env`
- `python3 -m venv venv && source venv/bin/activate`
- `pip install -r requirements.txt`
- `uvicorn app:app --reload`

2) Bot (separate terminal)
- `cd wa-mcp-bot-legacy-baileys/bot`
- `cp .env.example .env`
- `npm install`
- `node bot.js`

3) Dependencies
- `mcp_server` running and reachable via `MCP_URL`.
- `chatbot` running and reachable via `CHATBOT_API_URL`.

---

## 14) What This Legacy Project Demonstrates

- Real-time event-driven integration with WhatsApp groups.
- Hybrid command routing (deterministic tool mode + conversational mode).
- Practical protocol engineering (MCP Streamable HTTP and SSE parsing).
- Production-minded guardrails: dedupe, reconnection, auth gate, and graceful fallback replies.