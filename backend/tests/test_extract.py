import contextlib
import sys
import types
import unittest
from unittest.mock import patch

import backend.factcheck as factcheck_pkg
from backend.factcheck import extract
from backend.factcheck.extract import attach_timestamps, extract_claims
from backend.factcheck.models import Claim


@contextlib.contextmanager
def _install_fake_llm(fn):
    """Install a fake `backend.factcheck.llm` module for the duration of a test.

    extract.py imports llm lazily *inside* the function that needs it
    (`from backend.factcheck import llm`), specifically so tests work whether
    or not the real llm.py has landed yet. `from package import name` first
    checks `hasattr(package, name)` before ever consulting sys.modules, so if
    some other test in the same process has already triggered a real import
    of backend.factcheck.llm, patching sys.modules alone would be silently
    ignored — patch both the sys.modules entry and the package attribute.
    """
    fake = types.ModuleType("backend.factcheck.llm")
    fake.complete = fn
    with patch.dict(sys.modules, {"backend.factcheck.llm": fake}):
        with patch.object(factcheck_pkg, "llm", fake, create=True):
            yield


def _claim_payload(
    text: str,
    weight: int = 2,
    kind: str = "statistic",
    search_query: str = "some primary source query",
    source_quote: str | None = None,
) -> dict:
    return {
        "text": text,
        "kind": kind,
        "weight": weight,
        "search_query": search_query,
        "source_quote": source_quote if source_quote is not None else text,
    }


class ChunkRangesTests(unittest.TestCase):
    def test_empty_transcript_has_no_chunks(self):
        self.assertEqual(extract._chunk_ranges(0), [])

    def test_transcript_shorter_than_chunk_is_one_chunk(self):
        self.assertEqual(extract._chunk_ranges(100), [(0, 100)])

    def test_transcript_exactly_chunk_size_is_one_chunk(self):
        self.assertEqual(extract._chunk_ranges(extract.CHUNK_WORDS), [(0, extract.CHUNK_WORDS)])

    def test_overlap_between_consecutive_chunks_matches_constant(self):
        word_count = extract.CHUNK_WORDS + 800
        ranges = extract._chunk_ranges(word_count)
        self.assertEqual(len(ranges), 2)
        (start_0, end_0), (start_1, end_1) = ranges
        self.assertEqual((start_0, end_0), (0, extract.CHUNK_WORDS))
        self.assertEqual(end_1, word_count)
        overlap = end_0 - start_1
        self.assertEqual(overlap, extract.CHUNK_OVERLAP_WORDS)

    def test_many_chunks_each_end_at_or_before_total_and_last_reaches_end(self):
        word_count = extract.CHUNK_WORDS * 3 + 137
        ranges = extract._chunk_ranges(word_count)
        self.assertGreater(len(ranges), 2)
        for start, end in ranges:
            self.assertLessEqual(end, word_count)
            self.assertLess(start, end)
        self.assertEqual(ranges[-1][1], word_count)
        # Every consecutive pair overlaps by exactly CHUNK_OVERLAP_WORDS,
        # except possibly the final short tail chunk.
        # ranges[1:] is deliberately one element shorter (it's every range but
        # the first), so this pairing is not a strict zip.
        for (_s0, e0), (s1, _e1) in zip(ranges, ranges[1:]):  # noqa: B905
            self.assertEqual(e0 - s1, extract.CHUNK_OVERLAP_WORDS)


