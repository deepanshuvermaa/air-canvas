# Finite State Machines for UI State Management

## What a Finite State Machine Is

A finite state machine (FSM) is a model of computation defined by:

1. **A finite set of states.** The machine is always in exactly one state.
2. **A set of transitions.** Each transition connects one state to another and is triggered by an event.
3. **A current state.** The machine starts in an initial state and moves to other states via transitions.

Only valid transitions are allowed. If the machine is in state A and receives an event that has no transition defined for state A, the event is ignored. This constraint is the entire point: **the FSM prevents impossible states.**

A simple example:

```
States: { LOCKED, UNLOCKED }
Transitions:
  LOCKED   --coin-->   UNLOCKED
  UNLOCKED --push-->   LOCKED
  LOCKED   --push-->   LOCKED     (nothing happens)
  UNLOCKED --coin-->   UNLOCKED   (nothing happens)
```

This is a turnstile. You cannot push through a locked turnstile. You cannot insert a coin into an already-unlocked one (well, you can, but nothing changes). The FSM enforces these rules by construction.

---

## Why State Machines Matter for UI

Without a state machine, UI state is typically managed with booleans:

```javascript
var isRecording = false;
var hasLoop = false;
var isGhostActive = false;
```

This creates 2^3 = 8 possible combinations. But not all are valid:

| isRecording | hasLoop | isGhostActive | Valid? |
|---|---|---|---|
| false | false | false | Yes (idle) |
| true | false | false | Yes (recording) |
| false | true | false | Yes (ready) |
| false | true | true | Yes (active) |
| true | true | false | No --- re-recording while loop exists is fine, but the old loop is being replaced |
| true | false | true | **No** --- cannot be recording AND ghost active simultaneously |
| false | false | true | **No** --- cannot be ghost active without a loop |
| true | true | true | **No** --- cannot be recording AND active AND have a loop |

Three booleans permit 8 states. Only 4 are valid. That means 4 invalid states are representable in your data model. Every function that touches these booleans must independently check for and avoid the invalid combinations. Miss one check, and you have a bug.

A state machine eliminates this problem by making only valid states representable:

```javascript
var ghostState = 'idle'; // 'idle' | 'recording' | 'ready' | 'active'
```

One variable. Four possible values. Zero invalid combinations.

---

## Ghost Mode States

### IDLE

No loop has been recorded. The user has not interacted with Ghost Mode yet, or the previous loop has been discarded.

**UI state:**
- Record button: enabled, text = "Record Loop"
- Toggle button: disabled, text = "Activate Ghost"
- Status dot: neutral (gray)
- Status text: "No loop recorded"

**Valid transitions:**
- IDLE --> RECORDING (user clicks Record)

### RECORDING

The MediaRecorder is running. A 5.5-second clip of the live camera is being captured. The user cannot do anything during this time --- the recording runs to completion automatically.

**UI state:**
- Record button: disabled, text = "Recording..."
- Toggle button: disabled
- Status dot: recording indicator (pulsing red)
- Status text: "Recording..."

**Valid transitions:**
- RECORDING --> READY (recording completes successfully)
- RECORDING --> IDLE (recording fails)

Note: RECORDING --> ACTIVE is an invalid transition. You cannot activate ghost mode until the recording is finished and the loop is ready. The FSM blocks this.

### READY

A loop clip exists and is ready to play. The user can activate ghost mode or re-record.

**UI state:**
- Record button: enabled, text = "Re-record"
- Toggle button: enabled, text = "Activate Ghost"
- Status dot: ready (yellow)
- Status text: "Loop ready (5s)"

**Valid transitions:**
- READY --> ACTIVE (user clicks Activate)
- READY --> RECORDING (user clicks Re-record)

### ACTIVE

Ghost mode is live. The meeting app is receiving the looped video instead of the live camera. The user appears present but is not actually there.

**UI state:**
- Record button: disabled, text = "Record Loop"
- Toggle button: enabled, text = "Go Live"
- Status dot: active (green)
- Status text: "Ghost active"
- Extension badge: "GHOST" (green background)

**Valid transitions:**
- ACTIVE --> READY (user clicks Go Live to deactivate)

Note: ACTIVE --> RECORDING is invalid. The user must deactivate ghost mode first (ACTIVE --> READY), then re-record (READY --> RECORDING). This prevents the pipeline from trying to record the loop output instead of the live camera.

---

## State Transition Diagram

