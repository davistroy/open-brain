#!/usr/bin/env python3
"""
Deepgram STT Latency Validation Spike
======================================
Open Brain v2 Phase 0 gate — validates Deepgram cloud STT latency
before committing to the Pipecat voice implementation.

Targets (from PRD-V2 Risk Register):
  - Time-to-first-word:  < 500 ms
  - Total round-trip estimate (STT + LLM + TTS):  < 2 s

Usage:
  export DEEPGRAM_API_KEY=...
  pip install -r scripts/requirements-deepgram.txt
  python scripts/deepgram-spike.py

The script will:
  1. Look for WAV files in scripts/test-audio/
  2. If none found, generate synthetic test tones (5s, 10s, 30s)
  3. Stream each clip to Deepgram Nova-2 via the streaming API
  4. Measure time-to-first-word and total transcription time
  5. Print a formatted report with go/no-go recommendation
"""

from __future__ import annotations

import asyncio
import io
import os
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np  # type: ignore[import-untyped]
from deepgram import (  # type: ignore[import-untyped]
    DeepgramClient,
    LiveOptions,
    LiveTranscriptionEvents,
    PrerecordedOptions,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
AUDIO_DIR = SCRIPT_DIR / "test-audio"
SAMPLE_RATE = 16000  # 16 kHz — Deepgram's preferred rate
CHANNELS = 1
SAMPLE_WIDTH = 2  # 16-bit PCM
CHUNK_DURATION_S = 0.1  # Send audio in 100 ms chunks (simulates real-time streaming)

# Synthetic clip durations when no WAV files are available
SYNTHETIC_DURATIONS = [5, 10, 30]

# Deepgram model — Nova-2 is optimized for speed
DEEPGRAM_MODEL = "nova-2"

# Latency targets (seconds)
TARGET_TTFW = 0.5  # time-to-first-word
TARGET_ROUNDTRIP = 2.0  # STT + LLM + TTS budget

# Estimated LLM + TTS overhead for round-trip calculation
# Conservative: 800ms Claude API + 400ms TTS synthesis
ESTIMATED_LLM_TTS_OVERHEAD = 1.2


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class TranscriptResult:
    """Holds results from a single streaming transcription run."""

    clip_name: str
    clip_duration_s: float
    time_to_first_word_s: float | None = None
    total_time_s: float = 0.0
    word_count: int = 0
    transcript: str = ""
    is_final: bool = False
    error: str | None = None
    partial_results: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# WAV generation (synthetic test tones)
# ---------------------------------------------------------------------------


def generate_wav_bytes(duration_s: float, freq_start: float = 200, freq_end: float = 800) -> bytes:
    """Generate a WAV file in memory with a frequency-sweep sine wave.

    Not useful for transcription accuracy (no speech), but validates:
    - API connectivity
    - Streaming latency
    - Round-trip timing
    """
    num_samples = int(SAMPLE_RATE * duration_s)
    np.linspace(0, duration_s, num_samples, endpoint=False)

    # Linear frequency sweep
    freqs = np.linspace(freq_start, freq_end, num_samples)
    phase = 2 * np.pi * np.cumsum(freqs) / SAMPLE_RATE
    samples = (np.sin(phase) * 0.5 * 32767).astype(np.int16)

    # Build WAV in memory
    buf = io.BytesIO()
    data_size = num_samples * SAMPLE_WIDTH * CHANNELS
    # RIFF header
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", 36 + data_size))
    buf.write(b"WAVE")
    # fmt chunk
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))  # chunk size
    buf.write(struct.pack("<H", 1))  # PCM format
    buf.write(struct.pack("<H", CHANNELS))
    buf.write(struct.pack("<I", SAMPLE_RATE))
    buf.write(struct.pack("<I", SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH))  # byte rate
    buf.write(struct.pack("<H", CHANNELS * SAMPLE_WIDTH))  # block align
    buf.write(struct.pack("<H", SAMPLE_WIDTH * 8))  # bits per sample
    # data chunk
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(samples.tobytes())
    return buf.getvalue()


