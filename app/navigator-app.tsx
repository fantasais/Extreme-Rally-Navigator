"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  advanceNavigation,
  buildNavigationEvents,
  eventFinished,
  initialiseNavigation,
  resolveZones,
  seekNavigation,
  setInstructionCursor,
  stageInstructions,
  zoneEvidence,
  type ResolvedZone,
} from "./core/events";
import { bearing, clamp, haversine, headingDifference, pointAtDistance } from "./core/geo";
import {
  addEmptyZone,
  defaultConfig,
  defaultStage,
  localDateTime,
  markerRouteDistance,
  parseGpx,
  reverseRoute,
} from "./core/gpx";
import { RouteMatcher } from "./core/matcher";
import {
  appendRunFix,
  createRun,
  deleteRoute,
  getRunFixes,
  listRuns,
  loadRoutesAndConfigs,
  markInterruptedRunsRecovered,
  migrateLegacyStorage,
  removeRun,
  saveConfig,
  saveRouteAndConfig,
  updateRun,
} from "./core/storage";
import { buildTurnCalls, turnLeadDistance } from "./core/turns";
import type {
  Instruction,
  MatchResult,
  NavigationEvent,
  NavigationState,
  RawFix,
  RouteConfig,
  RouteRecord,
  RunLogEntry,
  RunMetadata,
  RunSummary,
  StageProfile,
  TurnCall,
  ZoneDefinition,
} from "./core/types";

const APP_VERSION = "1.0.5";
const BUILD_ID = "2026.10.06.4";
const SELECTED_ROUTE_KEY = "xr-v1-selected-route";
const END_HOLD_MS = 1_000;

type Tab = "setup" | "rally" | "controls";
type StageStatus = "idle" | "armed" | "running" | "finished";
type GpsStatus = "off" | "acquiring" | "ready" | "error";
type WakeStatus = "off" | "active" | "blocked" | "unsupported";

type ActiveSession = {
  routeId: string;
  stage: StageProfile;
  startTimestamp: number;
  status: "armed" | "running";
  testMode: boolean;
  runId?: string;
  odoOffsetM: number;
  confirmedStartRouteM: number;
};

type StageSummary = RunSummary & {
  routeName: string;
  stageName: string;
  startedAt: number;
  finishedAt: number;
  testMode: boolean;
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};

const emptyMatch: MatchResult = {
  status: "ACQUIRING",
  routeDistance: 0,
  segment: 0,
  offset: 0,
  nearestRouteDistance: 0,
  nearestSegment: 0,
  nearestOffset: 0,
  reliable: false,
  ambiguous: false,
  reason: "NOT_STARTED",
};

const formatDistance = (metres: number) => {
  const safe = Math.max(0, metres);
  return safe >= 1_000
    ? `${(safe / 1_000).toFixed(safe < 10_000 ? 2 : 1)} km`
    : `${Math.round(safe)} m`;
};

const formatDuration = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const remaining = safe % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
};

const formatCountdown = (milliseconds: number) =>
  formatDuration(Math.ceil(Math.max(0, milliseconds) / 1_000));

