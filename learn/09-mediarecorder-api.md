# MediaRecorder API & Video Capture

## What Is MediaRecorder?

The `MediaRecorder` API is the browser's built-in way to record media from a `MediaStream` into a file. It connects two concepts you already know from earlier docs:

- **Input:** A `MediaStream` (covered in `05-mediastream-api.md`) — the live feed from a camera, microphone, or canvas.
- **Output:** A `Blob` — an immutable chunk of binary data that represents a playable video/audio file.

```
MediaStream (live frames)
       │
       ▼
  MediaRecorder
       │
       ▼
  Blob[] chunks  ──▶  final Blob  ──▶  blob: URL  ──▶  <video src="blob:...">
```

MediaRecorder does the heavy lifting of encoding raw video frames into a compressed format (like VP8 or VP9 inside a WebM container). Without it, you would need to capture each frame as an `ImageData` bitmap, store them all in memory, and manually stitch them together — a process that is catastrophically expensive.

---

## Recording from a Live Stream vs from a Canvas

MediaRecorder accepts any `MediaStream` as input. There are two common sources:

### 1. Recording a camera stream directly

```typescript
const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
const recorder = new MediaRecorder(cameraStream);
```

This records exactly what the camera sees. The frames go straight from the camera driver into the encoder.

### 2. Recording a canvas stream

```typescript
const canvas = document.createElement('canvas');
canvas.width = 640;
canvas.height = 480;
const ctx = canvas.getContext('2d')!;

// Draw something every frame...
const canvasStream = canvas.captureStream(30); // 30 fps
const recorder = new MediaRecorder(canvasStream);
```

This records whatever is drawn on the canvas. Useful if you want to record composited output (e.g., camera + drawings + effects).

### Which does Ghost Mode use?

Ghost Mode records directly from the camera stream, not from a canvas. The reason: we want the raw camera footage with natural webcam noise and lighting. Recording from the composite canvas would include AirDraw ink, which defeats the purpose — Ghost Mode is supposed to look like an unmodified camera feed.

```typescript
// From loop-recorder.ts — extract only the video tracks
const videoTracks = stream.getVideoTracks();
const videoOnlyStream = new MediaStream(videoTracks);

// Record from the raw camera, not from any canvas
this.mediaRecorder = new MediaRecorder(videoOnlyStream, {
  mimeType,
  videoBitsPerSecond: RECORD_BITRATE,
});
```

Notice: audio tracks are deliberately excluded. Ghost Mode never records audio — the live microphone audio continues flowing through the original stream untouched. Recording audio would create echo/sync issues and serve no purpose.

---

## Codecs: VP8 vs VP9 in WebM Containers

### What is a container vs a codec?

A **container** is the file format — the box that holds the data. A **codec** is the compression algorithm that encodes/decodes the actual video frames inside that box.

```
WebM container
├── Video track (compressed with VP8 or VP9 codec)
└── Audio track (compressed with Opus or Vorbis codec)  ← Ghost Mode omits this
```

### WebM: The browser's native video format

WebM is essentially the only container that `MediaRecorder` reliably supports across browsers. It is an open format based on the Matroska container. MP4 recording is available in some browsers (Safari, newer Chrome) but is not universally supported.

### VP8 vs VP9

| Property | VP8 | VP9 |
|---|---|---|
| Quality at same bitrate | Good | Better (30-50% more efficient) |
| Encoding CPU cost | Low | Higher |
| Browser support | Universal | Very wide (Chrome, Firefox, Edge) |
| Year introduced | 2010 | 2013 |

VP9 produces smaller files at the same visual quality, or better quality at the same file size. But it uses more CPU during encoding. For Ghost Mode's 5.5-second clip at 1.5 Mbps, the difference is negligible — either codec works fine.

### How Ghost Mode picks a codec

```typescript
private pickMimeType(): string {
  const candidates = [
    'video/webm; codecs=vp9',   // Prefer VP9 if available
    'video/webm; codecs=vp8',   // Fall back to VP8
    'video/webm',               // Let browser decide
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return 'video/webm';
}
```

