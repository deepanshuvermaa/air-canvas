import { GestureState, Point } from '../types/messages';

/**
 * Gesture state machine + finger pose detection.
 *
 * MediaPipe Hand Landmarker gives us 21 landmarks per hand.
 * We use specific landmarks to detect finger poses:
 *
 * Landmark indices:
 *   0: wrist
 *   1-4: thumb (CMC, MCP, IP, TIP)
 *   5-8: index finger (MCP, PIP, DIP, TIP)
 *   9-12: middle finger (MCP, PIP, DIP, TIP)
 *   13-16: ring finger (MCP, PIP, DIP, TIP)
 *   17-20: pinky (MCP, PIP, DIP, TIP)
 *
 * "Pointing" gesture = index finger extended, others curled:
 *   - Index TIP (8) is above Index PIP (6) — finger is straight
 *   - Middle TIP (12) is below Middle PIP (10) — curled
 *   - Ring TIP (16) is below Ring PIP (14) — curled
 *   - Pinky TIP (20) is below Pinky PIP (18) — curled
 *
 * "Open palm" = all fingers extended (used for erase mode)
 * "Fist" / anything else = IDLE
 */

export interface HandLandmark {
  x: number;  // normalized 0-1
  y: number;  // normalized 0-1
  z: number;  // depth (unused for 2D drawing)
}

export interface GestureResult {
  state: GestureState;
  fingerTip: Point | null;    // index finger tip position (canvas coords)
  confidence: number;          // 0-1
}

export class GestureDetector {
  private currentState: GestureState = GestureState.IDLE;
  private stateFrameCount: number = 0;
  private debounceThreshold: number;
  private canvasWidth: number;
  private canvasHeight: number;
  private lastSmoothedPoint: Point | null = null;
  private smoothingAlpha: number = 0.4;

  constructor(
    canvasWidth: number,
    canvasHeight: number,
    debounceFrames: number = 3
  ) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
    this.debounceThreshold = debounceFrames;
  }

  updateDimensions(width: number, height: number): void {
    this.canvasWidth = width;
    this.canvasHeight = height;
  }

  /**
   * Process a set of hand landmarks and return the current gesture state.
   * Returns null if no hand is detected.
   */
  detect(landmarks: HandLandmark[] | null): GestureResult {
    if (!landmarks || landmarks.length < 21) {
      return this.transition(GestureState.IDLE, null, 0);
    }

    const indexExtended = this.isFingerExtended(landmarks, 'index');
    const middleExtended = this.isFingerExtended(landmarks, 'middle');
    const ringExtended = this.isFingerExtended(landmarks, 'ring');
    const pinkyExtended = this.isFingerExtended(landmarks, 'pinky');

    const fingerTip = this.landmarkToCanvas(landmarks[8]); // index tip

    // Open palm: all fingers extended
    if (indexExtended && middleExtended && ringExtended && pinkyExtended) {
      return this.transition(GestureState.ERASING, fingerTip, 0.9);
    }

    // Pointing: only index extended
    if (indexExtended && !middleExtended && !ringExtended && !pinkyExtended) {
      return this.transition(GestureState.DRAWING, fingerTip, 0.95);
    }

    // Peace sign / two fingers: hovering (index + middle extended)
    if (indexExtended && middleExtended && !ringExtended && !pinkyExtended) {
      return this.transition(GestureState.HOVERING, fingerTip, 0.85);
    }

    // Default: hand is visible but no recognized gesture
    return this.transition(GestureState.HOVERING, fingerTip, 0.5);
  }

  private isFingerExtended(
    landmarks: HandLandmark[],
    finger: 'index' | 'middle' | 'ring' | 'pinky'
  ): boolean {
    const indices = {
      index: { tip: 8, pip: 6, mcp: 5 },
      middle: { tip: 12, pip: 10, mcp: 9 },
      ring: { tip: 16, pip: 14, mcp: 13 },
      pinky: { tip: 20, pip: 18, mcp: 17 },
    };

    const { tip, pip, mcp } = indices[finger];
    // Finger is extended if tip is further from wrist than PIP
    // Using y-coordinate: in normalized coords, lower y = higher on screen
    // But this only works when hand is upright. More robust: compare distances.
    const tipToPip = Math.sqrt(
      (landmarks[tip].x - landmarks[pip].x) ** 2 +
      (landmarks[tip].y - landmarks[pip].y) ** 2
    );
    const mcpToPip = Math.sqrt(
      (landmarks[mcp].x - landmarks[pip].x) ** 2 +
      (landmarks[mcp].y - landmarks[pip].y) ** 2
    );

    // Extended if tip-to-pip distance is greater than mcp-to-pip
    // (i.e., finger is straightened out, not curled back)
    return tipToPip > mcpToPip * 0.8;
  }

  private landmarkToCanvas(landmark: HandLandmark): Point {
    // MediaPipe gives normalized coords (0-1). Convert to canvas pixels.
    // Note: x is mirrored (webcam is mirrored) — we flip it here.
    const raw: Point = {
      x: (1 - landmark.x) * this.canvasWidth,
      y: landmark.y * this.canvasHeight,
      timestamp: Date.now(),
    };

    // Apply EMA smoothing
    if (this.lastSmoothedPoint) {
      const smoothed: Point = {
        x: this.smoothingAlpha * raw.x + (1 - this.smoothingAlpha) * this.lastSmoothedPoint.x,
        y: this.smoothingAlpha * raw.y + (1 - this.smoothingAlpha) * this.lastSmoothedPoint.y,
        timestamp: raw.timestamp,
      };
      this.lastSmoothedPoint = smoothed;
      return smoothed;
    }

    this.lastSmoothedPoint = raw;
    return raw;
  }

  /**
   * Transition to a new state with hysteresis (debouncing).
   * The state only changes if the new state persists for N consecutive frames.
   * This prevents flickering between DRAWING and IDLE when the gesture is ambiguous.
   */
  private transition(
    candidateState: GestureState,
    fingerTip: Point | null,
    confidence: number
  ): GestureResult {
    if (candidateState === this.currentState) {
      this.stateFrameCount++;
    } else {
      this.stateFrameCount++;
      if (this.stateFrameCount >= this.debounceThreshold) {
        this.currentState = candidateState;
        this.stateFrameCount = 0;
        if (candidateState === GestureState.IDLE) {
          this.lastSmoothedPoint = null;
        }
      }
    }

    return {
      state: this.currentState,
      fingerTip,
      confidence,
    };
  }

  reset(): void {
    this.currentState = GestureState.IDLE;
    this.stateFrameCount = 0;
    this.lastSmoothedPoint = null;
  }
}
