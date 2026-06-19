# Gesture Recognition & State Machines

## Why a State Machine?

Hand tracking is inherently noisy. In a single second at 30 fps, MediaPipe might report:

- Frame 1-8: Index pointing (DRAWING)
- Frame 9: Briefly misdetected as open palm (ERASING)
- Frame 10-15: Index pointing again (DRAWING)
- Frame 16: No hand detected (IDLE)
- Frame 17-30: Index pointing (DRAWING)

If you directly map each frame's gesture to an action, the user sees their drawing interrupted by random erase flashes and idle gaps. The experience is terrible.

A state machine introduces **order** into this chaos. It defines exactly which states exist, which transitions are valid, and under what conditions transitions occur. Combined with debouncing and hysteresis, it produces stable, predictable behavior from noisy input.

---

## What Is a Finite State Machine (FSM)?

A finite state machine is a computational model with:

1. **A finite set of states** — the machine is always in exactly one state
2. **Transitions** — rules that move the machine from one state to another
3. **Events/inputs** — triggers that cause transitions
4. **Actions** — side effects that occur on transitions or while in a state

An FSM is "finite" because it has a fixed number of states (unlike, say, a Turing machine with infinite tape). For gesture recognition, this constraint is a feature — it forces you to enumerate every possible behavior.

---

## AirDraw's States

```typescript
enum GestureState {
  IDLE = "IDLE",
  DRAWING = "DRAWING",
  HOVERING = "HOVERING",
  ERASING = "ERASING",
}
```

### IDLE

The hand is not detected, or the hand is in a neutral position (fist, relaxed hand). No drawing or erasing occurs.

**Entry actions:** Stop any active stroke. Hide the cursor indicator.
**During:** Nothing happens visually. MediaPipe continues running to detect when the hand returns.

### HOVERING

The index finger is pointing, but the user has not committed to drawing yet. A cursor indicator (dot or crosshair) shows where drawing would occur.

**Entry actions:** Show the cursor indicator at the finger position.
**During:** Move the cursor indicator to follow the finger.
**Purpose:** Gives the user visual feedback before they start drawing. Also serves as a buffer state — you enter HOVERING first, then transition to DRAWING if the gesture is sustained.

### DRAWING

The user is actively drawing. The index finger is pointing, and the gesture has been stable for enough frames.

**Entry actions:** Begin a new stroke path at the current finger position.
**During:** Extend the stroke path to follow the finger.
**Exit actions:** Finalize the stroke.

### ERASING

The user has an open palm, indicating they want to erase.

**Entry actions:** Switch the cursor to an eraser indicator.
**During:** Erase ink within the eraser radius around the palm center.
**Exit actions:** Hide the eraser indicator.

---

## State Transition Diagram

```
                  hand detected,
                  index pointing
          ┌───────────────────────────┐
          │                           ▼
        IDLE ─────────────────────► HOVERING
          ▲                           │
          │                           │ stable for N frames
          │                           ▼
          │                       DRAWING
          │                           │
          │     hand lost /           │
          │     neutral pose          │
          └───────────────────────────┘
          ▲
          │
          │     hand lost /
          │     neutral pose
          │
        ERASING
          ▲
          │     open palm detected
          │     (from any state)
          └───────────────────────────┘
```

### Valid Transitions

| From | To | Trigger |
|---|---|---|
| IDLE | HOVERING | Index pointing detected |
| IDLE | ERASING | Open palm detected |
| HOVERING | DRAWING | Index pointing stable for N frames |
| HOVERING | IDLE | Hand lost or neutral pose |
| HOVERING | ERASING | Open palm detected |
| DRAWING | IDLE | Hand lost or neutral pose |
| DRAWING | ERASING | Open palm detected |
| ERASING | IDLE | Hand lost or neutral pose |
| ERASING | HOVERING | Index pointing detected |

### Invalid Transitions (Blocked by the FSM)

| From | To | Why Blocked |
|---|---|---|
| IDLE | DRAWING | Must pass through HOVERING first (prevents accidental strokes) |
| DRAWING | HOVERING | Once drawing, you are drawing until you stop. No ambiguous "maybe drawing" state. |

