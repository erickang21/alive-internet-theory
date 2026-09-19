"""Tests for the anti-hallucination boundary in verify.py.

`llm.py` and `evidence.py` are owned by other agents and may not exist on disk
yet (or may exist with a different implementation mid-edit), so every test
injects fake `backend.factcheck.llm` / `backend.factcheck.evidence` modules
into `sys.modules` via monkeypatch. `verify.py` imports both lazily inside
its functions specifically so this works regardless of their build state.
No network, no real LLM calls.
"""

import sys
import types

import pytest

import backend.factcheck as factcheck_pkg
from backend.factcheck.models import Claim, Source
from backend.factcheck.verify import CITATIONS_FAILED_REASON, verify_all, verify_claim

MARKDOWN = (
    "# Sky Facts\n\n"
    "Scientists confirm the sky appears blue due to "
    "[Rayleigh scattering](https://en.wikipedia.org/wiki/Rayleigh_scattering) of sunlight, "
    "and researchers’ consensus on this has been stable for decades."
)
REAL_QUOTE = (
    "Scientists confirm the sky appears blue due to Rayleigh scattering of sunlight, "
    "and researchers’ consensus on this has been stable for decades."
)
# Same content as REAL_QUOTE but with a straight apostrophe, an embedded newline,
# and no markdown link markup -- must still match via normalize_for_match.
WHITESPACE_QUOTE_VARIANT = (
    "Scientists confirm the sky appears blue due to Rayleigh scattering of sunlight,\n"
    "and researchers' consensus on this has been stable for decades."
)
FABRICATED_QUOTE = "The sky is actually green according to leading physicists."


def _claim(claim_id: str = "c1", weight: int = 2, timestamp_s: float | None = None) -> Claim:
    return Claim(
        id=claim_id,
        text="The sky appears blue due to Rayleigh scattering.",
        kind="scientific",
        weight=weight,
        search_query="why is the sky blue Rayleigh scattering",
        timestamp_s=timestamp_s,
    )


def _source(
    url: str = "https://nasa.gov/sky-facts",
    domain: str = "nasa.gov",
    title: str = "Sky Facts",
    tier: int = 1,
    markdown: str | None = MARKDOWN,
    fetched_ok: bool = True,
    failure=None,
) -> Source:
    return Source(
        url=url,
        domain=domain,
        title=title,
        tier=tier,
        markdown=markdown,
        fetched_ok=fetched_ok,
        failure=failure,
    )


def _install_fake_module(monkeypatch, name, **attrs):
    """Replace a backend.factcheck submodule for one test.

    Patching sys.modules alone is not enough. verify.py imports these lazily as
    `from backend.factcheck import X`, which reads the attribute off the already
    imported package and never consults sys.modules. So once any other test file
    has imported the real submodule, a sys.modules-only fake is silently ignored
    and the test exercises the real module instead. Patch both.
    """
    fake = types.ModuleType(f"backend.factcheck.{name}")
    for key, value in attrs.items():
        setattr(fake, key, value)
    monkeypatch.setitem(sys.modules, f"backend.factcheck.{name}", fake)
    monkeypatch.setattr(factcheck_pkg, name, fake, raising=False)
    return fake


def _install_fake_llm(monkeypatch, complete_fn):
    _install_fake_module(monkeypatch, "llm", complete=complete_fn)


def _install_fake_evidence(monkeypatch):
    _install_fake_module(
        monkeypatch, "evidence", excerpt_for=lambda markdown, claim: (markdown or "")[:4000]
    )


# --- fabricated quote is dropped --------------------------------------------


def test_fabricated_quote_is_dropped(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "verified_true",
            "reasoning": "The source confirms the claim.",
            "debunk": None,
            "citations": [{"source_index": 0, "quote": FABRICATED_QUOTE}],
        },
    )
    claim = _claim()
    verdict = verify_claim(claim, [_source()])

    assert verdict.citations == []
    assert verdict.status == "verified_true"  # drop alone doesn't force a downgrade here


# --- out-of-range source_index is dropped -----------------------------------


def test_out_of_range_source_index_is_dropped(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "verified_true",
            "reasoning": "Looks right.",
            "debunk": None,
            "citations": [{"source_index": 5, "quote": REAL_QUOTE}],
        },
    )
    claim = _claim()
    verdict = verify_claim(claim, [_source()])  # only index 0 is valid

    assert verdict.citations == []


# --- false verdict with only a fabricated citation downgrades --------------


