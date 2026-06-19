/**
 * ArtifactEngine — Generates realistic "bad connection" artifacts
 * to make a looping video clip indistinguishable from a flaky webcam feed.
 *
 * Uses a sine-wave-based "connection quality" model to produce bursty
 * artifact patterns (like real packet loss) instead of uniform random drops.
 */

export interface ArtifactDecision {
  /** true = skip drawImage, reuse the previous frame */
  freeze: boolean;
  /** true = draw at 50% res then scale up (pixelation) */
  qualityDrop: boolean;
  /** seconds to jump forward on the loop video after a freeze burst ends */
  catchUpJump: number;
  /** alpha for crossfade blending (1.0 = fully opaque, <1.0 = blending) */
  alpha: number;
}

export class ArtifactEngine {
  // ─── Tuning knobs ───
  private intensity: number;    // 0-100, user-controlled via slider

  // ─── Sine-wave connection quality model ───
  private wavePhase: number;
  private waveFreq: number;     // oscillations per second
  private secondaryPhase: number;
  private secondaryFreq: number;

  // ─── Freeze burst state ───
  private inFreezeBurst = false;
  private freezeFramesRemaining = 0;
  private totalFreezeFrames = 0;

  // ─── Framerate dip state ───
  private inFramerateDip = false;
  private framerateDipUntil = 0;
  private lastFramerateDipEnd = 0;
  private nextFramerateDipInterval: number;

  // ─── Loop seam ───
  private loopDurationMs: number;

  constructor(loopDurationMs: number, intensity = 50) {
    this.intensity = intensity;
    this.loopDurationMs = loopDurationMs;

    // Randomize wave parameters so each session feels different
    this.wavePhase     = Math.random() * Math.PI * 2;
    this.waveFreq      = 0.05 + Math.random() * 0.08; // period ~8-20s
    this.secondaryPhase = Math.random() * Math.PI * 2;
    this.secondaryFreq  = 0.12 + Math.random() * 0.1;  // faster secondary wave

    this.nextFramerateDipInterval = 10000 + Math.random() * 10000;
    this.lastFramerateDipEnd = performance.now();
  }

  /**
   * Set artifact intensity (0 = almost no artifacts, 100 = very aggressive).
   */
  setIntensity(value: number): void {
    this.intensity = Math.max(0, Math.min(100, value));
  }

  /**
   * Called once per frame. Returns what artifacts to apply this frame.
   * @param videoCurrentTime - current playback position of the loop video (seconds)
   */
  decide(videoCurrentTime: number): ArtifactDecision {
    const now = performance.now();
    const scale = this.intensity / 100;

    // Connection quality: 0.0 = terrible, 1.0 = fine
    const quality = this.getConnectionQuality(now);

    const decision: ArtifactDecision = {
      freeze: false,
      qualityDrop: false,
      catchUpJump: 0,
      alpha: 1.0,
    };

    // If intensity is 0, return clean frames
    if (scale < 0.01) return decision;

    // ─── Freeze bursts ───
    if (this.inFreezeBurst) {
      this.freezeFramesRemaining--;
      decision.freeze = true;

      // Quality drop during freezes (more likely mid-burst)
      if (Math.random() < 0.15 * scale) {
        decision.qualityDrop = true;
      }

      if (this.freezeFramesRemaining <= 0) {
        // End of freeze burst — do a catch-up jump
        this.inFreezeBurst = false;
        decision.freeze = false; // draw this frame (the catch-up frame)
        decision.catchUpJump = 0.05 + Math.random() * 0.1; // jump 50-150ms ahead
      }

      return decision;
    }

    // ─── Should we start a new freeze burst? ───
    // Higher chance when connection quality is low
    const freezeThreshold = 0.35 * scale;
    if (quality < freezeThreshold && Math.random() < 0.12 * scale) {
      this.inFreezeBurst = true;
      // Burst length: 3-12 frames (100-400ms at 30fps)
      this.totalFreezeFrames = 3 + Math.floor(Math.random() * 10 * scale);
      this.freezeFramesRemaining = this.totalFreezeFrames;
      decision.freeze = true;
      return decision;
    }

    // ─── Micro-stutter (draw same frame twice) ───
    // Implemented by freezing for exactly 1 frame
    if (quality < 0.5 && Math.random() < 0.05 * scale) {
      decision.freeze = true;
      return decision;
    }

    // ─── Loop seam artifact injection ───
    // Near the loop point, always inject a small freeze to mask the seam
    const loopDurationSec = this.loopDurationMs / 1000;
    const distFromSeam = Math.min(
      videoCurrentTime,                         // distance from start
      Math.abs(loopDurationSec - videoCurrentTime) // distance from end
    );
    if (distFromSeam < 0.3) {
      // Within 300ms of the seam — high chance of freeze
      if (Math.random() < 0.4 * scale) {
        this.inFreezeBurst = true;
        this.totalFreezeFrames = 3 + Math.floor(Math.random() * 5);
        this.freezeFramesRemaining = this.totalFreezeFrames;
        decision.freeze = true;
        return decision;
      }
      // Even if no freeze, apply slight alpha jitter near seam
      decision.alpha = 0.92 + Math.random() * 0.08;
    }

    // ─── Framerate dip ───
    if (this.inFramerateDip) {
      if (now > this.framerateDipUntil) {
        this.inFramerateDip = false;
        this.lastFramerateDipEnd = now;
        this.nextFramerateDipInterval = 10000 + Math.random() * 10000;
      } else {
        // During dip: skip every other frame (simulates 15fps)
        if (Math.random() < 0.5) {
          decision.freeze = true;
        }
      }
    } else if (now - this.lastFramerateDipEnd > this.nextFramerateDipInterval * (1 / scale)) {
      // Start a framerate dip (lasts 500ms - 1500ms)
      this.inFramerateDip = true;
      this.framerateDipUntil = now + 500 + Math.random() * 1000;
    }

    return decision;
  }

  /**
   * Sine-wave connection quality model.
   * Two sine waves with different frequencies create a non-repeating,
   * bursty quality pattern that feels like real network conditions.
   */
  private getConnectionQuality(now: number): number {
    const t = now / 1000; // seconds
    const wave1 = Math.sin(t * this.waveFreq * Math.PI * 2 + this.wavePhase);
    const wave2 = Math.sin(t * this.secondaryFreq * Math.PI * 2 + this.secondaryPhase);

    // Combine: primary wave sets the broad pattern, secondary adds jitter
    // Range: 0.0 to 1.0
    const combined = (wave1 * 0.6 + wave2 * 0.4 + 1) / 2;

    return combined;
  }
}
