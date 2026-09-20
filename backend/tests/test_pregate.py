"""Tests for the fiction/non-fiction pre-gate.

No network and no real LLM: `llm.complete` is monkeypatched everywhere. Several
tests assert the mock was NEVER called, because the whole point of Tier 1 is
deciding without spending a request.
"""

import pytest

from backend.factcheck import pregate
from backend.factcheck.pregate import (
    BYPASS_CATEGORIES,
    FICTION_CATEGORIES,
    MAX_DESCRIPTION_CHARS,
    NON_FICTION_CATEGORIES,
    PROCEED_CATEGORIES,
    PreGateResult,
    pre_gate,
)

LONG_TRANSCRIPT = " ".join(f"word{i}" for i in range(200))


class _Spy:
    """Stands in for llm.complete and records whether it was called."""

    def __init__(self, result=None):
        self.result = result
        self.calls: list[dict] = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        return self.result

    @property
    def called(self) -> bool:
        return bool(self.calls)


@pytest.fixture
def spy(monkeypatch):
    spy = _Spy()
    # pregate imports llm lazily inside _classify, so patch the module attribute
    # the import resolves to.
    from backend.factcheck import llm

    monkeypatch.setattr(llm, "complete", spy)
    return spy


def _gate(**overrides):
    kwargs = {
        "title": "A video",
        "description": "A description",
        "transcript": LONG_TRANSCRIPT,
        "categories": None,
    }
    kwargs.update(overrides)
    return pre_gate(**kwargs)


# --- Tier 1: free, and must not touch the LLM -------------------------------


@pytest.mark.parametrize("category", sorted(BYPASS_CATEGORIES))
def test_bypass_categories_decide_without_an_llm_call(spy, category):
    result = _gate(categories=[category])
    assert result.is_eligible is False
    assert result.source == "category"
    assert not spy.called, f"{category} should not have cost an LLM call"


@pytest.mark.parametrize("category", sorted(PROCEED_CATEGORIES))
def test_proceed_categories_decide_without_an_llm_call(spy, category):
    result = _gate(categories=[category])
    assert result.is_eligible is True
    assert result.source == "category"
    assert not spy.called, f"{category} should not have cost an LLM call"


@pytest.mark.parametrize("category", ["Entertainment", "People & Blogs", "Howto & Style"])
def test_ambiguous_categories_reach_the_classifier(spy, category):
    spy.result = {"category": "commentary", "reason": "Argues about real events."}
    result = _gate(categories=[category])
    assert spy.called, f"{category} is ambiguous and must be classified, not assumed"
    assert result.source == "llm"
    assert result.is_eligible is True


@pytest.mark.parametrize("categories", [None, []])
def test_missing_categories_fall_through_to_the_classifier(spy, categories):
    spy.result = {"category": "educational", "reason": "Explains a topic."}
    assert _gate(categories=categories).source == "llm"
    assert spy.called


def test_bypass_wins_when_a_video_carries_several_categories(spy):
    result = _gate(categories=["Gaming", "Education"])
    assert result.is_eligible is False
    assert not spy.called


# --- Short transcripts short-circuit ----------------------------------------


def test_short_transcript_short_circuits_without_an_llm_call(spy):
    result = _gate(transcript="Only a handful of words here.")
    assert result.is_eligible is False
    assert result.category == "insufficient_signal"
    assert not spy.called


def test_short_transcript_beats_even_a_proceed_category(spy):
    # Nothing to fact-check is nothing to fact-check, whatever YouTube labelled it.
    result = _gate(transcript="Too short.", categories=["Education"])
    assert result.category == "insufficient_signal"
    assert not spy.called


# --- Tier 2 outcomes ---------------------------------------------------------


@pytest.mark.parametrize("category", sorted(NON_FICTION_CATEGORIES))
def test_every_non_fiction_category_is_eligible(spy, category):
    spy.result = {"category": category, "reason": "Because."}
    assert _gate().is_eligible is True


