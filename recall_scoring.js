const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "before", "but", "by", "for",
  "from", "how", "i", "in", "into", "is", "it", "of", "on", "or", "that",
  "the", "this", "to", "use", "when", "with", "without", "why", "will",
]);

const TYPE_PRIORITY = {
  solved_problem: 0.18,
  gotcha: 0.16,
  decision: 0.12,
  convention: 0.10,
  fact: 0.06,
  todo: -0.15,
};

const TYPE_LABEL = {
  solved_problem: "Previous solution",
  gotcha: "Gotcha",
  decision: "Decision",
  convention: "Convention",
  fact: "Fact",
  todo: "Todo",
};

function clampInt(value, min, max, fallback) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

function tokenize(text) {
  return Array.from(new Set(String(text || "")
    .toLowerCase()
    .match(/[a-z0-9_./-]{3,}/g) || []))
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 80);
}

function normalizeFile(file) {
  return String(file || "").replace(/\\/g, "/").toLowerCase().trim();
}

function wantsTodos(text) {
  return /\b(todo|todos|pending|open task|remaining|follow[- ]?up|unfinished|what'?s next|next steps)\b/i.test(String(text || ""));
}

function buildCombinedQuery({ query = "", error = "", files = [] } = {}) {
  return [
    query,
    error,
    (files || []).map((file) => normalizeFile(file)).filter(Boolean).join(" "),
  ].filter(Boolean).join("\n").trim();
}

function lexicalScore(artifact, queryText) {
  const queryTokens = tokenize(queryText);
  if (!queryTokens.length) return 0;
  const haystack = `${artifact.title || ""} ${artifact.content || ""} ${(artifact.files_touched || []).join(" ")}`.toLowerCase();
  const matched = queryTokens.filter((token) => haystack.includes(token)).length;
  const base = matched / Math.min(queryTokens.length, 10);
  const phrase = String(queryText || "").trim().length >= 12
    && haystack.includes(String(queryText).toLowerCase().slice(0, 120))
    ? 0.12
    : 0;
  return Math.min(0.55, base * 0.45 + phrase);
}

function fileOverlapScore(artifact, files = []) {
  const active = (files || []).map(normalizeFile).filter(Boolean);
  if (!active.length) return { score: 0, overlaps: [] };
  const touched = (artifact.files_touched || []).map(normalizeFile).filter(Boolean);
  const overlaps = [];
  for (const file of active) {
    const base = file.split("/").pop();
    if (touched.some((hit) => hit === file || hit.endsWith(`/${file}`) || file.endsWith(`/${hit}`) || hit.split("/").pop() === base)) {
      overlaps.push(file);
    }
  }
  if (!overlaps.length) return { score: 0, overlaps: [] };
  return { score: Math.min(0.50, 0.30 + (overlaps.length - 1) * 0.10), overlaps };
}

function recencyScore(createdAt, now = new Date()) {
  if (!createdAt) return 0;
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return 0;
  const ageDays = Math.max(0, (now.getTime() - created.getTime()) / 86400000);
  if (ageDays <= 30) return 0.04;
  if (ageDays <= 180) return 0.02;
  return 0;
}

function scoreArtifact(artifact, input, now = new Date()) {
  const combined = buildCombinedQuery(input);
  const lexical = lexicalScore(artifact, combined);
  const fileOverlap = fileOverlapScore(artifact, input.files);
  const vector = Math.max(0, Math.min(1, Number(artifact.vector_score || artifact.score || 0))) * 0.55;
  const type = TYPE_PRIORITY[artifact.type] || 0;
  const recency = recencyScore(artifact.created_at, now);
  const score = vector + lexical + fileOverlap.score + type + recency;
  return {
    ...artifact,
    score: Number(score.toFixed(4)),
    score_parts: {
      vector: Number(vector.toFixed(4)),
      lexical: Number(lexical.toFixed(4)),
      file: Number(fileOverlap.score.toFixed(4)),
      type: Number(type.toFixed(4)),
      recency: Number(recency.toFixed(4)),
    },
    file_overlaps: fileOverlap.overlaps,
  };
}

function dedupeArtifacts(candidates) {
  const byId = new Map();
  const bySemantic = new Map();
  for (const candidate of candidates || []) {
    const id = candidate.id != null ? String(candidate.id) : "";
    const semantic = `${candidate.type || ""}|${String(candidate.content || "").trim().toLowerCase()}`;
    const key = id || semantic;
    const existing = byId.get(key) || bySemantic.get(semantic);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) {
      byId.set(key, candidate);
      bySemantic.set(semantic, candidate);
    }
  }
  return Array.from(new Set([...byId.values(), ...bySemantic.values()]));
}

function selectRecallArtifacts(candidates, input, { maxArtifacts = 5, threshold = 0.32, now = new Date() } = {}) {
  const includeTodos = wantsTodos(`${input.query || ""}\n${input.error || ""}`);
  return dedupeArtifacts((candidates || [])
    .filter((artifact) => includeTodos || artifact.type !== "todo")
    .map((artifact) => scoreArtifact(artifact, input, now)))
    .filter((artifact) => artifact.score >= threshold)
    .sort((a, b) => b.score - a.score || String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, maxArtifacts);
}

function formatHeading(artifact) {
  const label = TYPE_LABEL[artifact.type] || artifact.type || "Memory";
  return `${label} - ${artifact.title || "Untitled"}`;
}

function renderArtifact(artifact) {
  const files = Array.isArray(artifact.files_touched) && artifact.files_touched.length
    ? `\n\nApplies to: ${artifact.files_touched.slice(0, 8).map((file) => `\`${file}\``).join(", ")}`
    : "";
  return `### ${formatHeading(artifact)}\n${String(artifact.content || "").trim()}${files}`;
}

function buildRecallContext(artifacts, { maxTokens = 700 } = {}) {
  const budget = clampInt(maxTokens, 100, 2000, 700);
  const selected = [];
  let context = "## Relevant project memory";
  for (const artifact of artifacts || []) {
    const next = `${context}\n\n${renderArtifact(artifact)}`;
    if (estimateTokens(next) > budget) {
      if (!selected.length) {
        const compact = `## Relevant project memory\n\n### ${formatHeading(artifact)}\n${String(artifact.content || "").trim()}`;
        if (estimateTokens(compact) <= budget) {
          context = compact;
          selected.push(artifact);
        }
      }
      break;
    }
    context = next;
    selected.push(artifact);
  }
  return {
    context: selected.length ? context : "",
    memories: selected,
    estimatedTokens: selected.length ? estimateTokens(context) : 0,
  };
}

module.exports = {
  buildCombinedQuery,
  buildRecallContext,
  clampInt,
  dedupeArtifacts,
  estimateTokens,
  scoreArtifact,
  selectRecallArtifacts,
  tokenize,
  wantsTodos,
};