---

## Implementation

```typescript
enum GestureState {
  IDLE = "IDLE",
  DRAWING = "DRAWING",
  HOVERING = "HOVERING",
  ERASING = "ERASING",
}

interface GestureInput {
  handDetected: boolean;
  isIndexPointing: boolean;
  isOpenPalm: boolean;
  fingerX: number;
  fingerY: number;
}

class GestureStateMachine {
  private state: GestureState = GestureState.IDLE;
  private framesInCurrentGesture = 0;
  private readonly HOVER_TO_DRAW_FRAMES = 5; // ~170ms at 30fps

  // Callbacks for state actions
  constructor(
    private onStartStroke: (x: number, y: number) => void,
    private onContinueStroke: (x: number, y: number) => void,
    private onEndStroke: () => void,
    private onShowCursor: (x: number, y: number) => void,
    private onHideCursor: () => void,
    private onErase: (x: number, y: number) => void,
  ) {}

  /** Called every frame with the latest gesture detection results */
  update(input: GestureInput): void {
    const prevState = this.state;

    switch (this.state) {
      case GestureState.IDLE:
        this.handleIdle(input);
        break;
      case GestureState.HOVERING:
        this.handleHovering(input);
        break;
      case GestureState.DRAWING:
        this.handleDrawing(input);
        break;
      case GestureState.ERASING:
        this.handleErasing(input);
        break;
    }

    // Log state transitions for debugging
    if (this.state !== prevState) {
      console.log(`Gesture: ${prevState} -> ${this.state}`);
    }
  }

  private handleIdle(input: GestureInput): void {
    if (!input.handDetected) return;

    if (input.isOpenPalm) {
      this.transitionTo(GestureState.ERASING);
    } else if (input.isIndexPointing) {
      this.transitionTo(GestureState.HOVERING);
      this.onShowCursor(input.fingerX, input.fingerY);
    }
  }

  private handleHovering(input: GestureInput): void {
    if (!input.handDetected || (!input.isIndexPointing && !input.isOpenPalm)) {
      this.transitionTo(GestureState.IDLE);
      this.onHideCursor();
      return;
    }

    if (input.isOpenPalm) {
      this.transitionTo(GestureState.ERASING);
      this.onHideCursor();
      return;
    }

    // Still pointing — update cursor and count stable frames
    this.onShowCursor(input.fingerX, input.fingerY);
    this.framesInCurrentGesture++;

    if (this.framesInCurrentGesture >= this.HOVER_TO_DRAW_FRAMES) {
      this.transitionTo(GestureState.DRAWING);
      this.onHideCursor();
      this.onStartStroke(input.fingerX, input.fingerY);
    }
  }

  private handleDrawing(input: GestureInput): void {
    if (!input.handDetected || !input.isIndexPointing) {
      this.transitionTo(GestureState.IDLE);
      this.onEndStroke();

      // If the hand switched to open palm, go to ERASING
      if (input.handDetected && input.isOpenPalm) {
        this.transitionTo(GestureState.ERASING);
      }
      return;
    }

    // Continue drawing
    this.onContinueStroke(input.fingerX, input.fingerY);
  }

  private handleErasing(input: GestureInput): void {
    if (!input.handDetected || !input.isOpenPalm) {
      if (input.handDetected && input.isIndexPointing) {
        this.transitionTo(GestureState.HOVERING);
        this.onShowCursor(input.fingerX, input.fingerY);
      } else {
        this.transitionTo(GestureState.IDLE);
      }
      return;
    }

    // Continue erasing
    this.onErase(input.fingerX, input.fingerY);
  }

  private transitionTo(newState: GestureState): void {
    this.state = newState;
    this.framesInCurrentGesture = 0;
  }

  getState(): GestureState {
    return this.state;
  }
}
```

---

## Debouncing: Avoiding Flicker

Debouncing prevents rapid toggling between states. The idea: require a gesture to be **absent** for N frames before transitioning away.

