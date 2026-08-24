"use client";

import {
  ChangeEvent,
  DragEvent,
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
  source: string;
};
type Zone = {
  start: string;
  finish: string;
  speed: number;
  officialDistance?: number;
};

const R = 6_371_000;
const GENERIC_NOTE = "Roadbook instruction";

const hav = (
  a: Pick<Point, "lat" | "lon">,
  b: Pick<Point, "lat" | "lon">,
) => {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dp = ((b.lat - a.lat) * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  const x =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

const bearing = (a: Point, b: Point) => {
  const p1 = (a.lat * Math.PI) / 180;
  const p2 = (b.lat * Math.PI) / 180;
  const dl = ((b.lon - a.lon) * Math.PI) / 180;
  return (
    (Math.atan2(
      Math.sin(dl) * Math.cos(p2),
      Math.cos(p1) * Math.sin(p2) -
        Math.sin(p1) * Math.cos(p2) * Math.cos(dl),
    ) *
      180) /
      Math.PI +
    360
  ) % 360;
};

const angle = (a: number, b: number) => ((b - a + 540) % 360) - 180;
const fmtDist = (m: number) =>
  m >= 1000
    ? `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`
    : `${Math.max(0, Math.round(m))} m`;
const fmtTime = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;
const usefulNote = (instruction?: Instruction) =>
  instruction && instruction.note !== GENERIC_NOTE ? instruction.note : "";
const optionText = (instruction: Instruction) => {
  const note = usefulNote(instruction);
  return note ? `${instruction.label} · ${note}` : instruction.label;
};

function demo(): Route {
  const raw = [
    [30.742, 76.765, 530],
    [30.744, 76.766, 535],
    [30.746, 76.768, 545],
    [30.747, 76.772, 555],
    [30.75, 76.775, 570],
    [30.754, 76.774, 590],
    [30.757, 76.77, 610],
    [30.76, 76.768, 625],
    [30.764, 76.769, 650],
    [30.767, 76.773, 670],
    [30.769, 76.778, 660],
    [30.772, 76.781, 645],
    [30.775, 76.78, 635],
    [30.778, 76.776, 620],
    [30.781, 76.773, 610],
    [30.785, 76.775, 600],
  ];
  let distance = 0;
  const points: Point[] = raw.map((value, index) => {
    if (index) {
      distance += hav(
        { lat: raw[index - 1][0], lon: raw[index - 1][1] },
        { lat: value[0], lon: value[1] },
      );
    }
    return {
      lat: value[0],
      lon: value[1],
      ele: value[2],
      distance,
    };
  });
  const specs: [number, string, string][] = [
    [0, "001", "START — proceed north"],
    [3, "002", "Keep RIGHT at fork"],
    [5, "003", "Turn LEFT, uphill trail"],
    [8, "004", "CAUTION — sharp right"],
    [10, "005", "DZ 30 km/h"],
    [14, "006", "FZ — speed zone ends"],
  ];
  return {
    name: "SJOBA-style demo stage",
    points,
    instructions: specs.map(([point, label, note]) => ({
      id: `demo-${label}`,
      label,
      note,
      point,
      distance: points[point].distance,
    })),
    source: "Built-in replay",
  };
}

function parseGpx(text: string, fileName: string): Route {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Invalid GPX file");

  const trackPoints = [...xml.getElementsByTagNameNS("*", "trkpt")];
  const routePoints = [...xml.getElementsByTagNameNS("*", "rtept")];
  const nodes = trackPoints.length ? trackPoints : routePoints;
  if (nodes.length < 2) throw new Error("No usable track found");

  let distance = 0;
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
    if (previous) distance += hav(previous, point);
    point.distance = distance;
    points.push(point);
  });

  const instructions = [...xml.getElementsByTagNameNS("*", "wpt")]
    .map((waypoint, waypointIndex) => {
      const waypointPoint = {
        lat: Number(waypoint.getAttribute("lat")),
        lon: Number(waypoint.getAttribute("lon")),
      };
      let best = 0;
      let bestDistance = Infinity;
      points.forEach((point, pointIndex) => {
        const separation = hav(point, waypointPoint);
        if (separation < bestDistance) {
          bestDistance = separation;
          best = pointIndex;
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
        point: best,
        distance: points[best].distance,
        offset: bestDistance,
      };
    })
    .filter((instruction) => instruction.offset < 300)
    .sort((a, b) => a.distance - b.distance)
    .map(({ offset: _offset, ...instruction }) => instruction);

  return {
    name: fileName.replace(/\.gpx$/i, ""),
    points,
    instructions,
    source: "Imported GPX",
  };
}

function MiniMap({
  route,
  index,
  overview = false,
}: {
  route: Route;
  index: number;
  overview?: boolean;
}) {
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
  const done = points
    .slice(0, index + 1)
    .map((point, pointIndex) =>
      `${pointIndex ? "L" : "M"} ${xy(point).join(" ")}`,
    )
    .join(" ");
  const car = xy(points[index] || points[0]);
  const currentInstructionIndex = Math.max(
    0,
    route.instructions.findLastIndex(
      (instruction) => instruction.point <= index,
    ),
  );
  const labelled = new Set(
    overview
      ? []
      : [
          route.instructions[currentInstructionIndex]?.id,
          route.instructions[currentInstructionIndex + 1]?.id,
        ],
  );

  return (
    <svg viewBox="0 0 600 280" className="map" aria-label="Rally route">
      <path d={path} className="route-shadow" />
      <path d={path} className="route-line" />
      <path d={done} className="route-done" />
      {route.instructions.map((instruction) => {
        const [x, y] = xy(points[instruction.point]);
        const isLabelled = labelled.has(instruction.id);
        return (
          <g key={instruction.id}>
            <circle
              cx={x}
              cy={y}
              r={isLabelled ? 7 : 3.5}
              className={
                instruction.point <= index ? "marker passed" : "marker"
              }
            />
            {isLabelled && <text x={x} y={y - 13}>{instruction.label}</text>}
          </g>
        );
      })}
      <circle cx={car[0]} cy={car[1]} r="9" className="car" />
      <path
        d={`M ${car[0]} ${car[1] - 15} l -5 9 h 10 z`}
        className="car-arrow"
      />
    </svg>
  );
}

export default function NavigatorApp() {
  const [routes, setRoutes] = useState<Route[]>([demo()]);
  const [selected, setSelected] = useState(0);
  const route = routes[selected];
  const [screen, setScreen] = useState<"setup" | "drive">("setup");
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [gpsError, setGpsError] = useState("");
  const [liveElapsed, setLiveElapsed] = useState(0);
  const [zoneStartedAt, setZoneStartedAt] = useState<number | null>(null);
  const [zone, setZone] = useState<Zone>({
    start: "demo-005",
    finish: "demo-006",
    speed: 30,
  });
  const [sensitivity, setSensitivity] = useState("balanced");
  const fileRef = useRef<HTMLInputElement>(null);
  const watchRef = useRef<number | null>(null);

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
    setProgress(0);
    setPlaying(false);
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
  }, [selected, route]);

  useEffect(() => {
    if (!playing || screen !== "drive") return;
    const timer = setInterval(
      () =>
        setProgress((previous) => {
          const step = Math.max(1, route.points.length / 180);
          if (previous + step >= route.points.length - 1) {
            setPlaying(false);
            return route.points.length - 1;
          }
          return previous + step;
        }),
      250,
    );
    return () => clearInterval(timer);
  }, [playing, screen, route]);

  const index = Math.min(route.points.length - 1, Math.floor(progress));
  const distance = route.points[index].distance;
  const instructionIndex = Math.max(
    0,
    route.instructions.findLastIndex(
      (instruction) => instruction.distance <= distance,
    ),
  );
  const current = route.instructions[instructionIndex];
  const next = route.instructions[instructionIndex + 1];

  const analysis = useMemo(() => {
    const ahead = Math.min(
      route.points.length - 1,
      index + Math.max(2, Math.floor(route.points.length / 28)),
    );
    const farther = Math.min(
      route.points.length - 1,
      ahead + Math.max(2, Math.floor(route.points.length / 35)),
    );
    const turn = angle(
      bearing(route.points[index], route.points[ahead]),
      bearing(route.points[ahead], route.points[farther]),
    );
    const thresholds =
      sensitivity === "detailed"
        ? [8, 22, 45]
        : sensitivity === "minimal"
          ? [20, 45, 80]
          : [12, 32, 65];
    const magnitude = Math.abs(turn);
    const grade =
      ((route.points[ahead].ele || 0) - (route.points[index].ele || 0)) /
      Math.max(1, route.points[ahead].distance - distance) *
      100;
    return {
      bend:
        magnitude < thresholds[0]
          ? "STRAIGHT"
          : `${turn > 0 ? "RIGHT" : "LEFT"} · ${
              magnitude > thresholds[2]
                ? "HAIRPIN"
                : magnitude > thresholds[1]
                  ? "SHARP"
                  : "MEDIUM"
            }`,
      grade:
        route.points[index].ele === undefined
          ? "NO ELEVATION"
          : Math.abs(grade) < 2
            ? "LEVEL"
            : `${grade > 0 ? "UPHILL" : "DOWNHILL"} · ${Math.abs(
                grade,
              ).toFixed(0)}%`,
      ahead: route.points[ahead].distance - distance,
    };
  }, [route, index, distance, sensitivity]);

  const zoneStart = route.instructions.find(
    (instruction) => instruction.id === zone.start,
  )?.distance;
  const zoneFinish = route.instructions.find(
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
  const target = zoneDistance / (zone.speed / 3.6);
  const zoneState = !zoneReady
    ? "OFF"
    : distance < zoneStart
      ? "ARMED"
      : distance >= zoneFinish
        ? "COMPLETE"
        : "ACTIVE";

  useEffect(() => {
    if (!tracking) return;
    if (zoneState === "OFF" || zoneState === "ARMED") {
      setZoneStartedAt(null);
      setLiveElapsed(0);
    } else if (zoneState === "ACTIVE" && zoneStartedAt === null) {
      setZoneStartedAt(Date.now());
    } else if (zoneState === "COMPLETE" && zoneStartedAt !== null) {
      setLiveElapsed((Date.now() - zoneStartedAt) / 1000);
      setZoneStartedAt(null);
    }
  }, [tracking, zoneState, zoneStartedAt]);

  useEffect(() => {
    if (!tracking || zoneState !== "ACTIVE" || zoneStartedAt === null) return;
    const timer = setInterval(
      () => setLiveElapsed((Date.now() - zoneStartedAt) / 1000),
      200,
    );
    return () => clearInterval(timer);
  }, [tracking, zoneState, zoneStartedAt]);

  const zoneElapsed =
    zoneState === "OFF"
      ? 0
      : tracking
        ? liveElapsed
        : zoneState === "ACTIVE"
          ? (distance - zoneStart!) / (zone.speed / 3.6)
          : zoneState === "COMPLETE"
            ? target
            : 0;

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
      setRoutes((previous) => [...previous, ...parsed]);
      setSelected(routes.length);
      setScreen("setup");
    }
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    void load(event.dataTransfer.files);
  };

  const jump = (direction: number) => {
    const targetIndex = Math.max(
      0,
      Math.min(route.instructions.length - 1, instructionIndex + direction),
    );
    setProgress(route.instructions[targetIndex]?.point || 0);
  };

  const stopGps = () => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
    }
    watchRef.current = null;
    setTracking(false);
  };

  const toggleGps = () => {
    if (tracking) {
      stopGps();
      return;
    }
    if (!navigator.geolocation) {
      setGpsError("GPS is unavailable in this browser");
      return;
    }
    setPlaying(false);
    setGpsError("");
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        setGpsAccuracy(position.coords.accuracy);
        const here = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        };
        let best = 0;
        let bestDistance = Infinity;
        route.points.forEach((point, pointIndex) => {
          const separation = hav(point, here);
          if (separation < bestDistance) {
            bestDistance = separation;
            best = pointIndex;
          }
        });
        setProgress(best);
        setTracking(true);
      },
      (error) => {
        setGpsError(error.message);
        stopGps();
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15_000 },
    );
  };

  if (screen === "drive") {
    const nextDistance = next ? Math.max(0, next.distance - distance) : 0;
    return (
      <main className="shell drive-shell">
        <header className="topbar drive-topbar">
          <button
            className="ghost back-button"
            onClick={() => {
              setPlaying(false);
              stopGps();
              setScreen("setup");
            }}
          >
            ←
          </button>
          <div className="drive-title">
            <strong>{route.name}</strong>
            <span className={playing || tracking ? "live" : ""}>
              {tracking
                ? `LIVE GPS${gpsAccuracy ? ` · ±${Math.round(gpsAccuracy)} m` : ""}`
                : playing
                  ? "REPLAY RUNNING"
                  : gpsError
                    ? `GPS: ${gpsError}`
                    : "STAGE PAUSED"}
            </span>
          </div>
          <span className="version">v0.2</span>
        </header>

        <section className="drive-page">
          <div className="current-strip">
            <span>CURRENT</span>
            <strong>{current?.label || "TRACK"}</strong>
            <p>{usefulNote(current) || "Follow physical roadbook"}</p>
          </div>

          <div className="next-hero">
            <div>
              <span>NEXT {next?.label || "FINISH"}</span>
              <p>{usefulNote(next) || (next ? "Physical roadbook instruction" : "Stage finish")}</p>
            </div>
            <strong>{next ? fmtDist(nextDistance) : "—"}</strong>
          </div>

          <div className="map-panel">
            <MiniMap route={route} index={index} />
            <div className="map-chips">
              <span>
                {fmtDist(distance)} / {fmtDist(route.points.at(-1)!.distance)}
              </span>
              <span>
                {route.points[index].ele
                  ? `${Math.round(route.points[index].ele!)} m ALT`
                  : "NO ELEVATION"}
              </span>
            </div>
          </div>

          <div className="prediction">
            <div>
              <small>ROAD AHEAD · {fmtDist(analysis.ahead)}</small>
              <strong>{analysis.bend}</strong>
            </div>
            <div>
              <small>TERRAIN</small>
              <strong>{analysis.grade}</strong>
            </div>
          </div>

          {zoneState !== "OFF" && (
            <div className={`zone-card ${zoneState.toLowerCase()}`}>
              <div>
                <small>SPEED ZONE</small>
                <strong>{zoneState}</strong>
              </div>
              <div className="zone-speed">
                {zone.speed}
                <small>km/h</small>
              </div>
              <div>
                <small>TIME</small>
                <strong>
                  {fmtTime(zoneElapsed)} / {fmtTime(target)}
                </strong>
              </div>
            </div>
          )}
        </section>

        <div className="drive-controls">
          <button onClick={() => jump(-1)}>← PREV</button>
          <button
            onClick={toggleGps}
            className={tracking ? "gps-on" : ""}
          >
            {tracking ? "STOP GPS" : "◎ LIVE GPS"}
          </button>
          <button
            className="primary"
            onClick={() => {
              stopGps();
              setPlaying((value) => !value);
            }}
          >
            {playing ? "PAUSE" : "▶ REPLAY"}
          </button>
          <button onClick={() => jump(1)}>NEXT →</button>
        </div>
      </main>
    );
  }

  const quality = route.instructions.length
    ? route.instructions.some(
        (instruction) => instruction.note !== GENERIC_NOTE,
      )
      ? "INSTRUCTION-RICH"
      : "NUMBERED WAYPOINTS"
    : "TRACK ONLY";

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">XR</span>
          <span>RALLY NAVIGATOR</span>
          <em>v0.2</em>
        </div>
        <button className="primary import-button" onClick={() => fileRef.current?.click()}>
          ＋ IMPORT
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
        <div className="section-heading">
          <span>STAGES</span>
          <b>{routes.length}</b>
        </div>

        <div
          className="stage-strip"
          onDragOver={(event) => event.preventDefault()}
          onDrop={drop}
        >
          {routes.map((stage, stageIndex) => (
            <button
              key={`${stage.name}-${stageIndex}`}
              className={`route-card ${stageIndex === selected ? "selected" : ""}`}
              onClick={() => setSelected(stageIndex)}
            >
              <span className="route-no">
                {String(stageIndex + 1).padStart(2, "0")}
              </span>
              <span>
                <strong>{stage.name}</strong>
                <small>
                  {fmtDist(stage.points.at(-1)!.distance)} ·{" "}
                  {stage.instructions.length} instructions
                </small>
              </span>
            </button>
          ))}
          <button className="add-stage" onClick={() => fileRef.current?.click()}>
            ＋
            <small>ADD GPX</small>
          </button>
        </div>

        <section className="route-panel">
          <div className="route-head">
            <div>
              <span>SELECTED STAGE</span>
              <h1>{route.name}</h1>
            </div>
            <span className={`quality ${quality === "TRACK ONLY" ? "warn" : ""}`}>
              {quality}
            </span>
          </div>

          <div className="metrics">
            <div>
              <small>DISTANCE</small>
              <strong>{fmtDist(route.points.at(-1)!.distance)}</strong>
            </div>
            <div>
              <small>INSTRUCTIONS</small>
              <strong>{route.instructions.length}</strong>
            </div>
            <div>
              <small>ELEVATION</small>
              <strong>
                {route.points.some((point) => point.ele) ? "YES" : "NO"}
              </strong>
            </div>
          </div>

          <div className="preview">
            <MiniMap route={route} index={0} overview />
          </div>
        </section>

        <section className="settings-panel">
          <div className="section-heading">
            <span>STAGE SETUP</span>
          </div>

          <label>
            BEND WARNINGS
            <select
              value={sensitivity}
              onChange={(event) => setSensitivity(event.target.value)}
            >
              <option value="minimal">Minimal</option>
              <option value="balanced">Balanced</option>
              <option value="detailed">Detailed</option>
            </select>
          </label>

          <div className="subheading">
            <strong>SPEED CONTROL ZONE</strong>
            <span>Optional</span>
          </div>

          <div className="config-grid">
            <label>
              DZ INSTRUCTION
              <select
                value={zone.start}
                onChange={(event) =>
                  setZone({ ...zone, start: event.target.value })
                }
              >
                <option value="">None</option>
                {route.instructions.map((instruction) => (
                  <option key={instruction.id} value={instruction.id}>
                    {optionText(instruction)}
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
                <option value="">None</option>
                {route.instructions.map((instruction) => (
                  <option key={instruction.id} value={instruction.id}>
                    {optionText(instruction)}
                  </option>
                ))}
              </select>
            </label>

            <label>
              SPEED LIMIT
              <div className="input-unit">
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
                <span>km/h</span>
              </div>
            </label>

            <label>
              OFFICIAL ZONE DISTANCE <small>OPTIONAL</small>
              <div className="input-unit">
                <input
                  type="number"
                  step="0.01"
                  placeholder={
                    zoneDistance ? `${(zoneDistance / 1000).toFixed(2)}` : "—"
                  }
                  onChange={(event) =>
                    setZone({
                      ...zone,
                      officialDistance:
                        Number(event.target.value) || undefined,
                    })
                  }
                />
                <span>km</span>
              </div>
            </label>
          </div>

          <div className={`target ${zoneReady ? "" : "inactive"}`}>
            <span>TARGET ZONE TIME</span>
            <strong>{zoneReady ? fmtTime(target) : "NOT CONFIGURED"}</strong>
            <small>Automatic start at DZ · automatic stop at FZ</small>
          </div>
        </section>

        <button
          className="primary launch-button"
          onClick={() => {
            setProgress(0);
            setScreen("drive");
          }}
        >
          OPEN RALLY MODE →
        </button>

        <p className="disclaimer">
          Navigation assistance only. The organiser roadbook and safety
          instructions remain authoritative.
        </p>
      </section>
    </main>
  );
}
