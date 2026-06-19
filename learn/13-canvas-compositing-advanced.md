# Advanced Canvas Compositing: Source Switching & Effects

## Building on the Fundamentals

This document builds on [03-canvas-api-compositing.md](./03-canvas-api-compositing.md), which covered the basics: `drawImage()`, `globalCompositeOperation`, `captureStream()`, the render loop. Those fundamentals power AirDraw's core pipeline --- camera frame + ink overlay composited onto a canvas, fed to the meeting app as a MediaStream.

Ghost Mode reuses the exact same pipeline. It does not create a new canvas or a new stream. It changes *what gets drawn* onto the existing composite canvas. This is the key architectural insight: the compositing loop is a single point of control. By changing the source of `drawImage()`, we can switch between live camera and pre-recorded loop without the downstream meeting app knowing anything changed.

---

## Source Switching

### The Core Idea

AirDraw's compositing loop currently does this:

```javascript
function renderFrame() {
  compositeCtx.drawImage(videoElement, 0, 0, w, h);  // Camera feed
  compositeCtx.drawImage(drawingCanvas, 0, 0);        // Ink overlay
  requestAnimationFrame(renderFrame);
}
```

Ghost Mode changes which element gets passed to the first `drawImage()`:

```javascript
function renderFrame() {
  if (ghostActive && ghostLoopPlayer.isReady()) {
    // Draw from the recorded loop video instead of live camera
    ghostLoopPlayer.drawFrame(compositeCtx, w, h);
  } else {
    // Normal: draw from live camera
    compositeCtx.drawImage(videoElement, 0, 0, w, h);
  }

  // Ink overlay is disabled during ghost mode
  if (!ghostActive && enabled && drawingCanvas) {
    compositeCtx.drawImage(drawingCanvas, 0, 0);
  }

  requestAnimationFrame(renderFrame);
}
```

The `captureStream()` on the composite canvas keeps running. The meeting app keeps receiving frames. The only thing that changed is the pixels being drawn --- not the pipeline, not the stream, not the canvas. This is what makes the switch invisible to the downstream consumer.

### Why Ink Is Disabled During Ghost Mode

Notice the second condition: ink overlay is only drawn when ghost mode is inactive. Drawing on top of a looped video would be a dead giveaway --- the strokes would appear on top of video that is obviously not responding to them. If the user wants to "step away" (which is the whole point of ghost mode), they should not be drawing.

---

## ctx.drawImage() Source Types

`drawImage()` accepts several source types. Understanding which ones exist and how they differ matters for Ghost Mode because the source changes from a live `<video>` element to a pre-recorded `<video>` element.

### HTMLVideoElement

```javascript
var video = document.createElement('video');
video.srcObject = cameraStream;  // Live camera
await video.play();

ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
```

When you call `drawImage(video, ...)`, the browser grabs the video's **current displayed frame**. For a live camera stream, this is the most recent frame from the camera. For a pre-recorded video (like the ghost loop), this is whatever frame corresponds to `video.currentTime`.

The key point: `drawImage()` does not care whether the video is live or recorded. It just reads the current frame. This is why source switching is so simple --- both the live camera and the loop are `<video>` elements.

### HTMLCanvasElement

```javascript
var offscreen = document.createElement('canvas');
offscreen.width = 320;
offscreen.height = 240;
var offCtx = offscreen.getContext('2d');

// Draw something onto the offscreen canvas
offCtx.drawImage(video, 0, 0, 320, 240);

// Now draw that offscreen canvas onto the main canvas
ctx.drawImage(offscreen, 0, 0, 1280, 720);
```

Ghost Mode uses this for the quality-drop artifact. The loop video frame is drawn onto a small canvas, then that small canvas is drawn onto the full-size composite canvas. The upscaling introduces pixelation.

### HTMLImageElement

```javascript
var img = new Image();
img.src = 'placeholder.png';
img.onload = function () {
  ctx.drawImage(img, 0, 0);
};
```

Not used by Ghost Mode, but useful to know: `drawImage()` can take any image element. This could be used for a static "user is away" placeholder.

### ImageBitmap

```javascript
var bitmap = await createImageBitmap(blob);
ctx.drawImage(bitmap, 0, 0);
bitmap.close();  // Free GPU memory
```

`ImageBitmap` is a GPU-resident image handle. Creating one from a Blob decodes the image asynchronously and uploads it to the GPU. Subsequent `drawImage()` calls with an `ImageBitmap` are very fast because the data is already on the GPU. Ghost Mode does not use this, but it would be relevant if we wanted to pre-decode individual frames from the loop clip.

### OffscreenCanvas

