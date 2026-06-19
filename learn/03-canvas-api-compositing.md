# Canvas API & Real-Time Compositing

## Why Canvas Matters for AirDraw

AirDraw draws on top of a video call. The user waves their finger, and ink appears on screen. That ink must then be composited with the camera feed and sent to the meeting app as if it were the original camera. Every step of this pipeline uses the Canvas API.

The pipeline:
1. Camera frame arrives from `getUserMedia`
2. MediaPipe processes the frame and returns hand landmarks
3. We draw ink strokes on an overlay canvas based on the landmarks
4. We composite the camera frame + ink overlay onto a third canvas
5. We call `captureStream()` on that canvas to produce a MediaStream
6. We feed that stream to the meeting app in place of the raw camera

All of this must happen at 30 fps with minimal latency. Understanding the Canvas API deeply is not optional.

---

## Canvas 2D Context Basics

### Creating a Canvas

```typescript
const canvas = document.createElement("canvas");
canvas.width = 1280;
canvas.height = 720;

const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2D context not available");
```

**Important:** `canvas.width` and `canvas.height` set the internal drawing resolution. `canvas.style.width` and `canvas.style.height` set the display size. If they differ, the canvas scales. For AirDraw, set both to match the camera resolution to avoid blurriness.

```typescript
// Match camera resolution
canvas.width = videoTrack.getSettings().width ?? 1280;
canvas.height = videoTrack.getSettings().height ?? 720;

// For the overlay that sits on top of the page, set display size via CSS
canvas.style.width = "100%";
canvas.style.height = "100%";
canvas.style.position = "fixed";
canvas.style.top = "0";
canvas.style.left = "0";
canvas.style.pointerEvents = "none"; // Let clicks pass through
canvas.style.zIndex = "999999";
```

### Paths, Strokes, and Fills

Canvas drawing is path-based. You build a path with commands, then stroke (outline) or fill it.

```typescript
// Draw a straight line
ctx.beginPath();
ctx.moveTo(100, 100);     // Start point
ctx.lineTo(200, 200);     // End point
ctx.stroke();              // Actually draw it

// Draw a filled rectangle
ctx.fillStyle = "#ff0000";
ctx.fillRect(50, 50, 100, 80); // x, y, width, height

// Draw a circle
ctx.beginPath();
ctx.arc(150, 150, 50, 0, Math.PI * 2); // centerX, centerY, radius, startAngle, endAngle
ctx.fill();
```

### Stroke Properties

```typescript
ctx.strokeStyle = "#00ff00";    // Color
ctx.lineWidth = 4;              // Thickness in pixels
ctx.lineCap = "round";          // "butt" | "round" | "square"
ctx.lineJoin = "round";         // "miter" | "round" | "bevel"
ctx.globalAlpha = 0.8;          // Opacity (0 = transparent, 1 = opaque)
```

For AirDraw, `lineCap: "round"` and `lineJoin: "round"` are essential for smooth-looking strokes. Without them, you get ugly flat ends and sharp corners.

---

## Drawing Operations for AirDraw

### The Drawing Loop

When the user's index finger moves, we receive a stream of (x, y) coordinates from MediaPipe. We connect them with lines:

```typescript
// Naive approach — straight line segments
let isDrawing = false;
let lastX = 0;
let lastY = 0;

function onHandPosition(x: number, y: number): void {
  if (!isDrawing) {
    // First point — just record position
    lastX = x;
    lastY = y;
    isDrawing = true;
    return;
  }

  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.stroke();

  lastX = x;
  lastY = y;
}
```

This works but produces jagged lines because hand tracking data is noisy. We need smoothing.

### Quadratic Bezier Curves

`quadraticCurveTo(cpx, cpy, x, y)` draws a smooth curve through a control point. The trick is to use the midpoint between consecutive tracking points as the actual point, and the tracking points themselves as control points:

```typescript
const points: Array<{ x: number; y: number }> = [];

function onHandPosition(x: number, y: number): void {
  points.push({ x, y });

  if (points.length < 3) return;

  const len = points.length;
  const p0 = points[len - 3];
  const p1 = points[len - 2]; // Control point
  const p2 = points[len - 1];

  // Use midpoints as actual stroke points for smoothness
  const mid1 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const mid2 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

  ctx.beginPath();
  ctx.moveTo(mid1.x, mid1.y);
  ctx.quadraticCurveTo(p1.x, p1.y, mid2.x, mid2.y);
  ctx.stroke();
}
```

This produces much smoother strokes.

---

## Compositing: globalCompositeOperation

The `globalCompositeOperation` property controls how new drawings interact with existing content on the canvas.

### Key Modes for AirDraw

