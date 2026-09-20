import unittest
from unittest.mock import MagicMock, patch

from backend import browserbase


def _response(status_code: int = 200, json_data: dict | None = None, ok: bool | None = None):
    response = MagicMock()
    response.status_code = status_code
    response.ok = ok if ok is not None else status_code < 400
    response.json.return_value = json_data or {}
    return response


class ClassifyFailureTests(unittest.TestCase):
    def test_not_found(self):
        self.assertEqual(browserbase.classify_failure(404, None), "not_found")

    def test_blocked_403(self):
        self.assertEqual(browserbase.classify_failure(403, None), "blocked")

    def test_blocked_401(self):
        self.assertEqual(browserbase.classify_failure(401, None), "blocked")

    def test_too_large_502(self):
        self.assertEqual(browserbase.classify_failure(502, None), "too_large")

    def test_timeout_504(self):
        self.assertEqual(browserbase.classify_failure(504, None), "timeout")

    def test_timeout_on_missing_status(self):
        # A client-side timeout exception has no HTTP status at all.
        self.assertEqual(browserbase.classify_failure(None, None), "timeout")

    def test_empty_on_none_content(self):
        self.assertEqual(browserbase.classify_failure(200, None), "empty")

    def test_empty_on_short_content(self):
        self.assertEqual(browserbase.classify_failure(200, "too short"), "empty")

    def test_paywall_phrase(self):
        content = "Please subscribe to continue reading this article about penguins."
        self.assertEqual(browserbase.classify_failure(200, content), "paywall")

    def test_blocked_phrase(self):
        content = "Please enable javascript and verify you are human to view this page."
        self.assertEqual(browserbase.classify_failure(200, content), "blocked")

    def test_ok_content_passes(self):
        content = "A" * (browserbase.MIN_CONTENT_CHARS + 50)
        self.assertIsNone(browserbase.classify_failure(200, content))

    def test_missing_inner_status_with_good_content_is_not_a_timeout(self):
        # Regression: a 200 /v1/fetch response whose inner JSON simply omits
        # `statusCode` (so the caller passes status_code=None) must not be
        # discarded as a timeout when it carries perfectly good content. Only
        # a *real* timeout -- no status AND no content -- should classify as
        # "timeout" (see test_timeout_on_missing_status below).
        content = "A" * (browserbase.MIN_CONTENT_CHARS + 50)
        self.assertIsNone(browserbase.classify_failure(None, content))

    def test_missing_inner_status_with_short_content_is_empty_not_timeout(self):
        self.assertEqual(browserbase.classify_failure(None, "too short"), "empty")


class RetryTests(unittest.TestCase):
    def setUp(self):
        browserbase._disabled = False

    def tearDown(self):
        browserbase._disabled = False

    @patch("backend.browserbase._api_key", return_value="test-key")
    @patch("backend.browserbase._session")
    @patch("backend.browserbase.time.sleep", return_value=None)
    def test_search_retries_on_429_then_succeeds(self, mock_sleep, mock_session_factory, _mock_key):
        session = MagicMock()
        result_item = {"id": "1", "url": "https://x.com", "title": "t"}
        session.post.side_effect = [
            _response(429, ok=False),
            _response(200, json_data={"results": [result_item]}),
        ]
        mock_session_factory.return_value = session

        results = browserbase.search("query")

        self.assertEqual(len(results), 1)
        self.assertEqual(session.post.call_count, 2)
        mock_sleep.assert_called_once()


class DisabledTests(unittest.TestCase):
    def setUp(self):
        browserbase._disabled = False

    def tearDown(self):
        browserbase._disabled = False

    @patch("backend.browserbase._api_key", return_value="")
    def test_search_returns_empty_when_key_missing(self, _mock_key):
        self.assertEqual(browserbase.search("query"), [])
        self.assertTrue(browserbase._disabled)

    @patch("backend.browserbase._api_key", return_value="")
    def test_fetch_markdown_returns_unset_result_when_key_missing(self, _mock_key):
        result = browserbase.fetch_markdown("https://example.com")
        self.assertFalse(result.ok)
        self.assertIsNone(result.content)
        self.assertIsNone(result.failure)


