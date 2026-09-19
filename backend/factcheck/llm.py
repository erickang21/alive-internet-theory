"""LLM provider shim for the fact-check engine.

One function, `complete`, turns (system prompt, user prompt, JSON schema)
into a parsed JSON object, regardless of which provider is configured via
`config.factcheck_provider`: "openai" (default), "gateway" (Browserbase
Model Gateway, OpenAI-compatible), or "anthropic".

Degradation matches backend/scoring/fact_check.py: the first credentials
failure logs ONE warning and flips a module-level flag so every later call
returns None without touching the network. `complete` never raises for a
credentials problem — callers (extract.py, verify.py, ...) just see None and
skip that piece of work. A misconfigured "gateway" provider (no URL) is a
setup mistake, not a runtime credentials problem, so that case raises
RuntimeError with a fix-it message instead of degrading silently.
"""

import functools
import json
import logging
import time
from typing import Any

import anthropic
import openai

from backend.config import config

logger = logging.getLogger(__name__)

MAX_OUTPUT_TOKENS = 4096
RETRY_SLEEP_SECONDS = 2.0

# On a safety decline, the beta API re-runs the request on Anthropic's
# recommended fallback model instead of failing outright (see
# backend/scoring/fact_check.py, which uses the same beta).
ANTHROPIC_FALLBACK_BETA = "server-side-fallback-2026-07-01"

# Retried once after a short sleep; anything else (bad request, refusal,
# unparseable JSON) is not worth retrying and is handled separately.
TRANSIENT_OPENAI_ERRORS = (
    openai.RateLimitError,
    openai.InternalServerError,
    openai.APITimeoutError,
    openai.APIConnectionError,
)
TRANSIENT_ANTHROPIC_ERRORS = (
    anthropic.RateLimitError,
    anthropic.InternalServerError,
    anthropic.APITimeoutError,
    anthropic.APIConnectionError,
    anthropic.OverloadedError,
)

# Set on the first credentials failure so the rest of the run degrades with
# one warning instead of one error per call.
_disabled = False


class _CredentialsUnavailable(Exception):
    """Internal-only: signals complete() to disable further calls and return None."""


def reset() -> None:
    """Re-enable calls after a credentials failure, and drop cached clients.

    Tests need this to isolate cases; production code never calls it.
    """
    global _disabled
    _disabled = False
    _openai_client.cache_clear()
    _gateway_client.cache_clear()
    _anthropic_client.cache_clear()


