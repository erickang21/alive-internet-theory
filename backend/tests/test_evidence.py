import unittest
from unittest.mock import patch

from backend.browserbase import FetchResult
from backend.factcheck import evidence
from backend.factcheck.evidence import classify_domain, excerpt_for, gather_all, gather_evidence
from backend.factcheck.models import Claim
from backend.factcheck.text_utils import normalize_for_match


def _claim(**overrides) -> Claim:
    defaults = dict(
        id="c1",
        text="Measles vaccination prevented an estimated 60 million deaths since 2000.",
        kind="statistic",
        weight=2,
        search_query="WHO measles vaccination deaths prevented estimate report",
        source_quote="prevented an estimated 60 million deaths",
    )
    defaults.update(overrides)
    return Claim(**defaults)


def _search_result(url: str, title: str = "title") -> dict:
    return {"id": url, "url": url, "title": title, "publishedDate": None, "image": None}


class ClassifyDomainTests(unittest.TestCase):
    def test_explicit_tier1_domain(self):
        self.assertEqual(classify_domain("https://www.nih.gov/some/page"), ("nih.gov", 1))

    def test_www_is_stripped_and_matches_same_as_bare_host(self):
        bare = classify_domain("https://nih.gov/page")
        www = classify_domain("https://www.nih.gov/page")
        self.assertEqual(bare, www)
        self.assertEqual(bare, ("nih.gov", 1))

    def test_generic_gov_suffix_catches_unlisted_gov_host(self):
        domain, tier = classify_domain("https://www.usda.gov/topics")
        self.assertEqual(tier, 1)
        self.assertEqual(domain, "usda.gov")

    def test_generic_edu_suffix(self):
        _domain, tier = classify_domain("https://cs.stanford.edu/research")
        self.assertEqual(tier, 1)

    def test_generic_int_suffix(self):
        _domain, tier = classify_domain("https://www.who.int/news")
        self.assertEqual(tier, 1)

    def test_arxiv_tier1(self):
        self.assertEqual(classify_domain("https://arxiv.org/abs/1234.5678"), ("arxiv.org", 1))

    def test_subdomain_matches_tier2_dotted_parent(self):
        domain, tier = classify_domain("https://news.bbc.co.uk/story/1")
        self.assertEqual(tier, 2)
        self.assertEqual(domain, "bbc.co.uk")

    def test_reuters_tier2(self):
        self.assertEqual(classify_domain("https://www.reuters.com/world/x")[1], 2)

    def test_unknown_domain_is_tier3(self):
        self.assertEqual(classify_domain("https://some-random-blog.example.com/post")[1], 3)

    def test_excluded_domains_are_not_special_cased_by_classify_domain(self):
        # classify_domain only tiers; exclusion is a separate check applied
        # before a domain ever reaches classify_domain in the search path.
        domain, tier = classify_domain("https://www.reddit.com/r/science")
        self.assertEqual(domain, "reddit.com")
        self.assertEqual(tier, 3)


class SearchCandidatesTests(unittest.TestCase):
    @patch("backend.browserbase.search")
    def test_excluded_domains_never_appear_in_results(self, mock_search):
        mock_search.return_value = [
            _search_result("https://www.reddit.com/r/science/1"),
            _search_result("https://en.wikipedia.org/wiki/Measles"),
            _search_result("https://www.who.int/measles-report"),
        ]
        candidates = evidence._search_candidates(_claim())
        urls = [c.url for c in candidates]
        self.assertNotIn("https://www.reddit.com/r/science/1", urls)
        self.assertNotIn("https://en.wikipedia.org/wiki/Measles", urls)
        self.assertIn("https://www.who.int/measles-report", urls)

    @patch("backend.browserbase.search")
    def test_sorts_tier1_before_tier2_before_tier3(self, mock_search):
        # Deliberately returned in the "wrong" order (tier 3 first) so the
        # sort is what puts tier 1 ahead, not incidental search rank.
        mock_search.return_value = [
            _search_result("https://randomblog.example.com/a"),  # tier 3
            _search_result("https://www.reuters.com/world/b"),  # tier 2
            _search_result("https://www.nih.gov/c"),  # tier 1
        ]
        candidates = evidence._search_candidates(_claim())
        tiers = [c.tier for c in candidates]
        self.assertEqual(tiers, sorted(tiers))
        self.assertEqual(candidates[0].domain, "nih.gov")

    @patch("backend.browserbase.search")
    def test_original_rank_breaks_ties_within_a_tier(self, mock_search):
        mock_search.return_value = [
            _search_result("https://www.nih.gov/first"),
            _search_result("https://www.cdc.gov/second"),
        ]
        candidates = evidence._search_candidates(_claim())
        self.assertEqual([c.url for c in candidates], [
            "https://www.nih.gov/first",
            "https://www.cdc.gov/second",
        ])

    @patch("backend.browserbase.search", side_effect=RuntimeError("boom"))
    def test_never_raises_even_if_search_blows_up(self, _mock_search):
        self.assertEqual(evidence._search_candidates(_claim()), [])


