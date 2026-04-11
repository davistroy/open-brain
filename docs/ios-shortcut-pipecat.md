# iOS Shortcut Update -- Pipecat Voice Conversations

This guide explains how to update the existing Open Brain iOS Shortcut to support interactive voice conversations via the Pipecat WebSocket service, with fallback to the existing one-shot HTTP upload when Pipecat is unavailable.

## Overview

The original iOS Shortcut records audio, uploads it via HTTP POST to the voice-capture service, and receives a transcript + capture ID back. That flow still works and serves as the fallback.

The new Pipecat flow enables a real-time, interactive voice conversation with your brain -- you speak, the brain responds, you reply, and so on. Captures are extracted from the conversation context and ingested automatically.

## WebSocket URL

| Access Method | URL |
|---------------|-----|
| Tailscale (recommended) | `ws://<homeserver-tailscale-ip>:8765` |
| Cloudflare Tunnel (if exposed) | `wss://brain.troy-davis.com:8765` |

Find your homeserver's Tailscale IP in the Tailscale app on any connected device, or run `tailscale ip` on the server. Example: `ws://100.64.1.10:8765`

**Note:** WebSocket connections over Cloudflare Tunnel require the tunnel to be configured for the Pipecat port (8765). If not yet configured, use the Tailscale URL.

## Shortcut Configuration -- Interactive Mode

iOS Shortcuts do not natively support WebSocket connections. To enable the Pipecat interactive flow, you have two options:

### Option A: Scriptable App (Recommended)

Use the [Scriptable](https://apps.apple.com/app/scriptable/id1405459188) app to run JavaScript that manages the WebSocket connection.

1. **Install Scriptable** from the App Store.

2. **Create a new script** in Scriptable named "Brain Conversation":

```javascript
// Brain Conversation -- Pipecat WebSocket client
const WS_URL = "ws://<tailscale-ip>:8765";
const FALLBACK_URL = "http://<tailscale-ip>:3001/api/capture";

async function startConversation() {
  try {
    // Attempt WebSocket connection
    let ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log("Connected to Pipecat");
      // The Pipecat service handles audio streaming
      // On iOS, audio capture is managed by the native speech framework
    };

    ws.onmessage = (event) => {
      let data = JSON.parse(event.data);
      if (data.type === "transcript") {
        console.log("Brain: " + data.text);
      }
    };

    ws.onerror = async (error) => {
      console.log("WebSocket failed, falling back to HTTP upload");
      await fallbackUpload();
    };

    ws.onclose = () => {
      console.log("Conversation ended");
      Script.complete();
    };

  } catch (e) {
    console.log("Connection failed: " + e.message);
    await fallbackUpload();
  }
}

async function fallbackUpload() {
  // Fall back to one-shot voice capture via HTTP POST
  // This mirrors the existing iOS Shortcut behavior
  let alert = new Alert();
  alert.title = "Pipecat Unavailable";
  alert.message = "Falling back to one-shot voice capture. Record your memo and it will be uploaded.";
  alert.addAction("OK");
  await alert.present();

  // Trigger the existing voice capture shortcut
  let callback = new CallbackURL("shortcuts://run-shortcut");
  callback.addParameter("name", "Open Brain Voice Capture");
  callback.open();
}

await startConversation();
```

3. **Create an iOS Shortcut** named "Brain Conversation" with a single action:
   - **Run Script** (Scriptable)
   - Script: "Brain Conversation"

### Option B: Native Shortcut with Connection Check

If you prefer not to use Scriptable, update the existing Shortcut to check Pipecat availability and fall back gracefully:

1. **Get Contents of URL** (health check)
   - URL: `http://<tailscale-ip>:8765/health`
   - Method: `GET`
   - Continue on error: **Yes**

2. **If** the result contains "ok":
   - Show an alert: "Pipecat is available. Open the Brain Conversation app to start a voice conversation."
   - (A dedicated Pipecat client app would be needed for full WebSocket support from a native Shortcut)

3. **Otherwise** (fallback to existing one-shot flow):
   - **Record Audio**
   - **Get Current Location** (optional)
   - **Get Contents of URL**
     - URL: `http://<tailscale-ip>:3001/api/capture`
     - Method: `POST`
     - Request Body: Form (multipart)
     - Add field `file` with the recorded audio
     - Add field `brain_view` with value `personal` (or another view)
     - Optionally add `latitude`, `longitude`, `location_name`, `location_accuracy`
   - **Show Result**

## Fallback: One-Shot Voice Capture

The existing HTTP POST flow remains fully operational and serves as the automatic fallback:

- **Endpoint:** `http://<tailscale-ip>:3001/api/capture`
- **Method:** POST (multipart form)
- **Field:** `file` (audio file -- m4a, wav, mp3)
- **Optional fields:** `brain_view`, `latitude`, `longitude`, `location_name`, `location_accuracy`

See `docs/ios-shortcut.md` for the full one-shot configuration guide.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| WebSocket connection refused | Pipecat service may not be running. Check `docker ps` on homeserver. Falls back to HTTP. |
| Tailscale IP not reachable | Ensure Tailscale is connected on both iPhone and homeserver. |
| Audio not captured | Check microphone permissions for Shortcuts/Scriptable in iOS Settings. |
| Conversation cuts out | Check Wi-Fi stability. Pipecat sessions require a sustained connection. |
| No captures created | Pipecat extracts captures from conversation context -- very short conversations may not produce captures. |

## Architecture

```
iPhone/Watch
    |
    |-- [WebSocket] --> Pipecat (:8765)
    |                      |
    |                      +--> Deepgram STT (cloud)
    |                      +--> Claude (conversation)
    |                      +--> Core API (capture extraction)
    |
    |-- [HTTP POST] ----> Voice-Capture (:3001) [fallback]
                             |
                             +--> faster-whisper (STT)
                             +--> Core API (capture ingest)
```
