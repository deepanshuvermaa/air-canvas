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

  var settings = {
    strokeColor: '#FF3366',
    strokeWidth: 5,
    fadeMode: false,
    fadeDuration: 2000,
    smoothing: 0.5,
    shapeSnap: false,
    shapeSnapThreshold: 0.15,
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
      compositeFrameId = requestAnimationFrame(loop);
      if (!compositeCtx || !videoElement || videoElement.readyState < 2) return;

      compositeCtx.drawImage(videoElement, 0, 0, compositeCanvas.width, compositeCanvas.height);

      if (enabled && drawingCanvas) {
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

    // Cursor indicator
    if (cursorPos && enabled) {
      // Outer ring
      drawingCtx.beginPath();
      var radius = isCursorDrawing ? settings.strokeWidth + 4 : 8;
      drawingCtx.arc(cursorPos.x, cursorPos.y, radius, 0, 2 * Math.PI);
      drawingCtx.strokeStyle = isCursorDrawing ? settings.strokeColor : 'rgba(255,255,255,0.8)';
      drawingCtx.lineWidth = 2;
      drawingCtx.stroke();

      // Inner dot
      drawingCtx.beginPath();
      drawingCtx.arc(cursorPos.x, cursorPos.y, 3, 0, 2 * Math.PI);
      drawingCtx.fillStyle = isCursorDrawing ? settings.strokeColor : 'rgba(255,255,255,0.9)';
      drawingCtx.fill();

      // "Drawing" indicator: filled ring when drawing
      if (isCursorDrawing) {
        drawingCtx.beginPath();
        drawingCtx.arc(cursorPos.x, cursorPos.y, radius + 3, 0, 2 * Math.PI);
        drawingCtx.strokeStyle = 'rgba(255,255,255,0.4)';
        drawingCtx.lineWidth = 1;
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

  // ─── Shape detection ───
  function detectShape(stroke) {
    var pts = stroke.points;
    if (pts.length < 8) return null;

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y > maxY) maxY = pts[i].y;
    }
    var bbox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    var center = { x: minX + bbox.width / 2, y: minY + bbox.height / 2 };

    // Circle
    var avgR = 0;
    for (var i = 0; i < pts.length; i++) avgR += dist(pts[i], center);
    avgR /= pts.length;
    if (avgR > 15) {
      var variance = 0;
      for (var i = 0; i < pts.length; i++) {
        var d = dist(pts[i], center);
        var diff = (d - avgR) / avgR;
        variance += diff * diff;
      }
      variance /= pts.length;
      if (variance < settings.shapeSnapThreshold && dist(pts[0], pts[pts.length - 1]) < avgR * 0.5) {
        return { type: 'circle', center: center, radius: avgR };
      }
    }

    // Rectangle
    if (dist(pts[0], pts[pts.length - 1]) < (bbox.width + bbox.height) * 0.15 && bbox.width > 20 && bbox.height > 20) {
      var tol = Math.max(bbox.width, bbox.height) * 0.15;
      var nearEdge = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var minD = Math.min(Math.abs(p.x - bbox.x), Math.abs(p.x - (bbox.x + bbox.width)), Math.abs(p.y - bbox.y), Math.abs(p.y - (bbox.y + bbox.height)));
        if (minD < tol) nearEdge++;
      }
      if (nearEdge / pts.length > (1 - settings.shapeSnapThreshold)) {
        return { type: 'rectangle', topLeft: { x: bbox.x, y: bbox.y }, width: bbox.width, height: bbox.height };
      }
    }

    // Line
    var start = pts[0], end = pts[pts.length - 1];
    var len = dist(start, end);
    if (len > 30) {
      var maxDev = 0;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var dx = end.x - start.x, dy = end.y - start.y;
        var lenSq = dx * dx + dy * dy;
        var t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / lenSq));
        var dev = Math.sqrt(Math.pow(p.x - (start.x + t * dx), 2) + Math.pow(p.y - (start.y + t * dy), 2));
        if (dev > maxDev) maxDev = dev;
      }
      if (maxDev / len < settings.shapeSnapThreshold) {
        return { type: 'line', start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
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

    // *** FIX: No x-mirroring. Landmarks are in raw camera space,
    // composite canvas draws raw camera frame. Coordinates match directly.
    var rawX = landmarks[8].x * width;
    var rawY = landmarks[8].y * height;
    var now = Date.now();

    // EMA smoothing — lower alpha = smoother but laggier
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

    // All 4 open = ERASING
    if (openCount >= 4) return transitionGesture('ERASING', fingerTip);
    // Index open (+ maybe one other) = DRAWING
    if (indexOpen && openCount <= 2) return transitionGesture('DRAWING', fingerTip);
    // Fist = IDLE
    if (openCount === 0) return transitionGesture('IDLE', fingerTip);
    // 3 fingers or other = HOVERING
    return transitionGesture('HOVERING', fingerTip);
  }

  function transitionGesture(candidate, fingerTip) {
    if (candidate === gestureState) {
      gestureFrameCount = 0;
    } else {
      gestureFrameCount++;
      // Higher debounce = more stable, less flickering
      // DRAWING->IDLE needs more frames (grace period to prevent
      // accidental stroke breaks when finger wobbles)
      var threshold = 2;
      if (gestureState === 'DRAWING' && (candidate === 'IDLE' || candidate === 'HOVERING')) {
        threshold = 8; // ~270ms grace before stopping a stroke
      }
      if (gestureState === 'DRAWING' && candidate === 'ERASING') {
        threshold = 6; // need clear intent to erase
      }
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

    if (state === 'DRAWING' && fingerTip) {
      if (previousGestureState !== 'DRAWING') {
        // Begin new stroke
        currentStroke = {
          id: uid(),
          points: [fingerTip],
          color: settings.strokeColor,
          width: settings.strokeWidth,
          createdAt: Date.now(),
          snappedShape: null
        };
      } else if (currentStroke) {
        // Add point — skip if too close to last point (reduces noise)
        var lastPt = currentStroke.points[currentStroke.points.length - 1];
        var d = dist(fingerTip, lastPt);
        if (d > 2) { // minimum 2px movement to add a point
          currentStroke.points.push(fingerTip);
        }
      }
    } else if (previousGestureState === 'DRAWING' && currentStroke) {
      // End stroke
      if (settings.shapeSnap && currentStroke.points.length >= 8) {
        var shape = detectShape(currentStroke);
        if (shape) currentStroke.snappedShape = shape;
      }
      // Only save if stroke has meaningful length
      if (currentStroke.points.length >= 3) {
        strokes.push(currentStroke);
        undoStack = [];
      }
      currentStroke = null;
    }

    if (state === 'ERASING' && previousGestureState !== 'ERASING') {
      undoStack = undoStack.concat(strokes);
      strokes = [];
      currentStroke = null;
    }

    previousGestureState = state;
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
            settings[keys[i]] = event.data.payload[keys[i]];
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

})();
