"use client";

import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Point = { lat: number; lon: number; ele?: number; distance: number };
type Instruction = {
  id: string;
  label: string;
  note: string;
  point: number;
  distance: number;
};
type Route = {
  id: string;
  name: string;
  points: Point[];
  instructions: Instruction[];
};
type Zone = {
  start: string;
  finish: string;
  speed: number;
  officialDistance?: number;
};
type RouteConfig = {
  officialStart: string;
  zone: Zone;
};
type TurnCall = {
  distance: number;
  direction: "LEFT" | "RIGHT";
  severity: "GENTLE" | "MEDIUM" | "SHARP" | "HAIRPIN";
  angle: number;
  source: "TRACK" | "WAYPOINT";
  startDistance: number;
  endDistance: number;
};
type RecoveryGuidance = {
  label: string;
  arrow: string;
  bearing: number;
};
type ActiveStage = {
  routeId: string;
  config: RouteConfig;
  startTimestamp: number;
  testMode: boolean;
};
type Tab = "setup" | "rally" | "controls";
type StageStatus = "idle" | "armed" | "running" | "finished";
type ZoneAlert = "DZ" | "FZ" | null;
type GpsStatus = "off" | "acquiring" | "ready" | "error";
type WakeStatus = "off" | "active" | "unsupported" | "blocked";
type WakeLockSentinelLike = EventTarget & {
  released: boolean;
  release: () => Promise<void>;
};
type RouteProjection = {
  routeDistance: number;
  offset: number;
  segment: number;
  segmentBearing: number;
  nearestRouteDistance: number;
  nearestOffset: number;
  nearestSegment: number;
  nearestSegmentBearing: number;
};
type GpsFix = {
  lat: number;
  lon: number;
  timestamp: number;
  routeDistance: number;
  speedMps: number;
  segment: number;
};
type RunLogEntry = {
  timestamp: number;
  lat: number;
  lon: number;
  accuracy: number;
  reportedSpeedKph: number;
  displayedSpeedKph: number;
  routeDistance: number;
  offRouteDistance: number;
  segment: number;
  continuityOffset: number;
  nearestRouteDistance: number;
  rejoined: boolean;
  routeDistanceReliable: boolean;
  progressAdjustment: string;
  callMode: string;
  upcomingTurn: string;
  upcomingTurnRouteDistance: number | null;
  turnDistance: number | null;
  followingTurn: string;
  followingTurnRouteDistance: number | null;
  followingTurnDistance: number | null;
  nextInstruction: string;
  instructionDistance: number | null;
  recoveryDirection: string;
};
type StageSummary = {
  routeName: string;
  startedAt: number;
  finishedAt: number;
  elapsedSeconds: number;
  actualDistance: number;
  routeDistance: number;
  averageSpeedKph: number;
  topSpeedKph: number;
  testMode: boolean;
};
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const STORAGE_KEY = "xr-navigator-v0.5-routes";

const EARTH_RADIUS = 6_371_000;
const GENERIC_NOTE = "Roadbook instruction";
const OFF_ROUTE_DISTANCE = 50;
const TURN_PASS_MARGIN = 2;
const COMBINATION_DISTANCE = 120;
const GPS_PREDICTION_LIMIT_SECONDS = 1.1;

const haversine = (
  a: Pick<Point, "lat" | "lon">,
  b: Pick<Point, "lat" | "lon">,
) => {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const deltaLat = ((b.lat - a.lat) * Math.PI) / 180;
  const deltaLon = ((b.lon - a.lon) * Math.PI) / 180;
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(deltaLon / 2) ** 2;
  return (
    2 *
    EARTH_RADIUS *
    Math.atan2(Math.sqrt(value), Math.sqrt(1 - value))
  );
};

const bearing = (
  a: Pick<Point, "lat" | "lon">,
  b: Pick<Point, "lat" | "lon">,
) => {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const deltaLon = ((b.lon - a.lon) * Math.PI) / 180;
  return (
    (Math.atan2(
      Math.sin(deltaLon) * Math.cos(p2),
      Math.cos(p1) * Math.sin(p2) -
        Math.sin(p1) * Math.cos(p2) * Math.cos(deltaLon),
    ) *
      180) /
      Math.PI +
    360
  ) % 360;
};

const signedAngle = (from: number, to: number) =>
  ((to - from + 540) % 360) - 180;

const headingDifference = (a: number, b: number) =>
  Math.abs(signedAngle(a, b));

function recoveryFromHeading(
  heading: number | undefined,
  recoveryBearing: number,
): RecoveryGuidance {
  if (heading === undefined) {
    return {
      label: `TRACK BEARING ${Math.round(recoveryBearing)}°`,
      arrow: "◎",
      bearing: recoveryBearing,
    };
  }
  const relative = signedAngle(heading, recoveryBearing);
  const magnitude = Math.abs(relative);
  const side = relative < 0 ? "LEFT" : "RIGHT";
  if (magnitude <= 22.5) {
    return { label: "TRACK AHEAD", arrow: "↑", bearing: recoveryBearing };
  }
  if (magnitude <= 67.5) {
    return {
      label: `TRACK AHEAD ${side}`,
      arrow: relative < 0 ? "↖" : "↗",
      bearing: recoveryBearing,
    };
  }
  if (magnitude <= 112.5) {
    return {
      label: `TRACK ${side}`,
      arrow: relative < 0 ? "←" : "→",
      bearing: recoveryBearing,
    };
  }
  if (magnitude <= 157.5) {
    return {
      label: `TRACK BEHIND ${side}`,
      arrow: relative < 0 ? "↙" : "↘",
      bearing: recoveryBearing,
    };
  }
  return { label: "TRACK BEHIND", arrow: "↓", bearing: recoveryBearing };
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

function projectPointToRoute(
  points: Point[],
  target: Pick<Point, "lat" | "lon">,
  continuity?: {
    previousDistance: number;
    elapsedSeconds: number;
    speedMps: number;
    accuracy: number;
    heading?: number;
  },
): RouteProjection {
  let best: RouteProjection | undefined;
  let bestScore = Infinity;
  let nearest:
    | Pick<
        RouteProjection,
        "routeDistance" | "offset" | "segment" | "segmentBearing"
      >
    | undefined;

  for (let segment = 0; segment < points.length - 1; segment += 1) {
    const start = points[segment];
    const finish = points[segment + 1];
    const referenceLatitude =
      ((start.lat + finish.lat + target.lat) / 3) * (Math.PI / 180);
    const xScale = EARTH_RADIUS * Math.cos(referenceLatitude) * (Math.PI / 180);
    const yScale = EARTH_RADIUS * (Math.PI / 180);
    const segmentX = (finish.lon - start.lon) * xScale;
    const segmentY = (finish.lat - start.lat) * yScale;
    const targetX = (target.lon - start.lon) * xScale;
    const targetY = (target.lat - start.lat) * yScale;
    const segmentLengthSquared = segmentX ** 2 + segmentY ** 2;
    const ratio = segmentLengthSquared
      ? clamp(
          (targetX * segmentX + targetY * segmentY) /
            segmentLengthSquared,
          0,
          1,
        )
      : 0;
    const separation = Math.hypot(
      targetX - segmentX * ratio,
      targetY - segmentY * ratio,
    );
    const routeDistance =
      start.distance + (finish.distance - start.distance) * ratio;
    const segmentBearing = bearing(start, finish);
    let score = separation;

    if (!nearest || separation < nearest.offset) {
      nearest = { routeDistance, offset: separation, segment, segmentBearing };
    }

    if (continuity) {
      const delta = routeDistance - continuity.previousDistance;
      const plausibleTravel = Math.max(
        18,
        continuity.speedMps * continuity.elapsedSeconds * 1.7 +
          continuity.accuracy * 1.25 +
          8,
      );
      if (delta > plausibleTravel) score += (delta - plausibleTravel) * 3;
      const allowedReverse = Math.max(12, plausibleTravel * 0.4);
      if (delta < -allowedReverse) {
        score += (Math.abs(delta) - allowedReverse) * 4;
      }
      if (
        continuity.heading !== undefined &&
        continuity.speedMps > 2.5
      ) {
        score +=
          (headingDifference(continuity.heading, segmentBearing) / 180) * 60;
      }
    }

    if (score < bestScore) {
      bestScore = score;
      best = {
        routeDistance,
        offset: separation,
        segment,
        segmentBearing,
        nearestRouteDistance: routeDistance,
        nearestOffset: separation,
        nearestSegment: segment,
        nearestSegmentBearing: segmentBearing,
      };
    }
  }

  const fallback = {
      routeDistance: 0,
      offset: Infinity,
      segment: 0,
      segmentBearing: 0,
      nearestRouteDistance: 0,
      nearestOffset: Infinity,
      nearestSegment: 0,
      nearestSegmentBearing: 0,
  };
  if (!best || !nearest) return fallback;
  return {
    ...best,
    nearestRouteDistance: nearest.routeDistance,
    nearestOffset: nearest.offset,
    nearestSegment: nearest.segment,
    nearestSegmentBearing: nearest.segmentBearing,
  };
}

function pointAtDistance(points: Point[], distance: number): Point {
  const safeDistance = clamp(
    distance,
    0,
    points.at(-1)?.distance || 0,
  );
  const finishIndex = pointIndexAtDistance(points, safeDistance);
  if (finishIndex === 0) return points[0];
  const start = points[finishIndex - 1];
  const finish = points[finishIndex];
  const segmentDistance = finish.distance - start.distance;
  const ratio = segmentDistance
    ? (safeDistance - start.distance) / segmentDistance
    : 0;
  return {
    lat: start.lat + (finish.lat - start.lat) * ratio,
    lon: start.lon + (finish.lon - start.lon) * ratio,
    ele:
      start.ele !== undefined && finish.ele !== undefined
        ? start.ele + (finish.ele - start.ele) * ratio
        : undefined,
    distance: safeDistance,
  };
}

function sourceGapAtDistance(points: Point[], distance: number) {
  const finishIndex = pointIndexAtDistance(points, distance);
  if (finishIndex === 0) return 0;
  return points[finishIndex].distance - points[finishIndex - 1].distance;
}

const formatDistance = (metres: number) =>
  metres >= 1000
    ? `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`
    : `${Math.max(0, Math.round(metres))} m`;

const formatDuration = (seconds: number) => {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainingSeconds = Math.floor(safe % 60);
  return hours
    ? `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${remainingSeconds
        .toString()
        .padStart(2, "0")}`;
};

const formatCountdown = (milliseconds: number) =>
  formatDuration(Math.ceil(Math.max(0, milliseconds) / 1000));

const shortInstruction = (label: string) =>
  label.match(/(\d{1,3})$/)?.[1] || label;

const usefulNote = (instruction?: Instruction) =>
  instruction && instruction.note !== GENERIC_NOTE ? instruction.note : "";

const toLocalInputValue = (date: Date) => {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
};

const defaultStart = () => {
  const value = new Date(Date.now() + 5 * 60_000);
  value.setSeconds(0, 0);
  return toLocalInputValue(value);
};

function parseGpx(text: string, fileName: string): Route {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Invalid GPX file");

  const trackPoints = [...xml.getElementsByTagNameNS("*", "trkpt")];
  const routePoints = [...xml.getElementsByTagNameNS("*", "rtept")];
  const nodes = trackPoints.length ? trackPoints : routePoints;
  if (nodes.length < 2) throw new Error("No usable track found");

  let cumulativeDistance = 0;
  const points: Point[] = [];
  nodes.forEach((node) => {
    const point: Point = {
      lat: Number(node.getAttribute("lat")),
      lon: Number(node.getAttribute("lon")),
      ele:
        Number(node.getElementsByTagNameNS("*", "ele")[0]?.textContent) ||
        undefined,
      distance: 0,
    };
    const previous = points.at(-1);
    if (previous) cumulativeDistance += haversine(previous, point);
    point.distance = cumulativeDistance;
    points.push(point);
  });

  const instructions = [...xml.getElementsByTagNameNS("*", "wpt")]
    .map((waypoint, waypointIndex) => {
      const waypointPoint = {
        lat: Number(waypoint.getAttribute("lat")),
        lon: Number(waypoint.getAttribute("lon")),
      };
      const projection = projectPointToRoute(points, waypointPoint);
      const nearestPoint =
        projection.routeDistance - points[projection.segment].distance >
        points[projection.segment + 1].distance - projection.routeDistance
          ? projection.segment + 1
          : projection.segment;
      const get = (tag: string) =>
        waypoint
          .getElementsByTagNameNS("*", tag)[0]
          ?.textContent?.trim() || "";
      return {
        id: `${waypointIndex}-${get("name") || waypointIndex}`,
        label:
          get("name") || String(waypointIndex + 1).padStart(3, "0"),
        note: get("cmt") || get("desc") || GENERIC_NOTE,
        point: nearestPoint,
        distance: projection.routeDistance,
        offset: projection.offset,
      };
    })
    .filter((instruction) => instruction.offset < 300)
    .sort((a, b) => a.distance - b.distance)
    .map(({ offset: _offset, ...instruction }) => instruction);

  const generatedId =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return {
    id: generatedId,
    name: fileName.replace(/\.gpx$/i, ""),
    points,
    instructions,
  };
}

function defaultConfig(route: Route): RouteConfig {
  const dz = route.instructions.find((instruction) =>
    /\bDZ\b/i.test(`${instruction.label} ${instruction.note}`),
  );
  const fz = route.instructions.find(
    (instruction) =>
      instruction.distance > (dz?.distance ?? -1) &&
      /\bFZ\b/i.test(`${instruction.label} ${instruction.note}`),
  );
  return {
    officialStart: defaultStart(),
    zone: {
      start: dz?.id || "",
      finish: fz?.id || "",
      speed: 30,
    },
  };
}

function pointIndexAtDistance(points: Point[], distance: number) {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].distance < distance) low = middle + 1;
    else high = middle;
  }
  return low;
}