def test_false_verdict_with_only_fabricated_citation_downgrades(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "false",
            "reasoning": "The claim contradicts the source.",
            "debunk": "Actually the sky is blue, not green.",
            "citations": [{"source_index": 0, "quote": FABRICATED_QUOTE}],
        },
    )
    claim = _claim()
    verdict = verify_claim(claim, [_source()])

    assert verdict.status == "unverifiable"
    assert verdict.truth_score is None
    assert verdict.unverifiable_reason == CITATIONS_FAILED_REASON
    assert verdict.citations == []
    assert verdict.debunk is None  # debunk only kept for false/misleading


# --- legitimate quote survives; url always comes from OUR Source -----------


def test_legit_quote_survives_and_url_cannot_be_faked(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "verified_true",
            "reasoning": "Confirmed by an authoritative source.",
            "debunk": None,
            # A well-behaved model wouldn't include "url", but even if extra
            # keys slipped through, verify.py must never read them.
            "citations": [
                {
                    "source_index": 0,
                    "quote": REAL_QUOTE,
                    "url": "https://attacker.example/fake",
                }
            ],
        },
    )
    real_source = _source(url="https://nasa.gov/sky-facts", domain="nasa.gov", title="Sky Facts")
    claim = _claim()
    verdict = verify_claim(claim, [real_source])

    assert len(verdict.citations) == 1
    citation = verdict.citations[0]
    assert citation.url == "https://nasa.gov/sky-facts"
    assert citation.domain == "nasa.gov"
    assert citation.title == "Sky Facts"
    assert citation.quote == REAL_QUOTE
    assert citation.url != "https://attacker.example/fake"


# --- whitespace / curly-quote / markdown-link variance still matches -------


def test_quote_matches_despite_whitespace_curly_quotes_and_link_markup(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "verified_true",
            "reasoning": "Matches the source.",
            "debunk": None,
            "citations": [{"source_index": 0, "quote": WHITESPACE_QUOTE_VARIANT}],
        },
    )
    claim = _claim()
    verdict = verify_claim(claim, [_source()])

    assert len(verdict.citations) == 1
    assert verdict.citations[0].quote == WHITESPACE_QUOTE_VARIANT


# --- zero usable sources -----------------------------------------------------


def test_zero_usable_sources_returns_unverifiable_and_never_raises(monkeypatch):
    # No fake llm/evidence installed at all -- verify_claim must return before
    # ever attempting to import them, since there is nothing to verify against.
    claim = _claim()
    unfetched = _source(fetched_ok=False, markdown=None, failure="timeout")
    verdict = verify_claim(claim, [unfetched])

    assert verdict.status == "unverifiable"
    assert verdict.truth_score is None
    assert verdict.citations == []
    assert verdict.unverifiable_reason is not None
    assert "timeout" in verdict.unverifiable_reason


def test_no_sources_at_all_returns_unverifiable():
    claim = _claim()
    verdict = verify_claim(claim, [])

    assert verdict.status == "unverifiable"
    assert verdict.truth_score is None
    assert verdict.sources_consulted == []


# --- llm.complete returning None ---------------------------------------------


def test_llm_unavailable_returns_unverifiable_and_never_raises(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(monkeypatch, lambda **kw: None)

    claim = _claim()
    verdict = verify_claim(claim, [_source()])

    assert verdict.status == "unverifiable"
    assert verdict.truth_score is None
    assert verdict.citations == []


# --- debunk is None for a verified_true verdict ------------------------------


def test_debunk_is_none_for_verified_true(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "verified_true",
            "reasoning": "Solidly confirmed.",
            "debunk": "This text should be discarded by verify.py.",
            "citations": [{"source_index": 0, "quote": REAL_QUOTE}],
        },
    )
    claim = _claim()
    verdict = verify_claim(claim, [_source()])

    assert verdict.status == "verified_true"
    assert verdict.debunk is None


# --- debunk falls back to reasoning when the model omits one ----------------


def test_debunk_falls_back_to_reasoning_when_omitted(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "misleading",
            "reasoning": "The claim overstates the consensus.",
            "debunk": None,
            "citations": [{"source_index": 0, "quote": REAL_QUOTE}],
        },
    )
    claim = _claim()
    verdict = verify_claim(claim, [_source()])

    assert verdict.status == "misleading"
    assert verdict.debunk == "The claim overstates the consensus."


# --- unrecognized status from the model degrades safely ---------------------


def test_unrecognized_status_returns_unverifiable(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "definitely_true_probably",
            "reasoning": "nonsense",
            "debunk": None,
            "citations": [],
        },
    )
    claim = _claim()
    verdict = verify_claim(claim, [_source()])

    assert verdict.status == "unverifiable"
    assert verdict.truth_score is None


