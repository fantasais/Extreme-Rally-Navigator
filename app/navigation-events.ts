// Pure, route-independent event progression. No waypoint names, device APIs,
// wall-clock reads or predicted positions are used here.
export type NavigationEvent = {
  id: string;
  kind: "TURN" | "INSTRUCTION" | "DZ" | "FZ";
  distance: number; // Call/approach position along the route, metres.
  passDistance: number; // Geometric turn centre, or instruction/zone boundary.
  lead: number;
};

export type EventFix = {
  timestamp: number;
  receivedAt: number;
  distance: number;
  accuracy: number;
  speedMps: number;
  offset: number;
  headingError?: number;
  reliable: boolean;
  ambiguous?: boolean;
  rejoined?: boolean;
};

export type EventPhase = "UPCOMING" | "APPROACHING" | "EXECUTING" | "PASSED" | "BYPASSED";
export type EventProgress = {
  phase: EventPhase;
  at?: number;
  reason?: string;
  before?: EventFix;
};
export type NavigationState = {
  events: Record<string, EventProgress>;
  lastFix: EventFix | null;
  lastTimestamp: number;
  goodFixes: number;
  ready: boolean;
  recoveryReason: string;
  transitions: { id: string; phase: EventPhase; at: number; reason: string }[];
};

export const createNavigationState = (): NavigationState => ({
  events: {}, lastFix: null, lastTimestamp: 0, goodFixes: 0,
  ready: false, recoveryReason: "INITIAL_ACQUISITION", transitions: [],
});

export const eventFinished = (event?: EventProgress) =>
  event?.phase === "PASSED" || event?.phase === "BYPASSED";

