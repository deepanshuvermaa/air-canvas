# MediaPipe & Hand Tracking

## What Is MediaPipe?

MediaPipe is Google's open-source framework for building ML pipelines that process video, audio, and sensor data. It runs **entirely on-device** — no server calls, no cloud inference. For AirDraw, we use one specific component: the **Hand Landmarker** task, which detects hands in a video frame and returns the 3D positions of 21 joints per hand.

MediaPipe for the web ships as a set of npm packages (`@mediapipe/tasks-vision`) plus WebAssembly files and a TFLite model. The WASM runtime executes the ML model using either CPU (WASM) or GPU (WebGL delegate).

---

## Hand Landmarker: 21 Landmarks Per Hand

Each detected hand produces 21 landmarks numbered 0-20:

```
          FINGER TIPS
         8   12  16  20
         |   |   |   |
         7   11  15  19
         |   |   |   |
         6   10  14  18
         |   |   |   |
         5   9   13  17     <- Knuckles (MCP joints)
          \  |  /   /
           \ | /   /
            \|/   /
         4   \   /          <- Thumb tip
         |    \ /
         3     0            <- Wrist
         |
         2
         |
         1                  <- Thumb base (CMC)
```

### Landmark Reference Table

| Index | Name | What It Is |
|---|---|---|
| 0 | WRIST | Base of the hand |
| 1 | THUMB_CMC | Thumb base joint |
| 2 | THUMB_MCP | Thumb knuckle |
| 3 | THUMB_IP | Thumb middle joint |
| 4 | THUMB_TIP | Thumb tip |
| 5 | INDEX_FINGER_MCP | Index knuckle |
| 6 | INDEX_FINGER_PIP | Index proximal joint |
| 7 | INDEX_FINGER_DIP | Index distal joint |
| 8 | INDEX_FINGER_TIP | Index tip |
| 9 | MIDDLE_FINGER_MCP | Middle knuckle |
| 10 | MIDDLE_FINGER_PIP | Middle proximal joint |
| 11 | MIDDLE_FINGER_DIP | Middle distal joint |
| 12 | MIDDLE_FINGER_TIP | Middle tip |
| 13 | RING_FINGER_MCP | Ring knuckle |
| 14 | RING_FINGER_PIP | Ring proximal joint |
| 15 | RING_FINGER_DIP | Ring distal joint |
| 16 | RING_FINGER_TIP | Ring tip |
| 17 | PINKY_MCP | Pinky knuckle |
| 18 | PINKY_PIP | Pinky proximal joint |
| 19 | PINKY_DIP | Pinky distal joint |
| 20 | PINKY_TIP | Pinky tip |

Each landmark has three coordinates:
- `x`: Horizontal position, normalized [0, 1], left to right
- `y`: Vertical position, normalized [0, 1], top to bottom
- `z`: Depth relative to the wrist, roughly in the same scale as x (negative = closer to camera)

---

## Setting Up MediaPipe in AirDraw

### Installation

```bash
npm install @mediapipe/tasks-vision
```

### Initialization

```typescript
import {
  HandLandmarker,
  FilesetResolver,
  HandLandmarkerResult,
} from "@mediapipe/tasks-vision";

async function createHandLandmarker(): Promise<HandLandmarker> {
  // Load WASM files — these must be accessible via web_accessible_resources
  const vision = await FilesetResolver.forVisionTasks(
    // In a Chrome extension, this path must point to the bundled WASM files
    chrome.runtime.getURL("mediapipe/wasm")
  );

  const handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL(
        "mediapipe/hand_landmarker.task"
      ),
      delegate: "GPU", // or "CPU"
    },
    runningMode: "VIDEO",
    numHands: 1,               // We only need one hand for drawing
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  return handLandmarker;
}
```

### Processing Frames

```typescript
let lastTimestamp = 0;

function processFrame(video: HTMLVideoElement): HandLandmarkerResult | null {
  const timestamp = performance.now();

  // MediaPipe requires strictly increasing timestamps
  if (timestamp <= lastTimestamp) return null;
  lastTimestamp = timestamp;

  return handLandmarker.detectForVideo(video, timestamp);
}
```

---

## WASM vs WebGL Delegates

MediaPipe supports two execution backends:

### CPU (WASM)

```typescript
delegate: "CPU"
```

