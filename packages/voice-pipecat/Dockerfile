# Open Brain Voice Pipecat Service
# Python 3.11 slim — Pipecat + Deepgram + Claude + TTS
#
# Memory limit guidance: 4GB (set via mem_limit in docker-compose.yml)
# Audio processing + LLM streaming + TTS can be memory-intensive during
# concurrent sessions.

FROM python:3.11-slim AS base

# System deps for audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    libsndfile1-dev \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY src/ src/

# Non-root user for security
RUN groupadd -r pipecat && useradd -r -g pipecat -s /sbin/nologin pipecat
USER pipecat

# WebSocket port for audio streaming
EXPOSE 8765

# Health endpoint port
EXPOSE 8766

# Health check against the FastAPI health endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
    CMD wget -qO- http://127.0.0.1:8766/health || exit 1

CMD ["python", "-m", "src.main"]