export function advanceNavigation(
  definitions: NavigationEvent[], state: NavigationState, fix: EventFix,
): NavigationState {
  // A duplicate/out-of-order callback must not count as new evidence.
  if (!Number.isFinite(fix.timestamp) || fix.timestamp <= state.lastTimestamp) {
    return state;
  }
  const next: NavigationState = {
    ...state, events: { ...state.events }, lastTimestamp: fix.timestamp, transitions: [],
  };
  const invalidate = (reason: string) => {
    next.ready = false;
    next.goodFixes = 0;
    next.lastFix = null;
    next.recoveryReason = reason;
    for (const event of definitions) {
      const value = next.events[event.id];
      if (value && !eventFinished(value)) next.events[event.id] = { ...value, before: undefined };
    }
  };
  const age = fix.receivedAt - fix.timestamp;
  if (![fix.distance, fix.accuracy, fix.speedMps, fix.offset, age].every(Number.isFinite) ||
      fix.distance < 0 || fix.accuracy < 0 || fix.accuracy > 30 ||
      fix.speedMps < 0 || fix.speedMps > 70 || fix.offset > 35 ||
      age > 2000 || age < -1000 || !fix.reliable || fix.ambiguous ||
      (fix.speedMps > 2.5 && fix.headingError !== undefined &&
        (!Number.isFinite(fix.headingError) || fix.headingError > 75))) {
    invalidate("POSITION_UNCONFIRMED");
    return next;
  }
  let previous = state.lastFix;
  if (fix.rejoined) {
    invalidate("REJOIN");
    previous = null;
  } else if (previous) {
    const dt = (fix.timestamp - previous.timestamp) / 1000;
    const travel = fix.distance - previous.distance;
    const allowance = Math.max(12,
      Math.max(fix.speedMps, previous.speedMps) * dt * 1.7 +
      Math.max(fix.accuracy, previous.accuracy) + 5);
    if (dt > 3.5 || travel < -Math.max(5, fix.accuracy) || travel > allowance) {
      invalidate(dt > 3.5 ? "GPS_GAP" : "POSITION_REALIGNMENT");
      previous = null;
    }
  }
  next.lastFix = fix;
  next.goodFixes = previous ? next.goodFixes + 1 : 1;
  next.ready = next.goodFixes >= 3;

  for (const event of definitions) {
    const old = next.events[event.id];
    if (eventFinished(old)) continue;
    const margin = Math.max(2, Math.min(6, fix.accuracy * 0.25));
    const phase: EventPhase = fix.distance >= event.distance - margin
      ? "EXECUTING"
      : event.distance - fix.distance <= Math.max(event.lead, fix.speedMps * 8)
        ? "APPROACHING" : "UPCOMING";
    const before = fix.distance <= event.passDistance
      ? fix : old?.before;
    next.events[event.id] = { phase, before };
    if (!next.ready || fix.distance < event.passDistance + margin) continue;

    // On acquisition/rejoin, do not invent a crossing or an entry timestamp.
    // A bracket spanning at most 3.5 seconds proves movement through the event.
    const bracket = before &&
      fix.timestamp > before.timestamp &&
      fix.timestamp - before.timestamp <= 3500 &&
      fix.distance > before.distance &&
      fix.distance - before.distance > Math.max(2, fix.accuracy * 0.25) &&
      Math.max(fix.speedMps, before.speedMps) >= 0.8;
    if (bracket) {
      const ratio = (event.passDistance - before.distance) / (fix.distance - before.distance);
      const at = before.timestamp + Math.max(0, Math.min(1, ratio)) * (fix.timestamp - before.timestamp);
      next.events[event.id] = { phase: "PASSED", at, reason: "GPS_CROSSING" };
      next.transitions.push({ id: event.id, phase: "PASSED", at, reason: "GPS_CROSSING" });
    } else if (!state.ready || !previous) {
      next.events[event.id] = { phase: "BYPASSED", reason: next.recoveryReason };
      next.transitions.push({ id: event.id, phase: "BYPASSED", at: fix.timestamp, reason: next.recoveryReason });
    } else if (previous && previous.distance >= event.passDistance &&
        fix.distance - previous.distance >= 1 && fix.speedMps >= 0.8) {
      // Slow passage/stopping on the boundary: two accepted fixes beyond it
      // establish passage, but cannot reconstruct an accurate crossing time.
      next.events[event.id] = { phase: "PASSED", reason: "PASS_TIME_UNCONFIRMED" };
      next.transitions.push({ id: event.id, phase: "PASSED", at: fix.timestamp, reason: "PASS_TIME_UNCONFIRMED" });
    }
  }
  return next;
}

// Display prediction is deliberately separate: it cannot pass any event.
export function displayProgress(
  confirmedDistance: number, speedKph: number, fixTimestamp: number,
  now: number, reliable: boolean, totalDistance: number,
) {
  const age = now - fixTimestamp;
  const seconds = reliable && age >= 0 && age <= 1500
    ? Math.min(age / 1000, 1.1) : 0;
  return Math.max(0, Math.min(totalDistance, confirmedDistance + Math.max(0, speedKph) / 3.6 * seconds));
}

export function zoneFromEvents(state: NavigationState, start: number, finish: number) {
  const dz = state.events["zone:dz"];
  const fz = state.events["zone:fz"];
  if (eventFinished(fz)) {
    return { phase: "COMPLETE" as const,
      enteredAt: dz?.phase === "PASSED" ? dz.at : undefined,
      finishedAt: fz?.phase === "PASSED" ? fz.at : undefined,
      uncertain: dz?.phase !== "PASSED" || fz?.phase !== "PASSED" || dz.at === undefined || fz.at === undefined };
  }
  if (eventFinished(dz)) {
    return { phase: "ACTIVE" as const,
      enteredAt: dz?.phase === "PASSED" ? dz.at : undefined,
      finishedAt: undefined, uncertain: dz?.phase !== "PASSED" || dz.at === undefined };
  }
  return { phase: "ARMED" as const, enteredAt: undefined, finishedAt: undefined, uncertain: false };
}