def load_wav_file(path: Path) -> tuple[bytes, float]:
    """Load a WAV file and return (raw_bytes, duration_seconds)."""
    data = path.read_bytes()
    # Parse WAV header for duration calculation
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"{path.name} is not a valid WAV file")

    # Find data chunk
    pos = 12
    while pos < len(data) - 8:
        chunk_id = data[pos : pos + 4]
        chunk_size = struct.unpack_from("<I", data, pos + 4)[0]
        if chunk_id == b"fmt ":
            fmt_channels = struct.unpack_from("<H", data, pos + 10)[0]
            fmt_rate = struct.unpack_from("<I", data, pos + 12)[0]
            fmt_width = struct.unpack_from("<H", data, pos + 22)[0] // 8
        if chunk_id == b"data":
            data_size = chunk_size
            break
        pos += 8 + chunk_size
    else:
        raise ValueError(f"{path.name}: could not find data chunk")

    duration = data_size / (fmt_rate * fmt_channels * fmt_width)  # type: ignore[reportPossiblyUnbound]
    return data, duration


# ---------------------------------------------------------------------------
# Deepgram streaming test
# ---------------------------------------------------------------------------


async def test_streaming_latency(
    client: DeepgramClient,
    audio_bytes: bytes,
    clip_name: str,
    clip_duration_s: float,
) -> TranscriptResult:
    """Stream audio to Deepgram's live transcription API and measure latency."""

    result = TranscriptResult(
        clip_name=clip_name,
        clip_duration_s=clip_duration_s,
    )

    first_word_time: float | None = None
    start_time: float | None = None
    transcript_parts: list[str] = []
    total_words = 0
    connection_ready = asyncio.Event()
    done_event = asyncio.Event()
    error_captured: str | None = None

    try:
        dg_connection = client.listen.asyncwebsocket.v("1")

        async def on_open(self, open_response, **kwargs):
            nonlocal start_time
            connection_ready.set()

        async def on_message(self, msg, **kwargs):
            nonlocal first_word_time, total_words
            sentence = msg.channel.alternatives[0]
            transcript = sentence.transcript.strip()
            if transcript:
                if first_word_time is None:
                    first_word_time = time.perf_counter()
                words = transcript.split()
                total_words += len(words)
                if msg.is_final:
                    transcript_parts.append(transcript)
                else:
                    result.partial_results.append(transcript)

        async def on_error(self, error, **kwargs):
            nonlocal error_captured
            error_captured = str(error)
            done_event.set()

        async def on_close(self, close_response, **kwargs):
            done_event.set()

        dg_connection.on(LiveTranscriptionEvents.Open, on_open)
        dg_connection.on(LiveTranscriptionEvents.Transcript, on_message)
        dg_connection.on(LiveTranscriptionEvents.Error, on_error)
        dg_connection.on(LiveTranscriptionEvents.Close, on_close)

        options = LiveOptions(
            model=DEEPGRAM_MODEL,
            language="en",
            encoding="linear16",
            sample_rate=SAMPLE_RATE,
            channels=CHANNELS,
            punctuate=True,
            interim_results=True,
            endpointing=300,  # ms — quick endpoint detection
            vad_events=True,
        )

        started = await dg_connection.start(options)
        if not started:
            result.error = "Failed to start Deepgram connection"
            return result

        # Wait for connection to be ready
        await asyncio.wait_for(connection_ready.wait(), timeout=5.0)

        # Stream audio in real-time-ish chunks
        chunk_size = int(SAMPLE_RATE * SAMPLE_WIDTH * CHANNELS * CHUNK_DURATION_S)
        # Skip WAV header (44 bytes) if present
        audio_start = 44 if audio_bytes[:4] == b"RIFF" else 0
        audio_data = audio_bytes[audio_start:]

        start_time = time.perf_counter()
        offset = 0
        while offset < len(audio_data):
            chunk = audio_data[offset : offset + chunk_size]
            await dg_connection.send(chunk)
            offset += chunk_size
            # Pace to simulate real-time (slightly faster to stress-test)
            await asyncio.sleep(CHUNK_DURATION_S * 0.8)

        # Signal end of audio
        await dg_connection.finish()

        # Wait for final results (timeout after 5s past end of audio)
        try:
            await asyncio.wait_for(done_event.wait(), timeout=5.0)
        except TimeoutError:
            pass  # Some clips may not trigger close; that's OK

        end_time = time.perf_counter()

        result.total_time_s = end_time - start_time
        result.word_count = total_words
        result.transcript = " ".join(transcript_parts)
        result.is_final = True

        if first_word_time is not None and start_time is not None:
            result.time_to_first_word_s = first_word_time - start_time

        if error_captured:
            result.error = error_captured

    except Exception as e:
        result.error = f"{type(e).__name__}: {e}"

    return result


