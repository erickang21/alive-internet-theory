"""Tests for backend/factcheck/llm.py. No network: the SDK clients are mocked.

Config is a frozen dataclass, so tests never mutate the real `config`
singleton (or real env vars) — they monkeypatch the `config` name bound
inside backend.factcheck.llm to point at a `dataclasses.replace()`d copy.
"""

import dataclasses
import json
from typing import Any
from unittest.mock import MagicMock

import openai
import pytest

from backend.config import Config
from backend.factcheck import llm


@pytest.fixture(autouse=True)
def _reset_llm_state():
    """Every test starts with a clean _disabled flag and empty client caches."""
    llm.reset()
    yield
    llm.reset()


def _config(**overrides: Any) -> Config:
    return dataclasses.replace(llm.config, **overrides)


# --- harden_schema ---------------------------------------------------------


def test_harden_schema_nested_arrays_and_objects():
    schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "claims": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "citations": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "url": {"type": "string"},
                                    "quote": {"type": "string"},
                                },
                            },
                        },
                    },
                },
            },
        },
    }

    hardened = llm.harden_schema(schema)

    assert hardened["additionalProperties"] is False
    assert set(hardened["required"]) == {"name", "claims"}

    claim_schema = hardened["properties"]["claims"]["items"]
    assert claim_schema["additionalProperties"] is False
    assert set(claim_schema["required"]) == {"text", "citations"}

    citation_schema = claim_schema["properties"]["citations"]["items"]
    assert citation_schema["additionalProperties"] is False
    assert set(citation_schema["required"]) == {"url", "quote"}


def test_harden_schema_leaves_non_object_nodes_alone():
    schema = {"type": "string"}
    assert llm.harden_schema(schema) == {"type": "string"}


# --- provider dispatch -------------------------------------------------------


def _openai_response(payload: dict[str, Any], refusal: str | None = None) -> MagicMock:
    message = MagicMock(content=json.dumps(payload), refusal=refusal)
    choice = MagicMock(message=message)
    return MagicMock(choices=[choice])


def _anthropic_response(payload: dict[str, Any], stop_reason: str = "end_turn") -> MagicMock:
    block = MagicMock(type="text", text=json.dumps(payload))
    return MagicMock(content=[block], stop_reason=stop_reason, stop_details=None)


def test_dispatch_openai_calls_only_openai_client(monkeypatch):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="openai", openai_api_key="sk-real")
    )
    openai_client = MagicMock()
    openai_client.chat.completions.create.return_value = _openai_response({"ok": True})
    anthropic_client = MagicMock()
    monkeypatch.setattr(llm, "_openai_client", lambda: openai_client)
    monkeypatch.setattr(llm, "_anthropic_client", lambda: anthropic_client)

    result = llm.complete("sys", "usr", {"type": "object", "properties": {"ok": {}}})

    assert result == {"ok": True}
    openai_client.chat.completions.create.assert_called_once()
    anthropic_client.beta.messages.create.assert_not_called()


def test_dispatch_anthropic_calls_only_anthropic_client(monkeypatch):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="anthropic", factcheck_model="claude-opus-5")
    )
    anthropic_client = MagicMock(api_key="sk-ant-real", auth_token=None, credentials=None)
    anthropic_client.beta.messages.create.return_value = _anthropic_response({"ok": True})
    openai_client = MagicMock()
    monkeypatch.setattr(llm, "_anthropic_client", lambda: anthropic_client)
    monkeypatch.setattr(llm, "_openai_client", lambda: openai_client)

    result = llm.complete("sys", "usr", {"type": "object", "properties": {"ok": {}}})

    assert result == {"ok": True}
    anthropic_client.beta.messages.create.assert_called_once()
    openai_client.chat.completions.create.assert_not_called()


def test_dispatch_gateway_uses_gateway_client(monkeypatch):
    monkeypatch.setattr(
        llm,
        "config",
        _config(
            factcheck_provider="gateway",
            gateway_url="https://gateway.example.com/v1",
            browserbase_api_key="bb-real",
        ),
    )
    gateway_client = MagicMock()
    gateway_client.chat.completions.create.return_value = _openai_response({"ok": True})
    monkeypatch.setattr(llm, "_gateway_client", lambda: gateway_client)

    result = llm.complete("sys", "usr", {"type": "object", "properties": {"ok": {}}})

    assert result == {"ok": True}
    gateway_client.chat.completions.create.assert_called_once()


# --- credential degradation -------------------------------------------------


def test_empty_credentials_returns_none_and_logs_once(monkeypatch, caplog):
    monkeypatch.setattr(llm, "config", _config(factcheck_provider="openai", openai_api_key=""))

    with caplog.at_level("WARNING"):
        first = llm.complete("sys", "usr", {"type": "object", "properties": {}})
        second = llm.complete("sys", "usr", {"type": "object", "properties": {}})

    assert first is None
    assert second is None
    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    assert llm._disabled is True


def test_reset_re_enables_after_credentials_failure(monkeypatch):
    monkeypatch.setattr(llm, "config", _config(factcheck_provider="openai", openai_api_key=""))
    assert llm.complete("sys", "usr", {"type": "object", "properties": {}}) is None
    assert llm._disabled is True

    llm.reset()
    assert llm._disabled is False

    # Now give it real-looking credentials and a working mock client.
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="openai", openai_api_key="sk-real")
    )
    client = MagicMock()
    client.chat.completions.create.return_value = _openai_response({"ok": True})
    monkeypatch.setattr(llm, "_openai_client", lambda: client)

    assert llm.complete("sys", "usr", {"type": "object", "properties": {"ok": {}}}) == {
        "ok": True
    }


