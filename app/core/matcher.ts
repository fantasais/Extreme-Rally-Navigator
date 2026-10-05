import {
  bearing,
  clamp,
  haversine,
  headingDifference,
  nearestProjection,
  pointAtDistance,
  pointIndexAtDistance,
  projectionsInDistanceWindow,
} from "./geo";
import type {
  MatchResult,
  MatcherSnapshot,
  Point,
  RawFix,
} from "./types";

type RejoinCandidate = {
  distance: number;
  segment: number;
  count: number;
};

export class RouteMatcher {
  private readonly points: Point[];
  private expectedStartDistance: number;
  private snapshot: MatcherSnapshot;
  private stableFixes = 0;
  private pendingRejoin?: RejoinCandidate;
  private gnssOutage = false;
  private outageStartedAt?: number;
  private lastReliableTimestamp?: number;

  constructor(points: Point[], expectedStartDistance = 0) {
    this.points = points;
    this.expectedStartDistance = expectedStartDistance;
    this.snapshot = {
      routeDistance: expectedStartDistance,
      segment: 0,
      status: "ACQUIRING",
      departureCount: 0,
      recoveryCount: 0,
      rejoinCount: 0,
    };
  }

  reset(expectedStartDistance = this.expectedStartDistance) {
    this.expectedStartDistance = expectedStartDistance;
    this.stableFixes = 0;
    this.pendingRejoin = undefined;
    this.gnssOutage = false;
    this.outageStartedAt = undefined;
    this.lastReliableTimestamp = undefined;
    this.snapshot = {
      routeDistance: expectedStartDistance,
      segment: 0,
      status: "ACQUIRING",
      departureCount: 0,
      recoveryCount: 0,
      rejoinCount: 0,
    };
  }

  setRouteDistance(distance: number) {
    const safe = clamp(distance, 0, this.points.at(-1)?.distance || 0);
    const finishIndex = pointIndexAtDistance(this.points, safe);
    const segment = clamp(finishIndex - 1, 0, this.points.length - 2);
    this.snapshot = {
      ...this.snapshot,
      routeDistance: safe,
      segment,
      status: "MATCHED",
      departureCount: 0,
      recoveryCount: 0,
      rejoinCandidateDistance: undefined,
    };
    this.pendingRejoin = undefined;
    this.gnssOutage = false;
    this.outageStartedAt = undefined;
    this.stableFixes = 3;
  }

  acceptRejoin() {
    if (!this.pendingRejoin) return undefined;
    const accepted = this.pendingRejoin;
    this.snapshot = {
      ...this.snapshot,
      routeDistance: Math.max(this.snapshot.routeDistance, accepted.distance),
      segment: accepted.segment,
      status: "MATCHED",
      departureCount: 0,
      recoveryCount: 0,
      rejoinCount: this.snapshot.rejoinCount + 1,
      rejoinCandidateDistance: undefined,
    };
    this.pendingRejoin = undefined;
    this.gnssOutage = false;
    this.outageStartedAt = undefined;
    this.stableFixes = 1;
    return this.snapshot.routeDistance;
  }

  getSnapshot() {
    return { ...this.snapshot };
  }

