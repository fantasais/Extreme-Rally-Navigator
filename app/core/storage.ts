import { defaultConfig, sha256 } from "./gpx";
import type {
  RouteConfig,
  RouteRecord,
  RunLogEntry,
  RunMetadata,
} from "./types";

const DATABASE = "xr-navigator-v1";
const VERSION = 1;
const LEGACY_KEY = "xr-navigator-v0.5-routes";
const MIGRATION_KEY = "xr-v1-legacy-migration-complete";
let databasePromise: Promise<IDBDatabase> | undefined;

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("routes")) {
        database.createObjectStore("routes", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("configs")) {
        database.createObjectStore("configs", { keyPath: "routeId" });
      }
      if (!database.objectStoreNames.contains("runs")) {
        const runs = database.createObjectStore("runs", { keyPath: "id" });
        runs.createIndex("startedAt", "startedAt");
        runs.createIndex("status", "status");
      }
      if (!database.objectStoreNames.contains("fixes")) {
        const fixes = database.createObjectStore("fixes", {
          keyPath: "id",
          autoIncrement: true,
        });
        fixes.createIndex("runId", "runId");
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error);
    };
  });
  return databasePromise;
}

export async function loadRoutesAndConfigs() {
  const database = await openDatabase();
  const transaction = database.transaction(["routes", "configs"], "readonly");
  const routes = await requestResult<RouteRecord[]>(
    transaction.objectStore("routes").getAll(),
  );
  const configList = await requestResult<RouteConfig[]>(
    transaction.objectStore("configs").getAll(),
  );
  await transactionDone(transaction);
  return {
    routes,
    configs: Object.fromEntries(configList.map((config) => [config.routeId, config])),
  };
}

export async function saveRouteAndConfig(route: RouteRecord, config: RouteConfig) {
  const database = await openDatabase();
  const transaction = database.transaction(["routes", "configs"], "readwrite");
  transaction.objectStore("routes").put(route);
  transaction.objectStore("configs").put(config);
  await transactionDone(transaction);
}

export async function saveConfig(config: RouteConfig) {
  const database = await openDatabase();
  const transaction = database.transaction("configs", "readwrite");
  transaction.objectStore("configs").put(config);
  await transactionDone(transaction);
}

export async function deleteRoute(routeId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(["routes", "configs"], "readwrite");
  transaction.objectStore("routes").delete(routeId);
  transaction.objectStore("configs").delete(routeId);
  await transactionDone(transaction);
}

export async function createRun(run: RunMetadata) {
  const database = await openDatabase();
  const transaction = database.transaction("runs", "readwrite");
  transaction.objectStore("runs").put(run);
  await transactionDone(transaction);
}

export async function appendRunFix(entry: RunLogEntry) {
  const database = await openDatabase();
  const transaction = database.transaction("fixes", "readwrite");
  transaction.objectStore("fixes").add(entry);
  await transactionDone(transaction);
}

export async function updateRun(run: RunMetadata) {
  const database = await openDatabase();
  const transaction = database.transaction("runs", "readwrite");
  transaction.objectStore("runs").put(run);
  await transactionDone(transaction);
}