`MediaRecorder.isTypeSupported()` is a static method that checks whether the browser can encode the given MIME type. This avoids runtime errors from requesting an unsupported codec.

### What is actually inside the file?

A WebM file produced by MediaRecorder contains:

1. **EBML header** — declares this is a WebM/Matroska file
2. **Segment info** — duration, timecode scale, muxing app name
3. **Track entries** — codec ID (V_VP8 or V_VP9), resolution, frame rate
4. **Clusters** — groups of encoded video frames (keyframes + delta frames)

You never need to parse this manually. The browser handles it when you feed the blob back into a `<video>` element.

---

## Bitrate Control

### videoBitsPerSecond

The `videoBitsPerSecond` option tells the encoder roughly how many bits per second to target. It is not a hard limit — it is a hint to the encoder's rate controller.

```typescript
const recorder = new MediaRecorder(stream, {
  mimeType: 'video/webm; codecs=vp9',
  videoBitsPerSecond: 1_500_000,  // 1.5 Mbps
});
```

### How bitrate affects file size

```
Bitrate × Duration = File size (approximately)

1.5 Mbps × 5.5 sec = 8.25 Megabits = ~1.03 MB
500 Kbps × 5.5 sec = 2.75 Megabits = ~344 KB
3.0 Mbps × 5.5 sec = 16.5 Megabits = ~2.06 MB
```

### Why lower bitrate helps Ghost Mode

Ghost Mode benefits from a deliberately moderate bitrate (1.5 Mbps) for two reasons:

**1. Compression artifacts look more natural.** A low-bitrate webcam feed has subtle blockiness, color banding, and slight blurriness — exactly what people expect from a video call. A pristine, high-bitrate recording would look suspiciously good compared to the live feeds of other participants. The artifacts make the loop blend in.

**2. Smaller blob = less memory pressure.** A 1 MB blob sitting in RAM is inconsequential. A 10 MB blob would still be fine, but there is no reason to waste memory on quality that actively hurts the illusion.

**3. Faster encoding.** Lower bitrate means the encoder can work with a larger quantization parameter, which means less CPU work per frame. This matters because encoding happens in real-time on the main thread.

### The bitrate sweet spot

```
Too low  (200 Kbps):  Visible macro-blocking, faces become blurry mush
Sweet    (1-2 Mbps):  Looks like a typical webcam feed
Too high (5+ Mbps):   Suspiciously sharp, wastes memory, no benefit
```

Ghost Mode uses 1.5 Mbps — right in the sweet spot for 640x480 webcam footage.

---

## Blob Creation from Chunks

MediaRecorder does not produce the final file all at once. It streams data in chunks via the `ondataavailable` event. You collect these chunks and assemble them when recording stops.

### The chunk collection pattern

```typescript
const chunks: Blob[] = [];

recorder.ondataavailable = (event: BlobEvent) => {
  if (event.data.size > 0) {
    chunks.push(event.data);
  }
};

recorder.onstop = () => {
  // Combine all chunks into a single Blob
  const finalBlob = new Blob(chunks, { type: 'video/webm' });
  console.log(`Recording complete: ${finalBlob.size} bytes`);
};
```

### When does ondataavailable fire?

It depends on how you call `start()`:

```typescript
// Option 1: Collect all data at the end
recorder.start();
// ondataavailable fires once, when stop() is called

// Option 2: Collect data every N milliseconds
recorder.start(500);  // ondataavailable fires every ~500ms AND when stop() is called
```

Ghost Mode uses `start(500)` — requesting data every 500ms. This has two benefits:

1. **Smoother memory usage.** Instead of buffering the entire recording in the encoder's internal memory and dumping it all at once, data trickles out in ~90KB chunks.
2. **Faster finalization.** When `onstop` fires, there is less data left to flush, so the final blob is assembled faster.

### Why Blob and not ArrayBuffer?

A `Blob` is the browser's abstraction for immutable binary data. Unlike an `ArrayBuffer`, a `Blob` can be backed by data that lives on disk (if memory pressure is high) rather than always in RAM. The browser manages this transparently. For our use case — creating a URL to feed into a `<video>` element — `Blob` is the correct abstraction. We never need to read or modify the raw bytes.

