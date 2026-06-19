import { DrawingEngine } from '../drawing/drawing-engine';
import { HandTracker } from '../tracking/hand-tracker';
import { GestureState, AirDrawSettings, DEFAULT_SETTINGS } from '../types/messages';
import { GestureResult } from '../tracking/gesture-detector';

/**
 * StreamHijack — the core of AirDraw.
 *
 * This module patches navigator.mediaDevices.getUserMedia so that when
 * a meeting app (Meet, Zoom, Teams) requests the camera, we:
 *
 * 1. Call the REAL getUserMedia to get the actual camera stream
 * 2. Draw each camera frame onto a hidden canvas
 * 3. Run hand tracking on the same frames
 * 4. Overlay any drawn strokes on top of the camera frame
 * 5. Return canvas.captureStream() instead of the real camera
 *
 * The meeting app has no idea. It receives a MediaStream that looks
 * and acts exactly like a camera stream — because it is one, just
 * with our ink composited in.
 *
 * IMPORTANT: This must run in the MAIN world (not ISOLATED) because
 * we need to patch the page's actual navigator.mediaDevices object.
 * Content scripts in ISOLATED world get their own navigator object
 * that the page's JS never sees.
 */

export class StreamHijack {
  private drawingEngine: DrawingEngine | null = null;
  private handTracker: HandTracker | null = null;
  private realStream: MediaStream | null = null;
  private fakeStream: MediaStream | null = null;
  private compositeCanvas: HTMLCanvasElement | null = null;
  private compositeCtx: CanvasRenderingContext2D | null = null;
  private drawingCanvas: HTMLCanvasElement | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private renderLoopId: number | null = null;
  private enabled: boolean = false;
  private settings: AirDrawSettings = { ...DEFAULT_SETTINGS };
  private previousGestureState: GestureState = GestureState.IDLE;
  private originalGetUserMedia: typeof navigator.mediaDevices.getUserMedia | null = null;
  private isPatched: boolean = false;

  /**
   * Patch getUserMedia. Call this once, early (document_start).
   * The patch is always active but only composites when enabled=true.
   * When disabled, it passes through the real stream unmodified.
   */
  patchGetUserMedia(): void {
    if (this.isPatched) return;

    const self = this;
    this.originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );

    navigator.mediaDevices.getUserMedia = async function (
      constraints?: MediaStreamConstraints
    ): Promise<MediaStream> {
      // Only intercept video requests
      if (!constraints?.video) {
        return self.originalGetUserMedia!(constraints);
      }

      console.log('[AirDraw] Intercepted getUserMedia call', constraints);

      // Get the real camera stream
      const realStream = await self.originalGetUserMedia!(constraints);
      self.realStream = realStream;

      // If AirDraw is not enabled, return the real stream
      // (but save a reference so we can swap later)
      if (!self.enabled) {
        return realStream;
      }

      // Build and return the composited stream
      return self.buildCompositeStream(realStream);
    };

