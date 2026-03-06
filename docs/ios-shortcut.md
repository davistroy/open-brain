# iOS Shortcut Setup — Open Brain Voice Capture

This document explains how to configure an iOS Shortcut to record audio on iPhone or Apple Watch and send it to the Open Brain voice-capture service for transcription and ingestion.

## Access Pattern

The voice-capture service runs on port 3001 and is accessed **directly via Tailscale IP** from iOS devices. It is NOT behind the Cloudflare Tunnel (brain.k4jda.net routes only to core-api on port 3000).

**Primary**: `http://<homeserver-tailscale-ip>:3001`
**Secondary**: If you know the LAN IP and are on the same network, `http://<homeserver-lan-ip>:3001`

Find your homeserver's Tailscale IP in the Tailscale app on any connected device, or run `tailscale ip` on the server. Example: `http://100.64.1.10:3001`

## Shortcut Configuration

### Required Actions

1. **Record Audio** (or **Get File** if triggering from Watch)
   - Input: microphone
   - Duration: until stopped (or set a max, e.g. 5 minutes)
   - For Watch: the Watch records audio via the Watch app, which passes the file to the iPhone Shortcut

2. **Get Contents of URL**
   - URL: `http://<tailscale-ip>:3001/api/capture`
   - Method: `POST`
   - Request Body: **Form**
   - Add field:
     - Key: `audio`
     - Value: the recorded audio from the previous action (file reference)
     - Type: **File**

3. (Optional) **Get Dictionary Value**
   - Input: result from Get Contents of URL
   - Key: `capture_id` (or `message` for status text)

4. (Optional) **Show Notification** or **Show Result**
   - Display the capture ID or status for confirmation

### Optional: brain_view Query Parameter

To route the capture to a specific brain view, append a `brain_view` query parameter to the URL:

```
http://<tailscale-ip>:3001/api/capture?brain_view=work-internal
```

Valid values: `career`, `personal`, `technical`, `work-internal`, `client`

If omitted, the service auto-classifies the capture's brain view from the transcript content.

### Endpoint Reference

| Field | Value |
|-------|-------|
| URL | `http://<tailscale-ip>:3001/api/capture` |
| Method | `POST` |
| Content-Type | `multipart/form-data` |
| Field name | `audio` |
| Supported formats | `.m4a` (default from iPhone/Watch), `.wav`, `.mp3`, `.ogg` |

**Response (success, HTTP 202)**:
```json
{
  "capture_id": "uuid",
  "status": "processing",
  "message": "Voice memo received and queued for transcription"
}
```

**Response (error, HTTP 4xx/5xx)**:
```json
{
  "error": "description of what went wrong"
}
```

## Apple Watch Complications

To trigger the shortcut directly from the Watch face:

1. Open the **Shortcuts** app on Apple Watch (or add it via Watch app on iPhone).
2. Find your voice capture shortcut in the list.
3. Tap the **...** menu on the shortcut and enable **Show on Apple Watch**.
4. In the Watch app on iPhone, go to **My Faces** → edit a watch face → add the **Shortcuts** complication → select your voice capture shortcut.

When you tap the complication, the Watch microphone opens immediately and records. When you tap Done, the audio is sent to the Shortcut for POST to voice-capture.

### Watch-Specific Notes

- iPhone must be reachable via Tailscale during the upload (Shortcut executes on iPhone after Watch recording completes).
- Audio recorded on Watch is `.m4a` format — fully supported by the voice-capture service.
- If the iPhone is offline, the Shortcut will fail at the URL step. Add a **If** action checking the result for null/error if you want a fallback notification.
- Shortcut execution continues in the background after Watch recording; you do not need to stay in the Shortcuts app.

## Confirmation

On successful capture, the voice-capture service sends a Pushover notification to your iPhone. The notification includes:

- Capture type (decision, idea, task, etc.)
- Key topics extracted from the transcript
- Entity mentions (people, projects, companies)

This Pushover notification is separate from the optional Shortcut "Show Result" action — it fires from the server side after transcription and classification complete (typically within 15–60 seconds depending on audio length).

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| "Could not connect" error in Shortcut | Tailscale not active on iPhone | Open Tailscale app, ensure VPN is connected |
| HTTP 503 from /api/capture | voice-capture or faster-whisper container not running | SSH to homeserver, `docker compose ps` |
| No Pushover notification | PUSHOVER_TOKEN / PUSHOVER_USER not set in .env.secrets | Check `docker compose logs voice-capture` |
| Transcription takes >2 minutes | faster-whisper still loading model on first start | Wait for model load (up to 5 minutes on cold start) |
| brain_view rejected | Invalid view name in query param | Use one of: career, personal, technical, work-internal, client |

## Example Shortcut (Step-by-Step)

```
[Shortcut Name: Brain Voice Memo]

1. Record Audio
   - Audio Recording: Until Stopped

2. Get Contents of URL
   - URL: http://100.64.x.x:3001/api/capture
   - Method: POST
   - Request Body: Form
   - [+] audio = Recorded Audio (File)

3. Get Dictionary Value
   - Key: message
   - Dictionary: Contents of URL

4. Show Notification
   - Title: Brain Capture
   - Body: Dictionary Value
```

Replace `100.64.x.x` with your homeserver's actual Tailscale IP.