export async function listRuns() {
  const database = await openDatabase();
  const transaction = database.transaction("runs", "readonly");
  const runs = await requestResult<RunMetadata[]>(
    transaction.objectStore("runs").getAll(),
  );
  await transactionDone(transaction);
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getRunFixes(runId: string) {
  const database = await openDatabase();
  const transaction = database.transaction("fixes", "readonly");
  const fixes = await requestResult<(RunLogEntry & { id: number })[]>(
    transaction.objectStore("fixes").index("runId").getAll(runId),
  );
  await transactionDone(transaction);
  return fixes.sort((a, b) => a.sequence - b.sequence);
}

export async function removeRun(runId: string) {
  const database = await openDatabase();
  const transaction = database.transaction(["runs", "fixes"], "readwrite");
  transaction.objectStore("runs").delete(runId);
  const index = transaction.objectStore("fixes").index("runId");
  const range = IDBKeyRange.only(runId);
  index.openKeyCursor(range).onsuccess = (event) => {
    const cursor = (event.target as IDBRequest<IDBCursor | null>).result;
    if (!cursor) return;
    transaction.objectStore("fixes").delete(cursor.primaryKey);
    cursor.continue();
  };
  await transactionDone(transaction);
}

export async function markInterruptedRunsRecovered() {
  const runs = await listRuns();
  const unfinished = runs.filter((run) => run.status === "RUNNING");
  for (const run of unfinished) {
    await updateRun({
      ...run,
      status: "RECOVERED",
      finishedAt: run.finishedAt || Date.now(),
    });
  }
  return unfinished.length;
}

export async function migrateLegacyStorage() {
  if (localStorage.getItem(MIGRATION_KEY)) return 0;
  const raw = localStorage.getItem(LEGACY_KEY) || localStorage.getItem("xr-navigator-v0.4-routes");
  if (!raw) {
    localStorage.setItem(MIGRATION_KEY, "none");
    return 0;
  }
  try {
    const parsed = JSON.parse(raw) as {
      routes?: Array<{
        id: string;
        name: string;
        points: RouteRecord["points"];
        instructions: Array<{
          id: string;
          label: string;
          note: string;
          distance: number;
        }>;
      }>;
      configs?: Record<string, {
        officialStart?: string;
        zone?: {
          start?: string;
          finish?: string;
          speed?: number;
          officialDistance?: number;
        };
      }>;
    };
    let migrated = 0;
    for (const legacy of parsed.routes || []) {
      if (!legacy.points?.length) continue;
      const contentHash = await sha256(JSON.stringify(legacy.points));
      const gaps = legacy.points.slice(1).map(
        (point, index) => point.distance - legacy.points[index].distance,
      );
      const sorted = [...gaps].sort((a, b) => a - b);
      const at = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0;
      const route: RouteRecord = {
        id: `route-${contentHash.slice(0, 20)}`,
        contentHash,
        name: legacy.name,
        direction: "FORWARD",
        importedAt: Date.now(),
        points: legacy.points,
        instructions: (legacy.instructions || []).map((instruction, index) => ({
          id: instruction.id || `legacy-${index}`,
          number: instruction.label.match(/(\d{1,3})/)?.[1] || String(index + 1),
          label: instruction.label,
          note: instruction.note || "",
          routeDistance: instruction.distance,
          kind: /\bDZ\b/i.test(`${instruction.label} ${instruction.note}`)
            ? "DZ"
            : /\bFZ\b/i.test(`${instruction.label} ${instruction.note}`)
              ? "FZ"
              : "ROADBOOK",
        })),
        quality: {
          pointCount: legacy.points.length,
          instructionCount: legacy.instructions?.length || 0,
          totalDistance: legacy.points.at(-1)?.distance || 0,
          medianGap: at(0.5),
          p95Gap: at(0.95),
          maximumGap: Math.max(0, ...gaps),
          gapsOver140m: gaps.filter((gap) => gap > 140).length,
          lowConfidenceDistance: gaps.filter((gap) => gap > 140).reduce((a, b) => a + b, 0),
        },
      };
      const config = defaultConfig(route);
      const legacyConfig = parsed.configs?.[legacy.id];
      if (legacyConfig?.officialStart) config.stages[0].officialStart = legacyConfig.officialStart;
      const oldZone = legacyConfig?.zone;
      if (oldZone?.start && oldZone.finish) {
        config.stages[0].zones = [{
          id: `legacy-zone-${crypto.randomUUID()}`,
          name: "ZONE 1",
          start: { mode: "INSTRUCTION", value: oldZone.start },
          finish: { mode: "INSTRUCTION", value: oldZone.finish },
          speedLimitKph: oldZone.speed || 30,
          officialDistanceKm: oldZone.officialDistance,
        }];
      }
      await saveRouteAndConfig(route, config);
      migrated += 1;
    }
    localStorage.setItem(MIGRATION_KEY, String(migrated));
    return migrated;
  } catch {
    localStorage.setItem(MIGRATION_KEY, "failed");
    return 0;
  }
}