### The Problem Without Debouncing

```
Frame 1: Index pointing → DRAWING
Frame 2: Misdetection   → IDLE  (stroke ends!)
Frame 3: Index pointing → HOVERING (must wait again!)
Frame 4: Index pointing → HOVERING
Frame 5: Index pointing → HOVERING
Frame 6: Index pointing → HOVERING
Frame 7: Index pointing → DRAWING (finally drawing again, but the stroke was broken)
```

The user saw a broken stroke because of one bad frame.

### Debounced Transition

```typescript
private readonly DEBOUNCE_FRAMES = 3;
private framesWantingToLeave = 0;

private handleDrawing(input: GestureInput): void {
  if (!input.handDetected || !input.isIndexPointing) {
    this.framesWantingToLeave++;

    if (this.framesWantingToLeave >= this.DEBOUNCE_FRAMES) {
      // Consistently not pointing for 3 frames — actually transition
      this.transitionTo(GestureState.IDLE);
      this.onEndStroke();
      this.framesWantingToLeave = 0;
    } else {
      // Might be a misdetection — keep drawing at the last known position
      // Do nothing, wait for the next frame
    }
    return;
  }

  // Still pointing — reset the leave counter
  this.framesWantingToLeave = 0;
  this.onContinueStroke(input.fingerX, input.fingerY);
}
```

Now a single misdetected frame is absorbed:

```
Frame 1: Index pointing → DRAWING (stroke continues)
Frame 2: Misdetection   → DRAWING (debounce: 1/3, keep drawing)
Frame 3: Index pointing → DRAWING (debounce reset, stroke continues)
```

---

## Hysteresis: Asymmetric Thresholds

Hysteresis means using different thresholds for entering and exiting a state. It is like a thermostat: the heater turns on at 68 degrees F and turns off at 72 degrees F. If the threshold were the same (70 degrees), the heater would flicker on and off constantly right around 70 degrees.

### Applied to Gesture Recognition

```typescript
// For detecting if the index finger is extended:
const ENTER_THRESHOLD = 150; // degrees — must be very straight to start drawing
const EXIT_THRESHOLD = 120;  // degrees — can bend quite a bit before we stop

function isIndexPointingWithHysteresis(
  angle: number,
  currentlyPointing: boolean
): boolean {
  if (currentlyPointing) {
    // Currently pointing — only stop if angle drops significantly
    return angle > EXIT_THRESHOLD;
  } else {
    // Not currently pointing — only start if angle is very high
    return angle > ENTER_THRESHOLD;
  }
}
```

The 30-degree gap between the thresholds creates a "dead zone" where the state does not change. This eliminates the flickering that occurs when the finger angle hovers right around a single threshold.

### Hysteresis for Hand Detection Confidence

```typescript
const ENTER_CONFIDENCE = 0.7; // Need high confidence to start tracking
const EXIT_CONFIDENCE = 0.4;  // Can tolerate lower confidence once tracking

function shouldTrackHand(
  confidence: number,
  currentlyTracking: boolean
): boolean {
  if (currentlyTracking) {
    return confidence > EXIT_CONFIDENCE;
  } else {
    return confidence > ENTER_CONFIDENCE;
  }
}
```

---

## Smoothing Finger Position: Exponential Moving Average

Raw MediaPipe coordinates jitter by several pixels between frames. This makes the drawn stroke look shaky. Smoothing averages out the noise.

### One-Euro Filter

The Exponential Moving Average (EMA) has a tradeoff: high smoothing = smooth but laggy. Low smoothing = responsive but jittery. The **One-Euro Filter** adapts dynamically: when the finger moves fast, it reduces smoothing (responsive). When the finger is still, it increases smoothing (stable).

