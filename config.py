"""
OpenZhangXueFeng configuration — loaded from .env file and environment variables.
"""

import os
from dotenv import load_dotenv

load_dotenv()


# ── DeepSeek ──────────────────────────────────────────────
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-v4-pro")

# ── Fish Audio TTS ────────────────────────────────────────
FISH_AUDIO_API_KEY = os.getenv("FISH_AUDIO_API_KEY", "")
FISH_AUDIO_VOICE_ID = os.getenv(
    "FISH_AUDIO_VOICE_ID", "802e3bc2b27e49c2995d23ef70e6ac89"
)
FISH_AUDIO_LATENCY = os.getenv("FISH_AUDIO_LATENCY", "balanced")
FISH_AUDIO_FORMAT = os.getenv("FISH_AUDIO_FORMAT", "pcm")

# ── LangSearch ────────────────────────────────────────────
LANGSEARCH_API_KEY = os.getenv("LANGSEARCH_API_KEY", "")

# ── Server ────────────────────────────────────────────────
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))


def validate():
    """Raise if required keys are missing. Call on startup."""
    missing = []
    if not DEEPSEEK_API_KEY:
        missing.append("DEEPSEEK_API_KEY")
    if not FISH_AUDIO_API_KEY:
        missing.append("FISH_AUDIO_API_KEY")
    if not LANGSEARCH_API_KEY:
        missing.append("LANGSEARCH_API_KEY")
    if missing:
        raise RuntimeError(
            f"Missing required config keys: {', '.join(missing)}. "
            f"Copy .env.example to .env and fill in your API keys."
        )
