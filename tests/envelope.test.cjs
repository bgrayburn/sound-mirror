const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");

const context = { p5: function () {} };
runInNewContext(readFileSync(require.resolve("../sketch.js"), "utf8"), context);

function parameterSpy() {
  const calls = [];
  const parameter = {};
  for (const method of ["setValueAtTime", "linearRampToValueAtTime", "cancelScheduledValues"]) {
    parameter[method] = (...args) => calls.push([method, ...args]);
  }
  return { parameter, calls };
}

test("attack and decay are scheduled once with sustained final level", () => {
  const { parameter, calls } = parameterSpy();
  context.startEnvelope(parameter, 10);
  assert.deepEqual(calls, [
    ["setValueAtTime", 0, 10],
    ["linearRampToValueAtTime", 1, 10.1],
    ["linearRampToValueAtTime", 0.7, 10.35],
  ]);
  assert.equal(context.envelopeLevel(10, 100), 0.7);
});

test("envelope rises, decays, and holds while visible", () => {
  for (const [elapsed, expected] of [[0, 0], [0.05, 0.5], [0.1, 1], [0.225, 0.85], [0.35, 0.7], [5, 0.7]]) {
    assert.ok(Math.abs(context.envelopeLevel(0, elapsed) - expected) < 1e-10);
  }
});

for (const elapsed of [0, 0.05, 0.225, 1]) {
  test(`release at ${elapsed}s holds the current level before fading`, () => {
    const { parameter, calls } = parameterSpy();
    const now = 10 + elapsed;
    const end = context.releaseEnvelope(parameter, 10, now);
    assert.equal(end, now + 0.6);
    assert.deepEqual(calls, [
      ["cancelScheduledValues", now],
      ["setValueAtTime", context.envelopeLevel(10, now), now],
      ["linearRampToValueAtTime", 0, end],
    ]);
  });
}
