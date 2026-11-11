import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseJoin } from "../src/join.ts";

test("a join link gives the address and the name", () => {
  assert.deepEqual(parseJoin("anything://join?address=136.80.15.145:25565&name=Sam%27s%20world"), {
    address: "136.80.15.145:25565",
    name: "Sam's world",
  });
  assert.deepEqual(parseJoin("anything://join/?address=play.example.com"), {
    address: "play.example.com",
    name: "play.example.com",
  });
});

test("anything that is not a plain host and port is refused", () => {
  for (const bad of [
    "anything://join?address=--world%20x",
    "anything://join?address=a.com:99999",
    "anything://join?address=a.com;calc",
    "anything://join?address=",
    "anything://build?address=a.com",
    "https://join?address=a.com",
    "not a link",
  ]) {
    assert.equal(parseJoin(bad), null, bad);
  }
});
