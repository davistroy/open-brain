# Open Brain — Python batch-ingest sidecar
# Runs the financial-pipeline.py and (optionally) utility-pipeline.py scripts
# against CSVs dropped into /inbox. Posts captures to the core-api.
#
# Designed to be exec'd into by host cron:
#   docker exec open-brain-financial-ingest python /app/financial-pipeline.py --process-inbox
#
# Container sleeps forever by default. A long-lived container keeps image
# pull + startup cost out of the cron path.

FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates tzdata unzip \
    && rm -rf /var/lib/apt/lists/*

# Bitwarden Secrets Manager CLI (pinned).
# Scripts use `bws secret list` to retrieve API keys + merchant rules.
ARG BWS_VERSION=1.0.0
RUN ARCH="$(uname -m)" && case "$ARCH" in \
      x86_64)  BWS_ARCH="x86_64-unknown-linux-gnu" ;; \
      aarch64) BWS_ARCH="aarch64-unknown-linux-gnu" ;; \
      *) echo "unsupported arch: $ARCH"; exit 1 ;; \
    esac && \
    curl -sL "https://github.com/bitwarden/sdk-sm/releases/download/bws-v${BWS_VERSION}/bws-${BWS_ARCH}-${BWS_VERSION}.zip" -o /tmp/bws.zip && \
    unzip -o /tmp/bws.zip -d /tmp/ && \
    mv /tmp/bws /usr/local/bin/bws && \
    chmod +x /usr/local/bin/bws && \
    rm -rf /tmp/bws.zip

# Pipeline dependencies. Kept minimal — pdfplumber etc. deliberately excluded
# until a script actually needs them. Adding a package here is cheap.
RUN pip install --no-cache-dir \
      requests==2.32.3 \
      PyYAML==6.0.2

# Defaults for in-container paths. Overrideable via compose environment.
ENV PYTHONUNBUFFERED=1 \
    FINANCIAL_INBOX_DIR=/inbox \
    FINANCIAL_PIPE_DIR=/data \
    FINANCIAL_CONFIG_DIR=/app/config/financial \
    TZ=America/New_York

WORKDIR /app
COPY scripts/financial-pipeline.py /app/financial-pipeline.py
COPY scripts/utility-pipeline.py  /app/utility-pipeline.py
COPY config /app/config

# Directories the script writes to at runtime. Named volumes mount over these.
RUN mkdir -p /inbox /inbox/processed /data

# Long-lived container; host cron exec's into this to run the pipelines.
CMD ["sleep", "infinity"]
