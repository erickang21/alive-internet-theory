# Alive Internet Theory

Chrome extension that embeds a verdict card in YouTube watch pages and Shorts and rates videos **Likely human / Likely AI / Heavy AI Use**. The backend pulls everything from YouTube with yt-dlp, scores it, and stores the result in SQLite. Videos get analyzed when devs run the analyze script on them, or quietly in the background the first time someone opens them with the extension. A Flask API serves the results to the extension. **New here? Start with [GUIDE.md](GUIDE.md)** (quick start and usage). See [CLAUDE.md](CLAUDE.md) for the full design reference.

## Layout

```
frontend/                  Chrome extension (Manifest V3, esbuild): verdict card, breakdown/settings popover, feed filter; queues unanalyzed videos silently
backend/analyze.py         CLI that analyzes videos and writes evaluations
backend/ytdlp.py           yt-dlp: metadata, thumbnail, captions, audio, channel uploads
backend/transcripts.py     Caption parsing, local Whisper speech-to-text fallback
backend/scoring/           Scoring engine (starts at 100, deducts per AI evidence)
backend/api/               Flask API: GET /video/evaluation, POST /video/community-vote
backend/database/          SQLAlchemy models + repositories on SQLite, Alembic migrations
```

## Runbook

### 1. Install (first time)

Prerequisites: Node.js 20+, Chrome, and **either** Docker **or** Python 3.11+ with [ffmpeg](https://ffmpeg.org) and [Deno](https://deno.com) on your PATH (yt-dlp needs both to download from YouTube).

**Gather credentials:**

1. **GPTZero**: get an API key (hackathon form) for `api.gptzero.me`.
2. **Anthropic** (optional): create an API key at [console.anthropic.com](https://console.anthropic.com). It's used to fact-check educational videos. Without it, the analyze script logs one warning and skips the fact check; everything else still runs.

**Backend:**

```bash
cd backend
cp .env.example .env
# venv only (skip if you use Docker):
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Edit `backend/.env` and fill in `GPTZERO_API_KEY` and `ANTHROPIC_API_KEY`. For venv runs you can delete the `ANTHROPIC_API_KEY` line and use `ant auth login` instead. Never commit `.env`; it's gitignored. No database setup is needed: the SQLite file and pending migrations are applied automatically on every start.

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

### 2. Analyze videos

Opening a video in the extension queues it for analysis in the background; the script is for batches, channels, playlists, and `--force` re-analysis. A video shows "Not analyzed" until one of them has finished. Run it from your own machine, because YouTube bot-checks cloud IPs.

```bash
# Docker (from the repo root)
docker compose run --rm backend python -m backend.analyze <targets…>

# venv (from the repo root)
source backend/.venv/bin/activate
python -m backend.analyze <targets…>
```

Targets can be mixed freely:

| Target | Example | Analyzes |
|---|---|---|
| Video, Short, or bare ID | `https://www.youtube.com/watch?v=jNQXAC9IVRw`, `https://www.youtube.com/shorts/R6yNUnRXZ64`, `jNQXAC9IVRw` | that video |
| Channel | `https://www.youtube.com/@mkbhd` (or its `/videos` or `/shorts` tab) | its newest `--limit` videos (default 10) |
| Playlist | `https://www.youtube.com/playlist?list=…` | its first `--limit` videos |

Videos that already have an evaluation are skipped unless you pass `--force`. The script exits non-zero if any video failed, and logs why.

For each video it:
1. Downloads the captions, thumbnail, and yt-dlp's full metadata (`video.info.json`) to `MEDIA_DIR/<video_id>/`. The video itself isn't downloaded.
2. Uses the first 5 minutes of the captions as the transcript. If there are none, it downloads the audio, cuts it to the first 5 minutes, and transcribes it locally with Whisper. The first Whisper run downloads about 460 MB of model weights.
3. Scores the video: GPTZero, the ElevenLabs voice check, filler words, upload cadence, and channel age. The voice check needs audio, so a captioned video downloads a 60-second excerpt for it and deletes it again once scored. Claude also decides whether the video is educational and, if so, fact-checks its main thesis with web search. The first video from a channel also pulls exact dates for the channel's latest 20 uploads and its oldest one. That takes up to about a minute and is cached for 24 hours.

### 3. Run the API

```bash
# Docker (from the repo root)
docker compose up --build      # add -d to run in the background
docker compose down            # stop

# venv (from the repo root)
source backend/.venv/bin/activate
python -m backend.api.app
```

Both serve `http://127.0.0.1:5000`; check with `curl http://127.0.0.1:5000/health`. Docker keeps the database, downloaded media, and Whisper weights in the `backend-data` volume, which is separate from a venv run's `backend/data/`. `docker compose run` uses the same volume, so videos you analyze in Docker show up in the Docker API.

**Use the extension:** open any YouTube watch or Shorts page. The card above the related videos (top right on Shorts) shows the verdict and score; **View breakdown** opens the per-criterion breakdown and the feed-filter settings, and the thumbs record whether you agree with the verdict. Unanalyzed videos show nothing and are queued in the background; the card appears once the verdict lands.

**After changing frontend code:** rebuild with `npm run build` (or leave `npm run watch` running), then click the reload icon on the extension card in `chrome://extensions` and refresh the YouTube tab. Backend code changes only need the Flask process restarted (or set `FLASK_DEBUG=1` in `backend/.env` for auto-reload); under Docker, rerun `docker compose up --build`.

**When YouTube downloads start failing:** YouTube regularly breaks yt-dlp, and the fix is usually a newer release. Run `pip install -U "yt-dlp[default]"` in the venv, or `docker compose build --no-cache` for Docker.

## Development

- Backend lint/format: `ruff check backend && ruff format backend` ([ruff](https://docs.astral.sh/ruff/))
- Backend type check: `pip install basedpyright` in the backend venv, then `basedpyright -p backend` ([basedpyright](https://docs.basedpyright.com), strict mode, configured in `backend/pyproject.toml`; it resolves imports from `backend/.venv`)
- Frontend lint/format: `npm run lint` and `npm run format` in `frontend/`

### Changing the database schema

Tables are defined as SQLAlchemy models in `backend/database/models.py`. [Alembic](https://alembic.sqlalchemy.org) migrations in `backend/database/migrations/versions/` update existing databases to match. After editing a model:

```bash
alembic -c backend/alembic.ini revision --autogenerate -m "add foo column to videos"
ruff check --fix backend && ruff format backend
```

Review the generated file, because autogenerate misses some changes (e.g. a column rename shows up as a drop plus an add). Then commit it with the model change. The API and the analyze script both run `alembic upgrade head` on startup, so teammates and the container pick it up automatically. `alembic -c backend/alembic.ini check` reports whether models and migrations are out of sync.