class ExtractClaimsTests(unittest.TestCase):
    def test_llm_unavailable_yields_empty_list_without_raising(self):
        with _install_fake_llm(lambda **kwargs: None):
            claims = extract_claims("word " * 50)
        self.assertEqual(claims, [])

    def test_empty_transcript_short_circuits_without_calling_llm(self):
        calls = []
        with _install_fake_llm(lambda **kwargs: calls.append(1) or {"claims": []}):
            claims = extract_claims("")
        self.assertEqual(claims, [])
        self.assertEqual(calls, [])

    def test_single_chunk_transcript_extracts_claims_with_sequential_ids(self):
        payload = {
            "claims": [
                _claim_payload("Measles vaccination prevented 60 million deaths.", weight=3),
                _claim_payload("Earth's atmosphere is 78% nitrogen.", weight=1),
            ]
        }
        with _install_fake_llm(lambda **kwargs: payload):
            claims = extract_claims("short transcript " * 10)
        self.assertEqual(len(claims), 2)
        self.assertEqual([c.id for c in claims], ["c1", "c2"])
        # Sorted highest weight first.
        self.assertEqual(claims[0].weight, 3)
        self.assertEqual(claims[1].weight, 1)

    def test_malformed_claim_from_llm_is_dropped_not_raised(self):
        empty_text_claim = {
            "text": "",
            "kind": "statistic",
            "weight": 2,
            "search_query": "q",
            "source_quote": "q",
        }
        missing_text_claim = {"kind": "statistic", "weight": 2, "search_query": "q"}
        payload = {
            "claims": [
                empty_text_claim,
                _claim_payload("A valid claim here.", weight=2),
                missing_text_claim,
            ]
        }
        with _install_fake_llm(lambda **kwargs: payload):
            claims = extract_claims("short transcript " * 10)
        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0].text, "A valid claim here.")

    def test_dedupe_across_overlap_keeps_higher_weight(self):
        # Two chunks: the overlap region produces the "same" claim twice with
        # different weight. Chunks run concurrently, so route each fake
        # response by chunk CONTENT (not call order, which is a race) —
        # chunk 1 covers words w0..w2499, chunk 2 covers w2300..w2999, so
        # only chunk 1's text contains the token "w0".
        word_count = extract.CHUNK_WORDS + 500
        transcript = " ".join(f"w{i}" for i in range(word_count))

        low_weight_text = "Measles vaccination prevented sixty million deaths worldwide since 2000."
        high_weight_text = (
            "Measles vaccination prevented sixty million deaths worldwide since 2000!"
        )

        def fake_complete(**kwargs):
            user = kwargs.get("user", "")
            if "w0 " in user:
                return {"claims": [_claim_payload(low_weight_text, weight=1)]}
            return {"claims": [_claim_payload(high_weight_text, weight=3)]}

        with _install_fake_llm(fake_complete):
            claims = extract_claims(transcript)

        self.assertEqual(len(claims), 1)
        self.assertEqual(claims[0].weight, 3)
        self.assertEqual(claims[0].text, high_weight_text)

    def test_distinct_claims_are_not_merged(self):
        payload = {
            "claims": [
                _claim_payload("Measles vaccination prevented 60 million deaths.", weight=2),
                _claim_payload("The Roman Empire fell in 476 AD.", weight=2),
            ]
        }
        with _install_fake_llm(lambda **kwargs: payload):
            claims = extract_claims("short transcript " * 10)
        self.assertEqual(len(claims), 2)

    def test_max_claims_caps_keeping_highest_weight_first(self):
        # Distinct subjects so the dedupe pass (similarity > 0.85) never
        # collapses any of these — this test is purely about the cap.
        topics = [
            "The Great Wall of China is not visible from the Moon.",
            "Measles vaccination prevented sixty million deaths since 2000.",
            "The Roman Empire fell in 476 AD.",
            "Earth's atmosphere is roughly 78 percent nitrogen.",
            "Global average temperature has risen 1.1 degrees Celsius.",
            "The Empire State Building is struck by lightning yearly.",
            "Humans use virtually all of their brain, not ten percent.",
        ]
        weights = [1, 3, 2, 1, 3, 2, 1]
        payload = {
            "claims": [
                _claim_payload(text, weight=w) for text, w in zip(topics, weights, strict=True)
            ]
        }
        with _install_fake_llm(lambda **kwargs: payload):
            claims = extract_claims("short transcript " * 10, max_claims=3)
        self.assertEqual(len(claims), 3)
        self.assertEqual([c.weight for c in claims], [3, 3, 2])
        self.assertEqual([c.id for c in claims], ["c1", "c2", "c3"])

    def test_max_claims_none_falls_back_to_config_default(self):
        # Lexically distinct subjects so none collapse under the dedupe pass.
        topics = [
            "The Great Wall of China is not visible from the Moon with the naked eye.",
            "Measles vaccination prevented sixty million deaths since 2000.",
            "The Roman Empire fell in 476 AD when the emperor was deposed.",
            "Earth's atmosphere is roughly 78 percent nitrogen by volume.",
            "Global average temperature has risen 1.1 degrees Celsius since 1850.",
            "The Empire State Building is struck by lightning about twenty times a year.",
            "Humans use virtually all of their brain, not just ten percent.",
            "Carbon dioxide concentrations exceeded 420 parts per million recently.",
            "Apollo 11 landed on the Moon on July 20th, 1969.",
            "Recommended daily water intake evidence is weaker than commonly assumed.",
        ]
        payload = {"claims": [_claim_payload(text, weight=1) for text in topics]}
        with _install_fake_llm(lambda **kwargs: payload):
            with patch("backend.factcheck.extract.config") as mock_config:
                mock_config.factcheck_concurrency = 4
                mock_config.factcheck_max_claims = 5
                claims = extract_claims("short transcript " * 10)
        self.assertEqual(len(claims), 5)


