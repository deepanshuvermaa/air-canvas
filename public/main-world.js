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
  var drawingIdleTimer = null; // grace period before ending stroke
  var mediapipeBlobUrl = null;
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
  var CLICK_COOLDOWN = 500; // ms between clicks

  // ─── Ghost Mode state ───
  var ghostState = 'idle'; // idle | recording | ready | active
  var ghostActive = false;
  var ghostLoopPlayer = null; // will be initialized on first use

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

      drawingCtx.globalAlpha = alpha;
      drawingCtx.strokeStyle = stroke.color;
      drawingCtx.lineWidth = stroke.width;
      drawingCtx.lineCap = 'round';
      drawingCtx.lineJoin = 'round';

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

  // ─── Shape detection (improved tolerances) ───
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
    var isClosed = startEnd < Math.max(bbox.width, bbox.height) * 0.4;

    // ── Circle: closed stroke with consistent radius ──
    var avgR = 0;
    for (var i = 0; i < pts.length; i++) avgR += dist(pts[i], center);
    avgR /= pts.length;
    if (avgR > 10 && isClosed) {
      var variance = 0;
      for (var i = 0; i < pts.length; i++) {
        var d = dist(pts[i], center);
        var diff = (d - avgR) / avgR;
        variance += diff * diff;
      }
      variance /= pts.length;
      if (variance < thresh * 1.5) {
        return { type: 'circle', center: center, radius: avgR };
      }
    }

    // ── Rectangle: closed stroke hugging bounding box edges ──
    if (isClosed && bbox.width > 15 && bbox.height > 15) {
      var tol = Math.max(bbox.width, bbox.height) * 0.2;
      var nearEdge = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var minD = Math.min(
          Math.abs(p.x - bbox.x), Math.abs(p.x - (bbox.x + bbox.width)),
          Math.abs(p.y - bbox.y), Math.abs(p.y - (bbox.y + bbox.height))
        );
        if (minD < tol) nearEdge++;
      }
      if (nearEdge / pts.length > 0.7) {
        return { type: 'rectangle', topLeft: { x: bbox.x, y: bbox.y }, width: bbox.width, height: bbox.height };
      }
    }

    // ── Line / Arrow: open stroke, points near start-to-end line ──
    var start = pts[0], end = pts[pts.length - 1];
    var len = dist(start, end);
    if (len > 20 && !isClosed) {
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
        // Check for arrow: direction change in last 20% of points
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

    var rawX = landmarks[8].x * targetW;
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
    if (openCount >= 4) return transitionGesture('ERASING', fingerTip);
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
      if (gestureState === 'DRAWING' && candidate === 'ERASING') threshold = 8;
      if (gestureState === 'HOVERING' && candidate === 'DRAWING') threshold = 3;
      if (candidate === 'CLICKING') threshold = 2; // fast pinch response
      if (gestureState === 'CLICKING') threshold = 3; // need to hold pinch release

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
    }

    // Pinch-to-click (screen mode only)
    if (state === 'CLICKING' && fingerTip && previousGestureState !== 'CLICKING') {
      dispatchClick(fingerTip.x, fingerTip.y);
    }

    // Selective eraser
    if (state === 'ERASING' && fingerTip && previousGestureState !== 'ERASING') {
      var targetStrokes = (drawMode === 'SCREEN') ? screenStrokes : strokes;
      var targetUndo = (drawMode === 'SCREEN') ? screenUndoStack : undoStack;
      var eraserRadius = 40;
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

      // Active freeze burst
      if (this.inFreezeBurst) {
        this.freezeFramesRemaining--;
        d.freeze = true;
        if (Math.random() < 0.15 * scale) d.qualityDrop = true;
        if (this.freezeFramesRemaining <= 0) {
          this.inFreezeBurst = false;
          d.freeze = false;
          d.catchUpJump = 0.05 + Math.random() * 0.1;
        }
        return d;
      }

      // Start new freeze burst
      if (quality < 0.35 * scale && Math.random() < 0.12 * scale) {
        this.inFreezeBurst = true;
        this.freezeFramesRemaining = 3 + Math.floor(Math.random() * 10 * scale);
        d.freeze = true;
        return d;
      }

      // Micro-stutter
      if (quality < 0.5 && Math.random() < 0.05 * scale) {
        d.freeze = true;
        return d;
      }

      // Loop seam artifact
      var loopSec = this.loopDurationMs / 1000;
      var distFromSeam = Math.min(videoCurrentTime, Math.abs(loopSec - videoCurrentTime));
      if (distFromSeam < 0.3) {
        if (Math.random() < 0.4 * scale) {
          this.inFreezeBurst = true;
          this.freezeFramesRemaining = 3 + Math.floor(Math.random() * 5);
          d.freeze = true;
          return d;
        }
        d.alpha = 0.92 + Math.random() * 0.08;
      }

      // Framerate dip
      if (this.inFramerateDip) {
        if (now > this.framerateDipUntil) {
          this.inFramerateDip = false;
          this.lastFramerateDipEnd = now;
          this.nextFramerateDipInterval = 10000 + Math.random() * 10000;
        } else if (Math.random() < 0.5) {
          d.freeze = true;
        }
      } else if (scale > 0 && now - this.lastFramerateDipEnd > this.nextFramerateDipInterval / scale) {
        this.inFramerateDip = true;
        this.framerateDipUntil = now + 500 + Math.random() * 1000;
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
        var hw = Math.floor(w / 2), hh = Math.floor(h / 2);
        this.offCanvas.width = hw;
        this.offCanvas.height = hh;
        this.offCtx.drawImage(this.loopVideo, 0, 0, hw, hh);
        var prev = ctx.globalAlpha;
        ctx.globalAlpha = d.alpha;
        ctx.drawImage(this.offCanvas, 0, 0, w, h);
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

  function postGhostStatus() {
    window.postMessage({
      source: 'airdraw-main',
      type: 'GHOST_STATUS',
      payload: { ghostState: ghostState }
    }, '*');
  }

  async function recordGhostLoop() {
    if (!videoElement || !pipelineReady) {
      console.warn('[AirDraw] Cannot record ghost: pipeline not ready');
      return;
    }
    // If ghost is active, deactivate first
    if (ghostActive) {
      ghostActive = false;
    }
    ghostState = 'recording';
    postGhostStatus();
    console.log('[AirDraw] Ghost recording started...');

    try {
      await ghostLoopPlayer.prepare(videoElement, function (sec) {
        console.log('[AirDraw] Ghost recording: ' + sec + 's remaining');
      });
      ghostState = 'ready';
      console.log('[AirDraw] Ghost loop ready');
    } catch (e) {
      console.error('[AirDraw] Ghost recording failed:', e);
      ghostState = 'idle';
    }
    postGhostStatus();
  }

  function toggleGhostMode() {
    if (ghostState === 'ready') {
      ghostActive = true;
      ghostState = 'active';
      // Pause AirDraw hand tracking while ghost is active
      if (enabled) stopTracking();
      console.log('[AirDraw] Ghost mode ACTIVATED');
    } else if (ghostState === 'active') {
      ghostActive = false;
      ghostState = 'ready';
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
  function enableAirDraw() {
    enabled = true;
    console.log('[AirDraw] Enabled');
    if (pipelineReady && compositeCanvas) {
      startHandTrackingIfNeeded(compositeCanvas.width, compositeCanvas.height);
    }
    postStatus();
  }

  function disableAirDraw() {
    enabled = false;
    stopTracking();
    strokes = [];
    currentStroke = null;
    undoStack = [];
    console.log('[AirDraw] Disabled');
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
      case 'SCREEN_MODE':
        if (drawMode === 'SCREEN') {
          drawMode = 'WEBCAM';
          destroyScreenOverlay();
          stopScreenRenderLoop();
          console.log('[AirDraw] Switched to WEBCAM mode');
        } else {
          drawMode = 'SCREEN';
          createScreenOverlay();
          startScreenRenderLoop();
          console.log('[AirDraw] Switched to SCREEN mode');
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
