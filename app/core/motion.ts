import { clamp, haversine } from "./geo";
import type {
  FixDecision,
  MotionState,
  RawFix,
} from "./types";

const MAX_ACCURACY_M = 50;
const MAX_RALLY_SPEED_MPS = 250 / 3.6;
const STATIONARY_SPEED_MPS = 0.4;
const STATIONARY_RELEASE_SPEED_MPS = 0.8;
const STATIONARY_CONFIRM_MS = 3_000;
const CONTINUOUS_FIX_GAP_MS = 3_000;
const TELEPORT_CHECK_GAP_MS = 5_000;

export type MotionResult = {
  fix: RawFix;
  state: MotionState;
  decision: FixDecision;
  reason: string;
  holdRouteProgress: boolean;
  distanceDeltaM: number;
  distanceFromTimestamp?: number;
  interFixGapMs?: number;
  impliedSpeedKph?: number;
  stationaryDurationMs: number;
  releasedFromStationary: boolean;
};

const finiteReportedSpeed = (fix: RawFix) =>
  fix.reportedSpeedMps !== undefined &&
  Number.isFinite(fix.reportedSpeedMps) &&
  fix.reportedSpeedMps >= 0
    ? fix.reportedSpeedMps
    : undefined;

export class MotionFilter {
  private lastSeenTimestamp?: number;
  private lastObserved?: RawFix;
  private lastAccepted?: RawFix;
  private state: MotionState = "ACQUIRING";
  private stationaryCandidateSince?: number;
  private stationaryCandidateAnchor?: RawFix;
  private stationarySince?: number;
  private releaseFixes = 0;
  private releaseDistanceM = 0;

  reset() {
    this.lastSeenTimestamp = undefined;
    this.lastObserved = undefined;
    this.lastAccepted = undefined;
    this.state = "ACQUIRING";
    this.stationaryCandidateSince = undefined;
    this.stationaryCandidateAnchor = undefined;
    this.stationarySince = undefined;
    this.releaseFixes = 0;
    this.releaseDistanceM = 0;
  }

  getState() {
    return this.state;
  }