def test_openai_authentication_error_disables_future_calls(monkeypatch, caplog):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="openai", openai_api_key="sk-bad")
    )
    client = MagicMock()
    client.chat.completions.create.side_effect = openai.AuthenticationError(
        "invalid key", response=MagicMock(status_code=401, headers={}), body=None
    )
    monkeypatch.setattr(llm, "_openai_client", lambda: client)

    with caplog.at_level("WARNING"):
        first = llm.complete("sys", "usr", {"type": "object", "properties": {}})
        second = llm.complete("sys", "usr", {"type": "object", "properties": {}})

    assert first is None
    assert second is None
    # Second call short-circuits on the _disabled flag before ever touching
    # the client again.
    client.chat.completions.create.assert_called_once()


# --- gateway misconfiguration ------------------------------------------------


def test_gateway_without_url_raises_runtime_error(monkeypatch):
    monkeypatch.setattr(
        llm,
        "config",
        _config(factcheck_provider="gateway", gateway_url="", browserbase_api_key="bb-real"),
    )

    with pytest.raises(RuntimeError, match="BROWSERBASE_GATEWAY_URL"):
        llm.complete("sys", "usr", {"type": "object", "properties": {}})

    # A setup mistake is not a credentials problem: it must not disable
    # future calls.
    assert llm._disabled is False


# --- refusal / unparseable JSON --------------------------------------------


def test_unparseable_json_returns_none(monkeypatch, caplog):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="openai", openai_api_key="sk-real")
    )
    client = MagicMock()
    message = MagicMock(content="not json{{", refusal=None)
    client.chat.completions.create.return_value = MagicMock(choices=[MagicMock(message=message)])
    monkeypatch.setattr(llm, "_openai_client", lambda: client)

    with caplog.at_level("WARNING"):
        result = llm.complete("sys", "usr", {"type": "object", "properties": {}})

    assert result is None
    assert llm._disabled is False  # a bad response, not a credentials problem


def test_refusal_returns_none(monkeypatch):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="openai", openai_api_key="sk-real")
    )
    client = MagicMock()
    client.chat.completions.create.return_value = _openai_response(
        {}, refusal="cannot help with that"
    )
    monkeypatch.setattr(llm, "_openai_client", lambda: client)

    result = llm.complete("sys", "usr", {"type": "object", "properties": {}})

    assert result is None
    assert llm._disabled is False


def test_anthropic_refusal_stop_reason_returns_none(monkeypatch):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="anthropic", factcheck_model="claude-opus-5")
    )
    client = MagicMock(api_key="sk-ant-real", auth_token=None, credentials=None)
    client.beta.messages.create.return_value = MagicMock(
        content=[], stop_reason="refusal", stop_details=None
    )
    monkeypatch.setattr(llm, "_anthropic_client", lambda: client)

    result = llm.complete("sys", "usr", {"type": "object", "properties": {}})

    assert result is None


# --- retry-once on transient errors -----------------------------------------


def test_transient_error_is_retried_once_then_succeeds(monkeypatch):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="openai", openai_api_key="sk-real")
    )
    client = MagicMock()
    rate_limit_error = openai.RateLimitError(
        "slow down", response=MagicMock(status_code=429, headers={}), body=None
    )
    client.chat.completions.create.side_effect = [
        rate_limit_error,
        _openai_response({"ok": True}),
    ]
    monkeypatch.setattr(llm, "_openai_client", lambda: client)
    monkeypatch.setattr(llm.time, "sleep", lambda _seconds: None)

    result = llm.complete("sys", "usr", {"type": "object", "properties": {"ok": {}}})

    assert result == {"ok": True}
    assert client.chat.completions.create.call_count == 2


def test_transient_error_twice_returns_none_without_disabling(monkeypatch):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="openai", openai_api_key="sk-real")
    )
    client = MagicMock()
    client.chat.completions.create.side_effect = openai.APITimeoutError(request=MagicMock())
    monkeypatch.setattr(llm, "_openai_client", lambda: client)
    monkeypatch.setattr(llm.time, "sleep", lambda _seconds: None)

    result = llm.complete("sys", "usr", {"type": "object", "properties": {}})

    assert result is None
    assert client.chat.completions.create.call_count == 2
    assert llm._disabled is False


# --- schema hardening is actually applied inside complete() -----------------


def test_complete_sends_hardened_schema_to_openai(monkeypatch):
    monkeypatch.setattr(
        llm, "config", _config(factcheck_provider="openai", openai_api_key="sk-real")
    )
    client = MagicMock()
    client.chat.completions.create.return_value = _openai_response({"ok": True})
    monkeypatch.setattr(llm, "_openai_client", lambda: client)

    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}}
    llm.complete("sys", "usr", schema, schema_name="my_schema")

    _, kwargs = client.chat.completions.create.call_args
    sent_schema = kwargs["response_format"]["json_schema"]["schema"]
    assert sent_schema["additionalProperties"] is False
    assert sent_schema["required"] == ["ok"]
    assert kwargs["response_format"]["json_schema"]["name"] == "my_schema"
    assert kwargs["response_format"]["json_schema"]["strict"] is True


def test_non_dict_json_response_is_rejected():
    """A provider can return a bare list even under a json_schema request.

    Every caller does result.get(...), so a non-dict must be treated as a
    malformed response rather than handed onward to crash extract/verify.
    """
    import pytest

    from backend.factcheck.llm import _parse_object

    assert _parse_object('{"a": 1}') == {"a": 1}
    for raw in ["[1, 2, 3]", '"a string"', "42", "null", "true"]:
        with pytest.raises(ValueError):
            _parse_object(raw)
