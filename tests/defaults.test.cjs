const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");

const html = readFileSync(require.resolve("../index.html"), "utf8");
for (const [id, value, label] of [
  ["reverb-amount", "70", "70%"],
  ["room-size", "3", "3.0 s"],
  ["threshold", "130", "130"],
  ["min-size", "240", "240 px"],
  ["max-blobs", "80", "80"],
]) {
  test(`${id} defaults to ${value} with a matching label`, () => {
    const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))[0];
    assert.ok(input.includes(`value="${value}"`));
    assert.ok(html.includes(`<output id="${id}-value">${label}</output>`));
  });
}

test("reverb stays off by default", () => {
  assert.match(html, /<button id="reverb"[^>]*aria-pressed="false"/);
});
