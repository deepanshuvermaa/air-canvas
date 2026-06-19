# Vite, CRXJS & Extension Bundling

## What Is Vite?

Vite is a build tool created by Evan You (also the creator of Vue.js). It has two core components:

1. **Dev server:** Serves your source files as native ES modules. Instead of bundling everything before serving (like Webpack), Vite serves each module individually and lets the browser's native `import` handle dependency resolution. This makes dev startup nearly instant, regardless of project size.

2. **Production build:** Uses Rollup under the hood to produce optimized, tree-shaken bundles for deployment.

Vite uses **esbuild** for TypeScript and JSX transpilation (extremely fast, written in Go) and **Rollup** for the final production bundle (more configurable, supports code splitting).

---

## Why Vite Over Webpack for Extensions

### Webpack Pain Points for Extensions

- **Slow startup:** Webpack bundles everything before the dev server starts. For a project with MediaPipe WASM files, ML models, and multiple entry points, this can take 10-30 seconds.
- **Complex configuration:** A Chrome extension has 3-4 entry points (service worker, popup, content scripts). Configuring Webpack's multi-entry setup with HMR for each is painful.
- **HMR is fragile:** Webpack's HMR for Chrome extensions requires custom loaders and often breaks when you change the manifest.

### Vite Advantages

- **Fast dev startup:** ~300ms regardless of project size. No upfront bundling.
- **Native ESM:** Modern Chrome supports ES modules natively. Vite leverages this — no bundling needed during development.
- **Simple configuration:** Vite's config is minimal. Most of the complexity is handled by plugins (like CRXJS).
- **Fast production builds:** esbuild handles transpilation, Rollup handles bundling. Both are faster than Webpack for typical extension codebases.

---

## CRXJS: The Chrome Extension Plugin for Vite

[CRXJS](https://crxjs.dev/vite-plugin) is a Vite plugin that understands Chrome extension architecture. It reads your `manifest.json` and automatically:

1. Creates the right build entry points for each script declared in the manifest
2. Handles HMR for content scripts, popup, and the service worker
3. Manages `web_accessible_resources` for assets that content scripts need
4. Outputs a properly structured `dist/` directory that Chrome can load

### Setup

```bash
npm install @crxjs/vite-plugin --save-dev
```

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

export default defineConfig({
  plugins: [
    crx({ manifest }),
  ],
});
```

### How CRXJS Reads the Manifest

CRXJS scans your `manifest.json` and finds:

```jsonc
{
  "manifest_version": 3,
  "name": "AirDraw",
  "version": "1.0.0",
  "background": {
    "service_worker": "src/background/index.ts",  // → Entry point 1
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup/index.html"        // → Entry point 2
  },
  "content_scripts": [
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["src/content/patch-media.ts"],         // → Entry point 3
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["https://meet.google.com/*"],
      "js": ["src/content/overlay.ts"],             // → Entry point 4
      "run_at": "document_idle",
      "world": "ISOLATED"
    }
  ]
}
```

For each entry point, CRXJS configures Rollup to produce a separate output bundle. Content scripts are bundled as IIFE (to work in pages without module support). The service worker and popup are bundled as ES modules.

### Using TypeScript in the Manifest

CRXJS also supports defining the manifest in TypeScript, which gives you type-checking on the manifest itself:

```typescript
// manifest.config.ts
import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "AirDraw",
  version: "1.0.0",
  permissions: ["activeTab", "storage", "scripting"],
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["https://meet.google.com/*"],
      js: ["src/content/patch-media.ts"],
      run_at: "document_start",
      world: "MAIN",
    },
  ],
});
```

```typescript
// vite.config.ts
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [crx({ manifest })],
});
```

---

## Hot Module Replacement (HMR) in Extension Development

HMR is the ability to update code in a running application without a full reload. In normal web development, this means your React component re-renders with the new code while preserving state. In extension development, HMR is more complex because there are multiple contexts.

### How CRXJS Handles HMR

| Context | HMR Behavior |
|---|---|
| **Popup** | Full HMR — changes to popup code are reflected immediately while the popup is open |
| **Content scripts** | Page reloads — CRXJS reloads the tab when content script code changes |
| **Service worker** | Extension reloads — CRXJS reloads the entire extension (equivalent to clicking "Reload" on `chrome://extensions`) |
| **Manifest changes** | Full extension reload + re-register content scripts |

