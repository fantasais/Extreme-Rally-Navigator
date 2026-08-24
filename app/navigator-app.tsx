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
type TurnCall = {
  distance: number;
  direction: "LEFT" | "RIGHT";
  severity: "GENTLE" | "MEDIUM" | "SHARP" | "HAIRPIN";
  angle: number;
};
type StageStatus = "waiting" | "running" | "finished";
type GpsStatus = "idle" | "acquiring" | "ready" | "error";

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

const formatCountdown = (milliseconds: number) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return hours
    ? `${hours.toString().padStart(2, "0")}:${minutes
        .toString()
        .padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`
    : `${minutes.toString().padStart(2, "0")}:${remainingSeconds
        .toString()
        .padStart(2, "0")}`;
};

const shortInstruction = (label: string) => {
  const numericSuffix = label.match(/(\d{1,3})$/)?.[1];
  return numericSuffix || label;
};

const usefulNote = (instruction?: Instruction) =>
  instruction && instruction.note !== GENERIC_NOTE ? instruction.note : "";

const defaultStartTime = () => {
  const value = new Date(Date.now() + 5 * 60_000);
  value.setSeconds(0, 0);
  return `${value.getHours().toString().padStart(2, "0")}:${value
    .getMinutes()
    .toString()
    .padStart(2, "0")}:00`;
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

  return {
    name: fileName.replace(/\.gpx$/i, ""),
    points,
    instructions,
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

function buildTurnCalls(route: Route, sensitivity: string): TurnCall[] {
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
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selected, setSelected] = useState(0);
  const route = routes[selected];
  const [screen, setScreen] = useState<"setup" | "stage">("setup");
  const [stageStatus, setStageStatus] =
    useState<StageStatus>("waiting");
  const [officialStart, setOfficialStart] = useState(defaultStartTime);
  const [startTimestamp, setStartTimestamp] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [progress, setProgress] = useState(0);
  const [testMode, setTestMode] = useState(false);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("idle");
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState("");
  const [offRouteDistance, setOffRouteDistance] = useState(0);
  const [setupError, setSetupError] = useState("");
  const [sensitivity, setSensitivity] = useState("balanced");
  const [zone, setZone] = useState<Zone>({
    start: "",
    finish: "",
    speed: 30,
  });
  const [zoneStartedAt, setZoneStartedAt] = useState<number | null>(null);
  const [zoneElapsed, setZoneElapsed] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const watchRef = useRef<number | null>(null);

  const turnCalls = useMemo(
    () => (route ? buildTurnCalls(route, sensitivity) : []),
    [route, sensitivity],
  );

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  useEffect(
    () => () => {
      if (watchRef.current !== null) {
        navigator.geolocation.clearWatch(watchRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!route) return;
    setProgress(0);
    const dz = route.instructions.find((instruction) =>
      /\bDZ\b/i.test(`${instruction.label} ${instruction.note}`),
    );
    const fz = route.instructions.find(
      (instruction) =>
        instruction.distance > (dz?.distance ?? -1) &&
        /\bFZ\b/i.test(`${instruction.label} ${instruction.note}`),
    );
    setZone({
      start: dz?.id || "",
      finish: fz?.id || "",
      speed: 30,
    });
  }, [route]);

  useEffect(() => {
    if (screen !== "stage") return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [screen]);

  useEffect(() => {
    if (
      screen === "stage" &&
      stageStatus === "waiting" &&
      startTimestamp !== null &&
      now >= startTimestamp
    ) {
      setStageStatus("running");
    }
  }, [screen, stageStatus, startTimestamp, now]);

  useEffect(() => {
    if (
      screen !== "stage" ||
      !testMode ||
      stageStatus !== "running" ||
      !route
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      setProgress((previous) => {
        const step = Math.max(1, route.points.length / 240);
        if (previous + step >= route.points.length - 1) {
          setStageStatus("finished");
          return route.points.length - 1;
        }
        return previous + step;
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, [screen, testMode, stageStatus, route]);

  const stopGps = () => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
    setGpsStatus("idle");
  };

  const startGps = () => {
    if (!route) return;
    if (!navigator.geolocation) {
      setGpsStatus("error");
      setGpsError("GPS is unavailable on this device");
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

  const leaveStage = () => {
    stopGps();
    setScreen("setup");
    setStageStatus("waiting");
    setTestMode(false);
    setStartTimestamp(null);
    setZoneStartedAt(null);
    setZoneElapsed(0);
  };

  const load = async (files: FileList | null) => {
    if (!files) return;
    const parsed: Route[] = [];
    for (const file of [...files]) {
      try {
        parsed.push(parseGpx(await file.text(), file.name));
      } catch (error) {
        alert(`${file.name}: ${(error as Error).message}`);
      }
    }
    if (parsed.length) {
      const firstNewRoute = routes.length;
      setRoutes((previous) => [...previous, ...parsed]);
      setSelected(firstNewRoute);
      setSetupError("");
      setOfficialStart(defaultStartTime());
    }
  };

  const armStage = () => {
    if (!route) {
      setSetupError("Upload a GPX file first");
      return;
    }
    const values = officialStart.split(":").map(Number);
    if (values.length < 2 || values.some(Number.isNaN)) {
      setSetupError("Enter a valid official start time");
      return;
    }
    const start = new Date();
    start.setHours(values[0], values[1], values[2] || 0, 0);
    if (start.getTime() <= Date.now()) {
      setSetupError("That start time has already passed");
      return;
    }

    setSetupError("");
    setProgress(0);
    setTestMode(false);
    setStartTimestamp(start.getTime());
    setNow(Date.now());
    setStageStatus("waiting");
    setScreen("stage");
    startGps();
  };

  const testWithoutDriving = () => {
    if (!route) return;
    stopGps();
    setProgress(0);
    setTestMode(true);
    setStartTimestamp(Date.now());
    setNow(Date.now());
    setStageStatus("running");
    setScreen("stage");
  };

  const pointIndex = route
    ? Math.min(route.points.length - 1, Math.floor(progress))
    : 0;
  const routeDistance = route ? route.points[pointIndex].distance : 0;
  const stageElapsed =
    startTimestamp === null ? 0 : Math.max(0, (now - startTimestamp) / 1000);

  const nextTurnIndex = turnCalls.findIndex(
    (turn) => turn.distance > routeDistance + 8,
  );
  const upcomingTurn =
    nextTurnIndex >= 0 ? turnCalls[nextTurnIndex] : undefined;
  const followingTurn =
    nextTurnIndex >= 0 ? turnCalls[nextTurnIndex + 1] : undefined;
  const nextOfficial = route?.instructions.find(
    (instruction) => instruction.distance > routeDistance + 5,
  );

  const zoneStart = route?.instructions.find(
    (instruction) => instruction.id === zone.start,
  )?.distance;
  const zoneFinish = route?.instructions.find(
    (instruction) => instruction.id === zone.finish,
  )?.distance;
  const zoneReady =
    zoneStart !== undefined &&
    zoneFinish !== undefined &&
    zoneFinish > zoneStart;
  const zoneDistance = zone.officialDistance
    ? zone.officialDistance * 1000
    : zoneReady
      ? zoneFinish - zoneStart
      : 0;
  const zoneTarget = zoneDistance / (zone.speed / 3.6);
  const zoneState = !zoneReady
    ? "OFF"
    : routeDistance < zoneStart
      ? "ARMED"
      : routeDistance >= zoneFinish
        ? "COMPLETE"
        : "ACTIVE";

  useEffect(() => {
    if (stageStatus !== "running" || testMode || !zoneReady) return;
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
    testMode,
    zoneReady,
    zoneState,
    zoneStartedAt,
  ]);

  useEffect(() => {
    if (
      stageStatus !== "running" ||
      testMode ||
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
  }, [stageStatus, testMode, zoneState, zoneStartedAt]);

  const simulatedZoneElapsed =
    testMode && zoneState === "ACTIVE"
      ? (routeDistance - zoneStart!) / (zone.speed / 3.6)
      : testMode && zoneState === "COMPLETE"
        ? zoneTarget
        : zoneElapsed;
  const zoneApproaching =
    zoneState === "ARMED" &&
    zoneStart !== undefined &&
    zoneStart - routeDistance <= 500;
  const showZone =
    zoneState === "ACTIVE" ||
    zoneApproaching ||
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

  if (screen === "stage" && route) {
    if (stageStatus === "waiting") {
      return (
        <main className="shell stage-shell">
          <header className="stage-topbar">
            <button className="exit-button" onClick={leaveStage}>
              CANCEL
            </button>
            <strong>{route.name}</strong>
            <span>ARMED</span>
          </header>

          <section className="countdown-screen">
            <p>OFFICIAL START</p>
            <h1>{officialStart}</h1>
            <div className="countdown">
              {formatCountdown((startTimestamp || 0) - now)}
            </div>
            <span>STARTS AUTOMATICALLY AT ZERO</span>

            <div className={`gps-readiness ${gpsStatus}`}>
              <i />
              <div>
                <strong>
                  {gpsStatus === "ready"
                    ? "GPS READY"
                    : gpsStatus === "error"
                      ? "GPS ERROR"
                      : "ACQUIRING GPS"}
                </strong>
                <small>
                  {gpsStatus === "ready"
                    ? `Accuracy ±${Math.round(gpsAccuracy || 0)} m`
                    : gpsError || "Keep the phone where it has a clear sky view"}
                </small>
              </div>
            </div>

            <div className="first-call">
              <small>FIRST GENERATED CALL</small>
              <strong>
                {turnCalls[0]
                  ? `${turnCalls[0].severity} ${turnCalls[0].direction}`
                  : "NO RELIABLE TURN FOUND"}
              </strong>
              <span>
                {turnCalls[0]
                  ? formatDistance(turnCalls[0].distance)
                  : "Check GPX track quality"}
              </span>
            </div>
          </section>
        </main>
      );
    }

    return (
      <main className="shell stage-shell running-stage">
        <header className="stage-topbar">
          <button className="exit-button" onClick={leaveStage}>
            {testMode ? "EXIT TEST" : "END"}
          </button>
          <strong>{route.name}</strong>
          <span className={testMode ? "test" : "live"}>
            {testMode ? "TEST" : "LIVE"}
          </span>
        </header>

        <section className="turn-screen">
          {offRouteDistance > 50 && !testMode && (
            <div className="off-route">
              OFF ROUTE · {formatDistance(offRouteDistance)}
            </div>
          )}

          <div className="stage-time">
            <span>STAGE TIME</span>
            <strong>{formatDuration(stageElapsed)}</strong>
            <small>
              {testMode
                ? "SIMULATED MOVEMENT"
                : gpsStatus === "ready"
                  ? `GPS ±${Math.round(gpsAccuracy || 0)} m`
                  : "GPS NOT READY"}
            </small>
          </div>

          <div className="turn-call">
            <span>UPCOMING TURN</span>
            <div className="turn-arrow">{turnArrow}</div>
            <h1>
              {stageStatus === "finished"
                ? "FINISH"
                : upcomingTurn
                  ? `${upcomingTurn.severity} ${upcomingTurn.direction}`
                  : "NO SIGNIFICANT TURN"}
            </h1>
            <strong className="turn-distance">
              {stageStatus === "finished"
                ? "—"
                : upcomingTurn
                  ? formatDistance(upcomingTurn.distance - routeDistance)
                  : "—"}
            </strong>
          </div>

          <div className="then-call">
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
          </div>

          {nextOfficial && (
            <div className="roadbook-strip">
              <span>ROADBOOK</span>
              <strong>{shortInstruction(nextOfficial.label)}</strong>
              <p>{usefulNote(nextOfficial) || "Use physical roadbook"}</p>
              <b>{formatDistance(nextOfficial.distance - routeDistance)}</b>
            </div>
          )}

          {showZone && (
            <div className={`zone-alert ${zoneState.toLowerCase()}`}>
              <div>
                <span>SPEED ZONE</span>
                <strong>{zoneState}</strong>
              </div>
              <b>{zone.speed}</b>
              <small>km/h</small>
              <div>
                <span>TIME</span>
                <strong>
                  {formatDuration(simulatedZoneElapsed)} /{" "}
                  {formatDuration(zoneTarget)}
                </strong>
              </div>
            </div>
          )}
        </section>
      </main>
    );
  }

  const selectedZoneStart = route?.instructions.find(
    (instruction) => instruction.id === zone.start,
  );
  const selectedZoneFinish = route?.instructions.find(
    (instruction) => instruction.id === zone.finish,
  );

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">XR</span>
          <span>RALLY NAVIGATOR</span>
          <em>v0.3</em>
        </div>
        <button
          className="primary import-button"
          onClick={() => fileRef.current?.click()}
        >
          ＋ UPLOAD GPX
        </button>
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
      </header>

      <section className="setup-page">
        {!route ? (
          <button
            className="empty-upload"
            onClick={() => fileRef.current?.click()}
          >
            <b>1</b>
            <strong>UPLOAD YOUR STAGE GPX</strong>
            <span>Track and instruction waypoints remain on this device.</span>
            <em>CHOOSE GPX FILE →</em>
          </button>
        ) : (
          <>
            {routes.length > 1 && (
              <label className="stage-select">
                SELECT STAGE
                <select
                  value={selected}
                  onChange={(event) => setSelected(Number(event.target.value))}
                >
                  {routes.map((stage, stageIndex) => (
                    <option key={`${stage.name}-${stageIndex}`} value={stageIndex}>
                      {stage.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <section className="route-panel">
              <div className="route-head">
                <div>
                  <span>GPX READY</span>
                  <h1>{route.name}</h1>
                </div>
                <button
                  className="replace-file"
                  onClick={() => fileRef.current?.click()}
                >
                  ADD
                </button>
              </div>
              <div className="route-summary">
                <span>{formatDistance(route.points.at(-1)!.distance)}</span>
                <span>{route.instructions.length} instructions</span>
                <span>{turnCalls.length} generated turns</span>
              </div>
              <div className="preview">
                <RoutePreview route={route} />
              </div>
              <p className="preview-note">
                Route preview only. This map is not shown during the stage.
              </p>
            </section>

            <section className="start-panel">
              <div className="step-number">2</div>
              <div>
                <label htmlFor="official-start">OFFICIAL START TIME</label>
                <input
                  id="official-start"
                  type="time"
                  step="1"
                  value={officialStart}
                  onChange={(event) => {
                    setOfficialStart(event.target.value);
                    setSetupError("");
                  }}
                />
                <small>
                  The countdown uses this phone&apos;s current clock.
                </small>
              </div>
            </section>

            {setupError && <div className="setup-error">{setupError}</div>}

            <button className="primary arm-button" onClick={armStage}>
              ARM STAGE
              <small>GPS prepares now · tracking starts at zero</small>
            </button>

            <button className="test-button" onClick={testWithoutDriving}>
              TEST WITHOUT DRIVING
              <small>Simulate the GPX and inspect upcoming-turn calls</small>
            </button>

            <details className="advanced">
              <summary>OPTIONAL SETTINGS</summary>
              <label>
                TURN DETAIL
                <select
                  value={sensitivity}
                  onChange={(event) => setSensitivity(event.target.value)}
                >
                  <option value="minimal">Minimal — major turns only</option>
                  <option value="balanced">Balanced</option>
                  <option value="detailed">Detailed — more calls</option>
                </select>
              </label>

              <div className="advanced-divider">
                SPEED CONTROL ZONE
              </div>

              <label>
                DZ INSTRUCTION
                <select
                  value={zone.start}
                  onChange={(event) =>
                    setZone({ ...zone, start: event.target.value })
                  }
                >
                  <option value="">Not configured</option>
                  {route.instructions.map((instruction) => (
                    <option key={instruction.id} value={instruction.id}>
                      {shortInstruction(instruction.label)}
                      {usefulNote(instruction)
                        ? ` · ${usefulNote(instruction)}`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                FZ INSTRUCTION
                <select
                  value={zone.finish}
                  onChange={(event) =>
                    setZone({ ...zone, finish: event.target.value })
                  }
                >
                  <option value="">Not configured</option>
                  {route.instructions.map((instruction) => (
                    <option key={instruction.id} value={instruction.id}>
                      {shortInstruction(instruction.label)}
                      {usefulNote(instruction)
                        ? ` · ${usefulNote(instruction)}`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>

              <div className="advanced-pair">
                <label>
                  SPEED LIMIT
                  <input
                    type="number"
                    min="1"
                    value={zone.speed}
                    onChange={(event) =>
                      setZone({
                        ...zone,
                        speed: Number(event.target.value) || 1,
                      })
                    }
                  />
                </label>
                <label>
                  OFFICIAL DISTANCE
                  <input
                    type="number"
                    step="0.01"
                    placeholder="Optional km"
                    value={zone.officialDistance || ""}
                    onChange={(event) =>
                      setZone({
                        ...zone,
                        officialDistance:
                          Number(event.target.value) || undefined,
                      })
                    }
                  />
                </label>
              </div>

              <p>
                {selectedZoneStart && selectedZoneFinish
                  ? `DZ ${shortInstruction(
                      selectedZoneStart.label,
                    )} → FZ ${shortInstruction(selectedZoneFinish.label)} · target ${formatDuration(zoneTarget)}`
                  : "DZ/FZ is optional and remains hidden during the stage until relevant."}
              </p>
            </details>

            <p className="disclaimer">
              Generated calls are route previews, not pace notes. The organiser
              roadbook and safety instructions remain authoritative.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
