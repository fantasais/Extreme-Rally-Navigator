const assert = require("node:assert/strict");
const { RouteMatcher } = require("../.test-build/matcher.js");
const { MotionFilter } = require("../.test-build/motion.js");
const {
  advanceNavigation,
  initialiseNavigation,
} = require("../.test-build/events.js");

const METRES_PER_DEGREE = 111_320;
const point = (distance, lateral = 0) => ({
  lat: lateral / METRES_PER_DEGREE,
  lon: distance / METRES_PER_DEGREE,
  distance,
});
const points = Array.from({ length: 51 }, (_, index) => point(index * 100));

function fix(distance, timestamp, lateral = 0, speedMps = 20) {
  const coordinate = point(distance, lateral);
  return {
    timestamp,
    receivedAt: timestamp,
    lat: coordinate.lat,
    lon: coordinate.lon,
    accuracy: 4,
    speedMps,
    heading: 90,
  };
}

function motionFix(distance, timestamp, reportedSpeedMps, accuracy = 5, lateral = 0) {
  const coordinate = point(distance, lateral);
  return {
    timestamp,
    receivedAt: timestamp,
    lat: coordinate.lat,
    lon: coordinate.lon,
    accuracy,
    speedMps: reportedSpeedMps ?? 0,
    reportedSpeedMps,
    heading: 90,
  };
}

{
  const filter = new MotionFilter();
  const matcher = new RouteMatcher(points, 1_000);
  let timestamp = 1_000;
  let result = filter.process(motionFix(1_000, timestamp, 0));
  let matched = matcher.update(result.fix, { holdProgress: result.holdRouteProgress });
  let acceptedDistance = result.distanceDeltaM;
  const jitter = [2, -2, 1, -1, 3, -3, 2, -2];
  for (let index = 0; index < 64; index += 1) {
    timestamp += 1_000;
    result = filter.process(motionFix(1_000 + jitter[index % jitter.length], timestamp, 0));
    assert.notEqual(result.decision, "REJECTED");
    acceptedDistance += result.distanceDeltaM;
    matched = matcher.update(result.fix, { holdProgress: result.holdRouteProgress });
  }
  assert.equal(filter.getState(), "STATIONARY");
  assert.equal(result.decision, "HELD");
  assert.equal(acceptedDistance, 0);
  assert.ok(matched.routeDistance <= 1_003.5);
  timestamp += 30_000;
  result = filter.process(motionFix(1_001, timestamp, 0));
  assert.equal(result.decision, "HELD");
  matched = matcher.update(result.fix, { holdProgress: result.holdRouteProgress });
  assert.equal(matched.status, "MATCHED");
  assert.equal(matched.reason, "STATIONARY_PROGRESS_HELD");
  const heldDistance = matched.routeDistance;
  timestamp += 1_000;
  result = filter.process(motionFix(1_010, timestamp, 2));
  assert.equal(result.decision, "ACCEPTED");
  assert.equal(result.reason, "STATIONARY_RELEASE_BY_SPEED");
  assert.ok(result.distanceDeltaM >= 9 && result.distanceDeltaM <= 11);
  matched = matcher.update(result.fix, { holdProgress: result.holdRouteProgress });
  assert.ok(matched.routeDistance >= heldDistance);
}

{
  const filter = new MotionFilter();
  let timestamp = 1_000;
  filter.process(motionFix(1_000, timestamp, 0));
  for (let index = 0; index < 4; index += 1) {
    timestamp += 1_000;
    filter.process(motionFix(1_000, timestamp, 0));
  }
  timestamp += 1_000;
  const firstMovement = filter.process(motionFix(1_005, timestamp, undefined));
  assert.equal(firstMovement.decision, "HELD");
  timestamp += 1_000;
  const secondMovement = filter.process(motionFix(1_011, timestamp, undefined));
  assert.equal(secondMovement.decision, "ACCEPTED");
  assert.equal(secondMovement.reason, "STATIONARY_RELEASE_BY_MOVEMENT");
}

{
  const filter = new MotionFilter();
  filter.process(motionFix(0, 1_000, 20));
  const teleport = filter.process(motionFix(300, 2_000, 20));
  assert.equal(teleport.decision, "REJECTED");
  assert.equal(teleport.reason, "COORDINATE_TELEPORT_OVER_250_KPH");
}

