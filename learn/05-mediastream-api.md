# MediaStream API & getUserMedia

## What Are MediaStream and MediaStreamTrack?

A `MediaStream` is a container for media data — typically audio and/or video. It consists of one or more `MediaStreamTrack` objects:

```
MediaStream
  ├── MediaStreamTrack (video)  ← camera feed
  └── MediaStreamTrack (audio)  ← microphone feed
```

When a video call app like Google Meet calls `getUserMedia()`, the browser returns a `MediaStream` containing the user's camera and microphone tracks. The app then feeds these tracks into a WebRTC `RTCPeerConnection` to transmit to other participants.

**AirDraw's job:** Intercept this flow. Replace the video track with our composited track (camera + drawing overlay) before the meeting app gets it. The meeting app never knows the difference — it just sees a `MediaStreamTrack` that happens to contain drawings.

---

## navigator.mediaDevices.getUserMedia()

### Basic Usage

```typescript
const stream = await navigator.mediaDevices.getUserMedia({
  video: true,
  audio: true,
});

// Access individual tracks
const videoTrack = stream.getVideoTracks()[0];
const audioTrack = stream.getAudioTracks()[0];

// Get the video track's actual settings
const settings = videoTrack.getSettings();
console.log(`Resolution: ${settings.width}x${settings.height}`);
console.log(`Frame rate: ${settings.frameRate}`);
```

### Constraints

Constraints let you specify what kind of media you want:

```typescript
const stream = await navigator.mediaDevices.getUserMedia({
  video: {
    width: { ideal: 1280 },          // Prefer 1280, accept others
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 60 },
    facingMode: "user",               // Front camera (selfie)
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
  },
});
```

Constraint levels:
- `exact`: Must match exactly, or the call fails
- `ideal`: Prefer this value, but accept the closest match
- `min` / `max`: Acceptable range
- Plain value: Same as `ideal`

```typescript
// This FAILS if the camera cannot do exactly 1920x1080
video: { width: { exact: 1920 }, height: { exact: 1080 } }

// This succeeds with whatever is closest to 1920x1080
video: { width: { ideal: 1920 }, height: { ideal: 1080 } }
```

---

## Why We Need to Patch getUserMedia

Here is the core problem AirDraw solves:

1. Google Meet calls `navigator.mediaDevices.getUserMedia({ video: true })`
2. The browser returns a `MediaStream` with the raw camera feed
3. Meet sends this stream to other participants via WebRTC

We want to insert step 2.5: replace the video track with our composited stream (camera + drawing). But Meet's code is minified and obfuscated — we cannot modify it. We cannot add a "plugin" to Meet.

The only reliable approach: **monkey-patch `getUserMedia` before Meet's code runs**, so that when Meet calls it, it gets our modified stream instead of the raw camera.

---

## How to Monkey-Patch a Browser API Safely

### The Basic Patch

```typescript
// Save the original function
const originalGetUserMedia =
  navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

// Replace it with our version
navigator.mediaDevices.getUserMedia = async function (
  constraints?: MediaStreamConstraints
): Promise<MediaStream> {
  // Call the real getUserMedia
  const originalStream = await originalGetUserMedia(constraints);

  // If no video was requested, pass through unchanged
  if (!constraints?.video) {
    return originalStream;
  }

  // Replace the video track with our composited version
  const compositedStream = createCompositedStream(originalStream);
  return compositedStream;
};
```

### Making It Safe

Several things can go wrong with a naive patch:

**1. The page might check for tampering:**

```typescript
// Some apps check if getUserMedia is the native implementation
navigator.mediaDevices.getUserMedia.toString();
// Native: "function getUserMedia() { [native code] }"
// Patched: "async function (constraints) { ... }"

// Fix: Override toString
const patchedFn = async function(constraints) { ... };
patchedFn.toString = () => "function getUserMedia() { [native code] }";
navigator.mediaDevices.getUserMedia = patchedFn;
```

**2. The page might access getUserMedia via the prototype:**

```typescript
// Some apps do: MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices, ...)
// Our instance-level patch would be bypassed

// Fix: Also patch the prototype
const originalProto = MediaDevices.prototype.getUserMedia;
MediaDevices.prototype.getUserMedia = async function(constraints) {
  const stream = await originalProto.call(this, constraints);
  if (!constraints?.video) return stream;
  return createCompositedStream(stream);
};
```

**3. Save references before anything else runs:**

