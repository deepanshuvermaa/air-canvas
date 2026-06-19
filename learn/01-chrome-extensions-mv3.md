# Chrome Extensions & Manifest V3

## What Is a Chrome Extension?

A Chrome extension is a small software program that modifies or enhances the Chrome browser. Unlike a normal web app that lives at a URL and runs in a single tab, an extension:

- Runs across the entire browser, not just one page
- Has access to Chrome-specific APIs (tabs, storage, bookmarks, etc.)
- Can inject code into any webpage the user visits
- Has its own lifecycle independent of any webpage
- Is distributed through the Chrome Web Store (or loaded unpacked for development)

For AirDraw, we are building an extension rather than a web app because we need to **inject our hand-tracking overlay into third-party pages** like Google Meet, Zoom Web, and Microsoft Teams. A normal web app cannot modify another website's DOM or intercept its camera stream. An extension can.

---

## Manifest V3 vs Manifest V2

Chrome is migrating all extensions from Manifest V2 (MV2) to Manifest V3 (MV3). MV3 is mandatory for new extensions. Here are the key differences:

### Service Workers Replace Background Pages

**MV2:** You had a persistent background page — a hidden HTML page that ran as long as the browser was open. You could keep state in memory indefinitely.

**MV3:** Background pages are replaced by **service workers**. Service workers are event-driven and **non-persistent** — Chrome terminates them after ~30 seconds of inactivity and restarts them when an event fires.

```jsonc
// manifest.json (MV3)
{
  "manifest_version": 3,
  "background": {
    "service_worker": "src/background/index.ts",
    "type": "module"
  }
}
```

This is a critical architectural constraint for AirDraw. We cannot keep a persistent WebSocket connection or long-lived timer in the service worker. All persistent state must go into `chrome.storage`.

### declarativeNetRequest Replaces webRequest (Blocking)

MV2 allowed extensions to intercept and modify network requests in real-time using `chrome.webRequest` with blocking capabilities. MV3 replaces this with `declarativeNetRequest`, which uses static rules.

AirDraw does not need to modify network requests, so this change does not affect us directly. But it is important to understand if you ever need to block or redirect requests.

### Host Permissions Are Separate

In MV2, host permissions were declared inside the `permissions` array. In MV3, they are declared separately:

```jsonc
{
  "permissions": ["activeTab", "storage", "scripting"],
  "host_permissions": ["https://meet.google.com/*", "https://teams.microsoft.com/*"]
}
```

### Action API Replaces browserAction / pageAction

MV2 had two separate APIs: `chrome.browserAction` (always visible icon) and `chrome.pageAction` (icon visible only on certain pages). MV3 unifies them into `chrome.action`.

```typescript
// MV3
chrome.action.onClicked.addListener((tab) => {
  // Toggle AirDraw on/off
});
```

---

## Content Scripts

Content scripts are JavaScript files that run **inside a webpage** but in a sandboxed environment. They are how AirDraw injects its overlay canvas and hand-tracking logic into Google Meet or Zoom.

### ISOLATED World (Default)

By default, content scripts run in an **isolated world**. This means:

- They share the page's DOM (can read/write HTML elements)
- They do **not** share the page's JavaScript environment (different `window` object)
- The page's JS cannot see the content script's variables, and vice versa

```jsonc
// manifest.json
{
  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["src/content/overlay.ts"],
      "run_at": "document_idle",
      "world": "ISOLATED"  // default
    }
  ]
}
```

Use ISOLATED world when you only need to manipulate the DOM — adding overlay elements, reading page structure, etc.

### MAIN World

MAIN world content scripts share the **same JavaScript environment** as the page. They can access the page's `window`, prototype chains, and global variables.

```jsonc
{
  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["src/content/patch-media.ts"],
      "run_at": "document_start",
      "world": "MAIN"
    }
  ]
}
```