```typescript
// Default: new pixels draw on top of existing
ctx.globalCompositeOperation = "source-over";

// Eraser mode: new drawing removes existing pixels
ctx.globalCompositeOperation = "destination-out";
ctx.beginPath();
ctx.arc(x, y, eraserRadius, 0, Math.PI * 2);
ctx.fill(); // This "erases" — removes pixels where we draw

// Reset to normal drawing
ctx.globalCompositeOperation = "source-over";
```

### Compositing Camera + Drawing

To merge the camera feed and the drawing overlay into a single output stream:

```typescript
// compositeCanvas — the final output
const compositeCtx = compositeCanvas.getContext("2d")!;

function renderFrame(): void {
  // Step 1: Draw the camera frame
  compositeCtx.drawImage(videoElement, 0, 0);

  // Step 2: Draw the overlay (ink) on top
  compositeCtx.drawImage(overlayCanvas, 0, 0);

  requestAnimationFrame(renderFrame);
}
```

The `drawImage` function can take a `<video>` element, another `<canvas>`, or an `Image` object as input. When passed a video element, it grabs the current frame.

---

## OffscreenCanvas

`OffscreenCanvas` allows canvas rendering in a Web Worker, off the main thread. This is significant for AirDraw because hand tracking and drawing are CPU-intensive, and doing them on the main thread can cause jank in the meeting app.

### Basic Usage

```typescript
// On the main thread
const offscreen = new OffscreenCanvas(1280, 720);
const ctx = offscreen.getContext("2d")!;

// Render to it exactly like a regular canvas
ctx.fillStyle = "red";
ctx.fillRect(0, 0, 100, 100);

// Transfer to a visible canvas
const visibleCanvas = document.getElementById("output") as HTMLCanvasElement;
const visibleCtx = visibleCanvas.getContext("2d")!;
visibleCtx.drawImage(offscreen, 0, 0);
```

### Transferring to a Worker

```typescript
// main.ts
const canvas = document.getElementById("output") as HTMLCanvasElement;
const offscreen = canvas.transferControlToOffscreen();

const worker = new Worker("render-worker.ts");
worker.postMessage({ canvas: offscreen }, [offscreen]);

// render-worker.ts
self.onmessage = (event) => {
  const canvas: OffscreenCanvas = event.data.canvas;
  const ctx = canvas.getContext("2d")!;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // ... render frame
    requestAnimationFrame(draw);
  }
  draw();
};
```

**Caveat:** In a Chrome extension content script, Web Workers are trickier because the worker URL must be in `web_accessible_resources`. More on this in the Vite/CRXJS doc.

---

## drawImage() for Video Frame Capture

`drawImage()` is how we grab frames from the camera:

```typescript
const video = document.createElement("video");
video.srcObject = cameraStream;
await video.play();

// Capture a single frame
ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
```

### Overloads

```typescript
// Full signature — crop from source, draw to destination
ctx.drawImage(
  source,    // video, canvas, or image
  sx, sy,    // Source crop origin
  sw, sh,    // Source crop size
  dx, dy,    // Destination position
  dw, dh     // Destination size
);

// Common usage — draw full source at position, scaled to size
ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

// Simplest — draw at (0,0) at original size
ctx.drawImage(video, 0, 0);
```

### Performance Tip

`drawImage(video, ...)` is GPU-accelerated in Chrome. It does not actually copy pixel data through JavaScript — the browser blits the video texture directly to the canvas. This is very fast. Do not try to "optimize" by reading pixels with `getImageData()` and writing them back — that forces a GPU-to-CPU transfer and is orders of magnitude slower.

---

## captureStream(): Canvas to MediaStream

This is the magic that makes AirDraw work. `canvas.captureStream()` returns a live `MediaStream` from a canvas. Whatever is drawn on the canvas becomes the video stream.

```typescript
const compositeCanvas = document.createElement("canvas");
compositeCanvas.width = 1280;
compositeCanvas.height = 720;

// Create a stream at 30fps
const stream = compositeCanvas.captureStream(30);

// This stream can now be used anywhere a camera stream would be used
// For AirDraw, we swap this into the meeting app's video track
```

### Frame Rate Parameter

- `captureStream(30)` — Captures at a fixed 30 fps, regardless of how often you draw
- `captureStream(0)` — Only captures a new frame when you call `ctx.drawImage()` or any other drawing operation. Most efficient if your render rate varies.
- `captureStream()` (no argument) — Captures every frame as fast as possible. Can cause high CPU usage.

For AirDraw, `captureStream(30)` is ideal — it matches typical camera frame rates and gives a consistent output.

### Feeding the Stream to Meeting Apps

