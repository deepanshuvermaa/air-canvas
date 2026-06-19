/**
 * LoopPlayer — Orchestrates loop playback with artifact injection.
 * Owns the loop <video> element and the ArtifactEngine.
 *
 * Called once per frame from the main compositing loop.
 * Instead of drawing the real camera, the compositing loop calls
 * loopPlayer.drawFrame(ctx, w, h) to draw the looped clip with artifacts.
 */

import { LoopRecorder } from './loop-recorder';
import { ArtifactEngine } from './artifact-engine';

// Usable portion of the recording (trim margins for crossfade)
const CROSSFADE_MARGIN_SEC = 0.25;

export class LoopPlayer {
  private recorder: LoopRecorder;
  private artifactEngine: ArtifactEngine | null = null;

  private loopVideo: HTMLVideoElement | null = null;
  private blobUrl: string | null = null;
  private ready = false;

  // For crossfade at the loop seam
  private loopStartSec = CROSSFADE_MARGIN_SEC;
  private loopEndSec = 5.0; // updated after recording
  private totalDurationSec = 5.5;

  // Downscale canvas for quality-drop artifact
  private offscreenCanvas: HTMLCanvasElement | null = null;
  private offscreenCtx: CanvasRenderingContext2D | null = null;

  constructor() {
    this.recorder = new LoopRecorder();
  }

  /**
   * Record a loop clip from the real camera video element.
   * Must be called before drawFrame() will do anything.
   *
   * @param onProgress - called with seconds remaining during recording
   */
  async prepare(
    realVideoEl: HTMLVideoElement,
    onProgress?: (secondsRemaining: number) => void
  ): Promise<void> {
    // Clean up any previous loop
    this.destroyLoop();

    // Start progress reporting
    let progressInterval: number | undefined;
    if (onProgress) {
      const start = performance.now();
      const durationMs = 5500;
      progressInterval = window.setInterval(() => {
        const elapsed = performance.now() - start;
        const remaining = Math.max(0, Math.ceil((durationMs - elapsed) / 1000));
        onProgress(remaining);
      }, 500);
    }

    try {
      const result = await this.recorder.record(realVideoEl);
      this.blobUrl = result.blobUrl;

      // Create the loop video element
      this.loopVideo = document.createElement('video');
      this.loopVideo.src = this.blobUrl;
      this.loopVideo.loop = false; // we handle looping manually for crossfade
      this.loopVideo.muted = true; // no audio from the loop
      this.loopVideo.playsInline = true;
      this.loopVideo.style.display = 'none';

      // Calculate usable range (trim crossfade margins)
      this.totalDurationSec = result.durationMs / 1000;
      this.loopStartSec = CROSSFADE_MARGIN_SEC;
      this.loopEndSec = this.totalDurationSec - CROSSFADE_MARGIN_SEC;

      // Create artifact engine
      const usableDuration = (this.loopEndSec - this.loopStartSec) * 1000;
      this.artifactEngine = new ArtifactEngine(usableDuration);

      // Create offscreen canvas for quality-drop effect
      this.offscreenCanvas = document.createElement('canvas');
      this.offscreenCtx = this.offscreenCanvas.getContext('2d');

      // Wait for video metadata to load
      await new Promise<void>((resolve, reject) => {
        this.loopVideo!.onloadedmetadata = () => resolve();
        this.loopVideo!.onerror = () => reject(new Error('Failed to load loop video'));
      });

      // Start playback from the usable start point
      this.loopVideo.currentTime = this.loopStartSec;
      await this.loopVideo.play();

      this.ready = true;
    } finally {
      if (progressInterval !== undefined) {
        clearInterval(progressInterval);
      }
    }
  }

  /**
   * Returns true when a loop clip is recorded and ready for playback.
   */
  isReady(): boolean {
    return this.ready && this.loopVideo !== null && this.loopVideo.readyState >= 2;
  }

  /**
   * Set artifact intensity (0 = minimal, 100 = aggressive).
   */
  setIntensity(value: number): void {
    this.artifactEngine?.setIntensity(value);
  }

  /**
   * Draw one frame of the loop onto the compositing canvas.
   * Called from the main requestAnimationFrame loop.
   */
  drawFrame(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (!this.loopVideo || !this.artifactEngine || this.loopVideo.readyState < 2) {
      return;
    }

    // Manual loop: when we reach the end, jump back to start
    if (this.loopVideo.currentTime >= this.loopEndSec) {
      this.loopVideo.currentTime = this.loopStartSec;
    }

    // Get artifact decision for this frame
    const relativeTime = this.loopVideo.currentTime - this.loopStartSec;
    const decision = this.artifactEngine.decide(relativeTime);

    // Apply catch-up jump (after a freeze burst ends)
    if (decision.catchUpJump > 0) {
      this.loopVideo.currentTime = Math.min(
        this.loopVideo.currentTime + decision.catchUpJump,
        this.loopEndSec - 0.1
      );
    }

    // Freeze: skip drawing, leave previous frame on canvas
    if (decision.freeze) {
      return;
    }

    // Quality drop: draw at half resolution then scale up
    if (decision.qualityDrop && this.offscreenCanvas && this.offscreenCtx) {
      const halfW = Math.floor(w / 2);
      const halfH = Math.floor(h / 2);
      this.offscreenCanvas.width = halfW;
      this.offscreenCanvas.height = halfH;
      this.offscreenCtx.drawImage(this.loopVideo, 0, 0, halfW, halfH);

      // Apply alpha if needed (for seam crossfade)
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = decision.alpha;
      ctx.drawImage(this.offscreenCanvas, 0, 0, w, h);
      ctx.globalAlpha = prevAlpha;
      return;
    }

    // Normal frame draw (with optional alpha for seam crossfade)
    if (decision.alpha < 1.0) {
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = decision.alpha;
      ctx.drawImage(this.loopVideo, 0, 0, w, h);
      ctx.globalAlpha = prevAlpha;
    } else {
      ctx.drawImage(this.loopVideo, 0, 0, w, h);
    }
  }

  /**
   * Clean up the loop video and free memory.
   */
  destroy(): void {
    this.destroyLoop();
    this.recorder.destroy();
  }

  private destroyLoop(): void {
    if (this.loopVideo) {
      this.loopVideo.pause();
      this.loopVideo.src = '';
      this.loopVideo.load();
      this.loopVideo = null;
    }
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.artifactEngine = null;
    this.offscreenCanvas = null;
    this.offscreenCtx = null;
    this.ready = false;
  }
}