---

## Object URLs: createObjectURL and revokeObjectURL

Once you have a `Blob`, you need a way to reference it from HTML elements. Enter Object URLs.

### Creating an Object URL

```typescript
const blob = new Blob(chunks, { type: 'video/webm' });
const blobUrl = URL.createObjectURL(blob);

console.log(blobUrl);
// "blob:https://meet.google.com/3a4b5c6d-7e8f-9a0b-1c2d-3e4f5a6b7c8d"
```

This creates a `blob:` URI that acts as a local reference to the in-memory data. The browser essentially acts as a tiny file server — when a `<video>` element requests `blob:...`, the browser serves the Blob data directly from memory.

### Using in a video element

```typescript
const video = document.createElement('video');
video.src = blobUrl;
video.muted = true;
video.loop = true;
video.play();
```

### Revoking to free memory

```typescript
URL.revokeObjectURL(blobUrl);
```

After revocation:
- The URL string becomes invalid — any element using it will fail to load
- The underlying `Blob` becomes eligible for garbage collection (assuming no other JavaScript references to it)
- Existing elements that already loaded the data continue playing — revocation only prevents new loads

**Critical rule:** Always revoke when you are done. If you forget, the Blob stays in memory for the lifetime of the page. Ghost Mode revokes in its `destroy()` method and before re-recording:

```typescript
destroy(): void {
  if (this.currentBlobUrl) {
    URL.revokeObjectURL(this.currentBlobUrl);
    this.currentBlobUrl = null;
  }
  // ... cleanup MediaRecorder
}
```

---

## Why MediaRecorder Instead of Frame-by-Frame Capture

An alternative approach to recording video would be to capture each frame individually:

```typescript
// THE BAD APPROACH — do not do this
const frames: ImageData[] = [];

function captureFrame() {
  ctx.drawImage(video, 0, 0);
  const imageData = ctx.getImageData(0, 0, 640, 480);
  frames.push(imageData);
  requestAnimationFrame(captureFrame);
}
```

### The math on why this is terrible

Each `ImageData` for a 640x480 frame contains raw RGBA pixels:

```
640 × 480 × 4 bytes (RGBA) = 1,228,800 bytes ≈ 1.2 MB per frame
```

At 30 fps for 5.5 seconds:

```
30 fps × 5.5 sec = 165 frames
165 frames × 1.2 MB = 198 MB of RAM
```

Nearly 200 MB of uncompressed bitmaps sitting in JavaScript heap memory. That will cause garbage collection pauses, potential tab crashes on low-memory devices, and the user's fan spinning up.

### MediaRecorder comparison

The same 5.5 seconds recorded by MediaRecorder at 1.5 Mbps:

```
1.5 Mbps × 5.5 sec = 8.25 Megabits ≈ 1.03 MB
```

That is a **192x reduction** in memory usage. The encoder does all the work in native code, producing a compact compressed stream. The JavaScript side only sees the final blob.

### Could you use ImageCapture API instead?

The `ImageCapture` API (`track.grabFrame()`) lets you grab individual frames as `ImageBitmap` objects. This is slightly better than `getImageData()` because `ImageBitmap` can live in GPU memory, but you still face the fundamental problem: you have N uncompressed frames and no encoder. You would need a JavaScript-based video encoder (like `ffmpeg.wasm`), which is a 25 MB download and CPU-intensive.

MediaRecorder is the right tool. It uses the browser's hardware-accelerated encoder, produces a standard playable file, and requires minimal JavaScript.

---

## How Ghost Mode Uses MediaRecorder

Putting it all together — here is the complete flow in AirDraw's Ghost Mode:

### Step 1: Extract video tracks from the live camera stream

```typescript
const stream = realVideo.srcObject as MediaStream;
const videoTracks = stream.getVideoTracks();
const videoOnlyStream = new MediaStream(videoTracks);
```

Audio is excluded. The live microphone continues independently.

### Step 2: Create MediaRecorder with codec and bitrate

```typescript
const mimeType = this.pickMimeType(); // VP9 > VP8 > default
this.mediaRecorder = new MediaRecorder(videoOnlyStream, {
  mimeType,
  videoBitsPerSecond: 1_500_000,
});
```