```typescript
class OneEuroFilter {
  private xPrev: number | null = null;
  private dxPrev: number = 0;
  private lastTimestamp: number = 0;

  constructor(
    private minCutoff: number = 1.0,  // Minimum cutoff frequency
    private beta: number = 0.007,      // Speed coefficient
    private dCutoff: number = 1.0      // Derivative cutoff frequency
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const te = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + te / dt);
  }

  filter(x: number, timestamp: number): number {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.lastTimestamp = timestamp;
      return x;
    }

    const dt = (timestamp - this.lastTimestamp) / 1000; // seconds
    if (dt <= 0) return this.xPrev;
    this.lastTimestamp = timestamp;

    // Compute derivative (speed of movement)
    const dx = (x - this.xPrev) / dt;
    const edx = this.alpha(this.dCutoff, dt);
    const dxFiltered = edx * dx + (1 - edx) * this.dxPrev;
    this.dxPrev = dxFiltered;

    // Adaptive cutoff: higher speed → higher cutoff → less smoothing
    const cutoff = this.minCutoff + this.beta * Math.abs(dxFiltered);
    const a = this.alpha(cutoff, dt);

    // Apply filter
    const xFiltered = a * x + (1 - a) * this.xPrev;
    this.xPrev = xFiltered;

    return xFiltered;
  }

  reset(): void {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}

// Usage
const filterX = new OneEuroFilter();
const filterY = new OneEuroFilter();

function smoothPosition(
  rawX: number,
  rawY: number,
  timestamp: number
): { x: number; y: number } {
  return {
    x: filterX.filter(rawX, timestamp),
    y: filterY.filter(rawY, timestamp),
  };
}
```

### Simple EMA (If One-Euro Is Overkill)

```typescript
const ALPHA = 0.3; // Smoothing factor (0 = max smooth, 1 = no smooth)

let prevX = 0;
let prevY = 0;
let initialized = false;

function ema(rawX: number, rawY: number): { x: number; y: number } {
  if (!initialized) {
    prevX = rawX;
    prevY = rawY;
    initialized = true;
    return { x: rawX, y: rawY };
  }

  prevX = ALPHA * rawX + (1 - ALPHA) * prevX;
  prevY = ALPHA * rawY + (1 - ALPHA) * prevY;

  return { x: prevX, y: prevY };
}
```

---

## Why a State Machine Is Better Than Ad-Hoc if/else

### The if/else Approach (Don't Do This)

```typescript
// This looks simple at first...
function handleFrame(landmarks: NormalizedLandmark[]): void {
  if (isIndexPointing(landmarks)) {
    if (wasDrawingLastFrame) {
      continueStroke(landmarks[8].x, landmarks[8].y);
    } else if (hoverFrameCount > 5) {
      startStroke(landmarks[8].x, landmarks[8].y);
      wasDrawingLastFrame = true;
      hoverFrameCount = 0;
    } else {
      showCursor(landmarks[8].x, landmarks[8].y);
      hoverFrameCount++;
    }
  } else if (isOpenPalm(landmarks)) {
    if (wasDrawingLastFrame) {
      endStroke();
      wasDrawingLastFrame = false;
    }
    erase(landmarks[9].x, landmarks[9].y);
    wasErasingLastFrame = true;
  } else {
    if (wasDrawingLastFrame) {
      // But wait, should we debounce?
      if (debounceCounter < 3) {
        debounceCounter++;
        // Keep drawing? Or not?
      } else {
        endStroke();
        wasDrawingLastFrame = false;
        debounceCounter = 0;
      }
    }
    // What about hoverFrameCount? Reset it?
    // What about wasErasingLastFrame?
    hoverFrameCount = 0;
    wasErasingLastFrame = false;
  }
}
```

### Why This Falls Apart

1. **State explosion:** Every new feature (debouncing, hysteresis, a new gesture) adds nested if/else branches. The logic becomes a tangled web.

2. **Implicit state:** The "state" is spread across multiple boolean variables (`wasDrawingLastFrame`, `wasErasingLastFrame`, `hoverFrameCount`, `debounceCounter`). You can end up in impossible combinations (`wasDrawingLastFrame && wasErasingLastFrame`).

3. **Missing transitions:** What happens when the hand switches from open palm directly to index pointing? In the if/else version, you have to trace through all the branches to figure out. In the FSM, you look at the transition table.