  process(input: RawFix): MotionResult {
    const reportedSpeed = finiteReportedSpeed(input);
    const rawGapMs = this.lastObserved
      ? input.timestamp - this.lastObserved.timestamp
      : undefined;

    if (
      !Number.isFinite(input.timestamp) ||
      !Number.isFinite(input.receivedAt) ||
      !Number.isFinite(input.lat) ||
      !Number.isFinite(input.lon) ||
      !Number.isFinite(input.accuracy) ||
      input.accuracy < 0
    ) {
      return this.rejected(input, "INVALID_GPS_FIX", rawGapMs);
    }

    if (
      this.lastSeenTimestamp !== undefined &&
      input.timestamp <= this.lastSeenTimestamp
    ) {
      return this.rejected(input, "DUPLICATE_OR_OUT_OF_ORDER_TIMESTAMP", rawGapMs);
    }
    this.lastSeenTimestamp = input.timestamp;

    const ageMs = input.receivedAt - input.timestamp;
    if (ageMs > 3_000 || ageMs < -1_000) {
      return this.rejected(input, "STALE_GPS_TIMESTAMP", rawGapMs);
    }
    if (input.accuracy > MAX_ACCURACY_M) {
      return this.rejected(input, "ACCURACY_OVER_50M", rawGapMs);
    }
    if (reportedSpeed !== undefined && reportedSpeed > MAX_RALLY_SPEED_MPS) {
      return this.rejected(input, "REPORTED_SPEED_OVER_250_KPH", rawGapMs);
    }

    if (!this.lastObserved || !this.lastAccepted) {
      const first = {
        ...input,
        speedMps: clamp(reportedSpeed ?? 0, 0, MAX_RALLY_SPEED_MPS),
      };
      this.lastObserved = first;
      this.lastAccepted = first;
      if (reportedSpeed !== undefined && reportedSpeed < STATIONARY_SPEED_MPS) {
        this.state = "STATIONARY_CANDIDATE";
        this.stationaryCandidateSince = first.timestamp;
        this.stationaryCandidateAnchor = first;
      } else {
        this.state = "MOVING";
      }
      return this.result(first, "ACCEPTED", "INITIAL_FIX", false, 0, undefined, undefined, undefined, false);
    }

    const previousObserved = this.lastObserved;
    const gapMs = input.timestamp - previousObserved.timestamp;
    const gapSeconds = gapMs / 1_000;
    const observedDistanceM = haversine(previousObserved, input);
    const impliedSpeedMps = gapSeconds > 0 ? observedDistanceM / gapSeconds : 0;
    const impliedSpeedKph = impliedSpeedMps * 3.6;
    const previousAccuracy = Math.max(0, previousObserved.accuracy);

    const hardTeleport =
      gapMs <= TELEPORT_CHECK_GAP_MS &&
      impliedSpeedMps > MAX_RALLY_SPEED_MPS;
    const inconsistentTeleport =
      reportedSpeed !== undefined &&
      gapMs <= CONTINUOUS_FIX_GAP_MS &&
      input.accuracy <= 30 &&
      previousAccuracy <= 30 &&
      impliedSpeedKph > Math.max(140, reportedSpeed * 3.6 + 100);
    if (hardTeleport || inconsistentTeleport) {
      return this.rejected(
        input,
        hardTeleport ? "COORDINATE_TELEPORT_OVER_250_KPH" : "COORDINATE_SPEED_DISAGREES_WITH_DEVICE",
        gapMs,
        impliedSpeedKph,
      );
    }

    const observationNoiseM = Math.max(
      2.5,
      Math.min(previousAccuracy, input.accuracy) * 0.3,
    );
    let effectiveSpeedMps = reportedSpeed ?? (
      gapMs <= TELEPORT_CHECK_GAP_MS && observedDistanceM > observationNoiseM
        ? impliedSpeedMps
        : 0
    );
    let acceptedReason = gapMs > TELEPORT_CHECK_GAP_MS
      ? "ACCEPTED_AFTER_GNSS_GAP_NO_DISTANCE"
      : "CREDIBLE_MOVEMENT";
    if (
      reportedSpeed !== undefined &&
      gapMs <= CONTINUOUS_FIX_GAP_MS &&
      input.accuracy <= 30 &&
      Math.abs(reportedSpeed - impliedSpeedMps) > 35 &&
      impliedSpeedMps < reportedSpeed * 0.35
    ) {
      effectiveSpeedMps = impliedSpeedMps;
      acceptedReason = "REPORTED_SPEED_SANITISED";
    }
    effectiveSpeedMps = clamp(effectiveSpeedMps, 0, MAX_RALLY_SPEED_MPS);
    const fix: RawFix = { ...input, speedMps: effectiveSpeedMps };

    if (this.state === "STATIONARY") {
      const stationaryAnchor = this.lastAccepted;
      const anchorDistanceM = haversine(stationaryAnchor, fix);
      const accuracyBasis = Math.min(stationaryAnchor.accuracy, fix.accuracy);
      const releaseBySpeed =
        reportedSpeed !== undefined &&
        reportedSpeed >= STATIONARY_RELEASE_SPEED_MPS;
      const releaseThresholdM = reportedSpeed === undefined
        ? Math.max(4, accuracyBasis * 0.8)
        : Math.max(15, accuracyBasis * 2);
      const requiredReleaseFixes = reportedSpeed === undefined ? 2 : 3;
      const coherentAdvance =
        anchorDistanceM >= releaseThresholdM &&
        anchorDistanceM > this.releaseDistanceM + Math.max(1.5, observationNoiseM * 0.5);

      if (!releaseBySpeed && coherentAdvance) {
        this.releaseFixes += 1;
        this.releaseDistanceM = anchorDistanceM;
      } else if (!releaseBySpeed) {
        this.releaseFixes = 0;
        this.releaseDistanceM = Math.max(0, anchorDistanceM - observationNoiseM);
      }

      if (!releaseBySpeed && this.releaseFixes < requiredReleaseFixes) {
        this.lastObserved = { ...fix, speedMps: 0 };
        return this.result(
          { ...fix, speedMps: 0 },
          "HELD",
          coherentAdvance ? "STATIONARY_RELEASE_CONFIRMING" : "STATIONARY_DRIFT_LOCK",
          true,
          0,
          undefined,
          gapMs,
          impliedSpeedKph,
          false,
        );
      }

      const distanceFromTimestamp = stationaryAnchor.timestamp;
      this.lastObserved = fix;
      this.lastAccepted = fix;
      this.state = "MOVING";
      this.stationaryCandidateSince = undefined;
      this.stationaryCandidateAnchor = undefined;
      this.stationarySince = undefined;
      this.releaseFixes = 0;
      this.releaseDistanceM = 0;
      return this.result(
        fix,
        "ACCEPTED",
        releaseBySpeed ? "STATIONARY_RELEASE_BY_SPEED" : "STATIONARY_RELEASE_BY_MOVEMENT",
        false,
        anchorDistanceM,
        distanceFromTimestamp,
        gapMs,
        impliedSpeedKph,
        true,
      );
    }

    const reportedStopped =
      reportedSpeed !== undefined &&
      reportedSpeed < STATIONARY_SPEED_MPS;
    const inferredStopped =
      reportedSpeed === undefined &&
      gapMs <= TELEPORT_CHECK_GAP_MS &&
      observedDistanceM <= Math.max(3, observationNoiseM * 1.25);
    const stoppedSignal = reportedStopped || inferredStopped;

    if (stoppedSignal) {
      if (!this.stationaryCandidateAnchor || this.stationaryCandidateSince === undefined) {
        this.stationaryCandidateAnchor = fix;
        this.stationaryCandidateSince = fix.timestamp;
      }
      const candidateRadiusM = Math.max(
        6,
        Math.min(this.stationaryCandidateAnchor.accuracy, fix.accuracy) * 1.2,
      );
      const candidateDisplacementM = haversine(this.stationaryCandidateAnchor, fix);
      if (candidateDisplacementM <= candidateRadiusM) {
        this.lastObserved = { ...fix, speedMps: 0 };
        const candidateDurationMs = fix.timestamp - this.stationaryCandidateSince;
        if (candidateDurationMs >= STATIONARY_CONFIRM_MS) {
          this.state = "STATIONARY";
          this.stationarySince = this.stationaryCandidateSince;
          this.releaseFixes = 0;
          this.releaseDistanceM = 0;
          return this.result(
            { ...fix, speedMps: 0 },
            "HELD",
            "STATIONARY_LOCK_CONFIRMED",
            true,
            0,
            undefined,
            gapMs,
            impliedSpeedKph,
            false,
          );
        }
        this.state = "STATIONARY_CANDIDATE";
        return this.result(
          { ...fix, speedMps: 0 },
          "ACCEPTED",
          "STATIONARY_CONFIRMING",
          false,
          0,
          undefined,
          gapMs,
          impliedSpeedKph,
          false,
        );
      }
    }

    this.stationaryCandidateSince = undefined;
    this.stationaryCandidateAnchor = undefined;
    this.stationarySince = undefined;
    this.releaseFixes = 0;
    this.releaseDistanceM = 0;
    this.state = "MOVING";

    const acceptedAnchor = this.lastAccepted;
    const acceptedGapMs = fix.timestamp - acceptedAnchor.timestamp;
    const acceptedDistanceM = haversine(acceptedAnchor, fix);
    const acceptedNoiseM = Math.max(
      2.5,
      Math.min(acceptedAnchor.accuracy, fix.accuracy) * 0.3,
    );
    const distanceDeltaM =
      acceptedGapMs <= CONTINUOUS_FIX_GAP_MS &&
      acceptedDistanceM > acceptedNoiseM
        ? acceptedDistanceM
        : 0;
    const distanceFromTimestamp = distanceDeltaM > 0
      ? acceptedAnchor.timestamp
      : undefined;
    this.lastObserved = fix;
    this.lastAccepted = fix;
    return this.result(
      fix,
      "ACCEPTED",
      distanceDeltaM > 0
        ? acceptedReason
        : gapMs > TELEPORT_CHECK_GAP_MS
          ? "ACCEPTED_AFTER_GNSS_GAP_NO_DISTANCE"
          : "ACCEPTED_BELOW_DISTANCE_NOISE_GATE",
      false,
      distanceDeltaM,
      distanceFromTimestamp,
      gapMs,
      impliedSpeedKph,
      false,
    );
  }

