# AirDraw — In-Air Whiteboard for Video Calls
### Project Blueprint

---

## 1. Project Overview

People who explain things on video calls — engineers walking through an architecture, teachers sketching a concept, consultants drawing a process flow — currently have to break flow to open a separate tool (Excalidraw, Miro, a physical whiteboard) and screen-share it. That context switch kills the natural rhythm of "talk and draw at the same time."

AirDraw is a browser extension that removes that switch entirely. The user enables it with a button or hotkey, points a finger at their webcam, and the line they draw in the air appears live on their video feed — visible to everyone on the call, on any meeting platform (Google Meet, Zoom Web, Microsoft Teams Web), without installing anything server-side or asking other participants to do anything at all.

The core technical insight that makes this possible: instead of trying to overlay drawings on the *screen* (which only the local browser sees), the extension intercepts the webcam stream itself before it reaches the call, composites hand-tracked ink onto it in real time, and hands back a modified stream. The drawing becomes part of the video feed, so it works identically everywhere video calling already works.

---

## 2. User Personas & Use Cases

**Primary persona — "Explainer Erin"**: a software engineer, tech lead, or consultant who frequently needs to sketch a diagram mid-conversation on a call. Wants zero setup friction and to keep talking while drawing.

**Secondary persona — "Teacher Tariq"**: tutors or teaches remotely, wants to annotate or sketch freehand the way they would on a physical whiteboard, without breaking eye contact with the webcam for too long.

**Tertiary persona — "Sales Sam"**: does product demos and wants to circle/highlight things on their own video feed for emphasis, more like a laser pointer than a precise diagram tool.

Primary journeys:

- **Live explanation mid-call**: Already on a call, presses a hotkey to activate AirDraw, points and draws an arrow or box over their own video tile while talking, presses the hotkey again to stop. No tab switching, no screen-share dialog.
- **Quick pre-call check**: Before joining an important call, briefly tests that hand tracking is picking up correctly given current lighting/camera angle, adjusts position.
- **Emphasis-only annotation**: Doesn't need a persistent diagram, just wants to point at and briefly circle something on their feed (laser-pointer-style fading ink) without cluttering the screen.

---

## 3. Core Features & MVP Scope

**MVP (must-have to call this "done" for personal use):**