4. **Hard to test:** You cannot unit-test "what happens when I go from DRAWING to ERASING" because there is no explicit DRAWING or ERASING state — just a set of booleans.

### The State Machine Approach (Do This)

The FSM implementation above has:

- **Explicit states:** `GestureState.IDLE`, `HOVERING`, `DRAWING`, `ERASING`. You are always in exactly one.
- **Explicit transitions:** Each state's handler defines every possible transition. Missing a transition is immediately visible.
- **Testability:** You can write tests like "given state=DRAWING and input=hand_lost_for_3_frames, assert state=IDLE and endStroke was called."
- **Extensibility:** Adding a new state (e.g., `PINCH_ZOOM`) means adding a new enum value, a new handler method, and transitions from/to the new state. Nothing else changes.

```typescript
// Unit test example
describe("GestureStateMachine", () => {
  it("transitions from HOVERING to DRAWING after 5 stable frames", () => {
    const onStartStroke = jest.fn();
    const fsm = new GestureStateMachine(onStartStroke, ...);

    // Simulate IDLE -> HOVERING
    fsm.update({ handDetected: true, isIndexPointing: true, ... });
    expect(fsm.getState()).toBe(GestureState.HOVERING);

    // Simulate 4 more frames of pointing
    for (let i = 0; i < 4; i++) {
      fsm.update({ handDetected: true, isIndexPointing: true, ... });
    }

    expect(fsm.getState()).toBe(GestureState.DRAWING);
    expect(onStartStroke).toHaveBeenCalledOnce();
  });

  it("debounces single-frame hand loss during DRAWING", () => {
    const onEndStroke = jest.fn();
    // ... set up FSM in DRAWING state ...

    // Single frame of no hand
    fsm.update({ handDetected: false, ... });
    expect(fsm.getState()).toBe(GestureState.DRAWING); // Still drawing!
    expect(onEndStroke).not.toHaveBeenCalled();

    // Hand returns
    fsm.update({ handDetected: true, isIndexPointing: true, ... });
    expect(fsm.getState()).toBe(GestureState.DRAWING);
  });
});
```

---

## Advanced: State Machine Libraries

For simple state machines like AirDraw's gesture recognizer, a hand-rolled FSM (as shown above) is fine. For more complex scenarios, consider libraries:

### XState (Popular TypeScript FSM Library)

```typescript
import { createMachine, interpret } from "xstate";

const gestureMachine = createMachine({
  id: "gesture",
  initial: "idle",
  states: {
    idle: {
      on: {
        INDEX_POINTING: "hovering",
        OPEN_PALM: "erasing",
      },
    },
    hovering: {
      after: {
        170: "drawing", // Auto-transition after 170ms
      },
      on: {
        HAND_LOST: "idle",
        OPEN_PALM: "erasing",
      },
    },
    drawing: {
      on: {
        HAND_LOST: "idle",
        OPEN_PALM: "erasing",
      },
    },
    erasing: {
      on: {
        HAND_LOST: "idle",
        INDEX_POINTING: "hovering",
      },
    },
  },
});
```

XState is overkill for AirDraw's four states, but it provides useful features if the state machine grows: visualizers, guard conditions, hierarchical states, and persistence.

---

## Summary: The Complete Gesture Pipeline

```
MediaPipe Frame
      │
      ▼
  Raw Landmarks (noisy)
      │
      ▼
  Position Smoothing (One-Euro Filter)
      │
      ▼
  Gesture Detection (isIndexPointing, isOpenPalm)
      │
      ▼
  Hysteresis (asymmetric thresholds)
      │
      ▼
  State Machine (IDLE → HOVERING → DRAWING → ...)
      │
      ▼
  Debouncing (require N frames to transition out)
      │
      ▼
  Action Dispatch (startStroke, continueStroke, endStroke, erase)
      │
      ▼
  Canvas Drawing
```

Each layer in this pipeline removes noise and adds stability. By the time a drawing action reaches the canvas, it has been validated by multiple stages. The result: smooth, predictable strokes that track the user's intent rather than MediaPipe's jitter.