```
                    record()
         ┌──────────────────────────┐
         │                          ▼
       IDLE                     RECORDING
         ▲                          │
         │                          │ success
         │  fail                    │
         └──────────────────────────┤
                                    ▼
         ┌───── re-record ──────  READY
         │                          │ ▲
         ▼                          │ │
     RECORDING                      │ │
                          activate  │ │ deactivate
                                    ▼ │
                                  ACTIVE
```

Every arrow is a valid transition. There are no other transitions. If code attempts to call `toggleGhostMode()` while in IDLE or RECORDING state, the function logs a warning and returns without changing state:

```javascript
function toggleGhostMode() {
  if (ghostState === 'ready') {
    ghostActive = true;
    ghostState = 'active';
    console.log('[AirDraw] Ghost mode ACTIVATED');
  } else if (ghostState === 'active') {
    ghostActive = false;
    ghostState = 'ready';
    console.log('[AirDraw] Ghost mode DEACTIVATED');
  } else {
    console.log('[AirDraw] Ghost toggle ignored -- state is: ' + ghostState);
  }
  postGhostStatus();
}
```

The else clause is the FSM rejecting an invalid transition. Without it, a button click at the wrong time could put the system into an impossible state.

---

## Connecting State to UI

Each state maps to a deterministic set of UI properties. The `updateGhostUI()` function in the popup implements this:

```typescript
function updateGhostUI(state: string): void {
  currentGhostState = state;

  switch (state) {
    case 'recording':
      ghostStatusDot.className = 'ghost-status-dot recording';
      ghostStatusTextEl.textContent = 'Recording...';
      ghostRecordBtn.disabled = true;
      ghostRecordText.textContent = 'Recording...';
      ghostToggleBtn.disabled = true;
      break;

    case 'ready':
      ghostStatusDot.className = 'ghost-status-dot ready';
      ghostStatusTextEl.textContent = 'Loop ready (5s)';
      ghostRecordBtn.disabled = false;
      ghostRecordText.textContent = 'Re-record';
      ghostToggleBtn.disabled = false;
      ghostToggleText.textContent = 'Activate Ghost';
      ghostToggleBtn.classList.remove('active');
      break;

    case 'active':
      ghostStatusDot.className = 'ghost-status-dot active';
      ghostStatusTextEl.textContent = 'Ghost active';
      ghostRecordBtn.disabled = true;
      ghostRecordText.textContent = 'Record Loop';
      ghostToggleBtn.disabled = false;
      ghostToggleText.textContent = 'Go Live';
      ghostToggleBtn.classList.add('active');
      break;

    default: // 'idle'
      ghostStatusDot.className = 'ghost-status-dot';
      ghostStatusTextEl.textContent = 'No loop recorded';
      ghostRecordBtn.disabled = false;
      ghostRecordText.textContent = 'Record Loop';
      ghostToggleBtn.disabled = true;
      ghostToggleText.textContent = 'Activate Ghost';
      ghostToggleBtn.classList.remove('active');
      break;
  }
}
```

Notice: every case sets every UI element. There is no "partial update" where only some elements change. This eliminates an entire class of bugs where the UI gets out of sync with the state because one element was not updated in one code path.

This pattern is called **rendering from state** --- the UI is a pure function of the state. When the state changes, the entire UI is re-derived from the new state. React popularized this approach, but it works just as well with vanilla DOM manipulation.

---

## Implementation Patterns

### Pattern 1: Enum + Switch (Used in Ghost Mode)

The simplest pattern. One variable holds the state. Switch statements in handler functions check the state and perform valid transitions.

```javascript
var ghostState = 'idle'; // 'idle' | 'recording' | 'ready' | 'active'

async function recordGhostLoop() {
  if (ghostState === 'active') {
    // Must deactivate first
    ghostActive = false;
  }
  ghostState = 'recording';
  postGhostStatus();

  try {
    await ghostLoopPlayer.prepare(videoElement);
    ghostState = 'ready';
  } catch (e) {
    ghostState = 'idle';
  }
  postGhostStatus();
}

function toggleGhostMode() {
  if (ghostState === 'ready') {
    ghostActive = true;
    ghostState = 'active';
  } else if (ghostState === 'active') {
    ghostActive = false;
    ghostState = 'ready';
  }
  postGhostStatus();
}
```

**Pros:**
- Minimal boilerplate. No classes, no libraries.
- Easy to read and debug. The state transitions are right there in the handler.
- Perfect for small state machines (4-6 states).

