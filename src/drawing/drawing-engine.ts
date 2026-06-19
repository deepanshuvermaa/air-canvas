import { Stroke, Point, AirDrawSettings, DEFAULT_SETTINGS } from '../types/messages';
import { renderStrokes, renderCursor } from './renderer';
import { detectShape } from './shape-snapper';
import { uid } from '../utils/uid';

/**
 * DrawingEngine manages the stroke state and render loop.
 * It's the central coordinator: tracking adds points, the engine
 * stores strokes, and the renderer paints them each frame.
 *
 * This class owns:
 * - The list of completed strokes
 * - The current in-progress stroke (if any)
 * - The undo stack
 * - The render loop (requestAnimationFrame)
 * - Fade cleanup (removing fully faded strokes)
 */
export class DrawingEngine {
  private strokes: Stroke[] = [];
  private currentStroke: Stroke | null = null;
  private undoStack: Stroke[] = [];
  private settings: AirDrawSettings = { ...DEFAULT_SETTINGS };
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private animationFrameId: number | null = null;
  private cursorPosition: Point | null = null;
  private isDrawingCursor: boolean = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;
  }

  updateSettings(settings: Partial<AirDrawSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  getSettings(): AirDrawSettings {
    return { ...this.settings };
  }

  /** Begin a new stroke at the given point */
  beginStroke(point: Point): void {
    this.currentStroke = {
      id: uid(),
      points: [point],
      color: this.settings.strokeColor,
      width: this.settings.strokeWidth,
      createdAt: Date.now(),
    };
  }

  /** Add a point to the current stroke */
  addPoint(point: Point): void {
    if (!this.currentStroke) return;
    this.currentStroke.points.push(point);
  }

  /** End the current stroke, optionally snapping to a shape */
  endStroke(): void {
    if (!this.currentStroke) return;

    if (this.settings.shapeSnap && this.currentStroke.points.length >= 5) {
      const shape = detectShape(this.currentStroke, this.settings.shapeSnapThreshold);
      if (shape) {
        this.currentStroke.snappedShape = shape;
      }
    }

    this.strokes.push(this.currentStroke);
    this.undoStack = []; // clear redo on new stroke
    this.currentStroke = null;
  }

  /** Update the cursor position for rendering the finger indicator */
  setCursor(point: Point | null, isDrawing: boolean): void {
    this.cursorPosition = point;
    this.isDrawingCursor = isDrawing;
  }

  /** Undo the last stroke */
  undo(): void {
    const last = this.strokes.pop();
    if (last) {
      this.undoStack.push(last);
    }
  }

  /** Redo the last undone stroke */
  redo(): void {
    const last = this.undoStack.pop();
    if (last) {
      this.strokes.push(last);
    }
  }

  /** Clear all strokes */
  clear(): void {
    this.undoStack.push(...this.strokes);
    this.strokes = [];
    this.currentStroke = null;
  }

  /** Get all strokes (for export) */
  getStrokes(): Stroke[] {
    return [...this.strokes];
  }

  /** Export the canvas as a PNG data URL */
  exportAsImage(): string {
    return this.canvas.toDataURL('image/png');
  }

  /** Start the render loop */
  startRenderLoop(): void {
    if (this.animationFrameId !== null) return;

    const render = () => {
      this.renderFrame();
      this.animationFrameId = requestAnimationFrame(render);
    };
    this.animationFrameId = requestAnimationFrame(render);
  }

  /** Stop the render loop */
  stopRenderLoop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /** Render a single frame */
  private renderFrame(): void {
    const now = Date.now();

    // Clean up fully faded strokes
    if (this.settings.fadeMode) {
      this.strokes = this.strokes.filter(
        s => (now - s.createdAt) < this.settings.fadeDuration
      );
    }

    // Build the full list: completed strokes + current in-progress stroke
    const allStrokes = this.currentStroke
      ? [...this.strokes, this.currentStroke]
      : this.strokes;

    renderStrokes(this.ctx, allStrokes, this.settings, now);

    // Draw cursor
    if (this.cursorPosition) {
      renderCursor(
        this.ctx,
        this.cursorPosition,
        this.isDrawingCursor,
        this.settings.strokeColor,
        this.settings.strokeWidth
      );
    }
  }

  /** Resize canvas to match a video stream's dimensions */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  /** Get the canvas element (for compositing pipeline) */
  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }
}
