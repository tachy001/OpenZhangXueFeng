"""
Conversation storage — JSON file-based persistence.

Stores each conversation as a JSON file for a chat-app experience.
"""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional


# ── Paths ───────────────────────────────────────────────
DATA_DIR = Path(__file__).parent / "data"
CONVERSATIONS_DIR = DATA_DIR / "conversations"
INDEX_PATH = DATA_DIR / "conversations_index.json"


def _ensure_dirs():
    """Create data directories if they don't exist."""
    CONVERSATIONS_DIR.mkdir(parents=True, exist_ok=True)


def _load_index() -> list[dict]:
    """Load the conversation index."""
    _ensure_dirs()
    if INDEX_PATH.exists():
        try:
            return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, IOError):
            return []
    return []


def _save_index(index: list[dict]):
    """Save the conversation index."""
    _ensure_dirs()
    INDEX_PATH.write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _conv_path(conv_id: str) -> Path:
    return CONVERSATIONS_DIR / f"{conv_id}.json"


# ── Public API ─────────────────────────────────────────────

def create_conversation(title: str = "新对话") -> dict:
    """Create a new conversation and return its metadata."""
    conv_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()

    conversation = {
        "id": conv_id,
        "title": title,
        "created_at": now,
        "updated_at": now,
        "messages": [],
    }

    _conv_path(conv_id).write_text(
        json.dumps(conversation, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    index = _load_index()
    index.insert(0, {
        "id": conv_id,
        "title": title,
        "created_at": now,
        "updated_at": now,
    })
    _save_index(index)

    return conversation


def get_conversation(conv_id: str) -> Optional[dict]:
    """Load a conversation by ID."""
    path = _conv_path(conv_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, IOError):
        return None


def list_conversations() -> list[dict]:
    """List all conversations (metadata only, most recent first)."""
    index = _load_index()
    # Sort by updated_at descending
    index.sort(key=lambda c: c.get("updated_at", ""), reverse=True)
    return index


def update_conversation(
    conv_id: str,
    messages: Optional[list[dict]] = None,
    title: Optional[str] = None,
):
    """Update a conversation's messages and/or title."""
    conversation = get_conversation(conv_id)
    if not conversation:
        return

    now = datetime.now(timezone.utc).isoformat()
    if messages is not None:
        conversation["messages"] = messages

    # Auto-title from first user message if no title set
    if title:
        conversation["title"] = title
    elif (
        conversation["title"] == "新对话"
        and conversation["messages"]
    ):
        first_user = next(
            (m["content"][:30] for m in conversation["messages"] if m["role"] == "user"),
            None,
        )
        if first_user:
            conversation["title"] = first_user

    conversation["updated_at"] = now

    _conv_path(conv_id).write_text(
        json.dumps(conversation, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Update index
    index = _load_index()
    for item in index:
        if item["id"] == conv_id:
            item["title"] = conversation["title"]
            item["updated_at"] = now
            break
    _save_index(index)


def delete_conversation(conv_id: str) -> bool:
    """Delete a conversation. Returns True if deleted."""
    path = _conv_path(conv_id)
    if path.exists():
        path.unlink()

    index = _load_index()
    index = [item for item in index if item["id"] != conv_id]
    _save_index(index)
    return True


def add_message(conv_id: str, role: str, content: str, citations: list | None = None):
    """Add a single message to a conversation and persist."""
    _ensure_dirs()
    conversation = get_conversation(conv_id)
    if not conversation:
        raise FileNotFoundError(
            f"Conversation {conv_id} not found at {_conv_path(conv_id)}"
        )

    msg: dict = {
        "role": role,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if citations:
        msg["citations"] = citations

    conversation["messages"].append(msg)
    conversation["updated_at"] = datetime.now(timezone.utc).isoformat()

    _conv_path(conv_id).write_text(
        json.dumps(conversation, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    # Update index timestamp
    index = _load_index()
    for item in index:
        if item["id"] == conv_id:
            item["updated_at"] = conversation["updated_at"]
            # Auto-title from first user message
            if item["title"] == "新对话" and role == "user":
                item["title"] = content[:30]
                conversation["title"] = content[:30]
                # Re-save with updated title
                _conv_path(conv_id).write_text(
                    json.dumps(conversation, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            break
    _save_index(index)
