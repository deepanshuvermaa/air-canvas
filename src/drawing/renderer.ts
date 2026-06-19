import { Stroke, Point, SnappedShape, AirDrawSettings } from '../types/messages';
import { catmullRomSpline } from './stroke-smoothing';

/**
 * The renderer is responsible for painting strokes onto a canvas.
 * It handles both freehand strokes (via Catmull-Rom smoothing) and
 * snapped geometric shapes.
 *
 * This is a stateless module — give it a canvas context and strokes,
 * and it draws them. No side effects, no retained state.
 */

export function renderStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: Stroke[],
  settings: AirDrawSettings,
  now: number = Date.now()
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  for (const stroke of strokes) {
    // Fade mode: compute opacity based on age
    let alpha = 1;
    if (settings.fadeMode) {
      const age = now - stroke.createdAt;
      alpha = Math.max(0, 1 - age / settings.fadeDuration);
      if (alpha <= 0) continue; // fully faded, skip
    }

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.snappedShape) {
      renderShape(ctx, stroke.snappedShape);
    } else {
      renderFreehand(ctx, stroke.points, settings.smoothing);
    }
  }

  ctx.globalAlpha = 1;
}

function renderFreehand(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  tension: number
): void {
  if (points.length < 2) return;

  const smoothed = catmullRomSpline(points, tension, 6);

  ctx.beginPath();
  ctx.moveTo(smoothed[0].x, smoothed[0].y);

  for (let i = 1; i < smoothed.length; i++) {
    ctx.lineTo(smoothed[i].x, smoothed[i].y);
  }

  ctx.stroke();
}

function renderShape(ctx: CanvasRenderingContext2D, shape: SnappedShape): void {
  ctx.beginPath();

  switch (shape.type) {
    case 'line':
      ctx.moveTo(shape.start.x, shape.start.y);
      ctx.lineTo(shape.end.x, shape.end.y);
      ctx.stroke();
      break;

    case 'arrow':
      // Draw shaft
      ctx.moveTo(shape.start.x, shape.start.y);
      ctx.lineTo(shape.end.x, shape.end.y);
      ctx.stroke();

      // Draw arrowhead
      const angle = Math.atan2(
        shape.end.y - shape.start.y,
        shape.end.x - shape.start.x
      );
      const headLength = 15;
      ctx.beginPath();
      ctx.moveTo(shape.end.x, shape.end.y);
      ctx.lineTo(
        shape.end.x - headLength * Math.cos(angle - Math.PI / 6),
        shape.end.y - headLength * Math.sin(angle - Math.PI / 6)
      );
      ctx.moveTo(shape.end.x, shape.end.y);
      ctx.lineTo(
        shape.end.x - headLength * Math.cos(angle + Math.PI / 6),
        shape.end.y - headLength * Math.sin(angle + Math.PI / 6)
      );
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

/**
 * Render a cursor indicator at the current finger position.
 * Shows a small dot when hovering, a larger ring when drawing.
 */
export function renderCursor(
  ctx: CanvasRenderingContext2D,
  position: Point,
  isDrawing: boolean,
  color: string,
  strokeWidth: number
): void {
  ctx.beginPath();
  const radius = isDrawing ? strokeWidth * 1.5 : 4;
  ctx.arc(position.x, position.y, radius, 0, 2 * Math.PI);

  if (isDrawing) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  } else {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}