```javascript
var offscreen = new OffscreenCanvas(1280, 720);
var offCtx = offscreen.getContext('2d');
offCtx.fillRect(0, 0, 1280, 720);

ctx.drawImage(offscreen, 0, 0);
```

`OffscreenCanvas` can be used as a `drawImage()` source just like a regular `<canvas>`. The difference: `OffscreenCanvas` works in Web Workers and does not need to be attached to the DOM. Ghost Mode uses a regular `<canvas>` for the quality-drop offscreen buffer, but `OffscreenCanvas` would be a valid alternative.

---

## globalAlpha for Crossfades

### The Mechanism

`ctx.globalAlpha` sets the opacity of the **next** drawing operation. It does not affect content already on the canvas.

```javascript
ctx.globalAlpha = 0.5;
ctx.drawImage(video, 0, 0, w, h);  // Drawn at 50% opacity
ctx.globalAlpha = 1.0;              // Reset for subsequent draws
```

When `globalAlpha` is less than 1.0, the drawn content is blended with what is already on the canvas. The formula is:

```
outputPixel = sourcePixel * globalAlpha + existingPixel * (1 - globalAlpha)
```

This is alpha compositing, specifically the "source-over" blend mode applied with reduced alpha.

### How Ghost Mode Uses globalAlpha

Ghost Mode uses `globalAlpha` in two places:

**1. Loop seam softening.** Near the loop boundary, the artifact engine may set `alpha` to a value between 0.92 and 1.0. This creates a very subtle crossfade between the current frame and the previous frame (which is still on the canvas because it was drawn last frame).

```javascript
// In GhostArtifacts.decide():
if (distFromSeam < 0.3) {
  decision.alpha = 0.92 + Math.random() * 0.08;
}

// In drawFrame():
if (decision.alpha < 1.0) {
  var prev = ctx.globalAlpha;
  ctx.globalAlpha = decision.alpha;
  ctx.drawImage(loopVideo, 0, 0, w, h);
  ctx.globalAlpha = prev;  // Restore previous alpha
}
```

At `alpha = 0.95`, 95% of the new frame is drawn and 5% of the previous frame bleeds through. This smooths over the visual discontinuity at the loop seam without being noticeable to the viewer.

**2. Quality drop frames.** When a quality-drop artifact is combined with reduced alpha, the result looks like a degraded frame that is also slightly translucent --- mimicking the visual appearance of a partially-decoded frame.

### Saving and Restoring globalAlpha

Always restore `globalAlpha` after modifying it. The pattern:

```javascript
var prev = ctx.globalAlpha;
ctx.globalAlpha = 0.7;
ctx.drawImage(source, 0, 0, w, h);
ctx.globalAlpha = prev;
```

Alternatively, use `save()`/`restore()`:

```javascript
ctx.save();
ctx.globalAlpha = 0.7;
ctx.drawImage(source, 0, 0, w, h);
ctx.restore();
```

The `save()`/`restore()` approach also preserves the transformation matrix, clipping region, and other state. For Ghost Mode, where we only modify `globalAlpha`, saving and restoring just that one property is more efficient.

---

## The Downscale-Upscale Trick in Detail

This technique is the core of the quality-drop artifact. It simulates the visual appearance of low-bitrate video encoding without touching any codec.

### How Video Codecs Reduce Quality

When a video encoder (VP8, VP9, H.264) reduces bitrate, it quantizes the DCT coefficients more aggressively. This introduces blockiness --- 8x8 or 16x16 pixel blocks become visible because fine detail within each block is lost. The result is a characteristic "blocky" or "smeary" appearance.

We cannot control the WebRTC encoder's quantization from JavaScript. But we can simulate the visual result by reducing and then increasing the spatial resolution.

### Step by Step

```javascript
// Full-size canvas: 1280 x 720
// Offscreen canvas: 640 x 360

// Step 1: Draw video onto small canvas (downscale)
offCtx.drawImage(loopVideo, 0, 0, 640, 360);

// Step 2: Draw small canvas onto full canvas (upscale)
ctx.drawImage(offCanvas, 0, 0, 1280, 720);
```

**Step 1** reduces the video from 1280x720 to 640x360. This discards half the spatial detail. Fine textures, sharp edges, and subtle gradients are lost.

**Step 2** scales the 640x360 image back up to 1280x720. Because the detail was already lost, the upscaling just makes the low-resolution image larger. The result: each "pixel" of the downscaled image becomes a 2x2 block in the output, creating the characteristic blocky look.

### Why 50% Downscale?

Ghost Mode uses `Math.floor(w / 2)` and `Math.floor(h / 2)`:

```javascript
var hw = Math.floor(w / 2), hh = Math.floor(h / 2);
offCanvas.width = hw;
offCanvas.height = hh;
offCtx.drawImage(loopVideo, 0, 0, hw, hh);
ctx.drawImage(offCanvas, 0, 0, w, h);
```

A 50% downscale (720p to 360p) matches the typical adaptive bitrate drop that WebRTC performs under congestion. Going smaller (e.g., 25%) would look like an extremely degraded connection. Going larger (e.g., 75%) would be barely noticeable. The 50% point hits the sweet spot of "clearly degraded but still watchable."

### Performance Consideration

The downscale-upscale trick involves two extra `drawImage()` calls: one to draw onto the offscreen canvas and one to draw from it. Both are GPU-accelerated in Chrome. The total cost is roughly 2x that of a normal frame draw. Since quality drops occur infrequently (a few frames per "bad connection" burst), the average performance impact is negligible.

Setting `offCanvas.width` or `offCanvas.height` clears the canvas and may trigger a reallocation. In Ghost Mode, this happens only during quality-drop frames. For a more optimized implementation, the offscreen canvas could be pre-allocated once and reused:

```javascript
// Pre-allocate during initialization
offCanvas.width = Math.floor(maxWidth / 2);
offCanvas.height = Math.floor(maxHeight / 2);

// During quality drop: just draw (no resize)
offCtx.clearRect(0, 0, offCanvas.width, offCanvas.height);
offCtx.drawImage(loopVideo, 0, 0, offCanvas.width, offCanvas.height);
ctx.drawImage(offCanvas, 0, 0, w, h);
```

---

## Performance of Skipping drawImage (Freeze Effect)

When the artifact engine decides to "freeze," the compositing loop simply does not call `drawImage()`. This is a non-operation. No GPU work, no CPU work, no memory allocation, no pixel transfer.

```javascript
if (decision.freeze) return;
```

The canvas retains whatever was drawn on the previous frame. This happens because the canvas is a retained-mode surface --- it holds its pixel data until explicitly cleared or overwritten. Unlike an immediate-mode API (like OpenGL with double buffering), you do not need to redraw the canvas every frame to keep its contents visible.

### Why This Matters for Background Tabs

When a tab is in the background, Chrome throttles `requestAnimationFrame` to at most 1 call per second. Ghost Mode works around this by using `setTimeout` when ghost is active:

```javascript
// In the compositing loop
if (ghostActive) {
  setTimeout(renderFrame, 1000 / 30);  // Force ~30fps even in background
} else {
  requestAnimationFrame(renderFrame);   // Sync with display in foreground
}
```

When freeze frames are "free" (no GPU work), the `setTimeout` fallback is also essentially free during freezes. The loop keeps ticking at 30fps, but frozen frames cost nothing.

---

## Double Buffering in Canvas

### You Do Not Need to Implement Double Buffering

The browser internally double-buffers `<canvas>` elements. When you draw to a canvas, you are drawing to a back buffer. The browser displays the front buffer. The swap happens atomically between frames. You never see a partially-drawn frame.

This means you do not need to create your own double-buffer scheme. Draw directly to the canvas, and the viewer always sees a complete frame.

### When Previous Content Is Useful

Normally, you clear the canvas at the start of each frame:

```javascript
function renderFrame() {
  ctx.clearRect(0, 0, w, h);         // Clear previous frame
  ctx.drawImage(video, 0, 0, w, h);  // Draw new frame
}
```

For Ghost Mode's freeze effect, we intentionally skip the clear AND the draw. The previous frame persists on the canvas. This is the "ghost" --- the residual image from the last drawn frame.

If you called `clearRect()` but then decided to freeze (skip `drawImage()`), you would get a blank frame instead of a frozen one. This is why Ghost Mode's compositing loop draws directly without clearing first:

```javascript
function renderFrame() {
  // NO clearRect here — if we freeze, we want the previous frame to stay

  if (ghostActive && ghostLoopPlayer.isReady()) {
    ghostLoopPlayer.drawFrame(compositeCtx, w, h);
    // drawFrame may return without drawing (freeze), leaving previous frame
  } else {
    compositeCtx.drawImage(videoElement, 0, 0, w, h);
  }

  // Ink overlay on top (only when not in ghost mode)
  if (!ghostActive && enabled && drawingCanvas) {
    compositeCtx.drawImage(drawingCanvas, 0, 0);
  }
}
```

Since `drawImage(video, 0, 0, w, h)` draws the full canvas area, it effectively replaces all previous content --- no explicit `clearRect()` needed. And when we freeze, the lack of a `clearRect()` means the previous frame stays.

