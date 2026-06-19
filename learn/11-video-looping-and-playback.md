# HTMLVideoElement: Looping, Seeking & Frame-Accurate Playback

## HTMLVideoElement API Basics

The `<video>` element is the browser's built-in video player. For Ghost Mode, we do not display it to the user — we use it as an off-screen frame source, drawing its current frame onto a canvas every animation tick.

### Core properties

```typescript
const video = document.createElement('video');

// Source — where the video data comes from
video.src = 'blob:https://meet.google.com/abc123...';  // URL (including blob: URLs)
video.srcObject = mediaStream;                          // OR a live MediaStream

// Playback control
video.currentTime;     // Current playback position in seconds (read/write)
video.duration;        // Total duration in seconds (read-only, NaN until loaded)
video.paused;          // Whether the video is paused (read-only)
video.ended;           // Whether playback has reached the end (read-only)
video.playbackRate;    // Speed multiplier (1.0 = normal, 0.5 = half speed)

// State
video.readyState;      // How much data is loaded (0-4, see below)
video.networkState;    // Network activity status (0-3)

// Configuration
video.loop = true;     // Auto-restart when reaching the end
video.muted = true;    // Suppress audio output
video.autoplay = true; // Start playing when enough data is loaded
video.playsInline = true;  // Prevent fullscreen on mobile
```

### Core methods

```typescript
// Start playback — returns a Promise
const playPromise = video.play();
playPromise.catch(e => {
  // Play can fail if:
  // - User has not interacted with the page (autoplay policy)
  // - Source is invalid or not loaded
  // - Element was removed from the DOM
  console.error('Play failed:', e);
});

// Pause playback
video.pause();

// Force reload from source
video.load();
```

---

## src vs srcObject

These two properties serve the same purpose — telling the video element where to get its data — but they accept different types of input and have fundamentally different behavior.

### src: A URL pointing to a file

```typescript
video.src = 'https://example.com/video.webm';   // Remote file
video.src = 'blob:https://meet.google.com/abc';  // In-memory blob
video.src = 'data:video/webm;base64,...';         // Inline data (terrible idea)
```

When you set `src`, the browser treats the video as a **file**. It can:
- Seek to any position (`currentTime = 3.5`)
- Report total `duration`
- Support the `loop` attribute (knows where the end is)
- Buffer and cache frames

### srcObject: A live MediaStream

```typescript
const stream = await navigator.mediaDevices.getUserMedia({ video: true });
video.srcObject = stream;
```

When you set `srcObject` to a `MediaStream`, the browser treats the video as a **live feed**. Key differences:
- `duration` is `Infinity` — there is no end
- `currentTime` advances but seeking backward is impossible
- The `loop` attribute is meaningless — there is no "end" to loop from
- No buffering — frames arrive in real-time and are discarded after display

### Which does Ghost Mode use?

Both, for different purposes:

| Element | Source | Why |
|---|---|---|
| `videoElement` (live camera) | `srcObject = cameraStream` | Live feed from camera, drawn to canvas when Ghost is OFF |
| `loopVideo` (ghost playback) | `src = blobUrl` | Recorded clip, seekable and loopable, drawn to canvas when Ghost is ON |

```typescript
// The live camera — uses srcObject for real-time feed
videoElement.srcObject = cameraStream;

// The ghost loop — uses src with a blob URL for seekable playback
ghostLoopPlayer.loopVideo.src = blobUrl;
```

This distinction is critical. If Ghost Mode tried to use `srcObject` with a recorded stream, it could not loop — there would be no way to seek back to the beginning.

---

## readyState: Is the Video Ready to Draw?

The `readyState` property tells you how much of the video is loaded and available for playback. It has five values:

```
Value  Constant              Meaning
─────  ────────────────────  ──────────────────────────────────────────
0      HAVE_NOTHING          No data loaded. Duration unknown.
1      HAVE_METADATA         Duration and dimensions are known, but no
                             frame data is available for display.
2      HAVE_CURRENT_DATA     The current frame is available, but there
                             may not be enough data to advance.
3      HAVE_FUTURE_DATA      Enough data to render the current frame and
                             at least one more frame.
4      HAVE_ENOUGH_DATA      Enough data to play at the current rate
                             without buffering.
```

