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
    assert.equal(frequency([color]), 220);
  }
  assert.equal(frequency([]), 220);
});

test("saturated primary hues map to the expected pitches", () => {
  assert.equal(frequency([[255, 0, 0]]), 55);
  assert.ok(Math.abs(frequency([[0, 255, 0]]) - 55 * 16 ** (1 / 3)) < 1e-8);
  assert.ok(Math.abs(frequency([[0, 0, 255]]) - 55 * 16 ** (2 / 3)) < 1e-8);
});

test("white highlights do not wash out colored pixels", () => {
  const colors = Array.from({ length: 19 }, () => [255, 255, 255]);
  assert.equal(frequency([...colors, [255, 0, 0]]), 55);
});

test("only pixels within the requested label contribute", () => {
  assert.equal(frequency([[255, 0, 0], [0, 255, 0]], [1, 2]), 55);
});

test("opposing hues and insignificant color use the fallback", () => {
  assert.equal(frequency([[255, 0, 0], [0, 255, 255]]), 220);
  assert.equal(frequency([...Array.from({ length: 200 }, () => [255, 255, 255]), [255, 0, 0]]), 220);
});

test("reds across the hue seam stay near red rather than cyan", () => {
  const pitch = frequency([[255, 0, 20], [255, 20, 0]]);
  assert.ok(pitch < 60 || pitch > 800);
});

test("softening preserves lower notes and gently attenuates higher notes", () => {
  for (const pitch of [55, 110, 220]) {
    assert.equal(context.softenedAmplitude(0.8, pitch), 0.8);
  }
  assert.ok(Math.abs(context.softenedAmplitude(0.8, 440) - 0.8 / Math.sqrt(2)) < 1e-10);
  assert.equal(context.softenedAmplitude(0.8, 880), 0.4);
  assert.equal(context.softenedAmplitude(0, 880), 0);
  let previous = 1;
  for (let pitch = 55; pitch <= 880; pitch++) {
    const amplitude = context.softenedAmplitude(1, pitch);
    assert.ok(amplitude <= previous && amplitude >= 0.5);
    previous = amplitude;
  }
});
