const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");

const context = { p5: function () {} };
runInNewContext(readFileSync(require.resolve("../sketch.js"), "utf8"), context);
const frequency = (colors, labels = colors.map(() => 1)) =>
  context.blobToFrequency(colors.flatMap((color) => [...color, 255]), labels, 1);

test("gray, white, black, and empty blobs use the fallback", () => {
  for (const color of [[128, 128, 128], [255, 255, 255], [0, 0, 0]]) {
    assert.equal(frequency([color]), 440);
  }
  assert.equal(frequency([]), 440);
});

test("saturated primary hues map to the expected pitches", () => {
  assert.equal(frequency([[255, 0, 0]]), 110);
  assert.ok(Math.abs(frequency([[0, 255, 0]]) - 110 * 16 ** (1 / 3)) < 1e-8);
  assert.ok(Math.abs(frequency([[0, 0, 255]]) - 110 * 16 ** (2 / 3)) < 1e-8);
});

test("white highlights do not wash out colored pixels", () => {
  const colors = Array.from({ length: 19 }, () => [255, 255, 255]);
  assert.equal(frequency([...colors, [255, 0, 0]]), 110);
});

test("only pixels within the requested label contribute", () => {
  assert.equal(frequency([[255, 0, 0], [0, 255, 0]], [1, 2]), 110);
});

test("opposing hues and insignificant color use the fallback", () => {
  assert.equal(frequency([[255, 0, 0], [0, 255, 255]]), 440);
  assert.equal(frequency([...Array.from({ length: 200 }, () => [255, 255, 255]), [255, 0, 0]]), 440);
});

test("reds across the hue seam stay near red rather than cyan", () => {
  const pitch = frequency([[255, 0, 20], [255, 20, 0]]);
  assert.ok(pitch < 120 || pitch > 1600);
});