### Why Ghost Mode checks readyState >= 2

```typescript
// From the compositing loop:
if (!compositeCtx || !videoElement || videoElement.readyState < 2) return;

// From ghostLoopPlayer.isReady():
isReady: function () {
  return this.ready && this.loopVideo && this.loopVideo.readyState >= 2;
}

// From ghostLoopPlayer.drawFrame():
drawFrame: function (ctx, w, h) {
  if (!this.loopVideo || this.loopVideo.readyState < 2) return;
  // ...
}
```

The check `readyState >= 2` means "at least the current frame is available." If you call `ctx.drawImage(video, ...)` when `readyState < 2`, you will either:
- Draw a blank/black frame (readyState 0 or 1)
- Trigger a browser error in some implementations

The `>= 2` threshold is conservative but safe. It ensures there is always a valid frame to draw.

### readyState transitions

```
load() called
    │
    ▼
HAVE_NOTHING (0)
    │  ← metadata arrives (dimensions, duration, codec info)
    ▼
HAVE_METADATA (1)
    │  ← first frame decoded
    ▼
HAVE_CURRENT_DATA (2)  ← Ghost Mode: OK to draw
    │  ← more frames buffered
    ▼
HAVE_FUTURE_DATA (3)
    │  ← enough frames for sustained playback
    ▼
HAVE_ENOUGH_DATA (4)
```

For a blob URL (local data, no network), the transition from 0 to 4 is nearly instant. For a live `srcObject`, the state jumps directly to 4 once the first frame arrives from the camera.

---

## Playing from Blob URLs vs MediaStreams

### Blob URL playback model

```typescript
video.src = blobUrl;
```

The video element treats this as a file. Internally:

1. Browser resolves the `blob:` URL to the in-memory Blob
2. Parses the WebM container header (EBML, segment info, track entries)
3. Builds a seek index from the cluster positions
4. Decodes frames on demand as `currentTime` advances
5. Reports accurate `duration` from the container metadata

This gives you full random access: you can set `currentTime` to any point, and the browser will find the nearest keyframe, decode forward to the requested time, and display that frame.

### MediaStream playback model

```typescript
video.srcObject = mediaStream;
```

The video element treats this as a live feed:

1. Browser connects to the MediaStream's video track
2. Frames arrive as they are produced (by camera, canvas, etc.)
3. Each frame is displayed immediately, then discarded
4. No seek index, no buffering, no random access

You cannot go back in time. `currentTime` is read-only in practice (writing to it has no effect on a live stream).

### Why Ghost Mode needs the blob URL model

Ghost Mode loops a 5.5-second clip indefinitely. This requires:
- Seeking back to the loop start point when the end is reached
- Knowing the duration to calculate the loop boundary
- Random access for the "catch-up jump" artifact (seeking forward to simulate stream instability)

None of these are possible with a live MediaStream. The blob URL model is the only option.

---

## The loop Attribute vs Manual Looping

### The built-in loop attribute

```typescript
video.loop = true;
// When the video reaches the end, it automatically restarts from the beginning
```

This works for simple cases. The browser handles the transition internally, and for short clips it is nearly seamless.

### Why Ghost Mode does NOT use the loop attribute

Ghost Mode needs more control than `loop = true` provides:

**1. Trimmed loop boundaries.** The recording is 5.5 seconds, but Ghost Mode loops from 0.25s to 5.25s (trimming the first and last 0.25s). The `loop` attribute always loops from 0 to `duration` — you cannot set custom loop points.

```typescript
// Ghost Mode's loop boundaries:
self.loopStartSec = 0.25;
self.loopEndSec = result.durationMs / 1000 - 0.25;

// The first 0.25s is trimmed because MediaRecorder often produces
// a slightly corrupted or black first frame. The last 0.25s is
// trimmed for the same reason — the stop() call can truncate
// the final frame.
```

**2. Artifact injection at the loop seam.** Ghost Mode intentionally introduces visual artifacts near the loop point (freeze frames, quality drops, alpha blending) to disguise the fact that the video is looping. The `loop` attribute gives no hook for this — it just jumps.

**3. Cross-fade control.** Near the loop seam, Ghost Mode draws the frame with reduced alpha to create a subtle blend, making the loop restart less obvious:

```typescript
// From GhostArtifacts.decide():
var loopSec = this.loopDurationMs / 1000;
var distFromSeam = Math.min(videoCurrentTime, Math.abs(loopSec - videoCurrentTime));
if (distFromSeam < 0.3) {
  // Within 0.3 seconds of the loop point
  if (Math.random() < 0.4 * scale) {
    // Trigger a freeze burst to mask the seam
    d.freeze = true;
    return d;
  }
  // Subtle alpha reduction
  d.alpha = 0.92 + Math.random() * 0.08;
}
```

### Ghost Mode's manual loop implementation

```typescript
drawFrame: function (ctx, w, h) {
  if (!this.loopVideo || this.loopVideo.readyState < 2) return;

  // Manual loop: check if we have reached the end boundary
  if (this.loopVideo.currentTime >= this.loopEndSec) {
    this.loopVideo.currentTime = this.loopStartSec;
  }

  // Get artifact decisions for this frame
  var relTime = this.loopVideo.currentTime - this.loopStartSec;
  var d = GhostArtifacts.decide(relTime);

  // Apply artifacts...
  // Draw the frame...
}
```

The loop check runs every frame (every ~33ms). When `currentTime` passes `loopEndSec`, it is reset to `loopStartSec`. The video element handles this seek instantly because the data is local (blob URL) and the clip is short enough to be fully buffered.

---

## Seeking with currentTime

Assigning to `currentTime` forces the video to jump to a specific position. The browser finds the nearest keyframe at or before the requested time, decodes forward to the exact requested frame, and displays it.

### Basic seeking

```typescript
video.currentTime = 2.5; // Jump to 2.5 seconds
```

### How seeking works internally

WebM files contain keyframes (I-frames) at regular intervals, typically every 1-2 seconds. To seek to a non-keyframe position:

```
Keyframes:  [0.0s] --------- [1.0s] --------- [2.0s] --------- [3.0s]
                                                  ↑
                                          Requested: 2.5s

1. Find nearest keyframe at or before 2.5s → keyframe at 2.0s
2. Decode frames from 2.0s forward: 2.0, 2.033, 2.066, ... 2.5
3. Display the frame at 2.5s
```

For Ghost Mode's short 5.5-second clip with ~2 keyframes per second, seeking is nearly instant — the browser never needs to decode more than about 15 frames to reach any position.

### Seeking in Ghost Mode: catch-up jumps

Ghost Mode uses seeking to simulate the "catch-up" artifact common in degraded video streams. When a real video call has a network hiccup, the player sometimes jumps forward to catch up with the live stream. Ghost Mode fakes this:

```typescript
// From ghostLoopPlayer.drawFrame():
if (d.catchUpJump > 0) {
  this.loopVideo.currentTime = Math.min(
    this.loopVideo.currentTime + d.catchUpJump,
    this.loopEndSec - 0.1
  );
}
```

`catchUpJump` is a value (typically 0.1-0.5 seconds) determined by the artifact engine. When triggered, it makes the video skip forward, creating a visible temporal discontinuity that looks like a stream recovering from a stall.

The `Math.min` guard prevents seeking past the loop boundary, which would cause the loop logic to immediately reset to the start — creating a double-jump artifact that looks unnatural.

### The seeking event

When you assign to `currentTime`, the browser fires a `seeking` event, followed by a `seeked` event when the frame is ready:

```typescript
video.addEventListener('seeking', () => {
  console.log('Seek started');
});

video.addEventListener('seeked', () => {
  console.log('Seek complete, frame ready at', video.currentTime);
});
```

Ghost Mode does not listen for these events. The seek is fast enough (sub-frame for a local blob) that by the next `drawFrame` call 33ms later, the new frame is always ready.

---

## Crossfade at the Loop Seam

The most perceptible moment in a looping video is the seam — the point where the clip restarts. If the last frame and the first frame are visually different (different facial expression, head position, lighting), the jump is obvious.

### Ghost Mode's crossfade strategy

Rather than blending two frames (which would require two video elements or a pre-rendered crossfade), Ghost Mode uses a simpler approach: it reduces the alpha of frames near the seam and randomly injects freeze frames to mask the transition.