function turnSeverity(magnitude: number): TurnCall["severity"] {
  return magnitude >= 110
    ? "HAIRPIN"
    : magnitude >= 65
      ? "SHARP"
      : magnitude >= 35
        ? "MEDIUM"
        : "GENTLE";
}

function turnLeadDistance(turn: TurnCall, speedKph = 0) {
  const severityLead =
    turn.severity === "HAIRPIN"
      ? 320
      : turn.severity === "SHARP"
        ? 260
        : turn.severity === "MEDIUM"
          ? 200
          : 140;
  return Math.max(severityLead, (speedKph / 3.6) * 8);
}

function buildTurnCalls(route: Route): TurnCall[] {
  const threshold = 12;
  const totalDistance = route.points.at(-1)!.distance;
  const window = 24;
  const trackCandidates: TurnCall[] = [];

  for (
    let sampleDistance = window;
    sampleDistance < totalDistance - window;
    sampleDistance += 6
  ) {
    const before = pointAtDistance(route.points, sampleDistance - window);
    const centre = pointAtDistance(route.points, sampleDistance);
    const after = pointAtDistance(route.points, sampleDistance + window);
    const worstSourceGap = Math.max(
      sourceGapAtDistance(route.points, sampleDistance - window),
      sourceGapAtDistance(route.points, sampleDistance),
      sourceGapAtDistance(route.points, sampleDistance + window),
    );
    if (worstSourceGap > 140) continue;

    const turn = signedAngle(
      bearing(before, centre),
      bearing(centre, after),
    );
    const magnitude = Math.abs(turn);
    if (magnitude < threshold) continue;

    trackCandidates.push({
      distance: sampleDistance,
      direction: turn > 0 ? "RIGHT" : "LEFT",
      severity: turnSeverity(magnitude),
      angle: magnitude,
      source: "TRACK",
      startDistance: sampleDistance,
      endDistance: sampleDistance,
    });
  }

  const directionalRuns: TurnCall[] = [];
  trackCandidates.forEach((candidate) => {
    const previous = directionalRuns.at(-1);
    if (
      previous &&
      previous.direction === candidate.direction &&
      candidate.distance - previous.endDistance <= 72
    ) {
      previous.endDistance = candidate.distance;
      if (candidate.angle > previous.angle) {
        previous.distance = candidate.distance;
        previous.angle = candidate.angle;
        previous.severity = candidate.severity;
      }
      return;
    }
    directionalRuns.push({ ...candidate });
  });

  const stableRuns: TurnCall[] = [];
  directionalRuns.forEach((candidate, candidateIndex) => {
    const previous = stableRuns.at(-1);
    const following = directionalRuns[candidateIndex + 1];
    const isWeakReversal =
      previous &&
      following &&
      previous.direction === following.direction &&
      candidate.direction !== previous.direction &&
      candidate.angle < 22 &&
      candidate.endDistance - candidate.startDistance < 55 &&
      candidate.startDistance - previous.endDistance < 80 &&
      following.startDistance - candidate.endDistance < 80;

    if (isWeakReversal) {
      following.startDistance = previous.startDistance;
      following.angle = Math.max(previous.angle, following.angle);
      following.severity = turnSeverity(following.angle);
      stableRuns.pop();
      return;
    }

    if (
      previous &&
      previous.direction === candidate.direction &&
      candidate.startDistance - previous.endDistance <= 105
    ) {
      previous.endDistance = candidate.endDistance;
      if (candidate.angle > previous.angle) {
        previous.distance = candidate.distance;
        previous.angle = candidate.angle;
        previous.severity = candidate.severity;
      }
      return;
    }
    stableRuns.push({ ...candidate });
  });

  const eventCalls = stableRuns
    .map((run) => {
      const approachStart = Math.max(0, run.startDistance - 42);
      const approachFinish = Math.max(0, run.startDistance - 12);
      const exitStart = Math.min(totalDistance, run.endDistance + 12);
      const exitFinish = Math.min(totalDistance, run.endDistance + 42);
      const approachHeading = bearing(
        pointAtDistance(route.points, approachStart),
        pointAtDistance(route.points, approachFinish),
      );
      const exitHeading = bearing(
        pointAtDistance(route.points, exitStart),
        pointAtDistance(route.points, exitFinish),
      );
      const netTurn = signedAngle(approachHeading, exitHeading);
      const netMagnitude = Math.abs(netTurn);
      const netDirection = netTurn > 0 ? "RIGHT" : "LEFT";
      const netSupportsRun =
        netMagnitude >= threshold && netDirection === run.direction;
      const magnitude = netSupportsRun
        ? Math.max(run.angle, netMagnitude)
        : run.angle;
      return {
        ...run,
        distance: Math.max(0, run.startDistance - window * 0.5),
        direction: run.direction,
        angle: magnitude,
        severity: turnSeverity(magnitude),
      };
    })
    .filter((call) => call.angle >= threshold);

  const waypointCalls: TurnCall[] = [];
  route.instructions.forEach((instruction) => {
    if (instruction.distance < 25 || instruction.distance > totalDistance - 25) {
      return;
    }
    const before = pointAtDistance(route.points, instruction.distance - 45);
    const centre = pointAtDistance(route.points, instruction.distance);
    const after = pointAtDistance(route.points, instruction.distance + 45);
    const turn = signedAngle(
      bearing(before, centre),
      bearing(centre, after),
    );
    const magnitude = Math.abs(turn);
    if (magnitude < threshold) return;
    waypointCalls.push({
      distance: instruction.distance,
      direction: turn > 0 ? "RIGHT" : "LEFT",
      severity: turnSeverity(magnitude),
      angle: magnitude,
      source: "WAYPOINT",
      startDistance: instruction.distance,
      endDistance: instruction.distance,
    });
  });

  const candidates = [...eventCalls, ...waypointCalls].sort(
    (a, b) => a.distance - b.distance,
  );

  const merged: TurnCall[] = [];
  candidates.forEach((candidate) => {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.direction === candidate.direction &&
      candidate.distance - previous.endDistance < 90
    ) {
      previous.startDistance = Math.min(
        previous.startDistance,
        candidate.startDistance,
      );
      previous.endDistance = Math.max(
        previous.endDistance,
        candidate.endDistance,
      );
      if (candidate.angle > previous.angle) {
        previous.angle = candidate.angle;
        previous.severity = candidate.severity;
      }
      if (candidate.source === "WAYPOINT") {
        previous.distance = candidate.distance;
        previous.source = "WAYPOINT";
      }
      return;
    }

    if (
      previous &&
      previous.direction !== candidate.direction &&
      candidate.distance - previous.distance < 38 &&
      candidate.source !== "WAYPOINT" &&
      previous.source !== "WAYPOINT" &&
      Math.min(candidate.angle, previous.angle) < 24
    ) {
      if (candidate.angle > previous.angle) {
        merged[merged.length - 1] = { ...candidate };
      }
      return;
    }
    merged.push({ ...candidate });
  });

  return merged;
}

