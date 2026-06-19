import { FilesetResolver, HandLandmarker } from './mediapipe/vision_bundle.mjs';

let handTracker = null;
let videoElement = null;
let trackingLoop = null;

async function initTracker() {
  console.log('[AirDraw Tracker] Initializing MediaPipe...');

  const wasmFileset = await FilesetResolver.forVisionTasks(
    chrome.runtime.getURL('mediapipe/wasm')
  );

  handTracker = await HandLandmarker.createFromOptions(wasmFileset, {
    baseOptions: {
      modelAssetPath: chrome.runtime.getURL('mediapipe/hand_landmarker.task'),
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  console.log('[AirDraw Tracker] HandLandmarker ready');
}

async function startTracking(width, height) {
  if (!handTracker) await initTracker();

  if (!videoElement) {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height } }
    });
    videoElement = document.createElement('video');
    videoElement.srcObject = stream;
    videoElement.autoplay = true;
    videoElement.playsInline = true;
    videoElement.muted = true;
    document.body.appendChild(videoElement);
    await videoElement.play();
    console.log('[AirDraw Tracker] Camera stream acquired');
  }

  if (trackingLoop) return;

  function process() {
    trackingLoop = requestAnimationFrame(process);

    if (!handTracker || !videoElement || videoElement.readyState < 2) return;

    try {
      const result = handTracker.detectForVideo(videoElement, performance.now());
      let landmarks = null;
      if (result.landmarks && result.landmarks.length > 0) {
        landmarks = result.landmarks[0].map(function(l) { return { x: l.x, y: l.y, z: l.z }; });
      }

      chrome.runtime.sendMessage({
        type: 'LANDMARKS',
        landmarks: landmarks
      });
    } catch (e) {
      // skip frame
    }
  }

  trackingLoop = requestAnimationFrame(process);
  console.log('[AirDraw Tracker] Tracking loop started');
}

function stopTracking() {
  if (trackingLoop) {
    cancelAnimationFrame(trackingLoop);
    trackingLoop = null;
  }
  if (videoElement) {
    const stream = videoElement.srcObject;
    if (stream) stream.getTracks().forEach(function(t) { t.stop(); });
    videoElement.remove();
    videoElement = null;
  }
  console.log('[AirDraw Tracker] Tracking stopped');
}

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.type === 'START_TRACKING') {
    startTracking(message.width || 640, message.height || 480);
    sendResponse({ ok: true });
  } else if (message.type === 'STOP_TRACKING') {
    stopTracking();
    sendResponse({ ok: true });
  }
  return true;
});

console.log('[AirDraw Tracker] Offscreen document ready');