    this.isPatched = true;
    console.log('[AirDraw] getUserMedia patched');
  }

  /**
   * Build the compositing pipeline:
   * real video → canvas → hand tracking + drawing overlay → fake stream
   */
  private async buildCompositeStream(realStream: MediaStream): Promise<MediaStream> {
    const videoTrack = realStream.getVideoTracks()[0];
    const trackSettings = videoTrack.getSettings();
    const width = trackSettings.width || 640;
    const height = trackSettings.height || 480;

    // Create hidden video element to read camera frames
    this.videoElement = document.createElement('video');
    this.videoElement.srcObject = realStream;
    this.videoElement.autoplay = true;
    this.videoElement.playsInline = true;
    this.videoElement.muted = true;
    // Don't append to DOM — keep it invisible
    await this.videoElement.play();

    // Create the composite canvas (camera + ink)
    this.compositeCanvas = document.createElement('canvas');
    this.compositeCanvas.width = width;
    this.compositeCanvas.height = height;
    this.compositeCtx = this.compositeCanvas.getContext('2d')!;

    // Create the drawing overlay canvas
    this.drawingCanvas = document.createElement('canvas');
    this.drawingCanvas.width = width;
    this.drawingCanvas.height = height;

    // Initialize drawing engine
    this.drawingEngine = new DrawingEngine(this.drawingCanvas);
    this.drawingEngine.updateSettings(this.settings);
    this.drawingEngine.startRenderLoop();

    // Initialize hand tracking
    this.handTracker = new HandTracker(width, height, this.settings.gestureDebounceFrames);
    await this.handTracker.initialize();
    this.handTracker.onGestureDetected(this.handleGesture.bind(this));
    this.handTracker.startTracking(this.videoElement);

    // Start the compositing render loop
    this.startCompositing();

    // Capture the composite canvas as a stream
    // 30fps is standard for video calls
    this.fakeStream = this.compositeCanvas.captureStream(30);

    // Copy audio tracks from the real stream (if any)
    for (const audioTrack of realStream.getAudioTracks()) {
      this.fakeStream.addTrack(audioTrack);
    }

    console.log(`[AirDraw] Composite stream ready (${width}x${height})`);
    return this.fakeStream;
  }

  /**
   * The compositing loop: runs every frame, draws camera + ink onto
   * the composite canvas.
   */
  private startCompositing(): void {
    if (this.renderLoopId !== null) return;

    const composite = () => {
      this.renderLoopId = requestAnimationFrame(composite);

      if (!this.compositeCtx || !this.videoElement || !this.drawingCanvas) return;

      // Layer 1: Draw the real camera frame
      this.compositeCtx.drawImage(
        this.videoElement,
        0, 0,
        this.compositeCanvas!.width,
        this.compositeCanvas!.height
      );

      // Layer 2: Draw the ink overlay on top
      this.compositeCtx.drawImage(
        this.drawingCanvas,
        0, 0
      );
    };

    this.renderLoopId = requestAnimationFrame(composite);
  }

  private stopCompositing(): void {
    if (this.renderLoopId !== null) {
      cancelAnimationFrame(this.renderLoopId);
      this.renderLoopId = null;
    }
  }

  /**
   * Handle gesture results from the hand tracker.
   * This is the bridge between tracking and drawing.
   */
  private handleGesture(result: GestureResult): void {
    if (!this.drawingEngine) return;

    const { state, fingerTip } = result;

    // Update cursor
    this.drawingEngine.setCursor(fingerTip, state === GestureState.DRAWING);

    // State transitions
    if (state === GestureState.DRAWING && fingerTip) {
      if (this.previousGestureState !== GestureState.DRAWING) {
        // Just started drawing
        this.drawingEngine.beginStroke(fingerTip);
      } else {
        // Continue drawing
        this.drawingEngine.addPoint(fingerTip);
      }
    } else if (this.previousGestureState === GestureState.DRAWING) {
      // Just stopped drawing
      this.drawingEngine.endStroke();
    }

    // Erase gesture (open palm)
    if (state === GestureState.ERASING && this.previousGestureState !== GestureState.ERASING) {
      this.drawingEngine.clear();
    }

    this.previousGestureState = state;
  }

  /** Enable AirDraw compositing */
  async enable(): Promise<void> {
    this.enabled = true;

    // If we already have a real stream (user joined call before enabling),
    // we need to rebuild the composite pipeline
    if (this.realStream && !this.fakeStream) {
      const fakeStream = await this.buildCompositeStream(this.realStream);

      // Replace the video track in the real stream with our composited one
      // This is the "late activation" fix — we swap tracks on the existing stream
      const realVideoTrack = this.realStream.getVideoTracks()[0];
      const fakeVideoTrack = fakeStream.getVideoTracks()[0];

      // Some meeting apps monitor the original stream object, so we
      // try to replace the track in-place if possible
      try {
        this.realStream.removeTrack(realVideoTrack);
        this.realStream.addTrack(fakeVideoTrack);
      } catch {
        // If in-place replacement fails, the next getUserMedia call
        // will return our composited stream
        console.warn('[AirDraw] Late activation: track swap failed, will activate on next camera request');
      }
    }

    console.log('[AirDraw] Enabled');
  }

  /** Disable AirDraw — pass through real camera */
  disable(): void {
    this.enabled = false;

    this.stopCompositing();
    this.handTracker?.stopTracking();
    this.drawingEngine?.stopRenderLoop();

    // Restore real video track if we swapped it
    if (this.realStream && this.fakeStream) {
      const realVideoTrack = this.realStream.getVideoTracks()[0];
      // The meeting app will continue using whatever stream it has.
      // On next getUserMedia call, it'll get the real stream.
    }

    this.fakeStream = null;
    console.log('[AirDraw] Disabled');
  }

  /** Toggle on/off */
  async toggle(): Promise<boolean> {
    if (this.enabled) {
      this.disable();
    } else {
      await this.enable();
    }
    return this.enabled;
  }

  /** Update settings */
  updateSettings(settings: Partial<AirDrawSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.drawingEngine?.updateSettings(settings);
  }

  /** Clear the canvas */
  clearCanvas(): void {
    this.drawingEngine?.clear();
  }

  /** Undo last stroke */
  undoStroke(): void {
    this.drawingEngine?.undo();
  }

  /** Redo last undone stroke */
  redoStroke(): void {
    this.drawingEngine?.redo();
  }

  /** Export drawing as PNG */
  exportImage(): string | null {
    return this.drawingEngine?.exportAsImage() ?? null;
  }

  /** Check if currently enabled */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Check if hand tracking is active */
  isTracking(): boolean {
    return this.handTracker !== null && this.enabled;
  }

  /** Clean up everything */
  destroy(): void {
    this.disable();
    this.handTracker?.destroy();

    if (this.originalGetUserMedia && this.isPatched) {
      navigator.mediaDevices.getUserMedia = this.originalGetUserMedia;
      this.isPatched = false;
    }

    this.realStream = null;
    this.videoElement = null;
    this.compositeCanvas = null;
    this.compositeCtx = null;
    this.drawingCanvas = null;
    this.drawingEngine = null;
    this.handTracker = null;
  }
}