function RoutePreview({ route }: { route: Route }) {
  const points = route.points;
  const minX = Math.min(...points.map((point) => point.lon));
  const maxX = Math.max(...points.map((point) => point.lon));
  const minY = Math.min(...points.map((point) => point.lat));
  const maxY = Math.max(...points.map((point) => point.lat));
  const xy = (point: Point) => [
    24 + ((point.lon - minX) / (maxX - minX || 1)) * 552,
    256 - ((point.lat - minY) / (maxY - minY || 1)) * 220,
  ];
  const path = points
    .map((point, pointIndex) =>
      `${pointIndex ? "L" : "M"} ${xy(point).join(" ")}`,
    )
    .join(" ");

  return (
    <svg viewBox="0 0 600 280" className="map" aria-label="Imported GPX route">
      <path d={path} className="route-shadow" />
      <path d={path} className="route-line" />
      {route.instructions.map((instruction) => {
        const [x, y] = xy(points[instruction.point]);
        return (
          <circle
            key={instruction.id}
            cx={x}
            cy={y}
            r="3.5"
            className="marker"
          />
        );
      })}
      <circle
        cx={xy(points[0])[0]}
        cy={xy(points[0])[1]}
        r="8"
        className="start-marker"
      />
      <circle
        cx={xy(points.at(-1)!)[0]}
        cy={xy(points.at(-1)!)[1]}
        r="8"
        className="finish-marker"
      />
    </svg>
  );
}

