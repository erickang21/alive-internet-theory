import json
import logging
import re
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel  # pyright: ignore[reportMissingTypeStubs]

from backend.ytdlp import ANALYZED_SECONDS, Download, SubtitleTrack, download_audio

logger = logging.getLogger(__name__)

WHISPER_MODEL = "small"
VTT_TIMING = re.compile(r"^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3}) --> ")
VTT_TAG = re.compile(r"<[^>]+>")

# (start_seconds, text) per caption event or Whisper segment. The transcript text is
# these joined with single spaces, so a position in it maps back to a moment in the video.
Cue = tuple[float, str]


def _join(cues: list[Cue]) -> str:
    return " ".join(text for _, text in cues)


def get_transcript(download: Download) -> dict[str, Any]:
    """Transcript of the first ANALYZED_SECONDS, matching the downloaded video."""
    # Prefer auto captions: they keep the fillers and stutters the filler-word
    # criterion looks for, which uploaded captions strip by convention.
    tracks = sorted(download.subtitles, key=lambda track: track.kind != "asr")
    for track in tracks:
        cues = _read_subtitles(track)
        text = _join(cues)
        source = "auto-generated" if track.kind == "asr" else "uploaded"
        if text:
            logger.info(
                "transcript: %s captions (%s), %d words", source, track.language, len(text.split())
            )
            return {"text": text, "cues": cues, "kind": track.kind, "language": track.language}
        logger.info("transcript: %s captions (%s) are blank", source, track.language)

    # No captions, or only blank ones: transcribe the audio locally.
    logger.info("transcript: no usable captions, transcribing the audio with Whisper")
    audio_path = download_audio(download.video_id)
    return {**transcribe(audio_path), "audio_path": audio_path}


def transcribe(media_path: Path) -> dict[str, Any]:
    started = time.monotonic()
    # transcribe() leaves some parameter types unannotated upstream.
    segments, info = _whisper().transcribe(str(media_path), vad_filter=True)  # pyright: ignore[reportUnknownMemberType]
    # Segments are generated lazily, so this loop is where transcription happens.
    cues: list[Cue] = [
        (segment.start, text) for segment in segments if (text := segment.text.strip())
    ]
    text = _join(cues)
    logger.info(
        "transcript: Whisper (%s), %d words in %.0fs",
        info.language,
        len(text.split()),
        time.monotonic() - started,
    )
    # Whisper drops most fillers, so the filler criterion treats "whisper" like
    # uploaded captions and skips itself.
    return {"text": text, "cues": cues, "kind": "whisper", "language": info.language}


@lru_cache(maxsize=1)
def _whisper() -> WhisperModel:
    logger.info(
        "transcript: loading the Whisper %s model (the first run downloads ~460 MB)",
        WHISPER_MODEL,
    )
    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")


def _read_subtitles(track: SubtitleTrack) -> list[Cue]:
    raw = track.path.read_text(encoding="utf-8")
    if track.path.suffix != ".json3":
        return _vtt_cues(raw)
    events: list[dict[str, Any]] = json.loads(raw).get("events") or []
    cues: list[Cue] = []
    for event in events:
        start_ms = event.get("tStartMs", 0)
        if start_ms >= ANALYZED_SECONDS * 1000:
            break
        segs: list[dict[str, Any]] = event.get("segs") or []
        text = re.sub(r"\s+", " ", "".join(seg.get("utf8", "") for seg in segs)).strip()
        if text:
            cues.append((start_ms / 1000, text))
    return cues


def _vtt_cues(raw: str) -> list[Cue]:
    cues: list[Cue] = []
    for block in raw.split("\n\n"):
        cue = block.strip().splitlines()
        timing = next((m for line in cue if (m := VTT_TIMING.match(line))), None)
        if timing is None:
            continue  # header, NOTE, or STYLE block
        hours, minutes, seconds, millis = timing.groups()
        start = int(hours or 0) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000
        if start >= ANALYZED_SECONDS:
            break
        for line in cue:
            if VTT_TIMING.match(line):
                continue
            line = re.sub(r"\s+", " ", VTT_TAG.sub("", line)).strip()
            # Auto-caption VTT repeats each line in the next cue as it scrolls.
            if line and (not cues or cues[-1][1] != line):
                cues.append((start, line))
    return cues


def locate(cues: list[Cue], passage: str) -> float | None:
    """When in the video a passage of the transcript starts, if it can be found."""
    needle = " ".join(passage.split()).casefold()
    if not needle:
        return None
    position = _join(cues).casefold().find(needle)
    if position < 0:
        return None
    offset = 0
    for start, text in cues:
        offset += len(text) + 1
        if position < offset:
            return start
    return None