- Runs the ML model on the CPU via WebAssembly
- More reliable — works on all hardware
- Slower: ~30-80ms per frame on a modern laptop
- Does not compete with WebGL rendering for GPU resources

### GPU (WebGL)

```typescript
delegate: "GPU"
```

- Runs the ML model on the GPU via WebGL shaders
- Faster: ~10-30ms per frame
- Can cause contention if your app also uses the GPU heavily (canvas rendering, video decoding)
- May not work on all GPUs — fall back to CPU if initialization fails

### Recommendation for AirDraw

Start with `"GPU"` and fall back to `"CPU"`:

```typescript
let handLandmarker: HandLandmarker;

try {
  handLandmarker = await createHandLandmarker("GPU");
  console.log("Using GPU delegate");
} catch (e) {
  console.warn("GPU delegate failed, falling back to CPU:", e);
  handLandmarker = await createHandLandmarker("CPU");
}
```

---

## Running Mode: VIDEO vs IMAGE vs LIVE_STREAM

| Mode | Input | Timing | Use Case |
|---|---|---|---|
| `IMAGE` | Single image | No timestamp needed | Processing a photo |
| `VIDEO` | Video frames | Must provide increasing timestamps | Frame-by-frame processing (AirDraw uses this) |
| `LIVE_STREAM` | Video frames | Timestamps + async callback | When you want non-blocking inference |

### Why AirDraw Uses VIDEO Mode

`VIDEO` mode is synchronous — you call `detectForVideo()` and immediately get results. This makes the code simpler and ensures that drawing coordinates match the frame they were detected in.

`LIVE_STREAM` mode is asynchronous — you call `detectAsync()` and get results in a callback. This avoids blocking the main thread but introduces a frame of latency (you get results for frame N while you are already showing frame N+1). For AirDraw, where drawing needs to feel immediate, we prefer `VIDEO` mode.

```typescript
// VIDEO mode — synchronous
const result = handLandmarker.detectForVideo(video, timestamp);
// result is available immediately, draw now

// LIVE_STREAM mode — asynchronous
handLandmarker.detectAsync(video, timestamp);
// result arrives later in the callback passed during setup
```

---

## Detecting Finger Poses

### The Angle Method

To determine if a finger is extended or curled, compute the angle at each joint. A straight (extended) finger has angles close to 180 degrees. A curled finger has angles around 60-90 degrees.

```typescript
interface Point3D {
  x: number;
  y: number;
  z: number;
}

/**
 * Compute the angle (in degrees) at point B in the triangle A-B-C.
 */
function angleBetween(a: Point3D, b: Point3D, c: Point3D): number {
  const ba = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const bc = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };

  const dot = ba.x * bc.x + ba.y * bc.y + ba.z * bc.z;
  const magBA = Math.sqrt(ba.x ** 2 + ba.y ** 2 + ba.z ** 2);
  const magBC = Math.sqrt(bc.x ** 2 + bc.y ** 2 + bc.z ** 2);

  const cosAngle = dot / (magBA * magBC);
  // Clamp to avoid NaN from floating-point imprecision
  const clamped = Math.max(-1, Math.min(1, cosAngle));
  return Math.acos(clamped) * (180 / Math.PI);
}
```

### Detecting "Index Pointing" (Drawing Gesture)

The user draws by pointing their index finger while curling the other fingers. Here is how to detect it:

```typescript
function isIndexPointing(landmarks: Point3D[]): boolean {
  // Index finger should be extended
  // Check the angle at the PIP joint (landmark 6)
  const indexAngle = angleBetween(
    landmarks[5],  // INDEX_MCP
    landmarks[6],  // INDEX_PIP
    landmarks[7]   // INDEX_DIP
  );
  const indexExtended = indexAngle > 150; // Near-straight

  // Middle finger should be curled
  const middleAngle = angleBetween(
    landmarks[9],   // MIDDLE_MCP
    landmarks[10],  // MIDDLE_PIP
    landmarks[11]   // MIDDLE_DIP
  );
  const middleCurled = middleAngle < 120;

  // Ring finger should be curled
  const ringAngle = angleBetween(
    landmarks[13],  // RING_MCP
    landmarks[14],  // RING_PIP
    landmarks[15]   // RING_DIP
  );
  const ringCurled = ringAngle < 120;

  return indexExtended && middleCurled && ringCurled;
}
```