```typescript
// At the TOP of the MAIN world content script (document_start)
// Save references to APIs we need, before the page can modify them
const _getUserMedia = navigator.mediaDevices.getUserMedia.bind(
  navigator.mediaDevices
);
const _MediaStream = window.MediaStream;
const _RTCPeerConnection = window.RTCPeerConnection;
```

---

## captureStream() Methods

### HTMLCanvasElement.captureStream()

Creates a `MediaStream` from a canvas. Every time the canvas is updated, the stream gets a new frame.

```typescript
const canvas = document.createElement("canvas");
canvas.width = 1280;
canvas.height = 720;
const ctx = canvas.getContext("2d")!;

// Capture at 30 fps
const stream = canvas.captureStream(30);

// Use this stream anywhere a camera stream is expected
console.log(stream.getVideoTracks().length); // 1
```

### HTMLMediaElement.captureStream() (for <video> elements)

```typescript
const video = document.querySelector("video")!;
const stream = video.captureStream();
// stream contains the video's audio and video tracks
```

### MediaStream Constructor

You can also construct a stream by picking tracks from multiple sources:

```typescript
const cameraStream = await navigator.mediaDevices.getUserMedia({
  video: true,
  audio: true,
});

const canvasStream = compositeCanvas.captureStream(30);

// Take the video from our composited canvas, audio from the camera
const mixedStream = new MediaStream([
  canvasStream.getVideoTracks()[0],  // Composited video
  cameraStream.getAudioTracks()[0],  // Original audio
]);
```

This is exactly what AirDraw does — we keep the original audio track untouched and only replace the video track.

---

## Track Manipulation

### Replacing Tracks

You cannot directly replace a track inside a `MediaStream` object in a way that is guaranteed to propagate to all consumers. Instead:

**Approach 1: Replace in RTCPeerConnection (most reliable)**

```typescript
// Find the sender that is sending the video track
const peerConnection: RTCPeerConnection = /* ... */;
const videoSender = peerConnection.getSenders().find(
  (s) => s.track?.kind === "video"
);

if (videoSender) {
  await videoSender.replaceTrack(compositedTrack);
}
```

