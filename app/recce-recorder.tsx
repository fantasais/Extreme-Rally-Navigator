"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { bearing, haversine } from "./core/geo";
import { MotionFilter } from "./core/motion";
import {
  acceptedRecceSegments,
  buildRecceGpx,
  markerTitle,
  recceQuality,
  safeRecceFileName,
} from "./core/recce";
import {
  appendRecceFix,
  getRecceFixes,
  listRecces,
  pauseInterruptedRecces,
  removeRecce,
  saveRecceSession,
} from "./core/storage";
import type {
  RawFix,
  RecceFix,
  RecceMarker,
  RecceMarkerKind,
  RecceSession,
  StoredRecceFix,
  TurnCall,
} from "./core/types";

type Props = {
  appVersion: string;
  buildId: string;
  onClose: () => void;
  onImportGpx: (
    text: string,
    fileName: string,
  ) => Promise<{ id: string; name: string }>;
};

type Screen = "HOME" | "RECORD" | "REVIEW";
type RecorderGpsStatus = "OFF" | "ACQUIRING" | "READY" | "ERROR";

type WakeLockSentinelLike = {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
};

const formatDuration = (milliseconds: number) => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remaining = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
};

const defaultRecceName = () => {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `RECCE ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
};

function ReccePreview({ fixes }: { fixes: StoredRecceFix[] }) {
  const segments = acceptedRecceSegments(fixes);
  const points = segments.flat();
  if (points.length < 2) {
    return <div className="recce-preview-empty">Route preview appears after movement is recorded.</div>;
  }
  const minLon = Math.min(...points.map((point) => point.longitude));
  const maxLon = Math.max(...points.map((point) => point.longitude));
  const minLat = Math.min(...points.map((point) => point.latitude));
  const maxLat = Math.max(...points.map((point) => point.latitude));
  const xy = (point: StoredRecceFix) => [
    18 + ((point.longitude - minLon) / (maxLon - minLon || 1)) * 564,
    258 - ((point.latitude - minLat) / (maxLat - minLat || 1)) * 232,
  ];
  return (
    <svg className="recce-route-map" viewBox="0 0 600 276" aria-label="Recorded recce route preview">
      {segments.map((segment, index) => {
        const path = segment
          .map((point, pointIndex) => `${pointIndex ? "L" : "M"}${xy(point).join(",")}`)
          .join(" ");
        return <path key={`${index}-${segment[0]?.sequence}`} d={path} />;
      })}
    </svg>
  );
}

export default function RecceRecorder({
  appVersion,
  buildId,
  onClose,
  onImportGpx,
}: Props) {
  const [screen, setScreen] = useState<Screen>("HOME");
  const [sessions, setSessions] = useState<RecceSession[]>([]);
  const [active, setActive] = useState<RecceSession | null>(null);
  const [fixes, setFixes] = useState<StoredRecceFix[]>([]);
  const [newName, setNewName] = useState(defaultRecceName);
  const [gpsStatus, setGpsStatus] = useState<RecorderGpsStatus>("OFF");
  const [gpsAccuracy, setGpsAccuracy] = useState<number | null>(null);
  const [speedKph, setSpeedKph] = useState(0);
  const [lastUsableFix, setLastUsableFix] = useState<(RawFix & { altitudeM?: number }) | null>(null);
  const [now, setNow] = useState(Date.now());
  const [moreMarkers, setMoreMarkers] = useState(false);
  const [endHoldActive, setEndHoldActive] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [wakeActive, setWakeActive] = useState(false);

  const activeRef = useRef<RecceSession | null>(null);
  const watchRef = useRef<number | null>(null);
  const endHoldRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const motionRef = useRef(new MotionFilter());
  const previousObservedRef = useRef<RawFix | null>(null);
  const sequenceRef = useRef(0);
  const segmentRef = useRef(0);
  const lastAcceptedTimestampRef = useRef<number | undefined>(undefined);
  const rejectedSinceAcceptedRef = useRef(false);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

  const refreshSessions = useCallback(async () => {
    setSessions(await listRecces());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await pauseInterruptedRecces();
      if (!cancelled) await refreshSessions();
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (active?.status !== "RECORDING") return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [active?.status]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2_400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const activeRecording = active?.status === "RECORDING";
    const wakeLockApi = (
      navigator as Navigator & {
        wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
      }
    ).wakeLock;
    const release = async () => {
      const lock = wakeLockRef.current;
      wakeLockRef.current = null;
      if (lock && !lock.released) await lock.release().catch(() => undefined);
      setWakeActive(false);
    };
    if (!activeRecording || !wakeLockApi) {
      void release();
      return;
    }
    const acquire = async () => {
      if (document.visibilityState !== "visible" || wakeLockRef.current) return;
      try {
        const lock = await wakeLockApi.request("screen");
        wakeLockRef.current = lock;
        setWakeActive(true);
        lock.addEventListener("release", () => {
          if (wakeLockRef.current === lock) {
            wakeLockRef.current = null;
            setWakeActive(false);
            if (document.visibilityState === "visible") {
              window.setTimeout(() => void acquire(), 500);
            }
          }
        });
      } catch {
        setWakeActive(false);
      }
    };
    const visibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      void release();
    };
  }, [active?.status]);

  useEffect(
    () => () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      if (endHoldRef.current !== null) window.clearTimeout(endHoldRef.current);
      const current = activeRef.current;
      if (current?.status === "RECORDING") {
        void saveRecceSession({ ...current, status: "PAUSED", updatedAt: Date.now() });
      }
    },
    [],
  );

  const queueWrite = (entry: RecceFix, session: RecceSession) => {
    writeChainRef.current = writeChainRef.current
      .then(async () => {
        await appendRecceFix(entry);
        await saveRecceSession(session);
      })
      .catch((reason) => {
        setError(`Recorder storage failed: ${reason instanceof Error ? reason.message : String(reason)}`);
      });
  };

  const setAndSaveActive = (session: RecceSession) => {
    activeRef.current = session;
    setActive(session);
    void saveRecceSession(session).catch((reason) =>
      setError(`Could not save recce: ${reason instanceof Error ? reason.message : String(reason)}`),
    );
  };

  const stopGps = () => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    setGpsStatus("OFF");
  };

  const processPosition = (position: GeolocationPosition) => {
    const current = activeRef.current;
    if (!current || current.status !== "RECORDING") return;
    const previous = previousObservedRef.current;
    const receivedAt = Date.now();
    const timestamp = position.timestamp || receivedAt;
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const dt = previous ? Math.max(0.1, (timestamp - previous.timestamp) / 1_000) : 1;
    const movement = previous ? haversine(previous, { lat, lon }) : 0;
    const calculated = previous && movement > Math.max(2.5, position.coords.accuracy * 0.3)
      ? movement / dt
      : 0;
    const reported = position.coords.speed;
    const reportedSpeedMps =
      reported !== null && Number.isFinite(reported) && reported >= 0
        ? reported
        : undefined;
    const speedMps = reportedSpeedMps ?? calculated;
    const reportedHeading = position.coords.heading;
    const movementHeading = previous && movement > 4
      ? bearing(previous, { lat, lon })
      : undefined;
    const heading = reportedHeading !== null && Number.isFinite(reportedHeading)
      ? reportedHeading
      : movementHeading;
    const raw: RawFix = {
      timestamp,
      receivedAt,
      lat,
      lon,
      accuracy: position.coords.accuracy,
      speedMps,
      reportedSpeedMps,
      heading,
    };
    previousObservedRef.current = raw;
    const motion = motionRef.current.process(raw);
    const processed = motion.fix;

    const acceptedGapMs = lastAcceptedTimestampRef.current === undefined
      ? 0
      : processed.timestamp - lastAcceptedTimestampRef.current;
    const observedGapMs = previous ? processed.timestamp - previous.timestamp : 0;
    if (motion.decision === "REJECTED") rejectedSinceAcceptedRef.current = true;
    if (
      motion.decision === "ACCEPTED" &&
      (observedGapMs > 5_000 || (rejectedSinceAcceptedRef.current && acceptedGapMs > 5_000))
    ) {
      segmentRef.current += 1;
    }
    if (motion.decision === "ACCEPTED") {
      lastAcceptedTimestampRef.current = processed.timestamp;
      rejectedSinceAcceptedRef.current = false;
    }

    const entry: RecceFix = {
      sessionId: current.id,
      sequence: sequenceRef.current++,
      segment: segmentRef.current,
      timestamp: processed.timestamp,
      receivedAt: processed.receivedAt,
      latitude: processed.lat,
      longitude: processed.lon,
      altitudeM:
        position.coords.altitude !== null && Number.isFinite(position.coords.altitude)
          ? position.coords.altitude
          : undefined,
      accuracyM: processed.accuracy,
      speedKph: processed.speedMps * 3.6,
      headingDeg: processed.heading,
      motionState: motion.state,
      fixDecision: motion.decision,
      fixReason: motion.reason,
      interFixGapMs: motion.interFixGapMs,
      impliedSpeedKph: motion.impliedSpeedKph,
      distanceDeltaM: motion.distanceDeltaM,
    };
    const next: RecceSession = {
      ...current,
      updatedAt: Date.now(),
      acceptedDistanceM: current.acceptedDistanceM + motion.distanceDeltaM,
      observedFixCount: current.observedFixCount + 1,
      acceptedFixCount: current.acceptedFixCount + (motion.decision === "ACCEPTED" ? 1 : 0),
      segmentCount: Math.max(current.segmentCount, segmentRef.current + 1),
    };
    activeRef.current = next;
    setActive(next);
    setFixes((existing) => [...existing, entry]);
    setGpsStatus("READY");
    setGpsAccuracy(processed.accuracy);
    setSpeedKph(processed.speedMps * 3.6);
    if (motion.decision !== "REJECTED" && processed.accuracy <= 30) {
      setLastUsableFix({
        ...processed,
        altitudeM: entry.altitudeM,
      });
    }
    queueWrite(entry, next);
  };

  const startRecording = async (session: RecceSession, existingFixes: StoredRecceFix[]) => {
    if (!navigator.geolocation) {
      setError("This browser does not expose GPS");
      return;
    }
    stopGps();
    setError("");
    setNotice("");
    motionRef.current.reset();
    previousObservedRef.current = null;
    lastAcceptedTimestampRef.current = undefined;
    rejectedSinceAcceptedRef.current = false;
    sequenceRef.current = existingFixes.reduce((maximum, fix) => Math.max(maximum, fix.sequence + 1), 0);
    const existingSegments = existingFixes.reduce((maximum, fix) => Math.max(maximum, fix.segment + 1), 0);
    segmentRef.current = existingFixes.length ? existingSegments : 0;
    const next: RecceSession = {
      ...session,
      status: "RECORDING",
      updatedAt: Date.now(),
      finishedAt: undefined,
      segmentCount: Math.max(session.segmentCount, segmentRef.current + 1),
    };
    setAndSaveActive(next);
    setFixes(existingFixes);
    setScreen("RECORD");
    setGpsStatus("ACQUIRING");
    setGpsAccuracy(null);
    setSpeedKph(0);
    setLastUsableFix(null);
    setNow(Date.now());
    watchRef.current = navigator.geolocation.watchPosition(
      processPosition,
      (gpsError) => {
        setGpsStatus("ERROR");
        setError(`GPS ${gpsError.code}: ${gpsError.message}`);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
  };

  const createRecce = async () => {
    const timestamp = Date.now();
    const session: RecceSession = {
      id: `recce-${crypto.randomUUID()}`,
      name: newName.trim() || defaultRecceName(),
      appVersion,
      buildId,
      status: "PAUSED",
      startedAt: timestamp,
      updatedAt: timestamp,
      acceptedDistanceM: 0,
      observedFixCount: 0,
      acceptedFixCount: 0,
      segmentCount: 0,
      markers: [],
    };
    await saveRecceSession(session);
    await startRecording(session, []);
  };

  const openReview = async (session: RecceSession) => {
    stopGps();
    await writeChainRef.current;
    const stored = await getRecceFixes(session.id);
    activeRef.current = session;
    setActive(session);
    setFixes(stored);
    setScreen("REVIEW");
    setError("");
    setNotice("");
  };

  const pauseRecording = async (finished: boolean) => {
    const current = activeRef.current;
    if (!current) return;
    stopGps();
    const timestamp = Date.now();
    const next: RecceSession = {
      ...current,
      status: finished ? "FINISHED" : "PAUSED",
      updatedAt: timestamp,
      finishedAt: finished ? timestamp : current.finishedAt,
    };
    activeRef.current = next;
    setActive(next);
    await writeChainRef.current;
    await saveRecceSession(next);
    const stored = await getRecceFixes(next.id);
    setFixes(stored);
    setScreen("REVIEW");
    await refreshSessions();
  };

  const addMarker = (
    kind: RecceMarkerKind,
    direction?: "LEFT" | "RIGHT",
    severity: TurnCall["severity"] = "MEDIUM",
  ) => {
    const current = activeRef.current;
    const fix = lastUsableFix;
    if (!current || !fix) {
      setError("Wait for an accurate GPS fix before marking a point");
      return;
    }
    const marker: RecceMarker = {
      id: `marker-${crypto.randomUUID()}`,
      number: String(current.markers.length + 1).padStart(3, "0"),
      kind,
      label: "",
      note: "",
      timestamp: fix.timestamp,
      lat: fix.lat,
      lon: fix.lon,
      accuracyM: fix.accuracy,
      distanceM: current.acceptedDistanceM,
      direction,
      severity: kind === "TURN" ? severity : undefined,
    };
    const next = {
      ...current,
      updatedAt: Date.now(),
      markers: [...current.markers, marker],
    };
    setAndSaveActive(next);
    setNotice(`${markerTitle(marker)} marked`);
    setError("");
  };

  const undoMarker = () => {
    const current = activeRef.current;
    if (!current?.markers.length) return;
    const removed = current.markers.at(-1)!;
    const next = {
      ...current,
      updatedAt: Date.now(),
      markers: current.markers.slice(0, -1),
    };
    setAndSaveActive(next);
    setNotice(`${markerTitle(removed)} removed`);
  };

  const updateMarker = (markerId: string, patch: Partial<RecceMarker>) => {
    const current = activeRef.current;
    if (!current) return;
    const next = {
      ...current,
      updatedAt: Date.now(),
      markers: current.markers.map((marker) =>
        marker.id === markerId ? { ...marker, ...patch } : marker,
      ),
    };
    setAndSaveActive(next);
  };

  const deleteMarker = (markerId: string) => {
    const current = activeRef.current;
    if (!current) return;
    const markers = current.markers
      .filter((marker) => marker.id !== markerId)
      .map((marker, index) => ({ ...marker, number: String(index + 1).padStart(3, "0") }));
    setAndSaveActive({ ...current, markers, updatedAt: Date.now() });
  };

  const saveToNavigator = async () => {
    const current = activeRef.current;
    if (!current) return;
    try {
      await writeChainRef.current;
      const stored = await getRecceFixes(current.id);
      const gpx = buildRecceGpx(current, stored);
      const imported = await onImportGpx(gpx, safeRecceFileName(current.name));
      const next = { ...current, savedRouteId: imported.id, updatedAt: Date.now() };
      setAndSaveActive(next);
      setNotice(`${imported.name} saved to Navigator`);
      await refreshSessions();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const exportGpx = async () => {
    const current = activeRef.current;
    if (!current) return;
    try {
      await writeChainRef.current;
      const stored = await getRecceFixes(current.id);
      const gpx = buildRecceGpx(current, stored);
      const url = URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = safeRecceFileName(current.name);
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const deleteSession = async (session: RecceSession) => {
    if (!window.confirm(`Delete recce "${session.name}" and all recorded GPS fixes?`)) return;
    await removeRecce(session.id);
    if (activeRef.current?.id === session.id) {
      activeRef.current = null;
      setActive(null);
      setFixes([]);
      setScreen("HOME");
    }
    await refreshSessions();
  };

  const beginEndHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (endHoldRef.current !== null) window.clearTimeout(endHoldRef.current);
    setEndHoldActive(true);
    endHoldRef.current = window.setTimeout(() => {
      endHoldRef.current = null;
      setEndHoldActive(false);
      void pauseRecording(true);
    }, 1_000);
  };

  const cancelEndHold = () => {
    if (endHoldRef.current !== null) {
      window.clearTimeout(endHoldRef.current);
      endHoldRef.current = null;
    }
    setEndHoldActive(false);
  };

  const quality = useMemo(
    () => active ? recceQuality(active, fixes) : null,
    [active, fixes],
  );
  const elapsed = active
    ? (active.finishedAt || now) - active.startedAt
    : 0;

  return (
    <main className={`recce-shell ${screen === "RECORD" ? "recce-live" : ""}`}>
      <header className="recce-topbar">
        <div>
          <span>EXTREME RALLY · V{appVersion}</span>
          <h1>RECCE RECORDER</h1>
        </div>
        <button
          onClick={() => {
            if (active?.status === "RECORDING") {
              void pauseRecording(false);
            } else {
              onClose();
            }
          }}
        >
          {active?.status === "RECORDING" ? "PAUSE" : "BACK"}
        </button>
      </header>

      <section className="recce-content">
        {error ? <div className="error-banner">{error}</div> : null}
        {notice ? <div className="notice-banner" onClick={() => setNotice("")}>{notice}</div> : null}

        {screen === "HOME" ? (
          <div className="recce-stack">
            <section className="recce-intro-card">
              <span>OFFLINE ROUTE CREATION</span>
              <h2>Record the road during recce</h2>
              <p>GPS fixes, rejected points and manual pacenote markers remain stored on this phone. No mobile data is required.</p>
              <label>
                ROUTE NAME
                <input value={newName} onChange={(event) => setNewName(event.target.value)} />
              </label>
              <button className="recce-primary" onClick={() => void createRecce()}>START NEW RECCE</button>
            </section>

            <section className="recce-history-card">
              <div className="recce-section-title">
                <div><span>SAVED LOCALLY</span><h2>Recce sessions</h2></div>
                <button onClick={() => void refreshSessions()}>REFRESH</button>
              </div>
              {!sessions.length ? (
                <div className="recce-empty">No recorded recce sessions.</div>
              ) : sessions.map((session) => (
                <article className="recce-session-row" key={session.id}>
                  <div>
                    <strong>{session.name}</strong>
                    <span>{new Date(session.startedAt).toLocaleString([], { hour12: false })}</span>
                    <b>{session.status} · {(session.acceptedDistanceM / 1_000).toFixed(2)} km · {session.markers.length} markers</b>
                  </div>
                  <div>
                    <button onClick={() => void openReview(session)}>REVIEW</button>
                    {session.status !== "FINISHED" ? (
                      <button className="recce-resume" onClick={async () => {
                        const stored = await getRecceFixes(session.id);
                        await startRecording(session, stored);
                      }}>RESUME</button>
                    ) : null}
                    <button className="recce-danger" onClick={() => void deleteSession(session)}>DELETE</button>
                  </div>
                </article>
              ))}
            </section>
          </div>
        ) : null}

        {screen === "RECORD" && active ? (
          <div className="recce-record-screen">
            <section className={`recce-status-card ${gpsAccuracy !== null && gpsAccuracy > 25 ? "warning" : ""}`}>
              <div className="recce-live-label"><i /> RECORDING <b>{wakeActive ? "SCREEN AWAKE" : "KEEP APP VISIBLE"}</b></div>
              <h2>{active.name}</h2>
              <div className="recce-live-metrics">
                <div><span>DISTANCE</span><strong>{(active.acceptedDistanceM / 1_000).toFixed(2)}</strong><small>km</small></div>
                <div><span>TIME</span><strong>{formatDuration(elapsed)}</strong></div>
                <div><span>SPEED</span><strong>{Math.round(speedKph)}</strong><small>km/h</small></div>
                <div><span>GPS</span><strong>{gpsAccuracy === null ? "—" : `±${Math.round(gpsAccuracy)}m`}</strong><small>{gpsStatus}</small></div>
              </div>
              <div className="recce-fix-strip">
                <span>{active.acceptedFixCount} ACCEPTED</span>
                <span>{active.observedFixCount - active.acceptedFixCount} HELD / REJECTED</span>
                <span>{active.segmentCount} SEGMENT{active.segmentCount === 1 ? "" : "S"}</span>
              </div>
            </section>

            <section className="recce-marker-card">
              <div className="recce-section-title">
                <div><span>PACENOTE BACKUP</span><h2>Mark the current position</h2></div>
                <button disabled={!active.markers.length} onClick={undoMarker}>UNDO</button>
              </div>
              <div className="recce-quick-markers">
                <button disabled={!lastUsableFix} onClick={() => addMarker("TURN", "LEFT")}>↰<span>LEFT</span></button>
                <button disabled={!lastUsableFix} onClick={() => addMarker("TURN", "RIGHT")}>↱<span>RIGHT</span></button>
                <button disabled={!lastUsableFix} onClick={() => addMarker("CAUTION")}>!<span>CAUTION</span></button>
                <button onClick={() => setMoreMarkers((value) => !value)}>+<span>MORE</span></button>
              </div>
              {moreMarkers ? (
                <div className="recce-more-markers">
                  <button disabled={!lastUsableFix} onClick={() => addMarker("START")}>SS START</button>
                  <button disabled={!lastUsableFix} onClick={() => addMarker("CREST")}>CREST</button>
                  <button disabled={!lastUsableFix} onClick={() => addMarker("JUNCTION")}>JUNCTION</button>
                  <button disabled={!lastUsableFix} onClick={() => addMarker("DZ")}>DZ</button>
                  <button disabled={!lastUsableFix} onClick={() => addMarker("FZ")}>FZ</button>
                  <button disabled={!lastUsableFix} onClick={() => addMarker("FINISH")}>SS FINISH</button>
                  <button disabled={!lastUsableFix} onClick={() => addMarker("NOTE")}>NOTE</button>
                </div>
              ) : null}
              <div className="recce-last-marker">
                <span>LAST MARKER</span>
                <strong>{active.markers.length ? markerTitle(active.markers.at(-1)!) : "NONE"}</strong>
              </div>
            </section>

            <div className="recce-record-actions">
              <button onClick={() => void pauseRecording(false)}>PAUSE & REVIEW</button>
              <button
                className={endHoldActive ? "holding" : ""}
                onPointerDown={beginEndHold}
                onPointerUp={cancelEndHold}
                onPointerLeave={cancelEndHold}
                onPointerCancel={cancelEndHold}
                onContextMenu={(event) => event.preventDefault()}
              >
                {endHoldActive ? "KEEP HOLDING…" : "HOLD 1 SEC TO FINISH"}
              </button>
            </div>
          </div>
        ) : null}

        {screen === "REVIEW" && active && quality ? (
          <div className="recce-stack">
            <section className="recce-review-card">
              <div className="recce-section-title">
                <div><span>ROUTE REVIEW</span><h2>{active.name}</h2></div>
                <b className={quality.ready ? "ready" : "check"}>{quality.ready ? "ROUTE READY" : "MORE DATA NEEDED"}</b>
              </div>
              <ReccePreview fixes={fixes} />
              <div className="recce-review-metrics">
                <div><span>DISTANCE</span><strong>{(active.acceptedDistanceM / 1_000).toFixed(2)} km</strong></div>
                <div><span>POINTS</span><strong>{quality.usablePointCount}</strong></div>
                <div><span>SEGMENTS</span><strong>{quality.segmentCount}</strong></div>
                <div><span>GPS ≤20m</span><strong>{Math.round(quality.accuracyShare * 100)}%</strong></div>
              </div>
              {quality.breakCount ? (
                <div className="recce-gap-warning"><strong>{quality.breakCount} GPS BREAK{quality.breakCount === 1 ? "" : "S"}</strong><span>Export keeps each continuous span separate. Review these sections before stage use.</span></div>
              ) : null}
              <label className="recce-name-field">
                ROUTE NAME
                <input value={active.name} onChange={(event) => setAndSaveActive({ ...active, name: event.target.value, updatedAt: Date.now() })} />
              </label>
            </section>

            <section className="recce-markers-review">
              <div className="recce-section-title">
                <div><span>WAYPOINTS</span><h2>{active.markers.length} recce markers</h2></div>
              </div>
              {!active.markers.length ? (
                <div className="recce-empty">No manual pacenote markers. Track-generated calls will still be created.</div>
              ) : active.markers.map((marker) => (
                <article key={marker.id} className="recce-marker-editor">
                  <div className="recce-marker-editor-title">
                    <strong>{marker.number}</strong>
                    <span>{(marker.distanceM / 1_000).toFixed(2)} km · GPS ±{Math.round(marker.accuracyM)}m</span>
                    <button onClick={() => deleteMarker(marker.id)}>REMOVE</button>
                  </div>
                  <div className="recce-marker-fields">
                    <label>TYPE
                      <select value={marker.kind} onChange={(event) => {
                        const kind = event.target.value as RecceMarkerKind;
                        updateMarker(marker.id, {
                          kind,
                          direction: kind === "TURN" ? marker.direction || "LEFT" : undefined,
                          severity: kind === "TURN" ? marker.severity || "MEDIUM" : undefined,
                        });
                      }}>
                        <option value="START">SS START</option>
                        <option value="TURN">TURN</option>
                        <option value="CAUTION">CAUTION</option>
                        <option value="CREST">CREST</option>
                        <option value="JUNCTION">JUNCTION</option>
                        <option value="DZ">DZ</option>
                        <option value="FZ">FZ</option>
                        <option value="FINISH">SS FINISH</option>
                        <option value="NOTE">NOTE</option>
                      </select>
                    </label>
                    {marker.kind === "TURN" ? <>
                      <label>DIRECTION
                        <select value={marker.direction || "LEFT"} onChange={(event) => updateMarker(marker.id, { direction: event.target.value as "LEFT" | "RIGHT" })}>
                          <option value="LEFT">LEFT</option>
                          <option value="RIGHT">RIGHT</option>
                        </select>
                      </label>
                      <label>SEVERITY
                        <select value={marker.severity || "MEDIUM"} onChange={(event) => updateMarker(marker.id, { severity: event.target.value as TurnCall["severity"] })}>
                          <option value="GENTLE">GENTLE</option>
                          <option value="MEDIUM">MEDIUM</option>
                          <option value="SHARP">SHARP</option>
                          <option value="HAIRPIN">HAIRPIN</option>
                        </select>
                      </label>
                    </> : null}
                    <label className="wide">LABEL
                      <input value={marker.label} onChange={(event) => updateMarker(marker.id, { label: event.target.value })} />
                    </label>
                    <label className="wide">NOTE
                      <input value={marker.note} onChange={(event) => updateMarker(marker.id, { note: event.target.value })} />
                    </label>
                  </div>
                </article>
              ))}
            </section>

            <section className="recce-review-actions">
              <button disabled={!quality.ready} className="recce-primary" onClick={() => void saveToNavigator()}>
                {active.savedRouteId ? "SAVED TO NAVIGATOR" : "SAVE TO NAVIGATOR"}
              </button>
              <button disabled={!quality.ready} onClick={() => void exportGpx()}>EXPORT GPX</button>
              <button onClick={() => void startRecording(active, fixes)}>RESUME RECORDING</button>
              <button onClick={() => {
                setActive(null);
                activeRef.current = null;
                setFixes([]);
                setScreen("HOME");
                void refreshSessions();
              }}>RECCE LIST</button>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}
