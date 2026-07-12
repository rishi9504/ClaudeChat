const test = require("node:test");
const assert = require("node:assert/strict");

const extract = require("../extract");

test("unchanged transcript does not trigger re-extraction", () => {
  assert.equal(extract.needsExtraction({
    source_hash: "abc",
    last_extracted_hash: "abc",
  }, false), false);
});

test("changed transcript does trigger re-extraction", () => {
  assert.equal(extract.needsExtraction({
    source_hash: "abc",
    last_extracted_hash: "def",
  }, false), true);
});

test("force overrides freshness check", () => {
  assert.equal(extract.needsExtraction({
    source_hash: "abc",
    last_extracted_hash: "abc",
  }, true), true);
});

test("session artifact replacement targets only the current session", async () => {
  const calls = [];
  const client = {
    query(sql, params) {
      calls.push({ sql, params });
      return Promise.resolve({ rowCount: 2 });
    },
  };
  await extract.deleteSessionArtifacts(client, 42);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM artifacts WHERE session_ref = \$1/);
  assert.deepEqual(calls[0].params, [42]);
});