const csvEscape = (value: unknown) => {
  const text = value === undefined || value === null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const cloneStage = (stage: StageProfile): StageProfile =>
  JSON.parse(JSON.stringify(stage)) as StageProfile;

function recoveryLabel(vehicleHeading: number | undefined, recoveryBearing: number | undefined) {
  if (recoveryBearing === undefined) return { label: "TRACK DIRECTION ?", arrow: "?" };
  if (vehicleHeading === undefined) {
    return { label: `TRACK BEARING ${Math.round(recoveryBearing)}°`, arrow: "↑" };
  }
  const relative = ((recoveryBearing - vehicleHeading + 540) % 360) - 180;
  const magnitude = Math.abs(relative);
  const side = relative < 0 ? "LEFT" : "RIGHT";
  if (magnitude <= 22.5) return { label: "TRACK AHEAD", arrow: "↑" };
  if (magnitude <= 67.5) return { label: `TRACK AHEAD ${side}`, arrow: relative < 0 ? "↖" : "↗" };
  if (magnitude <= 112.5) return { label: `TRACK ${side}`, arrow: relative < 0 ? "←" : "→" };
  if (magnitude <= 157.5) return { label: `TRACK BEHIND ${side}`, arrow: relative < 0 ? "↙" : "↘" };
  return { label: "TRACK BEHIND", arrow: "↓" };
}

function RoutePreview({ route, stage }: { route: RouteRecord; stage: StageProfile }) {
  const points = route.points;
  const minLon = Math.min(...points.map((point) => point.lon));
  const maxLon = Math.max(...points.map((point) => point.lon));
  const minLat = Math.min(...points.map((point) => point.lat));
  const maxLat = Math.max(...points.map((point) => point.lat));
  const xy = (point: { lat: number; lon: number }) => [
    18 + ((point.lon - minLon) / (maxLon - minLon || 1)) * 564,
    258 - ((point.lat - minLat) / (maxLat - minLat || 1)) * 232,
  ];
  const path = points
    .map((point, index) => `${index ? "L" : "M"}${xy(point).join(",")}`)
    .join(" ");
  const start = xy(pointAtDistance(points, stage.startRouteKm * 1_000));
  const finish = stage.finishRouteKm !== undefined
    ? xy(pointAtDistance(points, stage.finishRouteKm * 1_000))
    : undefined;
  return (
    <svg className="route-map" viewBox="0 0 600 276" aria-label="Route preview">
      <path className="route-map-shadow" d={path} />
      <path className="route-map-line" d={path} />
      <circle className="route-map-start" cx={start[0]} cy={start[1]} r="7" />
      {finish && <circle className="route-map-finish" cx={finish[0]} cy={finish[1]} r="7" />}
    </svg>
  );
}

export default function NavigatorApp() {
  const [tab, setTab] = useState<Tab>("setup");
  const [routes, setRoutes] = useState<RouteRecord[]>([]);
  const [configs, setConfigs] = useState<Record<string, RouteConfig>>({});
  const [selectedRouteId, setSelectedRouteId] = useState("");
  const [storageReady, setStorageReady] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [notice, setNotice] = useState("");
  const [stageStatus, setStageStatus] = useState<StageStatus>("idle");
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [stageSummary, setStageSummary] = useState<StageSummary | null>(null);
  const [match, setMatch] = useState<MatchResult>(emptyMatch);
  const [navigation, setNavigation] = useState<NavigationState>({
    events: {},
    instructionCursor: 0,
    initialised: false,
    transitions: [],
  });
  const [routeDistance, setRouteDistance] = useState(0);
  const [actualDistance, setActualDistance] = useState(0);
  const [displaySpeed, setDisplaySpeed] = useState(0);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("off");
  const [gpsError, setGpsError] = useState("");
  const [lastGpsTimestamp, setLastGpsTimestamp] = useState(0);
  const [lastHeading, setLastHeading] = useState<number | undefined>();
  const [wakeStatus, setWakeStatus] = useState<WakeStatus>("off");
  const [now, setNow] = useState(Date.now());
  const [endHoldActive, setEndHoldActive] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [odoCorrection, setOdoCorrection] = useState("0.00");
  const [instructionCorrection, setInstructionCorrection] = useState("");
  const [zoneAnnouncement, setZoneAnnouncement] = useState<"DZ" | "FZ" | null>(null);
  const [runs, setRuns] = useState<RunMetadata[]>([]);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);

  const gpxInputRef = useRef<HTMLInputElement>(null);
  const watchRef = useRef<number | null>(null);
  const simulationRef = useRef<number | null>(null);
  const endHoldRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const matcherRef = useRef<RouteMatcher | null>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const routeRef = useRef<RouteRecord | null>(null);
  const eventsRef = useRef<NavigationEvent[]>([]);
  const instructionsRef = useRef<Instruction[]>([]);
  const turnsRef = useRef<TurnCall[]>([]);
  const navigationRef = useRef(navigation);
  const previousRawFixRef = useRef<RawFix | null>(null);
  const smoothedSpeedRef = useRef(0);
  const actualDistanceRef = useRef(0);
  const topSpeedRef = useRef(0);
  const runSequenceRef = useRef(0);
  const stageStartedRef = useRef(false);
  const runMetadataRef = useRef<RunMetadata | null>(null);
  const zonePhaseRef = useRef<Record<string, string>>({});
  const routeDistanceRef = useRef(0);
  const wakeStatusRef = useRef<WakeStatus>("off");
  const gpsStatusRef = useRef<GpsStatus>("off");
  const finishStageRef = useRef<() => void>(() => undefined);

  const selectedRoute = routes.find((route) => route.id === selectedRouteId) || routes[0];
  const selectedConfig = selectedRoute ? configs[selectedRoute.id] : undefined;
  const selectedStage = selectedConfig?.stages.find(
    (stage) => stage.id === selectedConfig.selectedStageId,
  ) || selectedConfig?.stages[0];
  const activeRoute = session
    ? routes.find((route) => route.id === session.routeId)
    : undefined;
  const activeStage = session?.stage;
  const setupLocked = stageStatus !== "idle";

  const selectedTurns = useMemo(
    () => (selectedRoute ? buildTurnCalls(selectedRoute) : []),
    [selectedRoute],
  );
  const activeTurns = useMemo(
    () => (activeRoute ? buildTurnCalls(activeRoute) : []),
    [activeRoute],
  );
  const activeInstructions = useMemo(
    () => (activeRoute && activeStage ? stageInstructions(activeRoute, activeStage) : []),
    [activeRoute, activeStage],
  );
  const activeZones = useMemo(
    () => (activeRoute && activeStage ? resolveZones(activeRoute, activeStage) : []),
    [activeRoute, activeStage],
  );

  const refreshRuns = useCallback(async () => setRuns(await listRuns()), []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await migrateLegacyStorage();
      await markInterruptedRunsRecovered();
      const loaded = await loadRoutesAndConfigs();
      if (cancelled) return;
      setRoutes(loaded.routes);
      setConfigs(loaded.configs);
      const saved = localStorage.getItem(SELECTED_ROUTE_KEY);
      const routeId = loaded.routes.some((route) => route.id === saved)
        ? saved!
        : loaded.routes[0]?.id || "";
      setSelectedRouteId(routeId);
      setRuns(await listRuns());
      setStorageReady(true);
    })().catch((error) => {
      if (!cancelled) {
        setSetupError(`Storage failed: ${error instanceof Error ? error.message : String(error)}`);
        setStorageReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedRouteId) localStorage.setItem(SELECTED_ROUTE_KEY, selectedRouteId);
  }, [selectedRouteId]);

  useEffect(() => {
    if (stageStatus !== "armed" && stageStatus !== "running") {
      setNow(Date.now());
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [stageStatus]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
    const prompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", prompt);
    return () => window.removeEventListener("beforeinstallprompt", prompt);
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    navigationRef.current = navigation;
  }, [navigation]);

  useEffect(() => {
    wakeStatusRef.current = wakeStatus;
  }, [wakeStatus]);

  useEffect(() => {
    gpsStatusRef.current = gpsStatus;
  }, [gpsStatus]);

  useEffect(() => {
    if (
      stageStatus === "armed" &&
      session &&
      now >= session.startTimestamp
    ) {
      const running = { ...session, status: "running" as const };
      sessionRef.current = running;
      setSession(running);
      setStageStatus("running");
      setTab("rally");
    }
  }, [now, session, stageStatus]);

  useEffect(() => {
    const wakeLockApi = (
      navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
      }
    ).wakeLock;
    const active = stageStatus === "armed" || stageStatus === "running";
    const release = async () => {
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (lock && !lock.released) await lock.release().catch(() => undefined);
      setWakeStatus("off");
    };
    if (!active) {
      void release();
      return;
    }
    if (!wakeLockApi) {
      setWakeStatus("unsupported");
      return;
    }
    const acquire = async () => {
      if (document.visibilityState !== "visible" || wakeLockRef.current) return;
      try {
        const lock = await wakeLockApi.request("screen");
        wakeLockRef.current = lock;
        setWakeStatus("active");
        lock.addEventListener("release", () => {
          if (wakeLockRef.current === lock) {
            wakeLockRef.current = null;
            if (document.visibilityState === "visible") {
              window.setTimeout(() => void acquire(), 500);
            }
          }
        });
      } catch {
        setWakeStatus("blocked");
      }
    };
    const visibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, [stageStatus]);

  useEffect(
    () => () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      if (simulationRef.current !== null) window.clearInterval(simulationRef.current);
      if (endHoldRef.current !== null) window.clearTimeout(endHoldRef.current);
    },
    [],
  );

  const commitConfig = useCallback((config: RouteConfig) => {
    setConfigs((current) => ({ ...current, [config.routeId]: config }));
    void saveConfig(config).catch((error) =>
      setSetupError(`Could not save setup: ${error instanceof Error ? error.message : String(error)}`),
    );
  }, []);

  const updateSelectedStage = (update: (stage: StageProfile) => StageProfile) => {
    if (!selectedConfig || !selectedStage) return;
    const next = {
      ...selectedConfig,
      stages: selectedConfig.stages.map((stage) =>
        stage.id === selectedStage.id ? update(stage) : stage,
      ),
    };
    commitConfig(next);
  };

  const loadGpx = async (files: FileList | null) => {
    if (!files?.length || setupLocked) return;
    setSetupError("");
    for (const file of [...files]) {
      try {
        const route = await parseGpx(await file.text(), file.name);
        const existing = routes.find((candidate) => candidate.contentHash === route.contentHash);
        if (existing) {
          setSelectedRouteId(existing.id);
          setNotice(`${existing.name} was already loaded`);
          continue;
        }
        const config = defaultConfig(route);
        await saveRouteAndConfig(route, config);
        setRoutes((current) => [...current, route]);
        setConfigs((current) => ({ ...current, [route.id]: config }));
        setSelectedRouteId(route.id);
        setNotice(`${route.name} loaded`);
      } catch (error) {
        setSetupError(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const removeSelectedRoute = async () => {
    if (!selectedRoute || setupLocked) return;
    if (!window.confirm(`Remove "${selectedRoute.name}" and its stage setups from this device?`)) return;
    await deleteRoute(selectedRoute.id);
    const remaining = routes.filter((route) => route.id !== selectedRoute.id);
    setRoutes(remaining);
    setConfigs((current) => {
      const next = { ...current };
      delete next[selectedRoute.id];
      return next;
    });
    setSelectedRouteId(remaining[0]?.id || "");
  };

  const createReverse = async () => {
    if (!selectedRoute || setupLocked) return;
    const reversed = reverseRoute(selectedRoute);
    const existing = routes.find((route) => route.id === reversed.id);
    if (existing) {
      setSelectedRouteId(existing.id);
      setNotice("Reverse profile already exists");
      return;
    }
    const config = defaultConfig(reversed);
    await saveRouteAndConfig(reversed, config);
    setRoutes((current) => [...current, reversed]);
    setConfigs((current) => ({ ...current, [reversed.id]: config }));
    setSelectedRouteId(reversed.id);
    setNotice("Reverse route created; verify stage markers and zones before use");
  };

  const stopTracking = () => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (simulationRef.current !== null) {
      window.clearInterval(simulationRef.current);
      simulationRef.current = null;
    }
  };

  const currentDisplay = (
    nav: NavigationState,
    turns: TurnCall[],
    instructions: Instruction[],
    distance: number,
  ) => {
    const turn = turns.find(
      (candidate) =>
        !eventFinished(nav, `turn:${candidate.id}`) &&
        candidate.passDistance >= distance - 8,
    );
    const instruction = instructions[Math.min(nav.instructionCursor, instructions.length - 1)];
    return { turn, instruction };
  };

  const appendPersistentFix = (
    fix: RawFix,
    matchResult: MatchResult,
    nav: NavigationState,
    speedKph: number,
  ) => {
    const activeSession = sessionRef.current;
    const route = routeRef.current;
    const run = runMetadataRef.current;
    if (!activeSession || !route || !run || activeSession.testMode) return;
    const instructions = instructionsRef.current;
    const turns = turnsRef.current;
    const display = currentDisplay(nav, turns, instructions, matchResult.routeDistance);
    const zones = resolveZones(route, activeSession.stage);
    const zone = zones.find((candidate) => {
      const evidence = zoneEvidence(nav, candidate, fix.timestamp);
      return evidence.phase === "ACTIVE" ||
        (evidence.phase === "ARMED" && candidate.startDistance - matchResult.routeDistance <= 500) ||
        (evidence.phase === "COMPLETE" && matchResult.routeDistance - candidate.finishDistance < 100);
    });
    const evidence = zone ? zoneEvidence(nav, zone, fix.timestamp) : undefined;
    const odoOffset = activeSession.odoOffsetM;
    const entry: RunLogEntry = {
      runId: run.id,
      sequence: runSequenceRef.current++,
      timestamp: fix.timestamp,
      receivedAt: fix.receivedAt,
      latitude: fix.lat,
      longitude: fix.lon,
      accuracyM: fix.accuracy,
      rawSpeedKph: fix.speedMps * 3.6,
      displaySpeedKph: speedKph,
      headingDeg: fix.heading,
      matchStatus: matchResult.status,
      matchReason: matchResult.reason,
      routeDistanceM: matchResult.routeDistance,
      stageOdoM: matchResult.routeDistance + odoOffset,
      actualDistanceM: actualDistanceRef.current,
      offRouteM: matchResult.nearestOffset,
      segment: matchResult.segment,
      nearestRouteDistanceM: matchResult.nearestRouteDistance,
      routeReliable: matchResult.reliable,
      routeAmbiguous: matchResult.ambiguous,
      upcomingTurnId: display.turn?.id,
      upcomingTurnLabel: display.turn
        ? `${display.turn.severity} ${display.turn.direction}`
        : undefined,
      upcomingTurnDistanceM: display.turn
        ? display.turn.distance - matchResult.routeDistance
        : undefined,
      upcomingTurnSource: display.turn?.source,
      upcomingTurnConfidence: display.turn?.confidence,
      nextInstructionId: display.instruction?.id,
      nextInstructionLabel: display.instruction?.label,
      nextInstructionDistanceM: display.instruction
        ? display.instruction.routeDistance - matchResult.routeDistance
        : undefined,
      activeZoneId: zone?.id,
      activeZoneState: evidence?.phase,
      zoneElapsedS: evidence?.elapsedSeconds,
      zoneDistanceRemainingM: zone
        ? evidence?.phase === "ACTIVE"
          ? zone.finishDistance - matchResult.routeDistance
          : zone.startDistance - matchResult.routeDistance
        : undefined,
      eventTransitions: nav.transitions.join(";"),
      pageVisibility: document.visibilityState,
      wakeLockState: wakeStatusRef.current,
    };
    void appendRunFix(entry).catch((error) =>
      setGpsError(`Run log storage failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };

  const activateStageAtDistance = (distance: number) => {
    const activeSession = sessionRef.current;
    if (!activeSession || stageStartedRef.current) return navigationRef.current;
    const instructions = instructionsRef.current;
    const initial = initialiseNavigation(
      eventsRef.current,
      instructions,
      distance,
      activeSession.stage.startInstructionId,
    );
    navigationRef.current = initial;
    setNavigation(initial);
    stageStartedRef.current = true;
    const running = {
      ...activeSession,
      status: "running" as const,
      confirmedStartRouteM: distance,
    };
    sessionRef.current = running;
    setSession(running);
    setStageStatus("running");
    setTab("rally");
    return initial;
  };

  const processRawFix = (fix: RawFix) => {
    const activeSession = sessionRef.current;
    const matcher = matcherRef.current;
    if (!activeSession || !matcher) return;
    const matchResult = matcher.update(fix);
    const previous = previousRawFixRef.current;
    const dt = previous ? clamp((fix.timestamp - previous.timestamp) / 1_000, 0.1, 5) : 1;
    const displacement = previous ? haversine(previous, fix) : 0;
    const boundedSpeedMps = previous
      ? clamp(
          fix.speedMps,
          Math.max(0, previous.speedMps - 15 * dt),
          previous.speedMps + 12 * dt,
        )
      : fix.speedMps;
    const rawKph = boundedSpeedMps * 3.6;
    const alpha = clamp(1 - Math.exp(-dt / 0.55), 0.45, 0.92);
    smoothedSpeedRef.current = smoothedSpeedRef.current === 0
      ? rawKph
      : smoothedSpeedRef.current + alpha * (rawKph - smoothedSpeedRef.current);
    if (rawKph < 1) smoothedSpeedRef.current = 0;

    const started = fix.timestamp >= activeSession.startTimestamp;
    let nav = navigationRef.current;
    if (started && !stageStartedRef.current) nav = activateStageAtDistance(matchResult.routeDistance);
    if (
      started &&
      previous &&
      previous.timestamp >= activeSession.startTimestamp &&
      fix.accuracy <= 30 &&
      dt <= 3 &&
      displacement > Math.max(2.5, fix.accuracy * 0.3) &&
      displacement / dt < 70
    ) {
      actualDistanceRef.current += displacement;
    }
    if (started && fix.accuracy <= 30) {
      topSpeedRef.current = Math.max(topSpeedRef.current, smoothedSpeedRef.current);
    }
    if (started) {
      nav = advanceNavigation(
        nav,
        eventsRef.current,
        instructionsRef.current,
        matchResult.routeDistance,
        fix.timestamp,
        matchResult.reliable,
      );
      navigationRef.current = nav;
      setNavigation(nav);
      appendPersistentFix(fix, matchResult, nav, smoothedSpeedRef.current);
    }

    previousRawFixRef.current = fix;
    setMatch(matchResult);
    routeDistanceRef.current = matchResult.routeDistance;
    setRouteDistance(matchResult.routeDistance);
    setActualDistance(actualDistanceRef.current);
    setDisplaySpeed(smoothedSpeedRef.current);
    setGpsAccuracy(fix.accuracy);
    setLastGpsTimestamp(fix.timestamp);
    setLastHeading(fix.heading);
    setGpsStatus("ready");
    setGpsError("");
  };

  const startGps = () => {
    if (!navigator.geolocation) {
      setGpsStatus("error");
      setGpsError("This browser does not expose GPS");
      return;
    }
    setGpsStatus("acquiring");
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const previous = previousRawFixRef.current;
        const receivedAt = Date.now();
        const timestamp = position.timestamp || receivedAt;
        if (previous && timestamp <= previous.timestamp) return;
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        const dt = previous ? Math.max(0.1, (timestamp - previous.timestamp) / 1_000) : 1;
        const movement = previous ? haversine(previous, { lat, lon }) : 0;
        const calculated = previous && movement > Math.max(2.5, position.coords.accuracy * 0.3)
          ? movement / dt
          : 0;
        const reported = position.coords.speed;
        const speedMps = clamp(
          reported !== null && Number.isFinite(reported) && reported >= 0
            ? reported
            : calculated,
          0,
          70,
        );
        const reportedHeading = position.coords.heading;
        const movementHeading = previous && movement > 4
          ? bearing(previous, { lat, lon })
          : undefined;
        const heading = reportedHeading !== null && Number.isFinite(reportedHeading)
          ? reportedHeading
          : movementHeading;
        processRawFix({
          timestamp,
          receivedAt,
          lat,
          lon,
          accuracy: position.coords.accuracy,
          speedMps,
          heading,
        });
      },
      (error) => {
        setGpsStatus("error");
        setGpsError(`${error.code}: ${error.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
  };

  const startSimulation = (route: RouteRecord, stage: StageProfile) => {
    const start = stage.startRouteKm * 1_000;
    const finish = (stage.finishRouteKm ?? route.quality.totalDistance / 1_000) * 1_000;
    let distance = start;
    let previousTick = Date.now();
    activateStageAtDistance(start);
    setMatch({
      ...emptyMatch,
      status: "MATCHED",
      routeDistance: start,
      nearestRouteDistance: start,
      reliable: true,
      reason: "SIMULATION",
    });
    setGpsStatus("ready");
    setGpsAccuracy(3);
    simulationRef.current = window.setInterval(() => {
      const timestamp = Date.now();
      const dt = (timestamp - previousTick) / 1_000;
      previousTick = timestamp;
      const speedMps = 28;
      distance = Math.min(finish, distance + speedMps * dt);
      const nav = advanceNavigation(
        navigationRef.current,
        eventsRef.current,
        instructionsRef.current,
        distance,
        timestamp,
        true,
      );
      navigationRef.current = nav;
      setNavigation(nav);
      routeDistanceRef.current = distance;
      setRouteDistance(distance);
      setActualDistance(distance - start);
      actualDistanceRef.current = distance - start;
      setDisplaySpeed(speedMps * 3.6);
      topSpeedRef.current = speedMps * 3.6;
      setLastGpsTimestamp(timestamp);
      setMatch((current) => ({
        ...current,
        routeDistance: distance,
        nearestRouteDistance: distance,
        reason: "SIMULATION",
      }));
      if (distance >= finish) finishStageRef.current();
    }, 250);
  };

  const validateSetup = (route: RouteRecord, stage: StageProfile) => {
    if (stage.startRouteKm < 0 || stage.startRouteKm * 1_000 > route.quality.totalDistance) {
      return "Stage start falls outside the GPX";
    }
    if (
      stage.finishRouteKm !== undefined &&
      (stage.finishRouteKm <= stage.startRouteKm ||
        stage.finishRouteKm * 1_000 > route.quality.totalDistance)
    ) return "Stage finish must be after the start and inside the GPX";
    if (resolveZones(route, stage).length !== stage.zones.length) {
      return "One or more DZ/FZ zones has an invalid or reversed boundary";
    }
    return "";
  };

  const beginStage = async (mode: "armed" | "now" | "test") => {
    if (!selectedRoute || !selectedStage) {
      setSetupError("Load a GPX and select a stage first");
      return;
    }
    const validation = validateSetup(selectedRoute, selectedStage);
    if (validation) {
      setSetupError(validation);
      return;
    }
    stopTracking();
    const stage = cloneStage(selectedStage);
    const startTimestamp = mode === "armed"
      ? new Date(stage.officialStart).getTime()
      : Date.now();
    if (!Number.isFinite(startTimestamp)) {
      setSetupError("Enter a valid official start time");
      return;
    }
    if (mode === "armed" && startTimestamp < Date.now() - 2_000) {
      setSetupError("Official start time is already in the past");
      return;
    }
    setSetupError("");
    setNotice("");
    setStageSummary(null);
    const turns = buildTurnCalls(selectedRoute);
    const instructions = stageInstructions(selectedRoute, stage);
    const events = buildNavigationEvents(selectedRoute, stage, turns);
    const matcher = new RouteMatcher(selectedRoute.points, stage.startRouteKm * 1_000);
    matcherRef.current = matcher;
    routeRef.current = selectedRoute;
    eventsRef.current = events;
    instructionsRef.current = instructions;
    turnsRef.current = turns;
    const initial = initialiseNavigation(
      events,
      instructions,
      stage.startRouteKm * 1_000,
      stage.startInstructionId,
    );
    navigationRef.current = initial;
    setNavigation(initial);
    previousRawFixRef.current = null;
    smoothedSpeedRef.current = 0;
    actualDistanceRef.current = 0;
    topSpeedRef.current = 0;
    runSequenceRef.current = 0;
    stageStartedRef.current = false;
    zonePhaseRef.current = {};
    const runId = mode === "test" ? undefined : `run-${crypto.randomUUID()}`;
    const active: ActiveSession = {
      routeId: selectedRoute.id,
      stage,
      startTimestamp,
      status: mode === "armed" && startTimestamp > Date.now() ? "armed" : "running",
      testMode: mode === "test",
      runId,
      odoOffsetM: stage.startOdoKm * 1_000 - stage.startRouteKm * 1_000,
      confirmedStartRouteM: stage.startRouteKm * 1_000,
    };
    sessionRef.current = active;
    setSession(active);
    routeDistanceRef.current = stage.startRouteKm * 1_000;
    setRouteDistance(stage.startRouteKm * 1_000);
    setActualDistance(0);
    setDisplaySpeed(0);
    setMatch({ ...emptyMatch, routeDistance: stage.startRouteKm * 1_000 });
    setStageStatus(active.status);
    setTab("rally");
    if (runId) {
      const metadata: RunMetadata = {
        id: runId,
        routeId: selectedRoute.id,
        routeName: selectedRoute.name,
        routeHash: selectedRoute.contentHash,
        stageId: stage.id,
        stageName: stage.name,
        appVersion: APP_VERSION,
        buildId: BUILD_ID,
        startedAt: startTimestamp,
        status: "RUNNING",
        configuration: stage,
      };
      runMetadataRef.current = metadata;
      await createRun(metadata);
    } else runMetadataRef.current = null;
    if (mode === "test") startSimulation(selectedRoute, stage);
    else startGps();
  };

  const finishStage = useCallback(async () => {
    const active = sessionRef.current;
    const route = routeRef.current;
    if (!active || !route) return;
    stopTracking();
    const finishedAt = Date.now();
    const elapsedSeconds = Math.max(0, (finishedAt - active.startTimestamp) / 1_000);
    const summary: StageSummary = {
      routeName: route.name,
      stageName: active.stage.name,
      startedAt: active.startTimestamp,
      finishedAt,
      elapsedSeconds,
      actualDistanceM: actualDistanceRef.current,
      routeDistanceM: Math.max(0, routeDistanceRef.current - active.confirmedStartRouteM),
      averageSpeedKph: elapsedSeconds
        ? (actualDistanceRef.current / elapsedSeconds) * 3.6
        : 0,
      topSpeedKph: topSpeedRef.current,
      testMode: active.testMode,
    };
    setStageSummary(summary);
    setStageStatus("finished");
    setEndHoldActive(false);
    setGpsStatus(active.testMode ? "off" : gpsStatusRef.current);
    if (runMetadataRef.current) {
      const completed: RunMetadata = {
        ...runMetadataRef.current,
        status: "FINISHED",
        finishedAt,
        summary,
      };
      runMetadataRef.current = completed;
      await updateRun(completed);
      await refreshRuns();
    }
  }, [refreshRuns]);

  finishStageRef.current = () => {
    void finishStage();
  };

  const resetForNewLeg = () => {
    stopTracking();
    const storedRun = runMetadataRef.current;
    if (storedRun?.status === "RUNNING") {
      if (stageStartedRef.current) {
        void updateRun({
          ...storedRun,
          status: "RECOVERED",
          finishedAt: Date.now(),
        }).then(refreshRuns);
      } else {
        void removeRun(storedRun.id).then(refreshRuns);
      }
    }
    sessionRef.current = null;
    routeRef.current = null;
    matcherRef.current = null;
    runMetadataRef.current = null;
    setSession(null);
    setStageStatus("idle");
    setStageSummary(null);
    setMatch(emptyMatch);
    setNavigation({ events: {}, instructionCursor: 0, initialised: false, transitions: [] });
    setGpsStatus("off");
    setGpsError("");
    routeDistanceRef.current = 0;
    setRouteDistance(0);
    setActualDistance(0);
    setDisplaySpeed(0);
    setTab("setup");
  };

  const beginEndHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setEndHoldActive(true);
    endHoldRef.current = window.setTimeout(() => void finishStage(), END_HOLD_MS);
  };

  const cancelEndHold = () => {
    if (endHoldRef.current !== null) window.clearTimeout(endHoldRef.current);
    endHoldRef.current = null;
    setEndHoldActive(false);
  };

  const acceptRejoin = () => {
    const accepted = matcherRef.current?.acceptRejoin();
    if (accepted === undefined) return;
    const nav = seekNavigation(
      navigationRef.current,
      eventsRef.current,
      instructionsRef.current,
      accepted,
      Date.now(),
      "MANUAL_REJOIN",
    );
    navigationRef.current = nav;
    setNavigation(nav);
    routeDistanceRef.current = accepted;
    setRouteDistance(accepted);
    setNotice("Rejoin accepted; skipped events are recorded in the log");
  };

  const openCorrection = () => {
    if (!session) return;
    setOdoCorrection(((routeDistance + session.odoOffsetM) / 1_000).toFixed(2));
    setInstructionCorrection(activeInstructions[navigation.instructionCursor]?.id || "");
    setCorrectionOpen(true);
  };

  const applyOdoCorrection = (syncRoute: boolean) => {
    const active = sessionRef.current;
    if (!active) return;
    const desired = Number(odoCorrection) * 1_000;
    if (!Number.isFinite(desired)) return;
    if (syncRoute) {
      const targetRoute = active.stage.startRouteKm * 1_000 +
        (desired - active.stage.startOdoKm * 1_000);
      matcherRef.current?.setRouteDistance(targetRoute);
      const nav = seekNavigation(
        navigationRef.current,
        eventsRef.current,
        instructionsRef.current,
        targetRoute,
        Date.now(),
        "MANUAL_ODO_SET",
      );
      navigationRef.current = nav;
      setNavigation(nav);
      routeDistanceRef.current = targetRoute;
      setRouteDistance(targetRoute);
      setMatch((current) => ({
        ...current,
        routeDistance: targetRoute,
        status: "MATCHED",
        reliable: false,
        reason: "MANUAL_ROUTE_POSITION_SET",
      }));
      const updated = { ...active, odoOffsetM: desired - targetRoute };
      sessionRef.current = updated;
      setSession(updated);
    } else {
      const updated = { ...active, odoOffsetM: desired - routeDistanceRef.current };
      sessionRef.current = updated;
      setSession(updated);
    }
    setCorrectionOpen(false);
  };

  const applyInstructionCorrection = () => {
    const index = activeInstructions.findIndex(
      (instruction) => instruction.id === instructionCorrection,
    );
    if (index < 0) return;
    const nav = setInstructionCursor(
      navigationRef.current,
      activeInstructions,
      index,
      Date.now(),
    );
    navigationRef.current = nav;
    setNavigation(nav);
    setCorrectionOpen(false);
  };

  const exportRun = async (run: RunMetadata) => {
    const fixes = await getRunFixes(run.id);
    const columns: (keyof RunLogEntry)[] = [
      "runId", "sequence", "timestamp", "receivedAt", "latitude", "longitude",
      "accuracyM", "rawSpeedKph", "displaySpeedKph", "headingDeg", "matchStatus",
      "matchReason", "routeDistanceM", "stageOdoM", "actualDistanceM", "offRouteM",
      "segment", "nearestRouteDistanceM", "routeReliable", "routeAmbiguous",
      "upcomingTurnId", "upcomingTurnLabel", "upcomingTurnDistanceM",
      "upcomingTurnSource", "upcomingTurnConfidence", "nextInstructionId",
      "nextInstructionLabel", "nextInstructionDistanceM", "activeZoneId",
      "activeZoneState", "zoneElapsedS", "zoneDistanceRemainingM", "eventTransitions",
      "pageVisibility", "wakeLockState",
    ];
    const metadata = [
      `# app_version=${run.appVersion}`,
      `# build_id=${run.buildId}`,
      `# route_name=${run.routeName}`,
      `# route_hash=${run.routeHash}`,
      `# stage_name=${run.stageName}`,
      `# configuration=${JSON.stringify(run.configuration)}`,
    ];
    const rows = fixes.map((fix) =>
      columns.map((column) => csvEscape(fix[column])).join(","),
    );
    const csv = [...metadata, columns.join(","), ...rows].join("\n");
    const fileName = `XR-v1-${run.stageName.replace(/[^a-z0-9]+/gi, "-")}-${new Date(run.startedAt).toISOString().replace(/[:.]/g, "-")}.csv`;
    const file = new File([csv], fileName, { type: "text/csv" });
    const shareNavigator = navigator as Navigator & {
      canShare?: (data: ShareData) => boolean;
      share?: (data: ShareData) => Promise<void>;
    };
    if (shareNavigator.share && shareNavigator.canShare?.({ files: [file] })) {
      try {
        await shareNavigator.share({ files: [file], title: fileName });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const deleteStoredRun = async (run: RunMetadata) => {
    if (!window.confirm(`Delete stored log for ${run.stageName}?`)) return;
    await removeRun(run.id);
    await refreshRuns();
  };

  const gpsFresh = gpsStatus === "ready" && lastGpsTimestamp > 0 && now - lastGpsTimestamp <= 2_500;
  const routeReliable = Boolean(session?.testMode) || (gpsFresh && match.reliable && match.status === "MATCHED");
  const extrapolatedRouteDistance = routeReliable && stageStatus === "running" && !session?.testMode
    ? Math.min(
        activeRoute?.quality.totalDistance || routeDistance,
        routeDistance + (displaySpeed / 3.6) * clamp((now - lastGpsTimestamp) / 1_000, 0, 1.2),
      )
    : routeDistance;
  const displayedStageOdo = extrapolatedRouteDistance + (session?.odoOffsetM || 0);
  const elapsedSeconds = session ? Math.max(0, (now - session.startTimestamp) / 1_000) : 0;
  const displayTurnIndex = activeTurns.findIndex(
    (turn) =>
      !eventFinished(navigation, `turn:${turn.id}`) &&
      turn.passDistance >= extrapolatedRouteDistance - 8,
  );
  const upcomingTurn = displayTurnIndex >= 0 ? activeTurns[displayTurnIndex] : undefined;
  const followingTurn = displayTurnIndex >= 0
    ? activeTurns.find((turn, index) => index > displayTurnIndex && !eventFinished(navigation, `turn:${turn.id}`))
    : undefined;
  const turnDistance = upcomingTurn ? upcomingTurn.distance - extrapolatedRouteDistance : undefined;
  const turnActive = upcomingTurn && turnDistance !== undefined &&
    turnDistance <= turnLeadDistance(upcomingTurn, displaySpeed);
  const nextInstruction = activeInstructions[
    Math.min(navigation.instructionCursor, activeInstructions.length - 1)
  ];
  const currentInstruction = activeInstructions[navigation.instructionCursor - 1];
  const activeZoneDisplay = activeZones
    .map((zone) => ({ zone, evidence: zoneEvidence(navigation, zone, now) }))
    .find(({ zone, evidence }) =>
      evidence.phase === "ACTIVE" ||
      (evidence.phase === "ARMED" && zone.startDistance - extrapolatedRouteDistance <= 500) ||
      (evidence.phase === "COMPLETE" && extrapolatedRouteDistance - zone.finishDistance < 100),
    );

  useEffect(() => {
    if (!activeZoneDisplay || stageStatus !== "running") return;
    const { zone, evidence } = activeZoneDisplay;
    const previous = zonePhaseRef.current[zone.id];
    zonePhaseRef.current[zone.id] = evidence.phase;
    if (evidence.phase === "ACTIVE" && previous !== "ACTIVE") {
      setZoneAnnouncement("DZ");
      navigator.vibrate?.([220, 100, 220]);
      window.setTimeout(() => setZoneAnnouncement(null), 2_600);
    } else if (evidence.phase === "COMPLETE" && previous !== "COMPLETE") {
      setZoneAnnouncement("FZ");
      navigator.vibrate?.([450, 140, 450]);
      window.setTimeout(() => setZoneAnnouncement(null), 2_600);
    }
  }, [activeZoneDisplay, stageStatus]);

  const recovery = recoveryLabel(lastHeading, match.recoveryBearing);
  const turnArrow = !turnActive
    ? "↑"
    : upcomingTurn?.severity === "HAIRPIN"
      ? upcomingTurn.direction === "LEFT" ? "↶" : "↷"
      : upcomingTurn?.direction === "LEFT" ? "↰" : "↱";
  const gpsLabel = gpsStatus === "ready" && !gpsFresh
    ? "GPS STALE"
    : gpsStatus === "ready"
      ? `GPS ±${Math.round(gpsAccuracy || 0)}m`
    : gpsStatus === "acquiring"
      ? "GPS …"
      : gpsStatus === "error"
        ? "GPS ERROR"
        : "GPS OFF";

  if (!storageReady) {
    return <main className="boot-screen"><strong>EXTREME RALLY</strong><span>Loading navigator…</span></main>;
  }

  return (
    <main className={`app-shell ${stageStatus === "running" && tab === "rally" ? "stage-active" : ""}`}>
      <header className="topbar">
        <div className="brand"><span>EXTREME RALLY · V{APP_VERSION}</span><h1>RALLY NAVIGATOR</h1></div>
        <div className="header-actions">
          <button
            className="install-pill"
            disabled={!installPrompt}
            onClick={() => void installPrompt?.prompt()}
          >
            {installPrompt ? "INSTALL" : BUILD_ID}
          </button>
          <div className={`gps-pill ${gpsStatus}`}>{gpsLabel}</div>
        </div>
      </header>

      <nav className="nav-tabs">
        {(["setup", "rally", "controls"] as Tab[]).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>
            {item.toUpperCase()}
          </button>
        ))}
      </nav>

      <input
        ref={gpxInputRef}
        hidden
        type="file"
        accept=".gpx"
        multiple
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          void loadGpx(event.target.files);
          event.target.value = "";
        }}
      />
      <section className="screen">
        {setupError && <div className="error-banner">{setupError}</div>}
        {notice && <div className="notice-banner" onClick={() => setNotice("")}>{notice}</div>}

        {tab === "setup" && (
          <div className="screen-stack">
            {setupLocked && <div className="locked-banner">STAGE ACTIVE · SETUP LOCKED</div>}
            <section className="panel">
              <div className="panel-heading">
                <div><span>ROUTE</span><h2>GPX package</h2></div>
                <div className="panel-actions">
                  <button disabled={!selectedRoute || setupLocked} onClick={removeSelectedRoute}>REMOVE</button>
                  <button disabled={setupLocked} onClick={() => gpxInputRef.current?.click()}>+ GPX</button>
                </div>
              </div>
              {!selectedRoute ? (
                <div className="empty-state"><strong>No route loaded</strong><p>Upload an organiser GPX to begin.</p></div>
              ) : (
                <>
                  <label className="field">CHOSEN ROUTE
                    <select value={selectedRoute.id} disabled={setupLocked} onChange={(event) => setSelectedRouteId(event.target.value)}>
                      {routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}
                    </select>
                  </label>
                  <div className="route-title"><strong>{selectedRoute.name}</strong><span>{selectedRoute.direction}</span></div>
                  <div className="metric-grid route-metrics">
                    <div><span>DISTANCE</span><strong>{(selectedRoute.quality.totalDistance / 1_000).toFixed(1)}</strong><small>km</small></div>
                    <div><span>ROADBOOK</span><strong>{selectedRoute.instructions.length}</strong></div>
                    <div><span>CALLS</span><strong>{selectedTurns.length}</strong></div>
                  </div>
                  {selectedStage && <>
                    <div className={`quality-strip ${selectedRoute.quality.maximumGap > 250 ? "warning" : ""}`}>
                      <span>GPX QUALITY</span>
                      <strong>{selectedRoute.quality.gapsOver140m} sparse gaps</strong>
                      <b>max {Math.round(selectedRoute.quality.maximumGap)}m</b>
                    </div>
                    <RoutePreview route={selectedRoute} stage={selectedStage} />
                    <button className="full-secondary route-reverse-action" disabled={setupLocked} onClick={createReverse}>CREATE REVERSE ROUTE</button>
                  </>}
                </>
              )}
            </section>

            {selectedRoute && selectedConfig && selectedStage && (
              <>
                <section className="panel setup-limits-panel">
                  <div className="panel-heading">
                    <div><span>STAGE LIMITS</span><h2>Start and finish</h2></div>
                    <div className="panel-actions">
                      <button disabled={setupLocked || selectedConfig.stages.length <= 1} onClick={() => {
                        const remaining = selectedConfig.stages.filter((stage) => stage.id !== selectedStage.id);
                        commitConfig({ ...selectedConfig, stages: remaining, selectedStageId: remaining[0].id });
                      }}>REMOVE SS</button>
                      <button disabled={setupLocked} onClick={() => {
                        const added = { ...defaultStage(selectedRoute), id: `stage-${crypto.randomUUID()}`, name: `SS ${selectedConfig.stages.length + 1}` };
                        commitConfig({ ...selectedConfig, stages: [...selectedConfig.stages, added], selectedStageId: added.id });
                      }}>+ SS</button>
                    </div>
                  </div>

                  {selectedConfig.stages.length > 1 && <label className="field compact-stage-select">SELECT SS
                      <select disabled={setupLocked} value={selectedStage.id} onChange={(event) => commitConfig({ ...selectedConfig, selectedStageId: event.target.value })}>
                        {selectedConfig.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
                      </select>
                    </label>}

                  <label className="field compact-stage-name">SS NAME
                    <input disabled={setupLocked} value={selectedStage.name} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, name: event.target.value }))} />
                  </label>

                  <div className="stage-boundaries">
                    <div className="boundary-card start-boundary">
                      <div className="boundary-heading"><span>START</span><strong>SS begins here</strong></div>
                      <div className="field-grid two boundary-fields">
                        <label className="field">GPX ROUTE KM
                          <input disabled={setupLocked} type="number" step="0.01" value={selectedStage.startRouteKm} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, startRouteKm: Number(event.target.value) }))} />
                        </label>
                        <label className="field">START ODO KM
                          <input disabled={setupLocked} type="number" step="0.01" value={selectedStage.startOdoKm} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, startOdoKm: Number(event.target.value) }))} />
                        </label>
                      </div>
                    </div>

                    <div className="boundary-card finish-boundary">
                      <div className="boundary-heading"><span>FINISH</span><strong>SS ends here</strong></div>
                      <label className="field">GPX ROUTE KM · OPTIONAL
                        <input disabled={setupLocked} type="number" step="0.01" placeholder="Use end of GPX" value={selectedStage.finishRouteKm ?? ""} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, finishRouteKm: event.target.value === "" ? undefined : Number(event.target.value) }))} />
                      </label>
                    </div>
                  </div>

                  <label className="field optional-roadbook">FIRST ROADBOOK INSTRUCTION · OPTIONAL
                    <select disabled={setupLocked} value={selectedStage.startInstructionId || ""} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, startInstructionId: event.target.value || undefined }))}>
                      <option value="">AUTO FROM SS START</option>
                      {selectedRoute.instructions.map((instruction) => <option key={instruction.id} value={instruction.id}>{instruction.number} · {instruction.label}</option>)}
                    </select>
                  </label>
                </section>

                <section className="panel start-panel setup-start-panel">
                  <div className="panel-heading">
                    <div><span>START</span><h2>Official clock</h2></div>
                  </div>
                  <label className="field">OFFICIAL START TIME
                    <input disabled={setupLocked} type="datetime-local" step="1" value={selectedStage.officialStart} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, officialStart: event.target.value }))} />
                  </label>
                  <div className="stage-ready"><span>READY</span><strong>{selectedStage.name}</strong><p>Stage ODO {selectedStage.startOdoKm.toFixed(2)} km · {selectedStage.zones.length} zone{selectedStage.zones.length === 1 ? "" : "s"}</p></div>
                  <div className="two-actions arm-actions">
                    <button className="primary-action" disabled={setupLocked} onClick={() => void beginStage("armed")}>ARM OFFICIAL START</button>
                    <button className="secondary-action" disabled={setupLocked} onClick={() => void beginStage("now")}>START NOW</button>
                  </div>
                </section>

                <details className="advanced-setup">
                  <summary><span>ADVANCED SETUP</span><b>DZ / FZ speed zones</b></summary>
                  <div className="advanced-stack">
                <section className="panel">
                  <div className="panel-heading">
                    <div><span>SPEED CONTROL</span><h2>DZ / FZ zones</h2></div>
                    <button disabled={setupLocked} onClick={() => updateSelectedStage((stage) => ({ ...stage, zones: [...stage.zones, addEmptyZone(stage)] }))}>+ ZONE</button>
                  </div>
                  {!selectedStage.zones.length && <div className="empty-state compact"><strong>No speed zones</strong><p>Add as many zones as the stage requires.</p></div>}
                  {selectedStage.zones.map((zone, zoneIndex) => (
                    <div className="zone-editor" key={zone.id}>
                      <div className="zone-editor-title"><strong>{zone.name || `ZONE ${zoneIndex + 1}`}</strong><button disabled={setupLocked} onClick={() => updateSelectedStage((stage) => ({ ...stage, zones: stage.zones.filter((candidate) => candidate.id !== zone.id) }))}>REMOVE</button></div>
                      <div className="field-grid two">
                        <label className="field">ZONE NAME
                          <input disabled={setupLocked} value={zone.name} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, zones: stage.zones.map((candidate) => candidate.id === zone.id ? { ...candidate, name: event.target.value } : candidate) }))} />
                        </label>
                        <label className="field">LIMIT KM/H
                          <input disabled={setupLocked} type="number" min="1" value={zone.speedLimitKph} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, zones: stage.zones.map((candidate) => candidate.id === zone.id ? { ...candidate, speedLimitKph: Number(event.target.value) } : candidate) }))} />
                        </label>
                      </div>
                      <div className="zone-boundaries">
                        {(["start", "finish"] as const).map((boundary) => {
                          const marker = zone[boundary];
                          return <div className={`boundary-card zone-${boundary}`} key={boundary}>
                            <div className="boundary-heading"><span>{boundary === "start" ? "DZ" : "FZ"}</span><strong>{boundary === "start" ? "Zone starts" : "Zone finishes"}</strong></div>
                            <div className="marker-row">
                              <label className="field">POSITION TYPE
                                <select disabled={setupLocked} value={marker.mode} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, zones: stage.zones.map((candidate) => candidate.id === zone.id ? { ...candidate, [boundary]: { mode: event.target.value as ZoneDefinition[typeof boundary]["mode"], value: event.target.value === "INSTRUCTION" ? selectedRoute.instructions[0]?.id || "" : 0 } } : candidate) }))}>
                                  <option value="STAGE_KM">STAGE ODO KM</option>
                                  <option value="ROUTE_KM">ROUTE KM</option>
                                  <option value="INSTRUCTION">INSTRUCTION</option>
                                </select>
                              </label>
                              <label className="field">POSITION
                                {marker.mode === "INSTRUCTION" ? (
                                  <select disabled={setupLocked} value={String(marker.value)} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, zones: stage.zones.map((candidate) => candidate.id === zone.id ? { ...candidate, [boundary]: { ...marker, value: event.target.value } } : candidate) }))}>
                                    {selectedRoute.instructions.map((instruction) => <option key={instruction.id} value={instruction.id}>{instruction.number} · {instruction.label}</option>)}
                                  </select>
                                ) : (
                                  <input disabled={setupLocked} type="number" step="0.01" value={Number(marker.value)} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, zones: stage.zones.map((candidate) => candidate.id === zone.id ? { ...candidate, [boundary]: { ...marker, value: Number(event.target.value) } } : candidate) }))} />
                                )}
                              </label>
                            </div>
                          </div>;
                        })}
                      </div>
                      <label className="field">OFFICIAL ZONE DISTANCE KM · OPTIONAL
                        <input disabled={setupLocked} type="number" step="0.01" value={zone.officialDistanceKm ?? ""} onChange={(event) => updateSelectedStage((stage) => ({ ...stage, zones: stage.zones.map((candidate) => candidate.id === zone.id ? { ...candidate, officialDistanceKm: event.target.value === "" ? undefined : Number(event.target.value) } : candidate) }))} />
                      </label>
                    </div>
                  ))}
                </section>
                  </div>
                </details>
              </>
            )}
          </div>
        )}

        {tab === "rally" && (
          <div className="rally-screen">
            {stageStatus === "idle" && <div className="empty-state rally-empty"><strong>No active stage</strong><p>Complete Setup, then arm or start the stage.</p><button onClick={() => setTab("setup")}>GO TO SETUP</button></div>}
            {stageStatus === "armed" && session && (
              <section className="countdown-card"><span>OFFICIAL START</span><strong>{formatCountdown(session.startTimestamp - now)}</strong><p>{gpsLabel} · Screen {wakeStatus}</p><button onClick={resetForNewLeg}>CANCEL</button></section>
            )}
            {stageStatus === "running" && session && activeRoute && (
              <>
                {zoneAnnouncement && <div className={`zone-flash ${zoneAnnouncement.toLowerCase()}`}><strong>{zoneAnnouncement}</strong><span>{zoneAnnouncement === "DZ" ? "SPEED ZONE START" : "SPEED ZONE FINISH"}</span></div>}
                <section className="drive-readout">
                  <div>
                    <span>STAGE ODO</span>
                    <strong>{(displayedStageOdo / 1_000).toFixed(2)}</strong><small>km</small>
                    <div className="readout-meta"><span>STAGE TIME</span><b>{formatDuration(elapsedSeconds)}</b></div>
                  </div>
                  <div>
                    <span>SPEED</span>
                    <strong>{Math.round(displaySpeed)}</strong><small>km/h</small>
                    <div className="readout-meta"><span>GPS ACCURACY</span><b>{gpsAccuracy === null ? "—" : `±${Math.round(gpsAccuracy)}m`}</b></div>
                  </div>
                </section>
                {activeZoneDisplay && (() => {
                  const { zone, evidence } = activeZoneDisplay;
                  const zoneDistance = zone.officialDistanceKm
                    ? zone.officialDistanceKm * 1_000
                    : zone.finishDistance - zone.startDistance;
                  const target = zoneDistance / (zone.speedLimitKph / 3.6);
                  const remaining = evidence.phase === "ACTIVE"
                    ? zone.finishDistance - extrapolatedRouteDistance
                    : zone.startDistance - extrapolatedRouteDistance;
                  return <section className={`live-zone ${evidence.phase.toLowerCase()} ${evidence.phase === "ACTIVE" && displaySpeed > zone.speedLimitKph + 1 ? "over" : ""}`}>
                    <div><span>{zone.name}</span><strong>{evidence.phase === "ARMED" ? "DZ AHEAD" : evidence.phase === "ACTIVE" ? "DZ ACTIVE" : "FZ COMPLETE"}</strong><b>{routeReliable ? formatDistance(remaining) : "POSITION ?"}</b></div>
                    <div><span>LIMIT</span><strong>{zone.speedLimitKph}</strong><small>km/h</small></div>
                    <div><span>{evidence.phase === "ACTIVE" ? "ZONE TIME" : "TARGET"}</span><strong>{formatDuration(evidence.elapsedSeconds ?? target)}</strong>{evidence.phase === "ACTIVE" && <small>/ {formatDuration(target)}</small>}</div>
                  </section>;
                })()}

                {match.status === "OFF_ROUTE" || match.status === "REJOIN_CONFIRMATION" ? (
                  <section className="recovery-card rally-primary">
                    <span>{match.status === "REJOIN_CONFIRMATION" ? "REJOIN FOUND" : "OFF ROUTE"}</span>
                    <div className="recovery-arrow">{recovery.arrow}</div>
                    <strong>{recovery.label}</strong>
                    <b>{formatDistance(match.nearestOffset)} TO GPX</b>
                    <small>BEARING ONLY · CHOOSE A SAFE ROAD</small>
                    {match.status === "REJOIN_CONFIRMATION" && (
                      <button onClick={acceptRejoin}>ACCEPT REJOIN · {((match.rejoinDistance || 0) / 1_000).toFixed(2)} KM</button>
                    )}
                  </section>
                ) : (
                  <section className={`turn-card rally-primary ${!routeReliable ? "unreliable" : ""}`}>
                    <div className="turn-meta"><span>{turnActive ? "UPCOMING TURN" : "CONTINUE"}</span></div>
                    <div className="turn-main"><div className="turn-arrow">{turnArrow}</div><div><strong>{turnActive && upcomingTurn ? `${upcomingTurn.severity} ${upcomingTurn.direction}` : "CONTINUE"}</strong><b>{!routeReliable ? "DISTANCE UNRELIABLE" : upcomingTurn ? formatDistance(Math.max(0, turnDistance || 0)) : "ROUTE COMPLETE"}</b></div></div>
                  </section>
                )}

                <div className="lower-calls">
                  <section className="next-card"><span>NEXT</span><strong>{followingTurn ? `${followingTurn.severity} ${followingTurn.direction}` : "NO FOLLOWING CALL"}</strong><b>{followingTurn && upcomingTurn ? `+${formatDistance(followingTurn.distance - upcomingTurn.distance)}` : "—"}</b></section>
                  <section className="roadbook-card"><span>ROADBOOK</span><strong>{nextInstruction?.number || "FINISH"}</strong><p>{nextInstruction?.note || nextInstruction?.label || "Use physical roadbook"}</p><b>{routeReliable && nextInstruction ? formatDistance(nextInstruction.routeDistance - extrapolatedRouteDistance) : "UNRELIABLE"}</b></section>
                </div>

                <div className="rally-actions">
                  <button className="correction-action" onClick={openCorrection}>SET ODO</button>
                  <button className={`hold-end-action ${endHoldActive ? "holding" : ""}`} onPointerDown={beginEndHold} onPointerUp={cancelEndHold} onPointerLeave={cancelEndHold} onPointerCancel={cancelEndHold} onContextMenu={(event) => event.preventDefault()}>{endHoldActive ? "KEEP HOLDING…" : "HOLD 1 SEC TO END"}</button>
                </div>
              </>
            )}
            {stageStatus === "finished" && stageSummary && (
              <section className="summary-card"><span>STAGE COMPLETE</span><h2>{stageSummary.stageName}</h2><div className="summary-time"><small>STAGE TIME</small><strong>{formatDuration(stageSummary.elapsedSeconds)}</strong></div><div className="metric-grid four"><div><span>DISTANCE</span><strong>{(stageSummary.actualDistanceM / 1_000).toFixed(2)}</strong><small>km</small></div><div><span>ROUTE</span><strong>{(stageSummary.routeDistanceM / 1_000).toFixed(2)}</strong><small>km</small></div><div><span>AVERAGE</span><strong>{stageSummary.averageSpeedKph.toFixed(1)}</strong><small>km/h</small></div><div><span>TOP</span><strong>{stageSummary.testMode ? "—" : Math.round(stageSummary.topSpeedKph)}</strong><small>{stageSummary.testMode ? "SIM" : "km/h"}</small></div></div><div className="two-actions"><button className="secondary-action" onClick={() => setTab("controls")}>RUN LOGS</button><button className="primary-action" onClick={resetForNewLeg}>NEW LEG</button></div></section>
            )}
          </div>
        )}

        {tab === "controls" && (
          <div className="screen-stack">
            <section className="panel"><div className="panel-heading"><div><span>TESTING</span><h2>Replay chosen stage</h2></div></div><p className="body-copy">Runs the selected stage through the same event and zone engine without GPS.</p><button className="full-secondary" disabled={!selectedRoute || setupLocked} onClick={() => void beginStage("test")}>TEST CHOSEN STAGE</button></section>
            <section className="panel"><div className="panel-heading"><div><span>LIVE CORRECTION</span><h2>ODO and roadbook</h2></div></div>{session ? <><div className="control-readout"><div><span>STAGE ODO</span><strong>{(displayedStageOdo / 1_000).toFixed(2)}</strong></div><div><span>ROADBOOK</span><strong>{currentInstruction?.number || "—"} → {nextInstruction?.number || "FINISH"}</strong></div></div><button className="full-secondary" disabled={stageStatus !== "running"} onClick={openCorrection}>SET ODO / INSTRUCTION</button></> : <div className="empty-state compact"><strong>No active stage</strong><p>Corrections become available after starting.</p></div>}</section>
            <section className="panel"><div className="panel-heading"><div><span>POSITION</span><h2>GNSS and route match</h2></div></div><div className="control-readout"><div><span>GNSS</span><strong>{gpsLabel}</strong></div><div><span>MATCH</span><strong>{match.status}</strong></div><div><span>OFF ROUTE</span><strong>{formatDistance(match.nearestOffset)}</strong></div><div><span>WAKE LOCK</span><strong>{wakeStatus.toUpperCase()}</strong></div></div>{gpsError && <div className="error-banner">{gpsError}</div>}{match.status === "REJOIN_CONFIRMATION" && <button className="primary-action" onClick={acceptRejoin}>ACCEPT REJOIN</button>}</section>
            <section className="panel"><div className="panel-heading"><div><span>RUN HISTORY</span><h2>Persistent logs</h2></div><button onClick={() => void refreshRuns()}>REFRESH</button></div>{!runs.length ? <div className="empty-state compact"><strong>No stored runs</strong></div> : <div className="run-list">{runs.map((run) => <article key={run.id}><div><strong>{run.stageName}</strong><span>{new Date(run.startedAt).toLocaleString([], { hour12: false })}</span><b>{run.status} · {run.buildId}</b></div><div><button onClick={() => void exportRun(run)}>EXPORT</button><button className="danger" disabled={run.id === session?.runId && stageStatus !== "finished"} onClick={() => void deleteStoredRun(run)}>DELETE</button></div></article>)}</div>}</section>
            {stageStatus === "running" && <section className="panel danger-panel"><div className="panel-heading"><div><span>STAGE CONTROL</span><h2>End current stage</h2></div></div><p>Use the one-second hold button on Rally mode to close the run safely.</p><button onClick={() => setTab("rally")}>RETURN TO RALLY</button></section>}
          </div>
        )}
      </section>

      {correctionOpen && session && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <section className="correction-modal"><div className="modal-title"><div><span>LIVE CORRECTION</span><h2>Known-point reset</h2></div><button onClick={() => setCorrectionOpen(false)}>×</button></div><label className="field">OFFICIAL STAGE ODO · KM<input type="number" step="0.01" value={odoCorrection} onChange={(event) => setOdoCorrection(event.target.value)} /></label><div className="two-actions"><button className="secondary-action" onClick={() => applyOdoCorrection(false)}>SET DISPLAY ODO</button><button className="primary-action" onClick={() => applyOdoCorrection(true)}>SET ODO + ROUTE</button></div><p className="helper">Use ODO + ROUTE only at a known roadbook point. It deliberately records skipped events.</p><label className="field">NEXT ROADBOOK INSTRUCTION<select value={instructionCorrection} onChange={(event) => setInstructionCorrection(event.target.value)}>{activeInstructions.map((instruction) => <option key={instruction.id} value={instruction.id}>{instruction.number} · {instruction.label}</option>)}</select></label><button className="full-secondary" onClick={applyInstructionCorrection}>SET INSTRUCTION ONLY</button></section>
        </div>
      )}
    </main>
  );
}

