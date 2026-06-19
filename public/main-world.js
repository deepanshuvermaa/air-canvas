/**
 * MAIN WORLD SCRIPT — injected synchronously via <script> tag.
 *
 * This is NOT processed by CRXJS/Vite. It's a raw JS file that runs
 * in the page's actual JS context. It MUST be synchronous and immediate
 * because we need to patch getUserMedia BEFORE Google Meet/Zoom/Teams
 * call it.
 *
 * Why not a CRXJS content script?
 * CRXJS wraps content scripts in an async dynamic import() loader.
 * Even with run_at: "document_start", the actual code runs after the
 * page's JS has already executed — too late to intercept getUserMedia.
 */

(function () {
  'use strict';

  // ─── State ───
  let enabled = false;
  let realStream = null;
  let fakeStream = null;
  let compositeCanvas = null;
  let compositeCtx = null;
  let drawingCanvas = null;
  let drawingCtx = null;
  let videoElement = null;
  let renderLoopId = null;
  let handTracker = null;
  let strokes = [];
  let currentStroke = null;
  let undoStack = [];
  let previousGestureState = 'IDLE';
  let cursorPos = null;
  let isCursorDrawing = false;
  let lastSmoothedPoint = null;
  let gestureState = 'IDLE';
  let gestureFrameCount = 0;

  // ─── Settings ───
  let settings = {
    strokeColor: '#FF3366',
    strokeWidth: 4,
    fadeMode: false,
    fadeDuration: 2000,
    smoothing: 0.5,
    shapeSnap: false,
    shapeSnapThreshold: 0.15,
    gestureDebounceFrames: 3,
    smoothingAlpha: 0.4,
  };

  // ─── Patch getUserMedia IMMEDIATELY ───
  const originalGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await originalGUM(constraints);

    // Always save the real stream reference for later
    if (constraints && constraints.video) {
      realStream = stream;
      console.log('[AirDraw] Intercepted getUserMedia (video)');

      // If already enabled, build composite immediately
      if (enabled) {
        try {
          return await buildCompositeStream(stream);
        } catch (e) {
          console.error('[AirDraw] Failed to build composite, returning real stream:', e);
          return stream;
        }
      }
    }

    return stream;
  };

  console.log('[AirDraw] getUserMedia patched (synchronous)');

  // ─── UID helper ───
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ─── Build composite stream ───
  async function buildCompositeStream(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    const trackSettings = videoTrack.getSettings();
    const width = trackSettings.width || 640;
    const height = trackSettings.height || 480;

    // Hidden video element
    videoElement = document.createElement('video');
    videoElement.srcObject = stream;
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.muted = true;
    videoElement.style.display = 'none';
    document.body.appendChild(videoElement);
    await videoElement.play();

    // Composite canvas (camera + ink)
    compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = height;
    compositeCtx = compositeCanvas.getContext('2d');

    // Drawing overlay canvas
    drawingCanvas = document.createElement('canvas');
    drawingCanvas.width = width;
    drawingCanvas.height = height;
    drawingCtx = drawingCanvas.getContext('2d');

    // Start compositing loop
    startCompositing();

    // Initialize hand tracking
    await initHandTracking(width, height);

    // Capture composite canvas as stream at 30fps
    fakeStream = compositeCanvas.captureStream(30);

    // Copy audio tracks
    for (const audioTrack of stream.getAudioTracks()) {
      fakeStream.addTrack(audioTrack);
    }

    console.log('[AirDraw] Composite stream ready (' + width + 'x' + height + ')');
    return fakeStream;
  }

  // ─── Compositing loop ───
  function startCompositing() {
    if (renderLoopId !== null) return;

    function composite() {
      renderLoopId = requestAnimationFrame(composite);

      if (!compositeCtx || !videoElement || !drawingCanvas) return;

      // Layer 1: camera frame
      compositeCtx.drawImage(videoElement, 0, 0, compositeCanvas.width, compositeCanvas.height);

      // Render strokes on drawing canvas
      renderFrame();

      // Layer 2: ink overlay
      compositeCtx.drawImage(drawingCanvas, 0, 0);
    }

    renderLoopId = requestAnimationFrame(composite);
  }

  function stopCompositing() {
    if (renderLoopId !== null) {
      cancelAnimationFrame(renderLoopId);
      renderLoopId = null;
    }
  }

  // ─── Rendering ───
  function renderFrame() {
    if (!drawingCtx) return;
    const now = Date.now();

    drawingCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);

    // Filter faded strokes
    if (settings.fadeMode) {
      strokes = strokes.filter(function (s) { return (now - s.createdAt) < settings.fadeDuration; });
    }

    // All strokes including current
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
        drawingCtx.beginPath();
        drawingCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (var j = 1; j < stroke.points.length; j++) {
          drawingCtx.lineTo(stroke.points[j].x, stroke.points[j].y);
        }
        drawingCtx.stroke();
      }
    }

    drawingCtx.globalAlpha = 1;

    // Draw cursor
    if (cursorPos) {
      drawingCtx.beginPath();
      var radius = isCursorDrawing ? settings.strokeWidth * 1.5 : 4;
      drawingCtx.arc(cursorPos.x, cursorPos.y, radius, 0, 2 * Math.PI);
      if (isCursorDrawing) {
        drawingCtx.strokeStyle = settings.strokeColor;
        drawingCtx.lineWidth = 2;
        drawingCtx.stroke();
      } else {
        drawingCtx.fillStyle = settings.strokeColor;
        drawingCtx.globalAlpha = 0.6;
        drawingCtx.fill();
        drawingCtx.globalAlpha = 1;
      }
    }
  }

  function renderShape(ctx, shape) {
    ctx.beginPath();
    switch (shape.type) {
      case 'line':
        ctx.moveTo(shape.start.x, shape.start.y);
        ctx.lineTo(shape.end.x, shape.end.y);
        ctx.stroke();
        break;
      case 'arrow':
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
        break;
      case 'circle':
        ctx.arc(shape.center.x, shape.center.y, shape.radius, 0, 2 * Math.PI);
        ctx.stroke();
        break;
      case 'rectangle':
        ctx.rect(shape.topLeft.x, shape.topLeft.y, shape.width, shape.height);
        ctx.stroke();
        break;
    }
  }

  // ─── Shape detection ───
  function detectShape(stroke) {
    var pts = stroke.points;
    if (pts.length < 5) return null;

    var bbox = getBoundingBox(pts);
    var center = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };

    var circle = detectCircle(pts, center, bbox);
    if (circle) return circle;

    var rect = detectRectangle(pts, bbox);
    if (rect) return rect;

    var line = detectLine(pts);
    if (line) return line;

    return null;
  }

  function getBoundingBox(pts) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y > maxY) maxY = pts[i].y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
  }

  function detectCircle(pts, center, bbox) {
    var avgR = 0;
    for (var i = 0; i < pts.length; i++) {
      avgR += dist(pts[i], center);
    }
    avgR /= pts.length;
    if (avgR < 10) return null;

    var variance = 0;
    for (var i = 0; i < pts.length; i++) {
      var d = dist(pts[i], center);
      var diff = (d - avgR) / avgR;
      variance += diff * diff;
    }
    variance /= pts.length;

    var closed = dist(pts[0], pts[pts.length - 1]) < avgR * 0.5;
    if (variance < settings.shapeSnapThreshold && closed) {
      return { type: 'circle', center: { x: center.x, y: center.y }, radius: avgR };
    }
    return null;
  }

  function detectRectangle(pts, bbox) {
    var closed = dist(pts[0], pts[pts.length - 1]) < (bbox.width + bbox.height) * 0.15;
    if (!closed) return null;

    var tol = Math.max(bbox.width, bbox.height) * 0.15;
    var nearEdge = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var minD = Math.min(
        Math.abs(p.x - bbox.x), Math.abs(p.x - (bbox.x + bbox.width)),
        Math.abs(p.y - bbox.y), Math.abs(p.y - (bbox.y + bbox.height))
      );
      if (minD < tol) nearEdge++;
    }

    if (nearEdge / pts.length > (1 - settings.shapeSnapThreshold) && bbox.width > 15 && bbox.height > 15) {
      return { type: 'rectangle', topLeft: { x: bbox.x, y: bbox.y }, width: bbox.width, height: bbox.height };
    }
    return null;
  }

  function detectLine(pts) {
    var start = pts[0], end = pts[pts.length - 1];
    var len = dist(start, end);
    if (len < 20) return null;

    var maxDev = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var dx = end.x - start.x, dy = end.y - start.y;
      var lenSq = dx * dx + dy * dy;
      var t = Math.max(0, Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / lenSq));
      var projX = start.x + t * dx, projY = start.y + t * dy;
      var dev = Math.sqrt((p.x - projX) * (p.x - projX) + (p.y - projY) * (p.y - projY));
      if (dev > maxDev) maxDev = dev;
    }

    if (maxDev / len < settings.shapeSnapThreshold) {
      return { type: 'line', start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
    }
    return null;
  }

  // ─── Hand tracking ───
  async function initHandTracking(width, height) {
    try {
      var vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest');
      var FilesetResolver = vision.FilesetResolver;
      var HandLandmarker = vision.HandLandmarker;

      var wasmFileset = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
      );

      handTracker = await HandLandmarker.createFromOptions(wasmFileset, {
        baseOptions: {
          modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numHands: 1,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      console.log('[AirDraw] Hand tracker initialized');
      startHandTracking(width, height);
    } catch (e) {
      console.error('[AirDraw] Hand tracking init failed:', e);
    }
  }

  var trackingFrameId = null;

  function startHandTracking(width, height) {
    if (trackingFrameId !== null) return;

    function processFrame() {
      trackingFrameId = requestAnimationFrame(processFrame);

      if (!handTracker || !videoElement || videoElement.readyState < 2) return;

      try {
        var result = handTracker.detectForVideo(videoElement, performance.now());
        var landmarks = null;
        if (result.landmarks && result.landmarks.length > 0) {
          landmarks = result.landmarks[0];
        }

        var gesture = detectGesture(landmarks, width, height);
        handleGesture(gesture);
      } catch (e) {
        // skip frame
      }
    }

    trackingFrameId = requestAnimationFrame(processFrame);
  }

  function stopHandTracking() {
    if (trackingFrameId !== null) {
      cancelAnimationFrame(trackingFrameId);
      trackingFrameId = null;
    }
  }

  // ─── Gesture detection ───
  function isFingerExtended(landmarks, finger) {
    var indices = {
      index: { tip: 8, pip: 6, mcp: 5 },
      middle: { tip: 12, pip: 10, mcp: 9 },
      ring: { tip: 16, pip: 14, mcp: 13 },
      pinky: { tip: 20, pip: 18, mcp: 17 },
    };
    var idx = indices[finger];
    var tipToPip = Math.sqrt(
      Math.pow(landmarks[idx.tip].x - landmarks[idx.pip].x, 2) +
      Math.pow(landmarks[idx.tip].y - landmarks[idx.pip].y, 2)
    );
    var mcpToPip = Math.sqrt(
      Math.pow(landmarks[idx.mcp].x - landmarks[idx.pip].x, 2) +
      Math.pow(landmarks[idx.mcp].y - landmarks[idx.pip].y, 2)
    );
    return tipToPip > mcpToPip * 0.8;
  }

  function detectGesture(landmarks, width, height) {
    if (!landmarks || landmarks.length < 21) {
      return transitionGesture('IDLE', null);
    }

    var indexExt = isFingerExtended(landmarks, 'index');
    var middleExt = isFingerExtended(landmarks, 'middle');
    var ringExt = isFingerExtended(landmarks, 'ring');
    var pinkyExt = isFingerExtended(landmarks, 'pinky');

    // Convert landmark to canvas coords (mirrored)
    var raw = {
      x: (1 - landmarks[8].x) * width,
      y: landmarks[8].y * height,
      timestamp: Date.now()
    };

    // EMA smoothing
    var fingerTip;
    if (lastSmoothedPoint) {
      fingerTip = {
        x: settings.smoothingAlpha * raw.x + (1 - settings.smoothingAlpha) * lastSmoothedPoint.x,
        y: settings.smoothingAlpha * raw.y + (1 - settings.smoothingAlpha) * lastSmoothedPoint.y,
        timestamp: raw.timestamp
      };
    } else {
      fingerTip = raw;
    }
    lastSmoothedPoint = fingerTip;

    // Open palm = erase
    if (indexExt && middleExt && ringExt && pinkyExt) {
      return transitionGesture('ERASING', fingerTip);
    }
    // Index only = draw
    if (indexExt && !middleExt && !ringExt && !pinkyExt) {
      return transitionGesture('DRAWING', fingerTip);
    }
    // Peace sign = hover
    if (indexExt && middleExt && !ringExt && !pinkyExt) {
      return transitionGesture('HOVERING', fingerTip);
    }

    return transitionGesture('HOVERING', fingerTip);
  }

  function transitionGesture(candidateState, fingerTip) {
    if (candidateState === gestureState) {
      gestureFrameCount = 0;
    } else {
      gestureFrameCount++;
      if (gestureFrameCount >= settings.gestureDebounceFrames) {
        gestureState = candidateState;
        gestureFrameCount = 0;
        if (candidateState === 'IDLE') {
          lastSmoothedPoint = null;
        }
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
      } else {
        // Continue stroke
        if (currentStroke) {
          currentStroke.points.push(fingerTip);
        }
      }
    } else if (previousGestureState === 'DRAWING') {
      // End stroke
      if (currentStroke) {
        if (settings.shapeSnap && currentStroke.points.length >= 5) {
          var shape = detectShape(currentStroke);
          if (shape) currentStroke.snappedShape = shape;
        }
        strokes.push(currentStroke);
        undoStack = [];
        currentStroke = null;
      }
    }

    if (state === 'ERASING' && previousGestureState !== 'ERASING') {
      undoStack = undoStack.concat(strokes);
      strokes = [];
      currentStroke = null;
    }

    previousGestureState = state;
  }

  // ─── Enable / Disable ───
  async function enableAirDraw() {
    enabled = true;
    console.log('[AirDraw] Enabling...');

    if (realStream && !fakeStream) {
      // Late activation: already have a camera stream, need to rebuild
      try {
        fakeStream = await buildCompositeStream(realStream);

        // Try to replace the video track in the real stream
        var realVideoTrack = realStream.getVideoTracks()[0];
        var fakeVideoTrack = fakeStream.getVideoTracks()[0];

        // Attempt track replacement (works on some browsers/apps)
        try {
          realStream.removeTrack(realVideoTrack);
          realStream.addTrack(fakeVideoTrack);
          console.log('[AirDraw] Late activation: track swapped');
        } catch (e) {
          console.warn('[AirDraw] Track swap failed. Please refresh the page to activate on video.');
        }
      } catch (e) {
        console.error('[AirDraw] Late activation failed:', e);
      }
    }

    postStatus();
  }

  function disableAirDraw() {
    enabled = false;
    stopCompositing();
    stopHandTracking();

    if (videoElement) {
      videoElement.remove();
      videoElement = null;
    }

    fakeStream = null;
    compositeCanvas = null;
    compositeCtx = null;
    drawingCanvas = null;
    drawingCtx = null;
    strokes = [];
    currentStroke = null;
    undoStack = [];
    cursorPos = null;
    lastSmoothedPoint = null;
    gestureState = 'IDLE';
    previousGestureState = 'IDLE';

    if (handTracker) {
      handTracker.close();
      handTracker = null;
    }

    console.log('[AirDraw] Disabled');
    postStatus();
  }

  function postStatus() {
    window.postMessage({
      source: 'airdraw-main',
      type: 'STATUS',
      payload: { enabled: enabled, tracking: handTracker !== null }
    }, '*');
  }

  // ─── Listen for commands from ISOLATED world ───
  window.addEventListener('message', function (event) {
    if (!event.data || event.data.source !== 'airdraw-isolated') return;

    var msg = event.data;

    switch (msg.type) {
      case 'TOGGLE':
        if (enabled) {
          disableAirDraw();
        } else {
          enableAirDraw();
        }
        break;

      case 'STATUS':
        postStatus();
        break;

      case 'SETTINGS':
        if (msg.payload) {
          Object.assign(settings, msg.payload);
        }
        break;

      case 'CLEAR':
        undoStack = undoStack.concat(strokes);
        strokes = [];
        currentStroke = null;
        break;

      case 'UNDO':
        if (strokes.length > 0) {
          undoStack.push(strokes.pop());
        }
        break;

      case 'ENABLE_IF_SAVED':
        // Auto-enable on page load if previously enabled
        if (!enabled) {
          enableAirDraw();
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
