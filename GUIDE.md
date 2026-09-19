# Quick Start & Usage Guide

Opening a video with the extension loaded queues it for analysis in the background. The overlay just says "Not analyzed" on that first visit, and the verdict appears the next time you open the video after the backend finishes. The analyze script is for batch runs and re-analysis. All commands run from the repo root.

## Quick start (Docker)

You need Docker, Node.js 20+, and Chrome.

1. **Add your keys.**
   ```bash
   cp backend/.env.example backend/.env
   ```
   In `backend/.env`, set `GPTZERO_API_KEY`. `ANTHROPIC_API_KEY` is optional (it powers the fact check). If you don't have one, delete that line rather than leaving the placeholder.

2. **Start the backend.**
   ```bash
   docker compose up -d --build
   curl http://127.0.0.1:5000/health        # {"status":"ok"}
   ```

3. **Build and load the extension.**
   ```bash
   cd frontend && npm install && npm run build && cd ..
   ```
   In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `frontend/` folder.

4. **Open a video in Chrome.** The overlay in the top right says "Not analyzed" while the backend analyzes it in the background. Reopen the video once it's done (usually under a minute, longer for a new channel or when Whisper is needed) to see the verdict. You can follow progress with `docker compose logs -f backend`.

## Analyzing videos in batches

Opening a video queues it by itself, so the script is for the rest: channels, playlists, files of targets, and `--force` re-analysis. With the stack running, submit videos to the running container:

```bash
docker compose exec backend python -m backend.analyze <target> [<target> …] [--limit N] [--force]
```

Results go into the same database the API serves, so the extension shows them as soon as the command finishes. The command prints its progress in your terminal; `docker compose logs` only shows the API server.

If the stack isn't running, `docker compose run --rm backend python -m backend.analyze …` does the same thing in a one-off container.

### What you can pass

| Target | Example | Analyzes |
|---|---|---|
| Video URL | `"https://www.youtube.com/watch?v=jNQXAC9IVRw"` | that video |
| Short or youtu.be link | `"https://www.youtube.com/shorts/R6yNUnRXZ64"` | that video |
| Bare video ID | `jNQXAC9IVRw` | that video |
| Channel | `"https://www.youtube.com/@mkbhd"`, or its `/videos` or `/shorts` tab | its newest `--limit` videos |
| Playlist | `"https://www.youtube.com/playlist?list=…"` | its first `--limit` videos |

Mix them freely in one command.

- **Quote URLs.** zsh treats the `?` in YouTube URLs as a wildcard and fails with `no matches found`. Bare IDs don't need quotes.
- **`--limit N`:** how many videos to take from each channel or playlist (default 10).
- **`--force`:** re-analyze videos that already have a result. Without it they're skipped (`already analyzed, skipping`). Use `--force` to backfill fact checks after adding an Anthropic key.

### Many videos from a file

Put one target per line in a file (no blank or comment lines), then:

```bash
xargs docker compose exec -T backend python -m backend.analyze < videos.txt
```

`-T` keeps `docker compose exec` from asking for a terminal when fed by `xargs`.

### What happens per video

1. Downloads the captions, thumbnail, and yt-dlp's full metadata (`video.info.json`), but not the video itself. That takes a few seconds.
2. Uses **the first 5 minutes** of the captions as the transcript. If there are no captions, or they're blank, it downloads the audio track, cuts it to the first 5 minutes, and transcribes it locally with Whisper (about 80s on a CPU). A video with no captions and no detectable speech is skipped and not stored.
3. Scores it: GPTZero, filler words, upload cadence, channel age, plus Claude's fact check (educational videos only; recorded, not scored yet).
4. Saves the result and prints e.g. `jNQXAC9IVRw: likely_human (score 100.0)`.

The script exits non-zero if any video failed, and logs why.

**Expect these one-time delays:**
- **First video from a new channel:** up to about a minute, while it pulls exact dates for the channel's latest 20 uploads and its oldest one. This is cached for 24 hours.
- **First video without captions:** downloads about 460 MB of Whisper model weights.

Each stage prints a timestamped line: the queue size, `[2/7] <id>: starting`, metadata, download progress, which transcript source was used, each criterion as it runs and its result, the channel-date fetch (`channel: 10/21 upload dates fetched`), and `[2/7] <id>: done in 45s, likely_human (score 88.2)`. The run ends with `finished: N analyzed, N skipped, N failed`.

**Run it from your own machine.** YouTube blocks downloads from cloud servers.

## Reading results

### In the extension

On any watch or Shorts page, the overlay shows one of:

- **Likely human / Likely AI / AI Slop** with `Score: N / 100`. Scores start at 100: 75 and up is Likely human, 45 to under 75 is Likely AI, and below 45 is AI Slop. **Show breakdown** lists each criterion's deduction, or `n/a` with the reason when a criterion didn't apply.
- **Not analyzed:** there's no verdict yet. Opening the video queued it in the background (if it wasn't already), so reopen it later. If it never gets a verdict, the analysis failed: check `docker compose logs -f backend`. Failures are remembered until the backend restarts.
- **Unavailable: "Couldn't reach the backend. Is it running?"** The API isn't answering on `127.0.0.1:5000` (see Troubleshooting).

### From the API

```bash
curl "http://127.0.0.1:5000/video/evaluation?video_id=jNQXAC9IVRw"
```

Returns `score`, `verdict`, `breakdown`, the fact check fields (`is_educational`, `thesis`, `hallucinated`; null when not run), `metadata` (title, channel, length, publish date, transcript kind and language, media paths), and `community_votes`. Unanalyzed videos return 404. A community vote says whether the evaluation was right: record one with `POST /video/community-vote` and a JSON body `{"video_id", "voter_id", "vote": "agree"|"disagree"}` (one vote per voter per video; re-voting overwrites), and read the standalone overview with `GET /video/community-votes?video_id=…` — `{"votes": {"agree", "disagree"}, "total", "consensus"}`, where `consensus` is the majority side or null on a tie. Votes never affect scoring.

### Downloaded files

Docker keeps everything in the `backend-data` volume at `/data`: the database, `media/<video_id>/` (captions, thumbnail, `video.info.json`, and `audio.<ext>` for videos that needed Whisper), and the Whisper model. To copy a video's files out:

```bash
docker compose cp backend:/data/media/jNQXAC9IVRw ./jNQXAC9IVRw
```

## Running without Docker

You need Python 3.11+ (3.14 works), plus [ffmpeg](https://ffmpeg.org) and [Deno](https://deno.com) on your PATH. yt-dlp needs both.

```bash
python -m venv backend/.venv && source backend/.venv/bin/activate
pip install -r backend/requirements.txt
python -m backend.analyze "https://www.youtube.com/shorts/R6yNUnRXZ64"
python -m backend.api.app                  # API on http://127.0.0.1:5000
```

You can run `ant auth login` instead of putting an Anthropic key in `.env`. A venv run stores data in `backend/data/`, separate from Docker's volume: videos analyzed in one don't show up in the other.

## Managing the stack

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| API logs | `docker compose logs -f backend` |
| Stop (keeps your data) | `docker compose down` |
| Start again | `docker compose up -d` |
| After `git pull` | `docker compose up -d --build` |
| YouTube downloads broke | `docker compose build --no-cache && docker compose up -d` (picks up the latest yt-dlp) |

> **`docker compose down -v` deletes the `backend-data` volume: every analyzed video, all downloaded media, and the Whisper model.** Only use it when you mean to start over.

## Troubleshooting

| You see | Cause and fix |
|---|---|
| Overlay: "Couldn't reach the backend. Is it running?" | The stack is down. Run `docker compose ps`; if nothing is up, run `docker compose up -d`, then `curl http://127.0.0.1:5000/health`. |
| Overlay still says "Not analyzed" after a while | Either it's still running (a new channel's upload dates, Whisper) or it failed. `docker compose logs -f backend` shows which, and why (yt-dlp break, age-restricted video). A failed video isn't retried until the backend restarts: fix the cause, run `docker compose restart backend`, and reopen the video. |
| `zsh: no matches found: https://…` | Put the URL in quotes. |
| `env file …/backend/.env not found` | Create it: `cp backend/.env.example backend/.env` and add your keys. |
| `service "backend" is not running` | `exec` needs the stack up. Run `docker compose up -d`, or use `docker compose run --rm backend …` instead. |
| `WARNING … Skipping the fact check for this run: …` | No usable Anthropic key. Everything else still runs. Add a key to use the fact check. |
| `ERROR … criterion gptzero_transcript failed` | `GPTZERO_API_KEY` is missing or invalid. That criterion is skipped; the rest still runs. |
| `… analysis failed` with a yt-dlp download error | Usually YouTube changed something. Rebuild with `--no-cache` to update yt-dlp. If YouTube asks you to confirm you're not a bot, make sure you're running from your own machine, not a server. Age-restricted and members-only videos can't be analyzed (they need a logged-in YouTube session). |
| Extension changes don't show up | Run `npm run build` in `frontend/`, click reload on the extension card in `chrome://extensions`, then refresh the YouTube tab. |
