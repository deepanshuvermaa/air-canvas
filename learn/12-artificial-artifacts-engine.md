# Artificial Artifacts: Making Loops Look Like Bad Connections

## Why Clean Loops Get Caught

A looping video is easy to detect. The human visual system is extraordinarily sensitive to periodic repetition. Within a few seconds of watching a clean 5-second loop, a viewer's brain locks onto the pattern: a slight head tilt, a blink, a shadow shifting. Once the periodicity is noticed, the illusion collapses.

This is a well-studied phenomenon in visual cognition. The brain runs a continuous novelty-detection process. When a stimulus repeats with metronomic regularity, the brain flags it as artificial. This is why GIF loops feel obviously fake even when the source footage is photorealistic.

Ghost Mode records a 5-second loop of the user's camera feed and plays it back in place of the live camera. If the loop plays back cleanly, the other meeting participants will notice the repetition within 10-15 seconds. The solution: make the loop look like it is being delivered over a bad connection. Stuttering, freezing, pixelation --- these are artifacts people are trained to *ignore*. Nobody troubleshoots someone else's bad WiFi. They just wait for it to clear up.

---

## Anatomy of a Real Bad Connection

To fake convincing artifacts, you need to understand what real ones look like. A video call over a degraded network does not degrade uniformly. The behavior depends on the video codec, the transport protocol, and the adaptive bitrate algorithm.

### WebRTC and Packet Loss

Video calls in the browser use WebRTC, which transports video over RTP/UDP. UDP does not guarantee delivery or ordering. When packets are lost:

1. **I-frames (keyframes)** contain a complete picture. Losing an I-frame packet means the decoder cannot reconstruct the full frame. The result: a completely garbled frame, or the decoder holds the previous frame (freeze).
2. **P-frames (predicted frames)** contain only the difference from the previous frame. Losing a P-frame causes localized corruption --- parts of the image smear, block, or trail. The corruption persists until the next I-frame arrives.
3. **Adaptive bitrate** detects congestion and lowers the video resolution or framerate. This manifests as sudden quality drops: the video becomes blocky, as if someone turned the resolution down from 720p to 360p.

### What Real "Bad WiFi" Looks Like

Real network degradation is **bursty**, not uniform. Packets tend to be lost in clusters because congestion, buffer overflows, and wireless interference are all bursty phenomena. The visual result:

- **Freeze bursts:** The video freezes for 100-500ms (3-15 frames at 30fps), then resumes. The freeze is not a single dropped frame --- it is a sustained pause.
- **Catch-up jumps:** After a freeze, the video often jumps forward slightly. The sender kept sending frames during the freeze; when the connection recovers, the receiver skips ahead to resync with the live stream.
- **Quality drops:** The video suddenly becomes noticeably blockier. This happens when the adaptive bitrate algorithm reacts to packet loss by lowering the encoding quality. The resolution may drop from 720p to 360p for several seconds.
- **Micro-stutters:** Single duplicated frames, scattered irregularly. These are individual P-frame losses where the decoder just holds the previous frame for one extra frame period.
- **Framerate dips:** Instead of smooth 30fps, the video drops to 15fps or lower for a burst. This happens when the encoder reduces framerate to lower bandwidth.

The critical insight: these artifacts are **clustered in time**, not randomly scattered. A connection is either "having a bad moment" or "fine." It oscillates between these states.

---

## Mapping Real Artifacts to Canvas Operations

Ghost Mode's compositing loop calls `ctx.drawImage()` every frame to paint either the live camera or the loop video onto the composite canvas. Every artifact maps to a simple modification of this drawing call.

### Frame Freeze

The simplest artifact. To freeze, skip the `drawImage()` call. The previous frame remains on the canvas because nothing overwrites it.

```javascript
// In the compositing loop
function drawFrame(ctx, w, h) {
  var decision = artifacts.decide(currentTime);

  // Freeze = do nothing. Previous frame stays on canvas.
  if (decision.freeze) return;

  // Normal frame
  ctx.drawImage(loopVideo, 0, 0, w, h);
}
```

This is essentially free in terms of performance. No GPU work, no CPU work. The canvas just keeps displaying what it already has. The browser's double buffering ensures the viewer sees the last completed frame.

### Quality Drop (Downscale-Upscale Trick)

Real adaptive bitrate drops manifest as blocky pixelation. We simulate this without touching any codec by drawing the video frame at half resolution onto a small offscreen canvas, then drawing that small canvas back onto the full-size canvas. The upscaling introduces the same blocky pixelation you see in bitrate-starved video.

