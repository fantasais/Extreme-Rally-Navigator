import {
  bearing,
  pointAtDistance,
  signedAngle,
  sourceGapAtDistance,
} from "./geo";
import type { RouteRecord, TurnCall } from "./types";

function severity(angle: number): TurnCall["severity"] {
  return angle >= 110
    ? "HAIRPIN"
    : angle >= 65
      ? "SHARP"
      : angle >= 35
        ? "MEDIUM"
        : "GENTLE";
}

export function turnLeadDistance(turn: TurnCall, speedKph = 0) {
  const severityLead =
    turn.severity === "HAIRPIN"
      ? 320
      : turn.severity === "SHARP"
        ? 260
        : turn.severity === "MEDIUM"
          ? 200
          : 140;
  return Math.max(severityLead, (Math.max(0, speedKph) / 3.6) * 8);
}

type Candidate = Omit<TurnCall, "id" | "confidence"> & {
  startDistance: number;
  endDistance: number;
  confidence: TurnCall["confidence"];
};

export function buildTurnCalls(route: RouteRecord): TurnCall[] {
  const points = route.points;
  const total = points.at(-1)?.distance || 0;
  const threshold = 12;
  const window = 24;
  const trackCandidates: Candidate[] = [];

  for (let distance = window; distance < total - window; distance += 6) {
    const gaps = [
      sourceGapAtDistance(points, distance - window),
      sourceGapAtDistance(points, distance),
      sourceGapAtDistance(points, distance + window),
    ];
    if (Math.max(...gaps) > 140) continue;
    const before = pointAtDistance(points, distance - window);
    const centre = pointAtDistance(points, distance);
    const after = pointAtDistance(points, distance + window);
    const signed = signedAngle(bearing(before, centre), bearing(centre, after));
    const angle = Math.abs(signed);
    if (angle < threshold) continue;
    trackCandidates.push({
      distance,
      passDistance: distance,
      direction: signed > 0 ? "RIGHT" : "LEFT",
      severity: severity(angle),
      angle,
      source: "TRACK",
      confidence: Math.max(...gaps) > 80 ? "MEDIUM" : "HIGH",
      startDistance: distance,
      endDistance: distance,
    });
  }

  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1];
    const centre = points[index];
    const after = points[index + 1];
    const approachGap = centre.distance - before.distance;
    const exitGap = after.distance - centre.distance;
    if (Math.max(approachGap, exitGap) <= 140 || Math.min(approachGap, exitGap) < 4) continue;
    const signed = signedAngle(bearing(before, centre), bearing(centre, after));
    const angle = Math.abs(signed);
    if (angle < 35) continue;
    trackCandidates.push({
      distance: centre.distance,
      passDistance: centre.distance,
      direction: signed > 0 ? "RIGHT" : "LEFT",
      severity: severity(angle),
      angle,
      source: "SPARSE_VERTEX",
      confidence: "LOW",
      startDistance: centre.distance,
      endDistance: centre.distance,
    });
  }

  trackCandidates.sort((a, b) => a.distance - b.distance);
  const runs: Candidate[] = [];
  for (const candidate of trackCandidates) {
    const previous = runs.at(-1);
    if (
      previous &&
      previous.direction === candidate.direction &&
      candidate.distance - previous.endDistance <= 18
    ) {
      previous.endDistance = candidate.distance;
      if (candidate.angle > previous.angle) {
        previous.distance = candidate.distance;
        previous.passDistance = candidate.passDistance;
        previous.angle = candidate.angle;
        previous.severity = candidate.severity;
      }
      if (candidate.confidence === "LOW") previous.confidence = "LOW";
      else if (candidate.confidence === "MEDIUM" && previous.confidence === "HIGH") {
        previous.confidence = "MEDIUM";
      }
      continue;
    }
    runs.push({ ...candidate });
  }

  const calls = runs
    .map((run) => {
      const entry = Math.max(0, run.startDistance - window * 0.5);
      const approachA = pointAtDistance(points, Math.max(0, run.startDistance - 42));
      const approachB = pointAtDistance(points, Math.max(0, run.startDistance - 12));
      const exitA = pointAtDistance(points, Math.min(total, run.endDistance + 12));
      const exitB = pointAtDistance(points, Math.min(total, run.endDistance + 42));
      const net = signedAngle(bearing(approachA, approachB), bearing(exitA, exitB));
      const netAngle = Math.abs(net);
      const sameDirection = (net > 0 ? "RIGHT" : "LEFT") === run.direction;
      const angle = sameDirection && netAngle >= threshold
        ? Math.max(run.angle, netAngle)
        : run.angle;
      return {
        ...run,
        distance: entry,
        passDistance: Math.min(total, entry + 14),
        angle,
        severity: severity(angle),
      };
    })
    .filter((call) => call.angle >= threshold);

  for (const instruction of route.instructions) {
    if (instruction.routeDistance < 45 || instruction.routeDistance > total - 45) continue;
    const before = pointAtDistance(points, instruction.routeDistance - 45);
    const centre = pointAtDistance(points, instruction.routeDistance);
    const after = pointAtDistance(points, instruction.routeDistance + 45);
    const signed = signedAngle(bearing(before, centre), bearing(centre, after));
    const angle = Math.abs(signed);
    if (angle < threshold) continue;
    const largestGap = Math.max(
      sourceGapAtDistance(points, instruction.routeDistance - 20),
      sourceGapAtDistance(points, instruction.routeDistance + 20),
    );
    calls.push({
      distance: instruction.routeDistance,
      passDistance: instruction.routeDistance,
      direction: signed > 0 ? "RIGHT" : "LEFT",
      severity: severity(angle),
      angle,
      source: "WAYPOINT",
      confidence: largestGap > 140 ? "MEDIUM" : "HIGH",
      startDistance: instruction.routeDistance,
      endDistance: instruction.routeDistance,
    });
  }

  calls.sort((a, b) => a.distance - b.distance);
  const merged: Candidate[] = [];
  for (const candidate of calls) {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.direction === candidate.direction &&
      candidate.distance <= previous.endDistance + 18
    ) {
      previous.endDistance = Math.max(previous.endDistance, candidate.endDistance);
      previous.passDistance = Math.max(previous.passDistance, candidate.passDistance);
      if (candidate.angle > previous.angle) {
        previous.angle = candidate.angle;
        previous.severity = candidate.severity;
      }
      if (candidate.source === "WAYPOINT") {
        previous.distance = candidate.distance;
        previous.passDistance = candidate.passDistance;
        previous.source = "WAYPOINT";
        previous.confidence = candidate.confidence;
      }
      continue;
    }
    merged.push({ ...candidate });
  }

  return merged.map((call, index) => ({
    id: `turn-${index}-${Math.round(call.distance)}`,
    distance: call.distance,
    passDistance: call.passDistance,
    direction: call.direction,
    severity: call.severity,
    angle: call.angle,
    source: call.source,
    confidence: call.confidence,
  }));
}