```typescript
// Near the seam (within 0.3 seconds):
var distFromSeam = Math.min(videoCurrentTime, Math.abs(loopSec - videoCurrentTime));
if (distFromSeam < 0.3) {
  // 40% chance of a freeze burst (scaled by intensity)
  if (Math.random() < 0.4 * scale) {
    this.inFreezeBurst = true;
    this.freezeFramesRemaining = 3 + Math.floor(Math.random() * 5);
    d.freeze = true;
    return d;
  }
  // Otherwise, slightly reduce alpha
  d.alpha = 0.92 + Math.random() * 0.08;
}
```

The alpha reduction works because the previous frame is still on the canvas. Drawing the new frame at 92-100% alpha creates a subtle blend with whatever was there before:

```typescript
// Drawing with alpha in drawFrame():
if (d.alpha < 1.0) {
  var prev = ctx.globalAlpha;
  ctx.globalAlpha = d.alpha;
  ctx.drawImage(this.loopVideo, 0, 0, w, h);
  ctx.globalAlpha = prev;
} else {
  ctx.drawImage(this.loopVideo, 0, 0, w, h);
}
```

When `globalAlpha = 0.95`, the new frame is drawn at 95% opacity over the old frame, creating a 5% ghost of the previous frame. This is subtle enough to be imperceptible but smooths out small differences between the loop's end and start.

### The freeze burst mask

The most effective seam masking is the freeze burst. When triggered, `drawFrame` simply returns without drawing a new frame for 3-8 consecutive frames (~100-260ms):

```typescript
if (d.freeze) return;
// Nothing is drawn. The canvas retains the last frame.
// The video continues playing underneath, but we skip the visual update.
// When the freeze ends, we resume drawing — now well past the seam.
```

This looks like a brief video freeze (common in real calls), and when playback resumes, we are already 100-260ms past the loop seam — the transition is completely hidden.

---

## requestAnimationFrame for Frame-Accurate Playback

Ghost Mode does not let the `<video>` element render itself to the screen. Instead, it uses a compositing loop that draws the video's current frame onto a canvas every tick:

```typescript
function loop() {
  compositeFrameId = requestAnimationFrame(loop);
  if (!compositeCtx || !videoElement || videoElement.readyState < 2) return;

  if (ghostActive && ghostLoopPlayer && ghostLoopPlayer.isReady()) {
    ghostLoopPlayer.drawFrame(compositeCtx, compositeCanvas.width, compositeCanvas.height);
  } else {
    compositeCtx.drawImage(videoElement, 0, 0, compositeCanvas.width, compositeCanvas.height);
  }
}
```

### Why drawImage(video, ...) works

`CanvasRenderingContext2D.drawImage()` accepts a `<video>` element as a source. It grabs the video's **current displayed frame** — whatever frame corresponds to the current `currentTime` — and draws it onto the canvas. This is how you turn a video into individual frames for compositing.

```typescript
// This captures exactly one frame from the video
ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
// The canvas now contains a static image of that frame
// On the next rAF tick, the video has advanced ~33ms, so we get the next frame
```

### requestAnimationFrame timing

`requestAnimationFrame` fires once per display refresh cycle — typically 60 times per second on a 60Hz display. For a 30fps webcam recording:

```
Display:  |  16ms  |  16ms  |  16ms  |  16ms  |  16ms  |  16ms  |
rAF:      1        2        3        4        5        6
Video:    frame1        frame1        frame2        frame2
                    ↑                            ↑
                    duplicate                    duplicate
```

Every other rAF callback draws the same video frame (the video only has 30 frames per second, but rAF fires 60 times). This is fine — `drawImage` is idempotent, and drawing the same frame twice has no visible effect.

---

## setTimeout Fallback for Background Tabs

### The problem: rAF throttles in background tabs

When a browser tab is not visible (the user has switched to another tab), `requestAnimationFrame` is severely throttled:

```
Foreground tab:  rAF fires every ~16ms  (60 fps)
Background tab:  rAF fires every ~1000ms (1 fps) or not at all
```

This is a deliberate browser optimization to save CPU and battery. But for Ghost Mode, it is catastrophic — the compositing loop needs to keep running because the output canvas is being captured by `captureStream()` and sent to other participants via WebRTC.