{
  const filter = new MotionFilter();
  const speedMps = 220 / 3.6;
  filter.process(motionFix(0, 1_000, speedMps));
  const fastButCredible = filter.process(motionFix(speedMps, 2_000, speedMps));
  assert.equal(fastButCredible.decision, "ACCEPTED");
  const overLimit = new MotionFilter().process(motionFix(0, 1_000, 260 / 3.6));
  assert.equal(overLimit.decision, "REJECTED");
  assert.equal(overLimit.reason, "REPORTED_SPEED_OVER_250_KPH");
}

{
  const filter = new MotionFilter();
  filter.process(motionFix(0, 1_000, 20));
  const afterGap = filter.process(motionFix(1_500, 31_000, 20));
  assert.equal(afterGap.decision, "ACCEPTED");
  assert.equal(afterGap.distanceDeltaM, 0);
  assert.equal(afterGap.reason, "ACCEPTED_AFTER_GNSS_GAP_NO_DISTANCE");
}

{
  const filter = new MotionFilter();
  filter.process(motionFix(0, 1_000, 0));
  const inaccurate = filter.process(motionFix(1, 2_000, 0, 60));
  assert.equal(inaccurate.decision, "REJECTED");
  assert.equal(inaccurate.reason, "ACCURACY_OVER_50M");
  const duplicate = filter.process(motionFix(1, 1_000, 0));
  assert.equal(duplicate.decision, "REJECTED");
  assert.equal(duplicate.reason, "DUPLICATE_OR_OUT_OF_ORDER_TIMESTAMP");
}

{
  const matcher = new RouteMatcher(points, 0);
  let timestamp = 1_000;
  for (let distance = 0; distance <= 500; distance += 20) {
    matcher.update(fix(distance, timestamp));
    timestamp += 1_000;
  }
  timestamp += 30_000;
  matcher.update(fix(1_500, timestamp));
  let result;
  for (let distance = 1_520; distance <= 1_600; distance += 20) {
    timestamp += 1_000;
    result = matcher.update(fix(distance, timestamp));
    if (result.reason === "AUTO_REJOIN_AFTER_GNSS_OUTAGE") break;
  }
  assert.equal(result.reason, "AUTO_REJOIN_AFTER_GNSS_OUTAGE");
  assert.ok(result.routeDistance >= 1_540);
}

{
  const matcher = new RouteMatcher(points, 0);
  let timestamp = 1_000;
  for (let distance = 0; distance <= 300; distance += 20) {
    matcher.update(fix(distance, timestamp));
    timestamp += 1_000;
  }
  let result;
  for (let distance = 320; distance <= 420; distance += 20) {
    result = matcher.update(fix(distance, timestamp, 80));
    timestamp += 1_000;
  }
  assert.equal(result.status, "OFF_ROUTE");
  for (let distance = 440; distance <= 520; distance += 20) {
    result = matcher.update(fix(distance, timestamp));
    timestamp += 1_000;
    if (result.reason.startsWith("AUTO_REJOIN_")) break;
  }
  assert.ok(result.reason.startsWith("AUTO_REJOIN_"));
}

{
  const events = [
    { id: "turn:a", kind: "TURN", distance: 600, passDistance: 600, leadDistance: 150, label: "RIGHT" },
    { id: "turn:b", kind: "TURN", distance: 800, passDistance: 800, leadDistance: 150, label: "LEFT" },
  ];
  const initial = initialiseNavigation(events, [], 500);
  const advanced = advanceNavigation(initial, events, [], 1_000, 10_000, true);
  assert.equal(advanced.events["turn:a"].state, "MISSED");
  assert.equal(advanced.events["turn:b"].state, "MISSED");
  assert.equal(advanced.lastReliableDistance, 1_000);
}

{
  const events = [
    { id: "turn:past", kind: "TURN", distance: 100, passDistance: 100, leadDistance: 100, label: "PAST" },
    { id: "turn:future", kind: "TURN", distance: 700, passDistance: 700, leadDistance: 100, label: "FUTURE" },
  ];
  const initial = initialiseNavigation(events, [], 500);
  assert.equal(initial.events["turn:past"].state, "BEFORE_START");
  assert.equal(initial.events["turn:future"].state, "UPCOMING");
  assert.equal(initial.transitions.length, 0);
}

console.log("core tests passed");
