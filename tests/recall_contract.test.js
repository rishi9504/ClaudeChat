const test = require("node:test");
const assert = require("node:assert/strict");

const retrieve = require("../retrieve");
const { executeRecallRequest } = require("../recall_request");
const { handleRecallTaskContextInput } = require("../mcp-server");

test("MCP recall_task_context and API recall use the same normalized request", async () => {
  const fakeRecall = async (input) => ({ normalized: input });
  const apiResult = await executeRecallRequest({
    project: "C:\\GithubRepos\\ClaudeChat",
    query: "stale memory",
    files: ["retrieve.js"],
    error: "",
    maxTokens: 700,
  }, { recallTaskContext: fakeRecall });
  const mcpResult = await handleRecallTaskContextInput({
    project: "C:\\GithubRepos\\ClaudeChat",
    task: "stale memory",
    files: ["retrieve.js"],
    error: "",
    maxTokens: 700,
  }, fakeRecall);

  assert.deepEqual(mcpResult.normalized, apiResult.normalized);
});

test("existing memory retrieval exports remain available", () => {
  assert.equal(typeof retrieve.searchMemory, "function");
  assert.equal(typeof retrieve.getProjectSummary, "function");
  assert.equal(typeof retrieve.buildContextBlock, "function");
  assert.equal(typeof retrieve.recallTaskContext, "function");
});

test("recall telemetry redacts obvious credentials", () => {
  const text = retrieve.redactSensitive("OPENAI_API_KEY=sk-testSECRET1234567890 password=hunter2 Authorization: Bearer abc.def");
  assert.doesNotMatch(text, /sk-testSECRET/);
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /abc\.def/);
  assert.match(text, /redacted/);
});