If the compositing loop drops to 1 fps, the other meeting participants see the Ghost Mode feed freeze and stutter. The user's "absence" becomes obvious.

### The solution: setTimeout when Ghost Mode is active

```typescript
function loop() {
  // Use setTimeout fallback during ghost mode (rAF throttles in background tabs)
  if (ghostActive) {
    compositeFrameId = setTimeout(loop, 33); // ~30fps
  } else {
    compositeFrameId = requestAnimationFrame(loop);
  }

  if (!compositeCtx || !videoElement || videoElement.readyState < 2) return;

  if (ghostActive && ghostLoopPlayer && ghostLoopPlayer.isReady()) {
    ghostLoopPlayer.drawFrame(compositeCtx, compositeCanvas.width, compositeCanvas.height);
  } else {
    compositeCtx.drawImage(videoElement, 0, 0, compositeCanvas.width, compositeCanvas.height);
  }
}
```

`setTimeout` is also throttled in background tabs, but much less aggressively:

```
Foreground:  setTimeout(fn, 33) fires in ~33ms   (actual ~30 fps)
Background:  setTimeout(fn, 33) fires in ~1000ms (actual ~1 fps)
```

Wait — that is still throttled. So why use it?

### Why setTimeout still works better than rAF in practice

The behavior depends on the browser and the Chrome version:

1. **Chrome (current):** `setTimeout` in background tabs is throttled to a minimum of 1 second, BUT there is an exception for pages that have an active `MediaStream` or WebRTC connection. Since Ghost Mode runs on a page that is actively in a video call (WebRTC), Chrome keeps `setTimeout` running at near-normal rates.

2. **The fallback is still better.** Even in the worst case (1 fps), `setTimeout` continues to fire, while `rAF` may stop entirely. A 1 fps update is better than a completely frozen frame.

3. **Ghost Mode's primary use case.** The user activates Ghost Mode and then switches to another tab (or window) to do other work. The meeting tab goes to the background, but the video call's WebRTC connection keeps the timer running.

### Why not always use setTimeout?

When Ghost Mode is NOT active, the compositing loop uses `requestAnimationFrame` for good reasons:

| Property | requestAnimationFrame | setTimeout(fn, 33) |
|---|---|---|
| Synced to display refresh | Yes | No |
| Stops when tab hidden | Yes (saves CPU) | No (wastes CPU) |
| Frame timing accuracy | Sub-millisecond | ~4ms minimum granularity |
| Throttled by browser | Intelligent throttling | Coarse throttling |

When the user is actively looking at the tab and drawing with AirDraw, `rAF` gives smoother visuals and better CPU usage. When the user has switched away and Ghost Mode is running, `setTimeout` ensures the feed keeps updating.

---

## The muted Property

### Why muted is mandatory for Ghost Mode

```typescript
self.loopVideo = document.createElement('video');
self.loopVideo.muted = true;  // CRITICAL
```

Three reasons:

**1. Audio stays live.** In a video call, the other participants hear your live microphone audio through the original `MediaStream`. If the loop video had audio, it would be recorded audio from 5.5 seconds ago — an echo of what you said before activating Ghost Mode. This would be immediately suspicious.

**2. Autoplay policy.** Browsers block autoplay of videos with audio unless the user has interacted with the page. While the user has likely interacted with the meeting page (clicking "Join"), it is not guaranteed. Muted videos can always autoplay without user interaction.

**3. We did not record audio.** Ghost Mode only records the video track (see `09-mediarecorder-api.md`). The loop video has no audio track. Setting `muted = true` is belt-and-suspenders — even if an audio track somehow existed, it would not play.

```typescript
// From LoopRecorder — only video tracks are recorded:
const videoTracks = stream.getVideoTracks();
const videoOnlyStream = new MediaStream(videoTracks);
// No getAudioTracks() — audio is deliberately excluded
```

---

## Video Element Events

The `<video>` element fires many events. Here are the ones relevant to Ghost Mode:

### loadedmetadata

Fires when the browser has parsed enough of the file to know the duration, dimensions, and codec. This is the earliest point at which you can set `currentTime`.

