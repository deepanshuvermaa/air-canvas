/**
 * Post-build script: copies static assets to dist/ that Vite doesn't handle.
 * - manifest.json (with corrected paths)
 * - popup.html
 * - icons
 * - main-world.js
 */
import fs from 'fs';
import path from 'path';

const DIST = 'dist';

// Copy icons
const iconSizes = [16, 48, 128];
fs.mkdirSync(path.join(DIST, 'icons'), { recursive: true });
for (const size of iconSizes) {
  fs.copyFileSync(
    path.join('src', 'assets', `icon${size}.png`),
    path.join(DIST, 'icons', `icon${size}.png`)
  );
}

// Copy main-world.js
fs.copyFileSync(
  path.join('public', 'main-world.js'),
  path.join(DIST, 'main-world.js')
);

// Copy popup.css
fs.copyFileSync(
  path.join('src', 'popup', 'popup.css'),
  path.join(DIST, 'popup.css')
);

// Copy tracker files (offscreen document)
fs.copyFileSync(
  path.join('public', 'tracker.html'),
  path.join(DIST, 'tracker.html')
);
fs.copyFileSync(
  path.join('public', 'tracker.js'),
  path.join(DIST, 'tracker.js')
);

// Copy MediaPipe files
fs.mkdirSync(path.join(DIST, 'mediapipe', 'wasm'), { recursive: true });
fs.copyFileSync(
  path.join('public', 'mediapipe', 'vision_bundle.mjs'),
  path.join(DIST, 'mediapipe', 'vision_bundle.mjs')
);
fs.copyFileSync(
  path.join('public', 'mediapipe', 'hand_landmarker.task'),
  path.join(DIST, 'mediapipe', 'hand_landmarker.task')
);
// Copy all wasm files
const wasmDir = path.join('public', 'mediapipe', 'wasm');
for (const f of fs.readdirSync(wasmDir)) {
  fs.copyFileSync(
    path.join(wasmDir, f),
    path.join(DIST, 'mediapipe', 'wasm', f)
  );
}

// Copy popup.html — read from source and fix the script tag for production
let popupHtml = fs.readFileSync(path.join('src', 'popup', 'popup.html'), 'utf8');
// Replace the dev script tag with production one
popupHtml = popupHtml.replace(
  '<script type="module" src="popup.ts"></script>',
  '<script src="popup.js"></script>'
);
fs.writeFileSync(path.join(DIST, 'popup.html'), popupHtml);

// Write the production manifest (with corrected paths for dist/)
const manifest = {
  manifest_version: 3,
  name: "AirDraw \u2014 In-Air Whiteboard",
  version: "1.0.0",
  description: "Draw in the air during video calls. Your hand gestures become ink on your webcam feed, visible to everyone on the call.",
  icons: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  action: {
    default_popup: "popup.html",
    default_icon: {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png"
    }
  },
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  background: {
    service_worker: "service-worker.js",
    type: "module"
  },
  content_scripts: [
    {
      matches: [
        "https://meet.google.com/*",
        "https://*.zoom.us/*",
        "https://teams.microsoft.com/*",
        "https://teams.live.com/*"
      ],
      js: ["bootstrap.js"],
      run_at: "document_start",
      world: "ISOLATED"
    }
  ],
  permissions: ["activeTab", "storage"],
  commands: {
    "toggle-airdraw": {
      suggested_key: { default: "Alt+D", mac: "Alt+D" },
      description: "Toggle AirDraw on/off"
    },
    "clear-canvas": {
      suggested_key: { default: "Alt+C", mac: "Alt+C" },
      description: "Clear the drawing canvas"
    },
    "undo-stroke": {
      suggested_key: { default: "Alt+Z", mac: "Alt+Z" },
      description: "Undo last stroke"
    },
    "screen-mode": {
      suggested_key: { default: "Alt+S", mac: "Alt+S" },
      description: "Toggle Screen Annotation Mode"
    }
  },
  web_accessible_resources: [
    {
      resources: ["main-world.js", "mediapipe/*"],
      matches: [
        "https://meet.google.com/*",
        "https://*.zoom.us/*",
        "https://teams.microsoft.com/*",
        "https://teams.live.com/*"
      ]
    }
  ],
  host_permissions: [
    "https://meet.google.com/*",
    "https://*.zoom.us/*",
    "https://teams.microsoft.com/*",
    "https://teams.live.com/*"
  ]
};

fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log('Build assets copied to dist/');