# ---------------------------------------------------------------------------
# Pre-recorded (batch) test for comparison
# ---------------------------------------------------------------------------


async def test_prerecorded_latency(
    client: DeepgramClient,
    audio_bytes: bytes,
    clip_name: str,
    clip_duration_s: float,
) -> TranscriptResult:
    """Send audio to Deepgram's pre-recorded API for baseline comparison."""

    result = TranscriptResult(
        clip_name=clip_name + " [batch]",
        clip_duration_s=clip_duration_s,
    )

    try:
        options = PrerecordedOptions(
            model=DEEPGRAM_MODEL,
            language="en",
            punctuate=True,
        )

        source = {"buffer": audio_bytes, "mimetype": "audio/wav"}

        start_time = time.perf_counter()
        response = await client.listen.asyncrest.v("1").transcribe_file(source, options)
        end_time = time.perf_counter()

        result.total_time_s = end_time - start_time
        result.time_to_first_word_s = result.total_time_s  # Batch = all at once

        transcript = response.results.channels[0].alternatives[0].transcript
        result.transcript = transcript
        result.word_count = len(transcript.split()) if transcript else 0
        result.is_final = True

    except Exception as e:
        result.error = f"{type(e).__name__}: {e}"

    return result


# ---------------------------------------------------------------------------
# Report formatting
# ---------------------------------------------------------------------------


