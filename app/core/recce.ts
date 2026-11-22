import { haversine } from "./geo";
import type {
  RecceFix,
  RecceMarker,
  RecceSession,
  StoredRecceFix,
} from "./types";

const xmlEscape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const isoTime = (timestamp: number) => new Date(timestamp).toISOString();

export function safeRecceFileName(name: string) {
  const safe = name
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${safe || "recorded-recce"}.gpx`;
}

export function markerTitle(marker: RecceMarker) {
  const suffix = marker.label.trim();
  const prefix = marker.number.padStart(3, "0");
  if (marker.kind === "START") return `${prefix} SS START${suffix ? ` · ${suffix}` : ""}`;
  if (marker.kind === "FINISH") return `${prefix} SS FINISH${suffix ? ` · ${suffix}` : ""}`;
  if (marker.kind === "DZ") return `${prefix} DZ${suffix ? ` · ${suffix}` : ""}`;
  if (marker.kind === "FZ") return `${prefix} FZ${suffix ? ` · ${suffix}` : ""}`;
  if (marker.kind === "TURN") {
    const call = `${marker.severity || "MEDIUM"} ${marker.direction || "LEFT"}`;
    return `${prefix} ${call}${suffix ? ` · ${suffix}` : ""}`;
  }
  return `${prefix} ${marker.kind}${suffix ? ` · ${suffix}` : ""}`;
}

export function acceptedRecceSegments(fixes: Array<StoredRecceFix | RecceFix>) {
  const bySegment = new Map<number, Array<StoredRecceFix | RecceFix>>();
  fixes
    .filter((fix) => fix.fixDecision === "ACCEPTED")
    .sort((a, b) => a.sequence - b.sequence)
    .forEach((fix) => {
      const segment = bySegment.get(fix.segment) || [];
      segment.push(fix);
      bySegment.set(fix.segment, segment);
    });

  return [...bySegment.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, segment]) => {
      if (segment.length <= 2) return segment;
      const kept = [segment[0]];
      for (let index = 1; index < segment.length - 1; index += 1) {
        const fix = segment[index];
        const previous = kept.at(-1)!;
        const displacement = haversine(
          { lat: previous.latitude, lon: previous.longitude },
          { lat: fix.latitude, lon: fix.longitude },
        );
        const elapsed = fix.timestamp - previous.timestamp;
        if (displacement >= 2.5 || (elapsed >= 3_000 && fix.speedKph >= 1)) {
          kept.push(fix);
        }
      }
      const last = segment.at(-1)!;
      const previous = kept.at(-1)!;
      if (
        last.sequence !== previous.sequence &&
        (haversine(
          { lat: previous.latitude, lon: previous.longitude },
          { lat: last.latitude, lon: last.longitude },
        ) >= 0.5 || last.timestamp - previous.timestamp >= 3_000)
      ) {
        kept.push(last);
      }
      return kept;
    })
    .filter((segment) => segment.length >= 2);
}

export function recceQuality(
  session: RecceSession,
  fixes: Array<StoredRecceFix | RecceFix>,
) {
  const segments = acceptedRecceSegments(fixes);
  const accepted = fixes.filter((fix) => fix.fixDecision === "ACCEPTED");
  const accurate = accepted.filter((fix) => fix.accuracyM <= 20).length;
  const rejected = fixes.filter((fix) => fix.fixDecision === "REJECTED").length;
  let longestGapMs = 0;
  for (let index = 1; index < accepted.length; index += 1) {
    longestGapMs = Math.max(longestGapMs, accepted[index].timestamp - accepted[index - 1].timestamp);
  }
  const usable = segments.reduce((total, segment) => total + segment.length, 0);
  const accuracyShare = accepted.length ? accurate / accepted.length : 0;
  const ready = usable >= 10 && session.acceptedDistanceM >= 50;
  return {
    ready,
    usablePointCount: usable,
    segmentCount: segments.length,
    breakCount: Math.max(0, segments.length - 1),
    rejectedFixCount: rejected,
    accuracyShare,
    longestGapMs,
  };
}

export function buildRecceGpx(
  session: RecceSession,
  fixes: Array<StoredRecceFix | RecceFix>,
) {
  const segments = acceptedRecceSegments(fixes);
  const pointCount = segments.reduce((total, segment) => total + segment.length, 0);
  if (pointCount < 2) throw new Error("At least two accepted GPS points are required");

  const waypoints = session.markers.map((marker) => {
    const title = markerTitle(marker);
    const comment = marker.note.trim() || "Recorded during recce";
    return [
      `  <wpt lat="${marker.lat.toFixed(8)}" lon="${marker.lon.toFixed(8)}">`,
      `    <time>${isoTime(marker.timestamp)}</time>`,
      `    <name>${xmlEscape(title)}</name>`,
      `    <cmt>${xmlEscape(comment)}</cmt>`,
      "    <extensions>",
      `      <xr:markerKind>${marker.kind}</xr:markerKind>`,
      marker.direction ? `      <xr:direction>${marker.direction}</xr:direction>` : "",
      marker.severity ? `      <xr:severity>${marker.severity}</xr:severity>` : "",
      `      <xr:accuracyM>${marker.accuracyM.toFixed(1)}</xr:accuracyM>`,
      "    </extensions>",
      "  </wpt>",
    ].filter(Boolean).join("\n");
  });

  const trackSegments = segments.map((segment) => [
    "    <trkseg>",
    ...segment.map((fix) => [
      `      <trkpt lat="${fix.latitude.toFixed(8)}" lon="${fix.longitude.toFixed(8)}">`,
      fix.altitudeM !== undefined ? `        <ele>${fix.altitudeM.toFixed(1)}</ele>` : "",
      `        <time>${isoTime(fix.timestamp)}</time>`,
      "        <extensions>",
      `          <xr:accuracyM>${fix.accuracyM.toFixed(1)}</xr:accuracyM>`,
      `          <xr:fixReason>${xmlEscape(fix.fixReason)}</xr:fixReason>`,
      "        </extensions>",
      "      </trkpt>",
    ].filter(Boolean).join("\n")),
    "    </trkseg>",
  ].join("\n"));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Extreme Rally Navigator Recce Recorder"',
    '  xmlns="http://www.topografix.com/GPX/1/1"',
    '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '  xmlns:xr="https://extreme-rally-navigator.app/gpx/recce/1"',
    '  xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    "  <metadata>",
    `    <name>${xmlEscape(session.name)}</name>`,
    `    <time>${isoTime(session.startedAt)}</time>`,
    "  </metadata>",
    ...waypoints,
    "  <trk>",
    `    <name>${xmlEscape(session.name)}</name>`,
    ...trackSegments,
    "  </trk>",
    "</gpx>",
    "",
  ].join("\n");
}