```javascript
// Simulate quality drop via downscale-upscale
if (decision.qualityDrop) {
  var halfW = Math.floor(w / 2);
  var halfH = Math.floor(h / 2);

  // Step 1: Draw video at half resolution
  offscreenCanvas.width = halfW;
  offscreenCanvas.height = halfH;
  offscreenCtx.drawImage(loopVideo, 0, 0, halfW, halfH);

  // Step 2: Draw the small canvas onto the full canvas (upscale)
  ctx.drawImage(offscreenCanvas, 0, 0, w, h);
  return;
}
```

Why this works: when you draw a 640x360 image onto a 1280x720 canvas, the browser scales it up. With `imageSmoothingEnabled` left at its default (`true`), the result is a blurry, blocky image. This looks remarkably similar to what happens when a WebRTC encoder drops from high to low bitrate.

### Micro-Stutter

A micro-stutter is a single duplicated frame. The implementation is identical to a freeze, but it only lasts one frame. In the artifact decision engine, this is just a freeze with `freezeFramesRemaining = 1`.

```javascript
// Micro-stutter: random chance of skipping one frame
if (quality < 0.5 && Math.random() < 0.05 * scale) {
  decision.freeze = true;  // Skip exactly one drawImage call
  return decision;
}
```

The viewer perceives a tiny hitch --- the video "catches" for a split second. This is one of the most common real-world artifacts and is almost never consciously noticed.

### Catch-Up Jump

After a freeze burst ends, real video often jumps forward. The sender continued transmitting frames during the freeze; the receiver catches up by skipping ahead. We simulate this by advancing the loop video's `currentTime`:

```javascript
// After a freeze burst ends
if (freezeFramesRemaining <= 0) {
  inFreezeBurst = false;
  decision.freeze = false;

  // Jump forward 50-150ms to simulate catch-up
  decision.catchUpJump = 0.05 + Math.random() * 0.1;
}

// In drawFrame:
if (decision.catchUpJump > 0) {
  loopVideo.currentTime = Math.min(
    loopVideo.currentTime + decision.catchUpJump,
    loopEndSec - 0.1
  );
}
```

The jump amount (50-150ms) is calibrated to be noticeable but not jarring. A jump of 50ms (about 1.5 frames) is barely perceptible. A jump of 150ms (about 4.5 frames) is clearly visible but still within the range of normal network behavior.

### Framerate Dip

A framerate dip reduces the effective framerate by skipping every other frame for a sustained period (500-1500ms). The compositing loop still runs at 30fps, but the artifact engine returns `freeze = true` for roughly half the frames during the dip.

```javascript
// Framerate dip: 50% chance of skipping each frame during the dip
if (inFramerateDip) {
  if (now > framerateDipUntil) {
    // Dip is over
    inFramerateDip = false;
    lastFramerateDipEnd = now;
    nextFramerateDipInterval = 10000 + Math.random() * 10000;
  } else if (Math.random() < 0.5) {
    decision.freeze = true;  // Skip this frame
  }
}
```

The interval between dips is randomized (10-20 seconds) and scaled by intensity. At low intensity, dips are very infrequent. At high intensity, they happen more often.

---

## Randomness Models

The choice of randomness model determines whether the artifacts feel natural or synthetic. This is the single most important design decision in the artifact engine.

### Uniform Random (Bad)

The simplest approach: every frame has an independent, equal probability of exhibiting an artifact.

```javascript
// Uniform random — DO NOT USE
function decideUniform(scale) {
  return {
    freeze: Math.random() < 0.1 * scale,
    qualityDrop: Math.random() < 0.03 * scale,
    catchUpJump: 0,
    alpha: 1.0
  };
}
```

The result looks wrong. Real network degradation does not produce evenly-distributed artifacts. Uniform random produces a "noisy" quality that looks like a damaged sensor, not a bad connection. The brain detects that the artifact distribution is too regular --- it lacks the burstiness of real network problems.

### Sine-Wave Modulation (Good)

Model a "connection quality" value that oscillates smoothly over time. When quality is high, artifacts are rare. When quality dips into a trough, artifacts cluster.

```javascript
function getQuality(now) {
  var t = now / 1000; // Convert to seconds
  var wave = Math.sin(t * frequency * Math.PI * 2 + phase);
  return (wave + 1) / 2; // Normalize to 0-1
}
```

When `quality` is near 0 (trough), the probability of freeze bursts, quality drops, and micro-stutters increases. When `quality` is near 1 (peak), the connection is "good" and few artifacts occur.

This produces bursty behavior: several seconds of clean video, then a rough patch, then clean again. This matches the real-world pattern of network congestion.

