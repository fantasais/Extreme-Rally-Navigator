import { markerRouteDistance } from "./gpx";
import { turnLeadDistance } from "./turns";
import type {
  Instruction,
  NavigationEvent,
  NavigationState,
  RouteRecord,
  StageProfile,
  TurnCall,
  ZoneDefinition,
} from "./types";

export type ResolvedZone = ZoneDefinition & {
  startDistance: number;
  finishDistance: number;
};

export function resolveZones(
  route: RouteRecord,
  stage: StageProfile,
): ResolvedZone[] {
  return stage.zones
    .map((zone) => {
      const startDistance = markerRouteDistance(zone.start, stage, route);
      const finishDistance = markerRouteDistance(zone.finish, stage, route);
      if (
        startDistance === undefined ||
        finishDistance === undefined ||
        !Number.isFinite(startDistance) ||
        !Number.isFinite(finishDistance) ||
        finishDistance <= startDistance
      ) return null;
      return { ...zone, startDistance, finishDistance };
    })
    .filter((zone): zone is ResolvedZone => Boolean(zone))
    .sort((a, b) => a.startDistance - b.startDistance);
}

export function stageInstructions(route: RouteRecord, stage: StageProfile) {
  const start = stage.startRouteKm * 1000 - 20;
  const finish = (stage.finishRouteKm ?? route.quality.totalDistance / 1000) * 1000 + 20;
  return route.instructions.filter(
    (instruction) =>
      instruction.routeDistance >= start && instruction.routeDistance <= finish,
  );
}

export function buildNavigationEvents(
  route: RouteRecord,
  stage: StageProfile,
  turns: TurnCall[],
) {
  const start = stage.startRouteKm * 1000 - 20;
  const finish = (stage.finishRouteKm ?? route.quality.totalDistance / 1000) * 1000 + 20;
  const events: NavigationEvent[] = [];
  turns
    .filter((turn) => turn.passDistance >= start && turn.distance <= finish)
    .forEach((turn) =>
      events.push({
        id: `turn:${turn.id}`,
        kind: "TURN",
        distance: turn.distance,
        passDistance: turn.passDistance,
        leadDistance: turnLeadDistance(turn),
        label: `${turn.severity} ${turn.direction}`,
      }),
    );
  stageInstructions(route, stage).forEach((instruction) =>
    events.push({
      id: `instruction:${instruction.id}`,
      kind: "INSTRUCTION",
      distance: instruction.routeDistance,
      passDistance: instruction.routeDistance,
      leadDistance: 150,
      label: instruction.label,
    }),
  );
  resolveZones(route, stage).forEach((zone) => {
    events.push({
      id: `zone:${zone.id}:dz`,
      kind: "DZ",
      distance: zone.startDistance,
      passDistance: zone.startDistance,
      leadDistance: 500,
      label: `${zone.name} DZ`,
      zoneId: zone.id,
    });
    events.push({
      id: `zone:${zone.id}:fz`,
      kind: "FZ",
      distance: zone.finishDistance,
      passDistance: zone.finishDistance,
      leadDistance: 500,
      label: `${zone.name} FZ`,
      zoneId: zone.id,
    });
  });
  return events.sort((a, b) => a.distance - b.distance);
}

export function initialiseNavigation(
  events: NavigationEvent[],
  instructions: Instruction[],
  startDistance: number,
  startInstructionId?: string,
): NavigationState {
  const states: NavigationState["events"] = {};
  events.forEach((event) => {
    states[event.id] = {
      state: event.passDistance < startDistance - 15 ? "BEFORE_START" : "UPCOMING",
      reason: event.passDistance < startDistance - 15 ? "STAGE_INITIALISATION" : undefined,
    };
  });
  const selectedIndex = startInstructionId
    ? instructions.findIndex((instruction) => instruction.id === startInstructionId)
    : -1;
  const distanceIndex = instructions.findIndex(
    (instruction) => instruction.routeDistance >= startDistance - 15,
  );
  const cursor = selectedIndex >= 0
    ? selectedIndex
    : distanceIndex >= 0
      ? distanceIndex
      : Math.max(0, instructions.length - 1);
  instructions.forEach((instruction, index) => {
    if (index < cursor) {
      states[`instruction:${instruction.id}`] = {
        state: "BEFORE_START",
        reason: "STAGE_INITIALISATION",
      };
    }
  });
  return {
    events: states,
    lastReliableDistance: startDistance,
    instructionCursor: cursor,
    initialised: true,
    transitions: [],
  };
}