```typescript
// After patching getUserMedia and intercepting the camera stream:
const compositedStream = compositeCanvas.captureStream(30);
const compositedTrack = compositedStream.getVideoTracks()[0];

// Replace the original camera track with our composited track
// (Details in the MediaStream API doc)
```

---

## requestAnimationFrame vs setInterval

### requestAnimationFrame (Preferred)

```typescript
function renderLoop(): void {
  // 1. Draw camera frame to composite canvas
  compositeCtx.drawImage(video, 0, 0);

  // 2. Draw overlay on top
  compositeCtx.drawImage(overlayCanvas, 0, 0);

  // 3. Schedule next frame
  requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);
```

Benefits:
- Syncs with the display refresh rate (typically 60 Hz)
- Automatically pauses when the tab is hidden (saves CPU/battery)
- Provides a high-resolution timestamp for animation timing

### setInterval (Avoid for Rendering)

```typescript
// DON'T do this for rendering
setInterval(() => {
  compositeCtx.drawImage(video, 0, 0);
  compositeCtx.drawImage(overlayCanvas, 0, 0);
}, 1000 / 30);
```

Problems:
- Does not sync with display refresh — causes tearing
- Does not pause when tab is hidden — wastes CPU
- Timer drift — `setInterval(fn, 33)` does not guarantee exactly 30 fps

### When to Use setInterval

Use it for non-rendering tasks like periodic state checks:

```typescript
// Check if the meeting has ended every 5 seconds
setInterval(() => {
  if (!document.querySelector(".meeting-container")) {
    cleanup();
  }
}, 5000);
```

---

## Performance: Avoiding GC Pressure

JavaScript's garbage collector pauses execution to free memory. In a 30 fps render loop, a GC pause of even 16ms drops a frame. Here is how to avoid it.

### Reuse Objects

```typescript
// BAD: Creates a new object every frame (30 objects/second = GC pressure)
function getFingerPosition(landmarks: HandLandmark[]): { x: number; y: number } {
  return { x: landmarks[8].x, y: landmarks[8].y };
}

// GOOD: Reuse a single object
const fingerPos = { x: 0, y: 0 };

function getFingerPosition(landmarks: HandLandmark[]): typeof fingerPos {
  fingerPos.x = landmarks[8].x;
  fingerPos.y = landmarks[8].y;
  return fingerPos;
}
```

### Avoid Array Allocation in the Render Loop

```typescript
// BAD: Creates a new array every frame
function getRecentPoints(): Array<{ x: number; y: number }> {
  return this.points.slice(-10);
}

// GOOD: Use a ring buffer with pre-allocated slots
class RingBuffer<T> {
  private buffer: T[];
  private head = 0;
  private size = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }
}
```

### Batch Canvas Operations

```typescript
// BAD: Multiple beginPath/stroke calls
for (let i = 1; i < points.length; i++) {
  ctx.beginPath();
  ctx.moveTo(points[i - 1].x, points[i - 1].y);
  ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke(); // Each stroke() is a draw call
}

// GOOD: Single path, single stroke
ctx.beginPath();
ctx.moveTo(points[0].x, points[0].y);
for (let i = 1; i < points.length; i++) {
  ctx.lineTo(points[i].x, points[i].y);
}
ctx.stroke(); // One draw call for the entire path
```

---

## Coordinate Systems and Transformations

### MediaPipe Coordinates to Canvas Pixels

MediaPipe returns **normalized coordinates**: x and y are in the range [0, 1], where (0, 0) is the top-left of the video frame and (1, 1) is the bottom-right.

```typescript
// Convert normalized coordinates to canvas pixels
function toCanvasCoords(
  normalizedX: number,
  normalizedY: number,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } {
  return {
    x: normalizedX * canvasWidth,
    y: normalizedY * canvasHeight
  };
}

// Usage
const landmark = handLandmarks[8]; // Index finger tip
const { x, y } = toCanvasCoords(
  landmark.x,
  landmark.y,
  overlayCanvas.width,
  overlayCanvas.height
);
```

### Mirroring

Most webcams mirror the image (selfie mode). If the user moves their hand to the right, it should move right on screen. But MediaPipe processes the un-mirrored frame. You may need to flip the x coordinate:

```typescript
// If the camera is mirrored:
const canvasX = (1 - landmark.x) * canvas.width;
const canvasY = landmark.y * canvas.height;
```

### Canvas Transformations

Instead of manually transforming coordinates, you can use the canvas transformation matrix:

```typescript
// Mirror the entire canvas (useful for the camera feed)
ctx.save();
ctx.scale(-1, 1);
ctx.translate(-canvas.width, 0);
ctx.drawImage(video, 0, 0);
ctx.restore(); // Reset transformation
```

