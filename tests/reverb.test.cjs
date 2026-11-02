const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { test } = require("node:test");

const context = { p5: function () {} };
runInNewContext(readFileSync(require.resolve("../sketch.js"), "utf8"), context);

for (const seconds of [0.2, 2, 5]) {
  test(`generates a decaying stereo impulse for a ${seconds}s room`, () => {
    const channels = [];
    const audio = {
      sampleRate: 48000,
      createBuffer(numberOfChannels, length, sampleRate) {
        for (let i = 0; i < numberOfChannels; i++) channels.push(new Float32Array(length));
        return { numberOfChannels, length, sampleRate, getChannelData: (i) => channels[i] };
      },
    };
    const impulse = context.createReverbImpulse(audio, seconds);
    assert.equal(impulse.numberOfChannels, 2);
    assert.equal(impulse.length, Math.ceil(seconds * audio.sampleRate));
    assert.equal(impulse.sampleRate, audio.sampleRate);
    for (const samples of channels) {
      assert.ok(samples.some((sample) => sample !== 0));
      assert.ok(samples.every((sample) => Number.isFinite(sample) && Math.abs(sample) <= 1));
      assert.ok(Math.abs(samples[samples.length - 1]) < 1e-9);
    }
    assert.notDeepEqual(channels[0], channels[1]);
  });
}
