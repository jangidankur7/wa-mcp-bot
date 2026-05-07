# WA MCP Bot

WhatsApp group assistant built with **Node.js (Baileys)** + **FastAPI** that processes bot mentions and routes requests to either direct MCP tools or chatbot flow.

## Features

- Mention-gated bot replies in WhatsApp groups
- `/tool` command support for direct MCP tool execution
- Natural-language fallback via chatbot endpoint
- Duplicate message suppression and reconnect handling
- Optional webhook secret validation between bot and backend

## Project Structure

- `bot/` - WhatsApp transport layer (Baileys client)
- `backend/` - FastAPI webhook service and routing logic
- `help.md` - quick local run notes

## Prerequisites

- Node.js 18+
- Python 3.10+
- A running MCP server endpoint
- A running chatbot endpoint

## Configuration

### Bot config (`bot/.env`)

Copy `bot/.env.example` to `.env` and configure:

- `BACKEND_BASE_URL`
- `WEBHOOK_SECRET` (optional, must match backend if enabled)
- logging/debug toggles as needed

### Backend config (`backend/.env`)

Copy `backend/.env.example` to `.env` and configure:

- `MCP_URL`
- `CHATBOT_API_URL`
- `WEBHOOK_SECRET` (optional)
- chatbot model/provider values

## Local Setup

### 1) Start backend

```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --reload
```

### 2) Start bot (new terminal)

```bash
cd bot
npm install
node bot.js
```

On first run, scan the WhatsApp QR code shown by the bot process.

## How It Works

1. User sends a group message and mentions the bot.
2. Bot validates context (group, mention, not self, dedupe).
3. Bot forwards cleaned query to backend webhook.
4. Backend routes:
   - `/tool ...` -> MCP tool call
   - normal text -> chatbot `/api/chat`
5. Backend returns reply, bot posts it back to the same group.

## API Endpoints (Backend)

- `GET /` - health check
- `POST /webhook/groups` - optional group sync telemetry
- `POST /webhook/message` - main message processing path

## Notes

- This project uses a linked-device WhatsApp session with Baileys.
- For production, add stronger observability, rate limiting, and request signing.
