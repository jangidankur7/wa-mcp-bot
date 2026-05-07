import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from request import (
    compact_json,
    fetch_chatbot_response,
    mcp_call_tool_streamable_http,
    parse_tool_command,
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Settings:
    mcp_url: str
    mcp_timeout_seconds: float
    webhook_secret: Optional[str]
    mcp_client_name: str
    mcp_client_version: str
    chatbot_api_url: str
    chatbot_timeout_seconds: float
    chatbot_model_provider: str
    chatbot_model_name: str
    chatbot_auth_token: Optional[str]
    chatbot_mcp_server_id: str
    chatbot_mcp_server_name: str


def load_settings() -> Settings:
    env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(env_path, override=False)

    secret = os.getenv("WEBHOOK_SECRET", "").strip()

    return Settings(
        mcp_url=os.getenv("MCP_URL", "http://localhost:8001/mcp").strip(),
        mcp_timeout_seconds=float(os.getenv("MCP_TIMEOUT_SECONDS", "10")),
        webhook_secret=secret or None,
        mcp_client_name=os.getenv("MCP_CLIENT_NAME", "wa-mcp-bot-backend").strip(),
        mcp_client_version=os.getenv("MCP_CLIENT_VERSION", "1.0.0").strip(),
        chatbot_api_url=os.getenv("CHATBOT_API_URL", "http://localhost:3003/api/chat").strip(),
        chatbot_timeout_seconds=float(os.getenv("CHATBOT_TIMEOUT_SECONDS", "30")),
        chatbot_model_provider=os.getenv("CHATBOT_MODEL_PROVIDER", "claude").strip(),
        chatbot_model_name=os.getenv("CHATBOT_MODEL_NAME", "claude-sonnet-4").strip(),
        chatbot_auth_token=(os.getenv("CHATBOT_AUTH_TOKEN", "").strip() or None),
        chatbot_mcp_server_id=os.getenv(
            "CHATBOT_MCP_SERVER_ID", "550e8400-e29b-41d4-a716-446655440004"
        ).strip(),
        chatbot_mcp_server_name=os.getenv("CHATBOT_MCP_SERVER_NAME", "PG-MCP").strip(),
    )


settings = load_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "Backend ready: bot POSTs to /webhook/message; each request queries MCP at %s",
        settings.mcp_url,
    )
    yield


app = FastAPI(title="wa-mcp-bot backend", version="1.0.0", lifespan=lifespan)


class WebhookPayload(BaseModel):
    message: str = Field(default="", max_length=16000)
    user: Optional[str] = Field(default=None, max_length=512)
    group: Optional[str] = Field(default=None, max_length=512)


class GroupRow(BaseModel):
    id: str = Field(..., max_length=512)
    subject: Optional[str] = Field(default=None, max_length=512)
    size: Optional[int] = Field(default=None, ge=0)


class GroupsSyncPayload(BaseModel):
    groups: list[GroupRow] = Field(default_factory=list)


def require_webhook_secret(
    x_webhook_secret: Optional[str] = Header(default=None, alias="X-Webhook-Secret"),
) -> None:
    expected = settings.webhook_secret
    if not expected:
        return
    if not x_webhook_secret or x_webhook_secret != expected:
        raise HTTPException(status_code=401, detail="Invalid or missing X-Webhook-Secret")


@app.get("/")
def health():
    return {"status": "ok"}


@app.post("/webhook/groups", dependencies=[Depends(require_webhook_secret)])
async def handle_groups_sync(payload: GroupsSyncPayload):
    """Receive participating groups from the linked-device bot after connect."""
    n = len(payload.groups)
    logger.info("Linked device reported %s participating group(s)", n)
    if n and logger.isEnabledFor(logging.DEBUG):
        for g in payload.groups[:20]:
            logger.debug("group id=%s subject=%r size=%s", g.id, g.subject, g.size)
    return {"ok": True, "count": n}


@app.post("/webhook/message", dependencies=[Depends(require_webhook_secret)])
async def handle_message(payload: WebhookPayload):
    query = payload.message.strip()
    if not query:
        return {"reply": "Empty query"}

    try:
        try:
            cmd = parse_tool_command(query)
        except ValueError as e:
            return {"reply": f"⚠️ {e}"}

        if not cmd:
            chatbot_text = await fetch_chatbot_response(
                chatbot_api_url=settings.chatbot_api_url,
                query=query,
                timeout_seconds=settings.chatbot_timeout_seconds,
                model_provider=settings.chatbot_model_provider,
                model_name=settings.chatbot_model_name,
                mcp_server_id=settings.chatbot_mcp_server_id,
                mcp_server_name=settings.chatbot_mcp_server_name,
                auth_token=settings.chatbot_auth_token,
            )
            return {"reply": chatbot_text}

        tool_data = await mcp_call_tool_streamable_http(
            settings.mcp_url,
            tool_name=cmd.tool,
            tool_args=cmd.args,
            timeout_seconds=settings.mcp_timeout_seconds,
            client_name=settings.mcp_client_name,
            client_version=settings.mcp_client_version,
        )
        return {"reply": f"🤖 {compact_json(tool_data, 2500)}"}

    except httpx.HTTPStatusError as e:
        logger.warning("MCP HTTP error: %s", e, exc_info=False)
        return {"reply": "⚠️ MCP returned an error"}
    except httpx.RequestError as e:
        logger.warning("MCP request failed: %s", e)
        return {"reply": "⚠️ Error contacting MCP"}
    except Exception:
        logger.exception("Unexpected error calling MCP")
        return {"reply": "⚠️ Error contacting MCP"}