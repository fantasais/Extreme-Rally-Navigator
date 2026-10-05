const assert = require("node:assert/strict");
const { RouteMatcher } = require("../.test-build/matcher.js");
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
