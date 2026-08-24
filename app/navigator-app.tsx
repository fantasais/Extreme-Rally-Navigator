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
  sensitivity: "minimal" | "balanced" | "detailed";
  zone: Zone;
};
type TurnCall = {
  distance: number;
  direction: "LEFT" | "RIGHT";
  severity: "GENTLE" | "MEDIUM" | "SHARP" | "HAIRPIN";
  angle: number;
};
type ActiveStage = {
  routeId: string;
  config: RouteConfig;
  startTimestamp: number;
  testMode: boolean;
};
type Tab = "setup" | "rally" | "controls";
type StageStatus = "idle" | "armed" | "running" | "finished";
type GpsStatus = "off" | "acquiring" | "ready" | "error";
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const STORAGE_KEY = "xr-navigator-v0.4-routes";

const EARTH_RADIUS = 6_371_000;
const GENERIC_NOTE = "Roadbook instruction";

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

const bearing = (a: Point, b: Point) => {
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
      let nearestPoint = 0;
      let nearestDistance = Infinity;
      points.forEach((point, pointIndex) => {
        const separation = haversine(point, waypointPoint);
        if (separation < nearestDistance) {
          nearestDistance = separation;
          nearestPoint = pointIndex;
        }
      });
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
        distance: points[nearestPoint].distance,
        offset: nearestDistance,
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
    sensitivity: "balanced",
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

function buildTurnCalls(
  route: Route,
  sensitivity: RouteConfig["sensitivity"],
): TurnCall[] {
  const threshold =
    sensitivity === "detailed" ? 18 : sensitivity === "minimal" ? 46 : 28;
  const totalDistance = route.points.at(-1)!.distance;
  const window = 45;
  const candidates: TurnCall[] = [];

  for (
    let sampleDistance = window;
    sampleDistance < totalDistance - window;
    sampleDistance += 20
  ) {
    const beforeIndex = pointIndexAtDistance(
      route.points,
      sampleDistance - window,
    );
    const centreIndex = pointIndexAtDistance(route.points, sampleDistance);
    const afterIndex = pointIndexAtDistance(
      route.points,
      sampleDistance + window,
    );
    if (
      beforeIndex === centreIndex ||
      centreIndex === afterIndex ||
      afterIndex >= route.points.length
    ) {
      continue;
    }

    const previousGap =
      route.points[centreIndex].distance -
      route.points[Math.max(0, centreIndex - 1)].distance;
    const nextGap =
      route.points[Math.min(route.points.length - 1, centreIndex + 1)]
        .distance - route.points[centreIndex].distance;
    if (Math.max(previousGap, nextGap) > 180) continue;

    const turn = signedAngle(
      bearing(route.points[beforeIndex], route.points[centreIndex]),
      bearing(route.points[centreIndex], route.points[afterIndex]),
    );
    const magnitude = Math.abs(turn);
    if (magnitude < threshold) continue;

    candidates.push({
      distance: sampleDistance,
      direction: turn > 0 ? "RIGHT" : "LEFT",
      severity:
        magnitude >= 110
          ? "HAIRPIN"
          : magnitude >= 65
            ? "SHARP"
            : magnitude >= 35
              ? "MEDIUM"
              : "GENTLE",
      angle: magnitude,
    });
  }

  const merged: TurnCall[] = [];
  candidates.forEach((candidate) => {
    const previous = merged.at(-1);
    if (
      previous &&
      previous.direction === candidate.direction &&
      candidate.distance - previous.distance < 120
    ) {
      if (candidate.angle > previous.angle) {
        previous.angle = candidate.angle;
        previous.severity = candidate.severity;
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
  const [gpsError, setGpsError] = useState("");
  const [offRouteDistance, setOffRouteDistance] = useState(0);
  const [setupError, setSetupError] = useState("");
  const [zoneStartedAt, setZoneStartedAt] = useState<number | null>(null);
  const [zoneElapsed, setZoneElapsed] = useState(0);
  const [installPrompt, setInstallPrompt] =
    useState<InstallPromptEvent | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const watchRef = useRef<number | null>(null);

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

  const selectedTurnCalls = useMemo(
    () =>
      selectedRoute && selectedConfig
        ? buildTurnCalls(selectedRoute, selectedConfig.sensitivity)
        : [],
    [selectedRoute, selectedConfig],
  );
  const activeTurnCalls = useMemo(
    () =>
      activeRoute && activeConfig
        ? buildTurnCalls(activeRoute, activeConfig.sensitivity)
        : [],
    [activeRoute, activeConfig],
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
      const saved = window.localStorage.getItem(STORAGE_KEY);
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
    },
    [],
  );

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
        const step = Math.max(1, activeRoute.points.length / 240);
        if (previous + step >= activeRoute.points.length - 1) {
          setStageStatus("finished");
          return activeRoute.points.length - 1;
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

  const stopGps = () => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
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
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const here = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        let nearestPoint = 0;
        let nearestDistance = Infinity;
        route.points.forEach((point, pointIndex) => {
          const separation = haversine(point, here);
          if (separation < nearestDistance) {
            nearestDistance = separation;
            nearestPoint = pointIndex;
          }
        });
        setProgress(nearestPoint);
        setOffRouteDistance(nearestDistance);
        setGpsAccuracy(position.coords.accuracy);
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
    setZoneElapsed(0);
    setZoneStartedAt(null);
    setNow(Date.now());
    setStageStatus(mode === "armed" ? "armed" : "running");
    setTab("rally");
    if (mode !== "test") startGps(selectedRoute);
  };

  const endStage = () => {
    stopGps();
    setActiveStage(null);
    setStageStatus("idle");
    setProgress(0);
    setZoneElapsed(0);
    setZoneStartedAt(null);
    setTab("setup");
  };

  const installApp = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  const pointIndex = activeRoute
    ? Math.min(activeRoute.points.length - 1, Math.floor(progress))
    : 0;
  const routeDistance = activeRoute
    ? activeRoute.points[pointIndex].distance
    : 0;
  const stageElapsed = activeStage
    ? Math.max(0, (now - activeStage.startTimestamp) / 1000)
    : 0;
  const nextTurnIndex = activeTurnCalls.findIndex(
    (turn) => turn.distance > routeDistance + 8,
  );
  const upcomingTurn =
    nextTurnIndex >= 0 ? activeTurnCalls[nextTurnIndex] : undefined;
  const followingTurn =
    nextTurnIndex >= 0 ? activeTurnCalls[nextTurnIndex + 1] : undefined;
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

  const turnArrow = upcomingTurn
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
    setProgress(activeRoute.instructions[targetIndex].point);
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
    <main className="app-shell">
      <header className="topbar">
        <div className="app-brand">
          <span>EXTREME RALLY V0.4</span>
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
                <button
                  className="small-action"
                  disabled={setupLocked}
                  onClick={() => fileRef.current?.click()}
                >
                  + UPLOAD GPX
                </button>
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
                  <span>TURN ASSIST</span>
                  <h2>Generated route calls</h2>
                </div>
              </div>

              <div className="choice-row">
                {(["minimal", "balanced", "detailed"] as const).map(
                  (choice) => (
                    <button
                      key={choice}
                      disabled={!selectedConfig || setupLocked}
                      className={
                        selectedConfig?.sensitivity === choice ? "active" : ""
                      }
                      onClick={() =>
                        updateSelectedConfig((current) => ({
                          ...current,
                          sensitivity: choice,
                        }))
                      }
                    >
                      {choice.toUpperCase()}
                    </button>
                  ),
                )}
              </div>
              <p className="helper-copy left">
                Balanced calls meaningful bends without constant chatter.
                Minimal keeps only major direction changes.
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

            {(stageStatus === "running" ||
              stageStatus === "finished") &&
              activeStage &&
              activeRoute && (
                <>
                  {offRouteDistance > 50 && !activeStage.testMode && (
                    <div className="off-route-banner">
                      OFF ROUTE · {formatDistance(offRouteDistance)}
                    </div>
                  )}

                  <section className="timing-card">
                    <div>
                      <span>STAGE TIME</span>
                      <strong>{formatDuration(stageElapsed)}</strong>
                    </div>
                    <div>
                      <span>MODE</span>
                      <strong>
                        {activeStage.testMode ? "TEST" : "LIVE"}
                      </strong>
                    </div>
                    <div>
                      <span>GPS</span>
                      <strong>
                        {activeStage.testMode
                          ? "SIM"
                          : gpsStatus === "ready"
                            ? `±${Math.round(gpsAccuracy || 0)}m`
                            : "—"}
                      </strong>
                    </div>
                  </section>

                  <section className="turn-card">
                    <span>UPCOMING TURN</span>
                    <div className="turn-arrow">{turnArrow}</div>
                    <h2>
                      {stageStatus === "finished"
                        ? "FINISH"
                        : upcomingTurn
                          ? `${upcomingTurn.severity} ${upcomingTurn.direction}`
                          : "NO SIGNIFICANT TURN"}
                    </h2>
                    <strong>
                      {stageStatus === "finished"
                        ? "—"
                        : upcomingTurn
                          ? formatDistance(
                              upcomingTurn.distance - routeDistance,
                            )
                          : "—"}
                    </strong>
                  </section>

                  <section className="next-card">
                    <span>THEN</span>
                    <strong>
                      {followingTurn
                        ? `${followingTurn.severity} ${followingTurn.direction}`
                        : "NO FOLLOWING CALL"}
                    </strong>
                    <b>
                      {followingTurn && upcomingTurn
                        ? `+${formatDistance(
                            followingTurn.distance - upcomingTurn.distance,
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
                        {formatDistance(
                          nextInstruction.distance - routeDistance,
                        )}
                      </b>
                    </section>
                  )}

                  {showZone && activeZone && (
                    <section
                      className={`speed-zone-card ${zoneState.toLowerCase()}`}
                    >
                      <div>
                        <span>SPEED ZONE</span>
                        <strong>{zoneState}</strong>
                      </div>
                      <b>{activeZone.speed}</b>
                      <small>km/h</small>
                      <div>
                        <span>TIME</span>
                        <strong>
                          {formatDuration(displayedZoneElapsed)} /{" "}
                          {formatDuration(zoneTarget)}
                        </strong>
                      </div>
                    </section>
                  )}
                </>
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
                      onClick={() => jumpInstruction(-1)}
                    >
                      ← PREVIOUS
                    </button>
                    <button
                      className="secondary-action"
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
                  <span>SESSION</span>
                  <h2>Stage control</h2>
                </div>
              </div>
              <button
                className="danger-action"
                disabled={stageStatus === "idle"}
                onClick={endStage}
              >
                END AND RESET STAGE
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
