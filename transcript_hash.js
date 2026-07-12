const crypto = require("crypto");

function normalizeMessages(messages) {
  return (messages || []).map((message, index) => ({
    captured_at: message.captured_at || message.timestamp || "",
    content: String(message.content || ""),
    role: String(message.role || ""),
    seq: Number.isInteger(message.seq) ? message.seq : index,
  }));
}

function transcriptHash(messages) {
  const payload = JSON.stringify(normalizeMessages(messages));
  return crypto.createHash("sha256").update(payload).digest("hex");
}

module.exports = {
  normalizeMessages,
  transcriptHash,
};