class GatherEvidenceTests(unittest.TestCase):
    @patch("backend.browserbase.fetch_markdown")
    @patch("backend.browserbase.search")
    def test_failing_fetch_is_excluded_from_usable_sources(self, mock_search, mock_fetch):
        mock_search.return_value = [
            _search_result("https://www.nih.gov/good"),
            _search_result("https://www.cdc.gov/bad"),
        ]

        def fake_fetch(url):
            if "good" in url:
                return FetchResult(
                    url=url, ok=True, content="A" * 300, status_code=200, failure=None
                )
            return FetchResult(url=url, ok=False, content=None, status_code=504, failure="timeout")

        mock_fetch.side_effect = fake_fetch

        sources = gather_evidence(_claim())
        usable = [s for s in sources if s.fetched_ok]
        unusable = [s for s in sources if not s.fetched_ok]

        self.assertEqual([s.url for s in usable], ["https://www.nih.gov/good"])
        self.assertEqual([s.url for s in unusable], ["https://www.cdc.gov/bad"])
        self.assertEqual(unusable[0].failure, "timeout")

    @patch("backend.browserbase.fetch_markdown")
    @patch("backend.browserbase.search")
    def test_not_ok_treated_as_unusable_even_with_no_failure_reason(self, mock_search, mock_fetch):
        # Per contract: failure is None when the API key was missing and
        # nothing was attempted — `ok` alone decides usability.
        mock_search.return_value = [_search_result("https://www.nih.gov/x")]
        mock_fetch.return_value = FetchResult(
            url="https://www.nih.gov/x", ok=False, content=None, status_code=None, failure=None
        )
        sources = gather_evidence(_claim())
        self.assertEqual(len(sources), 1)
        self.assertFalse(sources[0].fetched_ok)

    @patch("backend.browserbase.fetch_markdown")
    @patch("backend.browserbase.search")
    def test_caps_fetches_at_sources_per_claim(self, mock_search, mock_fetch):
        mock_search.return_value = [
            _search_result(f"https://www.nih.gov/{i}") for i in range(6)
        ]
        mock_fetch.side_effect = lambda url: FetchResult(
            url=url, ok=True, content="A" * 300, status_code=200, failure=None
        )
        sources = gather_evidence(_claim())
        self.assertLessEqual(len(sources), evidence.DEFAULT_SOURCES_PER_CLAIM)
        self.assertEqual(mock_fetch.call_count, evidence.DEFAULT_SOURCES_PER_CLAIM)

    @patch("backend.browserbase.search", side_effect=RuntimeError("boom"))
    def test_gather_evidence_never_raises(self, _mock_search):
        self.assertEqual(gather_evidence(_claim()), [])


class GatherAllTests(unittest.TestCase):
    @patch("backend.browserbase.fetch_markdown")
    @patch("backend.browserbase.search")
    def test_returns_dict_keyed_by_claim_id(self, mock_search, mock_fetch):
        mock_search.return_value = [_search_result("https://www.nih.gov/x")]
        mock_fetch.return_value = FetchResult(
            url="https://www.nih.gov/x", ok=True, content="A" * 300, status_code=200, failure=None
        )
        claims = [_claim(id="c1"), _claim(id="c2", search_query="other query")]
        result = gather_all(claims)
        self.assertEqual(set(result.keys()), {"c1", "c2"})
        self.assertTrue(all(s.fetched_ok for s in result["c1"]))

    def test_empty_claim_list_returns_empty_dict(self):
        self.assertEqual(gather_all([]), {})

    @patch("backend.browserbase.search", side_effect=RuntimeError("boom"))
    def test_never_raises_when_search_fails_for_every_claim(self, _mock_search):
        result = gather_all([_claim(id="c1"), _claim(id="c2")])
        self.assertEqual(result, {"c1": [], "c2": []})