### Simpler Distance-Based Approach

An alternative that works surprisingly well: check if the fingertip is above (lower y value, since y=0 is top) or far from the MCP joint:

```typescript
function isFingerExtended(
  tip: Point3D,
  pip: Point3D,
  mcp: Point3D
): boolean {
  // A finger is extended if the tip is farther from the wrist
  // than the PIP joint (i.e., the finger is not folding back)
  const tipDist = Math.sqrt(
    (tip.x - mcp.x) ** 2 + (tip.y - mcp.y) ** 2
  );
  const pipDist = Math.sqrt(
    (pip.x - mcp.x) ** 2 + (pip.y - mcp.y) ** 2
  );

  return tipDist > pipDist * 1.2; // 1.2 = margin for noise
}
```

### Detecting Open Palm (Erase Gesture)

```typescript
function isOpenPalm(landmarks: Point3D[]): boolean {
  // All fingers should be extended
  const indexExtended = isFingerExtended(landmarks[8], landmarks[6], landmarks[5]);
  const middleExtended = isFingerExtended(landmarks[12], landmarks[10], landmarks[9]);
  const ringExtended = isFingerExtended(landmarks[16], landmarks[14], landmarks[13]);
  const pinkyExtended = isFingerExtended(landmarks[20], landmarks[18], landmarks[17]);

  // Fingers should be spread apart
  const spread = Math.abs(landmarks[8].x - landmarks[20].x);
  const isSpreading = spread > 0.1; // Normalized units

  return indexExtended && middleExtended && ringExtended && pinkyExtended && isSpreading;
}
```

---

## Performance Optimization

### Frame Skip Strategies

You do not need to run hand detection on every frame. The hand does not move much between frames at 30 fps.

```typescript
let frameCount = 0;
const PROCESS_EVERY_N_FRAMES = 2; // Process every other frame

function renderLoop(): void {
  frameCount++;

  if (frameCount % PROCESS_EVERY_N_FRAMES === 0) {
    const result = handLandmarker.detectForVideo(video, performance.now());
    if (result.landmarks.length > 0) {
      updateDrawing(result.landmarks[0]);
    }
  }

  // Always render the composite (camera + overlay) even if we skip detection
  compositeCtx.drawImage(video, 0, 0);
  compositeCtx.drawImage(overlayCanvas, 0, 0);

  requestAnimationFrame(renderLoop);
}
```

Processing every other frame cuts ML inference cost in half with minimal impact on drawing quality.

### Resolution Tradeoffs

MediaPipe does not need full-resolution video. Process at a lower resolution for faster inference:

```typescript
// Request a lower resolution from the camera for ML processing
const mlStream = await navigator.mediaDevices.getUserMedia({
  video: { width: 640, height: 480 } // Half of 1280x720
});

// But use full resolution for the output
const displayStream = await navigator.mediaDevices.getUserMedia({
  video: { width: 1280, height: 720 }
});
```

Alternatively, downscale the frame before passing it to MediaPipe:

```typescript
const smallCanvas = document.createElement("canvas");
smallCanvas.width = 320;
smallCanvas.height = 240;
const smallCtx = smallCanvas.getContext("2d")!;

function processFrame(): void {
  // Downscale for ML
  smallCtx.drawImage(video, 0, 0, 320, 240);

  // Run detection on the small canvas
  const result = handLandmarker.detectForVideo(smallCanvas, performance.now());

  // Coordinates are normalized [0,1], so they map correctly to any resolution
  if (result.landmarks.length > 0) {
    const tip = result.landmarks[0][8]; // Index finger tip
    const x = tip.x * overlayCanvas.width;  // Maps to full-res canvas
    const y = tip.y * overlayCanvas.height;
    drawAt(x, y);
  }
}
```

---

## Coordinate Mapping

### Normalized to Canvas

MediaPipe returns coordinates in [0, 1] range. Map them to your canvas:

```typescript
function landmarkToCanvas(
  landmark: { x: number; y: number },
  canvas: HTMLCanvasElement,
  mirror: boolean = true
): { x: number; y: number } {
  return {
    x: mirror ? (1 - landmark.x) * canvas.width : landmark.x * canvas.width,
    y: landmark.y * canvas.height,
  };
}
```

