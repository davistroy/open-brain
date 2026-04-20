#!/usr/bin/env python3
"""
Open Brain Batch LLM Categorization â€” Classify files using LLM.

Reads from the inventory SQLite database (created by file-inventory.py).
Each file is classified with: category, subcategory, description, tags.
Supports two backends: DGX Spark (SSH tunnel to vLLM) or local Ollama.
Checkpoints every 100 files for resume capability.

Usage:
    python scripts/file-categorize.py --db /mnt/user/openbrain/inventory.db --backend spark
    python scripts/file-categorize.py --db ./inventory.db --backend ollama
    python scripts/file-categorize.py --db ./inventory.db --backend ollama --model llama3.1:8b
    python scripts/file-categorize.py --db ./inventory.db --backend spark --batch-size 50

Requires: requests (pip install requests)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sqlite3
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError:
    print("ERROR: requests not installed. Run: pip install requests", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("file-categorize")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
CHECKPOINT_INTERVAL = 100
MAX_CONTENT_CHARS = 2000
DEFAULT_SPARK_MODEL = "Qwen/Qwen3-32B"
DEFAULT_OLLAMA_MODEL = "qwen3:32b"

# Spark access via SSH tunnel
SPARK_HOST = "spark.k4jda.net"
SPARK_SSH_KEY = os.path.expanduser("~/.ssh/id_claude_code")
SPARK_VLLM_PORT = 8000  # vLLM default on Spark

# Ollama default
OLLAMA_URL = "http://localhost:11434"

# ---------------------------------------------------------------------------
# LLM prompt
# ---------------------------------------------------------------------------

CLASSIFICATION_PROMPT = """You are a file categorization system. Given a file's metadata and content preview, classify it into a structured taxonomy.

Return ONLY valid JSON with these exact fields:
{
    "category": "one of: business, technical, personal, reference, creative, financial, legal, education, communication, data",
    "subcategory": "more specific type within the category",
    "description": "one-line description of what this file is about",
    "tags": ["tag1", "tag2", "tag3"]
}

Category definitions:
- business: proposals, presentations, strategies, org charts, process docs, client work
- technical: code, architecture docs, system configs, API specs, technical notes
- personal: journal entries, personal notes, health, family, hobbies
- reference: articles, papers, saved web pages, bookmarks, how-to guides
- creative: writing, design work, media projects, brainstorming
- financial: invoices, budgets, tax docs, expense reports, financial models
- legal: contracts, agreements, NDAs, policies, compliance docs
- education: courses, certifications, study notes, training materials
- communication: emails, letters, meeting notes, chat logs
- data: spreadsheets, datasets, exports, backups, logs

File information:
- Filename: {filename}
- MIME type: {mime_type}
- File size: {size} bytes
- Modified: {modified_date}
- Content preview (first {content_chars} chars):

{content_preview}

