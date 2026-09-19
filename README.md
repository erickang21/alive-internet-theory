# Alive Internet Theory

Chrome extension that overlays on YouTube videos and Shorts and rates them **Likely human / Possibly AI / AI Slop**, backed by a Flask API that scores transcripts and channel metadata. See [CLAUDE.md](CLAUDE.md) for the full design reference.

## Layout

```
frontend/            Chrome extension (Manifest V3, esbuild)
backend/api/         Flask API: GET /video/evaluation, POST /video/evaluation, POST /video/community-vote
backend/scoring/     Scoring engine (starts at 100, deducts per AI evidence)
backend/database/    MongoDB Atlas repositories (videos, channel cache, community votes)
```

## Runbook

### 1. Install (first time)

Prerequisites: Python 3.11+, Node.js 20+, Chrome, and accounts for the three external services below.

**Gather credentials:**

1. **MongoDB Atlas** — create a free cluster at [cloud.mongodb.com](https://cloud.mongodb.com), add a database user, allow your IP under Network Access, then copy the connection string from Database → Connect → Drivers. Collections and indexes are created automatically on first use.
2. **GPTZero** — get an API key (hackathon form) for `api.gptzero.me`.
3. **YouTube Data API v3** — in [console.cloud.google.com](https://console.cloud.google.com), create a project, enable "YouTube Data API v3", and create an API key (no OAuth needed for public reads).

**Backend:**

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Edit `backend/.env` and fill in `GPTZERO_API_KEY`, `YOUTUBE_API_KEY`, `MONGODB_URI`, `MONGODB_USERNAME`, and `MONGODB_PASSWORD` with the values gathered above. Never commit `.env` — it is gitignored.

**Frontend:**

```bash
cd frontend
npm install
npm run build
```

**Load the extension into Chrome:**

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `frontend/` directory

### 2. Run the app

**Start the backend** (from the repo root, with the venv active):

```bash
source backend/.venv/bin/activate
python -m backend.api.app
```

The API listens on `http://127.0.0.1:5000`; check it with `curl http://127.0.0.1:5000/health`.

**Use the extension:** open any YouTube watch or Shorts page. The overlay appears in the top right, shows "Analyzing…" while the transcript is fetched and scored, then displays the verdict with an expandable per-criterion breakdown. The first visit to a video runs the full evaluation and saves it to Atlas; every later visit (by anyone) serves the stored result instantly.

**Degraded mode:** the app still runs with missing or wrong credentials. Without Atlas, evaluations are computed fresh on every visit instead of cached; without the GPTZero or YouTube keys, those criteria show as "unavailable" in the breakdown and deduct nothing. Each criterion degrades independently, so a partial `.env` still produces a verdict from whatever data is reachable.

**After changing frontend code:** rebuild with `npm run build` (or leave `npm run watch` running), then click the reload icon on the extension card in `chrome://extensions` and refresh the YouTube tab. Backend code changes only need the Flask process restarted (or set `FLASK_DEBUG=1` in `backend/.env` for auto-reload).

## Scoring

Every video starts at 100 and loses points per AI signal; the verdict bands are **Likely human** (≥75), **Possibly AI** (45–74), and **AI Slop** (<45).

| Criterion | Max deduction | Signal |
|---|---|---|
| GPTZero transcript scan | 45 | Document-level AI probability weighted by confidence, backstopped by the ratio of AI-flagged sentences (catches humanized scripts the document model misses) |
| Filler words / stutters | 20 | Near-zero fillers on a long auto-generated (ASR) transcript reads as scripted; skipped for manual/translated tracks |
| Upload cadence | 10 | Sustained faster-than-daily long-form uploads exceed human production capacity |
| Channel history | 10 | Fraction of the channel's previously evaluated videos that scored as AI |
| Account age | 5 | Channels younger than ~6 months |

## Development

- Backend tests: `pip install -r backend/requirements-dev.txt`, then `python -m pytest backend/tests` from the repo root (no credentials or network needed — external services are faked)
- Backend lint/format: `ruff check backend && ruff format backend` ([ruff](https://docs.astral.sh/ruff/))
- Frontend lint/format: `npm run lint` and `npm run format` in `frontend/`
