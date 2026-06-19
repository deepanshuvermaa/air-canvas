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

// Copy popup.html (rewrite script src to built output)
const popupHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AirDraw</title>
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div class="popup-container">
    <div class="header">
      <div class="logo">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="#FF3366" stroke-width="2"/>
          <path d="M8 16 C8 16, 10 8, 12 10 C14 12, 14 6, 16 8" stroke="#FF3366" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <span class="title">AirDraw</span>
      </div>
      <span class="version">v1.0</span>
    </div>
    <div class="status-section" id="status-section">
      <div class="status-row">
        <span class="status-label">Status</span>
        <span class="status-value" id="status-text">Inactive</span>
      </div>
      <button class="toggle-btn" id="toggle-btn">
        <span id="toggle-text">Enable AirDraw</span>
      </button>
      <p class="hint" id="page-hint" style="display: none;">
        Open Google Meet, Zoom Web, or Teams Web to use AirDraw.
      </p>
    </div>
    <div class="divider"></div>
    <div class="section">
      <h3 class="section-title">Tools</h3>
      <div class="tool-row">
        <button class="tool-btn" id="clear-btn" title="Clear canvas (Alt+C)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/><path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1h2.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/></svg>
          Clear
        </button>
        <button class="tool-btn" id="undo-btn" title="Undo (Alt+Z)">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466z"/></svg>
          Undo
        </button>
        <button class="tool-btn" id="redo-btn" title="Redo">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="transform: scaleX(-1)"><path fill-rule="evenodd" d="M8 3a5 5 0 1 1-4.546 2.914.5.5 0 0 0-.908-.417A6 6 0 1 0 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 0-.41-.192L5.23 2.308a.25.25 0 0 0 0 .384l2.36 1.966A.25.25 0 0 0 8 4.466z"/></svg>
          Redo
        </button>
        <button class="tool-btn" id="export-btn" title="Export as PNG">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/><path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/></svg>
          Export
        </button>
      </div>
    </div>
    <div class="divider"></div>
    <div class="section">
      <h3 class="section-title">Pen</h3>
      <div class="setting-row">
        <label>Color</label>
        <div class="color-picker-row">
          <div class="color-swatch active" data-color="#FF3366" style="background: #FF3366"></div>
          <div class="color-swatch" data-color="#3366FF" style="background: #3366FF"></div>
          <div class="color-swatch" data-color="#33CC66" style="background: #33CC66"></div>
          <div class="color-swatch" data-color="#FFCC00" style="background: #FFCC00"></div>
          <div class="color-swatch" data-color="#FFFFFF" style="background: #FFFFFF; border: 1px solid #555"></div>
          <input type="color" id="custom-color" value="#FF3366" class="custom-color-input" title="Custom color">
        </div>
      </div>
      <div class="setting-row">
        <label>Stroke Width</label>
        <div class="slider-row">
          <input type="range" id="stroke-width" min="1" max="12" value="4" step="1">
          <span class="slider-value" id="stroke-width-value">4px</span>
        </div>
      </div>
    </div>
    <div class="divider"></div>
    <div class="section">
      <h3 class="section-title">Modes</h3>
      <div class="setting-row toggle-row">
        <div>
          <label>Laser Pointer</label>
          <p class="setting-desc">Ink fades after a few seconds</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="fade-mode">
          <span class="switch-slider"></span>
        </label>
      </div>
      <div class="setting-row" id="fade-duration-row" style="display: none;">
        <label>Fade Duration</label>
        <div class="slider-row">
          <input type="range" id="fade-duration" min="500" max="5000" value="2000" step="250">
          <span class="slider-value" id="fade-duration-value">2.0s</span>
        </div>
      </div>
      <div class="setting-row toggle-row">
        <div>
          <label>Shape Snap</label>
          <p class="setting-desc">Auto-straighten circles, lines, rectangles</p>
        </div>
        <label class="switch">
          <input type="checkbox" id="shape-snap">
          <span class="switch-slider"></span>
        </label>
      </div>
    </div>
    <div class="divider"></div>
    <div class="section">
      <h3 class="section-title">Shortcuts</h3>
      <div class="shortcut-row"><span>Toggle AirDraw</span><kbd>Alt+D</kbd></div>
      <div class="shortcut-row"><span>Clear canvas</span><kbd>Alt+C</kbd></div>
      <div class="shortcut-row"><span>Undo</span><kbd>Alt+Z</kbd></div>
      <div class="shortcut-row"><span>Point to draw</span><kbd class="gesture">Index finger</kbd></div>
      <div class="shortcut-row"><span>Stop drawing</span><kbd class="gesture">Fist / Peace</kbd></div>
      <div class="shortcut-row"><span>Clear (gesture)</span><kbd class="gesture">Open palm</kbd></div>
    </div>
  </div>
  <script src="popup.js"></script>
</body>
</html>`;

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
  permissions: ["activeTab", "storage", "offscreen"],
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
    }
  },
  web_accessible_resources: [
    {
      resources: ["main-world.js"],
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
