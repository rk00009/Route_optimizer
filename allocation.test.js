"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { allocation } = require("./allocation");

const po = (id, volume, region = "north", weight) => ({
  id, name: id, volume, region, lat: 28 + volume / 100, lon: 77 + volume / 100, weight
});
const truck = (id, capacity, payloadCapacity) => ({ id, volumeCapacity: capacity, payloadCapacity });

test("keeps a complete geographic group on one truck", () => {
  const result = allocation({ pos: [po("A", 12), po("B", 10), po("C", 8)], trucks: [truck("T1", 30)], safetyBufferPercentage: 0 });
  assert.deepEqual(result.allocations[0].pos.map(item => item.id), ["A", "B", "C"]);
  assert.equal(result.allocations[0].usableUtilizationPercentage, 100);
});

test("selects the best whole-PO combination and reports the remainder", () => {
  const result = allocation({ pos: [po("A", 12), po("B", 10), po("C", 8)], trucks: [truck("T1", 20)], safetyBufferPercentage: 0 });
  assert.deepEqual(result.allocations[0].pos.map(item => item.id), ["A", "C"]);
  assert.equal(result.unassigned[0].po.id, "B");
});

test("applies safety buffer and supports different truck capacities", () => {
  const result = allocation({ pos: [po("A", 27)], trucks: [truck("small", 25), truck("large", 30)], safetyBufferPercentage: 10 });
  assert.equal(result.allocations[0].truck.id, "large");
  assert.equal(result.allocations[0].truck.usableVolume, 27);
});

test("does not combine explicitly incompatible geographic groups", () => {
  const result = allocation({
    pos: [po("N", 10, "north"), po("S", 10, "south")],
    trucks: [truck("T1", 30)],
    safetyBufferPercentage: 0
  });
  assert.equal(result.allocations.length, 1);
  assert.equal(result.unassigned.length, 1);
});

test("enforces payload only when weights are available", () => {
  const rejected = allocation({
    pos: [po("heavy", 5, "north", 120)],
    trucks: [truck("T1", 10, 100)],
    payloadEnabled: true,
    safetyBufferPercentage: 0
  });
  assert.equal(rejected.unassigned.length, 1);

  const unknownWeight = allocation({
    pos: [po("unknown", 5)],
    trucks: [truck("T1", 10, 100)],
    payloadEnabled: true,
    safetyBufferPercentage: 0
  });
  assert.equal(unknownWeight.allocations.length, 1);
});

test("rejects invalid volumes and oversized POs", () => {
  assert.throws(() => allocation({ pos: [po("bad", 0)], trucks: [truck("T1", 10)] }), /volume must be positive/);
  const result = allocation({ pos: [po("huge", 11)], trucks: [truck("T1", 10)], safetyBufferPercentage: 0 });
  assert.match(result.unassigned[0].reason, /larger than every available truck/);
});