Return ONLY the JSON object, no other text."""


# ---------------------------------------------------------------------------
# Backend: DGX Spark (SSH â†’ vLLM)
# ---------------------------------------------------------------------------


class SparkBackend:
    """Access vLLM on DGX Spark via SSH tunnel."""

    def __init__(self, model: str = DEFAULT_SPARK_MODEL):
        self.model = model
        self.tunnel_proc = None
        self.local_port = 18000  # Local port for SSH tunnel
        self.base_url = f"http://localhost:{self.local_port}/v1"

    def start(self) -> bool:
        """Open SSH tunnel to DGX Spark vLLM."""
        logger.info("Opening SSH tunnel to DGX Spark (%s)...", SPARK_HOST)
        try:
            self.tunnel_proc = subprocess.Popen(
                [
                    "ssh",
                    "-i",
                    SPARK_SSH_KEY,
                    "-L",
                    f"{self.local_port}:localhost:{SPARK_VLLM_PORT}",
                    "-N",
                    "-o",
                    "StrictHostKeyChecking=no",
                    f"claude@{SPARK_HOST}",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            # Wait for tunnel to establish
            time.sleep(2)
            if self.tunnel_proc.poll() is not None:
                stderr = self.tunnel_proc.stderr.read().decode() if self.tunnel_proc.stderr else ""
                logger.error("SSH tunnel failed: %s", stderr)
                return False

            # Verify connectivity
            try:
                resp = requests.get(f"{self.base_url}/models", timeout=10)
                if resp.status_code == 200:
                    models = resp.json().get("data", [])
                    model_ids = [m["id"] for m in models]
                    logger.info("Spark connected. Available models: %s", model_ids)
                    return True
                return False
            except requests.exceptions.ConnectionError:
                logger.error("SSH tunnel open but vLLM not responding on Spark")
                return False

        except FileNotFoundError:
            logger.error("SSH not found. Install OpenSSH or use --backend ollama")
            return False
        except Exception as e:
            logger.error("SSH tunnel error: %s", e)
            return False

    def stop(self):
        """Close SSH tunnel."""
        if self.tunnel_proc:
            self.tunnel_proc.terminate()
            self.tunnel_proc.wait(timeout=5)
            logger.info("SSH tunnel closed")

    def classify(self, prompt: str) -> dict[str, Any] | None:
        """Send classification request to vLLM on Spark."""
        try:
            resp = requests.post(
                f"{self.base_url}/chat/completions",
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 300,
                    "temperature": 0.1,
                },
                timeout=60,
            )
            if resp.status_code != 200:
                logger.warning("Spark API error: %d %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            content = data["choices"][0]["message"]["content"]
            return _parse_json_response(content)
        except requests.exceptions.Timeout:
            logger.warning("Spark request timed out")
            return None
        except Exception as e:
            logger.warning("Spark request error: %s", e)
            return None


class OllamaBackend:
    """Access local Ollama instance."""

    def __init__(self, model: str = DEFAULT_OLLAMA_MODEL, url: str = OLLAMA_URL):
        self.model = model
        self.base_url = url

    def start(self) -> bool:
        """Verify Ollama is running and model is available."""
        logger.info("Checking Ollama at %s...", self.base_url)
        try:
            resp = requests.get(f"{self.base_url}/api/tags", timeout=10)
            if resp.status_code == 200:
                models = [m["name"] for m in resp.json().get("models", [])]
                logger.info("Ollama connected. Available models: %s", models)
                if self.model not in models and not any(self.model in m for m in models):
                    logger.warning(
                        "Model '%s' not found. Available: %s. Will attempt to use anyway.",
                        self.model,
                        models,
                    )
                return True
            else:
                logger.error("Ollama returned %d", resp.status_code)
                return False
        except requests.exceptions.ConnectionError:
            logger.error("Cannot connect to Ollama at %s. Is it running?", self.base_url)
            return False

    def stop(self):
        """No cleanup needed for Ollama."""
        pass

    def classify(self, prompt: str) -> dict[str, Any] | None:
        """Send classification request to Ollama."""
        try:
            resp = requests.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "options": {
                        "temperature": 0.1,
                        "num_predict": 300,
                    },
                },
                timeout=120,
            )
            if resp.status_code != 200:
                logger.warning("Ollama API error: %d %s", resp.status_code, resp.text[:200])
                return None
            data = resp.json()
            content = data.get("message", {}).get("content", "")
            return _parse_json_response(content)
        except requests.exceptions.Timeout:
            logger.warning("Ollama request timed out")
            return None
        except Exception as e:
            logger.warning("Ollama request error: %s", e)
            return None


# ---------------------------------------------------------------------------
# JSON response parsing
# ---------------------------------------------------------------------------


def _parse_json_response(text: str) -> dict[str, Any] | None:
    """Extract and parse JSON from LLM response, handling markdown fences and thinking blocks."""
    if not text:
        return None

    # Strip <think>...</think> blocks (Qwen3 reasoning)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    # Try direct JSON parse
    try:
        result = json.loads(text)
        if _validate_classification(result):
            return result
    except json.JSONDecodeError:
        pass

    # Try extracting from markdown code fence
    json_match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.DOTALL)
    if json_match:
        try:
            result = json.loads(json_match.group(1))
            if _validate_classification(result):
                return result
        except json.JSONDecodeError:
            pass

    # Try finding first { ... } block
    brace_match = re.search(r"\{[^{}]*\}", text, re.DOTALL)
    if brace_match:
        try:
            result = json.loads(brace_match.group(0))
            if _validate_classification(result):
                return result
        except json.JSONDecodeError:
            pass

    logger.warning("Could not parse JSON from LLM response: %s", text[:200])
    return None


def _validate_classification(result: dict[str, Any]) -> bool:
    """Check that a classification result has the required fields."""
    required = {"category", "subcategory", "description", "tags"}
    return required.issubset(result.keys())


# ---------------------------------------------------------------------------
# Batch categorization
# ---------------------------------------------------------------------------


def categorize_files(
    conn: sqlite3.Connection,
    backend: SparkBackend | OllamaBackend,
    batch_size: int,
    max_files: int | None,
) -> dict[str, Any]:
    """Run batch LLM categorization on uncategorized files.

    Returns stats dict.
    """
    stats = {
        "total_processed": 0,
        "classified_ok": 0,
        "classification_errors": 0,
        "skipped_no_content": 0,
    }

    # Get uncategorized files
    cursor = conn.execute("""
        SELECT id, path, filename, extension, mime_type, size, modified_date, extracted_text
        FROM files
        WHERE category IS NULL
          AND is_duplicate = 0
        ORDER BY size DESC
    """)
    files = cursor.fetchall()

    if max_files:
        files = files[:max_files]

    total = len(files)
    logger.info("Files to categorize: %d", total)

    if total == 0:
        logger.info("No files to categorize")
        return stats

    start_time = time.monotonic()

    for i, (file_id, _path, filename, _ext, mime_type, size, modified_date, text) in enumerate(
        files
    ):
        # Progress bar
        pct = (i + 1) / total * 100
        elapsed = time.monotonic() - start_time
        rate = (i + 1) / elapsed if elapsed > 0 else 0
        eta = (total - i - 1) / rate if rate > 0 else 0
        sys.stdout.write(
            f"\r  [{i+1}/{total}] {pct:5.1f}% | {rate:.1f} files/min | ETA: {eta/60:.0f}m | {filename[:40]}"
        )
        sys.stdout.flush()

        # Build prompt
        content_preview = ""
        content_chars = 0
        if text:
            content_preview = text[:MAX_CONTENT_CHARS]
            content_chars = len(content_preview)
        else:
            content_preview = "(no extracted text available)"
            content_chars = 0

        prompt = CLASSIFICATION_PROMPT.format(
            filename=filename,
            mime_type=mime_type or "unknown",
            size=size,
            modified_date=modified_date,
            content_chars=content_chars,
            content_preview=content_preview,
        )

        # Call LLM
        result = backend.classify(prompt)
        stats["total_processed"] += 1

        if result:
            # Store results
            tags_json = json.dumps(result.get("tags", []))
            conn.execute(
                """
                UPDATE files
                SET category = ?, subcategory = ?, description = ?, tags = ?
                WHERE id = ?
            """,
                (
                    result["category"],
                    result["subcategory"],
                    result["description"],
                    tags_json,
                    file_id,
                ),
            )
            stats["classified_ok"] += 1
        else:
            stats["classification_errors"] += 1
            logger.debug("Classification failed for %s", filename)

        # Checkpoint
        if (i + 1) % batch_size == 0:
            conn.commit()
            logger.info("\n  Checkpoint at %d/%d (%.0f%% complete)", i + 1, total, pct)

    conn.commit()
    print()  # Newline after progress bar

    elapsed_total = time.monotonic() - start_time
    logger.info(
        "Categorization complete: %d/%d classified in %.0fs (%.1f files/min)",
        stats["classified_ok"],
        total,
        elapsed_total,
        total / elapsed_total * 60 if elapsed_total > 0 else 0,
    )

    return stats


# ---------------------------------------------------------------------------
# Taxonomy analysis
# ---------------------------------------------------------------------------


def analyze_taxonomy(conn: sqlite3.Connection) -> None:
    """Analyze category distribution and propose folder taxonomies."""
    print("\n" + "=" * 70)
    print("CATEGORIZATION ANALYSIS")
    print("=" * 70)

    # Category distribution
    cursor = conn.execute("""
        SELECT category, COUNT(*) as cnt, SUM(size) as total_size
        FROM files
        WHERE category IS NOT NULL AND is_duplicate = 0
        GROUP BY category
        ORDER BY cnt DESC
    """)
    categories = cursor.fetchall()

    print("\n--- Category Distribution ---")
    print(f"{'Category':<20} {'Count':>8} {'Size (MB)':>12} {'%':>8}")
    print("-" * 50)
    total_categorized = sum(c[1] for c in categories)
    for cat, count, size in categories:
        pct = count / total_categorized * 100 if total_categorized > 0 else 0
        print(f"{cat:<20} {count:>8,} {size / (1024*1024):>12.1f} {pct:>7.1f}%")

    # Subcategory distribution
    cursor = conn.execute("""
        SELECT category, subcategory, COUNT(*) as cnt
        FROM files
        WHERE category IS NOT NULL AND is_duplicate = 0
        GROUP BY category, subcategory
        ORDER BY category, cnt DESC
    """)
    subcats = cursor.fetchall()

    print("\n--- Subcategory Breakdown ---")
    current_cat = None
    for cat, subcat, count in subcats:
        if cat != current_cat:
            print(f"\n  {cat}/")
            current_cat = cat
        print(f"    {subcat:<30} {count:>6,}")

    # Top tags
    cursor = conn.execute("SELECT tags FROM files WHERE tags IS NOT NULL AND is_duplicate = 0")
    tag_counter: Counter = Counter()
    for (tags_json,) in cursor:
        try:
            tags = json.loads(tags_json)
            if isinstance(tags, list):
                tag_counter.update(tags)
        except (json.JSONDecodeError, TypeError):
            pass

    print("\n--- Top 30 Tags ---")
    for tag, count in tag_counter.most_common(30):
        print(f"  {tag:<30} {count:>6,}")

    # Propose folder taxonomies
    print("\n" + "=" * 70)
    print("PROPOSED FOLDER TAXONOMIES")
    print("=" * 70)

    # Taxonomy A: Flat by category
    print("\nTaxonomy A â€” Flat by Category:")
    print("  Good for: small collections, simple organization")
    for cat, count, _ in categories:
        print(f"  /{cat}/  ({count:,} files)")

    # Taxonomy B: Two-level category/subcategory
    print("\nTaxonomy B â€” Two-Level (Category/Subcategory):")
    print("  Good for: medium collections, balanced depth")
    current_cat = None
    for cat, subcat, count in subcats:
        if cat != current_cat:
            cat_count = sum(c for ca, _, c in subcats if ca == cat)
            print(f"  /{cat}/  ({cat_count:,} files total)")
            current_cat = cat
        print(f"    /{subcat}/  ({count:,})")

    # Taxonomy C: Three-level with year
    print("\nTaxonomy C â€” Three-Level (Category/Year/Subcategory):")
    print("  Good for: large collections (10K+), temporal organization")
    cursor = conn.execute("""
        SELECT category, SUBSTR(modified_date, 1, 4) as year, COUNT(*) as cnt
        FROM files
        WHERE category IS NOT NULL AND is_duplicate = 0
        GROUP BY category, year
        ORDER BY category, year DESC
    """)
    current_cat = None
    for cat, year, count in cursor:
        if cat != current_cat:
            print(f"  /{cat}/")
            current_cat = cat
        print(f"    /{year}/  ({count:,} files)")
    print("      /<subcategory>/")

    print("\n" + "=" * 70)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Batch LLM categorization of files in inventory database",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Categorize using DGX Spark (free GPU inference)
  python scripts/file-categorize.py --db /mnt/user/openbrain/inventory.db --backend spark

  # Categorize using local Ollama
  python scripts/file-categorize.py --db ./inventory.db --backend ollama

  # Custom Ollama model
  python scripts/file-categorize.py --db ./inventory.db --backend ollama --model llama3.1:8b

  # Limit to first 50 files (for testing)
  python scripts/file-categorize.py --db ./inventory.db --backend ollama --max-files 50

  # Just analyze existing categorization results
  python scripts/file-categorize.py --db ./inventory.db --analyze-only
        """,
    )
    parser.add_argument(
        "--db",
        default="/mnt/user/openbrain/inventory.db",
        help="Path to inventory SQLite database (default: /mnt/user/openbrain/inventory.db)",
    )
    parser.add_argument(
        "--backend",
        choices=["spark", "ollama"],
        default="ollama",
        help="LLM backend: 'spark' (SSH to DGX Spark) or 'ollama' (local, default)",
    )
    parser.add_argument(
        "--model",
        default=None,
        help=f"Model to use (default: spark={DEFAULT_SPARK_MODEL}, ollama={DEFAULT_OLLAMA_MODEL})",
    )
    parser.add_argument(
        "--ollama-url",
        default=OLLAMA_URL,
        help=f"Ollama URL (default: {OLLAMA_URL})",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=CHECKPOINT_INTERVAL,
        help=f"Checkpoint interval (default: {CHECKPOINT_INTERVAL})",
    )
    parser.add_argument(
        "--max-files",
        type=int,
        default=None,
        help="Maximum number of files to categorize (for testing)",
    )
    parser.add_argument(
        "--analyze-only",
        action="store_true",
        help="Skip categorization, just analyze existing results",
    )
    args = parser.parse_args()

    db_path = args.db
    if not Path(db_path).exists():
        logger.error("Database not found: %s (run file-inventory.py first)", db_path)
        sys.exit(1)

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")

    if args.analyze_only:
        analyze_taxonomy(conn)
        conn.close()
        return

    # Set up backend
    if args.backend == "spark":
        model = args.model or DEFAULT_SPARK_MODEL
        backend = SparkBackend(model=model)
    else:
        model = args.model or DEFAULT_OLLAMA_MODEL
        backend = OllamaBackend(model=model, url=args.ollama_url)

    logger.info("Backend: %s, Model: %s", args.backend, model)

    if not backend.start():
        logger.error("Failed to connect to %s backend. Exiting.", args.backend)
        sys.exit(1)

    checkpoint_interval = args.batch_size

    try:
        stats = categorize_files(conn, backend, checkpoint_interval, args.max_files)

        print("\n" + "=" * 70)
        print("CATEGORIZATION RESULTS")
        print("=" * 70)
        print(f"Total processed: {stats['total_processed']:,}")
        print(f"Successfully classified: {stats['classified_ok']:,}")
        print(f"Classification errors: {stats['classification_errors']:,}")
        if stats["total_processed"] > 0:
            rate = stats["classified_ok"] / stats["total_processed"] * 100
            print(f"Success rate: {rate:.1f}%")

        # Run taxonomy analysis on results
        analyze_taxonomy(conn)

    finally:
        backend.stop()
        conn.close()

    logger.info("Categorization complete. Database: %s", db_path)


if __name__ == "__main__":
    main()
