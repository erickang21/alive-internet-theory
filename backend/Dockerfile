FROM python:3.12-slim

# yt-dlp needs ffmpeg to merge YouTube's separate video/audio streams and
# convert thumbnails, and a JavaScript runtime (Deno) to solve YouTube's
# player challenges.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
COPY --from=denoland/deno:bin /deno /usr/local/bin/deno

# Everything stateful lives on the /data volume: the database, downloaded
# media, and the Whisper model weights (fetched on first use).
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=5000 \
    SQLITE_PATH=/data/alive_internet_theory.db \
    MEDIA_DIR=/data/media \
    HF_HOME=/data/huggingface

# The code imports itself as the `backend` package, so it lives at /app/backend
# and runs from /app.
WORKDIR /app
COPY requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY . backend/

VOLUME /data
EXPOSE 5000
CMD ["python", "-m", "backend.api.app"]