def format_report(results: list[TranscriptResult]) -> str:
    """Format test results into a readable report with go/no-go recommendation."""

    lines: list[str] = []
    lines.append("")
    lines.append("=" * 76)
    lines.append("  DEEPGRAM STT LATENCY VALIDATION REPORT")
    lines.append("  Open Brain v2 — Phase 0 Spike")
    lines.append("=" * 76)
    lines.append("")
    lines.append(f"  Model:           {DEEPGRAM_MODEL}")
    lines.append(f"  Sample rate:     {SAMPLE_RATE} Hz")
    lines.append(f"  Chunk duration:  {CHUNK_DURATION_S * 1000:.0f} ms")
    lines.append(f"  Target TTFW:     < {TARGET_TTFW * 1000:.0f} ms")
    lines.append(f"  Target RTT:      < {TARGET_ROUNDTRIP * 1000:.0f} ms (STT + LLM + TTS)")
    lines.append("")

    # Split streaming vs batch results
    streaming = [r for r in results if "[batch]" not in r.clip_name]
    batch = [r for r in results if "[batch]" in r.clip_name]

    # Streaming results table
    lines.append("-" * 76)
    lines.append("  STREAMING RESULTS (simulated real-time)")
    lines.append("-" * 76)
    lines.append(
        f"  {'Clip':<28} {'Duration':>8} {'TTFW':>10} {'Total':>10} {'Words':>6} {'Status':>8}"
    )
    lines.append(
        f"  {'----':<28} {'--------':>8} {'----':>10} {'-----':>10} {'-----':>6} {'------':>8}"
    )

    ttfw_values: list[float] = []
    total_values: list[float] = []

    for r in streaming:
        dur = f"{r.clip_duration_s:.1f}s"
        if r.error:
            lines.append(f"  {r.clip_name:<28} {dur:>8} {'ERROR':>10} {'':>10} {'':>6} {'FAIL':>8}")
            lines.append(f"    Error: {r.error}")
            continue

        ttfw_str = (
            f"{r.time_to_first_word_s * 1000:.0f}ms"
            if r.time_to_first_word_s is not None
            else "N/A"
        )
        total_str = f"{r.total_time_s * 1000:.0f}ms"
        words_str = str(r.word_count)

        ttfw_ok = r.time_to_first_word_s is not None and r.time_to_first_word_s < TARGET_TTFW
        status = "PASS" if ttfw_ok else ("WARN" if r.time_to_first_word_s is None else "FAIL")

        if r.time_to_first_word_s is not None:
            ttfw_values.append(r.time_to_first_word_s)
            total_values.append(r.total_time_s)

        if status == "FAIL":
            pass

        lines.append(
            f"  {r.clip_name:<28} {dur:>8} {ttfw_str:>10} {total_str:>10} {words_str:>6} {status:>8}"
        )
        if r.transcript:
            preview = r.transcript[:60] + "..." if len(r.transcript) > 60 else r.transcript
            lines.append(f"    Transcript: {preview}")

    lines.append("")

    # Batch results (if any)
    if batch:
        lines.append("-" * 76)
        lines.append("  BATCH (PRE-RECORDED) RESULTS — baseline comparison")
        lines.append("-" * 76)
        lines.append(f"  {'Clip':<28} {'Duration':>8} {'API Time':>10} {'Words':>6}")
        lines.append(f"  {'----':<28} {'--------':>8} {'--------':>10} {'-----':>6}")

        for r in batch:
            dur = f"{r.clip_duration_s:.1f}s"
            if r.error:
                lines.append(f"  {r.clip_name:<28} {dur:>8} {'ERROR':>10} {'':>6}")
                lines.append(f"    Error: {r.error}")
                continue
            total_str = f"{r.total_time_s * 1000:.0f}ms"
            words_str = str(r.word_count)
            lines.append(f"  {r.clip_name:<28} {dur:>8} {total_str:>10} {words_str:>6}")

        lines.append("")

    # Summary statistics
    lines.append("-" * 76)
    lines.append("  SUMMARY")
    lines.append("-" * 76)

    if ttfw_values:
        avg_ttfw = sum(ttfw_values) / len(ttfw_values)
        min_ttfw = min(ttfw_values)
        max_ttfw = max(ttfw_values)
        p90_ttfw = (
            sorted(ttfw_values)[int(len(ttfw_values) * 0.9)] if len(ttfw_values) >= 3 else max_ttfw
        )

        avg_total = sum(total_values) / len(total_values)
        estimated_rtt = avg_ttfw + ESTIMATED_LLM_TTS_OVERHEAD

        lines.append(f"  Streaming clips tested:     {len(streaming)}")
        lines.append(f"  Clips with transcription:   {len(ttfw_values)}")
        lines.append("")
        lines.append("  Time-to-first-word (TTFW):")
        lines.append(
            f"    Average:  {avg_ttfw * 1000:>8.0f} ms   (target: < {TARGET_TTFW * 1000:.0f} ms)"
        )
        lines.append(f"    Min:      {min_ttfw * 1000:>8.0f} ms")
        lines.append(f"    Max:      {max_ttfw * 1000:>8.0f} ms")
        lines.append(f"    P90:      {p90_ttfw * 1000:>8.0f} ms")
        lines.append("")
        lines.append(f"  Total streaming time (avg): {avg_total * 1000:>8.0f} ms")
        lines.append("  Est. round-trip (TTFW + LLM + TTS overhead):")
        lines.append(
            f"    {avg_ttfw * 1000:.0f}ms STT + {ESTIMATED_LLM_TTS_OVERHEAD * 1000:.0f}ms overhead = {estimated_rtt * 1000:.0f}ms"
        )
        lines.append(
            f"    Target: < {TARGET_ROUNDTRIP * 1000:.0f} ms  {'PASS' if estimated_rtt < TARGET_ROUNDTRIP else 'FAIL'}"
        )
    else:
        lines.append("  No successful streaming transcriptions to analyze.")
        lines.append("  (Synthetic tones may not produce words — try real speech WAV files)")

    lines.append("")

    # Go/no-go decision
    lines.append("=" * 76)

    has_data = len(ttfw_values) > 0
    if has_data:
        avg_ttfw = sum(ttfw_values) / len(ttfw_values)
        estimated_rtt = avg_ttfw + ESTIMATED_LLM_TTS_OVERHEAD
        ttfw_pass = avg_ttfw < TARGET_TTFW
        rtt_pass = estimated_rtt < TARGET_ROUNDTRIP
    else:
        ttfw_pass = False
        rtt_pass = False

    # Determine recommendation
    no_errors = all(r.error is None for r in streaming)

    if has_data and ttfw_pass and rtt_pass and no_errors:
        lines.append("  RECOMMENDATION:  GO")
        lines.append("")
        lines.append("  Deepgram Nova-2 streaming STT meets all latency targets.")
        lines.append("  Proceed to Phase 6.2 (Pipecat voice service implementation).")
    elif has_data and ttfw_pass and not rtt_pass:
        lines.append("  RECOMMENDATION:  CONDITIONAL GO")
        lines.append("")
        lines.append("  TTFW is within target but estimated round-trip exceeds budget.")
        lines.append("  Mitigations: use faster TTS, add 'thinking' indicator, reduce LLM tokens.")
        lines.append("  Proceed with caution — budget the latency gap in UX design.")
    elif no_errors and not has_data:
        lines.append("  RECOMMENDATION:  INCONCLUSIVE — RETEST WITH SPEECH")
        lines.append("")
        lines.append("  API connectivity confirmed but no words transcribed.")
        lines.append("  Synthetic tones don't produce speech — this is expected.")
        lines.append("  Place real WAV files in scripts/test-audio/ and rerun.")
        lines.append("  API round-trip times still provide useful latency signal.")
    elif not no_errors:
        lines.append("  RECOMMENDATION:  NO-GO (ERRORS)")
        lines.append("")
        lines.append("  Errors occurred during testing. Investigate before proceeding.")
    else:
        lines.append("  RECOMMENDATION:  NO-GO")
        lines.append("")
        lines.append(
            f"  Average TTFW ({avg_ttfw * 1000:.0f}ms) exceeds target ({TARGET_TTFW * 1000:.0f}ms)."  # type: ignore[reportPossiblyUnbound]
        )
        lines.append("  Options: try nova-2-general, reduce chunk size, accept higher latency.")

    lines.append("=" * 76)
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