  private rejected(
    fix: RawFix,
    reason: string,
    interFixGapMs?: number,
    impliedSpeedKph?: number,
  ): MotionResult {
    return {
      fix,
      state: this.state,
      decision: "REJECTED",
      reason,
      holdRouteProgress: false,
      distanceDeltaM: 0,
      interFixGapMs,
      impliedSpeedKph,
      stationaryDurationMs: this.stationaryDuration(fix.timestamp),
      releasedFromStationary: false,
    };
  }

  private result(
    fix: RawFix,
    decision: FixDecision,
    reason: string,
    holdRouteProgress: boolean,
    distanceDeltaM: number,
    distanceFromTimestamp?: number,
    interFixGapMs?: number,
    impliedSpeedKph?: number,
    releasedFromStationary = false,
  ): MotionResult {
    return {
      fix,
      state: this.state,
      decision,
      reason,
      holdRouteProgress,
      distanceDeltaM,
      distanceFromTimestamp,
      interFixGapMs,
      impliedSpeedKph,
      stationaryDurationMs: this.stationaryDuration(fix.timestamp),
      releasedFromStationary,
    };
  }

  private stationaryDuration(timestamp: number) {
    const since = this.stationarySince ?? this.stationaryCandidateSince;
    return since === undefined ? 0 : Math.max(0, timestamp - since);
  }
}