### The Dev Experience

During development:

1. Run `npm run dev` — Vite starts the dev server
2. Load the `dist/` directory as an unpacked extension in Chrome
3. Edit your popup code — the popup updates live
4. Edit your content script — the active tab reloads
5. Edit the manifest — the extension reloads

This is dramatically faster than the traditional workflow of running a build, going to `chrome://extensions`, clicking "Reload", then manually refreshing the page.

### HMR Caveats

- **Service worker HMR causes disconnections:** When the service worker restarts, all existing `chrome.runtime.connect()` ports break. Your content scripts need to handle reconnection.
- **Content script HMR reloads the page:** This means any state in the page (like an active video call) is lost. During development on Google Meet, you will need to rejoin the call after each content script change.
- **WASM files are not HMR-friendly:** Changes to WASM files or ML models require a full rebuild and extension reload.

---

## Handling Static Assets

### WASM Files for MediaPipe

MediaPipe requires several WASM files and a TFLite model file. These must be included in the extension package and made accessible to content scripts.

```
src/
  assets/
    mediapipe/
      wasm/
        vision_wasm_internal.wasm
        vision_wasm_internal.js
        vision_wasm_nosimd_internal.wasm
        vision_wasm_nosimd_internal.js
      hand_landmarker.task          (ML model, ~3-5 MB)
```

### Configuring Vite for Static Assets

Tell Vite to copy these files to the output directory without processing them:

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    crx({ manifest }),
    viteStaticCopy({
      targets: [
        {
          src: "src/assets/mediapipe/*",
          dest: "mediapipe",
        },
      ],
    }),
  ],
});
```

Alternatively, use Vite's `public/` directory:

```
public/
  mediapipe/
    wasm/
      vision_wasm_internal.wasm
      ...
    hand_landmarker.task
```

Files in `public/` are copied to the output directory as-is. Access them with `chrome.runtime.getURL("mediapipe/hand_landmarker.task")`.

### Referencing Assets from Content Scripts

Content scripts cannot use relative paths to load assets — they run in the context of the webpage, not the extension. Use `chrome.runtime.getURL()`:

```typescript
// ISOLATED world content script
const wasmPath = chrome.runtime.getURL("mediapipe/wasm");
const modelPath = chrome.runtime.getURL("mediapipe/hand_landmarker.task");

// These return URLs like:
// chrome-extension://abcdef123456/mediapipe/wasm
// chrome-extension://abcdef123456/mediapipe/hand_landmarker.task
```

**MAIN world content scripts cannot use `chrome.runtime.getURL`** because they do not have access to Chrome APIs. To get asset URLs in MAIN world:

```typescript
// ISOLATED world script sends the URL to MAIN world via postMessage
const wasmUrl = chrome.runtime.getURL("mediapipe/wasm");
window.postMessage({
  source: "airdraw-isolated",
  type: "ASSET_URLS",
  wasmUrl,
}, "*");
```

---

## Build Output: What Ends Up in dist/

After running `npm run build`, the `dist/` directory contains everything Chrome needs:

```
dist/
  manifest.json              ← Processed manifest (paths rewritten)
  service-worker.js          ← Bundled service worker
  popup/
    index.html               ← Popup HTML
    popup-[hash].js           ← Bundled popup JS
    popup-[hash].css          ← Popup styles
  content-scripts/
    patch-media-[hash].js    ← MAIN world content script (IIFE)
    overlay-[hash].js        ← ISOLATED world content script (IIFE)
  mediapipe/
    wasm/
      vision_wasm_internal.wasm
      vision_wasm_internal.js
      ...
    hand_landmarker.task
  icons/
    icon16.png
    icon48.png
    icon128.png