class FetchMarkdownTests(unittest.TestCase):
    def setUp(self):
        browserbase._disabled = False

    def tearDown(self):
        browserbase._disabled = False

    @patch("backend.browserbase._api_key", return_value="test-key")
    @patch("backend.browserbase._session")
    def test_maps_404_to_not_found(self, mock_session_factory, _mock_key):
        session = MagicMock()
        session.post.return_value = _response(200, json_data={"statusCode": 404, "content": None})
        mock_session_factory.return_value = session

        result = browserbase.fetch_markdown("https://example.com/missing")

        self.assertFalse(result.ok)
        self.assertEqual(result.failure, "not_found")
        self.assertEqual(result.status_code, 404)

    @patch("backend.browserbase._api_key", return_value="test-key")
    @patch("backend.browserbase._session")
    def test_short_body_becomes_empty(self, mock_session_factory, _mock_key):
        session = MagicMock()
        session.post.return_value = _response(200, json_data={"statusCode": 200, "content": "hi"})
        mock_session_factory.return_value = session

        result = browserbase.fetch_markdown("https://example.com/short")

        self.assertFalse(result.ok)
        self.assertEqual(result.failure, "empty")

    @patch("backend.browserbase._api_key", return_value="test-key")
    @patch("backend.browserbase._session")
    def test_missing_statuscode_key_with_good_content_is_ok(self, mock_session_factory, _mock_key):
        # Regression for the classify_failure ordering bug: the inner JSON
        # payload omits "statusCode" entirely (payload.get returns None), but
        # the page content is perfectly good and must not be discarded.
        content = "A" * (browserbase.MIN_CONTENT_CHARS + 50)
        session = MagicMock()
        session.post.return_value = _response(200, json_data={"content": content})
        mock_session_factory.return_value = session

        result = browserbase.fetch_markdown("https://example.com/ok")

        self.assertTrue(result.ok)
        self.assertEqual(result.content, content)
        self.assertIsNone(result.failure)

    @patch("backend.browserbase._api_key", return_value="test-key")
    @patch("backend.browserbase._session")
    def test_ok_content_is_returned(self, mock_session_factory, _mock_key):
        content = "A" * (browserbase.MIN_CONTENT_CHARS + 50)
        session = MagicMock()
        session.post.return_value = _response(
            200, json_data={"statusCode": 200, "content": content}
        )
        mock_session_factory.return_value = session

        result = browserbase.fetch_markdown("https://example.com/ok")

        self.assertTrue(result.ok)
        self.assertEqual(result.content, content)
        self.assertIsNone(result.failure)


class ErrorShellTests(unittest.TestCase):
    """A 200 response carrying an interstitial instead of an article.

    Observed live, not invented: nature.com returned exactly this at HTTP 200
    in 209 characters. It cleared the old 200-char floor, was classified as a
    usable source, and its text was then quoted back as a "verified" citation -
    verification passed honestly, because the error message really was in the
    fetched markdown. The guard has to reject the source, since nothing
    downstream can tell a real quote from a quoted error page.
    """

    NATURE_SHELL = (
        "A required part of this site couldn't load. This may be due to a "
        "browser extension, network issues, or browser settings. Please check "
        "your connection, disable any ad blockers, or try using a different "
        "browser."
    )

    def test_the_real_nature_shell_is_blocked(self):
        self.assertEqual(browserbase.classify_failure(200, self.NATURE_SHELL), "blocked")

    def test_the_shell_is_long_enough_to_beat_a_length_check_alone(self):
        # Pins WHY the phrase match is needed: this payload is not short enough
        # for the size floor to have caught it under the old threshold.
        self.assertGreater(len(self.NATURE_SHELL), 200)

    def test_an_interstitial_under_the_floor_is_empty(self):
        self.assertEqual(browserbase.classify_failure(200, "x" * 500), "empty")

    def test_a_real_article_still_passes(self):
        self.assertIsNone(browserbase.classify_failure(200, "word " * 5000))


if __name__ == "__main__":
    unittest.main()
