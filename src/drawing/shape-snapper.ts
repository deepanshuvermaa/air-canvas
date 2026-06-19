import { Point, Stroke, SnappedShape } from '../types/messages';

/**
 * Shape snapping: detects if a freehand stroke is "close enough" to a
 * geometric primitive (line, circle, rectangle, arrow) and returns the
 * cleaned-up shape. This is the "wow factor" feature — draw a wobbly
 * circle and it snaps into a perfect one.
 *
 * The algorithm:
 * 1. Compute bounding box and stroke statistics
 * 2. Try each shape detector in order (most specific first)
 * 3. If the fit error is below threshold, return the snapped shape
 * 4. Otherwise return null (keep the freehand stroke)
 */

export function detectShape(stroke: Stroke, threshold: number = 0.15): SnappedShape | null {
  const pts = stroke.points;
  if (pts.length < 5) return null;

  const bbox = getBoundingBox(pts);
  const aspectRatio = bbox.width / (bbox.height || 1);
  const center = { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };

  // Try circle detection first
  const circleResult = detectCircle(pts, center, bbox, threshold);
  if (circleResult) return circleResult;

  // Try rectangle detection
  const rectResult = detectRectangle(pts, bbox, threshold);
  if (rectResult) return rectResult;

  // Try straight line / arrow
  const lineResult = detectLine(pts, threshold);
  if (lineResult) return lineResult;

  return null;
}

interface BBox {
  x: number; y: number; width: number; height: number;
}

function getBoundingBox(pts: Point[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function detectCircle(
  pts: Point[],
  center: { x: number; y: number },
  bbox: BBox,
  threshold: number
): SnappedShape | null {
  const avgRadius = pts.reduce((sum, p) => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    return sum + Math.sqrt(dx * dx + dy * dy);
  }, 0) / pts.length;

  if (avgRadius < 10) return null; // too small

  // Check how well points fit a circle: variance of distances from center
  const variance = pts.reduce((sum, p) => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const diff = (dist - avgRadius) / avgRadius;
    return sum + diff * diff;
  }, 0) / pts.length;

  // Check if stroke is closed (start ≈ end)
  const startEnd = distance(pts[0], pts[pts.length - 1]);
  const isClosed = startEnd < avgRadius * 0.5;

  if (variance < threshold && isClosed) {
    return {
      type: 'circle',
      center: { x: center.x, y: center.y, timestamp: 0 },
      radius: avgRadius,
    };
  }
  return null;
}

function detectRectangle(
  pts: Point[],
  bbox: BBox,
  threshold: number
): SnappedShape | null {
  // Check if stroke is closed
  const startEnd = distance(pts[0], pts[pts.length - 1]);
  const perimeter = 2 * (bbox.width + bbox.height);
  if (startEnd > perimeter * 0.15) return null; // not closed

  // Check how well points stay near the bounding box edges
  let nearEdgeCount = 0;
  const edgeTolerance = Math.max(bbox.width, bbox.height) * 0.15;

  for (const p of pts) {
    const distToLeft = Math.abs(p.x - bbox.x);
    const distToRight = Math.abs(p.x - (bbox.x + bbox.width));
    const distToTop = Math.abs(p.y - bbox.y);
    const distToBottom = Math.abs(p.y - (bbox.y + bbox.height));
    const minDist = Math.min(distToLeft, distToRight, distToTop, distToBottom);
    if (minDist < edgeTolerance) nearEdgeCount++;
  }

  const edgeRatio = nearEdgeCount / pts.length;
  if (edgeRatio > (1 - threshold) && bbox.width > 15 && bbox.height > 15) {
    return {
      type: 'rectangle',
      topLeft: { x: bbox.x, y: bbox.y, timestamp: 0 },
      width: bbox.width,
      height: bbox.height,
    };
  }
  return null;
}

function detectLine(pts: Point[], threshold: number): SnappedShape | null {
  const start = pts[0];
  const end = pts[pts.length - 1];
  const lineLen = distance(start, end);

  if (lineLen < 20) return null; // too short

  // Check how close all points are to the straight line between start and end
  let maxDeviation = 0;
  for (const p of pts) {
    const dev = pointToLineDistance(p, start, end);
    if (dev > maxDeviation) maxDeviation = dev;
  }

  const normalizedDeviation = maxDeviation / lineLen;
  if (normalizedDeviation < threshold) {
    // Check if it looks like an arrow (velocity spike near end)
    const isArrow = detectArrowHead(pts, end);
    return {
      type: isArrow ? 'arrow' : 'line',
      start: { ...start },
      end: { ...end },
    };
  }
  return null;
}

function detectArrowHead(pts: Point[], end: Point): boolean {
  // An arrow has a direction change near the end — the user draws the shaft
  // then flicks to make the arrowhead. Check for angle change in last 20% of points.
  if (pts.length < 10) return false;

  const cutoff = Math.floor(pts.length * 0.8);
  const shaftDir = Math.atan2(
    pts[cutoff].y - pts[0].y,
    pts[cutoff].x - pts[0].x
  );
  const headDir = Math.atan2(
    end.y - pts[cutoff].y,
    end.x - pts[cutoff].x
  );

  const angleDiff = Math.abs(shaftDir - headDir);
  return angleDiff > 0.4 && angleDiff < 2.5; // noticeable but not reversed
}

function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function pointToLineDistance(p: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, lineStart);

  let t = ((p.x - lineStart.x) * dx + (p.y - lineStart.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  return Math.sqrt((p.x - projX) ** 2 + (p.y - projY) ** 2);
}
