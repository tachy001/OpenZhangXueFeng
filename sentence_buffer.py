"""
Sentence buffer — accumulates LLM token stream and yields complete sentences
for natural-sounding TTS input.
"""

import re
from typing import AsyncGenerator


# Sentence-ending characters for Chinese and English
SENTENCE_ENDINGS = re.compile(r"[。！？.!?\n]")


class SentenceBuffer:
    """
    Buffers streaming text and yields complete sentences.

    Splits on Chinese/English sentence-ending punctuation.
    Falls back to yielding buffered text if it exceeds max_length
    (prevents unbounded buffering during long run-on output).
    """

    def __init__(self, min_length: int = 4, max_length: int = 200):
        self.min_length = min_length
        self.max_length = max_length
        self._buffer = ""

    def feed(self, text: str) -> list[str]:
        """Feed new text, return list of complete sentences."""
        self._buffer += text
        sentences = []
        while True:
            match = SENTENCE_ENDINGS.search(self._buffer)
            if not match:
                break
            end_idx = match.end()
            sentence = self._buffer[:end_idx].strip()
            self._buffer = self._buffer[end_idx:]
            if len(sentence) >= self.min_length:
                sentences.append(sentence)

        # Fallback: yield if buffer exceeds max_length
        if len(self._buffer) >= self.max_length:
            sentences.append(self._buffer.strip())
            self._buffer = ""

        return sentences

    def flush(self) -> str:
        """Return and clear remaining buffer content."""
        remaining = self._buffer.strip()
        self._buffer = ""
        return remaining

    def reset(self) -> None:
        """Clear buffer state for a new conversation turn."""
        self._buffer = ""


async def sentence_stream(
    text_generator: AsyncGenerator[str, None],
    min_length: int = 4,
    max_length: int = 200,
) -> AsyncGenerator[str, None]:
    """
    Wraps a token-level text generator and yields complete sentences.

    Usage:
        async for sentence in sentence_stream(llm_chat_stream()):
            audio = await tts(sentence)
    """
    buffer = SentenceBuffer(min_length=min_length, max_length=max_length)
    async for chunk in text_generator:
        for sentence in buffer.feed(chunk):
            yield sentence

    remaining = buffer.flush()
    if remaining:
        yield remaining
