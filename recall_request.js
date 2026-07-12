const retrieve = require("./retrieve");
const { clampInt } = require("./recall_scoring");

function normalizeRecallRequest(body = {}, { taskField = "query" } = {}) {
  const project = String(body.project || "").trim();
  const query = String(body.query || body.task || "").trim();
  if (!project) {
    const err = new Error("project is required");
    err.statusCode = 400;
    throw err;
  }
  if (!query) {
    const err = new Error(`${taskField} is required`);
    err.statusCode = 400;
    throw err;
  }
  const files = Array.isArray(body.files)
    ? body.files.map((file) => String(file || "").trim()).filter(Boolean).slice(0, 30)
    : [];
  return {
    project,
    query,
    files,
    error: String(body.error || "").slice(0, 6000),
    branch: String(body.branch || "").slice(0, 200),
    commit: String(body.commit || "").slice(0, 200),
    maxTokens: clampInt(body.maxTokens, 100, 2000, 700),
    maxArtifacts: clampInt(body.maxArtifacts, 1, 12, 5),
  };
}

async function executeRecallRequest(body, { recallTaskContext = retrieve.recallTaskContext, taskField = "query" } = {}) {
  return recallTaskContext(normalizeRecallRequest(body, { taskField }));
}

module.exports = {
  executeRecallRequest,
  normalizeRecallRequest,
};