### Two Overlapping Sine Waves (Better)

A single sine wave has a perfectly periodic envelope, which can itself become detectable over time. Using two sine waves with different frequencies creates a non-repeating interference pattern:

```javascript
function getQuality(now) {
  var t = now / 1000;

  // Primary wave: slow oscillation (period ~12-20 seconds)
  var w1 = Math.sin(t * waveFreq * Math.PI * 2 + wavePhase);

  // Secondary wave: faster oscillation (period ~5-8 seconds)
  var w2 = Math.sin(t * secondaryFreq * Math.PI * 2 + secondaryPhase);

  // Weighted combination — primary dominates
  return (w1 * 0.6 + w2 * 0.4 + 1) / 2;
}
```

The actual implementation in `GhostArtifacts`:

```javascript
var GhostArtifacts = {
  wavePhase: Math.random() * Math.PI * 2,
  waveFreq: 0.05 + Math.random() * 0.08,       // 0.05-0.13 Hz
  secondaryPhase: Math.random() * Math.PI * 2,
  secondaryFreq: 0.12 + Math.random() * 0.1,    // 0.12-0.22 Hz
  // ...
};
```

The frequencies are randomized at initialization. The primary wave has a period of roughly 8-20 seconds; the secondary wave has a period of roughly 5-8 seconds. Because the two frequencies are incommensurate (they do not share a common period), the combined quality signal never exactly repeats. This makes the artifact pattern feel organic.

### Why Incommensurate Frequencies Matter

If both sine waves had a frequency ratio of exactly 2:1 (say, 0.1 Hz and 0.2 Hz), the combined signal would repeat every 10 seconds. That periodicity could be detected.

When the frequencies are, say, 0.07 Hz and 0.15 Hz, the combined signal's period is `LCM(1/0.07, 1/0.15)` --- which is either very long or, in practice, never repeats within the loop's lifetime. The viewer experiences what feels like random, naturalistic variation.

This is the same principle behind the "golden ratio" tuning of low-frequency oscillators in synthesizers --- irrational frequency ratios produce non-repeating textures.

---

## The Intensity Slider

Ghost Mode exposes an intensity slider (0-100) in the popup UI. This slider scales all artifact probabilities linearly.

```javascript
setIntensity: function (v) {
  this.intensity = Math.max(0, Math.min(100, v));
},

// In decide():
var scale = this.intensity / 100;
if (scale < 0.01) return d; // intensity=0 → no artifacts at all
```

Every probability threshold in the `decide()` function is multiplied by `scale`:

```javascript
// Freeze burst trigger
if (quality < 0.35 * scale && Math.random() < 0.12 * scale) {
  // Start freeze burst
}

// Micro-stutter
if (quality < 0.5 && Math.random() < 0.05 * scale) {
  // Single frame freeze
}

// Freeze burst length
freezeFramesRemaining = 3 + Math.floor(Math.random() * 10 * scale);

// Framerate dip interval
if (now - lastFramerateDipEnd > nextFramerateDipInterval / scale) {
  // Start framerate dip
}
```

The scaling is intentionally linear rather than exponential. At `intensity = 50` (the default), artifact probabilities are halved. At `intensity = 100`, they are at full strength. At `intensity = 10`, the loop plays almost cleanly with only very occasional micro-stutters.

### Why Linear Scaling Works

Linear scaling preserves the relative proportions between artifact types. If freeze bursts are 12% likely and micro-stutters are 5% likely at full intensity, at half intensity they become 6% and 2.5% respectively. The "flavor" of the artifacts stays the same; only the density changes.

An exponential curve would make low intensities feel too clean and high intensities feel too aggressive, with a narrow band of "natural-looking" values in the middle. Linear avoids this cliff effect.

---

## Loop Seam Handling

The loop is a 5-second clip trimmed to avoid the start and end (which may have codec artifacts or recording glitches). When the loop video reaches `loopEndSec`, it resets to `loopStartSec`:

```javascript
// Manual loop (HTML5 video loop attribute is unreliable for gapless looping)
if (loopVideo.currentTime >= loopEndSec) {
  loopVideo.currentTime = loopStartSec;
}
```

The seam --- the point where the video jumps from the end back to the start --- is the most detectable moment. The last frame and the first frame are adjacent in time but may differ noticeably (different head position, different lighting, different expression). This discontinuity is a dead giveaway.

### Masking the Seam with Artifacts

The artifact engine specifically targets the seam. When the current playback position is within 300ms of either end:

