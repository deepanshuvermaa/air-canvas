/**
 * MAIN WORLD — synchronous getUserMedia patch.
 * Production-quality AirDraw engine.
 */

(function () {
  'use strict';

  // ─── Trusted Types for Meet's CSP ───
  if (typeof window.trustedTypes !== 'undefined' && window.trustedTypes.createPolicy) {
    try {
      window.trustedTypes.createPolicy('default', {
        createScriptURL: function(url) { return url; },
        createHTML: function(html) { return html; },
        createScript: function(script) { return script; },
      });
    } catch (e) { /* already exists */ }
  }

  // ─── State ───
  var enabled = false;
  var realStream = null;
  var compositeCanvas = null;
  var compositeCtx = null;
  var drawingCanvas = null;
  var drawingCtx = null;
  var videoElement = null;
  var compositingActive = false;
  var handTracker = null;
  var trackingActive = false;
  var strokes = [];
  var currentStroke = null;
  var undoStack = [];
  var previousGestureState = 'IDLE';
  var cursorPos = null;
  var isCursorDrawing = false;
  var lastSmoothedPoint = null;
  var gestureState = 'IDLE';
  var gestureFrameCount = 0;
  var trackingFrameId = null;
  var compositeFrameId = null;
  var pipelineReady = false;
  var mediapipeBlobUrl = null;

  // ─── Select/Move state ───
  var selectedStrokeId = null;  // id of currently selected stroke
  var selectDragStart = null;   // finger position when drag started
  var lastDrawEndTime = 0;      // timestamp when last stroke ended (cooldown for erase)
  var mediapipeWasmPath = null;
  var mediapipeModelPath = null;

  // ─── Screen annotation mode ───
  var drawMode = 'WEBCAM'; // 'WEBCAM' or 'SCREEN'
  var screenOverlay = null;  // canvas element for screen annotation
  var screenCtx = null;
  var screenStrokes = [];    // separate stroke list for screen mode
  var screenCurrentStroke = null;
  var screenUndoStack = [];

  // ─── Pinch-to-click ───
  var lastClickTime = 0;
  var CLICK_COOLDOWN = 800; // ms between clicks (prevent rapid firing)

  // ─── Ghost Mode state ───
  var ghostState = 'idle'; // idle | recording | previewing | ready | active
  var ghostActive = false;
  var ghostLoopPlayer = null; // will be initialized on first use

  // ─── Ghost Mode: PiP preview ───
  var pipWindow = null;
  var pipVideo = null;

  // ─── Ghost Mode: Multi-clip ───
  var ghostClips = [];       // array of { blobUrl, durationMs, width, height }
  var ghostCurrentClipIdx = 0;
  var ghostClipSwitchTimer = null;

  // ─── Ghost Mode: Auto-mute ───
  var ghostSavedMuteState = false;
  var ghostAutoMuteEnabled = true;
  var capturedAudioTracks = []; // all audio tracks from any getUserMedia call

  // ─── Ghost Mode: Auto-return timer ───
  var ghostAutoReturnTimer = null;
  var ghostAutoReturnDuration = 0; // ms, 0 = disabled

  // ─── Ghost Mode: Name detection ───
  var ghostNameDetector = null;
  var ghostUserName = '';
  var ghostSpeechRecognition = null;

  // ─── Ghost Mode: Meeting monitor ───
  var ghostMeetingMonitor = null;

  var settings = {
    strokeColor: '#FF3366',
    strokeWidth: 5,
    fadeMode: false,
    fadeDuration: 2000,
    smoothing: 0.5,
    shapeSnap: false,
    shapeSnapThreshold: 0.25,
    smoothingAlpha: 0.35,   // lower = smoother (more lag), higher = more responsive
  };

  // ─── Patch getUserMedia IMMEDIATELY ───
  var originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    var stream = await originalGUM(constraints);

    // Capture ALL audio tracks for auto-mute feature
    var audioTracks = stream.getAudioTracks();
    for (var i = 0; i < audioTracks.length; i++) {
      if (capturedAudioTracks.indexOf(audioTracks[i]) === -1) {
        capturedAudioTracks.push(audioTracks[i]);
      }
    }

    if (constraints && constraints.video) {
      console.log('[AirDraw] Intercepted getUserMedia (video)');
      realStream = stream;
      try {
        return await buildPipeline(stream);
      } catch (e) {
        console.error('[AirDraw] Pipeline failed, returning raw stream:', e);
        return stream;
      }
    }
    return stream;
  };

  console.log('[AirDraw] getUserMedia patched');

  // ─── Helpers ───
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }

  // ─── Build pipeline ───
  async function buildPipeline(stream) {
    var videoTrack = stream.getVideoTracks()[0];
    var ts = videoTrack.getSettings();
    var width = ts.width || 640;
    var height = ts.height || 480;

    console.log('[AirDraw] Building pipeline ' + width + 'x' + height);

    videoElement = document.createElement('video');
    videoElement.srcObject = stream;
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.muted = true;
    videoElement.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.documentElement.appendChild(videoElement);

    await new Promise(function (resolve) {
      videoElement.onloadedmetadata = function () {
        videoElement.play().then(resolve).catch(resolve);
      };
      setTimeout(resolve, 3000);
    });

    compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = height;
    compositeCtx = compositeCanvas.getContext('2d');

    drawingCanvas = document.createElement('canvas');
    drawingCanvas.width = width;
    drawingCanvas.height = height;
    drawingCtx = drawingCanvas.getContext('2d');

    startCompositing();
    pipelineReady = true;

    var fakeStream = compositeCanvas.captureStream(30);
    var audioTracks = stream.getAudioTracks();
    for (var i = 0; i < audioTracks.length; i++) {
      fakeStream.addTrack(audioTracks[i]);
    }

    console.log('[AirDraw] Pipeline ready');

    if (enabled) {
      startHandTrackingIfNeeded(width, height);
    }

    return fakeStream;
  }

  // ─── Compositing loop ───
  function startCompositing() {
    if (compositingActive) return;
    compositingActive = true;

    function loop() {
      // Use setTimeout fallback during ghost mode (rAF throttles in background tabs)
      if (ghostActive) {
        compositeFrameId = setTimeout(loop, 33); // ~30fps
      } else {
        compositeFrameId = requestAnimationFrame(loop);
      }
      if (!compositeCtx || !videoElement || videoElement.readyState < 2) return;

      // Ghost mode: draw from recorded loop instead of live camera
      if (ghostActive && ghostLoopPlayer && ghostLoopPlayer.isReady()) {
        ghostLoopPlayer.drawFrame(compositeCtx, compositeCanvas.width, compositeCanvas.height);
      } else {
        compositeCtx.drawImage(videoElement, 0, 0, compositeCanvas.width, compositeCanvas.height);
      }

      // AirDraw ink is disabled during ghost mode (drawing while "away" is a giveaway)
      if (!ghostActive && enabled && drawingCanvas) {
        renderDrawing();
        compositeCtx.drawImage(drawingCanvas, 0, 0);
      }
    }

    compositeFrameId = requestAnimationFrame(loop);
  }

  // ─── Drawing renderer ───
  function renderDrawing() {
    if (!drawingCtx) return;
    var now = Date.now();
    var cw = drawingCanvas.width;
    var ch = drawingCanvas.height;

    drawingCtx.clearRect(0, 0, cw, ch);

    if (settings.fadeMode) {
      strokes = strokes.filter(function (s) { return (now - s.createdAt) < settings.fadeDuration; });
    }

    var allStrokes = currentStroke ? strokes.concat([currentStroke]) : strokes;

    for (var i = 0; i < allStrokes.length; i++) {
      var stroke = allStrokes[i];
      var alpha = 1;

      if (settings.fadeMode) {
        var age = now - stroke.createdAt;
        alpha = Math.max(0, 1 - age / settings.fadeDuration);
        if (alpha <= 0) continue;
      }

      // Highlight selected stroke
      var isSelected = (selectedStrokeId && stroke.id === selectedStrokeId);

      drawingCtx.globalAlpha = alpha;
      drawingCtx.strokeStyle = isSelected ? '#00DDFF' : stroke.color;
      drawingCtx.lineWidth = isSelected ? stroke.width + 2 : stroke.width;
      drawingCtx.lineCap = 'round';
      drawingCtx.lineJoin = 'round';

      // Draw selection glow
      if (isSelected) {
        drawingCtx.shadowColor = '#00DDFF';
        drawingCtx.shadowBlur = 10;
      }

      if (stroke.snappedShape) {
        renderShape(drawingCtx, stroke.snappedShape);
      } else if (stroke.points.length >= 2) {
        // Quadratic bezier smoothing for natural-looking strokes
        drawingCtx.beginPath();
        drawingCtx.moveTo(stroke.points[0].x, stroke.points[0].y);

        if (stroke.points.length === 2) {
          drawingCtx.lineTo(stroke.points[1].x, stroke.points[1].y);
        } else {
          for (var j = 1; j < stroke.points.length - 1; j++) {
            var cx = (stroke.points[j].x + stroke.points[j + 1].x) / 2;
            var cy = (stroke.points[j].y + stroke.points[j + 1].y) / 2;
            drawingCtx.quadraticCurveTo(stroke.points[j].x, stroke.points[j].y, cx, cy);
          }
          var last = stroke.points[stroke.points.length - 1];
          drawingCtx.lineTo(last.x, last.y);
        }
        drawingCtx.stroke();
      }

      // Reset shadow
      drawingCtx.shadowColor = 'transparent';
      drawingCtx.shadowBlur = 0;
    }

    drawingCtx.globalAlpha = 1;

    // Cursor indicator — distinct for each state
    if (cursorPos && enabled) {
      var gs = gestureState;

      if (gs === 'DRAWING') {
        // Filled colored dot + ring = pen is down
        drawingCtx.beginPath();
        drawingCtx.arc(cursorPos.x, cursorPos.y, settings.strokeWidth / 2 + 2, 0, 2 * Math.PI);
        drawingCtx.fillStyle = settings.strokeColor;
        drawingCtx.fill();
        drawingCtx.beginPath();
        drawingCtx.arc(cursorPos.x, cursorPos.y, settings.strokeWidth + 6, 0, 2 * Math.PI);
        drawingCtx.strokeStyle = settings.strokeColor;
        drawingCtx.lineWidth = 2;
        drawingCtx.globalAlpha = 0.5;
        drawingCtx.stroke();
        drawingCtx.globalAlpha = 1;
      } else if (gs === 'HOVERING') {
        // Hollow white circle = pen is up, you can reposition
        drawingCtx.beginPath();
        drawingCtx.arc(cursorPos.x, cursorPos.y, 10, 0, 2 * Math.PI);
        drawingCtx.strokeStyle = 'rgba(255,255,255,0.8)';
        drawingCtx.lineWidth = 2;
        drawingCtx.stroke();
        // Small crosshair
        drawingCtx.beginPath();
        drawingCtx.moveTo(cursorPos.x - 4, cursorPos.y);
        drawingCtx.lineTo(cursorPos.x + 4, cursorPos.y);
        drawingCtx.moveTo(cursorPos.x, cursorPos.y - 4);
        drawingCtx.lineTo(cursorPos.x, cursorPos.y + 4);
        drawingCtx.strokeStyle = 'rgba(255,255,255,0.6)';
        drawingCtx.lineWidth = 1;
        drawingCtx.stroke();
      } else if (gs === 'SELECTING') {
        // Cyan move cursor = select/drag mode
        drawingCtx.beginPath();
        drawingCtx.arc(cursorPos.x, cursorPos.y, 14, 0, 2 * Math.PI);
        drawingCtx.strokeStyle = selectedStrokeId ? 'rgba(0,221,255,0.9)' : 'rgba(0,221,255,0.5)';
        drawingCtx.lineWidth = 2;
        drawingCtx.stroke();
        // Move arrows
        var arrLen = 6;
        drawingCtx.beginPath();
        drawingCtx.strokeStyle = 'rgba(0,221,255,0.8)';
        drawingCtx.lineWidth = 1.5;
        // Up
        drawingCtx.moveTo(cursorPos.x, cursorPos.y - 5);
        drawingCtx.lineTo(cursorPos.x, cursorPos.y - 5 - arrLen);
        // Down
        drawingCtx.moveTo(cursorPos.x, cursorPos.y + 5);
        drawingCtx.lineTo(cursorPos.x, cursorPos.y + 5 + arrLen);
        // Left
        drawingCtx.moveTo(cursorPos.x - 5, cursorPos.y);
        drawingCtx.lineTo(cursorPos.x - 5 - arrLen, cursorPos.y);
        // Right
        drawingCtx.moveTo(cursorPos.x + 5, cursorPos.y);
        drawingCtx.lineTo(cursorPos.x + 5 + arrLen, cursorPos.y);
        drawingCtx.stroke();
      } else if (gs === 'ERASING') {
        // Red X = eraser mode
        drawingCtx.beginPath();
        drawingCtx.arc(cursorPos.x, cursorPos.y, 20, 0, 2 * Math.PI);
        drawingCtx.strokeStyle = 'rgba(255,80,80,0.7)';
        drawingCtx.lineWidth = 2;
        drawingCtx.stroke();
        drawingCtx.beginPath();
        drawingCtx.moveTo(cursorPos.x - 8, cursorPos.y - 8);
        drawingCtx.lineTo(cursorPos.x + 8, cursorPos.y + 8);
        drawingCtx.moveTo(cursorPos.x + 8, cursorPos.y - 8);
        drawingCtx.lineTo(cursorPos.x - 8, cursorPos.y + 8);
        drawingCtx.strokeStyle = 'rgba(255,80,80,0.9)';
        drawingCtx.lineWidth = 2;
        drawingCtx.stroke();
      }
    }
  }

  function renderShape(ctx, shape) {
    ctx.beginPath();
    if (shape.type === 'line') {
      ctx.moveTo(shape.start.x, shape.start.y);
      ctx.lineTo(shape.end.x, shape.end.y);
      ctx.stroke();
    } else if (shape.type === 'arrow') {
      ctx.moveTo(shape.start.x, shape.start.y);
      ctx.lineTo(shape.end.x, shape.end.y);
      ctx.stroke();
      var angle = Math.atan2(shape.end.y - shape.start.y, shape.end.x - shape.start.x);
      var hl = 15;
      ctx.beginPath();
      ctx.moveTo(shape.end.x, shape.end.y);
      ctx.lineTo(shape.end.x - hl * Math.cos(angle - Math.PI / 6), shape.end.y - hl * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(shape.end.x, shape.end.y);
      ctx.lineTo(shape.end.x - hl * Math.cos(angle + Math.PI / 6), shape.end.y - hl * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    } else if (shape.type === 'circle') {
      ctx.arc(shape.center.x, shape.center.y, shape.radius, 0, 2 * Math.PI);
      ctx.stroke();
    } else if (shape.type === 'rectangle') {
      ctx.rect(shape.topLeft.x, shape.topLeft.y, shape.width, shape.height);
      ctx.stroke();
    }
  }

  // ─── Screen annotation overlay ───
  function createScreenOverlay() {
    if (screenOverlay) return;
    screenOverlay = document.createElement('canvas');
    screenOverlay.id = 'airdraw-screen-overlay';
    screenOverlay.width = window.innerWidth;
    screenOverlay.height = window.innerHeight;
    screenOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999998;pointer-events:none;';
    document.body.appendChild(screenOverlay);
    screenCtx = screenOverlay.getContext('2d');

    // Resize on window resize
    window.addEventListener('resize', resizeScreenOverlay);
    console.log('[AirDraw] Screen overlay created');
  }

  function resizeScreenOverlay() {
    if (!screenOverlay) return;
    screenOverlay.width = window.innerWidth;
    screenOverlay.height = window.innerHeight;
  }

  function destroyScreenOverlay() {
    if (screenOverlay) {
      screenOverlay.remove();
      screenOverlay = null;
      screenCtx = null;
      window.removeEventListener('resize', resizeScreenOverlay);
      console.log('[AirDraw] Screen overlay removed');
    }
    screenStrokes = [];
    screenCurrentStroke = null;
    screenUndoStack = [];
  }

  function renderScreenOverlay() {
    if (!screenCtx || !screenOverlay) return;
    var now = Date.now();
    var cw = screenOverlay.width;
    var ch = screenOverlay.height;

    screenCtx.clearRect(0, 0, cw, ch);

    if (settings.fadeMode) {
      screenStrokes = screenStrokes.filter(function (s) { return (now - s.createdAt) < settings.fadeDuration; });
    }

    var allStrokes = screenCurrentStroke ? screenStrokes.concat([screenCurrentStroke]) : screenStrokes;

    for (var i = 0; i < allStrokes.length; i++) {
      var stroke = allStrokes[i];
      var alpha = 1;

      if (settings.fadeMode) {
        var age = now - stroke.createdAt;
        alpha = Math.max(0, 1 - age / settings.fadeDuration);
        if (alpha <= 0) continue;
      }

      screenCtx.globalAlpha = alpha;
      screenCtx.strokeStyle = stroke.color;
      screenCtx.lineWidth = stroke.width;
      screenCtx.lineCap = 'round';
      screenCtx.lineJoin = 'round';

      if (stroke.snappedShape) {
        renderShape(screenCtx, stroke.snappedShape);
      } else if (stroke.points.length >= 2) {
        screenCtx.beginPath();
        screenCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
        if (stroke.points.length === 2) {
          screenCtx.lineTo(stroke.points[1].x, stroke.points[1].y);
        } else {
          for (var j = 1; j < stroke.points.length - 1; j++) {
            var cx = (stroke.points[j].x + stroke.points[j + 1].x) / 2;
            var cy = (stroke.points[j].y + stroke.points[j + 1].y) / 2;
            screenCtx.quadraticCurveTo(stroke.points[j].x, stroke.points[j].y, cx, cy);
          }
          var last = stroke.points[stroke.points.length - 1];
          screenCtx.lineTo(last.x, last.y);
        }
        screenCtx.stroke();
      }
    }

    screenCtx.globalAlpha = 1;

    // Cursor on screen overlay
    if (cursorPos && enabled) {
      var gs = gestureState;
      if (gs === 'DRAWING') {
        screenCtx.beginPath();
        screenCtx.arc(cursorPos.x, cursorPos.y, settings.strokeWidth / 2 + 2, 0, 2 * Math.PI);
        screenCtx.fillStyle = settings.strokeColor;
        screenCtx.fill();
        screenCtx.beginPath();
        screenCtx.arc(cursorPos.x, cursorPos.y, settings.strokeWidth + 6, 0, 2 * Math.PI);
        screenCtx.strokeStyle = settings.strokeColor;
        screenCtx.lineWidth = 2;
        screenCtx.globalAlpha = 0.5;
        screenCtx.stroke();
        screenCtx.globalAlpha = 1;
      } else if (gs === 'HOVERING') {
        screenCtx.beginPath();
        screenCtx.arc(cursorPos.x, cursorPos.y, 12, 0, 2 * Math.PI);
        screenCtx.strokeStyle = 'rgba(255,255,255,0.8)';
        screenCtx.lineWidth = 2;
        screenCtx.stroke();
        screenCtx.beginPath();
        screenCtx.moveTo(cursorPos.x - 5, cursorPos.y);
        screenCtx.lineTo(cursorPos.x + 5, cursorPos.y);
        screenCtx.moveTo(cursorPos.x, cursorPos.y - 5);
        screenCtx.lineTo(cursorPos.x, cursorPos.y + 5);
        screenCtx.strokeStyle = 'rgba(255,255,255,0.6)';
        screenCtx.lineWidth = 1;
        screenCtx.stroke();
      } else if (gs === 'CLICKING') {
        // Green target for pinch-click
        screenCtx.beginPath();
        screenCtx.arc(cursorPos.x, cursorPos.y, 16, 0, 2 * Math.PI);
        screenCtx.strokeStyle = 'rgba(0,220,100,0.9)';
        screenCtx.lineWidth = 3;
        screenCtx.stroke();
        screenCtx.beginPath();
        screenCtx.arc(cursorPos.x, cursorPos.y, 4, 0, 2 * Math.PI);
        screenCtx.fillStyle = 'rgba(0,220,100,0.9)';
        screenCtx.fill();
      } else if (gs === 'ERASING') {
        screenCtx.beginPath();
        screenCtx.arc(cursorPos.x, cursorPos.y, 20, 0, 2 * Math.PI);
        screenCtx.strokeStyle = 'rgba(255,80,80,0.7)';
        screenCtx.lineWidth = 2;
        screenCtx.stroke();
      }
    }
  }

  // Screen annotation render loop (separate from composite)
  var screenRenderLoopId = null;
  function startScreenRenderLoop() {
    if (screenRenderLoopId) return;
    function loop() {
      screenRenderLoopId = requestAnimationFrame(loop);
      if (drawMode === 'SCREEN' && enabled) {
        renderScreenOverlay();
      }
    }
    screenRenderLoopId = requestAnimationFrame(loop);
  }
  function stopScreenRenderLoop() {
    if (screenRenderLoopId) {
      cancelAnimationFrame(screenRenderLoopId);
      screenRenderLoopId = null;
    }
  }

  // ─── Pinch-to-click ───
  function isPinching(landmarks) {
    if (!landmarks || landmarks.length < 21) return false;
    var thumbTip = landmarks[4];
    var indexTip = landmarks[8];
    var d = Math.sqrt(
      Math.pow(thumbTip.x - indexTip.x, 2) +
      Math.pow(thumbTip.y - indexTip.y, 2)
    );
    return d < 0.04;
  }

  function dispatchClick(x, y) {
    var now = Date.now();
    if (now - lastClickTime < CLICK_COOLDOWN) return;
    lastClickTime = now;

    // Find element at position and click it
    var el = document.elementFromPoint(x, y);
    if (el) {
      console.log('[AirDraw] Pinch-click at (' + Math.round(x) + ',' + Math.round(y) + ') on', el.tagName);
      var clickEvent = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        view: window
      });
      el.dispatchEvent(clickEvent);
    }
  }

  // ─── Shape detection ───
  // Order matters: check RECTANGLE before CIRCLE because a rectangle
  // that's roughly closed can be misdetected as a circle.
  function detectShape(stroke) {
    var pts = stroke.points;
    if (pts.length < 6) return null;

    var thresh = settings.shapeSnapThreshold || 0.25;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y > maxY) maxY = pts[i].y;
    }
    var bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    var center = { x: minX + bbox.width / 2, y: minY + bbox.height / 2 };
    var startEnd = dist(pts[0], pts[pts.length - 1]);
    var maxDim = Math.max(bbox.width, bbox.height);
    var isClosed = startEnd < maxDim * 0.35;
    var aspectRatio = bbox.width / (bbox.height || 1);

    // ── 1. RECTANGLE (check FIRST): closed, has corners, aspect ratio not 1:1 ──
    if (isClosed && bbox.width > 20 && bbox.height > 20) {
      var tol = maxDim * 0.22;
      var nearEdge = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var dLeft = Math.abs(p.x - bbox.x);
        var dRight = Math.abs(p.x - (bbox.x + bbox.width));
        var dTop = Math.abs(p.y - bbox.y);
        var dBottom = Math.abs(p.y - (bbox.y + bbox.height));
        if (Math.min(dLeft, dRight, dTop, dBottom) < tol) nearEdge++;
      }
      // Rectangle if >60% of points near edges AND aspect ratio is not too circular
      if (nearEdge / pts.length > 0.6 && (aspectRatio > 1.3 || aspectRatio < 0.77)) {
        return { type: 'rectangle', topLeft: { x: bbox.x, y: bbox.y }, width: bbox.width, height: bbox.height };
      }
      // Even with ~1:1 aspect, if edge-hugging is very strong, it's a square/rect
      if (nearEdge / pts.length > 0.75) {
        return { type: 'rectangle', topLeft: { x: bbox.x, y: bbox.y }, width: bbox.width, height: bbox.height };
      }
    }

    // ── 2. CIRCLE: closed, consistent radius, roughly 1:1 aspect ──
    if (isClosed && aspectRatio > 0.5 && aspectRatio < 2.0) {
      var avgR = 0;
      for (var i = 0; i < pts.length; i++) avgR += dist(pts[i], center);
      avgR /= pts.length;
      if (avgR > 12) {
        var variance = 0;
        for (var i = 0; i < pts.length; i++) {
          var d = dist(pts[i], center);
          var diff = (d - avgR) / avgR;
          variance += diff * diff;
        }
        variance /= pts.length;
        if (variance < thresh) {
          return { type: 'circle', center: center, radius: avgR };
        }
      }
    }

    // ── 3. LINE / ARROW: open stroke ──
    var start = pts[0], end = pts[pts.length - 1];
    var len = dist(start, end);
    if (len > 25 && !isClosed) {
      var maxDev = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var dx = end.x - start.x, dy = end.y - start.y;
        var lenSq = dx * dx + dy * dy;
        var t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / lenSq));
        var dev = Math.sqrt(Math.pow(p.x - (start.x + t * dx), 2) + Math.pow(p.y - (start.y + t * dy), 2));
        if (dev > maxDev) maxDev = dev;
      }
      if (maxDev / len < thresh) {
        var isArrow = false;
        if (pts.length >= 10) {
          var cut = Math.floor(pts.length * 0.8);
          var shaftAngle = Math.atan2(pts[cut].y - pts[0].y, pts[cut].x - pts[0].x);
          var headAngle = Math.atan2(end.y - pts[cut].y, end.x - pts[cut].x);
          var angleDiff = Math.abs(shaftAngle - headAngle);
          if (angleDiff > 0.3 && angleDiff < 2.8) isArrow = true;
        }
        return {
          type: isArrow ? 'arrow' : 'line',
          start: { x: start.x, y: start.y },
          end: { x: end.x, y: end.y }
        };
      }
    }

    return null;
  }

  // ─── Hand tracking ───
  function startHandTrackingIfNeeded(width, height) {
    if (trackingActive) return;
    if (!mediapipeBlobUrl) {
      setTimeout(function() { startHandTrackingIfNeeded(width, height); }, 500);
      return;
    }
    trackingActive = true;
    console.log('[AirDraw] Loading MediaPipe...');
    initAndRunTracking(width, height);
  }

  async function initAndRunTracking(width, height) {
    try {
      var vision = await import(mediapipeBlobUrl);
      var wasmFileset = await vision.FilesetResolver.forVisionTasks(mediapipeWasmPath);
      handTracker = await vision.HandLandmarker.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: mediapipeModelPath,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      console.log('[AirDraw] HandLandmarker ready');
      runTrackingLoop(width, height);
    } catch (e) {
      console.error('[AirDraw] MediaPipe init failed:', e);
      trackingActive = false;
    }
  }

  function runTrackingLoop(width, height) {
    function process() {
      if (!enabled || !trackingActive) { trackingFrameId = null; return; }
      trackingFrameId = requestAnimationFrame(process);
      if (!handTracker || !videoElement || videoElement.readyState < 2) return;

      try {
        var result = handTracker.detectForVideo(videoElement, performance.now());
        var landmarks = (result.landmarks && result.landmarks.length > 0) ? result.landmarks[0] : null;
        var gesture = detectGesture(landmarks, width, height);
        handleGesture(gesture);
      } catch (e) { /* skip frame */ }
    }
    trackingFrameId = requestAnimationFrame(process);
  }

  function stopTracking() {
    trackingActive = false;
    if (trackingFrameId) { cancelAnimationFrame(trackingFrameId); trackingFrameId = null; }
    cursorPos = null;
    lastSmoothedPoint = null;
    gestureState = 'IDLE';
    previousGestureState = 'IDLE';
    if (currentStroke) { strokes.push(currentStroke); currentStroke = null; }
  }

  // ─── Gesture detection ───
  function isFingerOpen(landmarks, tipIdx, pipIdx) {
    var wrist = landmarks[0];
    var tip = landmarks[tipIdx];
    var pip = landmarks[pipIdx];
    var tipDist = Math.sqrt(Math.pow(tip.x - wrist.x, 2) + Math.pow(tip.y - wrist.y, 2));
    var pipDist = Math.sqrt(Math.pow(pip.x - wrist.x, 2) + Math.pow(pip.y - wrist.y, 2));
    return tipDist > pipDist;
  }

  function detectGesture(landmarks, width, height) {
    if (!landmarks || landmarks.length < 21) {
      return transitionGesture('IDLE', null);
    }

    var indexOpen = isFingerOpen(landmarks, 8, 6);
    var middleOpen = isFingerOpen(landmarks, 12, 10);
    var ringOpen = isFingerOpen(landmarks, 16, 14);
    var pinkyOpen = isFingerOpen(landmarks, 20, 18);
    var openCount = (indexOpen ? 1 : 0) + (middleOpen ? 1 : 0) + (ringOpen ? 1 : 0) + (pinkyOpen ? 1 : 0);

    // Coordinate mapping depends on mode
    var targetW, targetH;
    if (drawMode === 'SCREEN' && screenOverlay) {
      targetW = screenOverlay.width;
      targetH = screenOverlay.height;
    } else {
      targetW = width;
      targetH = height;
    }

    // SCREEN mode: mirror x because webcam landmarks are mirrored relative to screen
    // WEBCAM mode: no mirror because composite draws raw camera (already mirrored)
    var rawX;
    if (drawMode === 'SCREEN') {
      rawX = (1 - landmarks[8].x) * targetW;
    } else {
      rawX = landmarks[8].x * targetW;
    }
    var rawY = landmarks[8].y * targetH;
    var now = Date.now();

    var fingerTip;
    if (lastSmoothedPoint) {
      fingerTip = {
        x: settings.smoothingAlpha * rawX + (1 - settings.smoothingAlpha) * lastSmoothedPoint.x,
        y: settings.smoothingAlpha * rawY + (1 - settings.smoothingAlpha) * lastSmoothedPoint.y,
        timestamp: now
      };
    } else {
      fingerTip = { x: rawX, y: rawY, timestamp: now };
    }
    lastSmoothedPoint = fingerTip;

    // ─── Pinch-to-click (screen mode only) ───
    if (drawMode === 'SCREEN' && isPinching(landmarks)) {
      return transitionGesture('CLICKING', fingerTip);
    }

    // ─── Gesture classification ───
    // ERASING:   all 4 fingers open (open palm)
    // SELECTING: index + middle + ring open (3 fingers) = select/move/delete
    // DRAWING:   index only = pen down
    // HOVERING:  index + middle (peace) = pen up, reposition
    // IDLE:      fist
    if (openCount >= 4) return transitionGesture('ERASING', fingerTip);
    if (indexOpen && middleOpen && ringOpen && !pinkyOpen && openCount === 3) return transitionGesture('SELECTING', fingerTip);
    if (indexOpen && !middleOpen && openCount === 1) return transitionGesture('DRAWING', fingerTip);
    if (indexOpen && middleOpen && openCount === 2) return transitionGesture('HOVERING', fingerTip);
    if (openCount === 0) return transitionGesture('IDLE', fingerTip);
    return transitionGesture('HOVERING', fingerTip);
  }

  function transitionGesture(candidate, fingerTip) {
    if (candidate === gestureState) {
      gestureFrameCount = 0;
    } else {
      gestureFrameCount++;

      var threshold = 3;

      if (gestureState === 'DRAWING' && candidate === 'HOVERING') threshold = 5;
      if (gestureState === 'DRAWING' && candidate === 'IDLE') threshold = 10;
      // FIX: After drawing, hand naturally opens → triggers erase.
      // 18 frames = ~600ms prevents accidental erase after drawing a shape.
      if (gestureState === 'DRAWING' && candidate === 'ERASING') threshold = 18;
      if (gestureState === 'HOVERING' && candidate === 'DRAWING') threshold = 12;
      if (gestureState === 'IDLE' && candidate === 'DRAWING') threshold = 5;
      if (candidate === 'CLICKING') threshold = 4;
      if (gestureState === 'CLICKING') threshold = 5;
      // SELECTING transitions
      if (candidate === 'SELECTING') threshold = 5;
      if (gestureState === 'SELECTING' && candidate !== 'SELECTING') threshold = 5;
      // After recently finishing a stroke, block erase for 1 second
      if (candidate === 'ERASING' && (Date.now() - lastDrawEndTime) < 1000) threshold = 30;

      if (gestureFrameCount >= threshold) {
        gestureState = candidate;
        gestureFrameCount = 0;
        if (candidate === 'IDLE') lastSmoothedPoint = null;
      }
    }
    return { state: gestureState, fingerTip: fingerTip };
  }

  function handleGesture(result) {
    var state = result.state;
    var fingerTip = result.fingerTip;

    cursorPos = fingerTip;
    isCursorDrawing = (state === 'DRAWING');

    // Route to correct stroke list based on draw mode
    var activeStrokes = (drawMode === 'SCREEN') ? screenStrokes : strokes;
    var activeCurrent = (drawMode === 'SCREEN') ? screenCurrentStroke : currentStroke;
    var activeUndo = (drawMode === 'SCREEN') ? screenUndoStack : undoStack;

    if (state === 'DRAWING' && fingerTip) {
      if (previousGestureState !== 'DRAWING') {
        var newStroke = {
          id: uid(),
          points: [fingerTip],
          color: settings.strokeColor,
          width: settings.strokeWidth,
          createdAt: Date.now(),
          snappedShape: null
        };
        if (drawMode === 'SCREEN') {
          screenCurrentStroke = newStroke;
        } else {
          currentStroke = newStroke;
        }
      } else {
        var cs = (drawMode === 'SCREEN') ? screenCurrentStroke : currentStroke;
        if (cs) {
          var lastPt = cs.points[cs.points.length - 1];
          var d = dist(fingerTip, lastPt);
          if (d > 2) {
            cs.points.push(fingerTip);
          }
        }
      }
    }

    // Pen lifted
    if (previousGestureState === 'DRAWING' && state !== 'DRAWING') {
      var cs = (drawMode === 'SCREEN') ? screenCurrentStroke : currentStroke;
      if (cs) {
        if (settings.shapeSnap && cs.points.length >= 6) {
          var shape = detectShape(cs);
          if (shape) cs.snappedShape = shape;
        }
        if (cs.points.length >= 3) {
          if (drawMode === 'SCREEN') {
            screenStrokes.push(cs);
            screenUndoStack = [];
          } else {
            strokes.push(cs);
            undoStack = [];
          }
        }
        if (drawMode === 'SCREEN') {
          screenCurrentStroke = null;
        } else {
          currentStroke = null;
        }
      }
      lastDrawEndTime = Date.now(); // cooldown for accidental erase
    }

    // Pinch-to-click (screen mode only, not while selecting)
    if (state === 'CLICKING' && fingerTip && previousGestureState !== 'CLICKING' && !selectedStrokeId) {
      dispatchClick(fingerTip.x, fingerTip.y);
    }

    // ─── SELECT / MOVE / DELETE ───
    // 3 fingers (index+middle+ring) = select mode
    if (state === 'SELECTING' && fingerTip) {
      var targetStrokes = (drawMode === 'SCREEN') ? screenStrokes : strokes;

      if (previousGestureState !== 'SELECTING') {
        // Just entered select mode — find nearest stroke
        var nearestId = null;
        var nearestDist = Infinity;
        for (var i = 0; i < targetStrokes.length; i++) {
          for (var j = 0; j < targetStrokes[i].points.length; j++) {
            var d = dist(targetStrokes[i].points[j], fingerTip);
            if (d < nearestDist) {
              nearestDist = d;
              nearestId = targetStrokes[i].id;
            }
          }
          // Also check snapped shape center
          if (targetStrokes[i].snappedShape) {
            var sh = targetStrokes[i].snappedShape;
            var shCenter;
            if (sh.type === 'circle') shCenter = sh.center;
            else if (sh.type === 'rectangle') shCenter = { x: sh.topLeft.x + sh.width / 2, y: sh.topLeft.y + sh.height / 2 };
            else if (sh.type === 'line' || sh.type === 'arrow') shCenter = { x: (sh.start.x + sh.end.x) / 2, y: (sh.start.y + sh.end.y) / 2 };
            if (shCenter) {
              var dc = dist(shCenter, fingerTip);
              if (dc < nearestDist) { nearestDist = dc; nearestId = targetStrokes[i].id; }
            }
          }
        }
        if (nearestDist < 80) {
          selectedStrokeId = nearestId;
          selectDragStart = { x: fingerTip.x, y: fingerTip.y };
        } else {
          selectedStrokeId = null;
          selectDragStart = null;
        }
      } else if (selectedStrokeId && selectDragStart) {
        // Dragging — move the selected stroke
        var dx = fingerTip.x - selectDragStart.x;
        var dy = fingerTip.y - selectDragStart.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          for (var i = 0; i < targetStrokes.length; i++) {
            if (targetStrokes[i].id === selectedStrokeId) {
              // Move all points
              for (var j = 0; j < targetStrokes[i].points.length; j++) {
                targetStrokes[i].points[j].x += dx;
                targetStrokes[i].points[j].y += dy;
              }
              // Move snapped shape
              if (targetStrokes[i].snappedShape) {
                var sh = targetStrokes[i].snappedShape;
                if (sh.type === 'circle') { sh.center.x += dx; sh.center.y += dy; }
                else if (sh.type === 'rectangle') { sh.topLeft.x += dx; sh.topLeft.y += dy; }
                else if (sh.type === 'line' || sh.type === 'arrow') {
                  sh.start.x += dx; sh.start.y += dy;
                  sh.end.x += dx; sh.end.y += dy;
                }
              }
              break;
            }
          }
          selectDragStart = { x: fingerTip.x, y: fingerTip.y };
        }
      }
    }

    // Pinch while selecting = delete selected stroke
    if (state === 'CLICKING' && selectedStrokeId && previousGestureState === 'SELECTING') {
      var targetStrokes = (drawMode === 'SCREEN') ? screenStrokes : strokes;
      var targetUndo = (drawMode === 'SCREEN') ? screenUndoStack : undoStack;
      for (var i = 0; i < targetStrokes.length; i++) {
        if (targetStrokes[i].id === selectedStrokeId) {
          targetUndo.push(targetStrokes[i]);
          targetStrokes.splice(i, 1);
          break;
        }
      }
      selectedStrokeId = null;
      selectDragStart = null;
    }

    // Deselect when leaving select mode (not to clicking)
    if (previousGestureState === 'SELECTING' && state !== 'SELECTING' && state !== 'CLICKING') {
      selectedStrokeId = null;
      selectDragStart = null;
    }

    // Selective eraser — with post-draw cooldown protection
    if (state === 'ERASING' && fingerTip && previousGestureState !== 'ERASING') {
      // Skip erase if we just finished drawing (hand opens naturally)
      if ((Date.now() - lastDrawEndTime) < 1000) {
        // Do nothing — cooldown active
      } else {
        var targetStrokes = (drawMode === 'SCREEN') ? screenStrokes : strokes;
        var targetUndo = (drawMode === 'SCREEN') ? screenUndoStack : undoStack;
        var eraserRadius = 50;
        var remaining = [];
        for (var i = 0; i < targetStrokes.length; i++) {
          var strokeNear = false;
          for (var j = 0; j < targetStrokes[i].points.length; j++) {
            if (dist(targetStrokes[i].points[j], fingerTip) < eraserRadius) {
              strokeNear = true;
              break;
            }
          }
          if (strokeNear) {
            targetUndo.push(targetStrokes[i]);
          } else {
            remaining.push(targetStrokes[i]);
          }
        }
        if (remaining.length < targetStrokes.length) {
          if (drawMode === 'SCREEN') { screenStrokes = remaining; }
          else { strokes = remaining; }
        } else {
          if (drawMode === 'SCREEN') {
            screenUndoStack = screenUndoStack.concat(screenStrokes);
            screenStrokes = [];
          } else {
            undoStack = undoStack.concat(strokes);
            strokes = [];
          }
        }
        if (drawMode === 'SCREEN') { screenCurrentStroke = null; }
        else { currentStroke = null; }
      }
    }

    previousGestureState = state;
  }

  // ─── Ghost Mode: Inline LoopRecorder + ArtifactEngine + LoopPlayer ───
  // (Can't use ES module imports in MAIN world, so everything is inlined)

  var GhostRecorder = {
    mediaRecorder: null,
    chunks: [],
    currentBlobUrl: null,

    record: function (realVideo) {
      var self = this;
      return new Promise(function (resolve, reject) {
        var stream = realVideo.srcObject;
        if (!stream) { reject(new Error('No srcObject')); return; }
        var videoTracks = stream.getVideoTracks();
        if (videoTracks.length === 0) { reject(new Error('No video tracks')); return; }

        var ts = videoTracks[0].getSettings();
        var w = ts.width || realVideo.videoWidth || 640;
        var h = ts.height || realVideo.videoHeight || 480;
        var videoOnlyStream = new MediaStream(videoTracks);

        self.destroy();

        var mimeType = 'video/webm';
        var candidates = ['video/webm; codecs=vp9', 'video/webm; codecs=vp8', 'video/webm'];
        for (var i = 0; i < candidates.length; i++) {
          if (MediaRecorder.isTypeSupported(candidates[i])) { mimeType = candidates[i]; break; }
        }

        try {
          self.mediaRecorder = new MediaRecorder(videoOnlyStream, { mimeType: mimeType, videoBitsPerSecond: 1500000 });
        } catch (e) {
          self.mediaRecorder = new MediaRecorder(videoOnlyStream, { videoBitsPerSecond: 1500000 });
        }

        self.chunks = [];
        self.mediaRecorder.ondataavailable = function (e) { if (e.data.size > 0) self.chunks.push(e.data); };
        self.mediaRecorder.onstop = function () {
          var blob = new Blob(self.chunks, { type: mimeType });
          self.currentBlobUrl = URL.createObjectURL(blob);
          self.chunks = [];
          resolve({ blobUrl: self.currentBlobUrl, durationMs: 5500, width: w, height: h });
        };
        self.mediaRecorder.onerror = function (e) { reject(e); };

        self.mediaRecorder.start(500);
        setTimeout(function () {
          if (self.mediaRecorder && self.mediaRecorder.state === 'recording') self.mediaRecorder.stop();
        }, 5500);
      });
    },

    destroy: function () {
      if (this.currentBlobUrl) { URL.revokeObjectURL(this.currentBlobUrl); this.currentBlobUrl = null; }
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') this.mediaRecorder.stop();
      this.mediaRecorder = null;
      this.chunks = [];
    }
  };

  var GhostArtifacts = {
    intensity: 50,
    wavePhase: Math.random() * Math.PI * 2,
    waveFreq: 0.05 + Math.random() * 0.08,
    secondaryPhase: Math.random() * Math.PI * 2,
    secondaryFreq: 0.12 + Math.random() * 0.1,
    inFreezeBurst: false,
    freezeFramesRemaining: 0,
    inFramerateDip: false,
    framerateDipUntil: 0,
    lastFramerateDipEnd: 0,
    nextFramerateDipInterval: 10000 + Math.random() * 10000,
    loopDurationMs: 5000,

    setIntensity: function (v) { this.intensity = Math.max(0, Math.min(100, v)); },

    getQuality: function (now) {
      var t = now / 1000;
      var w1 = Math.sin(t * this.waveFreq * Math.PI * 2 + this.wavePhase);
      var w2 = Math.sin(t * this.secondaryFreq * Math.PI * 2 + this.secondaryPhase);
      return (w1 * 0.6 + w2 * 0.4 + 1) / 2;
    },

    decide: function (videoCurrentTime) {
      var now = performance.now();
      var scale = this.intensity / 100;
      var d = { freeze: false, qualityDrop: false, catchUpJump: 0, alpha: 1.0 };
      if (scale < 0.01) return d;

      var quality = this.getQuality(now);

      // Active freeze burst — SHORTER bursts (1-4 frames = 33-133ms)
      // Real bad connections freeze briefly, not for seconds
      if (this.inFreezeBurst) {
        this.freezeFramesRemaining--;
        d.freeze = true;
        // Quality drop more often during freeze (pixelated catch-up frame)
        if (Math.random() < 0.3 * scale) d.qualityDrop = true;
        if (this.freezeFramesRemaining <= 0) {
          this.inFreezeBurst = false;
          d.freeze = false;
          d.catchUpJump = 0.03 + Math.random() * 0.08; // smaller jumps
          d.qualityDrop = Math.random() < 0.4 * scale; // catch-up frame often pixelated
        }
        return d;
      }

      // Start new freeze burst — shorter, more frequent
      if (quality < 0.4 * scale && Math.random() < 0.08 * scale) {
        this.inFreezeBurst = true;
        // 1-4 frames (33-133ms) — brief hitches, not long freezes
        this.freezeFramesRemaining = 1 + Math.floor(Math.random() * 4 * scale);
        d.freeze = true;
        return d;
      }

      // Micro-stutter (1-frame duplicate)
      if (quality < 0.55 && Math.random() < 0.04 * scale) {
        d.freeze = true;
        return d;
      }

      // Occasional quality drop WITHOUT freeze (like adaptive bitrate)
      if (quality < 0.45 && Math.random() < 0.06 * scale) {
        d.qualityDrop = true;
        return d;
      }

      // Loop seam: brief freeze + quality drop to mask the cut
      var loopSec = this.loopDurationMs / 1000;
      var distFromSeam = Math.min(videoCurrentTime, Math.abs(loopSec - videoCurrentTime));
      if (distFromSeam < 0.2) {
        if (Math.random() < 0.5 * scale) {
          this.inFreezeBurst = true;
          this.freezeFramesRemaining = 2 + Math.floor(Math.random() * 3);
          d.freeze = true;
          d.qualityDrop = true;
          return d;
        }
      }

      // Framerate dip — shorter (300-800ms)
      if (this.inFramerateDip) {
        if (now > this.framerateDipUntil) {
          this.inFramerateDip = false;
          this.lastFramerateDipEnd = now;
          this.nextFramerateDipInterval = 12000 + Math.random() * 18000;
        } else if (Math.random() < 0.35) {
          d.freeze = true; // skip ~35% of frames = ~20fps feel
        }
      } else if (scale > 0 && now - this.lastFramerateDipEnd > this.nextFramerateDipInterval / scale) {
        this.inFramerateDip = true;
        this.framerateDipUntil = now + 300 + Math.random() * 500;
      }

      return d;
    }
  };

  ghostLoopPlayer = {
    loopVideo: null,
    blobUrl: null,
    ready: false,
    loopStartSec: 0.25,
    loopEndSec: 5.0,
    offCanvas: null,
    offCtx: null,

    prepare: function (realVideoEl, onProgress) {
      var self = this;
      this.destroyLoop();

      var progressInterval;
      if (onProgress) {
        var start = performance.now();
        progressInterval = setInterval(function () {
          var remaining = Math.max(0, Math.ceil((5500 - (performance.now() - start)) / 1000));
          onProgress(remaining);
        }, 500);
      }

      return GhostRecorder.record(realVideoEl).then(function (result) {
        if (progressInterval) clearInterval(progressInterval);
        self.blobUrl = result.blobUrl;
        self.loopVideo = document.createElement('video');
        self.loopVideo.src = self.blobUrl;
        self.loopVideo.loop = false;
        self.loopVideo.muted = true;
        self.loopVideo.playsInline = true;
        self.loopVideo.style.display = 'none';

        self.loopEndSec = result.durationMs / 1000 - 0.25;
        GhostArtifacts.loopDurationMs = (self.loopEndSec - self.loopStartSec) * 1000;

        self.offCanvas = document.createElement('canvas');
        self.offCtx = self.offCanvas.getContext('2d');

        return new Promise(function (resolve, reject) {
          self.loopVideo.onloadedmetadata = function () {
            self.loopVideo.currentTime = self.loopStartSec;
            self.loopVideo.play().then(function () {
              self.ready = true;
              resolve();
            }).catch(reject);
          };
          self.loopVideo.onerror = function () { reject(new Error('Loop video load failed')); };
        });
      }).catch(function (e) {
        if (progressInterval) clearInterval(progressInterval);
        throw e;
      });
    },

    isReady: function () {
      return this.ready && this.loopVideo && this.loopVideo.readyState >= 2;
    },

    drawFrame: function (ctx, w, h) {
      if (!this.loopVideo || this.loopVideo.readyState < 2) return;

      // Manual loop
      if (this.loopVideo.currentTime >= this.loopEndSec) {
        this.loopVideo.currentTime = this.loopStartSec;
      }

      var relTime = this.loopVideo.currentTime - this.loopStartSec;
      var d = GhostArtifacts.decide(relTime);

      if (d.catchUpJump > 0) {
        this.loopVideo.currentTime = Math.min(this.loopVideo.currentTime + d.catchUpJump, this.loopEndSec - 0.1);
      }

      if (d.freeze) return;

      if (d.qualityDrop && this.offCanvas && this.offCtx) {
        // Draw at 25-35% resolution for visible but not extreme pixelation
        var scaleFactor = 0.25 + Math.random() * 0.1;
        var sw = Math.floor(w * scaleFactor), sh = Math.floor(h * scaleFactor);
        this.offCanvas.width = sw;
        this.offCanvas.height = sh;
        // Disable image smoothing for blocky upscale (like real codec artifacts)
        this.offCtx.imageSmoothingEnabled = false;
        this.offCtx.drawImage(this.loopVideo, 0, 0, sw, sh);
        var prev = ctx.globalAlpha;
        ctx.globalAlpha = d.alpha;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.offCanvas, 0, 0, w, h);
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = prev;
        return;
      }

      if (d.alpha < 1.0) {
        var prev = ctx.globalAlpha;
        ctx.globalAlpha = d.alpha;
        ctx.drawImage(this.loopVideo, 0, 0, w, h);
        ctx.globalAlpha = prev;
      } else {
        ctx.drawImage(this.loopVideo, 0, 0, w, h);
      }
    },

    setIntensity: function (v) { GhostArtifacts.setIntensity(v); },

    destroy: function () { this.destroyLoop(); GhostRecorder.destroy(); },

    destroyLoop: function () {
      if (this.loopVideo) { this.loopVideo.pause(); this.loopVideo.src = ''; this.loopVideo.load(); this.loopVideo = null; }
      if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
      this.offCanvas = null;
      this.offCtx = null;
      this.ready = false;
    }
  };

  // ─── Feature 1: PiP Preview Window ───
  // Shows users what meeting participants see in a floating always-on-top window

  function startPiP() {
    // PiP requires a user gesture — we prepare the video but DON'T request PiP
    // PiP will be requested from a user-gesture context (popup button click)
    if (pipVideo) return;
    if (!compositeCanvas) return;

    pipVideo = document.createElement('video');
    pipVideo.srcObject = compositeCanvas.captureStream(15);
    pipVideo.muted = true;
    pipVideo.playsInline = true;
    pipVideo.autoplay = true;
    pipVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.documentElement.appendChild(pipVideo);
    pipVideo.play().catch(function () {});
  }

  // Called from a user-gesture context (message from popup button click)
  function requestPiP() {
    if (!pipVideo) startPiP();
    if (pipVideo && document.pictureInPictureEnabled && !document.pictureInPictureElement) {
      pipVideo.requestPictureInPicture().then(function (win) {
        pipWindow = win;
        win.addEventListener('leavepictureinpicture', function () {
          pipWindow = null;
        });
      }).catch(function (e) {
        console.warn('[AirDraw] PiP not available:', e);
      });
    }
  }

  function stopPiP() {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(function () {});
    }
    if (pipVideo) {
      pipVideo.srcObject = null;
      pipVideo.remove();
      pipVideo = null;
    }
    pipWindow = null;
  }

  // ─── Feature 3: Multi-clip Rotation ───
  // Records multiple clips and rotates between them during ghost mode

  var GhostMultiRecorder = {
    clipCount: 3,
    clipDurationMs: 8000,
    currentRecording: 0,
    clips: [],
    onClipProgress: null,

    recordAll: function (realVideo, onProgress, onClipDone) {
      var self = this;
      self.destroyAll();
      self.clips = [];
      self.currentRecording = 0;
      self.onClipProgress = onProgress;

      return self._recordNext(realVideo, onClipDone);
    },

    _recordNext: function (realVideo, onClipDone) {
      var self = this;
      if (self.currentRecording >= self.clipCount) {
        return Promise.resolve(self.clips);
      }

      var clipNum = self.currentRecording + 1;
      if (self.onClipProgress) self.onClipProgress(clipNum, self.clipCount, self.clipDurationMs / 1000);

      return self._recordSingleClip(realVideo).then(function (clip) {
        self.clips.push(clip);
        if (onClipDone) onClipDone(clipNum, self.clipCount);
        self.currentRecording++;
        return self._recordNext(realVideo, onClipDone);
      });
    },

    _recordSingleClip: function (realVideo) {
      var self = this;
      return new Promise(function (resolve, reject) {
        var stream = realVideo.srcObject;
        if (!stream) { reject(new Error('No srcObject')); return; }
        var videoTracks = stream.getVideoTracks();
        if (videoTracks.length === 0) { reject(new Error('No video tracks')); return; }

        var ts = videoTracks[0].getSettings();
        var w = ts.width || realVideo.videoWidth || 640;
        var h = ts.height || realVideo.videoHeight || 480;
        var videoOnlyStream = new MediaStream(videoTracks);

        var mimeType = 'video/webm';
        var candidates = ['video/webm; codecs=vp9', 'video/webm; codecs=vp8', 'video/webm'];
        for (var i = 0; i < candidates.length; i++) {
          if (MediaRecorder.isTypeSupported(candidates[i])) { mimeType = candidates[i]; break; }
        }

        var recorder;
        try {
          recorder = new MediaRecorder(videoOnlyStream, { mimeType: mimeType, videoBitsPerSecond: 1500000 });
        } catch (e) {
          recorder = new MediaRecorder(videoOnlyStream, { videoBitsPerSecond: 1500000 });
        }

        var chunks = [];
        recorder.ondataavailable = function (e) { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = function () {
          var blob = new Blob(chunks, { type: mimeType });
          var blobUrl = URL.createObjectURL(blob);
          resolve({ blobUrl: blobUrl, durationMs: self.clipDurationMs, width: w, height: h });
        };
        recorder.onerror = function (e) { reject(e); };

        recorder.start(500);
        setTimeout(function () {
          if (recorder.state === 'recording') recorder.stop();
        }, self.clipDurationMs);
      });
    },

    destroyAll: function () {
      for (var i = 0; i < this.clips.length; i++) {
        if (this.clips[i].blobUrl) URL.revokeObjectURL(this.clips[i].blobUrl);
      }
      this.clips = [];
      this.currentRecording = 0;
    }
  };

  // Modified ghostLoopPlayer to support multi-clip rotation
  function switchToClip(clipIdx) {
    if (!ghostClips[clipIdx]) return;
    var clip = ghostClips[clipIdx];
    ghostCurrentClipIdx = clipIdx;

    if (ghostLoopPlayer.loopVideo) {
      ghostLoopPlayer.loopVideo.pause();
    }

    ghostLoopPlayer.blobUrl = clip.blobUrl;
    if (!ghostLoopPlayer.loopVideo) {
      ghostLoopPlayer.loopVideo = document.createElement('video');
      ghostLoopPlayer.loopVideo.muted = true;
      ghostLoopPlayer.loopVideo.playsInline = true;
      ghostLoopPlayer.loopVideo.style.display = 'none';
    }
    ghostLoopPlayer.loopVideo.src = clip.blobUrl;
    ghostLoopPlayer.loopEndSec = clip.durationMs / 1000 - 0.25;
    ghostLoopPlayer.loopStartSec = 0.25;
    GhostArtifacts.loopDurationMs = (ghostLoopPlayer.loopEndSec - ghostLoopPlayer.loopStartSec) * 1000;

    ghostLoopPlayer.loopVideo.currentTime = ghostLoopPlayer.loopStartSec;
    ghostLoopPlayer.loopVideo.play().catch(function () {});
    ghostLoopPlayer.ready = true;
  }

  function startClipRotation() {
    if (ghostClips.length <= 1) return;
    stopClipRotation();

    ghostClipSwitchTimer = setInterval(function () {
      if (!ghostActive || ghostClips.length <= 1) return;
      // Switch at a random point near end of current loop, masked by artifact
      var nextIdx = (ghostCurrentClipIdx + 1) % ghostClips.length;
      // Sometimes skip to a random clip for less predictability
      if (ghostClips.length > 2 && Math.random() < 0.3) {
        nextIdx = Math.floor(Math.random() * ghostClips.length);
        if (nextIdx === ghostCurrentClipIdx) nextIdx = (nextIdx + 1) % ghostClips.length;
      }
      // Inject a freeze burst to mask the switch
      GhostArtifacts.inFreezeBurst = true;
      GhostArtifacts.freezeFramesRemaining = 5 + Math.floor(Math.random() * 8);
      switchToClip(nextIdx);
    }, 15000 + Math.random() * 15000); // switch every 15-30s
  }

  function stopClipRotation() {
    if (ghostClipSwitchTimer) {
      clearInterval(ghostClipSwitchTimer);
      ghostClipSwitchTimer = null;
    }
  }

  // ─── Feature 5: Auto-mute mic during ghost ───

  function autoMuteMic() {
    if (!ghostAutoMuteEnabled) return;
    // Mute all captured audio tracks (from any getUserMedia call)
    if (capturedAudioTracks.length > 0) {
      ghostSavedMuteState = !capturedAudioTracks[0].enabled; // save current state
      for (var i = 0; i < capturedAudioTracks.length; i++) {
        capturedAudioTracks[i].enabled = false;
      }
      console.log('[AirDraw] Auto-muted ' + capturedAudioTracks.length + ' audio track(s)');
    } else {
      console.log('[AirDraw] No audio tracks captured for muting');
    }
  }

  function autoUnmuteMic() {
    if (!ghostAutoMuteEnabled) return;
    for (var i = 0; i < capturedAudioTracks.length; i++) {
      capturedAudioTracks[i].enabled = !ghostSavedMuteState;
    }
    if (capturedAudioTracks.length > 0) {
      console.log('[AirDraw] Restored mic state on ' + capturedAudioTracks.length + ' track(s)');
    }
  }

  // ─── Feature 7: Timer-based auto-return ───

  function startGhostTimer(durationMs) {
    clearGhostTimer();
    if (durationMs <= 0) return;
    ghostAutoReturnDuration = durationMs;

    ghostAutoReturnTimer = setTimeout(function () {
      if (ghostState === 'active') {
        console.log('[AirDraw] Ghost auto-return timer expired');
        toggleGhostMode(); // deactivate
        // Notify user
        window.postMessage({
          source: 'airdraw-main',
          type: 'GHOST_ALERT',
          payload: { alert: 'timer_expired', message: 'Ghost mode auto-returned after timer expired' }
        }, '*');
      }
    }, durationMs);

    console.log('[AirDraw] Ghost timer set: ' + (durationMs / 1000) + 's');
  }

  function clearGhostTimer() {
    if (ghostAutoReturnTimer) {
      clearTimeout(ghostAutoReturnTimer);
      ghostAutoReturnTimer = null;
    }
    ghostAutoReturnDuration = 0;
  }

  // ─── Feature 4: Name Detection via Web Speech API ───

  function startNameDetection() {
    if (!ghostUserName || ghostUserName.trim() === '') return;
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      console.warn('[AirDraw] Speech recognition not available');
      return;
    }

    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    ghostSpeechRecognition = new SpeechRecognition();
    ghostSpeechRecognition.continuous = true;
    ghostSpeechRecognition.interimResults = true;
    ghostSpeechRecognition.lang = 'en-US';

    var nameVariants = ghostUserName.toLowerCase().split(',').map(function (n) { return n.trim(); });

    ghostSpeechRecognition.onresult = function (event) {
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var transcript = event.results[i][0].transcript.toLowerCase();
        for (var j = 0; j < nameVariants.length; j++) {
          if (transcript.indexOf(nameVariants[j]) !== -1) {
            console.log('[AirDraw] NAME DETECTED in audio: "' + nameVariants[j] + '"');
            window.postMessage({
              source: 'airdraw-main',
              type: 'GHOST_ALERT',
              payload: {
                alert: 'name_detected',
                message: 'Someone said "' + nameVariants[j] + '"!',
                transcript: transcript
              }
            }, '*');
            break;
          }
        }
      }
    };

    ghostSpeechRecognition.onerror = function (e) {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('[AirDraw] Speech recognition error:', e.error);
      }
    };

    ghostSpeechRecognition.onend = function () {
      // Auto-restart if ghost is still active
      if (ghostActive && ghostSpeechRecognition) {
        try { ghostSpeechRecognition.start(); } catch (e) {}
      }
    };

    try {
      ghostSpeechRecognition.start();
      console.log('[AirDraw] Name detection started for:', nameVariants);
    } catch (e) {
      console.warn('[AirDraw] Could not start speech recognition:', e);
    }
  }

  function stopNameDetection() {
    if (ghostSpeechRecognition) {
      try { ghostSpeechRecognition.stop(); } catch (e) {}
      ghostSpeechRecognition = null;
    }
  }

  // ─── Feature 6: Meeting Activity Monitor ───

  var MeetingMonitor = {
    observer: null,
    chatObserver: null,
    active: false,
    lastAlerts: {},       // debounce: { alertType: timestamp }
    ALERT_COOLDOWN: 10000, // 10 seconds between same alert type

    start: function () {
      if (this.active) return;
      this.active = true;
      this.lastAlerts = {};

      // Only monitor chat area for name mentions, not the full DOM
      // The full-DOM approach triggers on thousands of irrelevant mutations
      this._startChatMonitor();

      console.log('[AirDraw] Meeting monitor started (chat-only mode)');
    },

    _startChatMonitor: function () {
      var self = this;

      this.chatObserver = new MutationObserver(function (mutations) {
        if (!ghostActive) return;
        var nameVariants = ghostUserName
          ? ghostUserName.toLowerCase().split(',').map(function (n) { return n.trim(); }).filter(function (n) { return n.length > 0; })
          : [];

        for (var i = 0; i < mutations.length; i++) {
          for (var j = 0; j < mutations[i].addedNodes.length; j++) {
            var node = mutations[i].addedNodes[j];
            if (node.nodeType !== 1) continue;

            // Only check small elements (toasts, notifications, chat bubbles)
            // Skip large container elements to avoid false positives
            var text = (node.textContent || '');
            if (text.length > 500 || text.length < 3) continue;

            var lowerText = text.toLowerCase();

            // Chat name detection
            for (var k = 0; k < nameVariants.length; k++) {
              if (lowerText.indexOf(nameVariants[k]) !== -1) {
                self._alertThrottled('name_in_chat', 'Your name mentioned in chat');
                break;
              }
            }
          }
        }
      });

      this.chatObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    },

    stop: function () {
      if (this.observer) { this.observer.disconnect(); this.observer = null; }
      if (this.chatObserver) { this.chatObserver.disconnect(); this.chatObserver = null; }
      this.active = false;
      this.lastAlerts = {};
      console.log('[AirDraw] Meeting monitor stopped');
    },

    _alertThrottled: function (type, message) {
      var now = Date.now();
      if (this.lastAlerts[type] && (now - this.lastAlerts[type]) < this.ALERT_COOLDOWN) {
        return; // throttled
      }
      this.lastAlerts[type] = now;
      this._alert(type, message);
    },

    _alert: function (type, message) {
      console.log('[AirDraw] Meeting alert: ' + type + ' — ' + message);
      window.postMessage({
        source: 'airdraw-main',
        type: 'GHOST_ALERT',
        payload: { alert: type, message: message }
      }, '*');
    }
  };

  function postGhostStatus() {
    window.postMessage({
      source: 'airdraw-main',
      type: 'GHOST_STATUS',
      payload: {
        ghostState: ghostState,
        clipCount: ghostClips.length,
        autoMute: ghostAutoMuteEnabled,
        autoReturnMs: ghostAutoReturnDuration,
        userName: ghostUserName
      }
    }, '*');
  }

  async function recordGhostLoop() {
    if (!videoElement || !pipelineReady) {
      console.warn('[AirDraw] Cannot record ghost: pipeline not ready');
      return;
    }
    // If ghost is active, deactivate first
    if (ghostActive) {
      toggleGhostMode();
    }
    ghostState = 'recording';
    postGhostStatus();
    console.log('[AirDraw] Ghost multi-clip recording started...');

    try {
      // Record 3 clips of 8 seconds each
      var clips = await GhostMultiRecorder.recordAll(
        videoElement,
        function (clipNum, totalClips, durationSec) {
          console.log('[AirDraw] Recording clip ' + clipNum + '/' + totalClips + ' (' + durationSec + 's)');
          window.postMessage({
            source: 'airdraw-main',
            type: 'GHOST_RECORDING_PROGRESS',
            payload: { clipNum: clipNum, totalClips: totalClips, durationSec: durationSec }
          }, '*');
        },
        function (clipNum, totalClips) {
          console.log('[AirDraw] Clip ' + clipNum + '/' + totalClips + ' done');
        }
      );

      ghostClips = clips;
      ghostCurrentClipIdx = 0;

      // Load the first clip into the player
      if (clips.length > 0) {
        switchToClip(0);
      }

      // Move to preview state
      ghostState = 'previewing';
      console.log('[AirDraw] Ghost clips recorded, entering preview');
      postGhostStatus();

      // PiP preview available via popup button (requires user gesture)

    } catch (e) {
      console.error('[AirDraw] Ghost recording failed:', e);
      ghostState = 'idle';
      postGhostStatus();
    }
  }

  function acceptGhostPreview() {
    if (ghostState !== 'previewing') return;
    ghostState = 'ready';
    stopPiP();
    console.log('[AirDraw] Ghost preview accepted, ready to activate');
    postGhostStatus();
  }

  function rejectGhostPreview() {
    if (ghostState !== 'previewing') return;
    stopPiP();
    GhostMultiRecorder.destroyAll();
    ghostClips = [];
    ghostState = 'idle';
    console.log('[AirDraw] Ghost preview rejected, clips discarded');
    postGhostStatus();
  }

  function toggleGhostMode() {
    if (ghostState === 'ready') {
      // ── ACTIVATE ghost ──
      ghostActive = true;
      ghostState = 'active';

      // Pause AirDraw hand tracking while ghost is active
      if (enabled) stopTracking();

      // PiP preview started via popup button (needs user gesture)

      // Feature 3: Start clip rotation if multiple clips
      if (ghostClips.length > 1) startClipRotation();

      // Feature 5: Auto-mute mic
      autoMuteMic();

      // Feature 4: Start name detection
      startNameDetection();

      // Feature 6: Start meeting monitor
      MeetingMonitor.start();

      // Feature 7: Start auto-return timer if set
      if (ghostAutoReturnDuration > 0) {
        startGhostTimer(ghostAutoReturnDuration);
      }

      console.log('[AirDraw] Ghost mode ACTIVATED (clips: ' + ghostClips.length + ')');

    } else if (ghostState === 'active') {
      // ── DEACTIVATE ghost ──
      ghostActive = false;
      ghostState = 'ready';

      // Stop all ghost sub-features
      stopPiP();
      stopClipRotation();
      autoUnmuteMic();
      stopNameDetection();
      MeetingMonitor.stop();
      clearGhostTimer();

      // Resume AirDraw tracking if it was enabled
      if (enabled && pipelineReady && compositeCanvas) {
        startHandTrackingIfNeeded(compositeCanvas.width, compositeCanvas.height);
      }
      console.log('[AirDraw] Ghost mode DEACTIVATED');

    } else {
      console.log('[AirDraw] Ghost toggle ignored — state is: ' + ghostState);
    }
    postGhostStatus();
  }

  // ─── Enable / Disable ───
  // ─── Toast notifications ───
  function showToast(title, subtitle) {
    var existing = document.getElementById('airdraw-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.id = 'airdraw-toast';
    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:999999;' +
      'padding:12px 24px;background:rgba(0,0,0,0.9);backdrop-filter:blur(8px);' +
      'border:1px solid rgba(255,51,102,0.5);border-radius:12px;' +
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#fff;' +
      'text-align:center;pointer-events:none;' +
      'animation:airdraw-toast-in 0.3s ease;' +
      'box-shadow:0 4px 20px rgba(0,0,0,0.5);';

    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:2px;';
    titleEl.textContent = title;
    toast.appendChild(titleEl);

    if (subtitle) {
      var subEl = document.createElement('div');
      subEl.style.cssText = 'font-size:11px;color:#aaa;';
      subEl.textContent = subtitle;
      toast.appendChild(subEl);
    }

    // Inject animation keyframe if not already present
    if (!document.getElementById('airdraw-toast-style')) {
      var style = document.createElement('style');
      style.id = 'airdraw-toast-style';
      style.textContent = '@keyframes airdraw-toast-in{from{opacity:0;transform:translateX(-50%) translateY(20px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}';
      document.head.appendChild(style);
    }

    document.body.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) {
        toast.style.transition = 'opacity 0.3s';
        toast.style.opacity = '0';
        setTimeout(function () { toast.remove(); }, 300);
      }
    }, 2500);
  }

  function enableAirDraw() {
    enabled = true;
    console.log('[AirDraw] Enabled');
    if (pipelineReady && compositeCanvas) {
      startHandTrackingIfNeeded(compositeCanvas.width, compositeCanvas.height);
    }
    showToast('AirDraw Enabled', 'Point to draw | Peace sign to move | Palm to erase');
    postStatus();
  }

  function disableAirDraw() {
    enabled = false;
    stopTracking();
    if (drawMode === 'SCREEN') {
      drawMode = 'WEBCAM';
      destroyScreenOverlay();
      stopScreenRenderLoop();
    }
    strokes = [];
    currentStroke = null;
    undoStack = [];
    screenStrokes = [];
    screenCurrentStroke = null;
    screenUndoStack = [];
    console.log('[AirDraw] Disabled');
    showToast('AirDraw Disabled', '');
    postStatus();
  }

  function postStatus() {
    window.postMessage({
      source: 'airdraw-main',
      type: 'STATUS',
      payload: { enabled: enabled, tracking: trackingActive }
    }, '*');
  }

  // ─── Message listener ───
  window.addEventListener('message', function (event) {
    if (!event.data || event.data.source !== 'airdraw-isolated') return;

    switch (event.data.type) {
      case 'TOGGLE':
        if (enabled) disableAirDraw();
        else enableAirDraw();
        break;
      case 'STATUS':
        postStatus();
        break;
      case 'SETTINGS':
        if (event.data.payload) {
          var keys = Object.keys(event.data.payload);
          for (var i = 0; i < keys.length; i++) {
            if (keys[i] === 'ghostIntensity') {
              ghostLoopPlayer.setIntensity(event.data.payload[keys[i]]);
            } else {
              settings[keys[i]] = event.data.payload[keys[i]];
            }
          }
        }
        break;
      case 'CLEAR':
        undoStack = undoStack.concat(strokes);
        strokes = [];
        currentStroke = null;
        break;
      case 'UNDO':
        if (strokes.length > 0) undoStack.push(strokes.pop());
        break;
      case 'REDO':
        if (undoStack.length > 0) strokes.push(undoStack.pop());
        break;
      case 'ENABLE_IF_SAVED':
        if (!enabled) enableAirDraw();
        break;
      case 'RECORD_GHOST':
        recordGhostLoop();
        break;
      case 'TOGGLE_GHOST':
        toggleGhostMode();
        break;
      case 'GHOST_INTENSITY':
        if (event.data.payload && typeof event.data.payload.intensity === 'number') {
          ghostLoopPlayer.setIntensity(event.data.payload.intensity);
        }
        break;
      case 'GHOST_STATUS':
        postGhostStatus();
        break;
      case 'GHOST_ACCEPT_PREVIEW':
        acceptGhostPreview();
        break;
      case 'GHOST_REJECT_PREVIEW':
        rejectGhostPreview();
        break;
      case 'GHOST_SET_TIMER':
        if (event.data.payload && typeof event.data.payload.durationMs === 'number') {
          ghostAutoReturnDuration = event.data.payload.durationMs;
          if (ghostActive && ghostAutoReturnDuration > 0) {
            startGhostTimer(ghostAutoReturnDuration);
          }
        }
        break;
      case 'GHOST_SET_NAME':
        if (event.data.payload && typeof event.data.payload.name === 'string') {
          ghostUserName = event.data.payload.name;
          // Restart name detection if ghost is active
          if (ghostActive) {
            stopNameDetection();
            startNameDetection();
          }
        }
        break;
      case 'GHOST_SET_AUTOMUTE':
        if (event.data.payload && typeof event.data.payload.enabled === 'boolean') {
          ghostAutoMuteEnabled = event.data.payload.enabled;
        }
        break;
      case 'GHOST_REQUEST_PIP':
        requestPiP();
        break;
      case 'SCREEN_MODE':
        if (drawMode === 'SCREEN') {
          drawMode = 'WEBCAM';
          destroyScreenOverlay();
          stopScreenRenderLoop();
          console.log('[AirDraw] Switched to WEBCAM mode');
          showToast('Webcam Drawing Mode', 'Drawing on your video feed');
        } else {
          drawMode = 'SCREEN';
          createScreenOverlay();
          startScreenRenderLoop();
          console.log('[AirDraw] Switched to SCREEN mode');
          showToast('Screen Annotation Mode', 'Drawing on shared screen. Pinch to click.');
        }
        window.postMessage({
          source: 'airdraw-main',
          type: 'MODE_STATUS',
          payload: { mode: drawMode }
        }, '*');
        break;
      case 'MEDIAPIPE_BUNDLE':
        if (event.data.payload) {
          mediapipeBlobUrl = event.data.payload.blobUrl;
          mediapipeWasmPath = event.data.payload.wasmPath;
          mediapipeModelPath = event.data.payload.modelPath;
          console.log('[AirDraw] MediaPipe bundle received');
        }
        break;
    }
  });

  // Signal ready
  window.postMessage({
    source: 'airdraw-main',
    type: 'STATUS',
    payload: { enabled: false, tracking: false, ready: true }
  }, '*');

  // Also broadcast initial ghost state
  postGhostStatus();

})();
