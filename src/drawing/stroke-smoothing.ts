import { Point } from '../types/messages';

/**
 * Catmull-Rom spline interpolation for smooth strokes.
 *
 * Raw finger positions are jittery. Instead of drawing straight lines
 * between consecutive points, we fit a Catmull-Rom spline through them.
 * This produces curves that pass through every control point but with
 * smooth transitions — the same math used in animation paths and
 * vector graphics tools.
 *
 * tension: 0 = loose curves, 1 = tight/angular (0.5 is a good default)
 */
export function catmullRomSpline(
  points: Point[],
  tension: number = 0.5,
  segments: number = 8
): Point[] {
  if (points.length < 2) return [...points];
  if (points.length === 2) return [...points];

  const result: Point[] = [points[0]];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(i - 1, 0)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(i + 2, points.length - 1)];

    for (let t = 1; t <= segments; t++) {
      const tNorm = t / segments;
      const tt = tNorm * tNorm;
      const ttt = tt * tNorm;

      const x = 0.5 * (
        (2 * p1.x) +
        (-p0.x + p2.x) * tension * tNorm +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tension * tt +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * tension * ttt
      );

      const y = 0.5 * (
        (2 * p1.y) +
        (-p0.y + p2.y) * tension * tNorm +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tension * tt +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * tension * ttt
      );

      result.push({
        x,
        y,
        timestamp: p1.timestamp + (p2.timestamp - p1.timestamp) * tNorm,
      });
    }
  }

  return result;
}

/**
 * Exponential moving average for real-time position smoothing.
 * Applied to finger tip coordinates before they enter the stroke.
 * alpha: 0 = maximum smoothing (laggy), 1 = no smoothing (raw input)
 */
export function emaSmooth(
  current: Point,
  previous: Point | null,
  alpha: number = 0.4
): Point {
  if (!previous) return current;
  return {
    x: alpha * current.x + (1 - alpha) * previous.x,
    y: alpha * current.y + (1 - alpha) * previous.y,
    timestamp: current.timestamp,
  };
}
