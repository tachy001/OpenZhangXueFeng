"""
Fish Audio TTS + ASR client.

TTS: HTTP API per-sentence for streaming voice generation.
ASR: HTTP API for speech-to-text transcription.

API reference: https://docs.fish.audio
"""

import httpx

from config import (
    FISH_AUDIO_API_KEY,
    FISH_AUDIO_VOICE_ID,
    FISH_AUDIO_FORMAT,
)


FISH_AUDIO_TTS_URL = "https://api.fish.audio/v1/tts"
FISH_AUDIO_ASR_URL = "https://api.fish.audio/v1/asr"


# ═══════════════════════════════════════════════════════════
# TTS
# ═══════════════════════════════════════════════════════════

async def tts_sentence(text: str) -> bytes:
    """
    Convert a single sentence to speech via Fish Audio HTTP API.

    IMPORTANT: Caller should strip markdown from `text` before calling.
    Returns raw audio bytes in the configured format (default: PCM 44100Hz Int16 mono).
    """
    if not text.strip():
        return b""

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            FISH_AUDIO_TTS_URL,
            headers={
                "Authorization": f"Bearer {FISH_AUDIO_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "text": text,
                "reference_id": FISH_AUDIO_VOICE_ID,
                "format": FISH_AUDIO_FORMAT,
            },
        )
        response.raise_for_status()
        return response.content


# ═══════════════════════════════════════════════════════════
# ASR (Speech-to-Text)
# ═══════════════════════════════════════════════════════════

async def transcribe_audio(
    audio_bytes: bytes,
    language: str | None = None,
    ignore_timestamps: bool = True,
) -> dict:
    """
    Transcribe audio to text using Fish Audio ASR.

    API: POST /v1/asr  (multipart/form-data)

    Args:
        audio_bytes: Raw audio data (WAV, MP3, WebM, etc.)
        language: Optional language hint (e.g. "zh", "en"). None for auto-detect.
        ignore_timestamps: Skip precise timestamps for lower latency (default True).

    Returns:
        Dict with keys: text (str), duration (float), segments (list).
    """
    if not audio_bytes:
        return {"text": "", "duration": 0, "segments": []}

    data: dict = {"ignore_timestamps": str(ignore_timestamps).lower()}
    if language:
        data["language"] = language

    # Fish Audio ASR only accepts application/form-data or application/msgpack.
    # We use msgpack (binary serialization) for reliability.
    import msgpack

    payload: dict = {
        "audio": audio_bytes,
        "ignore_timestamps": ignore_timestamps,
    }
    if language:
        payload["language"] = language

    packed = msgpack.packb(payload)

    async with httpx.AsyncClient(timeout=60.0) as client:
        response = await client.post(
            FISH_AUDIO_ASR_URL,
            headers={
                "Authorization": f"Bearer {FISH_AUDIO_API_KEY}",
                "Content-Type": "application/msgpack",
            },
            content=packed,
        )
        if response.status_code >= 400:
            import logging
            _log = logging.getLogger("openzxf.asr")
            _log.error(f"ASR {response.status_code}: {response.text[:1000]}")
        response.raise_for_status()
        return response.json()