# --- llm.complete raising is swallowed, never propagates --------------------


def test_llm_raising_is_swallowed(monkeypatch):
    _install_fake_evidence(monkeypatch)

    def _boom(**kw):
        raise RuntimeError("network exploded")

    _install_fake_llm(monkeypatch, _boom)

    claim = _claim()
    verdict = verify_claim(claim, [_source()])

    assert verdict.status == "unverifiable"
    assert verdict.truth_score is None


# --- verify_all --------------------------------------------------------------


def test_verify_all_handles_missing_sources_entry_and_multiple_claims(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "verified_true",
            "reasoning": "Confirmed.",
            "debunk": None,
            "citations": [{"source_index": 0, "quote": REAL_QUOTE}],
        },
    )
    claim_a = _claim(claim_id="a")
    claim_b = _claim(claim_id="b")
    sources_by_claim = {"a": [_source()]}  # "b" intentionally missing

    verdicts = verify_all([claim_a, claim_b], sources_by_claim)

    assert len(verdicts) == 2
    by_id = {v.claim.id: v for v in verdicts}
    assert by_id["a"].status == "verified_true"
    assert by_id["b"].status == "unverifiable"  # no sources entry -> empty list


# --- a citation must carry enough text to be evidence ------------------------
# Regression: the substring check alone let "the" verify against any page, and a
# non-empty citation list suppresses the downgrade that would otherwise catch it,
# so a model could substantiate a "false" verdict with filler.

_EVIDENCE_MD = (
    "# NASA\n\nThe Great Wall of China is **not** visible from the Moon with the "
    "naked eye.\n\nCO2 exceeded 420 ppm in 2023 according to monitoring stations."
)


def _evidence_source():
    return _source(markdown=_EVIDENCE_MD)


@pytest.mark.parametrize("quote", ["the", "is", "a", "   the   ", "of", "not visible"])
def test_quotes_too_thin_to_be_evidence_are_dropped(monkeypatch, quote):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda *a, **k: {
            "status": "false",
            "reasoning": "r",
            "debunk": "d",
            "citations": [{"source_index": 0, "quote": quote}],
        },
    )
    verdict = verify_claim(_claim(), [_evidence_source()])
    assert verdict.citations == []
    assert verdict.status == "unverifiable"
    assert verdict.unverifiable_reason == CITATIONS_FAILED_REASON


@pytest.mark.parametrize(
    "quote",
    ["not visible from the Moon with the naked eye", "CO2 exceeded 420 ppm in 2023"],
)
def test_substantive_quotes_still_survive(monkeypatch, quote):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda *a, **k: {
            "status": "false",
            "reasoning": "r",
            "debunk": "d",
            "citations": [{"source_index": 0, "quote": quote}],
        },
    )
    verdict = verify_claim(_claim(), [_evidence_source()])
    assert len(verdict.citations) == 1
    assert verdict.status == "false"


def test_bool_source_index_is_rejected(monkeypatch):
    # bool subclasses int, so `source_index: true` would otherwise read usable[1]
    # and misattribute the quote to the wrong source.
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda *a, **k: {
            "status": "false",
            "reasoning": "r",
            "debunk": "d",
            "citations": [
                {"source_index": True, "quote": "not visible from the Moon with the naked eye"}
            ],
        },
    )
    verdict = verify_claim(_claim(), [_evidence_source(), _evidence_source()])
    assert verdict.citations == []


# --- malformed model output must degrade, not crash --------------------------
# Regression: the citations list can contain anything the model emitted. A bare
# string in it used to raise AttributeError straight out of verify_claim, whose
# docstring promises it never raises.


def test_non_dict_citation_item_is_dropped_not_raised(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "verified_true",
            "reasoning": "r",
            "debunk": None,
            "citations": ["not-a-dict", 42, None, {"source_index": 0, "quote": REAL_QUOTE}],
        },
    )
    verdict = verify_claim(_claim(), [_source()])
    assert len(verdict.citations) == 1  # only the well-formed one survives


def test_duplicate_citations_are_kept_once(monkeypatch):
    _install_fake_evidence(monkeypatch)
    _install_fake_llm(
        monkeypatch,
        lambda **kw: {
            "status": "verified_true",
            "reasoning": "r",
            "debunk": None,
            "citations": [
                {"source_index": 0, "quote": REAL_QUOTE},
                {"source_index": 0, "quote": REAL_QUOTE},
            ],
        },
    )
    assert len(verify_claim(_claim(), [_source()]).citations) == 1
