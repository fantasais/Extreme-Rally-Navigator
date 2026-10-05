import {
  haversine,
  nearestProjection,
  percentile,
  pointAtDistance,
} from "./geo";
import type {
  Instruction,
  InstructionKind,
  PositionMarker,
  RouteConfig,
  RouteRecord,
  StageProfile,
  ZoneDefinition,
} from "./types";

const textEncoder = new TextEncoder();

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function instructionNumber(label: string, fallback: number) {
  const prefixed = label.match(/(?:^|\s)(\d{1,3})(?=\D|$)/);
  return prefixed?.[1] || String(fallback + 1).padStart(3, "0");
}

function instructionKind(label: string, note: string): InstructionKind {
  const text = `${label} ${note}`.toUpperCase();
  if (/\bDZ\b|DECONTROL ZONE START/.test(text)) return "DZ";
  if (/\bFZ\b|DECONTROL ZONE FINISH/.test(text)) return "FZ";
  if (/FLYING FINISH|STAGE FINISH|\bSS FINISH\b/.test(text)) return "FINISH";
  if (/\bSTOP\b|STOP CONTROL/.test(text)) return "STOP";
  if (/STAGE START|\bSS START\b/.test(text)) return "START";
  return "ROADBOOK";
}

function calculateQuality(points: RouteRecord["points"], instructionCount: number) {
  const gaps = points.slice(1).map((point, index) => point.distance - points[index].distance);
  const large = gaps.filter((gap) => gap > 140);
  return {
    pointCount: points.length,
    instructionCount,
    totalDistance: points.at(-1)?.distance || 0,
    medianGap: percentile(gaps, 0.5),
    p95Gap: percentile(gaps, 0.95),
    maximumGap: Math.max(0, ...gaps),
    gapsOver140m: large.length,
    lowConfidenceDistance: large.reduce((total, gap) => total + gap, 0),
  };
}