export default function NavigatorApp() {
  const [tab, setTab] = useState<Tab>("setup");
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [configs, setConfigs] = useState<Record<string, RouteConfig>>({});
  const [activeStage, setActiveStage] = useState<ActiveStage | null>(null);
  const [stageStatus, setStageStatus] = useState<StageStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("off");
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [currentSpeed, setCurrentSpeed] = useState(0);
  const [lastGpsFixTimestamp, setLastGpsFixTimestamp] = useState(0);
  const [gpsError, setGpsError] = useState("");
  const [offRouteDistance, setOffRouteDistance] = useState(0);
  const [routeDistanceReliable, setRouteDistanceReliable] = useState(true);
  const [recoveryGuidance, setRecoveryGuidance] =
    useState<RecoveryGuidance | null>(null);
  const [wakeStatus, setWakeStatus] = useState<WakeStatus>("off");
  const [setupError, setSetupError] = useState("");
  const [zoneStartedAt, setZoneStartedAt] = useState<number | null>(null);
  const [zoneElapsed, setZoneElapsed] = useState(0);
  const [zoneAlert, setZoneAlert] = useState<ZoneAlert>(null);
  const [stageSummary, setStageSummary] = useState<StageSummary | null>(null);
  const [endHoldActive, setEndHoldActive] = useState(false);
  const [installPrompt, setInstallPrompt] =
    useState<InstallPromptEvent | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const watchRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const gpsFixRef = useRef<GpsFix | null>(null);
  const smoothedSpeedRef = useRef(0);
  const runLogRef = useRef<RunLogEntry[]>([]);
  const rejoinCandidateRef = useRef({ count: 0, routeDistance: 0 });
  const continuityCandidateRef = useRef({ count: 0, routeDistance: 0 });
  const wasOffRouteRef = useRef(false);
  const startAnchoredRef = useRef(true);
  const reliableRouteFixesRef = useRef(0);
  const routeDistanceReliableRef = useRef(true);
  const actualDistanceRef = useRef(0);
  const topSpeedRef = useRef(0);
  const stageStartTimestampRef = useRef(0);
  const endHoldTimerRef = useRef<number | null>(null);
  const zoneAlertTimerRef = useRef<number | null>(null);
  const previousZoneStateRef = useRef("OFF");
  const reachedWaypointTurnsRef = useRef<Set<number>>(new Set());

  const selectedRoute =
    routes.find((route) => route.id === selectedRouteId) || routes[0];
  const selectedConfig = selectedRoute
    ? configs[selectedRoute.id]
    : undefined;
  const activeRoute = activeStage
    ? routes.find((route) => route.id === activeStage.routeId)
    : undefined;
  const activeConfig = activeStage?.config;
  const setupLocked = stageStatus !== "idle";
  const stageActive = stageStatus === "armed" || stageStatus === "running";

  const selectedTurnCalls = useMemo(
    () => (selectedRoute ? buildTurnCalls(selectedRoute) : []),
    [selectedRoute],
  );
  const activeTurnCalls = useMemo(
    () => (activeRoute ? buildTurnCalls(activeRoute) : []),
    [activeRoute],
  );

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    return () =>
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
  }, []);

  useEffect(() => {
    try {
      const saved =
        window.localStorage.getItem(STORAGE_KEY) ||
        window.localStorage.getItem("xr-navigator-v0.4-routes");
      if (saved) {
        const state = JSON.parse(saved) as {
          routes?: Route[];
          configs?: Record<string, RouteConfig>;
          selectedRouteId?: string;
        };
        if (Array.isArray(state.routes) && state.routes.length) {
          setRoutes(state.routes);
          setConfigs(state.configs || {});
          const savedSelection = state.routes.some(
            (route) => route.id === state.selectedRouteId,
          )
            ? state.selectedRouteId!
            : state.routes[0].id;
          setSelectedRouteId(savedSelection);
        }
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    } finally {
      setStorageReady(true);
    }
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ routes, configs, selectedRouteId }),
      );
    } catch {
      setSetupError(
        "This device could not save every GPX locally. Remove unused routes before closing the app.",
      );
    }
  }, [storageReady, routes, configs, selectedRouteId]);

  useEffect(
    () => () => {
      if (watchRef.current !== null) {
        navigator.geolocation.clearWatch(watchRef.current);
      }
      if (endHoldTimerRef.current !== null) {
        window.clearTimeout(endHoldTimerRef.current);
      }
      if (zoneAlertTimerRef.current !== null) {
        window.clearTimeout(zoneAlertTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const wakeLockApi = (
      navigator as Navigator & {
        wakeLock?: {
          request: (type: "screen") => Promise<WakeLockSentinelLike>;
        };
      }
    ).wakeLock;

    const releaseWakeLock = async () => {
      const current = wakeLockRef.current;
      wakeLockRef.current = null;
      if (current && !current.released) await current.release().catch(() => {});
      setWakeStatus("off");
    };

    if (!stageActive) {
      void releaseWakeLock();
      return;
    }

    if (!wakeLockApi) {
      setWakeStatus("unsupported");
      return;
    }

    const acquireWakeLock = async () => {
      if (
        document.visibilityState !== "visible" ||
        (wakeLockRef.current && !wakeLockRef.current.released)
      ) {
        return;
      }
      try {
        const sentinel = await wakeLockApi.request("screen");
        wakeLockRef.current = sentinel;
        setWakeStatus("active");
        sentinel.addEventListener("release", () => {
          if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
        });
      } catch {
        setWakeStatus("blocked");
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void acquireWakeLock();
    };
    void acquireWakeLock();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void releaseWakeLock();
    };
  }, [stageActive]);

  useEffect(() => {
    if (stageStatus === "idle") return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [stageStatus]);

  useEffect(() => {
    if (
      stageStatus === "armed" &&
      activeStage &&
      now >= activeStage.startTimestamp
    ) {
      setStageStatus("running");
    }
  }, [stageStatus, activeStage, now]);

  useEffect(() => {
    if (
      stageStatus !== "running" ||
      !activeStage?.testMode ||
      !activeRoute
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setProgress((previous) => {
        const finishDistance = activeRoute.points.at(-1)!.distance;
        const step = Math.max(2, finishDistance / 240);
        if (previous + step >= finishDistance) {
          return finishDistance;
        }
        return previous + step;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [stageStatus, activeStage, activeRoute]);

  const updateSelectedConfig = (
    update: (current: RouteConfig) => RouteConfig,
  ) => {
    if (!selectedRoute || !selectedConfig || setupLocked) return;
    setConfigs((previous) => ({
      ...previous,
      [selectedRoute.id]: update(previous[selectedRoute.id]),
    }));
  };

  const load = async (files: FileList | null) => {
    if (!files || setupLocked) return;
    const parsed: Route[] = [];
    for (const file of [...files]) {
      try {
        parsed.push(parseGpx(await file.text(), file.name));
      } catch (error) {
        alert(`${file.name}: ${(error as Error).message}`);
      }
    }
    if (!parsed.length) return;

    setRoutes((previous) => [...previous, ...parsed]);
    setConfigs((previous) => {
      const next = { ...previous };
      parsed.forEach((route) => {
        next[route.id] = defaultConfig(route);
      });
      return next;
    });
    setSelectedRouteId(parsed[0].id);
    setSetupError("");
  };

  const removeSelectedRoute = () => {
    if (!selectedRoute || setupLocked) return;
    const confirmed = window.confirm(
      `Remove "${selectedRoute.name}" from this device? Its DZ/FZ settings will also be deleted.`,
    );
    if (!confirmed) return;

    const remainingRoutes = routes.filter(
      (route) => route.id !== selectedRoute.id,
    );
    setRoutes(remainingRoutes);
    setConfigs((previous) => {
      const next = { ...previous };
      delete next[selectedRoute.id];
      return next;
    });
    setSelectedRouteId(remainingRoutes[0]?.id || "");
    setSetupError("");
  };

  const stopGps = () => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
    gpsFixRef.current = null;
    rejoinCandidateRef.current = { count: 0, routeDistance: 0 };
    continuityCandidateRef.current = { count: 0, routeDistance: 0 };
    wasOffRouteRef.current = false;
    startAnchoredRef.current = true;
    reliableRouteFixesRef.current = 0;
    routeDistanceReliableRef.current = true;
    reachedWaypointTurnsRef.current = new Set();
    smoothedSpeedRef.current = 0;
    setCurrentSpeed(0);
    setLastGpsFixTimestamp(0);
    setRecoveryGuidance(null);
    setRouteDistanceReliable(true);
    setGpsStatus("off");
  };

  const startGps = (route: Route) => {
    if (!navigator.geolocation) {
      setGpsStatus("error");
      setGpsError("GPS unavailable");
      return;
    }
    setGpsStatus("acquiring");
    setGpsError("");
    gpsFixRef.current = null;
    rejoinCandidateRef.current = { count: 0, routeDistance: 0 };
    continuityCandidateRef.current = { count: 0, routeDistance: 0 };
    wasOffRouteRef.current = false;
    startAnchoredRef.current = true;
    reliableRouteFixesRef.current = 0;
    routeDistanceReliableRef.current = true;
    reachedWaypointTurnsRef.current = new Set();
    smoothedSpeedRef.current = 0;
    const liveTurnCalls = buildTurnCalls(route);
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const here = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        const timestamp = position.timestamp || Date.now();
        const previousFix = gpsFixRef.current;
        const elapsedSeconds = previousFix
          ? clamp((timestamp - previousFix.timestamp) / 1000, 0.1, 10)
          : 1;
        const displacement = previousFix ? haversine(previousFix, here) : 0;
        const movementNoiseFloor = Math.max(
          2.5,
          Math.min(12, position.coords.accuracy * 0.35),
        );
        const calculatedSpeed =
          previousFix && displacement > movementNoiseFloor
            ? displacement / elapsedSeconds
            : 0;
        const reportedSpeed = position.coords.speed;
        const rawSpeed =
          reportedSpeed !== null &&
          Number.isFinite(reportedSpeed) &&
          reportedSpeed > 0.25
            ? Math.max(0, reportedSpeed)
            : calculatedSpeed;
        const reliableSpeed = clamp(rawSpeed, 0, 70);
        const reportedHeading =
          position.coords.heading !== null &&
          Number.isFinite(position.coords.heading)
            ? position.coords.heading
            : undefined;
        const movementHeading =
          previousFix && displacement > movementNoiseFloor
            ? bearing(previousFix, here)
            : undefined;
        const heading = reportedHeading ?? movementHeading;
        const projection = projectPointToRoute(
          route.points,
          here,
          previousFix
            ? {
                previousDistance: previousFix.routeDistance,
                elapsedSeconds,
                speedMps: reliableSpeed,
                accuracy: position.coords.accuracy,
                heading,
              }
            : undefined,
        );
        let projectedDistance = projection.routeDistance;
        let projectedSegment = projection.segment;
        let rejoined = false;
        let progressAdjustment = "NONE";
        let distanceIsReliable = true;
        const nearestPoint = pointAtDistance(
          route.points,
          projection.nearestRouteDistance,
        );
        const recoveryBearing = bearing(here, nearestPoint);
        const guidance = recoveryFromHeading(heading, recoveryBearing);

        const rejoinRadius = Math.max(
          18,
          Math.min(35, position.coords.accuracy * 2),
        );
        const nearestHeadingFits =
          heading === undefined ||
          reliableSpeed < 2.5 ||
          headingDifference(heading, projection.nearestSegmentBearing) < 75;
        const genuinelyOffRoute =
          projection.nearestOffset > OFF_ROUTE_DISTANCE;
        const nearRouteStart =
          haversine(here, route.points[0]) <=
            Math.max(70, position.coords.accuracy * 3) &&
          projection.nearestRouteDistance <= 120;

        if (!previousFix) {
          if (nearRouteStart && reliableSpeed < 1.5) {
            projectedDistance = 0;
            projectedSegment = 0;
            progressAdjustment = "START_ANCHOR";
          } else {
            startAnchoredRef.current = false;
            projectedDistance = projection.nearestRouteDistance;
            projectedSegment = projection.nearestSegment;
          }
          wasOffRouteRef.current = genuinelyOffRoute;
        } else if (
          startAnchoredRef.current &&
          nearRouteStart &&
          reliableSpeed < 1.5 &&
          displacement <= movementNoiseFloor
        ) {
          projectedDistance = 0;
          projectedSegment = 0;
          progressAdjustment = "START_ANCHOR";
        } else {
          startAnchoredRef.current = false;

          if (genuinelyOffRoute) {
            wasOffRouteRef.current = true;
            rejoinCandidateRef.current = { count: 0, routeDistance: 0 };
            continuityCandidateRef.current = {
              count: 0,
              routeDistance: 0,
            };
            projectedDistance = previousFix.routeDistance;
            projectedSegment = previousFix.segment;
            distanceIsReliable = false;
            progressAdjustment = "OFF_ROUTE_HOLD";
          } else if (wasOffRouteRef.current) {
            const nearestIsForward =
              projection.nearestRouteDistance >=
              previousFix.routeDistance - rejoinRadius;
            if (
              projection.nearestOffset <= rejoinRadius &&
              nearestIsForward &&
              nearestHeadingFits
            ) {
              const previousCandidate = rejoinCandidateRef.current;
              const coherent =
                previousCandidate.count === 0 ||
                projection.nearestRouteDistance >=
                  previousCandidate.routeDistance - 30;
              rejoinCandidateRef.current = {
                count: coherent ? previousCandidate.count + 1 : 1,
                routeDistance: projection.nearestRouteDistance,
              };
            } else {
              rejoinCandidateRef.current = { count: 0, routeDistance: 0 };
            }

            if (rejoinCandidateRef.current.count >= 3) {
              projectedDistance = Math.max(
                previousFix.routeDistance,
                projection.nearestRouteDistance,
              );
              projectedSegment = projection.nearestSegment;
              rejoined = true;
              wasOffRouteRef.current = false;
              rejoinCandidateRef.current = { count: 0, routeDistance: 0 };
              progressAdjustment = "OFF_ROUTE_REJOIN";
            } else {
              projectedDistance = previousFix.routeDistance;
              projectedSegment = previousFix.segment;
              distanceIsReliable = false;
              progressAdjustment = "REJOIN_PENDING";
            }
          } else {
            const expectedTravel = Math.max(
              reliableSpeed * elapsedSeconds,
              displacement > movementNoiseFloor ? displacement : 0,
            );
            const allowedTravel = Math.max(
              8,
              expectedTravel * 1.6 + position.coords.accuracy * 0.75 + 4,
            );
            const nearestIsForward =
              projection.nearestRouteDistance >=
              previousFix.routeDistance - 15;
            const nearestLead =
              projection.nearestRouteDistance - previousFix.routeDistance;
            const continuityLead =
              projection.routeDistance - previousFix.routeDistance;
            const continuityLooksStuck =
              nearestIsForward &&
              nearestHeadingFits &&
              projection.nearestOffset <= rejoinRadius &&
              nearestLead > 18 &&
              continuityLead < 6;

            if (continuityLooksStuck) {
              const previousCandidate = continuityCandidateRef.current;
              const coherent =
                previousCandidate.count === 0 ||
                projection.nearestRouteDistance >=
                  previousCandidate.routeDistance - 12;
              continuityCandidateRef.current = {
                count: coherent ? previousCandidate.count + 1 : 1,
                routeDistance: projection.nearestRouteDistance,
              };
            } else {
              continuityCandidateRef.current = {
                count: 0,
                routeDistance: 0,
              };
            }

            const useNearest =
              nearestIsForward &&
              nearestHeadingFits &&
              (projection.nearestOffset + 12 < projection.offset ||
                continuityCandidateRef.current.count >= 2);
            const targetDistance = useNearest
              ? projection.nearestRouteDistance
              : projection.routeDistance;
            const targetSegment = useNearest
              ? projection.nearestSegment
              : projection.segment;
            const delta = targetDistance - previousFix.routeDistance;

            if (
              reliableSpeed < 1.2 &&
              displacement <= movementNoiseFloor
            ) {
              projectedDistance = previousFix.routeDistance;
              projectedSegment = previousFix.segment;
            } else if (delta < 0) {
              projectedDistance = previousFix.routeDistance;
              projectedSegment = previousFix.segment;
            } else if (delta > allowedTravel) {
              projectedDistance = previousFix.routeDistance + allowedTravel;
              projectedSegment = targetSegment;
              progressAdjustment = "CONTINUITY_CATCHUP";
            } else {
              projectedDistance = targetDistance;
              projectedSegment = targetSegment;
            }

            const remainingGap = Math.abs(
              projection.nearestRouteDistance - projectedDistance,
            );
            if (
              !nearestHeadingFits ||
              remainingGap > 45 ||
              (progressAdjustment === "CONTINUITY_CATCHUP" &&
                remainingGap > 25)
            ) {
              distanceIsReliable = false;
            }
          }
        }

        const protectedWaypointTurn = liveTurnCalls.find(
          (turn) =>
            turn.source === "WAYPOINT" &&
            turn.distance >= (previousFix?.routeDistance || 0) - 20 &&
            !reachedWaypointTurnsRef.current.has(turn.distance),
        );
        if (protectedWaypointTurn) {
          const protectedInstruction = route.instructions.find(
            (instruction) =>
              Math.abs(instruction.distance - protectedWaypointTurn.distance) <
              2,
          );
          if (protectedInstruction) {
            const directWaypointDistance = haversine(
              here,
              route.points[protectedInstruction.point],
            );
            if (directWaypointDistance <= 45) {
              reachedWaypointTurnsRef.current.add(
                protectedWaypointTurn.distance,
              );
            } else if (
              projectedDistance > protectedWaypointTurn.distance - 2
            ) {
              projectedDistance = Math.max(
                previousFix?.routeDistance || 0,
                protectedWaypointTurn.distance - 2,
              );
              progressAdjustment = "WAYPOINT_GUARD";
            }
          }
        }

        if (previousFix && projectedDistance < previousFix.routeDistance) {
          projectedDistance = previousFix.routeDistance;
          projectedSegment = previousFix.segment;
        }

        if (distanceIsReliable) {
          reliableRouteFixesRef.current += 1;
          if (
            routeDistanceReliableRef.current ||
            reliableRouteFixesRef.current >= 3
          ) {
            routeDistanceReliableRef.current = true;
          }
        } else {
          reliableRouteFixesRef.current = 0;
          routeDistanceReliableRef.current = false;
        }

        const smoothing = reliableSpeed < 1 ? 0.18 : 0.38;
        smoothedSpeedRef.current =
          smoothedSpeedRef.current === 0
            ? reliableSpeed
            : smoothedSpeedRef.current * (1 - smoothing) +
              reliableSpeed * smoothing;
        if (reliableSpeed < 0.5) smoothedSpeedRef.current = 0;

        const stageHasStarted = timestamp >= stageStartTimestampRef.current;
        if (
          stageHasStarted &&
          previousFix &&
          previousFix.timestamp >= stageStartTimestampRef.current &&
          position.coords.accuracy <= 30 &&
          elapsedSeconds <= 5 &&
          displacement > movementNoiseFloor &&
          displacement / elapsedSeconds < 70
        ) {
          actualDistanceRef.current += displacement;
        }
        if (stageHasStarted && position.coords.accuracy <= 30) {
          topSpeedRef.current = Math.max(
            topSpeedRef.current,
            smoothedSpeedRef.current * 3.6,
          );
        }

        const loggedTurnIndex = liveTurnCalls.findIndex(
          (turn) => turn.distance > projectedDistance - TURN_PASS_MARGIN,
        );
        const loggedTurn =
          loggedTurnIndex >= 0 ? liveTurnCalls[loggedTurnIndex] : undefined;
        const loggedFollowingTurn =
          loggedTurnIndex >= 0
            ? liveTurnCalls[loggedTurnIndex + 1]
            : undefined;
        const loggedTurnDistance = loggedTurn
          ? loggedTurn.distance - projectedDistance
          : null;
        const loggedTurnActive =
          loggedTurn !== undefined &&
          loggedTurnDistance !== null &&
          loggedTurnDistance <=
            turnLeadDistance(
              loggedTurn,
              smoothedSpeedRef.current * 3.6,
            );
        const loggedCombination =
          loggedTurnActive &&
          loggedTurn &&
          loggedFollowingTurn &&
          loggedFollowingTurn.distance - loggedTurn.distance <=
            COMBINATION_DISTANCE;
        const loggedInstruction = route.instructions.find(
          (instruction) => instruction.distance > projectedDistance + 5,
        );

        if (stageHasStarted) {
          runLogRef.current.push({
            timestamp,
            ...here,
            accuracy: position.coords.accuracy,
            reportedSpeedKph: reliableSpeed * 3.6,
            displayedSpeedKph: smoothedSpeedRef.current * 3.6,
            routeDistance: projectedDistance,
            offRouteDistance: projection.nearestOffset,
            segment: projectedSegment,
            continuityOffset: projection.offset,
            nearestRouteDistance: projection.nearestRouteDistance,
            rejoined,
            routeDistanceReliable: routeDistanceReliableRef.current,
            progressAdjustment,
            callMode: genuinelyOffRoute
              ? "RECOVERY"
              : !routeDistanceReliableRef.current
                ? "ADJUSTING"
                : loggedCombination
                  ? "COMBINATION"
                  : loggedTurnActive
                    ? "ACTIVE"
                    : "CONTINUE",
            upcomingTurn: loggedTurn
              ? `${loggedTurn.severity} ${loggedTurn.direction}`
              : "",
            upcomingTurnRouteDistance: loggedTurn?.distance ?? null,
            turnDistance: loggedTurnDistance,
            followingTurn: loggedFollowingTurn
              ? `${loggedFollowingTurn.severity} ${loggedFollowingTurn.direction}`
              : "",
            followingTurnRouteDistance:
              loggedFollowingTurn?.distance ?? null,
            followingTurnDistance: loggedFollowingTurn
              ? loggedFollowingTurn.distance - projectedDistance
              : null,
            nextInstruction: loggedInstruction?.label || "",
            instructionDistance: loggedInstruction
              ? loggedInstruction.distance - projectedDistance
              : null,
            recoveryDirection:
              projection.nearestOffset > OFF_ROUTE_DISTANCE
                ? guidance.label
                : "",
          });
          if (runLogRef.current.length > 20_000) runLogRef.current.shift();
        }

        gpsFixRef.current = {
          ...here,
          timestamp,
          routeDistance: projectedDistance,
          speedMps: reliableSpeed,
          segment: projectedSegment,
        };
        setProgress(projectedDistance);
        setOffRouteDistance(projection.nearestOffset);
        setRouteDistanceReliable(routeDistanceReliableRef.current);
        setRecoveryGuidance(guidance);
        setCurrentSpeed(smoothedSpeedRef.current * 3.6);
        setGpsAccuracy(position.coords.accuracy);
        setLastGpsFixTimestamp(timestamp);
        setGpsStatus("ready");
      },
      (error) => {
        setGpsStatus("error");
        setGpsError(error.message);
      },
      { enableHighAccuracy: true, maximumAge: 500, timeout: 15_000 },
    );
  };

  const validateSelectedSetup = () => {
    if (!selectedRoute || !selectedConfig) {
      setSetupError("Upload and select a GPX route first");
      return false;
    }
    const { start, finish } = selectedConfig.zone;
    if ((start && !finish) || (!start && finish)) {
      setSetupError("Choose both DZ and FZ, or leave both unconfigured");
      return false;
    }
    if (start && finish) {
      const dz = selectedRoute.instructions.find(
        (instruction) => instruction.id === start,
      );
      const fz = selectedRoute.instructions.find(
        (instruction) => instruction.id === finish,
      );
      if (!dz || !fz) {
        setSetupError("DZ/FZ must belong to the selected GPX");
        return false;
      }
      if (fz.distance <= dz.distance) {
        setSetupError("FZ must come after DZ on the selected GPX");
        return false;
      }
    }
    setSetupError("");
    return true;
  };

  const beginStage = (mode: "armed" | "now" | "test") => {
    if (!validateSelectedSetup() || !selectedRoute || !selectedConfig) return;

    let startTimestamp = Date.now();
    if (mode === "armed") {
      startTimestamp = new Date(selectedConfig.officialStart).getTime();
      if (!Number.isFinite(startTimestamp) || startTimestamp <= Date.now()) {
        setSetupError("Official start time must be in the future");
        setTab("setup");
        return;
      }
    }

    const configSnapshot: RouteConfig = {
      ...selectedConfig,
      zone: { ...selectedConfig.zone },
    };
    setActiveStage({
      routeId: selectedRoute.id,
      config: configSnapshot,
      startTimestamp,
      testMode: mode === "test",
    });
    setProgress(0);
    setOffRouteDistance(0);
    setRouteDistanceReliable(true);
    setRecoveryGuidance(null);
    setZoneElapsed(0);
    setZoneStartedAt(null);
    setZoneAlert(null);
    previousZoneStateRef.current = "OFF";
    if (zoneAlertTimerRef.current !== null) {
      window.clearTimeout(zoneAlertTimerRef.current);
      zoneAlertTimerRef.current = null;
    }
    setStageSummary(null);
    actualDistanceRef.current = 0;
    topSpeedRef.current = 0;
    reachedWaypointTurnsRef.current = new Set();
    stageStartTimestampRef.current = startTimestamp;
    rejoinCandidateRef.current = { count: 0, routeDistance: 0 };
    runLogRef.current = [];
    setNow(Date.now());
    setStageStatus(mode === "armed" ? "armed" : "running");
    setTab("rally");
    if (mode !== "test") startGps(selectedRoute);
  };

  const completeStage = () => {
    if (!activeStage || !activeRoute || stageStatus === "finished") return;
    const finishedAt = Date.now();
    const elapsedSeconds = Math.max(
      0,
      (finishedAt - activeStage.startTimestamp) / 1000,
    );
    const actualDistance = activeStage.testMode
      ? progress
      : actualDistanceRef.current;
    stopGps();
    setNow(finishedAt);
    setStageSummary({
      routeName: activeRoute.name,
      startedAt: activeStage.startTimestamp,
      finishedAt,
      elapsedSeconds,
      actualDistance,
      routeDistance: progress,
      averageSpeedKph:
        elapsedSeconds > 0 ? (actualDistance / elapsedSeconds) * 3.6 : 0,
      topSpeedKph: activeStage.testMode ? 0 : topSpeedRef.current,
      testMode: activeStage.testMode,
    });
    setStageStatus("finished");
    setZoneStartedAt(null);
    setZoneAlert(null);
    if (zoneAlertTimerRef.current !== null) {
      window.clearTimeout(zoneAlertTimerRef.current);
      zoneAlertTimerRef.current = null;
    }
    setEndHoldActive(false);
  };

  const resetForNewLeg = () => {
    stopGps();
    setActiveStage(null);
    setStageSummary(null);
    setStageStatus("idle");
    setProgress(0);
    setOffRouteDistance(0);
    setRouteDistanceReliable(true);
    setRecoveryGuidance(null);
    setZoneElapsed(0);
    setZoneStartedAt(null);
    setZoneAlert(null);
    previousZoneStateRef.current = "OFF";
    setTab("setup");
  };

  const beginEndHold = () => {
    if (stageStatus !== "running" || endHoldTimerRef.current !== null) return;
    setEndHoldActive(true);
    endHoldTimerRef.current = window.setTimeout(() => {
      endHoldTimerRef.current = null;
      completeStage();
    }, 1000);
  };

  const cancelEndHold = () => {
    if (endHoldTimerRef.current !== null) {
      window.clearTimeout(endHoldTimerRef.current);
      endHoldTimerRef.current = null;
    }
    setEndHoldActive(false);
  };

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const downloadRunLog = () => {
    if (!runLogRef.current.length) return;
    const header = [
      "timestamp",
      "latitude",
      "longitude",
      "accuracy_m",
      "reported_speed_kph",
      "displayed_speed_kph",
      "route_odo_km",
      "off_route_m",
      "segment",
      "continuity_offset_m",
      "nearest_route_odo_km",
      "rejoined",
      "route_distance_reliable",
      "progress_adjustment",
      "call_mode",
      "upcoming_turn",
      "upcoming_turn_route_odo_km",
      "turn_distance_m",
      "following_turn",
      "following_turn_route_odo_km",
      "following_turn_distance_m",
      "next_instruction",
      "instruction_distance_m",
      "recovery_direction",
    ].join(",");
    const rows = runLogRef.current.map((entry) =>
      [
        new Date(entry.timestamp).toISOString(),
        entry.lat.toFixed(7),
        entry.lon.toFixed(7),
        entry.accuracy.toFixed(1),
        entry.reportedSpeedKph.toFixed(1),
        entry.displayedSpeedKph.toFixed(1),
        (entry.routeDistance / 1000).toFixed(4),
        entry.offRouteDistance.toFixed(1),
        entry.segment,
        entry.continuityOffset.toFixed(1),
        (entry.nearestRouteDistance / 1000).toFixed(4),
        entry.rejoined ? "yes" : "no",
        entry.routeDistanceReliable ? "yes" : "no",
        entry.progressAdjustment,
        entry.callMode,
        entry.upcomingTurn,
        entry.upcomingTurnRouteDistance === null
          ? ""
          : (entry.upcomingTurnRouteDistance / 1000).toFixed(4),
        entry.turnDistance === null ? "" : entry.turnDistance.toFixed(1),
        entry.followingTurn,
        entry.followingTurnRouteDistance === null
          ? ""
          : (entry.followingTurnRouteDistance / 1000).toFixed(4),
        entry.followingTurnDistance === null
          ? ""
          : entry.followingTurnDistance.toFixed(1),
        `"${entry.nextInstruction.replaceAll('"', '""')}"`,
        entry.instructionDistance === null
          ? ""
          : entry.instructionDistance.toFixed(1),
        entry.recoveryDirection,
      ].join(","),
    );
    const blob = new Blob([[header, ...rows].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `XR-run-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const predictionSeconds =
    stageStatus === "running" &&
    !activeStage?.testMode &&
    gpsStatus === "ready" &&
    routeDistanceReliable &&
    offRouteDistance <= OFF_ROUTE_DISTANCE &&
    lastGpsFixTimestamp > 0
      ? clamp(
          (now - lastGpsFixTimestamp) / 1000,
          0,
          GPS_PREDICTION_LIMIT_SECONDS,
        )
      : 0;
  const predictedProgress =
    progress + (currentSpeed / 3.6) * predictionSeconds;
  const protectedWaypointAhead = activeTurnCalls.find(
    (turn) =>
      turn.source === "WAYPOINT" &&
      turn.distance >= progress - 2 &&
      !reachedWaypointTurnsRef.current.has(turn.distance),
  );
  const responsiveProgress = protectedWaypointAhead
    ? Math.min(predictedProgress, protectedWaypointAhead.distance - 1)
    : predictedProgress;
  const routeDistance = activeRoute
    ? clamp(
        responsiveProgress,
        0,
        activeRoute.points.at(-1)!.distance,
      )
    : 0;
  const stageElapsed = activeStage
    ? Math.max(0, (now - activeStage.startTimestamp) / 1000)
    : 0;
  const nextTurnIndex = activeTurnCalls.findIndex(
    (turn) => turn.distance > routeDistance - TURN_PASS_MARGIN,
  );
  const upcomingTurn =
    nextTurnIndex >= 0 ? activeTurnCalls[nextTurnIndex] : undefined;
  const followingTurn =
    nextTurnIndex >= 0 ? activeTurnCalls[nextTurnIndex + 1] : undefined;
  const distanceToUpcomingTurn = upcomingTurn
    ? upcomingTurn.distance - routeDistance
    : null;
  const upcomingTurnActive =
    upcomingTurn !== undefined &&
    distanceToUpcomingTurn !== null &&
    distanceToUpcomingTurn <=
      turnLeadDistance(upcomingTurn, currentSpeed);
  const closeCombination =
    upcomingTurnActive &&
    upcomingTurn !== undefined &&
    followingTurn !== undefined &&
    followingTurn.distance - upcomingTurn.distance <=
      COMBINATION_DISTANCE;
  const secondaryTurn = upcomingTurnActive ? followingTurn : upcomingTurn;
  const secondaryTurnDistance = secondaryTurn
    ? upcomingTurnActive && upcomingTurn
      ? secondaryTurn.distance - upcomingTurn.distance
      : secondaryTurn.distance - routeDistance
    : null;
  const currentInstructionIndex = activeRoute
    ? Math.max(
        0,
        activeRoute.instructions.findLastIndex(
          (instruction) => instruction.distance <= routeDistance,
        ),
      )
    : 0;
  const currentInstruction =
    activeRoute?.instructions[currentInstructionIndex];
  const nextInstruction =
    activeRoute?.instructions[currentInstructionIndex + 1];
  const isOffRoute =
    !activeStage?.testMode && offRouteDistance > OFF_ROUTE_DISTANCE;
  const routePositionReliable =
    Boolean(activeStage?.testMode) ||
    (!isOffRoute && routeDistanceReliable);

  const activeZone = activeConfig?.zone;
  const zoneStart = activeRoute?.instructions.find(
    (instruction) => instruction.id === activeZone?.start,
  )?.distance;
  const zoneFinish = activeRoute?.instructions.find(
    (instruction) => instruction.id === activeZone?.finish,
  )?.distance;
  const zoneReady =
    zoneStart !== undefined &&
    zoneFinish !== undefined &&
    zoneFinish > zoneStart;
  const zoneDistance = activeZone?.officialDistance
    ? activeZone.officialDistance * 1000
    : zoneReady
      ? zoneFinish - zoneStart
      : 0;
  const zoneTarget = activeZone
    ? zoneDistance / (activeZone.speed / 3.6)
    : 0;
  const zoneState = !zoneReady
    ? "OFF"
    : routeDistance < zoneStart
      ? "ARMED"
      : routeDistance >= zoneFinish
        ? "COMPLETE"
        : "ACTIVE";

  useEffect(() => {
    if (
      stageStatus !== "running" ||
      activeStage?.testMode ||
      !zoneReady
    ) {
      return;
    }
    if (zoneState === "ARMED") {
      setZoneStartedAt(null);
      setZoneElapsed(0);
    } else if (zoneState === "ACTIVE" && zoneStartedAt === null) {
      setZoneStartedAt(Date.now());
    } else if (zoneState === "COMPLETE" && zoneStartedAt !== null) {
      setZoneElapsed((Date.now() - zoneStartedAt) / 1000);
      setZoneStartedAt(null);
    }
  }, [
    stageStatus,
    activeStage,
    zoneReady,
    zoneState,
    zoneStartedAt,
  ]);

  useEffect(() => {
    const previousZoneState = previousZoneStateRef.current;
    previousZoneStateRef.current = zoneState;
    if (stageStatus !== "running" || !zoneReady) return;

    const showZoneAlert = (alert: Exclude<ZoneAlert, null>) => {
      if (zoneAlertTimerRef.current !== null) {
        window.clearTimeout(zoneAlertTimerRef.current);
      }
      setZoneAlert(alert);
      if ("vibrate" in navigator) {
        navigator.vibrate(
          alert === "DZ" ? [220, 100, 220] : [450, 140, 450],
        );
      }
      zoneAlertTimerRef.current = window.setTimeout(() => {
        setZoneAlert(null);
        zoneAlertTimerRef.current = null;
      }, 2600);
    };

    if (zoneState === "ACTIVE" && previousZoneState !== "ACTIVE") {
      showZoneAlert("DZ");
    } else if (
      zoneState === "COMPLETE" &&
      previousZoneState === "ACTIVE"
    ) {
      showZoneAlert("FZ");
    }
  }, [stageStatus, zoneReady, zoneState]);

  useEffect(() => {
    if (
      stageStatus !== "running" ||
      activeStage?.testMode ||
      zoneState !== "ACTIVE" ||
      zoneStartedAt === null
    ) {
      return;
    }
    const timer = window.setInterval(
      () => setZoneElapsed((Date.now() - zoneStartedAt) / 1000),
      200,
    );
    return () => window.clearInterval(timer);
  }, [stageStatus, activeStage, zoneState, zoneStartedAt]);

  const displayedZoneElapsed =
    activeStage?.testMode && zoneState === "ACTIVE"
      ? (routeDistance - zoneStart!) / ((activeZone?.speed || 1) / 3.6)
      : activeStage?.testMode && zoneState === "COMPLETE"
        ? zoneTarget
        : zoneElapsed;
  const showZone =
    zoneState === "ACTIVE" ||
    (zoneState === "ARMED" &&
      zoneStart !== undefined &&
      zoneStart - routeDistance <= 500) ||
    (zoneState === "COMPLETE" &&
      zoneFinish !== undefined &&
      routeDistance - zoneFinish < 100);
  const zoneDistanceRemaining =
    zoneState === "ARMED" && zoneStart !== undefined
      ? zoneStart - routeDistance
      : zoneState === "ACTIVE" && zoneFinish !== undefined
        ? zoneFinish - routeDistance
        : 0;
  const zoneSpeedExceeded =
    zoneState === "ACTIVE" &&
    currentSpeed > (activeZone?.speed || Infinity) + 1;

  const turnArrow = upcomingTurn && upcomingTurnActive
    ? upcomingTurn.severity === "HAIRPIN"
      ? upcomingTurn.direction === "LEFT"
        ? "↶"
        : "↷"
      : upcomingTurn.direction === "LEFT"
        ? "↰"
        : "↱"
    : "↑";

  const jumpInstruction = (direction: number) => {
    if (!activeRoute || !activeRoute.instructions.length) return;
    const targetIndex = Math.max(
      0,
      Math.min(
        activeRoute.instructions.length - 1,
        currentInstructionIndex + direction,
      ),
    );
    setProgress(activeRoute.instructions[targetIndex].distance);
  };

  const selectedZoneStart = selectedRoute?.instructions.find(
    (instruction) => instruction.id === selectedConfig?.zone.start,
  );
  const selectedZoneFinish = selectedRoute?.instructions.find(
    (instruction) => instruction.id === selectedConfig?.zone.finish,
  );
  const selectedZoneValid =
    selectedZoneStart &&
    selectedZoneFinish &&
    selectedZoneFinish.distance > selectedZoneStart.distance;
  const selectedZoneDistance = selectedConfig?.zone.officialDistance
    ? selectedConfig.zone.officialDistance * 1000
    : selectedZoneValid
      ? selectedZoneFinish.distance - selectedZoneStart.distance
      : 0;
  const selectedZoneTarget =
    selectedConfig && selectedZoneDistance
      ? selectedZoneDistance / (selectedConfig.zone.speed / 3.6)
      : 0;

  const gpsLabel =
    gpsStatus === "ready"
      ? `GPS ±${Math.round(gpsAccuracy || 0)}m`
      : gpsStatus === "acquiring"
        ? "GPS …"
        : gpsStatus === "error"
          ? "GPS ERROR"
          : "GPS OFF";

  return (
    <main className={`app-shell ${stageActive ? "stage-active" : ""}`}>
      <header className="topbar">
        <div className="app-brand">
          <span>EXTREME RALLY V0.9</span>
          <h1>RALLY NAVIGATOR</h1>
        </div>
        <div className="header-actions">
          <button
            className="install-pill"
            disabled={!installPrompt}
            onClick={installApp}
          >
            {installPrompt ? "INSTALL" : "PWA"}
          </button>
          <div className={`gps-pill ${gpsStatus}`}>{gpsLabel}</div>
        </div>
      </header>

      <nav className="nav-tabs" aria-label="Main screens">
        {(["setup", "rally", "controls"] as Tab[]).map((item) => (
          <button
            key={item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item.toUpperCase()}
          </button>
        ))}
      </nav>

      <input
        ref={fileRef}
        hidden
        type="file"
        accept=".gpx"
        multiple
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          void load(event.target.files);
          event.target.value = "";
        }}
      />

      <section className="screen">
        {tab === "setup" && (
          <div className="screen-stack">
            {setupLocked && (
              <div className="locked-banner">
                STAGE ACTIVE · Setup is frozen until the session ends
              </div>
            )}

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span>ROUTE</span>
                  <h2>Stage GPX</h2>
                </div>
                <div className="panel-actions">
                  <button
                    className="small-action remove-route-action"
                    disabled={!selectedRoute || setupLocked}
                    onClick={removeSelectedRoute}
                  >
                    REMOVE
                  </button>
                  <button
                    className="small-action"
                    disabled={setupLocked}
                    onClick={() => fileRef.current?.click()}
                  >
                    + UPLOAD GPX
                  </button>
                </div>
              </div>

              {!selectedRoute ? (
                <div className="inline-empty">
                  <strong>No route loaded</strong>
                  <p>Upload one or more organiser GPX files to begin.</p>
                </div>
              ) : (
                <>
                  {routes.length > 1 && (
                    <label className="field">
                      CHOSEN GPX
                      <select
                        disabled={setupLocked}
                        value={selectedRoute.id}
                        onChange={(event) => {
                          setSelectedRouteId(event.target.value);
                          setSetupError("");
                        }}
                      >
                        {routes.map((route) => (
                          <option key={route.id} value={route.id}>
                            {route.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <div className="route-name">{selectedRoute.name}</div>
                  <div className="metric-row">
                    <div>
                      <span>DISTANCE</span>
                      <strong>
                        {formatDistance(
                          selectedRoute.points.at(-1)!.distance,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>INSTRUCTIONS</span>
                      <strong>{selectedRoute.instructions.length}</strong>
                    </div>
                    <div>
                      <span>TURN CALLS</span>
                      <strong>{selectedTurnCalls.length}</strong>
                    </div>
                  </div>

                  <div className="route-preview">
                    <RoutePreview route={selectedRoute} />
                  </div>
                  <p className="helper-copy">
                    Route preview for verification only. It is not shown while
                    the stage is running.
                  </p>
                </>
              )}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span>START</span>
                  <h2>Official start time</h2>
                </div>
              </div>

              <label className="field">
                DATE AND TIME
                <input
                  disabled={!selectedConfig || setupLocked}
                  type="datetime-local"
                  step="1"
                  value={selectedConfig?.officialStart || ""}
                  onChange={(event) =>
                    updateSelectedConfig((current) => ({
                      ...current,
                      officialStart: event.target.value,
                    }))
                  }
                />
              </label>

              <div className="two-actions">
                <button
                  className="primary-action"
                  disabled={!selectedRoute || setupLocked}
                  onClick={() => beginStage("armed")}
                >
                  ARM START
                </button>
                <button
                  className="secondary-action"
                  disabled={!selectedRoute || setupLocked}
                  onClick={() => beginStage("now")}
                >
                  START NOW
                </button>
              </div>
              <p className="helper-copy left">
                Arm acquires GPS immediately, counts down to the official time
                and starts automatically at zero.
              </p>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span>SPEED ZONES</span>
                  <h2>DZ / FZ calibration</h2>
                </div>
                <em>OPTIONAL</em>
              </div>

              {!selectedRoute?.instructions.length ? (
                <div className="inline-empty compact">
                  <strong>No instruction waypoints</strong>
                  <p>DZ/FZ cannot be placed on this GPX.</p>
                </div>
              ) : (
                <>
                  <div className="field-grid">
                    <label className="field">
                      DZ INSTRUCTION
                      <select
                        disabled={!selectedConfig || setupLocked}
                        value={selectedConfig?.zone.start || ""}
                        onChange={(event) =>
                          updateSelectedConfig((current) => ({
                            ...current,
                            zone: {
                              ...current.zone,
                              start: event.target.value,
                            },
                          }))
                        }
                      >
                        <option value="">Not configured</option>
                        {selectedRoute.instructions.map((instruction) => (
                          <option key={instruction.id} value={instruction.id}>
                            {shortInstruction(instruction.label)}
                            {usefulNote(instruction)
                              ? ` · ${usefulNote(instruction)}`
                              : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      FZ INSTRUCTION
                      <select
                        disabled={!selectedConfig || setupLocked}
                        value={selectedConfig?.zone.finish || ""}
                        onChange={(event) =>
                          updateSelectedConfig((current) => ({
                            ...current,
                            zone: {
                              ...current.zone,
                              finish: event.target.value,
                            },
                          }))
                        }
                      >
                        <option value="">Not configured</option>
                        {selectedRoute.instructions.map((instruction) => (
                          <option key={instruction.id} value={instruction.id}>
                            {shortInstruction(instruction.label)}
                            {usefulNote(instruction)
                              ? ` · ${usefulNote(instruction)}`
                              : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      SPEED LIMIT (KM/H)
                      <input
                        disabled={!selectedConfig || setupLocked}
                        type="number"
                        min="1"
                        value={selectedConfig?.zone.speed || 30}
                        onChange={(event) =>
                          updateSelectedConfig((current) => ({
                            ...current,
                            zone: {
                              ...current.zone,
                              speed: Number(event.target.value) || 1,
                            },
                          }))
                        }
                      />
                    </label>
                    <label className="field">
                      OFFICIAL DISTANCE (KM)
                      <input
                        disabled={!selectedConfig || setupLocked}
                        type="number"
                        step="0.01"
                        placeholder="Optional"
                        value={selectedConfig?.zone.officialDistance || ""}
                        onChange={(event) =>
                          updateSelectedConfig((current) => ({
                            ...current,
                            zone: {
                              ...current.zone,
                              officialDistance:
                                Number(event.target.value) || undefined,
                            },
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div
                    className={`zone-summary ${
                      selectedZoneValid ? "valid" : ""
                    }`}
                  >
                    {selectedZoneValid
                      ? `GPX: ${selectedRoute.name} · DZ ${shortInstruction(
                          selectedZoneStart.label,
                        )} → FZ ${shortInstruction(
                          selectedZoneFinish.label,
                        )} · TARGET ${formatDuration(selectedZoneTarget)}`
                      : "No complete speed zone configured for this GPX."}
                  </div>
                </>
              )}
            </section>

            {setupError && <div className="error-banner">{setupError}</div>}
          </div>
        )}

        {tab === "rally" && (
          <div className="screen-stack">
            {stageStatus === "idle" && (
              <section className="empty-card">
                <span>RALLY NAVIGATOR READY</span>
                <h2>Complete Setup, then arm the official start.</h2>
                <p>
                  During the stage this screen shows the upcoming turn,
                  distance, following call and roadbook reference.
                </p>
                <button
                  className="primary-action full-action"
                  onClick={() => setTab("setup")}
                >
                  GO TO SETUP
                </button>
              </section>
            )}

            {stageStatus === "armed" && activeStage && activeRoute && (
              <>
                {(wakeStatus === "unsupported" ||
                  wakeStatus === "blocked") && (
                  <div className="error-banner">
                    SCREEN STAY-AWAKE FAILED · Disable battery restriction for
                    this app
                  </div>
                )}
                <section className="panel countdown-card">
                  <span>OFFICIAL START</span>
                  <h2>
                    {new Date(activeStage.startTimestamp).toLocaleTimeString(
                      [],
                      { hour12: false },
                    )}
                  </h2>
                  <strong>
                    {formatCountdown(activeStage.startTimestamp - now)}
                  </strong>
                  <p>Stage starts automatically at zero</p>
                </section>
                <section className="status-card">
                  <i className={gpsStatus} />
                  <div>
                    <strong>{gpsLabel}</strong>
                    <span>
                      {gpsStatus === "ready"
                        ? "Position locked. Ready for the countdown."
                        : gpsError || "Acquiring an accurate GPS position…"}
                    </span>
                  </div>
                </section>
                <section className="next-card preview-call">
                  <span>FIRST GENERATED CALL</span>
                  <strong>
                    {activeTurnCalls[0]
                      ? `${activeTurnCalls[0].severity} ${activeTurnCalls[0].direction}`
                      : "NO RELIABLE TURN FOUND"}
                  </strong>
                  <b>
                    {activeTurnCalls[0]
                      ? formatDistance(activeTurnCalls[0].distance)
                      : "—"}
                  </b>
                </section>
              </>
            )}

            {stageStatus === "running" &&
              activeStage &&
              activeRoute && (
                <>
                  {isOffRoute && (
                    <div className="off-route-banner">
                      OFF ROUTE · {formatDistance(offRouteDistance)}
                    </div>
                  )}

                  {!activeStage.testMode &&
                    (wakeStatus === "unsupported" ||
                      wakeStatus === "blocked") && (
                      <div className="error-banner">
                        SCREEN STAY-AWAKE FAILED · Disable battery restriction
                        for this app
                      </div>
                    )}

                  {zoneAlert && activeZone && (
                    <div className={`zone-alert-overlay ${zoneAlert.toLowerCase()}`}>
                      <span>SPEED ZONE</span>
                      <strong>{zoneAlert}</strong>
                      <b>
                        {zoneAlert === "DZ"
                          ? `${activeZone.speed} km/h LIMIT`
                          : `ZONE ${formatDuration(displayedZoneElapsed)}`}
                      </b>
                    </div>
                  )}

                  <section className="drive-readout">
                    <div>
                      <span>ROUTE ODO</span>
                      <strong>{(routeDistance / 1000).toFixed(2)}</strong>
                      <small>km</small>
                      <div className="readout-meta">
                        <span>STAGE TIME</span>
                        <b>{formatDuration(stageElapsed)}</b>
                      </div>
                    </div>
                    <div>
                      <span>SPEED</span>
                      <strong>
                        {activeStage.testMode
                          ? "SIM"
                          : Math.round(currentSpeed)}
                      </strong>
                      <small>{activeStage.testMode ? "" : "km/h"}</small>
                      <div className="readout-meta">
                        <span>GPS ACCURACY</span>
                        <b>
                          {activeStage.testMode
                            ? "SIM"
                            : gpsStatus === "ready"
                              ? `±${Math.round(gpsAccuracy || 0)}m`
                              : "—"}
                        </b>
                      </div>
                    </div>
                  </section>

                  {showZone && activeZone && (
                    <section
                      className={`speed-zone-card ${zoneState.toLowerCase()} ${
                        zoneSpeedExceeded ? "over-limit" : ""
                      }`}
                    >
                      <div className="zone-state">
                        <span>SPEED ZONE</span>
                        <strong>
                          {zoneState === "ARMED"
                            ? `DZ IN ${formatDistance(zoneDistanceRemaining)}`
                            : zoneState === "ACTIVE"
                              ? "DZ ACTIVE"
                              : "FZ COMPLETE"}
                        </strong>
                      </div>
                      <div className="zone-limit">
                        <span>LIMIT</span>
                        <strong>{activeZone.speed}</strong>
                        <small>km/h</small>
                      </div>
                      <div className="zone-clock">
                        <span>
                          {zoneState === "ACTIVE" ? "ZONE TIMER" : "TARGET"}
                        </span>
                        <strong>
                          {formatDuration(displayedZoneElapsed)}
                          {zoneState === "ACTIVE" && (
                            <small> / {formatDuration(zoneTarget)}</small>
                          )}
                        </strong>
                        {zoneState === "ACTIVE" && (
                          <b>{formatDistance(zoneDistanceRemaining)} TO FZ</b>
                        )}
                      </div>
                    </section>
                  )}

                  <section
                    className={`turn-card ${
                      isOffRoute
                        ? "unreliable"
                        : !routePositionReliable
                          ? "adjusting"
                          : !upcomingTurnActive
                            ? "waiting"
                            : ""
                    } ${closeCombination ? "combination" : ""}`}
                  >
                    <span>
                      {isOffRoute
                        ? "RECOVERY"
                        : !routePositionReliable
                          ? "UPCOMING TURN · DISTANCE ADJUSTING"
                          : upcomingTurnActive
                            ? closeCombination
                              ? "UPCOMING COMBINATION"
                              : "UPCOMING TURN"
                            : "ROUTE AHEAD"}
                    </span>
                    <div className="turn-arrow">
                      {isOffRoute
                        ? recoveryGuidance?.arrow || "◎"
                        : turnArrow}
                    </div>
                    <h2>
                      {isOffRoute
                        ? recoveryGuidance?.label || "DIRECTION ACQUIRING"
                        : upcomingTurnActive && upcomingTurn
                          ? `${upcomingTurn.severity} ${upcomingTurn.direction}`
                          : upcomingTurn
                            ? "CONTINUE"
                            : "NO SIGNIFICANT TURN"}
                    </h2>
                    <strong>
                      {isOffRoute
                        ? `${formatDistance(offRouteDistance)} TO GPX`
                        : !routePositionReliable
                          ? "ADJUSTING"
                          : distanceToUpcomingTurn !== null
                            ? formatDistance(distanceToUpcomingTurn)
                          : "—"}
                    </strong>
                    {isOffRoute && (
                      <small className="recovery-note">
                        STRAIGHT-LINE BEARING · CHOOSE A SAFE RECOVERY PATH
                      </small>
                    )}
                    {!isOffRoute && !routePositionReliable && (
                      <small className="recovery-note">
                        TURN REMAINS ACTIVE · DISTANCE TEMPORARILY UNRELIABLE
                      </small>
                    )}
                    {!isOffRoute &&
                      routePositionReliable &&
                      !upcomingTurnActive &&
                      upcomingTurn && (
                        <small className="call-ahead-note">
                          {upcomingTurn.severity} {upcomingTurn.direction} AHEAD
                        </small>
                      )}
                  </section>

                  <section
                    className={`next-card ${
                      closeCombination ? "combination-call" : ""
                    }`}
                  >
                    <span>
                      {upcomingTurnActive
                        ? closeCombination
                          ? "THEN · COMBINATION"
                          : "THEN"
                        : "NEXT CALL"}
                    </span>
                    <strong>
                      {secondaryTurn
                        ? `${secondaryTurn.severity} ${secondaryTurn.direction}`
                        : "NO FOLLOWING CALL"}
                    </strong>
                    <b>
                      {secondaryTurnDistance !== null
                        ? `${upcomingTurnActive ? "+" : ""}${formatDistance(
                            secondaryTurnDistance,
                          )}`
                        : "—"}
                    </b>
                  </section>

                  {nextInstruction && (
                    <section className="roadbook-card">
                      <span>ROADBOOK</span>
                      <strong>
                        {shortInstruction(nextInstruction.label)}
                      </strong>
                      <p>
                        {usefulNote(nextInstruction) ||
                          "Use physical roadbook"}
                      </p>
                      <b>
                        {routePositionReliable
                          ? formatDistance(
                              nextInstruction.distance - routeDistance,
                            )
                          : "UNRELIABLE"}
                      </b>
                    </section>
                  )}

                  <button
                    className={`hold-end-action ${
                      endHoldActive ? "holding" : ""
                    }`}
                    onPointerDown={beginEndHold}
                    onPointerUp={cancelEndHold}
                    onPointerLeave={cancelEndHold}
                    onPointerCancel={cancelEndHold}
                    onContextMenu={(event) => event.preventDefault()}
                  >
                    <span>
                      {endHoldActive
                        ? "KEEP HOLDING…"
                        : "HOLD TO END STAGE"}
                    </span>
                  </button>
                </>
              )}

            {stageStatus === "finished" && stageSummary && (
              <section className="stage-summary-card">
                <span>STAGE COMPLETE</span>
                <h2>{stageSummary.routeName}</h2>
                <div className="summary-hero">
                  <small>STAGE TIME</small>
                  <strong>{formatDuration(stageSummary.elapsedSeconds)}</strong>
                </div>
                <div className="summary-grid">
                  <div>
                    <span>ACTUAL DISTANCE</span>
                    <strong>
                      {(stageSummary.actualDistance / 1000).toFixed(2)}
                    </strong>
                    <small>km</small>
                  </div>
                  <div>
                    <span>AVERAGE SPEED</span>
                    <strong>{stageSummary.averageSpeedKph.toFixed(1)}</strong>
                    <small>km/h</small>
                  </div>
                  <div>
                    <span>TOP SPEED</span>
                    <strong>
                      {stageSummary.testMode
                        ? "—"
                        : Math.round(stageSummary.topSpeedKph)}
                    </strong>
                    <small>{stageSummary.testMode ? "SIM" : "km/h"}</small>
                  </div>
                  <div>
                    <span>ROUTE ODO</span>
                    <strong>
                      {(stageSummary.routeDistance / 1000).toFixed(2)}
                    </strong>
                    <small>km</small>
                  </div>
                </div>
                <p>
                  {new Date(stageSummary.startedAt).toLocaleTimeString([], {
                    hour12: false,
                  })}
                  {" → "}
                  {new Date(stageSummary.finishedAt).toLocaleTimeString([], {
                    hour12: false,
                  })}
                </p>
                <div className="summary-actions">
                  <button
                    className="full-secondary"
                    disabled={!runLogRef.current.length}
                    onClick={downloadRunLog}
                  >
                    DOWNLOAD RUN LOG
                  </button>
                  <button className="primary-action" onClick={resetForNewLeg}>
                    NEW LEG
                  </button>
                </div>
              </section>
            )}
          </div>
        )}

        {tab === "controls" && (
          <div className="screen-stack">
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span>TESTING</span>
                  <h2>Test without driving</h2>
                </div>
              </div>
              <p className="body-copy">
                Simulate the chosen GPX through the same turn-call screen used
                during a live stage.
              </p>
              <button
                className="full-secondary"
                disabled={!selectedRoute || setupLocked}
                onClick={() => beginStage("test")}
              >
                TEST CHOSEN GPX
              </button>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span>CORRECTION</span>
                  <h2>Roadbook position</h2>
                </div>
              </div>
              {activeRoute ? (
                <>
                  <div className="control-readout">
                    <div>
                      <span>CURRENT</span>
                      <strong>
                        {currentInstruction
                          ? shortInstruction(currentInstruction.label)
                          : "—"}
                      </strong>
                    </div>
                    <div>
                      <span>NEXT</span>
                      <strong>
                        {nextInstruction
                          ? shortInstruction(nextInstruction.label)
                          : "FINISH"}
                      </strong>
                    </div>
                  </div>
                  <div className="two-actions">
                    <button
                      className="secondary-action"
                      disabled={stageStatus !== "running"}
                      onClick={() => jumpInstruction(-1)}
                    >
                      ← PREVIOUS
                    </button>
                    <button
                      className="secondary-action"
                      disabled={stageStatus !== "running"}
                      onClick={() => jumpInstruction(1)}
                    >
                      NEXT →
                    </button>
                  </div>
                </>
              ) : (
                <div className="inline-empty compact">
                  <strong>No active stage</strong>
                  <p>Manual correction becomes available after starting.</p>
                </div>
              )}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span>POSITION</span>
                  <h2>GPS and recovery</h2>
                </div>
              </div>
              <div className="control-readout">
                <div>
                  <span>GPS</span>
                  <strong>{gpsLabel}</strong>
                </div>
                <div>
                  <span>OFF ROUTE</span>
                  <strong>
                    {activeRoute
                      ? formatDistance(offRouteDistance)
                      : "—"}
                  </strong>
                </div>
              </div>
              {gpsError && <div className="error-banner">{gpsError}</div>}
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span>DIAGNOSTICS</span>
                  <h2>Last live run</h2>
                </div>
              </div>
              <p className="body-copy">
                Export this with the tested GPX if a distance or turn call is
                wrong. Nothing is uploaded automatically.
              </p>
              <button
                className="full-secondary"
                disabled={
                  (stageStatus === "armed" || stageStatus === "running") ||
                  !runLogRef.current.length
                }
                onClick={downloadRunLog}
              >
                DOWNLOAD RUN LOG
              </button>
            </section>

            <section className="panel">
              <div className="panel-heading">
                <div>
                  <span>SESSION</span>
                  <h2>Stage control</h2>
                </div>
              </div>
              <button
                className="danger-action"
                disabled={stageStatus === "idle" || stageStatus === "running"}
                onClick={resetForNewLeg}
              >
                {stageStatus === "finished"
                  ? "NEW LEG"
                  : stageStatus === "armed"
                    ? "CANCEL ARMED START"
                    : "END STAGE FROM RALLY TAB"}
              </button>
            </section>
          </div>
        )}
      </section>

      <footer>
        GENERATED CALLS ARE ROUTE PREVIEWS. THE ORGANISER ROADBOOK AND SAFETY
        INSTRUCTIONS REMAIN AUTHORITATIVE.
      </footer>
    </main>
  );
}