- Toolbar icon and keyboard shortcut to turn AirDraw on/off
- Webcam stream interception (`getUserMedia` patch) so the composited canvas replaces the real camera feed sent to the call
- Single-hand tracking via MediaPipe Hand Landmarker, running fully client-side
- "Point to draw" gesture: index finger extended = pen down, anything else (open palm, fist) = pen up — no pinch required
- Basic freehand drawing: one color, adjustable stroke width, manual clear gesture or button
- Small on-screen status indicator confirming AirDraw is active (so the user never forgets it's live, especially before unrelated calls)
- Verified working on Chrome (Manifest V3) for Google Meet, Zoom Web, and Microsoft Teams Web

**Deferred to v2+ (explicitly out of MVP scope):**

- Real-time shape snapping (wobbly circle/arrow auto-straightens) — the highest "wow factor" feature, but separable from core functionality
- Laser-pointer fade mode (ink disappears after a few seconds) as a toggle alongside permanent ink
- Multiple colors, pen styles, undo/redo
- A local DOM-canvas overlay mode (independent of the camera trick) for annotating a shared tab/slides instead of your face
- Firefox/Edge support beyond Chrome
- Export/save drawings as an image
- Two-hand gestures (e.g., pinch-zoom or pan the canvas)
- Multi-user collaborative drawing if other call participants also have the extension
- Any cloud sync, accounts, or persistence across sessions

---

## 4. Proposed Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Extension framework | Chrome Manifest V3 (content scripts + service worker) | Required to inject into arbitrary meeting pages and intercept `getUserMedia` before the page's own JS runs |
| Language | TypeScript | The stream-patching and gesture state machine have enough moving parts that type safety pays for itself quickly |
| Hand tracking | MediaPipe Tasks Vision (Hand Landmarker, WASM) | Runs entirely in-browser, no server round-trip, real-time on a typical laptop CPU, no camera data ever leaves the device |
| Rendering/compositing | Canvas API / OffscreenCanvas | Native, performant, integrates directly with `MediaStream.captureStream()` to fabricate the output video track |
| Bundling | Vite + CRXJS plugin | Purpose-built for Manifest V3 extension development, handles hot-reload during dev |
| Backend/server | None for MVP | Everything runs client-side; this also means zero infrastructure cost and a strong privacy story (camera frames stay local) |
| Settings storage | `chrome.storage.local` | Lightweight key-value store built into the extension platform, no database needed for preferences like stroke color or hotkey |

A traditional backend or database is intentionally absent from the MVP — there's no data to persist or sync yet. If multi-user collaboration is added later, that's the point a lightweight WebRTC data channel or relay server would enter the picture, not before.

---

## 5. System Architecture

Since this is a client-only browser extension, there's no traditional frontend/backend/database split. Instead, picture it as a single real-time pipeline running inside the meeting tab:

1. **Content script (injected in the page's MAIN world, at document start)** patches `navigator.mediaDevices.getUserMedia` before the meeting app calls it.
2. When the meeting app requests the camera, the patched function fetches the **real camera stream**, then routes each video frame through a **compositing pipeline**: draw the raw frame to an offscreen canvas → run it through the **MediaPipe Hand Landmarker** → feed the landmark positions into a small **gesture/drawing state machine** (pen up vs. pen down based on finger pose) → draw any new ink strokes onto an overlay layer → composite overlay + camera frame together.
3. The composited canvas is turned into a stream via `canvas.captureStream()`, and that fake stream — not the real camera — is what gets handed back to the meeting app. From the meeting app's perspective, nothing is unusual; it's just "the camera."
4. A **background service worker** owns the on/off state, listens for the keyboard shortcut (`chrome.commands`), and relays toggle messages to the content script.
5. A **popup UI** (the toolbar icon's dropdown) exposes simple settings — on/off, stroke color/width, hotkey reference — and reads/writes them via `chrome.storage.local`.

No external API or database sits in this loop for the MVP; everything happens locally inside the browser tab, frame by frame.

---

## 6. Step-by-Step Development Roadmap

**Phase 0 — Scaffolding**
Set up the Manifest V3 project with Vite + CRXJS, a minimal manifest with host permissions for the target meeting domains, and a "hello world" content script that confirms injection works.

**Phase 1 — Local overlay prototype (no hand tracking yet)**
Get a transparent canvas rendering on top of a test page, drawable with the mouse, toggled on/off via the toolbar icon. This validates the drawing engine and on/off plumbing in isolation, with the fastest possible feedback loop.

**Phase 2 — Hand tracking integration**
Wire in the MediaPipe Hand Landmarker, log raw landmark coordinates to the console, and tune detection of the "pointing" pose (index extended, others curled) under normal lighting.

**Phase 3 — Gesture-to-draw on the local overlay**
Replace mouse input with the pointing gesture from Phase 2, still drawing on the *local* overlay canvas only. This is already a demoable, satisfying milestone even before the harder camera-stream work begins.

**Phase 4 — Camera stream hijack**
Implement the `getUserMedia` patch and the full compositing pipeline (real video + ink → output canvas → `captureStream()`). Confirm the drawing actually shows up inside a live Google Meet video tile, not just locally.

**Phase 5 — MVP polish**
Stroke smoothing, manual clear/erase, the always-visible "AirDraw is live" status indicator, and a settings popup for color/stroke width/hotkey.

**Phase 6 — Cross-platform validation**
Test against Google Meet, Zoom Web, and Teams Web specifically — each may request or cache the camera stream slightly differently, and timing edge cases will likely surface here.

**Phase 7 — Packaging for personal use**
Load unpacked for daily personal use; package and (optionally) publish privately/unlisted on the Chrome Web Store only if it needs to be installed on a second machine or shared with others.

**Phase 8 — Post-MVP features**
Shape snapping, laser-pointer fade mode, then (only if still wanted) the local DOM-overlay mode for shared-tab annotation, and collaboration features if the project grows beyond personal use.

---

## Critical Assumptions to Confirm

- **Browser target**: this plan assumes Chrome (Manifest V3) as the only target for now. Firefox handles `getUserMedia` patching and extension permissions differently — confirm if cross-browser support matters for the MVP or can wait.
- **Single-hand only**: the gesture model assumes one hand is sufficient. Confirm this matches the intended use (vs. needing two-hand gestures like pinch-zoom on the canvas).
- **Personal use vs. distribution**: if this stays a personal tool, Chrome Web Store review and policy compliance aren't a blocker — "load unpacked" works indefinitely. If you intend to share it with even a few other people, that changes packaging and possibly privacy-disclosure requirements.

## Edge Cases Not Yet Addressed

- **Stream already obtained before enabling**: if the user joins a call first and enables AirDraw afterward, the meeting app already holds the original camera stream — the patch needs to either intercept earlier than that or require a page refresh after enabling, which should be decided explicitly rather than discovered by accident.
- **Mid-call camera switching or mute/unmute**: meeting apps occasionally swap or re-request the video track (e.g., toggling camera off and on); the fake stream needs to survive this without freezing or reverting to the raw, undrawn feed.
- **Performance under load**: hand tracking plus per-frame compositing competes for CPU with the video call's own encoding — needs profiling on a typical laptop, not just a dev machine, before calling Phase 4 "done."
- **Detection reliability in poor lighting**: MediaPipe's accuracy degrades in low light or unusual camera angles; the MVP should fail gracefully (e.g., pen simply doesn't activate) rather than draw erratic strokes.
- **Privacy framing**: because the extension intercepts the camera stream, the manifest and any future store listing should be explicit that no frame data leaves the device — important for personal trust now and essential if ever shared with others.
