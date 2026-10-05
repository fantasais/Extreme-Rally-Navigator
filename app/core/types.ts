export type Point = {
  lat: number;
  lon: number;
  ele?: number;
  distance: number;
};

export type InstructionKind =
  | "ROADBOOK"
  | "START"
  | "FINISH"
  | "STOP"
  | "DZ"
  | "FZ";

export type Instruction = {
  id: string;
  number: string;
  label: string;
  note: string;
  routeDistance: number;
  kind: InstructionKind;
  heading?: number;
};

export type RouteQuality = {
  pointCount: number;
  instructionCount: number;
  totalDistance: number;
  medianGap: number;
  p95Gap: number;
  maximumGap: number;
  gapsOver140m: number;
  lowConfidenceDistance: number;
};

export type RouteRecord = {
  id: string;
  contentHash: string;
  name: string;
  direction: "FORWARD" | "REVERSE";
  sourceRouteId?: string;
  importedAt: number;
  points: Point[];
  instructions: Instruction[];
  quality: RouteQuality;
};

export type MarkerMode = "ROUTE_KM" | "STAGE_KM" | "INSTRUCTION";

export type PositionMarker = {
  mode: MarkerMode;
  value: number | string;
};

export type ZoneDefinition = {
  id: string;
  name: string;
  start: PositionMarker;
  finish: PositionMarker;
  speedLimitKph: number;
  officialDistanceKm?: number;
};

export type StageProfile = {
  id: string;
  name: string;
  officialStart: string;
  startRouteKm: number;
  finishRouteKm?: number;
  startOdoKm: number;
  startInstructionId?: string;
  zones: ZoneDefinition[];
};

export type RouteConfig = {
  routeId: string;
  selectedStageId: string;
  stages: StageProfile[];
};

export type TurnCall = {
  id: string;
  distance: number;
  passDistance: number;
  direction: "LEFT" | "RIGHT";
  severity: "GENTLE" | "MEDIUM" | "SHARP" | "HAIRPIN";
  angle: number;
  source: "TRACK" | "WAYPOINT" | "SPARSE_VERTEX";
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

export type RawFix = {
  timestamp: number;
  receivedAt: number;
  lat: number;
  lon: number;
  accuracy: number;
  speedMps: number;
  heading?: number;
};

export type MatchStatus =
  | "ACQUIRING"
  | "MATCHED"
  | "UNCERTAIN"
  | "OFF_ROUTE"
  | "REJOIN_CONFIRMATION"
  | "GPS_STALE";

export type MatchResult = {
  status: MatchStatus;
  routeDistance: number;
  segment: number;
  offset: number;
  nearestRouteDistance: number;
  nearestSegment: number;
  nearestOffset: number;
  reliable: boolean;
  ambiguous: boolean;
  rejoinDistance?: number;
  recoveryBearing?: number;
  reason: string;
};

export type MatcherSnapshot = {
  routeDistance: number;
  segment: number;
  status: MatchStatus;
  lastFix?: RawFix;
  departureCount: number;
  recoveryCount: number;
  rejoinCount: number;
  rejoinCandidateDistance?: number;
};

export type EventKind = "TURN" | "INSTRUCTION" | "DZ" | "FZ";
export type EventState = "BEFORE_START" | "UPCOMING" | "PASSED" | "MISSED";

export type NavigationEvent = {
  id: string;
  kind: EventKind;
  distance: number;
  passDistance: number;
  leadDistance: number;
  label: string;
  zoneId?: string;
};

export type NavigationEventProgress = {
  state: EventState;
  at?: number;
  reason?: string;
};

export type NavigationState = {
  events: Record<string, NavigationEventProgress>;
  lastReliableDistance?: number;
  instructionCursor: number;
  initialised: boolean;
  transitions: string[];
};

export type RunStatus = "RUNNING" | "FINISHED" | "RECOVERED";

export type RunMetadata = {
  id: string;
  routeId: string;
  routeName: string;
  routeHash: string;
  stageId: string;
  stageName: string;
  appVersion: string;
  buildId: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  configuration: StageProfile;
  summary?: RunSummary;
};

export type RunSummary = {
  elapsedSeconds: number;
  actualDistanceM: number;
  routeDistanceM: number;
  averageSpeedKph: number;
  topSpeedKph: number;
};

export type RunLogEntry = {
  runId: string;
  sequence: number;
  timestamp: number;
  receivedAt: number;
  latitude: number;
  longitude: number;
  accuracyM: number;
  rawSpeedKph: number;
  displaySpeedKph: number;
  headingDeg?: number;
  matchStatus: MatchStatus;
  matchReason: string;
  routeDistanceM: number;
  stageOdoM: number;
  actualDistanceM: number;
  offRouteM: number;
  segment: number;
  nearestRouteDistanceM: number;
  routeReliable: boolean;
  routeAmbiguous: boolean;
  upcomingTurnId?: string;
  upcomingTurnLabel?: string;
  upcomingTurnDistanceM?: number;
  upcomingTurnSource?: string;
  upcomingTurnConfidence?: string;
  nextInstructionId?: string;
  nextInstructionLabel?: string;
  nextInstructionDistanceM?: number;
  activeZoneId?: string;
  activeZoneState?: string;
  zoneElapsedS?: number;
  zoneDistanceRemainingM?: number;
  eventTransitions: string;
  pageVisibility: string;
  wakeLockState: string;
};

export type StoredRunFix = RunLogEntry & { id?: number };