**Why AirDraw needs MAIN world:** We need to monkey-patch `navigator.mediaDevices.getUserMedia()` so that when Google Meet requests the camera, we can intercept the stream and replace it with our composited stream (camera + drawing overlay). This function lives on the page's `window.navigator` object. From ISOLATED world, we would be patching a different copy of `navigator` that the page never calls.

**The danger:** MAIN world scripts have no sandboxing. A malicious page could detect and tamper with your code. The page's CSP also applies to your script. Use MAIN world only when absolutely necessary.

### Programmatic Injection

Instead of declaring content scripts in the manifest, you can inject them on demand:

```typescript
// In the service worker
chrome.scripting.executeScript({
  target: { tabId: tab.id },
  files: ["src/content/overlay.js"],
  world: "MAIN"
});
```

This is useful when you only want to inject into a page after the user clicks the extension icon.

---

## Service Workers: Lifecycle

The service worker is the "brain" of your extension. Understanding its lifecycle is essential because it behaves differently from a regular web page script.

### Startup and Shutdown

1. Chrome loads the service worker when an event it listens for fires (e.g., `chrome.runtime.onInstalled`, `chrome.action.onClicked`, a message from a content script).
2. The service worker runs the event handler.
3. After ~30 seconds of inactivity (no pending events, no open ports), Chrome terminates it.
4. When the next event fires, Chrome starts it again from scratch — all in-memory variables are gone.

### No Persistent State

```typescript
// BAD: This value is lost when the service worker sleeps
let isEnabled = false;

chrome.action.onClicked.addListener(async (tab) => {
  isEnabled = !isEnabled; // This works once, but is lost on restart
});

// GOOD: Persist state in chrome.storage
chrome.action.onClicked.addListener(async (tab) => {
  const { isEnabled } = await chrome.storage.local.get("isEnabled");
  await chrome.storage.local.set({ isEnabled: !isEnabled });
});
```

### Keeping the Service Worker Alive (When Necessary)

Sometimes you need the service worker to stay alive longer (e.g., during a long operation). You can use `chrome.alarms` or long-lived message ports, but these are workarounds. Design your architecture so the service worker can die and restart cleanly.

```typescript
// Use alarms instead of setInterval
chrome.alarms.create("heartbeat", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "heartbeat") {
    // Do periodic work
  }
});
```

---

## Popup UI

The popup is the small panel that appears when a user clicks the extension icon in the toolbar. In AirDraw, this is where users configure settings (brush color, size, toggle drawing on/off).

### How It Works

- Declared in `manifest.json` under `action.default_popup`
- It is a regular HTML file with its own JS context
- It opens when the user clicks the icon and **closes as soon as the user clicks away**
- When it closes, **all its state is destroyed** — it is not a persistent UI

```jsonc
{
  "action": {
    "default_popup": "src/popup/index.html",
    "default_icon": "icons/icon48.png"
  }
}
```

```html
<!-- src/popup/index.html -->
<!DOCTYPE html>
<html>
  <body>
    <h1>AirDraw Settings</h1>
    <label>
      <input type="checkbox" id="enabled" />
      Enable Drawing
    </label>
    <script src="popup.ts" type="module"></script>
  </body>
</html>
```

### Communicating with Content Scripts

The popup cannot directly access content script variables. It must use message passing:

```typescript
// popup.ts
const toggleBtn = document.getElementById("enabled") as HTMLInputElement;
toggleBtn.addEventListener("change", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id!, {
    type: "TOGGLE_DRAWING",
    enabled: toggleBtn.checked
  });
});
```

---

## Permissions Model

Chrome extensions use a declarative permissions model. You request permissions in the manifest, and Chrome grants them at install time (or prompts the user for optional permissions).

### Key Permissions for AirDraw

| Permission | Why AirDraw Needs It |
|---|---|
| `activeTab` | Access the current tab when the user clicks the icon |
| `scripting` | Programmatically inject content scripts |
| `storage` | Persist settings (brush color, enabled state) |
| `tabs` | Query tab URLs to know which meeting app is active |

