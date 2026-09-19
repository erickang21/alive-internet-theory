import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel

from backend.ytdlp import Download, SubtitleTrack

WHISPER_MODEL = "small"
VTT_TIMING = re.compile(r"^\d{2}:\d{2}[:.\d]* --> ")
VTT_TAG = re.compile(r"<[^>]+>")


def get_transcript(download: Download) -> dict[str, Any]:
    # Prefer auto captions: they keep the fillers and stutters the filler-word
    # criterion looks for, which uploaded captions strip by convention.
    tracks = sorted(download.subtitles, key=lambda track: track.kind != "asr")
    for track in tracks:
        text = _read_subtitles(track)
        if text:
            return {"text": text, "kind": track.kind, "language": track.language}

    # No captions, or only blank ones: transcribe the audio locally.
    return transcribe(download.video_path)


def transcribe(media_path: Path) -> dict[str, Any]:
    segments, info = _whisper().transcribe(str(media_path), vad_filter=True)
    text = " ".join(segment.text.strip() for segment in segments)
    # Whisper drops most fillers, so the filler criterion treats "whisper" like
    # uploaded captions and skips itself.
    return {"text": text, "kind": "whisper", "language": info.language}


@lru_cache(maxsize=1)
def _whisper() -> WhisperModel:
    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")


def _read_subtitles(track: SubtitleTrack) -> str:
    raw = track.path.read_text(encoding="utf-8")
    if track.path.suffix == ".json3":
        segments = (
            seg.get("utf8", "")
            for event in json.loads(raw).get("events", [])
            for seg in event.get("segs") or []
        )
        text = "".join(segments)
    else:
        text = _vtt_text(raw)
    return re.sub(r"\s+", " ", text).strip()


def _vtt_text(raw: str) -> str:
    lines: list[str] = []
    for block in raw.split("\n\n"):
        cue = block.strip().splitlines()
        if not any(VTT_TIMING.match(line) for line in cue):
            continue  # header, NOTE, or STYLE block
        for line in cue:
            if VTT_TIMING.match(line):
                continue
            line = VTT_TAG.sub("", line).strip()
            # Auto-caption VTT repeats each line in the next cue as it scrolls.
            if line and (not lines or lines[-1] != line):
                lines.append(line)
    return " ".join(lines)