```

### What CRXJS Does to the Manifest

CRXJS rewrites paths in the manifest to point to the bundled output files:

```jsonc
// Input manifest
{
  "content_scripts": [{
    "js": ["src/content/overlay.ts"]
  }]
}

// Output manifest (in dist/)
{
  "content_scripts": [{
    "js": ["content-scripts/overlay-a1b2c3d4.js"]
  }]
}
```

### Content Hashes

Production builds include content hashes in filenames (`overlay-a1b2c3d4.js`). This ensures caching correctness — if the code changes, the filename changes, and Chrome loads the new version. CRXJS handles updating the manifest references automatically.

---

## web_accessible_resources

### What Are They?

By default, files inside a Chrome extension are not accessible to web pages. If a content script tries to fetch `chrome-extension://id/mediapipe/model.task`, the request is blocked unless that file is listed in `web_accessible_resources`.

### Why MediaPipe Needs This

MediaPipe's WASM loader fetches the WASM binary and model file via HTTP. Even though our content script initiated the load, the actual fetch happens in the page's context (for MAIN world) or needs explicit permission (for ISOLATED world with `fetch`).

```jsonc
{
  "web_accessible_resources": [
    {
      "resources": [
        "mediapipe/wasm/*",
        "mediapipe/hand_landmarker.task"
      ],
      "matches": [
        "https://meet.google.com/*",
        "https://teams.microsoft.com/*",
        "https://*.zoom.us/*"
      ]
    }
  ]
}
```

### Security Implications

Making resources web-accessible means any page matching the `matches` pattern can access those files. For WASM and ML models, this is low-risk — they are not sensitive. But never put API keys, configuration files, or internal extension pages in `web_accessible_resources`.

### CRXJS Auto-Detection

CRXJS can auto-detect which resources need to be web-accessible based on your content script imports. If your content script does:

```typescript
import wasmUrl from "../assets/mediapipe/wasm/vision.wasm?url";
```

CRXJS adds `vision.wasm` to `web_accessible_resources` automatically. However, for dynamically loaded resources (like MediaPipe's model file loaded at runtime), you need to declare them manually.

---

## Complete Vite Configuration for AirDraw

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import { viteStaticCopy } from "vite-plugin-static-copy";
import manifest from "./manifest.json";
import path from "path";

export default defineConfig({
  plugins: [
    crx({ manifest }),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@mediapipe/tasks-vision/wasm/*",
          dest: "mediapipe/wasm",
        },
      ],
    }),
  ],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },

  build: {
    // Avoid inlining assets — extension files must be separate files
    assetsInlineLimit: 0,

    rollupOptions: {
      output: {
        // Prevent code splitting for content scripts
        // (content scripts must be single files)
        manualChunks: undefined,
      },
    },
  },

  // Ensure WASM files are handled correctly
  optimizeDeps: {
    exclude: ["@mediapipe/tasks-vision"],
  },
});
```

### package.json Scripts

```jsonc
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "typecheck": "tsc --noEmit --watch",
    "preview": "vite preview",
    "lint": "eslint src/ --ext .ts,.tsx"
  }
}
```

### Development Workflow

```bash
# Terminal 1: Start Vite dev server
npm run dev

# Terminal 2: Run TypeScript type checker in watch mode
npm run typecheck

# In Chrome:
# 1. Go to chrome://extensions
# 2. Enable "Developer mode"
# 3. Click "Load unpacked"
# 4. Select the dist/ directory
# 5. The extension is now running with HMR
```

When you edit a file:
- Vite detects the change
- esbuild transpiles the TypeScript instantly
- CRXJS determines which part of the extension is affected
- The appropriate context (popup, content script, or service worker) is updated
- You see the changes immediately (or after a page/extension reload for content scripts/service worker)
