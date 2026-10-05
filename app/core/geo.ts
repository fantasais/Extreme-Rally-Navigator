import type { Point } from "./types";

export const EARTH_RADIUS = 6_371_000;

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function haversine(
  a: Pick<Point, "lat" | "lon">,
  b: Pick<Point, "lat" | "lon">,
) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function bearing(
  a: Pick<Point, "lat" | "lon">,
  b: Pick<Point, "lat" | "lon">,
) {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export function headingDifference(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

export function signedAngle(from: number, to: number) {
  return ((to - from + 540) % 360) - 180;
}

export function pointIndexAtDistance(points: Point[], distance: number) {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].distance < distance) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function pointAtDistance(points: Point[], distance: number): Point {
  const safe = clamp(distance, 0, points.at(-1)?.distance || 0);
  const finishIndex = pointIndexAtDistance(points, safe);
  if (finishIndex === 0) return { ...points[0], distance: safe };
  const start = points[finishIndex - 1];
  const finish = points[finishIndex];
  const length = finish.distance - start.distance;
  const ratio = length ? (safe - start.distance) / length : 0;
  return {
    lat: start.lat + (finish.lat - start.lat) * ratio,
    lon: start.lon + (finish.lon - start.lon) * ratio,
    ele:
      start.ele !== undefined && finish.ele !== undefined
        ? start.ele + (finish.ele - start.ele) * ratio
        : undefined,
    distance: safe,
  };
}

export function sourceGapAtDistance(points: Point[], distance: number) {
  const index = pointIndexAtDistance(points, distance);
  if (index === 0) return 0;
  return points[index].distance - points[index - 1].distance;
}

export type Projection = {
  routeDistance: number;
  offset: number;
  segment: number;
  segmentBearing: number;
};

export function projectToSegment(
  points: Point[],
  segment: number,
  target: Pick<Point, "lat" | "lon">,
): Projection {
  const safeSegment = clamp(segment, 0, points.length - 2);
  const start = points[safeSegment];
  const finish = points[safeSegment + 1];
  const referenceLatitude =
    ((start.lat + finish.lat + target.lat) / 3) * (Math.PI / 180);
  const xScale =
    EARTH_RADIUS * Math.cos(referenceLatitude) * (Math.PI / 180);
  const yScale = EARTH_RADIUS * (Math.PI / 180);
  const segmentX = (finish.lon - start.lon) * xScale;
  const segmentY = (finish.lat - start.lat) * yScale;
  const targetX = (target.lon - start.lon) * xScale;
  const targetY = (target.lat - start.lat) * yScale;
  const lengthSquared = segmentX ** 2 + segmentY ** 2;
  const ratio = lengthSquared
    ? clamp(
        (targetX * segmentX + targetY * segmentY) / lengthSquared,
        0,
        1,
      )
    : 0;
  return {
    routeDistance:
      start.distance + (finish.distance - start.distance) * ratio,
    offset: Math.hypot(
      targetX - segmentX * ratio,
      targetY - segmentY * ratio,
    ),
    segment: safeSegment,
    segmentBearing: bearing(start, finish),
  };
}

export function projectionsInDistanceWindow(
  points: Point[],
  target: Pick<Point, "lat" | "lon">,
  centreDistance?: number,
  behind = 450,
  ahead = 1_000,
) {
  let start = 0;
  let finish = points.length - 2;
  if (centreDistance !== undefined) {
    start = Math.max(
      0,
      pointIndexAtDistance(points, Math.max(0, centreDistance - behind)) - 1,
    );
    finish = Math.min(
      points.length - 2,
      pointIndexAtDistance(points, centreDistance + ahead),
    );
  }
  const projections: Projection[] = [];
  for (let segment = start; segment <= finish; segment += 1) {
    projections.push(projectToSegment(points, segment, target));
  }
  return projections;
}

export function nearestProjection(
  points: Point[],
  target: Pick<Point, "lat" | "lon">,
) {
  let best: Projection | undefined;
  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const projection = projectToSegment(points, segment, target);
    if (!best || projection.offset < best.offset) best = projection;
  }
  return best!;
}

export function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(
    Math.ceil(fraction * sorted.length) - 1,
    0,
    sorted.length - 1,
  );
  return sorted[index];
}