def harden_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Recursively make a JSON Schema safe for OpenAI strict json_schema mode.

    Strict mode requires `additionalProperties: false` on every object node
    and a `required` list naming EVERY key in that node's `properties`, at
    every nesting level (object properties and array items). Callers write
    plain JSON Schema; this normalizes it so they can't get the strict-mode
    details wrong.
    """
    if not isinstance(schema, dict):
        return schema
    hardened = dict(schema)
    if hardened.get("type") == "object" and isinstance(hardened.get("properties"), dict):
        hardened["properties"] = {
            key: harden_schema(value) for key, value in hardened["properties"].items()
        }
        hardened["required"] = list(hardened["properties"].keys())
        hardened["additionalProperties"] = False
    if hardened.get("type") == "array" and "items" in hardened:
        hardened["items"] = harden_schema(hardened["items"])
    return hardened


def complete(
    system: str,
    user: str,
    schema: dict[str, Any],
    *,
    schema_name: str = "result",
    max_output_tokens: int = MAX_OUTPUT_TOKENS,
) -> dict[str, Any] | None:
    """Run one structured-output completion, or None if the LLM is unavailable."""
    if _disabled:
        return None
    hardened = harden_schema(schema)
    provider = config.factcheck_provider
    try:
        if provider == "openai":
            return _complete_openai(system, user, hardened, schema_name, max_output_tokens)
        if provider == "gateway":
            return _complete_gateway(system, user, hardened, schema_name, max_output_tokens)
        if provider == "anthropic":
            return _complete_anthropic(system, user, hardened, schema_name, max_output_tokens)
        raise RuntimeError(f"Unknown FACTCHECK_LLM_PROVIDER: {provider!r}")
    except RuntimeError:
        # A setup mistake (unknown provider, or "gateway" with no URL): the
        # run should fail loudly, not silently skip fact-checking.
        raise
    except (
        _CredentialsUnavailable,
        openai.AuthenticationError,
        anthropic.AuthenticationError,
        anthropic.CredentialsError,
    ) as error:
        _disable(str(error))
        return None
    except Exception as error:  # noqa: BLE001 - an LLM hiccup must never crash analyze.py
        logger.warning("LLM completion failed, skipping this call: %s", error)
        return None


def _disable(reason: str) -> None:
    global _disabled
    _disabled = True
    logger.warning(
        "Skipping LLM-backed fact-check calls for this run: %s. Set OPENAI_API_KEY, "
        "BROWSERBASE_API_KEY, or ANTHROPIC_API_KEY (depending on FACTCHECK_LLM_PROVIDER) "
        "in the repo-root or backend/.env.",
        reason,
    )


def _call_with_retry(call: Any, transient_errors: tuple[type[Exception], ...]) -> Any:
    try:
        return call()
    except transient_errors as error:
        logger.warning(
            "Transient LLM API error, retrying once in %.0fs: %s", RETRY_SLEEP_SECONDS, error
        )
        time.sleep(RETRY_SLEEP_SECONDS)
        return call()


@functools.cache
def _openai_client() -> openai.OpenAI:
    return openai.OpenAI(api_key=config.openai_api_key)


@functools.cache
def _gateway_client() -> openai.OpenAI:
    return openai.OpenAI(base_url=config.gateway_url, api_key=config.browserbase_api_key)


@functools.cache
def _anthropic_client() -> anthropic.Anthropic:
    return anthropic.Anthropic()


def _complete_openai_compatible(
    client: openai.OpenAI,
    system: str,
    user: str,
    schema: dict[str, Any],
    schema_name: str,
    max_output_tokens: int,
) -> dict[str, Any]:
    def _call() -> Any:
        return client.chat.completions.create(
            model=config.factcheck_model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": schema_name, "strict": True, "schema": schema},
            },
            max_completion_tokens=max_output_tokens,
        )

    response = _call_with_retry(_call, TRANSIENT_OPENAI_ERRORS)
    message = response.choices[0].message
    if message.refusal:
        raise ValueError(f"model refused: {message.refusal}")
    return _parse_object(message.content)


def _complete_openai(
    system: str, user: str, schema: dict[str, Any], schema_name: str, max_output_tokens: int
) -> dict[str, Any]:
    if not config.openai_api_key:
        raise _CredentialsUnavailable("no OPENAI_API_KEY configured")
    return _complete_openai_compatible(
        _openai_client(), system, user, schema, schema_name, max_output_tokens
    )


def _complete_gateway(
    system: str, user: str, schema: dict[str, Any], schema_name: str, max_output_tokens: int
) -> dict[str, Any]:
    if not config.gateway_url:
        raise RuntimeError(
            "FACTCHECK_LLM_PROVIDER=gateway requires BROWSERBASE_GATEWAY_URL, but "
            "Browserbase ships no public REST endpoint for Model Gateway as of "
            "2026-09-19 (verified by probing 5 candidate hosts). Set "
            "FACTCHECK_LLM_PROVIDER=openai instead."
        )
    if not config.browserbase_api_key:
        raise _CredentialsUnavailable("no BROWSERBASE_API_KEY configured")
    return _complete_openai_compatible(
        _gateway_client(), system, user, schema, schema_name, max_output_tokens
    )


def _complete_anthropic(
    system: str, user: str, schema: dict[str, Any], schema_name: str, max_output_tokens: int
) -> dict[str, Any]:
    client = _anthropic_client()
    if client.api_key is None and client.auth_token is None and client.credentials is None:
        raise _CredentialsUnavailable("no Anthropic credentials found")

    def _call() -> Any:
        return client.beta.messages.create(
            model=config.factcheck_model,
            max_tokens=max_output_tokens,
            betas=[ANTHROPIC_FALLBACK_BETA],
            fallbacks="default",
            system=system,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": user}],
        )

    response = _call_with_retry(_call, TRANSIENT_ANTHROPIC_ERRORS)
    _check_anthropic_stop(response)
    text = next(block.text for block in response.content if block.type == "text")
    return _parse_object(text)


def _parse_object(raw: str) -> dict[str, Any]:
    """Parse a model response and insist it is a JSON object.

    A provider can hand back a bare list or scalar even under a json_schema
    request. Every caller does `result.get(...)`, so letting a non-dict through
    turns into an AttributeError deep inside extract/verify rather than the
    normal "LLM unavailable" degradation. Reject it once, here.
    """
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError(f"expected a JSON object, got {type(parsed).__name__}")
    return parsed


def _check_anthropic_stop(response: Any) -> None:
    if response.stop_reason == "refusal":
        category = response.stop_details.category if response.stop_details else None
        raise ValueError(f"model declined to respond (category: {category})")
    if response.stop_reason == "max_tokens":
        raise ValueError("response hit max_output_tokens before finishing")