`save()` and `restore()` push/pop the transformation state. Always pair them to avoid corrupting the state for subsequent draw operations.

---

## Anti-Aliasing and Stroke Smoothing

### Canvas Anti-Aliasing

Canvas 2D automatically anti-aliases strokes and fills. You generally want this, but it can cause unwanted blurring on pixel-perfect lines. To disable:

```typescript
ctx.imageSmoothingEnabled = false; // For drawImage() only
// There is no way to disable anti-aliasing for strokes/paths
```

### Catmull-Rom Spline Smoothing

For truly smooth strokes from noisy hand tracking data, use Catmull-Rom splines. These pass through every control point (unlike Bezier curves, which pull toward control points).

```typescript
/**
 * Compute a point on a Catmull-Rom spline.
 * t goes from 0 to 1 between p1 and p2.
 * p0 and p3 are the surrounding points that influence the curve shape.
 */
function catmullRom(
  p0: number, p1: number, p2: number, p3: number, t: number
): number {
  const t2 = t * t;
  const t3 = t2 * t;

  return 0.5 * (
    (2 * p1) +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

/**
 * Draw a smooth curve through a series of points using Catmull-Rom interpolation.
 */
function drawSmoothStroke(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  segments: number = 8  // Interpolation steps between each pair of points
): void {
  if (points.length < 4) return;

  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 0; i < points.length - 3; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const p2 = points[i + 2];
    const p3 = points[i + 3];

    for (let j = 1; j <= segments; j++) {
      const t = j / segments;
      const x = catmullRom(p0.x, p1.x, p2.x, p3.x, t);
      const y = catmullRom(p0.y, p1.y, p2.y, p3.y, t);
      ctx.lineTo(x, y);
    }
  }

  ctx.stroke();
}
```

### Exponential Moving Average for Position Smoothing

Before even reaching the spline stage, smooth the raw landmark positions:

```typescript
const SMOOTHING_FACTOR = 0.3; // 0 = no smoothing, 1 = no movement

let smoothX = 0;
let smoothY = 0;
let initialized = false;

function smooth(rawX: number, rawY: number): { x: number; y: number } {
  if (!initialized) {
    smoothX = rawX;
    smoothY = rawY;
    initialized = true;
  } else {
    smoothX = smoothX * SMOOTHING_FACTOR + rawX * (1 - SMOOTHING_FACTOR);
    smoothY = smoothY * SMOOTHING_FACTOR + rawY * (1 - SMOOTHING_FACTOR);
  }

  return { x: smoothX, y: smoothY };
}
```

A smoothing factor of 0.3 means 30% of the previous position and 70% of the new position. Lower values = more responsive but jittery. Higher values = smoother but laggy. For AirDraw, 0.2-0.4 is the sweet spot.

---

## Putting It All Together: AirDraw's Render Pipeline

```typescript
class AirDrawRenderer {
  private overlayCanvas: HTMLCanvasElement;   // Drawing ink goes here
  private overlayCtx: CanvasRenderingContext2D;
  private compositeCanvas: HTMLCanvasElement; // Camera + ink composited
  private compositeCtx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;            // Camera feed
  private outputStream: MediaStream;

  constructor(width: number, height: number) {
    // Overlay canvas — transparent, only has ink strokes
    this.overlayCanvas = document.createElement("canvas");
    this.overlayCanvas.width = width;
    this.overlayCanvas.height = height;
    this.overlayCtx = this.overlayCanvas.getContext("2d")!;
    this.overlayCtx.lineCap = "round";
    this.overlayCtx.lineJoin = "round";

    // Composite canvas — hidden, produces the output stream
    this.compositeCanvas = document.createElement("canvas");
    this.compositeCanvas.width = width;
    this.compositeCanvas.height = height;
    this.compositeCtx = this.compositeCanvas.getContext("2d")!;

    // Start the output stream
    this.outputStream = this.compositeCanvas.captureStream(30);
  }

  /** Called every frame by requestAnimationFrame */
  render(): void {
    // Layer 1: Camera feed
    this.compositeCtx.drawImage(this.video, 0, 0);

    // Layer 2: Drawing overlay
    this.compositeCtx.drawImage(this.overlayCanvas, 0, 0);

    requestAnimationFrame(() => this.render());
  }

  /** Called by the gesture state machine when drawing */
  drawAt(x: number, y: number, color: string, size: number): void {
    this.overlayCtx.strokeStyle = color;
    this.overlayCtx.lineWidth = size;
    // ... draw smooth stroke
  }

  /** Get the composited stream to feed to the meeting app */
  getOutputStream(): MediaStream {
    return this.outputStream;
  }
}
```