**Approach 2: Return the modified stream from getUserMedia (AirDraw's approach)**

Since we control what `getUserMedia` returns, we build the composited stream before the meeting app ever sees it:

```typescript
navigator.mediaDevices.getUserMedia = async function(constraints) {
  const original = await _getUserMedia(constraints);

  if (!constraints?.video) return original;

  // Start our compositing pipeline
  startCompositing(original);

  // Return a stream with our composited video track + original audio
  const outputStream = new MediaStream([
    compositeCanvas.captureStream(30).getVideoTracks()[0],
    ...original.getAudioTracks(),
  ]);

  return outputStream;
};
```

### Cloning Streams

```typescript
const clone = originalStream.clone();
// clone is independent — stopping a track on the clone
// does not affect the original
```

Cloning is useful when you need to use the camera feed in two places: one for MediaPipe processing, one for the composite canvas.

### Track Events

```typescript
const track = stream.getVideoTracks()[0];

track.addEventListener("ended", () => {
  console.log("Camera was disconnected or permissions revoked");
  cleanup();
});

track.addEventListener("mute", () => {
  console.log("Track was muted (e.g., camera paused by OS)");
});

track.addEventListener("unmute", () => {
  console.log("Track was unmuted");
});
```

---

## The "Late Activation" Problem

### The Problem

A user might visit Google Meet, join a call, and only then enable AirDraw. By that point, Meet has already called `getUserMedia` and obtained a raw camera stream. Our patch never fired.

### The Solution: Always Patch, Passthrough When Disabled

```typescript
// MAIN world content script — runs at document_start, always
const _getUserMedia = navigator.mediaDevices.getUserMedia.bind(
  navigator.mediaDevices
);

// Flag controlled by the extension popup/service worker
let airDrawEnabled = false;

navigator.mediaDevices.getUserMedia = async function(constraints) {
  const stream = await _getUserMedia(constraints);

  if (!constraints?.video || !airDrawEnabled) {
    // Pass through unchanged — zero impact when disabled
    return stream;
  }

  // AirDraw is enabled — composite the stream
  return createCompositedStream(stream);
};

// Listen for enable/disable messages from the extension
window.addEventListener("message", (event) => {
  if (event.data?.source === "airdraw" && event.data.type === "TOGGLE") {
    airDrawEnabled = event.data.enabled;

    if (airDrawEnabled) {
      // If the stream was already acquired, we need to re-acquire it
      // Some apps re-acquire on track replacement, others need us to
      // trigger a "device change" event
      triggerReacquisition();
    }
  }
});
```

### Triggering Re-acquisition

When the user enables AirDraw after the meeting has already started, we need the meeting app to call `getUserMedia` again so our patch can intercept it. Some tricks:

```typescript
function triggerReacquisition(): void {
  // Option 1: Dispatch a devicechange event
  // Some apps re-acquire the camera when devices change
  navigator.mediaDevices.dispatchEvent(new Event("devicechange"));

  // Option 2: Stop the current video track
  // This may cause the app to re-request the camera
  // (but it also briefly shows "camera off" to other participants)
}
```

The cleanest solution is to always intercept the stream from the beginning and switch between passthrough and composited mode dynamically by swapping the video track in the output stream.

---

## How Meeting Apps Handle Camera Streams

### Google Meet

- Calls `getUserMedia` when the user joins (or in the pre-join lobby)
- Uses WebRTC `RTCPeerConnection` to send the stream
- Re-acquires the camera when the user switches devices
- Checks camera access via `enumerateDevices()` and `devicechange` events
- Uses specific video constraints (often requests exact resolutions)

### Zoom Web Client

- Uses a more complex media pipeline, often involving Web Workers
- May use `MediaRecorder` or `ImageCapture` in addition to WebRTC
- More aggressive about checking for "unexpected" stream behavior
- May re-request camera access periodically

### Microsoft Teams

- Uses `getUserMedia` with specific constraints
- Heavy use of Web Workers for media processing
- May apply its own video effects (background blur, etc.)
- Our composited stream may interact with Teams' own effects pipeline

### Key Insight for AirDraw

Each app behaves differently. The safest approach is:

1. Patch at the lowest level (`getUserMedia` and `MediaDevices.prototype.getUserMedia`)
2. Return a `MediaStream` that behaves identically to a real camera stream
3. Do not modify audio tracks
4. Match the resolution and frame rate the app requested
5. Handle the `ended` event on the original camera track (in case the user revokes camera permission)

---

## Complete AirDraw Media Pipeline

```typescript
// patch-media.ts — MAIN world, document_start

const _getUserMedia = navigator.mediaDevices.getUserMedia.bind(
  navigator.mediaDevices
);
const _protoGUM = MediaDevices.prototype.getUserMedia;

// State
let enabled = false;
let compositeCanvas: HTMLCanvasElement | null = null;
let compositeCtx: CanvasRenderingContext2D | null = null;
let outputStream: MediaStream | null = null;

// Patch both instance and prototype
async function patchedGetUserMedia(
  this: MediaDevices,
  constraints?: MediaStreamConstraints
): Promise<MediaStream> {
  // Get the real stream
  const realStream = await _protoGUM.call(this, constraints);

  // If video is not requested or AirDraw is off, pass through
  if (!constraints?.video || !enabled) {
    return realStream;
  }

  // Get video dimensions
  const videoTrack = realStream.getVideoTracks()[0];
  const settings = videoTrack.getSettings();
  const width = settings.width ?? 1280;
  const height = settings.height ?? 720;

  // Set up compositing canvas
  compositeCanvas = document.createElement("canvas");
  compositeCanvas.width = width;
  compositeCanvas.height = height;
  compositeCtx = compositeCanvas.getContext("2d")!;

  // Create output stream
  const canvasStream = compositeCanvas.captureStream(30);
  outputStream = new MediaStream([
    canvasStream.getVideoTracks()[0],
    ...realStream.getAudioTracks(),
  ]);

  // Tell the ISOLATED world content script about the camera stream
  window.postMessage({
    source: "airdraw-main",
    type: "CAMERA_STREAM_READY",
    width,
    height,
  }, "*");

  // Start render loop — draws camera + overlay to composite canvas
  startRenderLoop(realStream);

  // If the real camera track ends, end our track too
  videoTrack.addEventListener("ended", () => {
    outputStream?.getVideoTracks()[0]?.stop();
  });

  return outputStream;
}

navigator.mediaDevices.getUserMedia = patchedGetUserMedia;
MediaDevices.prototype.getUserMedia = patchedGetUserMedia;
```

This is the foundation of AirDraw's media pipeline. The ISOLATED world content script handles MediaPipe and drawing (see other docs), and communicates the overlay canvas data to this MAIN world script via `postMessage`.
