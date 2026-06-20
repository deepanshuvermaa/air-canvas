// ─── Discriminated union for all extension messages ───
// This pattern ensures type-safe message passing between
// content scripts, service worker, and popup.

export type AirDrawMessage =
  | ToggleMessage
  | StatusRequestMessage
  | StatusResponseMessage
  | ClearCanvasMessage
  | UndoStrokeMessage
  | SettingsUpdateMessage
  | SettingsRequestMessage
  | SettingsResponseMessage
  | RecordGhostMessage
  | ToggleGhostMessage
  | GhostStatusMessage;

export interface ToggleMessage {
  type: 'TOGGLE_AIRDRAW';
}

export interface StatusRequestMessage {
  type: 'STATUS_REQUEST';
}

export interface StatusResponseMessage {
  type: 'STATUS_RESPONSE';
  enabled: boolean;
  tracking: boolean;
}

export interface ClearCanvasMessage {
  type: 'CLEAR_CANVAS';
}

export interface UndoStrokeMessage {
  type: 'UNDO_STROKE';
}

export interface SettingsUpdateMessage {
  type: 'SETTINGS_UPDATE';
  settings: Partial<AirDrawSettings>;
}

export interface SettingsRequestMessage {
  type: 'SETTINGS_REQUEST';
}

export interface SettingsResponseMessage {
  type: 'SETTINGS_RESPONSE';
  settings: AirDrawSettings;
}

export interface RecordGhostMessage {
  type: 'RECORD_GHOST';
}

export interface ToggleGhostMessage {
  type: 'TOGGLE_GHOST';
}

export interface GhostStatusMessage {
  type: 'GHOST_STATUS';
  ghostState: GhostState;
}

// ─── Ghost Mode state machine ───

export enum GhostState {
  IDLE = 'IDLE',             // no clips recorded
  RECORDING = 'RECORDING',   // currently capturing clips
  PREVIEWING = 'PREVIEWING', // clips recorded, user reviewing before accepting
  READY = 'READY',           // clips accepted, waiting for activation
  ACTIVE = 'ACTIVE',         // ghost mode on, showing loop with clip rotation
}

// ─── Settings schema ───

export interface AirDrawSettings {
  strokeColor: string;
  strokeWidth: number;
  fadeMode: boolean;       // laser-pointer fade
  fadeDuration: number;    // ms before ink disappears
  smoothing: number;       // 0-1, Catmull-Rom tension
  shapeSnap: boolean;      // auto-straighten shapes
  shapeSnapThreshold: number;
  gestureDebounceFrames: number;
}

export const DEFAULT_SETTINGS: AirDrawSettings = {
  strokeColor: '#FF3366',
  strokeWidth: 4,
  fadeMode: false,
  fadeDuration: 2000,
  smoothing: 0.5,
  shapeSnap: false,
  shapeSnapThreshold: 0.15,
  gestureDebounceFrames: 3,
};

// ─── Drawing types ───

export interface Point {
  x: number;
  y: number;
  timestamp: number;
}

export interface Stroke {
  id: string;
  points: Point[];
  color: string;
  width: number;
  createdAt: number;
  snappedShape?: SnappedShape;
}

export type SnappedShape =
  | { type: 'line'; start: Point; end: Point }
  | { type: 'circle'; center: Point; radius: number }
  | { type: 'rectangle'; topLeft: Point; width: number; height: number }
  | { type: 'arrow'; start: Point; end: Point };

// ─── Gesture states ───

export enum GestureState {
  IDLE = 'IDLE',           // no hand detected or not pointing
  DRAWING = 'DRAWING',     // index finger extended, pen is down
  HOVERING = 'HOVERING',   // hand detected but not drawing gesture
  ERASING = 'ERASING',     // open palm = erase mode (v2)
}

// ─── Custom events for MAIN ↔ ISOLATED world communication ───
// (chrome.runtime messaging doesn't work across worlds in MV3,
// so we use window.postMessage / CustomEvent)

export interface WorldBridgeEvent {
  source: 'airdraw-isolated' | 'airdraw-main';
  type: 'TOGGLE' | 'STATUS' | 'SETTINGS' | 'CLEAR' | 'UNDO'
    | 'RECORD_GHOST' | 'TOGGLE_GHOST' | 'GHOST_STATUS'
    | 'GHOST_ACCEPT_PREVIEW' | 'GHOST_REJECT_PREVIEW'
    | 'GHOST_SET_TIMER' | 'GHOST_SET_NAME' | 'GHOST_SET_AUTOMUTE'
    | 'GHOST_ALERT' | 'GHOST_RECORDING_PROGRESS'
    | 'SCREEN_MODE' | 'MODE_STATUS';
  payload?: unknown;
}