class AttachTimestampsTests(unittest.TestCase):
    def test_no_segments_is_a_noop(self):
        claim = Claim(
            id="c1",
            text="Some claim",
            kind="statistic",
            weight=1,
            search_query="q",
            source_quote="the exact quote",
        )
        attach_timestamps([claim], None)
        self.assertIsNone(claim.timestamp_s)
        attach_timestamps([claim], [])
        self.assertIsNone(claim.timestamp_s)

    def test_matches_quote_to_correct_segment(self):
        claim_a = Claim(
            id="c1",
            text="Measles claim",
            kind="statistic",
            weight=2,
            search_query="q",
            source_quote="prevented sixty million deaths",
        )
        claim_b = Claim(
            id="c2",
            text="Roman Empire claim",
            kind="historical",
            weight=1,
            search_query="q",
            source_quote="fell in 476 AD",
        )
        segments = [
            {"start": 0.0, "text": "Welcome back to the channel, today we discuss history."},
            {
                "start": 12.5,
                "text": "Measles vaccination prevented sixty million deaths worldwide.",
            },
            {
                "start": 40.0,
                "text": "The Roman Empire fell in 476 AD when the emperor was deposed.",
            },
        ]
        attach_timestamps([claim_a, claim_b], segments)
        self.assertEqual(claim_a.timestamp_s, 12.5)
        self.assertEqual(claim_b.timestamp_s, 40.0)

    def test_claim_without_source_quote_is_skipped(self):
        claim = Claim(
            id="c1", text="x", kind="statistic", weight=1, search_query="q", source_quote=None
        )
        segments = [{"start": 1.0, "text": "anything at all"}]
        attach_timestamps([claim], segments)
        self.assertIsNone(claim.timestamp_s)

    def test_no_match_leaves_timestamp_none(self):
        claim = Claim(
            id="c1",
            text="x",
            kind="statistic",
            weight=1,
            search_query="q",
            source_quote="a quote that appears nowhere in the segments",
        )
        segments = [{"start": 1.0, "text": "completely unrelated segment text"}]
        attach_timestamps([claim], segments)
        self.assertIsNone(claim.timestamp_s)

    def test_normalization_handles_quote_and_punctuation_variance(self):
        claim = Claim(
            id="c1",
            text="x",
            kind="statistic",
            weight=1,
            search_query="q",
            source_quote="the ‘measles’ vaccine — worked",
        )
        segments = [{"start": 5.0, "text": "the 'measles' vaccine - worked well overall"}]
        attach_timestamps([claim], segments)
        self.assertEqual(claim.timestamp_s, 5.0)


if __name__ == "__main__":
    unittest.main()