**Cons:**
- Transitions are implicit --- you have to read the handler code to find them.
- No compile-time checking of valid transitions.
- Scales poorly past ~8 states (the switch statements become unwieldy).

### Pattern 2: Object Map (State --> Transitions --> Handlers)

Define the state machine as a data structure. Each state maps to its valid transitions:

```typescript
const ghostMachine = {
  initial: 'idle',
  states: {
    idle:      { on: { RECORD: 'recording' } },
    recording: { on: { RECORD_SUCCESS: 'ready', RECORD_FAIL: 'idle' } },
    ready:     { on: { ACTIVATE: 'active', RECORD: 'recording' } },
    active:    { on: { DEACTIVATE: 'ready' } },
  },
};

function send(machine, currentState, event) {
  var transition = machine.states[currentState]?.on[event];
  if (!transition) {
    console.warn('No transition for "' + event + '" in state "' + currentState + '"');
    return currentState;
  }
  return transition; // Returns the new state
}

// Usage
var state = 'idle';
state = send(ghostMachine, state, 'RECORD');          // 'recording'
state = send(ghostMachine, state, 'ACTIVATE');         // ignored, still 'recording'
state = send(ghostMachine, state, 'RECORD_SUCCESS');   // 'ready'
state = send(ghostMachine, state, 'ACTIVATE');         // 'active'
```

The entire machine is visible in one object. Invalid transitions are automatically rejected. The tradeoff: more boilerplate than Pattern 1, and async transitions (like recording) require additional handling outside the machine.

### Pattern 3: XState-Style (Overkill for Simple Cases)

Libraries like XState provide hierarchical states, guards, delays, async invocations, and visual debugging. For Ghost Mode's four states and two handler functions, the ~15KB bundle cost and learning curve are not justified. Mentioned here for completeness --- reach for it when your state machine exceeds ~8 states or needs complex guard logic.

Ghost Mode uses Pattern 1. Four states, two handler functions, no library. The right amount of machinery for the problem.

---

## AirDraw Already Uses a State Machine

Ghost Mode's FSM is not the first state machine in this codebase. AirDraw's gesture recognizer (documented in [06-gesture-state-machine.md](./06-gesture-state-machine.md)) uses the same pattern:

```typescript
enum GestureState {
  IDLE = "IDLE",
  DRAWING = "DRAWING",
  HOVERING = "HOVERING",
  ERASING = "ERASING",
}
```

Four states, explicit transitions, debounced exits. Both FSMs share the same design philosophy: enumerate valid states, define valid transitions, reject invalid ones, derive UI from state. The gesture FSM uses a class (it needs debouncing and hysteresis); Ghost Mode uses a bare variable with switch statements (it does not).

---

## Ghost Mode State vs. AirDraw State: Parallel State Machines

Ghost Mode and AirDraw run as two independent state machines. They interact at specific points:

### When Ghost Activates

Ghost activation pauses AirDraw's hand tracking. Drawing while "away from the keyboard" would be an obvious tell --- strokes appearing over a frozen/looping video. The transition:

```javascript
function toggleGhostMode() {
  if (ghostState === 'ready') {
    ghostActive = true;
    ghostState = 'active';
    // Pause AirDraw hand tracking
    // (The gesture FSM stays in whatever state it was in,
    //  but the compositing loop stops drawing the ink overlay)
  }
}
```

The gesture state machine is not reset or destroyed. It simply stops receiving input because the hand tracking loop checks `ghostActive` before processing:

```javascript
// In the compositing loop:
if (!ghostActive && enabled && drawingCanvas) {
  compositeCtx.drawImage(drawingCanvas, 0, 0);
}
```

### When Ghost Deactivates

When the user deactivates ghost mode, the live camera resumes and AirDraw tracking resumes if AirDraw was enabled:

```javascript
if (ghostState === 'active') {
  ghostActive = false;
  ghostState = 'ready';
  // AirDraw hand tracking resumes automatically
  // (The compositing loop starts drawing ink overlay again
  //  because ghostActive is false and enabled is still true)
}
```

### Independence of the Two Machines

The two state machines communicate through a shared `ghostActive` boolean, not direct references. The gesture FSM keeps running during ghost mode, but the compositing loop gates its output: `if (!ghostActive && enabled && drawingCanvas)`. This loose coupling means Ghost Mode can be removed or refactored without touching gesture recognition code.

---

## Communicating State Across Contexts

Ghost Mode's state machine runs in three different execution contexts. Keeping them in sync is a cross-cutting concern.

### The Three Contexts