### Why Mirroring Is Important

Webcams typically show a mirrored image (selfie view). When the user moves their right hand to the right, it should move right on screen. MediaPipe detects landmarks on the un-mirrored frame, so:

- If your camera feed is displayed mirrored (selfie mode), flip the x coordinate: `x = (1 - landmark.x) * width`
- If your camera feed is displayed normally (not mirrored), use the raw coordinate: `x = landmark.x * width`

Most video call apps show the self-view in selfie mode, so you almost always need to mirror.

### Z-Coordinate

The z-coordinate represents depth relative to the wrist. It is useful for:

- Determining if a finger is pointing toward or away from the camera
- Estimating hand size (distance from camera)
- 3D gesture detection

For AirDraw's 2D drawing, we primarily use x and y. But z could be used for:

```typescript
// Example: Use z-depth to control brush size (closer hand = thicker stroke)
const indexTip = landmarks[8];
const wrist = landmarks[0];
const depthDiff = wrist.z - indexTip.z; // Positive = finger closer to camera

const brushSize = Math.max(2, Math.min(20, depthDiff * 100));
```

---

## Common Failure Modes

### Low Light

MediaPipe struggles in dim lighting because the hand model relies on visual features. There is no built-in fix — you can:
- Increase the video brightness via CSS filter on the video element (does not affect detection)
- Lower `minHandDetectionConfidence` to be more permissive (but increases false positives)
- Add a warning to the user: "Move to a well-lit area for best results"

### Occlusion

When part of the hand is hidden (behind a mug, under a desk), landmarks for the hidden fingers are **estimated, not detected**. They will be inaccurate. AirDraw mitigates this by:
- Only relying on the fingertips and one or two joints for gesture detection
- Requiring high confidence for the specific landmarks we use

### Fast Movement

Rapid hand movements cause motion blur in the camera frame, which degrades detection accuracy. The landmarks may jump or disappear entirely. Solutions:
- Increase camera frame rate (60 fps instead of 30) to reduce blur
- Apply position smoothing (exponential moving average) to absorb jumps
- Require stable detection for N consecutive frames before starting a stroke

### Multiple People

If other people are visible on screen (in a meeting), MediaPipe might detect their hands. Set `numHands: 1` and rely on the closest/most-prominent hand detection.

---

## Privacy: Everything Is Local

A key selling point of MediaPipe for AirDraw:

1. **No data leaves the device.** The ML model runs entirely in the browser via WASM/WebGL. No frames, landmarks, or gesture data are sent to any server.

2. **No internet required for inference.** Once the extension is installed (with the model bundled), hand tracking works offline.

3. **The model is small.** The hand landmarker model is ~3-5 MB. It ships with the extension package.

4. **No recording.** AirDraw processes frames in real-time and discards them immediately. No video is stored.

This is a meaningful privacy advantage over server-based hand tracking solutions. It is worth communicating to users who are understandably cautious about browser extensions that access their camera.

---

## Complete Integration Example

```typescript
import {
  HandLandmarker,
  FilesetResolver,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";

class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastTimestamp = 0;

  async initialize(): Promise<void> {
    const vision = await FilesetResolver.forVisionTasks(
      chrome.runtime.getURL("mediapipe/wasm")
    );

    this.landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL("mediapipe/hand_landmarker.task"),
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  detect(video: HTMLVideoElement): NormalizedLandmark[] | null {
    if (!this.landmarker) return null;

    const timestamp = performance.now();
    if (timestamp <= this.lastTimestamp) return null;
    this.lastTimestamp = timestamp;

    const result = this.landmarker.detectForVideo(video, timestamp);

    if (result.landmarks.length === 0) return null;
    return result.landmarks[0]; // First detected hand
  }

  getFingerTip(landmarks: NormalizedLandmark[]): { x: number; y: number } {
    return {
      x: landmarks[8].x,  // Index finger tip
      y: landmarks[8].y,
    };
  }

  isDrawingGesture(landmarks: NormalizedLandmark[]): boolean {
    return isIndexPointing(landmarks as Point3D[]);
  }

  isEraseGesture(landmarks: NormalizedLandmark[]): boolean {
    return isOpenPalm(landmarks as Point3D[]);
  }

  destroy(): void {
    this.landmarker?.close();
    this.landmarker = null;
  }
}
```