export async function parseGpx(text: string, fileName: string): Promise<RouteRecord> {
  const xml = new DOMParser().parseFromString(text, "application/xml");
  if (xml.querySelector("parsererror")) throw new Error("Invalid GPX file");

  const trackPoints = [...xml.getElementsByTagNameNS("*", "trkpt")];
  const routePoints = [...xml.getElementsByTagNameNS("*", "rtept")];
  const nodes = trackPoints.length ? trackPoints : routePoints;
  if (nodes.length < 2) throw new Error("The GPX has no usable track");

  let cumulative = 0;
  const points: RouteRecord["points"] = [];
  for (const node of nodes) {
    const lat = Number(node.getAttribute("lat"));
    const lon = Number(node.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleText = node.getElementsByTagNameNS("*", "ele")[0]?.textContent;
    const point = {
      lat,
      lon,
      ele: eleText && Number.isFinite(Number(eleText)) ? Number(eleText) : undefined,
      distance: 0,
    };
    const previous = points.at(-1);
    if (previous) cumulative += haversine(previous, point);
    point.distance = cumulative;
    points.push(point);
  }
  if (points.length < 2) throw new Error("The GPX track contains invalid coordinates");

  const instructions: Instruction[] = [
    ...xml.getElementsByTagNameNS("*", "wpt"),
  ]
    .map((waypoint, index) => {
      const lat = Number(waypoint.getAttribute("lat"));
      const lon = Number(waypoint.getAttribute("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const get = (tag: string) =>
        waypoint.getElementsByTagNameNS("*", tag)[0]?.textContent?.trim() || "";
      const label = get("name") || `Instruction ${index + 1}`;
      const note = get("cmt") || get("desc") || "";
      const projection = nearestProjection(points, { lat, lon });
      if (projection.offset > 300) return null;
      const number = instructionNumber(label, index);
      return {
        id: `gpx-${index}-${number}`,
        number,
        label,
        note,
        routeDistance: projection.routeDistance,
        kind: instructionKind(label, note),
      } satisfies Instruction;
    })
    .filter((instruction): instruction is Instruction => Boolean(instruction))
    .sort((a, b) => a.routeDistance - b.routeDistance);

  const contentHash = await sha256(text);
  return {
    id: `route-${contentHash.slice(0, 20)}`,
    contentHash,
    name: fileName.replace(/\.gpx$/i, ""),
    direction: "FORWARD",
    importedAt: Date.now(),
    points,
    instructions,
    quality: calculateQuality(points, instructions.length),
  };
}

export function reverseRoute(source: RouteRecord): RouteRecord {
  const reversedCoordinates = [...source.points].reverse();
  let cumulative = 0;
  const points = reversedCoordinates.map((point, index) => {
    if (index) cumulative += haversine(reversedCoordinates[index - 1], point);
    return { ...point, distance: cumulative };
  });
  const total = source.points.at(-1)?.distance || 0;
  const instructions = source.instructions
    .map((instruction) => ({
      ...instruction,
      id: `reverse-${instruction.id}`,
      routeDistance: Math.max(0, total - instruction.routeDistance),
    }))
    .sort((a, b) => a.routeDistance - b.routeDistance);
  return {
    ...source,
    id: `${source.id}-reverse`,
    contentHash: `${source.contentHash}-reverse`,
    name: `${source.name} — REVERSE`,
    direction: "REVERSE",
    sourceRouteId: source.id,
    importedAt: Date.now(),
    points,
    instructions,
    quality: calculateQuality(points, instructions.length),
  };
}

export function defaultStage(route: RouteRecord): StageProfile {
  const start = route.instructions.find((instruction) => instruction.kind === "START");
  const finish = route.instructions.find(
    (instruction) =>
      instruction.kind === "FINISH" &&
      instruction.routeDistance > (start?.routeDistance ?? -1),
  );
  const startRouteKm = (start?.routeDistance || 0) / 1000;
  const zones: ZoneDefinition[] = [];
  let openDz: Instruction | undefined;
  route.instructions.forEach((instruction) => {
    if (instruction.kind === "DZ") openDz = instruction;
    if (instruction.kind === "FZ" && openDz && instruction.routeDistance > openDz.routeDistance) {
      zones.push({
        id: `zone-${openDz.id}-${instruction.id}`,
        name: `ZONE ${zones.length + 1}`,
        start: { mode: "INSTRUCTION", value: openDz.id },
        finish: { mode: "INSTRUCTION", value: instruction.id },
        speedLimitKph: 30,
      });
      openDz = undefined;
    }
  });
  return {
    id: `stage-${crypto.randomUUID()}`,
    name: "SPECIAL STAGE 1",
    officialStart: localDateTime(new Date(Date.now() + 5 * 60_000)),
    startRouteKm,
    finishRouteKm: finish ? finish.routeDistance / 1000 : undefined,
    startOdoKm: 0,
    startInstructionId: start?.id,
    zones,
  };
}

export function defaultConfig(route: RouteRecord): RouteConfig {
  const stage = defaultStage(route);
  return { routeId: route.id, selectedStageId: stage.id, stages: [stage] };
}

export function localDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function markerRouteDistance(
  marker: PositionMarker,
  stage: StageProfile,
  route: RouteRecord,
) {
  if (marker.mode === "ROUTE_KM") return Number(marker.value) * 1000;
  if (marker.mode === "STAGE_KM") {
    return stage.startRouteKm * 1000 +
      (Number(marker.value) - stage.startOdoKm) * 1000;
  }
  return route.instructions.find((instruction) => instruction.id === marker.value)
    ?.routeDistance;
}

export function addEmptyZone(stage: StageProfile): ZoneDefinition {
  return {
    id: `zone-${crypto.randomUUID()}`,
    name: `ZONE ${stage.zones.length + 1}`,
    start: { mode: "STAGE_KM", value: 0 },
    finish: { mode: "STAGE_KM", value: 0 },
    speedLimitKph: 30,
  };
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

export function importRoadbookCsv(
  route: RouteRecord,
  stage: StageProfile,
  text: string,
) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("Roadbook CSV is empty");
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const required = headers.indexOf("number");
  if (required < 0) throw new Error("Roadbook CSV requires a 'number' column");
  const index = (name: string) => headers.indexOf(name);
  const routeKmIndex = index("route_km");
  const stageKmIndex = index("stage_km");
  if (routeKmIndex < 0 && stageKmIndex < 0) {
    throw new Error("Roadbook CSV requires route_km or stage_km");
  }

  const imported = rows.slice(1).map((row, rowIndex) => {
    const routeKm = routeKmIndex >= 0 ? Number(row[routeKmIndex]) : NaN;
    const stageKm = stageKmIndex >= 0 ? Number(row[stageKmIndex]) : NaN;
    const routeDistance = Number.isFinite(routeKm)
      ? routeKm * 1000
      : stage.startRouteKm * 1000 + (stageKm - stage.startOdoKm) * 1000;
    if (!Number.isFinite(routeDistance)) {
      throw new Error(`Invalid distance on CSV row ${rowIndex + 2}`);
    }
    const number = row[required] || String(rowIndex + 1).padStart(3, "0");
    const label = index("label") >= 0 ? row[index("label")] : number;
    const note = index("note") >= 0 ? row[index("note")] : "";
    const kindText = index("kind") >= 0 ? row[index("kind")].toUpperCase() : "";
    const kind = (["START", "FINISH", "STOP", "DZ", "FZ"] as InstructionKind[])
      .includes(kindText as InstructionKind)
      ? (kindText as InstructionKind)
      : instructionKind(label, note);
    const headingValue = index("heading") >= 0 ? Number(row[index("heading")]) : NaN;
    return {
      id: `csv-${rowIndex}-${number}`,
      number,
      label: label || number,
      note,
      routeDistance,
      kind,
      heading: Number.isFinite(headingValue) ? headingValue : undefined,
    } satisfies Instruction;
  });

  const total = route.points.at(-1)?.distance || 0;
  if (imported.some((instruction) => instruction.routeDistance < 0 || instruction.routeDistance > total)) {
    throw new Error("One or more roadbook instructions fall outside the GPX route");
  }
  return {
    ...route,
    instructions: imported.sort((a, b) => a.routeDistance - b.routeDistance),
    quality: calculateQuality(route.points, imported.length),
  };
}

export function routePointForInstruction(route: RouteRecord, instruction: Instruction) {
  return pointAtDistance(route.points, instruction.routeDistance);
}