### Host Permissions

Host permissions grant access to specific websites. Without them, content scripts declared with `matches` will not inject.

```jsonc
{
  "host_permissions": [
    "https://meet.google.com/*",
    "https://teams.microsoft.com/*",
    "https://*.zoom.us/*"
  ]
}
```

### Optional Permissions

For broad site access, use optional permissions so the user is not scared off at install time:

```typescript
chrome.permissions.request({
  origins: ["https://*.example.com/*"]
}, (granted) => {
  if (granted) {
    // Now inject content script
  }
});
```

---

## Message Passing

Extensions have three main contexts that need to communicate:

1. **Content Script** — runs in the webpage
2. **Service Worker** — runs in the background
3. **Popup** — runs when the user opens the popup

### One-Time Messages

```typescript
// Content script sends a message
chrome.runtime.sendMessage({ type: "HAND_DETECTED", landmarks: data });

// Service worker receives it
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "HAND_DETECTED") {
    // Handle it
    sendResponse({ status: "ok" });
  }
  return true; // Keep the message channel open for async sendResponse
});
```

### Service Worker to Content Script

```typescript
// Service worker sends to a specific tab
chrome.tabs.sendMessage(tabId, { type: "UPDATE_SETTINGS", color: "#ff0000" });
```

### Long-Lived Connections (Ports)

For frequent communication (like streaming hand position data), use ports:

```typescript
// Content script
const port = chrome.runtime.connect({ name: "hand-tracking" });
port.postMessage({ type: "POSITION_UPDATE", x: 0.5, y: 0.3 });

port.onMessage.addListener((msg) => {
  console.log("Received:", msg);
});

// Service worker
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "hand-tracking") {
    port.onMessage.addListener((msg) => {
      // Process hand tracking data
    });
  }
});
```

### AirDraw Message Flow

```
[Content Script (MAIN world)]  -- patches getUserMedia, sends composited stream
        |
        | window.postMessage (MAIN ↔ ISOLATED communication)
        v
[Content Script (ISOLATED world)]  -- manages overlay UI, runs MediaPipe
        |
        | chrome.runtime.sendMessage
        v
[Service Worker]  -- coordinates state, relays settings
        |
        | chrome.tabs.sendMessage
        v
[Popup]  -- user changes brush color, toggles features
```

Note: MAIN world and ISOLATED world content scripts on the same page communicate via `window.postMessage`, not `chrome.runtime.sendMessage`, because MAIN world scripts do not have access to Chrome extension APIs.

---

## chrome.storage API

`chrome.storage` provides persistent key-value storage for extensions. Unlike `localStorage`, it:

- Works in service workers (which have no `localStorage`)
- Can sync across devices (`chrome.storage.sync`)
- Supports change listeners

```typescript
// Save settings
await chrome.storage.local.set({
  brushColor: "#ff0000",
  brushSize: 4,
  isEnabled: true
});

// Read settings
const settings = await chrome.storage.local.get([
  "brushColor",
  "brushSize",
  "isEnabled"
]);
console.log(settings.brushColor); // "#ff0000"

// Listen for changes (works in any context)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (changes.brushColor) {
    console.log("Color changed from", changes.brushColor.oldValue,
                "to", changes.brushColor.newValue);
  }
});
```

### storage.local vs storage.sync

| Feature | `storage.local` | `storage.sync` |
|---|---|---|
| Size limit | ~10 MB | ~100 KB |
| Syncs across devices | No | Yes |
| Best for | Large data, temp state | User preferences |

For AirDraw, use `storage.local` for drawing data and `storage.sync` for user preferences like brush color.

---

## chrome.commands for Keyboard Shortcuts

Define keyboard shortcuts in the manifest:

```jsonc
{
  "commands": {
    "toggle-drawing": {
      "suggested_key": {
        "default": "Alt+D"
      },
      "description": "Toggle drawing mode"
    },
    "clear-canvas": {
      "suggested_key": {
        "default": "Alt+C"
      },
      "description": "Clear the canvas"
    }
  }
}
```

Handle them in the service worker:

```typescript
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-drawing") {
    // Toggle AirDraw on the active tab
  }
});
```

Users can remap these in `chrome://extensions/shortcuts`.

---

## Content Script Injection Timing

The `run_at` field controls when a content script is injected:

| Value | When | Use Case |
|---|---|---|
| `document_start` | Before any page JS runs | Monkey-patching APIs (getUserMedia) |
| `document_idle` | After DOM is ready | Adding overlay elements |
| `document_end` | After DOM is parsed but before subresources load | Rarely used |

**For AirDraw:**
- The MAIN world script that patches `getUserMedia` must run at `document_start` — if the page's JS calls `getUserMedia` before our patch is in place, we miss it.
- The ISOLATED world script that creates the overlay canvas should run at `document_idle` — it needs the DOM to be ready.

```jsonc
{
  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["src/content/patch-media.ts"],
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["src/content/overlay.ts"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    }
  ]
}
```

---

## Security: CSP in Extensions

### Extension CSP

MV3 enforces a strict Content Security Policy on extension pages (popup, options page):

- No inline scripts (`<script>alert(1)</script>` is blocked)
- No `eval()` or `new Function()`
- No remote code loading from CDNs

This means all your code must be bundled locally. You cannot load MediaPipe from a CDN in the popup or options page — it must be included in the extension package.

```jsonc
// You can relax CSP slightly for extension pages (not content scripts):
{
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

The `'wasm-unsafe-eval'` directive is critical for AirDraw because MediaPipe's hand tracking model uses WebAssembly.

### Why MAIN World Is Dangerous but Necessary

When your content script runs in MAIN world:

1. The page's CSP applies to your script, not the extension's CSP
2. The page can see and modify your code (it shares the same `window`)
3. A malicious page could override functions your script depends on
4. Your script has no access to `chrome.*` APIs

For AirDraw, we accept these risks because patching `getUserMedia` is impossible from ISOLATED world. We mitigate the risk by:

- Keeping the MAIN world script as small as possible (just the media patch)
- Saving references to original APIs before the page can tamper with them
- Communicating with the ISOLATED world script via `window.postMessage` with a unique message key that is hard to guess

```typescript
// MAIN world script — save originals immediately
const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
  navigator.mediaDevices
);
const originalRTCPeerConnection = window.RTCPeerConnection;

// Now even if the page overrides these later, we have clean references
```

---

## Putting It All Together: AirDraw's Extension Architecture

```
manifest.json
  |
  +-- service_worker: background.ts
  |     - Listens for chrome.action.onClicked
  |     - Manages extension state via chrome.storage
  |     - Relays messages between popup and content scripts
  |     - Handles chrome.commands keyboard shortcuts
  |
  +-- popup: popup.html + popup.ts
  |     - UI for brush color, size, clear canvas
  |     - Reads/writes chrome.storage.sync
  |     - Sends messages to content script via service worker
  |
  +-- content_scripts:
        |
        +-- patch-media.ts (MAIN world, document_start)
        |     - Patches getUserMedia to intercept camera stream
        |     - Replaces video track with composited canvas stream
        |     - Communicates with ISOLATED script via postMessage
        |
        +-- overlay.ts (ISOLATED world, document_idle)
              - Creates transparent overlay canvas
              - Loads and runs MediaPipe hand tracking
              - Draws on the overlay canvas based on hand gestures
              - Composites drawing with camera feed
              - Sends composited stream to MAIN world script
```

This architecture separates concerns cleanly: the MAIN world script does the minimum dangerous work (API patching), while the ISOLATED world script handles the heavy lifting (ML inference, canvas rendering) in a sandboxed environment with full access to Chrome extension APIs.