---

## drawImage with Scaling: The 9-Argument Form

`drawImage()` has three overloads:

### 3-Argument Form (Position Only)

```javascript
ctx.drawImage(source, dx, dy);
```

Draws the source at position (dx, dy) at its natural size. No scaling.

### 5-Argument Form (Position + Size)

```javascript
ctx.drawImage(source, dx, dy, dw, dh);
```

Draws the source at position (dx, dy), scaled to size (dw, dh). This is what Ghost Mode uses for most frames:

```javascript
ctx.drawImage(loopVideo, 0, 0, w, h);
```

If the video's natural resolution differs from the canvas size, this call handles the scaling.

### 9-Argument Form (Source Crop + Destination)

```javascript
ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
```

This crops a rectangle (sx, sy, sw, sh) from the source and draws it onto the destination rectangle (dx, dy, dw, dh). This is the most powerful form.

Example: draw only the center 50% of the video, scaled to fill the canvas:

```javascript
var videoW = video.videoWidth;
var videoH = video.videoHeight;
var cropX = videoW * 0.25;
var cropY = videoH * 0.25;
var cropW = videoW * 0.5;
var cropH = videoH * 0.5;

ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
```

Ghost Mode does not currently use the 9-argument form, but it would be useful for implementing a "zoom artifact" --- zooming into a slightly different region on each loop iteration to add variety.

---

## How Ghost Mode Uses All of This

The compositing loop is a single function that orchestrates everything. Here is the complete flow in the actual implementation:

```javascript
function renderFrame() {
  // Decide timing: rAF in foreground, setTimeout in background
  if (ghostActive) {
    setTimeout(renderFrame, 1000 / 30);
  } else {
    requestAnimationFrame(renderFrame);
  }

  // Layer 1: Video source (live or ghost loop)
  if (ghostActive && ghostLoopPlayer && ghostLoopPlayer.isReady()) {
    ghostLoopPlayer.drawFrame(compositeCtx, compositeCanvas.width, compositeCanvas.height);
  } else {
    compositeCtx.drawImage(videoElement, 0, 0, compositeCanvas.width, compositeCanvas.height);
  }

  // Layer 2: Ink overlay (disabled during ghost mode)
  if (!ghostActive && enabled && drawingCanvas) {
    compositeCtx.drawImage(drawingCanvas, 0, 0);
  }
}
```

Inside `ghostLoopPlayer.drawFrame()`:

```javascript
drawFrame: function (ctx, w, h) {
  // Manual loop
  if (loopVideo.currentTime >= loopEndSec) {
    loopVideo.currentTime = loopStartSec;
  }

  // Get artifact decision
  var relTime = loopVideo.currentTime - loopStartSec;
  var d = GhostArtifacts.decide(relTime);

  // Apply catch-up jump
  if (d.catchUpJump > 0) {
    loopVideo.currentTime += d.catchUpJump;
  }

  // Freeze: skip drawImage entirely
  if (d.freeze) return;

  // Quality drop: downscale-upscale via offscreen canvas
  if (d.qualityDrop && offCanvas && offCtx) {
    var hw = Math.floor(w / 2), hh = Math.floor(h / 2);
    offCanvas.width = hw;
    offCanvas.height = hh;
    offCtx.drawImage(loopVideo, 0, 0, hw, hh);
    var prev = ctx.globalAlpha;
    ctx.globalAlpha = d.alpha;
    ctx.drawImage(offCanvas, 0, 0, w, h);
    ctx.globalAlpha = prev;
    return;
  }

  // Normal draw (with optional alpha reduction)
  if (d.alpha < 1.0) {
    var prev = ctx.globalAlpha;
    ctx.globalAlpha = d.alpha;
    ctx.drawImage(loopVideo, 0, 0, w, h);
    ctx.globalAlpha = prev;
  } else {
    ctx.drawImage(loopVideo, 0, 0, w, h);
  }
}
```

Every concept from this document converges in this function:

1. **Source switching**: `drawImage(loopVideo, ...)` instead of `drawImage(videoElement, ...)`
2. **Freeze via skip**: `if (d.freeze) return;`
3. **Quality drop via downscale-upscale**: draw to offscreen at half size, then upscale
4. **globalAlpha for seam softening**: reduce alpha near loop boundary
5. **No clearRect**: previous frame persists during freezes
6. **5-argument drawImage**: scale to fill canvas

The downstream `captureStream()` sees a continuous sequence of frames. It does not know that some frames are frozen, some are pixelated, and the source switches between live and recorded. All it sees is pixels on a canvas.