export function advanceNavigation(
  state: NavigationState,
  events: NavigationEvent[],
  instructions: Instruction[],
  routeDistance: number,
  timestamp: number,
  reliable: boolean,
) {
  const next: NavigationState = {
    ...state,
    events: { ...state.events },
    transitions: [],
  };
  if (!reliable) return next;
  const previous = state.lastReliableDistance ?? routeDistance;
  if (routeDistance < previous) return next;
  const travel = routeDistance - previous;
  if (travel > 100) {
    for (const event of events) {
      const current = next.events[event.id] || { state: "UPCOMING" as const };
      if (current.state !== "UPCOMING") continue;
      if (event.passDistance < previous - 5 || event.passDistance > routeDistance + 5) continue;
      next.events[event.id] = {
        state: "MISSED",
        at: timestamp,
        reason: "GNSS_GAP_NO_CONFIRMED_CROSSING",
      };
      next.transitions.push(
        `${event.id}:MISSED:GNSS_GAP_NO_CONFIRMED_CROSSING:${Math.round(timestamp)}`,
      );
      if (event.kind === "INSTRUCTION") {
        const instructionId = event.id.slice("instruction:".length);
        const index = instructions.findIndex((instruction) => instruction.id === instructionId);
        if (index >= 0) next.instructionCursor = Math.min(instructions.length, index + 1);
      }
    }
    next.lastReliableDistance = routeDistance;
    return next;
  }

  for (const event of events) {
    const current = next.events[event.id] || { state: "UPCOMING" as const };
    if (current.state !== "UPCOMING") continue;
    const crossed =
      event.passDistance >= previous - 5 &&
      event.passDistance <= routeDistance + 5;
    if (!crossed) continue;
    next.events[event.id] = {
      state: "PASSED",
      at: timestamp,
      reason: "CONFIRMED_ROUTE_CROSSING",
    };
    next.transitions.push(
      `${event.id}:PASSED:CONFIRMED_ROUTE_CROSSING:${Math.round(timestamp)}`,
    );
    if (event.kind === "INSTRUCTION") {
      const instructionId = event.id.slice("instruction:".length);
      const index = instructions.findIndex((instruction) => instruction.id === instructionId);
      if (index >= 0) next.instructionCursor = Math.min(instructions.length, index + 1);
    }
  }
  next.lastReliableDistance = routeDistance;
  return next;
}

export function seekNavigation(
  state: NavigationState,
  events: NavigationEvent[],
  instructions: Instruction[],
  routeDistance: number,
  timestamp: number,
  reason: "MANUAL_ODO_SET" | "MANUAL_REJOIN",
) {
  const next: NavigationState = {
    ...state,
    events: { ...state.events },
    lastReliableDistance: routeDistance,
    transitions: [],
  };
  for (const event of events) {
    const current = next.events[event.id];
    if (event.passDistance < routeDistance - 5 && current?.state === "UPCOMING") {
      next.events[event.id] = { state: "MISSED", at: timestamp, reason };
      next.transitions.push(`${event.id}:MISSED:${reason}:${Math.round(timestamp)}`);
    }
  }
  const cursor = instructions.findIndex(
    (instruction) => instruction.routeDistance >= routeDistance - 5,
  );
  if (cursor >= 0) next.instructionCursor = cursor;
  return next;
}

export function setInstructionCursor(
  state: NavigationState,
  instructions: Instruction[],
  targetIndex: number,
  timestamp: number,
) {
  const safe = Math.max(0, Math.min(instructions.length - 1, targetIndex));
  const next: NavigationState = {
    ...state,
    events: { ...state.events },
    instructionCursor: safe,
    transitions: [
      `instruction:${instructions[safe]?.id || "none"}:CURSOR:MANUAL_INSTRUCTION_SET:${Math.round(timestamp)}`,
    ],
  };
  instructions.forEach((instruction, index) => {
    const id = `instruction:${instruction.id}`;
    if (index < safe && next.events[id]?.state === "UPCOMING") {
      next.events[id] = {
        state: "MISSED",
        at: timestamp,
        reason: "MANUAL_INSTRUCTION_SET",
      };
    } else if (index >= safe && next.events[id]?.reason === "MANUAL_INSTRUCTION_SET") {
      next.events[id] = { state: "UPCOMING" };
    }
  });
  return next;
}

export function eventFinished(state: NavigationState, id: string) {
  const value = state.events[id]?.state;
  return value === "PASSED" || value === "MISSED" || value === "BEFORE_START";
}

export function zoneEvidence(
  state: NavigationState,
  zone: ResolvedZone,
  now: number,
) {
  const dz = state.events[`zone:${zone.id}:dz`];
  const fz = state.events[`zone:${zone.id}:fz`];
  if (fz?.state === "PASSED") {
    return {
      phase: "COMPLETE" as const,
      enteredAt: dz?.state === "PASSED" ? dz.at : undefined,
      finishedAt: fz.at,
      elapsedSeconds:
        dz?.at !== undefined && fz.at !== undefined ? (fz.at - dz.at) / 1000 : undefined,
      uncertain: dz?.state !== "PASSED" || dz.at === undefined || fz.at === undefined,
    };
  }
  if (dz?.state === "PASSED") {
    return {
      phase: "ACTIVE" as const,
      enteredAt: dz.at,
      finishedAt: undefined,
      elapsedSeconds: dz.at !== undefined ? (now - dz.at) / 1000 : undefined,
      uncertain: dz.at === undefined,
    };
  }
  return {
    phase: "ARMED" as const,
    enteredAt: undefined,
    finishedAt: undefined,
    elapsedSeconds: undefined,
    uncertain: false,
  };
}