  update(fix: RawFix): MatchResult {
    const total = this.points.at(-1)?.distance || 0;
    const age = fix.receivedAt - fix.timestamp;
    const previousFix = this.snapshot.lastFix;
    const dt = previousFix
      ? clamp((fix.timestamp - previousFix.timestamp) / 1000, 0.1, 30)
      : 1;
    const displacement = previousFix ? haversine(previousFix, fix) : 0;
    const expectedTravel = Math.max(
      displacement,
      fix.speedMps * Math.min(dt, 2),
    );
    const secondsSinceReliable = Math.max(
      0,
      (fix.timestamp - (this.lastReliableTimestamp || previousFix?.timestamp || fix.timestamp)) /
        1_000,
    );
    const plausibleForwardAdvance = clamp(
      120 + secondsSinceReliable * Math.max(12, fix.speedMps) * 1.8,
      120,
      3_000,
    );
    const globalNearest = nearestProjection(this.points, fix);
    const recoveryBearing = bearing(
      fix,
      pointAtDistance(this.points, globalNearest.routeDistance),
    );

    if (
      !Number.isFinite(fix.lat) ||
      !Number.isFinite(fix.lon) ||
      !Number.isFinite(fix.accuracy) ||
      fix.accuracy > 50 ||
      age > 3_000 ||
      age < -1_000 ||
      (previousFix && dt > 5)
    ) {
      if (previousFix && dt > 5) {
        this.gnssOutage = true;
        this.outageStartedAt ??= previousFix.timestamp;
      }
      this.stableFixes = 0;
      this.snapshot = {
        ...this.snapshot,
        status: "GPS_STALE",
        lastFix: fix,
      };
      return this.result(
        globalNearest,
        false,
        false,
        recoveryBearing,
        "GNSS_STALE_OR_INACCURATE",
      );
    }

    if (!previousFix) {
      const startCandidates = projectionsInDistanceWindow(
        this.points,
        fix,
        this.expectedStartDistance,
        1_000,
        2_000,
      ).sort((a, b) => a.offset - b.offset);
      const startCandidate = startCandidates[0];
      const selected =
        startCandidate && startCandidate.offset <= globalNearest.offset + 25
          ? startCandidate
          : globalNearest;
      this.snapshot = {
        ...this.snapshot,
        routeDistance: selected.routeDistance,
        segment: selected.segment,
        status: "ACQUIRING",
        lastFix: fix,
      };
      this.stableFixes = 1;
      return this.result(
        globalNearest,
        false,
        false,
        recoveryBearing,
        "INITIAL_FIX",
      );
    }

    const localCandidates = projectionsInDistanceWindow(
      this.points,
      fix,
      this.snapshot.routeDistance,
      350,
      900,
    );
    const automaticAdvance = Math.min(
      90,
      Math.max(
        55,
        expectedTravel * 1.45 + fix.accuracy * 1.5 + 10,
      ),
    );
    const allowedReverse = Math.max(12, fix.accuracy * 1.5);
    const scored = localCandidates
      .map((candidate) => {
        const delta = candidate.routeDistance - this.snapshot.routeDistance;
        const headingError =
          fix.heading !== undefined && fix.speedMps > 2.5
            ? headingDifference(fix.heading, candidate.segmentBearing)
            : 0;
        let score = candidate.offset + Math.abs(delta - expectedTravel) * 0.22;
        if (delta < -allowedReverse) score += Math.abs(delta + allowedReverse) * 5;
        if (delta > automaticAdvance) score += (delta - automaticAdvance) * 6;
        score += headingError * (fix.speedMps > 4 ? 0.24 : 0.1);
        return { ...candidate, score, delta, headingError };
      })
      .sort((a, b) => a.score - b.score);

    const best = scored[0];
    let selected = best || {
      ...globalNearest,
      score: globalNearest.offset,
      delta: globalNearest.routeDistance - this.snapshot.routeDistance,
      headingError: 0,
    };
    let alternative = scored.find(
      (candidate, index) =>
        index > 0 &&
        Math.abs(candidate.routeDistance - selected.routeDistance) > 100 &&
        candidate.score <= selected.score + 5,
    );
    let ambiguous = Boolean(alternative);
    const segmentLength =
      this.points[globalNearest.segment + 1].distance -
      this.points[globalNearest.segment].distance;
    const geometryAllowance = Math.min(40, Math.max(0, segmentLength - 80) * 0.18);
    const offRouteThreshold = clamp(
      fix.accuracy * (fix.accuracy <= 10 ? 1.55 : 1.8) + 8 + geometryAllowance,
      22,
      70,
    );
    const headingFits =
      fix.heading === undefined ||
      fix.speedMps < 2.5 ||
      headingDifference(fix.heading, globalNearest.segmentBearing) < 80;

    const selectedDeltaBeforeFallback =
      selected.routeDistance - this.snapshot.routeDistance;
    const selectedPlausibleBeforeFallback =
      selected.offset <= offRouteThreshold &&
      selectedDeltaBeforeFallback >= -allowedReverse &&
      selectedDeltaBeforeFallback <= automaticAdvance;
    const globalDeltaBeforeFallback =
      globalNearest.routeDistance - this.snapshot.routeDistance;
    const globalPlausibleBeforeFallback =
      globalNearest.offset <= offRouteThreshold &&
      globalDeltaBeforeFallback >= -allowedReverse &&
      globalDeltaBeforeFallback <= automaticAdvance;
    if (!selectedPlausibleBeforeFallback && globalPlausibleBeforeFallback) {
      selected = {
        ...globalNearest,
        score: globalNearest.offset,
        delta: globalDeltaBeforeFallback,
        headingError:
          fix.heading !== undefined && fix.speedMps > 2.5
            ? headingDifference(fix.heading, globalNearest.segmentBearing)
            : 0,
      };
      alternative = scored.find(
        (candidate) =>
          Math.abs(candidate.routeDistance - selected.routeDistance) > 100 &&
          candidate.score <= selected.score + 5,
      );
      ambiguous = Boolean(alternative);
    }

    const currentlyRecovering =
      this.snapshot.status === "OFF_ROUTE" ||
      this.snapshot.status === "REJOIN_CONFIRMATION";

    if (currentlyRecovering) {
      const forward =
        globalNearest.routeDistance >= this.snapshot.routeDistance - offRouteThreshold;
      if (
        globalNearest.offset <= offRouteThreshold &&
        forward &&
        headingFits
      ) {
        const coherent =
          !this.pendingRejoin ||
          Math.abs(globalNearest.routeDistance - this.pendingRejoin.distance) <=
            Math.max(50, automaticAdvance);
        this.pendingRejoin = {
          distance: globalNearest.routeDistance,
          segment: globalNearest.segment,
          count: coherent ? (this.pendingRejoin?.count || 0) + 1 : 1,
        };
      } else this.pendingRejoin = undefined;

      if (this.pendingRejoin && this.pendingRejoin.count >= 3) {
        const gap = this.pendingRejoin.distance - this.snapshot.routeDistance;
        if (gap >= -allowedReverse && gap <= plausibleForwardAdvance) {
          this.snapshot = {
            ...this.snapshot,
            routeDistance: Math.max(
              this.snapshot.routeDistance,
              this.pendingRejoin.distance,
            ),
            segment: this.pendingRejoin.segment,
            status: "MATCHED",
            lastFix: fix,
            departureCount: 0,
            recoveryCount: 0,
            rejoinCount: this.snapshot.rejoinCount + 1,
            rejoinCandidateDistance: undefined,
          };
          this.pendingRejoin = undefined;
          this.stableFixes = 1;
          this.lastReliableTimestamp = fix.timestamp;
          this.gnssOutage = false;
          this.outageStartedAt = undefined;
          return this.result(
            globalNearest,
            false,
            false,
            recoveryBearing,
            gap <= automaticAdvance
              ? "AUTO_REJOIN_LOCAL"
              : "AUTO_REJOIN_PLAUSIBLE_FORWARD",
          );
        }
        this.snapshot = {
          ...this.snapshot,
          status: "REJOIN_CONFIRMATION",
          lastFix: fix,
          rejoinCandidateDistance: this.pendingRejoin.distance,
        };
        return this.result(
          globalNearest,
          false,
          false,
          recoveryBearing,
          "REJOIN_REQUIRES_CONFIRMATION",
        );
      }

      this.snapshot = {
        ...this.snapshot,
        status: "OFF_ROUTE",
        lastFix: fix,
        recoveryCount: this.snapshot.recoveryCount + 1,
      };
      return this.result(
        globalNearest,
        false,
        ambiguous,
        recoveryBearing,
        "OFF_ROUTE_HOLD",
      );
    }

    const departure = globalNearest.offset > offRouteThreshold && !ambiguous;
    const departureCount = departure ? this.snapshot.departureCount + 1 : 0;
    const departureRequired = globalNearest.offset > offRouteThreshold + 25 ? 3 : 5;
    if (departureCount >= departureRequired) {
      this.stableFixes = 0;
      this.pendingRejoin = undefined;
      this.snapshot = {
        ...this.snapshot,
        status: "OFF_ROUTE",
        lastFix: fix,
        departureCount,
        recoveryCount: 0,
      };
      return this.result(
        globalNearest,
        false,
        ambiguous,
        recoveryBearing,
        "SUSTAINED_CROSS_TRACK_DEPARTURE",
      );
    }

    const candidateDelta = selected.routeDistance - this.snapshot.routeDistance;
    const candidateKinematicallyPlausible =
      selected.offset <= offRouteThreshold &&
      candidateDelta >= -allowedReverse &&
      candidateDelta <= automaticAdvance;
    if (ambiguous && candidateKinematicallyPlausible) {
      this.stableFixes = 0;
      this.pendingRejoin = undefined;
      this.snapshot = {
        ...this.snapshot,
        routeDistance: clamp(
          Math.max(this.snapshot.routeDistance, selected.routeDistance),
          0,
          total,
        ),
        segment: selected.segment,
        status: "UNCERTAIN",
        lastFix: fix,
        departureCount,
        rejoinCandidateDistance: undefined,
      };
      return this.result(
        globalNearest,
        false,
        true,
        recoveryBearing,
        "LOCAL_AMBIGUOUS_CONTINUITY",
      );
    }

    const candidateAcceptable = !ambiguous && candidateKinematicallyPlausible;

    if (!candidateAcceptable) {
      const globalGap = globalNearest.routeDistance - this.snapshot.routeDistance;
      const globalCoherent =
        globalNearest.offset <= offRouteThreshold &&
        globalGap >= -allowedReverse &&
        headingFits &&
        !ambiguous;
      if (globalCoherent && globalGap > automaticAdvance) {
        const coherent =
          !this.pendingRejoin ||
          Math.abs(globalNearest.routeDistance - this.pendingRejoin.distance) <=
            Math.max(60, automaticAdvance);
        this.pendingRejoin = {
          distance: globalNearest.routeDistance,
          segment: globalNearest.segment,
          count: coherent ? (this.pendingRejoin?.count || 0) + 1 : 1,
        };
      } else this.pendingRejoin = undefined;

      if (this.pendingRejoin && this.pendingRejoin.count >= 3) {
        if (globalGap <= plausibleForwardAdvance) {
          const wasGnssOutage = this.gnssOutage;
          this.snapshot = {
            ...this.snapshot,
            routeDistance: this.pendingRejoin.distance,
            segment: this.pendingRejoin.segment,
            status: "MATCHED",
            lastFix: fix,
            departureCount: 0,
            recoveryCount: 0,
            rejoinCount: this.snapshot.rejoinCount + 1,
            rejoinCandidateDistance: undefined,
          };
          this.pendingRejoin = undefined;
          this.gnssOutage = false;
          this.outageStartedAt = undefined;
          this.lastReliableTimestamp = fix.timestamp;
          this.stableFixes = 3;
          return this.result(
            globalNearest,
            true,
            false,
            recoveryBearing,
            wasGnssOutage
              ? "AUTO_REJOIN_AFTER_GNSS_OUTAGE"
              : "AUTO_REJOIN_PLAUSIBLE_FORWARD",
          );
        }
        this.snapshot = {
          ...this.snapshot,
          status: "REJOIN_CONFIRMATION",
          lastFix: fix,
          rejoinCandidateDistance: this.pendingRejoin.distance,
        };
        return this.result(
          globalNearest,
          false,
          false,
          recoveryBearing,
          "FORWARD_REJOIN_REQUIRES_CONFIRMATION",
        );
      }

      this.stableFixes = 0;
      this.snapshot = {
        ...this.snapshot,
        status: "UNCERTAIN",
        lastFix: fix,
        departureCount,
      };
      return this.result(
        globalNearest,
        false,
        ambiguous,
        recoveryBearing,
        ambiguous ? "MULTIPLE_ROUTE_BRANCHES" : "IMPLAUSIBLE_ROUTE_ADVANCE",
      );
    }

    const nextDistance = clamp(
      Math.max(this.snapshot.routeDistance, selected.routeDistance),
      0,
      total,
    );
    this.stableFixes += 1;
    this.snapshot = {
      ...this.snapshot,
      routeDistance: nextDistance,
      segment: selected.segment,
      status: this.stableFixes >= 3 ? "MATCHED" : "ACQUIRING",
      lastFix: fix,
      departureCount,
      recoveryCount: 0,
      rejoinCandidateDistance: undefined,
    };
    if (this.stableFixes >= 3) {
      this.lastReliableTimestamp = fix.timestamp;
      this.gnssOutage = false;
      this.outageStartedAt = undefined;
    }
    return this.result(
      globalNearest,
      this.stableFixes >= 3,
      false,
      recoveryBearing,
      this.stableFixes >= 3 ? "LOCAL_CONTINUITY_MATCH" : "MATCH_STABILISING",
    );
  }

  private result(
    nearest: ReturnType<typeof nearestProjection>,
    reliable: boolean,
    ambiguous: boolean,
    recoveryBearing: number,
    reason: string,
  ): MatchResult {
    return {
      status: this.snapshot.status,
      routeDistance: this.snapshot.routeDistance,
      segment: this.snapshot.segment,
      offset: haversine(
        this.snapshot.lastFix || pointAtDistance(this.points, this.snapshot.routeDistance),
        pointAtDistance(this.points, this.snapshot.routeDistance),
      ),
      nearestRouteDistance: nearest.routeDistance,
      nearestSegment: nearest.segment,
      nearestOffset: nearest.offset,
      reliable,
      ambiguous,
      rejoinDistance: this.snapshot.rejoinCandidateDistance,
      recoveryBearing,
      reason,
    };
  }
}
