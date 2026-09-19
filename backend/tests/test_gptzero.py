import pytest

from backend.scoring import gptzero

LONG_TEXT = "word " * 300


def _prediction(class_probabilities, confidence, sentences=(), predicted_class="human"):
    return {
        "predicted_class": predicted_class,
        "confidence_score": confidence,
        "class_probabilities": class_probabilities,
        "sentences": list(sentences),
    }


def _sentences(total, flagged):
    return [{"highlight_sentence_for_ai": i < flagged} for i in range(total)]


@pytest.fixture
def predict(monkeypatch):
    def install(prediction):
        monkeypatch.setattr(gptzero, "predict_text", lambda document: prediction)

    return install


def test_short_transcript_reports_no_signal(predict):
    result = gptzero.score_transcript("too short")
    assert result["applied"] is False
    assert result["deduction"] == 0


def test_confident_ai_verdict_deducts_heavily(predict):
    predict(
        _prediction(
            {"human": 0.0, "ai": 0.853, "mixed": 0.147},
            confidence=0.853,
            sentences=_sentences(62, 62),
            predicted_class="ai",
        )
    )
    result = gptzero.score_transcript(LONG_TEXT)
    assert result["applied"] is True
    assert result["deduction"] == gptzero.MAX_DEDUCTION


def test_clean_human_verdict_deducts_nothing(predict):
    predict(
        _prediction(
            {"human": 0.999999, "ai": 0.0, "mixed": 0.0},
            confidence=0.99,
            sentences=_sentences(280, 0),
        )
    )
    result = gptzero.score_transcript(LONG_TEXT)
    assert result["deduction"] == 0


def test_sentence_ratio_backstops_document_miss(predict):
    # Real case from live testing: known-AI video, document verdict "human",
    # but 25 of 300 sentences flagged.
    predict(
        _prediction(
            {"human": 0.980, "ai": 0.0004, "mixed": 0.0197},
            confidence=0.98,
            sentences=_sentences(300, 25),
        )
    )
    result = gptzero.score_transcript(LONG_TEXT)
    assert result["deduction"] > 5
    assert "sentences" in result["detail"]


def test_deduction_never_exceeds_max(predict):
    predict(
        _prediction(
            {"human": 0.0, "ai": 1.0, "mixed": 0.0},
            confidence=1.0,
            sentences=_sentences(10, 10),
            predicted_class="ai",
        )
    )
    result = gptzero.score_transcript(LONG_TEXT)
    assert result["deduction"] <= gptzero.MAX_DEDUCTION
