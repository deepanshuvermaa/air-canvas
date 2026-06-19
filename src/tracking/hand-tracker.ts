import { GestureDetector, GestureResult, HandLandmark } from './gesture-detector';
import { GestureState } from '../types/messages';

/**
 * HandTracker wraps the MediaPipe Hand Landmarker and feeds results
 * into our GestureDetector state machine.
 *
 * Architecture:
 *   Video frame → MediaPipe Hand Landmarker → raw landmarks
 *   Raw landmarks → GestureDetector → GestureResult (state + finger position)
 *   GestureResult → DrawingEngine (begin/add/end stroke)
 *
 * MediaPipe runs entirely client-side using WASM. No data ever leaves
 * the browser. The WASM files are bundled with the extension and loaded
 * from web_accessible_resources.
 */

// MediaPipe types (we define our own minimal interface rather than
// importing the full package, to keep bundle size down)
interface HandLandmarkerResult {
  landmarks: Array<Array<{ x: number; y: number; z: number }>>;
  handedness: Array<Array<{ categoryName: string; score: number }>>;
}

interface HandLandmarkerInstance {
  detectForVideo(video: HTMLVideoElement, timestamp: number): HandLandmarkerResult;
  close(): void;
}

export class HandTracker {
  private gestureDetector: GestureDetector;
  private landmarker: HandLandmarkerInstance | null = null;
  private isInitialized: boolean = false;
  private isProcessing: boolean = false;
  private onGesture: ((result: GestureResult) => void) | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private animFrameId: number | null = null;
  private frameSkip: number = 0; // process every Nth frame for performance
  private frameCount: number = 0;

  constructor(canvasWidth: number, canvasHeight: number, debounceFrames: number = 3) {
    this.gestureDetector = new GestureDetector(canvasWidth, canvasHeight, debounceFrames);
  }

  /**
   * Initialize the MediaPipe Hand Landmarker.
   * This is async because it loads the WASM module and ML model.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Dynamic import — MediaPipe is loaded only when needed
      const vision = await import('@mediapipe/tasks-vision');

      const { HandLandmarker, FilesetResolver } = vision;

      // Load the WASM fileset
      const wasmFileset = await FilesetResolver.forVisionTasks(
        // In extension context, these are served from web_accessible_resources
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      );

      // Create the hand landmarker
      this.landmarker = await HandLandmarker.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU', // Use WebGL when available, falls back to CPU
        },
        runningMode: 'VIDEO',
        numHands: 1, // Single hand for MVP
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }) as unknown as HandLandmarkerInstance;

      this.isInitialized = true;
      console.log('[AirDraw] Hand tracker initialized');
    } catch (error) {
      console.error('[AirDraw] Failed to initialize hand tracker:', error);
      throw error;
    }
  }

  /** Set the callback for gesture detection results */
  onGestureDetected(callback: (result: GestureResult) => void): void {
    this.onGesture = callback;
  }

  /** Start processing frames from a video element */
  startTracking(videoElement: HTMLVideoElement, frameSkip: number = 0): void {
    this.videoElement = videoElement;
    this.frameSkip = frameSkip;
    this.frameCount = 0;

    if (this.animFrameId !== null) return; // already running

    const processFrame = () => {
      this.animFrameId = requestAnimationFrame(processFrame);

      // Frame skipping for performance on lower-end hardware
      this.frameCount++;
      if (this.frameSkip > 0 && this.frameCount % (this.frameSkip + 1) !== 0) {
        return;
      }

      if (
        !this.landmarker ||
        !this.videoElement ||
        this.videoElement.readyState < 2 || // HAVE_CURRENT_DATA
        this.isProcessing
      ) {
        return;
      }

      this.isProcessing = true;

      try {
        const result = this.landmarker.detectForVideo(
          this.videoElement,
          performance.now()
        );

        let landmarks: HandLandmark[] | null = null;
        if (result.landmarks && result.landmarks.length > 0) {
          landmarks = result.landmarks[0] as HandLandmark[];
        }

        const gesture = this.gestureDetector.detect(landmarks);

        if (this.onGesture) {
          this.onGesture(gesture);
        }
      } catch (error) {
        // Silently skip frames that fail (e.g., video not ready)
        // Don't flood the console — this can happen transiently
      } finally {
        this.isProcessing = false;
      }
    };

    this.animFrameId = requestAnimationFrame(processFrame);
    console.log('[AirDraw] Hand tracking started');
  }

  /** Stop processing frames */
  stopTracking(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.gestureDetector.reset();
    this.videoElement = null;
    console.log('[AirDraw] Hand tracking stopped');
  }

  /** Update canvas dimensions (e.g., on resize) */
  updateDimensions(width: number, height: number): void {
    this.gestureDetector.updateDimensions(width, height);
  }

  /** Clean up resources */
  destroy(): void {
    this.stopTracking();
    if (this.landmarker) {
      this.landmarker.close();
      this.landmarker = null;
    }
    this.isInitialized = false;
  }
}
