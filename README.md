# Alive Internet Theory

Chrome extension that overlays on YouTube videos and Shorts and rates them **Likely human / Possibly AI / AI Slop**, backed by a Flask API that scores transcripts and channel metadata. See [CLAUDE.md](CLAUDE.md) for the full design reference.

## Layout

```
frontend/            Chrome extension (Manifest V3, esbuild)
backend/api/         Flask API: GET /video/evaluation, POST /video/evaluation, POST /video/community-vote
backend/scoring/     Scoring engine (starts at 100, deducts per AI evidence)
backend/database/    MongoDB Atlas repositories (evaluations, channel cache, community votes)
```

## Backend setup

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in real keys
cd .. && python -m backend.api.app
```

Requires a MongoDB Atlas cluster (`MONGODB_URI`), a GPTZero API key, and a YouTube Data API v3 key — see `backend/.env.example`.

Lint/format with [ruff](https://docs.astral.sh/ruff/): `ruff check backend && ruff format backend`.

## Frontend setup

```bash
cd frontend
npm install
npm run build          # or: npm run watch
```

Then load `frontend/` as an unpacked extension at `chrome://extensions` (enable Developer mode → "Load unpacked"). Open any YouTube watch or Shorts page; the overlay appears top-right.

Lint/format: `npm run lint` and `npm run format`.