```javascript
var loopSec = loopDurationMs / 1000;
var distFromSeam = Math.min(
  videoCurrentTime,
  Math.abs(loopSec - videoCurrentTime)
);

if (distFromSeam < 0.3) {
  // High probability of triggering a freeze burst at the seam
  if (Math.random() < 0.4 * scale) {
    inFreezeBurst = true;
    freezeFramesRemaining = 3 + Math.floor(Math.random() * 5);
    decision.freeze = true;
    return decision;
  }
  // If no freeze, at least reduce alpha slightly
  decision.alpha = 0.92 + Math.random() * 0.08;
}
```

The strategy: freeze the video just before the seam, hold the freeze for a few frames, then let playback resume after the seam has passed. The viewer sees a "connection hiccup" exactly when the discontinuity would be most visible.

The 40% probability (scaled by intensity) means the seam is not always masked. But because the seam occurs every ~5 seconds and the artifact engine also produces freeze bursts elsewhere, the seam freezes blend in with the general pattern of instability. The viewer cannot distinguish "seam freeze" from "normal bad-connection freeze."

### Alpha Fallback

If the random check does not trigger a freeze at the seam, the engine reduces `globalAlpha` slightly (to 0.92-1.0). This subtle transparency blending softens the visual discontinuity. At `alpha = 0.92`, the current frame is blended 92% with the previous frame, creating a very slight crossfade that masks small differences.

```javascript
// In drawFrame:
if (decision.alpha < 1.0) {
  var prev = ctx.globalAlpha;
  ctx.globalAlpha = decision.alpha;
  ctx.drawImage(loopVideo, 0, 0, w, h);
  ctx.globalAlpha = prev;
} else {
  ctx.drawImage(loopVideo, 0, 0, w, h);
}
```

---

## The Decision Engine: Full Flow

The `decide()` function runs once per frame. It returns an object describing what to do:

```javascript
var decision = {
  freeze: false,        // Skip drawImage this frame?
  qualityDrop: false,   // Use downscale-upscale trick?
  catchUpJump: 0,       // Seconds to jump forward (0 = no jump)
  alpha: 1.0            // globalAlpha for drawImage (1.0 = fully opaque)
};
```

The decision priority order matters:

1. **Active freeze burst** (highest priority): If we are in a freeze burst, decrement the counter and return freeze. When the burst ends, set `catchUpJump`.
2. **New freeze burst**: If quality is low and the random check passes, start a new burst.
3. **Micro-stutter**: Independent single-frame freeze.
4. **Loop seam**: If near the seam boundary, inject a freeze or alpha reduction.
5. **Framerate dip**: If in a dip, skip frames with 50% probability.

This priority order ensures freeze bursts are atomic --- once a burst starts, it runs to completion without being interrupted by other artifact types.

---

## The Psychological Principle

The entire artifact system is built on one psychological observation: people are trained to tolerate and ignore bad video connections.

In the era of remote work, everyone has experienced calls where someone's video freezes, pixelates, or drops to slideshow framerate. The universal response is to wait for it to clear up. Nobody says "I think your video is a pre-recorded loop being played through an artifact engine." They think "bad WiFi" and move on.

This social norm is so strong that even aggressive artifacts (frequent freezes, obvious pixelation) are dismissed as network problems rather than deception. The artifact engine exploits this by making the loop look like it is being delivered over a consistently mediocre connection --- not terrible enough to prompt "you should reconnect," but bad enough that the repetition in the underlying loop is masked by the visual noise.

The intensity slider lets the user calibrate this balance. Too low: the loop repetition becomes visible. Too high: someone might ask "are you having connection problems?" The sweet spot is different for every meeting and every audience.

---

## Summary

```
Live Camera → MediaRecorder (5s clip) → Blob URL → <video> element (looping)
                                                          │
                                                          ▼
                                                  GhostArtifacts.decide()
                                                          │
                                              ┌───────────┼──────────────┐
                                              ▼           ▼              ▼
                                          freeze?    qualityDrop?    alpha < 1?
                                              │           │              │
                                         skip draw   downscale/      set ctx.
                                                      upscale        globalAlpha
                                                          │              │
                                                          ▼              ▼
                                                    ctx.drawImage(loopVideo)
                                                          │
                                                          ▼
                                                  compositeCanvas
                                                          │
                                                          ▼
                                                  captureStream(30)
                                                          │
                                                          ▼
                                                  Meeting app sees
                                                  "bad connection"
```

Each component --- the sine-wave quality model, the freeze burst state machine, the seam masking, the intensity scaling --- is simple on its own. The realism comes from their interaction: two incommensurate sine waves modulating a probability space, with bursty freeze states and seam-targeted masking. The result looks like a real bad connection because it is modeled on how real bad connections behave.