async def main() -> int:
    # Check API key
    api_key = os.environ.get("DEEPGRAM_API_KEY")
    if not api_key:
        print("ERROR: DEEPGRAM_API_KEY environment variable is not set.")
        print("Get a key at https://console.deepgram.com/ and export it:")
        print("  export DEEPGRAM_API_KEY=your_key_here")
        return 1

    print(f"Deepgram STT Latency Spike — model: {DEEPGRAM_MODEL}")
    print(f"Audio dir: {AUDIO_DIR}")

    client = DeepgramClient(api_key)

    # Discover or generate test audio
    clips: list[tuple[str, bytes, float]] = []  # (name, wav_bytes, duration_s)

    # Check for user-provided WAV files
    if AUDIO_DIR.exists():
        wav_files = sorted(AUDIO_DIR.glob("*.wav"))
        for wav_path in wav_files:
            try:
                wav_bytes, duration = load_wav_file(wav_path)
                clips.append((wav_path.stem, wav_bytes, duration))
                print(f"  Found: {wav_path.name} ({duration:.1f}s)")
            except Exception as e:
                print(f"  Skipping {wav_path.name}: {e}")

    # Generate synthetic clips if no WAV files found
    if not clips:
        print("  No WAV files found in test-audio/ — generating synthetic test tones")
        print("  (Tones validate connectivity and latency, not transcription accuracy)")
        for dur in SYNTHETIC_DURATIONS:
            wav_bytes = generate_wav_bytes(dur)
            clips.append((f"synthetic-{dur}s", wav_bytes, dur))
            print(f"  Generated: synthetic-{dur}s ({dur}s)")

    print(f"\nRunning {len(clips)} streaming tests + {len(clips)} batch tests...\n")

    # Run tests
    results: list[TranscriptResult] = []

    for name, wav_bytes, duration in clips:
        # Streaming test
        print(f"  Streaming: {name} ({duration:.1f}s)...", end="", flush=True)
        r = await test_streaming_latency(client, wav_bytes, name, duration)
        if r.error:
            print(f" ERROR: {r.error}")
        elif r.time_to_first_word_s is not None:
            print(
                f" TTFW={r.time_to_first_word_s * 1000:.0f}ms, total={r.total_time_s * 1000:.0f}ms, words={r.word_count}"
            )
        else:
            print(f" no words detected, total={r.total_time_s * 1000:.0f}ms")
        results.append(r)

        # Batch test for comparison
        print(f"  Batch:     {name} ({duration:.1f}s)...", end="", flush=True)
        r_batch = await test_prerecorded_latency(client, wav_bytes, name, duration)
        if r_batch.error:
            print(f" ERROR: {r_batch.error}")
        else:
            print(f" time={r_batch.total_time_s * 1000:.0f}ms, words={r_batch.word_count}")
        results.append(r_batch)

        print()

    # Print report
    report = format_report(results)
    print(report)

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