### Step 3: Collect chunks during recording

```typescript
this.chunks = [];
this.mediaRecorder.ondataavailable = (e: BlobEvent) => {
  if (e.data.size > 0) {
    this.chunks.push(e.data);
  }
};
```

### Step 4: Start recording, stop after 5.5 seconds

```typescript
this.mediaRecorder.start(500); // Request data every 500ms

setTimeout(() => {
  if (this.mediaRecorder?.state === 'recording') {
    this.mediaRecorder.stop();
  }
}, 5500);
```

### Step 5: Assemble final blob and create URL

```typescript
this.mediaRecorder.onstop = () => {
  const blob = new Blob(this.chunks, { type: mimeType || 'video/webm' });
  this.currentBlobUrl = URL.createObjectURL(blob);

  resolve({
    blobUrl: this.currentBlobUrl,
    durationMs: 5500,
    width,
    height,
  });
};
```

### Step 6: Feed blob URL to a hidden looping video element

```typescript
const loopVideo = document.createElement('video');
loopVideo.src = blobUrl;     // The blob: URL from step 5
loopVideo.muted = true;      // Audio stays live, never from recording
loopVideo.playsInline = true;
loopVideo.style.display = 'none';
// ... wait for loadedmetadata, then play()
```

The compositing loop then calls `ctx.drawImage(loopVideo, 0, 0, w, h)` every frame to draw the looping clip onto the composite canvas. Other participants see what appears to be a live camera feed — but it is a seamlessly looping 5.5-second recording.

---

## MediaRecorder State Machine

MediaRecorder has three states, and transitions between them are strictly ordered:

```
           start()           stop()
inactive ─────────▶ recording ────────▶ inactive
                       │
                       │ pause()
                       ▼
                     paused
                       │
                       │ resume()
                       ▼
                    recording
```

### Checking state before operations

```typescript
// Always check state before calling stop()
if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
  this.mediaRecorder.stop();
}

// Calling stop() on an inactive recorder throws an InvalidStateError
// Calling start() on a recording recorder throws an InvalidStateError
```

Ghost Mode checks `state === 'recording'` before stopping, and calls `destroy()` before starting a new recording to ensure the previous recorder is fully cleaned up.

---

## Error Handling

MediaRecorder can fail in several ways:

### Construction failure

```typescript
try {
  this.mediaRecorder = new MediaRecorder(videoOnlyStream, {
    mimeType: 'video/webm; codecs=vp9',
    videoBitsPerSecond: RECORD_BITRATE,
  });
} catch (e) {
  // VP9 not supported — fall back to browser default
  this.mediaRecorder = new MediaRecorder(videoOnlyStream, {
    videoBitsPerSecond: RECORD_BITRATE,
  });
}
```

### Runtime errors

```typescript
this.mediaRecorder.onerror = (event) => {
  // The EncodedAudioChunk/EncodedVideoChunk could not be encoded
  // This is rare but can happen if the camera disconnects mid-recording
  reject(new Error(`MediaRecorder error: ${event}`));
};
```

### Track ended during recording

If the camera is disconnected or permissions are revoked while recording, the `MediaStreamTrack` fires an `ended` event. MediaRecorder will stop automatically and fire `onstop`, but the resulting blob may be truncated. Ghost Mode handles this gracefully — a truncated clip simply loops over a shorter duration.

---

## Browser Compatibility Notes

| Feature | Chrome | Firefox | Safari | Edge |
|---|---|---|---|---|
| MediaRecorder (basic) | 49+ | 25+ | 14.1+ | 79+ |
| VP8 in WebM | Yes | Yes | No | Yes |
| VP9 in WebM | Yes | Yes | No | Yes |
| `isTypeSupported()` | Yes | Yes | Yes | Yes |
| `videoBitsPerSecond` | Yes | Yes | Partial | Yes |

Safari is the outlier — it supports MediaRecorder but only with MP4/H.264, not WebM. Ghost Mode currently targets Chrome (it is a Chrome extension), so WebM/VP8/VP9 is the reliable choice.
