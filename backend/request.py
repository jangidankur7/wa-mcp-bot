import json
import logging
from dataclasses import dataclass
from typing import Any, Optional
from uuid import uuid4

import httpx

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolCommand:
    tool: str
    args: dict[str, Any]


def parse_tool_command(text: str) -> Optional[ToolCommand]:
    """
    Parse '/tool <tool_name> <json-args>' from WhatsApp text.
    Examples:
      /tool fetch_current_date_time
      /tool fetch_merchant_channel {"merchant_id":"MID123"}
    """
    if not text:
        return None
    raw = text.strip()
    if not raw.startswith("/tool "):
        return None
    rest = raw[len("/tool ") :].strip()
    if not rest:
        return None

    parts = rest.split(" ", 1)
    tool_name = parts[0].strip()
    args: dict[str, Any] = {}
    if len(parts) == 2 and parts[1].strip():
        payload = parts[1].strip()
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON args: {e.msg}")
        if parsed is None:
            parsed = {}
        if not isinstance(parsed, dict):
            raise ValueError("JSON args must be an object")
        args = parsed

    return ToolCommand(tool=tool_name, args=args)


def compact_json(obj: Any, max_len: int = 1200) -> str:
    txt = json.dumps(obj, ensure_ascii=True, separators=(",", ":"))
    return txt if len(txt) <= max_len else f"{txt[:max_len]}…"


def parse_mcp_response_payload(res: httpx.Response) -> dict[str, Any]:
    """
    Parse MCP Streamable HTTP response payload that may be either:
    - application/json
    - text/event-stream (SSE with `data: {...}`)
    """
    ctype = (res.headers.get("content-type") or "").lower()
    if "application/json" in ctype:
        return res.json()

    if "text/event-stream" in ctype:
        body = res.text or ""
        data_lines: list[str] = []
        for line in body.splitlines():
            if line.startswith("data:"):
                data_lines.append(line[len("data:") :].strip())
        for chunk in data_lines:
            if not chunk:
                continue
            try:
                parsed = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                return parsed
        raise ValueError(f"SSE payload missing JSON data: {body[:400]}")

    # Fallback attempt for unknown content-type
    try:
        parsed = res.json()
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    raise ValueError(f"Unsupported MCP response content-type={ctype!r}, body={res.text[:400]!r}")


async def mcp_call_tool_streamable_http(
    mcp_url: str,
    *,
    tool_name: str,
    tool_args: dict[str, Any],
    timeout_seconds: float,
    client_name: str,
    client_version: str,
) -> dict[str, Any]:
    """
    Minimal MCP Streamable HTTP flow (same sequence as chatbot SDK):
    1) initialize
    2) notifications/initialized
    3) tools/call
    """
    init_req = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {"tools": {}},
            "clientInfo": {"name": client_name, "version": client_version},
        },
    }
    logger.info("MCP -> initialize payload=%s", compact_json(init_req))

    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        init_res = await client.post(
            mcp_url,
            json=init_req,
            headers={"content-type": "application/json", "accept": "application/json, text/event-stream"},
        )
        init_res.raise_for_status()
        init_data = parse_mcp_response_payload(init_res)
        logger.info("MCP <- initialize status=%s body=%s", init_res.status_code, compact_json(init_data))

        init_result = init_data.get("result") or {}
        protocol_version = init_result.get("protocolVersion")
        session_id = init_res.headers.get("mcp-session-id")

        common_headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
        }
        if protocol_version:
            common_headers["mcp-protocol-version"] = protocol_version
        if session_id:
            common_headers["mcp-session-id"] = session_id

        initialized_req = {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
        logger.info("MCP -> notifications/initialized payload=%s", compact_json(initialized_req))
        initialized_res = await client.post(mcp_url, json=initialized_req, headers=common_headers)
        if initialized_res.status_code not in (200, 202):
            initialized_res.raise_for_status()

        tool_req = {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": tool_args},
        }
        logger.info("MCP -> tools/call payload=%s", compact_json(tool_req))
        tool_res = await client.post(mcp_url, json=tool_req, headers=common_headers)
        tool_res.raise_for_status()
        tool_data = parse_mcp_response_payload(tool_res)
        logger.info("MCP <- tools/call status=%s body=%s", tool_res.status_code, compact_json(tool_data))
        return tool_data


def extract_text_from_chatbot_sse(raw: str) -> str:
    """
    Parse Vercel AI data stream payload from /api/chat and return assistant text.
    Handles:
      data: {"type":"text-delta","delta":"..."}
      data: {"type":"error","errorText":"..."}
      data: [DONE]
    """
    chunks: list[str] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:") :].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            if obj.get("type") == "error":
                raise ValueError(obj.get("errorText") or "Chatbot returned an error")
            if obj.get("type") == "text-delta":
                delta = obj.get("delta")
                if isinstance(delta, str):
                    chunks.append(delta)
    return "".join(chunks).strip()


async def fetch_chatbot_response(
    *,
    chatbot_api_url: str,
    query: str,
    timeout_seconds: float,
    model_provider: str,
    model_name: str,
    mcp_server_id: str,
    mcp_server_name: str,
    auth_token: Optional[str] = None,
) -> str:
    """
    Call chatbot /api/chat and return the assistant text output.
    """
    msg_id = f"wa-{uuid4()}"
    body = {
        "id": msg_id,
        "message": {
            "id": msg_id,
            "role": "user",
            "parts": [{"type": "text", "text": query}],
        },
        "messages": [
            {
                "id": msg_id,
                "role": "user",
                "parts": [{"type": "text", "text": query}],
            }
        ],
        "chatModel": {"provider": model_provider, "model": model_name},
        "toolChoice": "auto",
        # Include PG-MCP server mention so chatbot loads MCP tools for this request
        "mentions": [
            {
                "type": "mcpServer",
                "name": mcp_server_name,
                "serverId": mcp_server_id,
            }
        ],
    }
    headers = {"content-type": "application/json", "accept": "text/event-stream"}
    if auth_token:
        headers["cookie"] = f"auth_token={auth_token}"

    logger.info("CHATBOT -> /api/chat payload=%s", compact_json(body))
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        res = await client.post(chatbot_api_url, json=body, headers=headers)
        res.raise_for_status()
        text = extract_text_from_chatbot_sse(res.text)
        if not text:
            raise ValueError("Chatbot response did not contain assistant text")
        logger.info("CHATBOT <- /api/chat text=%s", compact_json(text, 1000))
        return text