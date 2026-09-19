FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=5000 \
    SQLITE_PATH=/data/alive_internet_theory.db

# The code imports itself as the `backend` package, so it lives at /app/backend
# and runs from /app.
WORKDIR /app
COPY requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY . backend/

VOLUME /data
EXPOSE 5000
CMD ["python", "-m", "backend.api.app"]
