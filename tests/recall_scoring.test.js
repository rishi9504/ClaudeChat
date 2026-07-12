const test = require("node:test");
const assert = require("node:assert/strict");

const scoring = require("../recall_scoring");

const now = new Date("2026-07-11T00:00:00Z");

test("recall boosts memories that reference active files", () => {
  const selected = scoring.selectRecallArtifacts([
    {
      id: 1,
      type: "fact",
      title: "Generic stale memory note",
      content: "The hook can return stale memory.",
      files_touched: ["README.md"],
      created_at: now,
    },
    {
      id: 2,
      type: "fact",
      title: "Session hook stale memory",
      content: "The hook can return stale memory.",
      files_touched: ["session_start_hook.py"],
      created_at: now,
    },
  ], {
    query: "stale memory hook",
    files: ["session_start_hook.py"],
  }, { now, maxArtifacts: 2 });

  assert.equal(selected[0].id, 2);
  assert.ok(selected[0].score > selected[1].score);
});

test("recall returns no context for an unrelated query", () => {
  const selected = scoring.selectRecallArtifacts([
    {
      id: 1,
      type: "fact",
      title: "Database backup",
      content: "Backups include sessions and bookmarks.",
      files_touched: ["backup.js"],
      created_at: now,
    },
  ], {
    query: "render a calendar widget",
    files: [],
  }, { now });
  const rendered = scoring.buildRecallContext(selected, { maxTokens: 700 });

  assert.deepEqual(selected, []);
  assert.equal(rendered.context, "");
  assert.equal(rendered.estimatedTokens, 0);
});

test("recall respects maxArtifacts", () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    type: "solved_problem",
    title: `Import fix ${index}`,
    content: `Transcript import stale extraction source hash messages case ${index}.`,
    files_touched: ["bulk_import.py"],
    created_at: now,
  }));
  const selected = scoring.selectRecallArtifacts(candidates, {
    query: "transcript import stale extraction",
    files: ["bulk_import.py"],
  }, { now, maxArtifacts: 3 });

  assert.equal(selected.length, 3);
});

test("recall approximately respects maxTokens", () => {
  const selected = scoring.selectRecallArtifacts([
    {
      id: 1,
      type: "solved_problem",
      title: "Short fix",
      content: "Use source hashes to invalidate extraction.",
      files_touched: ["extract.js"],
      created_at: now,
    },
    {
      id: 2,
      type: "gotcha",
      title: "Large note",
      content: "memory ".repeat(600),
      files_touched: ["retrieve.js"],
      created_at: now,
    },
  ], {
    query: "source hashes invalidate extraction memory",
    files: ["extract.js"],
  }, { now, maxArtifacts: 5 });
  const rendered = scoring.buildRecallContext(selected, { maxTokens: 100 });

  assert.ok(rendered.estimatedTokens <= 100);
  assert.ok(rendered.memories.length >= 1);
});
