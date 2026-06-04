"""
OpenZhangXueFeng — FastAPI WebSocket server.

Orchestrates:
  - DeepSeek LLM (streaming chat)
  - Fish Audio TTS (streaming voice generation) + ASR
  - LangSearch (real-time web search)
  - Conversation persistence (JSON file storage)

Run:
    python server.py
    → http://localhost:8000
"""

import asyncio
import base64
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from config import HOST, PORT, validate as validate_config
from deepseek_client import chat_stream_agent
from fish_audio_client import tts_sentence, transcribe_audio
from langsearch_client import search as langsearch_search
from tts_utils import strip_for_tts, filter_citations
from storage import (
    create_conversation,
    get_conversation,
    list_conversations,
    delete_conversation,
    add_message,
    update_conversation,
)

# ── Logging ───────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("openzxf")

# ── Lifespan ────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Validating config...")
    try:
        validate_config()
        logger.info("Config OK!")
    except RuntimeError as e:
        logger.error(str(e))
        logger.error(
            "Copy .env.example to .env and fill in your API keys, then restart."
        )
        raise
    yield


# ── FastAPI app ────────────────────────────────────────────
app = FastAPI(title="OpenZhangXueFeng", version="1.1.0", lifespan=lifespan)

# Static files
static_dir = Path(__file__).parent / "static"
static_dir.mkdir(exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")


@app.get("/")
async def root():
    """Serve the main page."""
    return FileResponse(str(static_dir / "index.html"))


# ── Conversation REST API ──────────────────────────────────

@app.get("/api/conversations")
async def api_list_conversations():
    """List all conversations (sidebar)."""
    return JSONResponse(list_conversations())


@app.post("/api/conversations")
async def api_create_conversation():
    """Create a new conversation."""
    conv = create_conversation()
    return JSONResponse(conv)


@app.get("/api/conversations/{conv_id}")
async def api_get_conversation(conv_id: str):
    """Get a full conversation by ID."""
    conv = get_conversation(conv_id)
    if not conv:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return JSONResponse(conv)


@app.delete("/api/conversations/{conv_id}")
async def api_delete_conversation(conv_id: str):
    """Delete a conversation."""
    delete_conversation(conv_id)
    return JSONResponse({"ok": True})


@app.post("/api/asr")
async def api_transcribe(audio: UploadFile = File(...)):
    """
    Transcribe uploaded audio via Fish Audio ASR.
    Accepts form-data with audio file, proxies to Fish Audio ASR API.
    Returns {"text": "...", "duration": 1.2, "segments": [...]}
    """
    try:
        audio_bytes = await audio.read()
        result = await transcribe_audio(audio_bytes)
        return JSONResponse({
            "text": result.get("text", ""),
            "duration": result.get("duration", 0),
        })
    except Exception as e:
        logger.error(f"ASR error: {e}")
        return JSONResponse({"error": str(e)}, status_code=500)


# ── Voice-mode sentence-end regex ───────────────────────────
import re as _re
_SENTENCE_END = _re.compile(r"[。！？.!?\n]")


# ── WebSocket handler ──────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    logger.info("WebSocket connected")

    # Active conversation state
    active_conv_id: str | None = None
    chat_history: list[dict] = []  # Current session (role+content for LLM)
    session_citations: list[dict] = []  # Accumulated across all turns
    tts_task: asyncio.Task | None = None  # For cancellation on interrupt
    cancel_event: asyncio.Event | None = None  # Set when user clicks stop

    # ── Helper: persist message ──────────────────────────
    def persist(role: str, content: str, citations: list | None = None):
        """Persist a message if we have an active conversation."""
        if not active_conv_id:
            logger.warning(f"No active conversation — cannot persist {role} message")
            return
        if not content:
            logger.warning(f"Empty {role} content — skipping persist")
            return
        try:
            add_message(active_conv_id, role, content, citations)
            cite_info = f", {len(citations)} citations" if citations else ""
            logger.info(f"Persisted [{role}] ({len(content)} chars{cite_info}) to conv {active_conv_id[:8]}")
        except Exception as e:
            logger.error(f"Failed to persist [{role}] message: {e}")

    # ── Helper: initialize/load conversation ─────────────
    async def load_conversation(conv_id: str):
        nonlocal chat_history, active_conv_id, session_citations
        conv = get_conversation(conv_id)
        if not conv:
            conv = create_conversation()
            conv_id = conv["id"]

        active_conv_id = conv_id
        chat_history = [
            {"role": m["role"], "content": m["content"]}
            for m in conv.get("messages", [])
        ]
        # Restore accumulated citations from last assistant message
        session_citations = []
        for m in reversed(conv.get("messages", [])):
            if m["role"] == "assistant" and m.get("citations"):
                session_citations = m["citations"]
                break

        # Attach per-message display citations to each assistant message
        enriched_messages = []
        for m in conv.get("messages", []):
            msg_copy = dict(m)
            if m["role"] == "assistant" and session_citations:
                _, display = filter_citations(m["content"], session_citations)
                msg_copy["display_citations"] = display
            enriched_messages.append(msg_copy)

        # Send history to client
        await ws.send_json({
            "type": "history",
            "conv_id": conv_id,
            "messages": enriched_messages,
        })

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "消息格式不对，发JSON过来"})
                continue

            msg_type = msg.get("type", "")

            # ── Stop generation ─────────────────────────
            if msg_type == "stop":
                logger.info("User requested stop")
                if cancel_event:
                    cancel_event.set()
                if tts_task and not tts_task.done():
                    tts_task.cancel()
                    tts_task = None
                continue

            # ── Conversation commands ──────────────────
            if msg_type == "load_conv":
                conv_id = msg.get("conv_id", "")
                if conv_id:
                    await load_conversation(conv_id)
                continue

            if msg_type == "new_conv":
                # Don't create server-side conversation yet — just reset
                # local state. The conversation is created on first message.
                active_conv_id = None
                chat_history = []
                await ws.send_json({
                    "type": "history",
                    "conv_id": None,
                    "messages": [],
                })
                continue

            if msg_type == "delete_conv":
                conv_id = msg.get("conv_id", "")
                if conv_id:
                    delete_conversation(conv_id)
                # If deleting the active conversation, reset to local clean state
                if conv_id == active_conv_id:
                    active_conv_id = None
                    chat_history = []
                    await ws.send_json({
                        "type": "history",
                        "conv_id": None,
                        "messages": [],
                    })
                # Send updated list
                await ws.send_json({
                    "type": "conv_list",
                    "conversations": list_conversations(),
                })
                continue

            # ── Chat message ────────────────────────────
            if msg_type != "chat":
                await ws.send_json({"type": "error", "message": f"未知消息类型: {msg_type}"})
                continue

            user_text = msg.get("text", "").strip()
            mode = msg.get("mode", "text")  # "text" or "voice"

            # Cancel any in-progress TTS from previous turn
            if tts_task and not tts_task.done():
                tts_task.cancel()
                tts_task = None
                logger.info("Cancelled previous TTS")

            if not user_text:
                continue

            # Auto-create conversation if not active
            # Use "conv_active" (not "history") to set the ID without
            # clearing the user message already displayed on frontend
            if not active_conv_id:
                conv = create_conversation()
                active_conv_id = conv["id"]
                chat_history = []
                await ws.send_json({
                    "type": "conv_active",
                    "conv_id": active_conv_id,
                })

            logger.info(f"User [{mode}] on conv {active_conv_id}: {user_text[:80]}...")

            # Persist user message
            persist("user", user_text)

            # Add user to LLM history
            chat_history.append({"role": "user", "content": user_text})

            # ── Agent-based LLM call (LLM decides if/when to search) ──
            cancel_event = asyncio.Event()
            await ws.send_json({"type": "status", "status": "thinking"})

            # Search callback: accumulates into session-level citations
            citations_offset = len(session_citations)

            async def do_search(query: str) -> tuple[str, list[dict]]:
                await ws.send_json({"type": "status", "status": "searching"})
                text, cites = await langsearch_search(query)
                session_citations.extend(cites)
                return text, cites

            citations_out: list = []
            llm_stream = chat_stream_agent(
                chat_history, do_search, citations_out,
                voice_mode=(mode == "voice"),
                citation_offset=citations_offset,
            )

            if mode == "voice":
                # Voice mode: stream text → send citations → finalize bubble → TTS
                logger.info(f"Voice mode ON")
                full_response = ""
                async for chunk in llm_stream:
                    if cancel_event.is_set():
                        break
                    full_response += chunk
                    await ws.send_json({"type": "text_chunk", "content": chunk})

                if cancel_event.is_set():
                    await ws.send_json({"type": "status", "status": "done"})
                    chat_history.append({"role": "assistant", "content": full_response})
                    if full_response.strip():
                        persist("assistant", full_response)
                    continue

                # Filter against ALL session citations, but only show referenced ones
                full_response, display_cites = filter_citations(full_response, session_citations)
                await ws.send_json({"type": "citations", "data": display_cites, "full": session_citations})

                # Now finalize — frontend has citations, will render badge URLs + cite list
                await ws.send_json({"type": "status", "status": "done"})

                # TTS in background — run as cancellable task
                async def _run_tts(text: str):
                    buf_ = text
                    while True:
                        m = _SENTENCE_END.search(buf_)
                        if not m:
                            break
                        sent = buf_[:m.end()].strip()
                        buf_ = buf_[m.end():]
                        if len(sent) >= 2:
                            tts_text = strip_for_tts(sent)
                            if tts_text.strip():
                                audio_bytes = await tts_sentence(tts_text)
                                if audio_bytes:
                                    b64 = base64.b64encode(audio_bytes).decode("ascii")
                                    await ws.send_json({"type": "audio", "data": b64})
                    if buf_.strip():
                        tts_text = strip_for_tts(buf_)
                        if tts_text.strip():
                            audio_bytes = await tts_sentence(tts_text)
                            if audio_bytes:
                                b64 = base64.b64encode(audio_bytes).decode("ascii")
                                await ws.send_json({"type": "audio", "data": b64})

                tts_task = asyncio.create_task(_run_tts(full_response))

                # Store both: full session list (for cross-turn) and display version
                persist("assistant", full_response, session_citations if session_citations else None)
                chat_history.append({"role": "assistant", "content": full_response})

                await ws.send_json({
                    "type": "conv_list",
                    "conversations": list_conversations(),
                })

            else:
                # Text mode: stream text only (no TTS)
                full_response = ""

                async for chunk in llm_stream:
                    if cancel_event.is_set():
                        break
                    full_response += chunk
                    await ws.send_json({"type": "text_chunk", "content": chunk})

                if cancel_event.is_set():
                    await ws.send_json({"type": "status", "status": "done"})
                    chat_history.append({"role": "assistant", "content": full_response})
                    if full_response.strip():
                        persist("assistant", full_response)
                    continue

                # Filter against ALL session citations for display
                full_response, display_cites = filter_citations(full_response, session_citations)

                # Store ALL session citations
                persist("assistant", full_response, session_citations if session_citations else None)
                chat_history.append({"role": "assistant", "content": full_response})

                await ws.send_json({"type": "citations", "data": display_cites, "full": session_citations})

                await ws.send_json({
                    "type": "conv_list",
                    "conversations": list_conversations(),
                })

            # Done with this turn
            await ws.send_json({"type": "status", "status": "done"})

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:
            pass


# ── Main ────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    from pathlib import Path

    cert_dir = Path(__file__).parent
    cert_pem = cert_dir / "cert.pem"
    cert_key = cert_dir / "cert.key"

    if cert_pem.exists() and cert_key.exists():
        logger.info(f"Starting OpenZhangXueFeng on https://{HOST}:{PORT}")
        uvicorn.run(
            "server:app",
            host=HOST,
            port=PORT,
            reload=True,
            log_level="info",
            ssl_keyfile=str(cert_key),
            ssl_certfile=str(cert_pem),
        )
    else:
        logger.info(f"Starting OpenZhangXueFeng on http://{HOST}:{PORT}")
        uvicorn.run(
            "server:app",
            host=HOST,
            port=PORT,
            reload=True,
            log_level="info",
        )