```typescript
video.onloadedmetadata = function () {
  console.log(`Duration: ${video.duration}s`);
  console.log(`Dimensions: ${video.videoWidth}x${video.videoHeight}`);

  // Now safe to seek
  video.currentTime = 0.25;  // Jump past the first 0.25s
};
```

Ghost Mode waits for `loadedmetadata` before starting playback:

```typescript
self.loopVideo.onloadedmetadata = function () {
  self.loopVideo.currentTime = self.loopStartSec;  // 0.25s
  self.loopVideo.play().then(function () {
    self.ready = true;
    resolve();
  }).catch(reject);
};
```

### error

Fires if the video cannot be loaded or decoded.

```typescript
video.onerror = function () {
  console.error('Video error:', video.error?.message);
  // video.error is a MediaError object with a code:
  // 1 = MEDIA_ERR_ABORTED (user/script aborted)
  // 2 = MEDIA_ERR_NETWORK (network error — irrelevant for blob URLs)
  // 3 = MEDIA_ERR_DECODE (corrupt data or unsupported codec)
  // 4 = MEDIA_ERR_SRC_NOT_SUPPORTED (format not supported)
};
```

For Ghost Mode, errors 3 and 4 are the most likely — a corrupted recording or a codec mismatch. The error handler in Ghost Mode rejects the preparation promise, which causes the ghost state to reset to 'idle'.

### ended

Fires when playback reaches the end. Ghost Mode does NOT rely on this event because it uses manual looping (checking `currentTime` every frame). The `loop` attribute is set to `false`, and the manual loop resets `currentTime` before the video ever reaches the true end.

### timeupdate

Fires periodically (roughly every 250ms) as playback progresses. Ghost Mode does not use this — it checks `currentTime` directly in its compositing loop, which runs every 33ms and provides much finer granularity.

---

## Putting It All Together: Ghost Mode's Video Playback Pipeline

```
User clicks "Record Ghost"
         │
         ▼
LoopRecorder records 5.5s from camera
         │
         ▼
Blob created, Object URL generated
         │
         ▼
ghostLoopPlayer.prepare()
         │
         ├── Creates <video> element (hidden, muted)
         ├── Sets src = blobUrl
         ├── Waits for loadedmetadata
         ├── Sets currentTime = 0.25 (skip first 0.25s)
         └── Calls play() → ready = true
         │
         ▼
User clicks "Activate Ghost"
         │
         ▼
ghostActive = true
         │
         ▼
Compositing loop switches from setTimeout to rAF-or-setTimeout
         │
         ▼
Every 33ms (compositing loop):
         │
         ├── Check: loopVideo.readyState >= 2?
         │     No → skip frame (retain previous)
         │     Yes ↓
         │
         ├── Check: currentTime >= loopEndSec (5.25s)?
         │     Yes → currentTime = loopStartSec (0.25s)  [manual loop]
         │     No  ↓
         │
         ├── GhostArtifacts.decide(relativeTime)
         │     Returns: { freeze, alpha, catchUpJump, qualityDrop }
         │
         ├── If catchUpJump > 0:
         │     currentTime += catchUpJump  [simulated stream catch-up]
         │
         ├── If freeze:
         │     return  [keep previous frame on canvas]
         │
         ├── If qualityDrop:
         │     Draw to half-size offscreen canvas, then upscale back
         │     (simulates bitrate reduction)
         │
         └── Draw frame to composite canvas:
               ctx.globalAlpha = d.alpha (usually 1.0, reduced near seam)
               ctx.drawImage(loopVideo, 0, 0, w, h)
               ctx.globalAlpha = 1.0
         │
         ▼
captureStream(30) sends composite canvas frames to WebRTC
         │
         ▼
Other meeting participants see a "live" camera feed
that is actually a seamlessly looping 5-second clip
```

### The key insight

The `<video>` element does all the heavy lifting: decoding the WebM file, managing the frame buffer, handling seeks, keeping the playback clock accurate. Ghost Mode's code just reads frames from it (via `drawImage`) and adds artifacts. The video element is invisible — it exists only as a frame source for the compositing canvas.

This architecture — hidden video element as frame source, canvas as compositing surface, `captureStream` as output — is the same pattern used by professional video processing libraries (e.g., WebGL-based video effects). Ghost Mode applies it to a specific purpose: making a looping pre-recorded clip look like a live camera feed.
