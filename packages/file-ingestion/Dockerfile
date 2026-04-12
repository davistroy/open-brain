# Open Brain File Ingestion Service
# Python 3.11 slim — FastAPI content extraction for Office/document formats
#
# Memory limit guidance: 1.5GB (set via mem_limit in docker-compose.yml)
# Single uvicorn worker, streaming extraction to stay within budget.

FROM python:3.11-slim AS base

# Minimal system deps (pdfplumber needs no native libs beyond what slim provides)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies (layer cached separately from source)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY src/ src/

# Non-root user for security
RUN groupadd -r extractor && useradd -r -g extractor -s /sbin/nologin extractor
USER extractor

# Extraction API port
EXPOSE 8080

# Health check against the FastAPI health endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=10s \
    CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["python", "-m", "src.extract"]
