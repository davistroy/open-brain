# Test Audio Files for Deepgram Spike

Place WAV audio files in this directory for the Deepgram latency validation script.

## Requirements

- Format: WAV (PCM), 16-bit, mono, 16kHz sample rate (Deepgram's preferred format)
- Recommended clips: 5s, 10s, 30s of clear spoken English
- Name files descriptively: `05s-clear-speech.wav`, `10s-noisy.wav`, etc.

## Generating test audio

If you don't have WAV files handy, the spike script (`../deepgram-spike.py`) will
auto-generate synthetic test tones using numpy. These are sine-wave chirps — they
won't produce meaningful transcriptions but will validate connectivity, streaming
latency, and API round-trip timing.

For meaningful accuracy testing, record yourself reading a passage and save as WAV:

```bash
# macOS — record 10 seconds of microphone audio
sox -d -r 16000 -c 1 -b 16 10s-speech.wav trim 0 10

# ffmpeg — convert any audio file to the right format
ffmpeg -i input.mp3 -ar 16000 -ac 1 -sample_fmt s16 10s-speech.wav
```

## .gitignore

WAV files in this directory are gitignored (binary test fixtures don't belong in the repo).
