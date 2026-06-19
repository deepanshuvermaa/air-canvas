# TypeScript in Extension Development

## Why TypeScript Matters for AirDraw Specifically

AirDraw has a complex architecture with multiple execution contexts (MAIN world, ISOLATED world, service worker, popup) that communicate via message passing. Without TypeScript, you will inevitably send a message with `{ type: "TOGGLE_DRAWNG" }` (notice the typo) and spend an hour wondering why nothing happens. TypeScript catches this at compile time.

More concretely, AirDraw benefits from TypeScript because:

1. **Message passing is stringly-typed** — dozens of message types flow between contexts. TypeScript ensures every sender and receiver agrees on the shape of each message.
2. **Chrome APIs are complex** — `chrome.scripting.executeScript` has multiple overloads with different return types depending on the options you pass. TypeScript guides you through them.
3. **MediaPipe returns untyped landmark data** — 21 hand landmarks, each with x/y/z coordinates. Without types, you will confuse `landmarks[4]` (thumb tip) with `landmarks[8]` (index finger tip) and wonder why your "pointing" gesture fires when the user makes a fist.
4. **Canvas API has subtle gotchas** — methods like `getContext("2d")` return `CanvasRenderingContext2D | null`. TypeScript forces you to handle the null case.

---

## Type Safety for Message Passing

### The Problem

In a Chrome extension, message passing looks like this in plain JavaScript:

```javascript
// Content script
chrome.runtime.sendMessage({ type: "SET_COLOR", color: "#ff0000" });

// Service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SET_COLOUR") { // British spelling — silent bug
    applyColor(message.color);
  }
});
```

This code has a bug that JavaScript will never catch. The message type is `"SET_COLOR"` but the handler checks `"SET_COLOUR"`. The handler simply never fires.

### Discriminated Unions

TypeScript solves this with discriminated unions — a pattern where a union of types shares a common field (the "discriminant") that TypeScript uses to narrow the type:

```typescript
// src/types/messages.ts

// Each message type is its own interface
interface ToggleDrawingMessage {
  type: "TOGGLE_DRAWING";
  enabled: boolean;
}

interface SetColorMessage {
  type: "SET_COLOR";
  color: string;
}

interface SetBrushSizeMessage {
  type: "SET_BRUSH_SIZE";
  size: number;
}

interface HandDetectedMessage {
  type: "HAND_DETECTED";
  landmarks: HandLandmark[];
}

interface ClearCanvasMessage {
  type: "CLEAR_CANVAS";
}

// The discriminated union — the "type" field is the discriminant
type ExtensionMessage =
  | ToggleDrawingMessage
  | SetColorMessage
  | SetBrushSizeMessage
  | HandDetectedMessage
  | ClearCanvasMessage;
```

Now the handler becomes:

```typescript
chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  switch (message.type) {
    case "SET_COLOR":
      // TypeScript knows message.color exists here
      applyColor(message.color);
      break;
    case "TOGGLE_DRAWING":
      // TypeScript knows message.enabled exists here
      setEnabled(message.enabled);
      break;
    case "SET_COLOUR": // ERROR: This string is not in the union
      break;
  }
});
```

TypeScript will flag `"SET_COLOUR"` as an error because it is not a valid discriminant value. It will also auto-complete the valid message types for you.

### Exhaustive Checking

You can ensure every message type is handled:

```typescript
function handleMessage(message: ExtensionMessage): void {
  switch (message.type) {
    case "TOGGLE_DRAWING":
      // handle
      break;
    case "SET_COLOR":
      // handle
      break;
    // If you forget a case, TypeScript will warn you:
    default:
      const _exhaustive: never = message;
      // ERROR if there are unhandled cases
  }
}
```

The `never` trick works because if all cases are handled, `message` in the default branch is type `never`. If you add a new message type but forget to add a case, `message` is not `never` and TypeScript complains.

---

## Typing Chrome APIs with @types/chrome

The Chrome extension API is fully typed via the `@anthropic-ai/sdk` package — wait, no, it is `@types/chrome`:

```bash
npm install --save-dev @types/chrome
```

This gives you complete type definitions for all `chrome.*` APIs. No import needed — the types are globally available:

```typescript
// These just work after installing @types/chrome
chrome.storage.local.get(["brushColor"], (result) => {
  // result is { [key: string]: any } — you can narrow it further
  const color = result.brushColor as string;
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  // tabs is chrome.tabs.Tab[]
  const url = tabs[0]?.url; // string | undefined
});
```

### Improving Chrome API Types

The default types for `chrome.storage` are loose (`any` values). You can tighten them:

```typescript
// src/types/storage.ts
interface AirDrawStorage {
  brushColor: string;
  brushSize: number;
  isEnabled: boolean;
  gestureState: GestureState;
}

// Wrapper with proper types
async function getStorage<K extends keyof AirDrawStorage>(
  keys: K[]
): Promise<Pick<AirDrawStorage, K>> {
  return chrome.storage.local.get(keys) as Promise<Pick<AirDrawStorage, K>>;
}

// Usage
const { brushColor, brushSize } = await getStorage(["brushColor", "brushSize"]);
// brushColor is string, brushSize is number — no casting needed
```

---

## Interfaces vs Types

Both `interface` and `type` can define object shapes. Here is when to use each:

### Use `interface` for Object Shapes That May Be Extended

```typescript
interface HandLandmark {
  x: number;
  y: number;
  z: number;
}

// Extending
interface NamedHandLandmark extends HandLandmark {
  name: string;
  fingerIndex: number;
}
```

### Use `type` for Unions, Intersections, and Computed Types

```typescript
// Union — cannot be done with interface
type GestureState = "IDLE" | "DRAWING" | "HOVERING" | "ERASING";

// Intersection
type DrawingConfig = BrushSettings & CanvasSettings;

// Mapped type
type ReadonlySettings = Readonly<AirDrawStorage>;
```

### Rule of Thumb

- Use `interface` for things that represent a "shape" (objects with properties)
- Use `type` for everything else (unions, intersections, aliases, mapped types)
- Either works for most cases — pick one convention and stick with it

---

## Generics Basics

Generics let you write code that works with multiple types without losing type information.

### The Motivation

```typescript
// Without generics — loses type info
function getFirst(arr: any[]): any {
  return arr[0];
}

const value = getFirst([1, 2, 3]); // value is any — useless

// With generics — preserves type info
function getFirst<T>(arr: T[]): T {
  return arr[0];
}

const value = getFirst([1, 2, 3]); // value is number
const name = getFirst(["alice", "bob"]); // name is string
```

### Real AirDraw Example: Typed Message Sender

```typescript
// A generic message sender that returns the correct response type
type MessageResponseMap = {
  TOGGLE_DRAWING: { success: boolean };
  SET_COLOR: { previousColor: string };
  GET_SETTINGS: AirDrawStorage;
};

async function sendMessage<T extends keyof MessageResponseMap>(
  type: T,
  data?: any
): Promise<MessageResponseMap[T]> {
  return chrome.runtime.sendMessage({ type, ...data });
}

// Usage
const response = await sendMessage("GET_SETTINGS");
// response is AirDrawStorage — fully typed

const colorResponse = await sendMessage("SET_COLOR", { color: "#00ff00" });
// colorResponse is { previousColor: string }
```

### Constrained Generics

```typescript
// T must have x and y properties
function distance<T extends { x: number; y: number }>(a: T, b: T): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// Works with HandLandmark (has x, y, z) because it satisfies the constraint
const d = distance(landmarks[4], landmarks[8]); // thumb tip to index tip
```

---

## Strict Mode and Why We Use It

In `tsconfig.json`, we enable strict mode:

```jsonc
{
  "compilerOptions": {
    "strict": true
    // This enables ALL of the following:
    // "strictNullChecks": true,
    // "noImplicitAny": true,
    // "strictFunctionTypes": true,
    // "strictBindCallApply": true,
    // "strictPropertyInitialization": true,
    // "noImplicitThis": true,
    // "alwaysStrict": true
  }
}
```

### Why Each Flag Matters for AirDraw

**`strictNullChecks`** — The most important one. Without it, every type implicitly includes `null` and `undefined`. With it:

```typescript
const ctx = canvas.getContext("2d");
// ctx is CanvasRenderingContext2D | null

ctx.fillRect(0, 0, 100, 100); // ERROR: ctx might be null

// You must handle it
if (!ctx) throw new Error("Canvas 2D not supported");
ctx.fillRect(0, 0, 100, 100); // OK — TypeScript knows ctx is not null here
```

**`noImplicitAny`** — Forces you to declare types on function parameters:

```typescript
// ERROR: parameter 'landmark' implicitly has 'any' type
function isPointing(landmark) { ... }

// OK
function isPointing(landmark: HandLandmark): boolean { ... }
```

**`strictFunctionTypes`** — Prevents you from passing a less-specific callback where a more-specific one is expected. This catches subtle bugs in event handlers.

---

## Enums for Gesture States

AirDraw uses a state machine to track what the user's hand is doing. Enums are ideal for this:

### String Enums (Preferred)

```typescript
enum GestureState {
  IDLE = "IDLE",
  DRAWING = "DRAWING",
  HOVERING = "HOVERING",
  ERASING = "ERASING",
}
```

String enums are preferred because:
- They are readable in logs and debug output (`"DRAWING"` vs `2`)
- They serialize cleanly to JSON (for message passing)
- They are self-documenting in chrome.storage

### Using the Enum

```typescript
let currentState: GestureState = GestureState.IDLE;

function transition(newState: GestureState): void {
  console.log(`${currentState} -> ${newState}`);
  currentState = newState;
}

// In the hand tracking callback
if (isIndexPointing(landmarks)) {
  transition(GestureState.DRAWING);
} else if (isPalmOpen(landmarks)) {
  transition(GestureState.ERASING);
} else {
  transition(GestureState.IDLE);
}
```

### Const Enums vs Regular Enums

```typescript
// Regular enum — exists at runtime, can be iterated
enum GestureState {
  IDLE = "IDLE",
  DRAWING = "DRAWING",
}

// Const enum — inlined at compile time, no runtime object
const enum GestureState {
  IDLE = "IDLE",
  DRAWING = "DRAWING",
}
// Every usage is replaced with the literal string "IDLE" or "DRAWING"
```

Use regular enums when you need to iterate over states or pass them across message boundaries. Use const enums for pure compile-time safety with zero runtime overhead.

### Alternative: Union of String Literals

Some developers prefer unions over enums:

```typescript
type GestureState = "IDLE" | "DRAWING" | "HOVERING" | "ERASING";
```

This has no runtime overhead and works well with discriminated unions. The tradeoff is no namespace — you cannot write `GestureState.DRAWING`, you just write `"DRAWING"`. For AirDraw, either approach works. Pick one and be consistent.

---

## How Vite Compiles TypeScript for Extensions

Vite uses **esbuild** for TypeScript compilation during development and **Rollup** (with esbuild or SWC) for production builds.

### Key Points

1. **Vite strips types but does not type-check.** Compilation is fast because esbuild ignores types entirely — it just removes them. You need to run `tsc --noEmit` separately (or via an IDE) to actually check types.

2. **Multiple entry points.** A Chrome extension has multiple entry points (service worker, popup, content scripts). CRXJS handles this automatically by reading `manifest.json` and creating the right Rollup configuration.

3. **Module format.** Service workers in MV3 support ES modules (`"type": "module"` in manifest). Content scripts are bundled as IIFE (immediately invoked function expressions) because they inject into pages that may not support modules.

```typescript
// vite.config.ts
import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    // Vite will create separate bundles for each entry point
    // CRXJS handles the manifest-to-entry-point mapping
  },
});
```

### The tsconfig.json for AirDraw

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",          // Modern JS — service workers support it
    "module": "ESNext",          // ESM for Vite
    "moduleResolution": "bundler", // Let Vite handle resolution
    "strict": true,              // All strict checks on
    "esModuleInterop": true,     // import x from "y" works for CJS modules
    "skipLibCheck": true,        // Skip checking node_modules types (faster)
    "forceConsistentCasingInFileNames": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome"]          // Include @types/chrome globally
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### Running Type Checks

Since Vite does not type-check, add a script to `package.json`:

```jsonc
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit --watch"
  }
}
```

Run `npm run typecheck` in a separate terminal during development. Your IDE (VS Code) also runs TypeScript checks in real-time, so you typically catch errors before you even look at the terminal.