1. **MAIN world** (page context): The `ghostState` variable lives here. The compositing loop, artifact engine, and loop player all run here. This is the source of truth.

2. **Service worker** (background): Manages the extension badge text and color. Needs to know the current ghost state to display "GHOST" on the badge when active.

3. **Popup** (extension popup): Displays the Ghost Mode UI (record button, toggle button, status dot). Needs the current ghost state to render the correct UI.

### MAIN World --> Service Worker

When the ghost state changes, the MAIN world broadcasts via `postMessage` to the content script, which relays to the service worker:

```javascript
// MAIN world (main-world.js)
function postGhostStatus() {
  window.postMessage({
    source: 'airdraw-main',
    type: 'GHOST_STATUS',
    payload: { ghostState: ghostState }
  }, '*');
}

// Content script (bootstrap.ts) — bridge between MAIN and extension
window.addEventListener('message', (event) => {
  if (msg.type === 'GHOST_STATUS') {
    // Update content script UI
    updateGhostBadge(payload.ghostState);
    // Relay to service worker
    chrome.runtime.sendMessage({
      type: 'GHOST_STATUS',
      ghostState: payload.ghostState,
    });
  }
});

// Service worker (service-worker.ts)
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'GHOST_STATUS' && sender.tab?.id) {
    updateGhostBadge(sender.tab.id, message.ghostState);
  }
});
```

### Popup --> MAIN World (Reverse Direction)

User actions in the popup follow the reverse path: popup sends `chrome.tabs.sendMessage` to the content script, which relays via `window.postMessage` to the MAIN world. The content script bridges both directions:

```typescript
// Content script (bootstrap.ts)
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'RECORD_GHOST': sendToMain('RECORD_GHOST'); break;
    case 'TOGGLE_GHOST': sendToMain('TOGGLE_GHOST'); break;
    case 'GHOST_STATUS_REQUEST': sendToMain('GHOST_STATUS'); break;
  }
});
```

The popup also performs **optimistic UI updates** --- it calls `updateGhostUI('recording')` immediately after sending the record message, rather than waiting for the MAIN world to confirm. If the recording fails, the MAIN world broadcasts the corrected state and the popup self-corrects. This makes the UI feel instant.

When the popup first opens, it sends a `GHOST_STATUS_REQUEST` to query the current state. The round trip takes a few milliseconds. In the meantime, the popup shows the default (idle) state.

---

## Why Not a Boolean

The naive approach:

```javascript
var isGhostActive = false;
```

This boolean can represent exactly two states: ghost is on, or ghost is off. But Ghost Mode has four states:

1. **IDLE** --- no loop exists. Cannot activate. Can only record.
2. **RECORDING** --- actively recording. Cannot activate. Cannot re-record.
3. **READY** --- loop exists, not active. Can activate or re-record.
4. **ACTIVE** --- loop is playing. Can deactivate. Cannot re-record.

A boolean collapses IDLE, RECORDING, and READY into a single "not active" state. This means:

- You cannot disable the toggle button during recording (because `!isGhostActive` is the same for IDLE, RECORDING, and READY).
- You cannot show "Re-record" vs "Record Loop" (both are `!isGhostActive`).
- You cannot prevent recording while ghost is active (you would need a second boolean, `isRecording`, creating the 2^2 = 4 combinations problem again).

With two booleans (`isGhostActive`, `isRecording`), you have 4 combinations, one of which (`isGhostActive && isRecording`) is invalid. You are back to the problem described at the top of this document.

The state enum solves this cleanly:

```javascript
var ghostState = 'idle';
// One variable. Four values. Zero invalid combinations.
```

Every function that checks ghost state checks one variable:

```javascript
// Can we record?
if (ghostState === 'idle' || ghostState === 'ready') { /* yes */ }

// Can we toggle?
if (ghostState === 'ready' || ghostState === 'active') { /* yes */ }

// Is ghost currently showing the loop?
if (ghostState === 'active') { /* yes */ }
```

Each check reads as a direct question about the system's state. There is no mental juggling of boolean combinations.

---

## Summary

The state machine is the backbone of Ghost Mode's control flow. One string variable (`ghostState`) with four values replaces what would otherwise be multiple booleans with invalid combinations. Each state maps deterministically to a UI configuration. State changes propagate across Chrome extension contexts (MAIN world, content script, service worker, popup) via message passing. The same FSM pattern powers gesture recognition elsewhere in AirDraw, proving its value as a general-purpose tool for managing complex UI state.
