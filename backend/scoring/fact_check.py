import json
import logging
from typing import Any

import anthropic
from anthropic.types.beta import BetaMessage, BetaMessageParam, BetaToolParam

logger = logging.getLogger(__name__)

MODEL = "claude-opus-5"
# On a safety decline, the API re-runs the request on Anthropic's recommended
# fallback model instead of failing the criterion.
FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_TOKENS = 16000
MAX_SEARCHES = 5
# A long search turn can pause server-side; resume it at most this many times.
MAX_CONTINUATIONS = 5

SKIPPED = {
    "criterion": "fact_check",
    "deduction": 0,
    "applied": False,
    "detail": "Skipped: no usable Anthropic credentials.",
}
# Set on the first credentials failure so the rest of the run skips the fact
# check with one warning instead of an error per video.
_credentials_unusable = False

CLASSIFY_PROMPT = """Below is the transcript of a YouTube video.

Decide whether the video is educational: non-fiction whose main purpose is to \
present factual claims about the real world that could be checked against \
independent sources (explainers, science, history, news analysis, health or \
finance advice, tutorials). Fiction, comedy, music, gaming, and personal vlogs \
are not educational, even if they mention facts in passing.

If it is educational, state the video's main thesis as one sentence. Otherwise \
return an empty thesis.

<transcript>
{transcript}
</transcript>"""

CLASSIFY_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "is_educational": {"type": "boolean"},
        "thesis": {"type": "string"},
    },
    "required": ["is_educational", "thesis"],
    "additionalProperties": False,
}

VERIFY_PROMPT = """A YouTube video's main thesis is:

"{thesis}"

Search the web for independent, reputable third-party sources, not the video \
or its creator, and check whether they confirm the thesis is correct. Then \
call report_verdict exactly once."""

VERDICT_TOOL: BetaToolParam = {
    "name": "report_verdict",
    "description": (
        "Report whether independent third-party sources confirm the thesis. "
        "hallucinated is false only when they confirm it is correct; it is true "
        "when they contradict it or when no independent confirmation exists."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "hallucinated": {"type": "boolean"},
            "justification": {
                "type": "string",
                "description": "One or two sentences on what the sources say.",
            },
            "sources": {
                "type": "array",
                "items": {"type": "string"},
                "description": "URLs of the sources the verdict rests on.",
            },
        },
        "required": ["hallucinated", "justification", "sources"],
        "additionalProperties": False,
    },
}


def score_transcript(transcript: str) -> dict[str, Any]:
    """Fact-check the video's main thesis, for educational content only.

    Recorded for the breakdown but not yet scored: the deduction is still TBD.
    """
    if _credentials_unusable:
        return SKIPPED
    client = anthropic.Anthropic()
    if client.api_key is None and client.auth_token is None and client.credentials is None:
        _disable("no Anthropic credentials found")
        return SKIPPED
    logger.info("fact check: deciding whether the video is educational")
    try:
        classification = _classify(client, transcript)
    except (anthropic.AuthenticationError, anthropic.CredentialsError) as error:
        _disable(f"Anthropic credentials didn't work: {str(error).rstrip('.')}")
        return SKIPPED
    if not classification["is_educational"]:
        return {
            "criterion": "fact_check",
            "deduction": 0,
            "applied": False,
            "detail": "Not educational content, so not fact-checked.",
            "evidence": {"is_educational": False, "thesis": None, "hallucinated": None},
        }

    thesis = classification["thesis"]
    logger.info('fact check: educational, thesis "%s"; checking it with web search', thesis)
    verdict = _verify(client, thesis)
    outcome = (
        "not confirmed by independent sources"
        if verdict["hallucinated"]
        else "confirmed by independent sources"
    )
    return {
        "criterion": "fact_check",
        "deduction": 0,
        "applied": False,
        "detail": f'Thesis "{thesis}" is {outcome}. {verdict["justification"]}',
        "evidence": {
            "is_educational": True,
            "thesis": thesis,
            "hallucinated": verdict["hallucinated"],
            "sources": verdict["sources"],
        },
    }


def _disable(reason: str) -> None:
    global _credentials_unusable
    _credentials_unusable = True
    logger.warning(
        "Skipping the fact check for this run: %s. Set ANTHROPIC_API_KEY in backend/.env "
        + "or run `ant auth login`.",
        reason,
    )


def _classify(client: anthropic.Anthropic, transcript: str) -> dict[str, Any]:
    response = client.beta.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        betas=[FALLBACK_BETA],
        fallbacks="default",
        output_config={"format": {"type": "json_schema", "schema": CLASSIFY_SCHEMA}},
        messages=[{"role": "user", "content": CLASSIFY_PROMPT.format(transcript=transcript)}],
    )
    _check_stop(response)
    text = next(block.text for block in response.content if block.type == "text")
    return json.loads(text)


def _verify(client: anthropic.Anthropic, thesis: str) -> dict[str, Any]:
    messages: list[BetaMessageParam] = [
        {"role": "user", "content": VERIFY_PROMPT.format(thesis=thesis)}
    ]
    for _ in range(MAX_CONTINUATIONS + 1):
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            betas=[FALLBACK_BETA],
            fallbacks="default",
            tools=[
                {"type": "web_search_20260209", "name": "web_search", "max_uses": MAX_SEARCHES},
                VERDICT_TOOL,
            ],
            messages=messages,
        )
        _check_stop(response)
        for block in response.content:
            if block.type == "tool_use" and block.name == VERDICT_TOOL["name"]:
                return block.input
        if response.stop_reason != "pause_turn":
            raise RuntimeError(f"fact check ended without a verdict ({response.stop_reason})")
        # The server paused a long search turn; resending it resumes where it left off.
        messages.append({"role": "assistant", "content": response.content})
    raise RuntimeError("fact check still paused after the maximum number of continuations")


def _check_stop(response: BetaMessage) -> None:
    if response.stop_reason == "refusal":
        category = response.stop_details.category if response.stop_details else None
        raise RuntimeError(f"model declined to fact-check (category: {category})")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("fact check response hit max_tokens")