class ExcerptForTests(unittest.TestCase):
    def _markdown(self) -> str:
        # No blank line inside `lede` itself — _split_paragraphs treats any
        # blank line as a paragraph boundary, and the lede must stay one block.
        lede = "# CDC Report on Measles: this page summarizes vaccination outcomes."
        relevant_1 = (
            "Measles vaccination programs prevented an estimated sixty million deaths "
            "worldwide between 2000 and 2023, according to surveillance data compiled "
            "by the World Health Organization and partner agencies." * 3
        )
        irrelevant = (
            "Unrelated paragraph about office scheduling and building access badges "
            "having nothing whatsoever to do with any public health topic at all." * 3
        )
        relevant_2 = (
            "Additional estimates of measles vaccination deaths prevented show similar "
            "figures across multiple independent surveillance datasets and reports." * 3
        )
        return "\n\n".join([lede, irrelevant, relevant_1, relevant_2])

    def test_empty_markdown_returns_empty_string(self):
        self.assertEqual(excerpt_for("", _claim()), "")
        self.assertEqual(excerpt_for(None, _claim()), "")

    def test_stays_under_budget(self):
        filler_paragraphs = [
            f"Measles vaccination deaths prevented estimate number {i}. " * 50 for i in range(30)
        ]
        big_markdown = "\n\n".join(["# Title\n\nLede paragraph."] + filler_paragraphs)
        result = excerpt_for(big_markdown, _claim())
        self.assertLessEqual(len(result), evidence.EXCERPT_BUDGET)

    def test_preserves_original_document_order(self):
        # Two relevant paragraphs, far apart, with an irrelevant one between
        # them; both should be kept (small enough to fit) and in doc order.
        markdown = self._markdown()
        result = excerpt_for(markdown, _claim())
        parts = result.split(evidence._EXCERPT_SEPARATOR)
        # relevant_1 mentions "sixty million deaths", relevant_2 mentions
        # "Additional estimates" — assert relevant_1's marker text precedes
        # relevant_2's marker text in the excerpt, matching document order.
        idx_1 = result.find("sixty million deaths")
        idx_2 = result.find("Additional estimates")
        self.assertNotEqual(idx_1, -1)
        self.assertNotEqual(idx_2, -1)
        self.assertLess(idx_1, idx_2)
        expected_lede = evidence._split_paragraphs(markdown)[0][: evidence.LEDE_CHARS]
        self.assertEqual(parts[0], expected_lede)

    def test_excerpt_paragraphs_are_substrings_of_full_text_when_normalized(self):
        markdown = self._markdown()
        result = excerpt_for(markdown, _claim())
        normalized_full = normalize_for_match(markdown)
        for part in result.split(evidence._EXCERPT_SEPARATOR):
            normalized_part = normalize_for_match(part)
            self.assertIn(normalized_part, normalized_full)

    def test_keyword_scoring_prefers_relevant_paragraph_over_irrelevant(self):
        markdown = self._markdown()
        result = excerpt_for(markdown, _claim())
        self.assertIn("sixty million deaths", result)
        self.assertNotIn("office scheduling", result)


if __name__ == "__main__":
    unittest.main()


# --- navigation chrome must not eat the LLM budget ---------------------------
# Regression: a site's nav menu repeats verbatim across a page and is dense in the
# page's own keywords, so it scored well and crowded real prose out. Measured on a
# live CDC page it took 49% of the excerpt, the same menu three times over.

_NAV_BLOCK = (
    "- [About](https://cdc.gov/measles/about) - [Symptoms](https://cdc.gov/measles/sym) "
    "- [How It Spreads](https://cdc.gov/measles/spread) - [Vaccines](https://cdc.gov/vax)"
)
_PROSE = (
    "Measles vaccination prevented an estimated 60 million deaths worldwide between "
    "2000 and 2023, according to surveillance data compiled by health agencies."
)


def _nav_claim():
    return Claim(
        id="c1",
        text="Measles vaccination prevented 60 million deaths between 2000 and 2023",
        kind="statistic",
        weight=2,
        search_query="measles vaccination deaths prevented about symptoms spreads vaccines",
    )


def test_navigation_blocks_are_excluded_from_the_excerpt():
    markdown = "\n\n".join(["# Measles Data", _NAV_BLOCK, _PROSE, _NAV_BLOCK])
    excerpt = excerpt_for(markdown, _nav_claim())
    assert _PROSE in excerpt
    assert "[About](https://cdc.gov/measles/about)" not in excerpt


def test_repeated_paragraphs_are_kept_only_once():
    markdown = "\n\n".join(["# Measles Data", _PROSE, _PROSE, _PROSE])
    assert excerpt_for(markdown, _nav_claim()).count(_PROSE) == 1


def test_a_paragraph_with_few_links_is_still_kept():
    # One inline citation is prose, not a menu — the nav filter must not eat it.
    cited = f"{_PROSE} See [the WHO report](https://who.int/measles) for details."
    excerpt = excerpt_for("\n\n".join(["# Measles Data", cited]), _nav_claim())
    assert "the WHO report" in excerpt


def test_excerpt_paragraphs_remain_substrings_of_the_full_markdown():
    # The soundness property verify.py depends on: anything the model can see in the
    # excerpt must still be findable in the full markdown it is checked against.
    markdown = "\n\n".join(["# Measles Data", _NAV_BLOCK, _PROSE, "Other text here."])
    excerpt = excerpt_for(markdown, _nav_claim())
    full_normalized = normalize_for_match(markdown)
    for paragraph in excerpt.split("\n\n"):
        if paragraph.strip() and paragraph.strip() != "[...]":
            assert normalize_for_match(paragraph) in full_normalized