@pytest.mark.parametrize("category", sorted(FICTION_CATEGORIES))
def test_every_fiction_category_is_not_eligible(spy, category):
    spy.result = {"category": category, "reason": "Because."}
    assert _gate().is_eligible is False


def test_llm_unavailable_fails_closed_as_unknown(spy):
    spy.result = None
    result = _gate()
    assert result.is_eligible is False
    assert result.category == "unknown"
    assert result.source == "fallback"


def test_category_outside_the_taxonomy_is_unknown(spy):
    spy.result = {"category": "interpretive_dance", "reason": "Invented."}
    result = _gate()
    assert result.category == "unknown"
    assert result.source == "fallback"


def test_non_dict_llm_response_is_unknown(spy):
    spy.result = ["not", "a", "dict"]
    assert _gate().category == "unknown"


def test_classifier_raising_is_unknown_not_an_exception(monkeypatch):
    from backend.factcheck import llm

    def boom(**_kwargs):
        raise RuntimeError("upstream died")

    monkeypatch.setattr(llm, "complete", boom)
    result = _gate()
    assert result.category == "unknown"
    assert result.source == "fallback"


def test_unknown_reason_does_not_claim_the_video_is_fiction(spy):
    # We failed closed to protect the API budget; saying "this is fiction" would
    # assert something we never actually determined.
    spy.result = None
    reason = _gate().reason.lower()
    assert "fiction" not in reason
    assert "classif" in reason


def test_blank_model_reason_is_replaced(spy):
    spy.result = {"category": "educational", "reason": "   "}
    assert _gate().reason.strip()


# --- Prompt construction -----------------------------------------------------


def test_description_is_truncated_before_prompting(spy):
    spy.result = {"category": "educational", "reason": "ok"}
    _gate(description="x" * 5000)
    prompt = spy.calls[0]["user"]
    assert "x" * MAX_DESCRIPTION_CHARS in prompt
    assert "x" * (MAX_DESCRIPTION_CHARS + 1) not in prompt


def test_only_the_opening_sentences_are_sent(spy):
    spy.result = {"category": "educational", "reason": "ok"}
    transcript = " ".join(f"Sentence number {i} here." for i in range(40))
    _gate(transcript=transcript)
    prompt = spy.calls[0]["user"]
    assert "Sentence number 0" in prompt
    assert "Sentence number 39" not in prompt


# --- Robustness --------------------------------------------------------------


@pytest.mark.parametrize(
    "kwargs",
    [
        {"title": None, "description": None, "transcript": None, "categories": None},
        {"title": "", "description": "", "transcript": "", "categories": []},
    ],
)
def test_pre_gate_never_raises_on_empty_input(spy, kwargs):
    assert isinstance(pre_gate(**kwargs), PreGateResult)


def test_to_dict_emits_exactly_the_camelcase_boundary_keys():
    result = PreGateResult(True, "educational", "Because.", "llm")
    assert result.to_dict() == {
        "isEligible": True,
        "category": "educational",
        "reason": "Because.",
        "source": "llm",
    }


def test_taxonomy_sets_do_not_overlap():
    assert not (NON_FICTION_CATEGORIES & FICTION_CATEGORIES)


def test_youtube_category_mapping_always_yields_a_taxonomy_value():
    for category in BYPASS_CATEGORIES | PROCEED_CATEGORIES:
        mapped = pregate._taxonomy_for_youtube_category(category)
        assert mapped in NON_FICTION_CATEGORIES | FICTION_CATEGORIES


def test_tier1_eligibility_agrees_with_the_taxonomy_mapping(spy):
    # A Tier 1 decision and the taxonomy value it stores must not contradict
    # each other, or the UI would show "educational" on a skipped card.
    for category in BYPASS_CATEGORIES:
        result = _gate(categories=[category])
        assert result.is_eligible is pregate.is_eligible_category(result.category)
    for category in PROCEED_CATEGORIES:
        result = _gate(categories=[category])
        assert result.is_eligible is pregate.is_eligible_category(result.category)
