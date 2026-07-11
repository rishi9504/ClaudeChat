require("dotenv").config({ path: __dirname + "/.env" });

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const Parser = require("web-tree-sitter");
const db = require("./db");
const summarize = require("./summarize");

const MAX_FILE_BYTES = 500 * 1024;
const IGNORE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", "out", "coverage", ".nuxt",
  "venv", ".venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache", "target",
  "vendor", ".idea", ".vscode", ".cache", "bin", "obj", ".gradle", "Pods",
  "DerivedData", ".terraform",
]);

const EXT_LANG = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".cs": "c_sharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
};

const DEF_NODES = new Set([
  "function_definition", "function_declaration", "method_definition", "method_declaration",
  "class_definition", "class_declaration", "interface_declaration", "enum_declaration",
  "struct_item", "struct_specifier", "impl_item", "trait_item", "mod_item",
  "lexical_declaration", "variable_declaration", "variable_declarator", "const_declaration",
  "assignment_statement", "module", "singleton_method", "method", "property_declaration",
  "arrow_function", "function_item", "constructor_declaration",
]);

const IMPORT_NODES = new Set([
  "import_statement", "import_declaration", "import_from_statement", "future_import_statement",
  "use_declaration", "use_item", "include_declaration", "preproc_include", "require",
  "require_relative", "namespace_use_declaration", "using_declaration", "package_clause",
]);

let parserReady = null;
const langCache = new Map();

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function merkleRoot(leaves) {
  if (!leaves.length) return "";
  let layer = leaves.slice().sort();
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 >= layer.length) next.push(layer[i]);
      else next.push(sha256(layer[i] + layer[i + 1]));
    }
    layer = next;
  }
  return layer[0];
}

function wasmName(lang) {
  const mapped = {
    c_sharp: "c_sharp",
    typescript: "typescript",
    tsx: "tsx",
    cpp: "cpp",
    bash: "bash",
  };
  return mapped[lang] || lang;
}

async function loadLanguage(lang) {
  if (!parserReady) parserReady = Parser.init();
  await parserReady;
  if (langCache.has(lang)) return langCache.get(lang);
  const wasmPath = path.join(__dirname, "node_modules", "tree-sitter-wasms", "out", `tree-sitter-${wasmName(lang)}.wasm`);
  if (!fs.existsSync(wasmPath)) {
    langCache.set(lang, null);
    return null;
  }
  try {
    const language = await Parser.Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(language);
    langCache.set(lang, parser);
    return parser;
  } catch (err) {
    console.error(`Could not load tree-sitter grammar for ${lang}: ${err.message}`);
    langCache.set(lang, null);
    return null;
  }
}

function nodeText(source, node) {
  return source.slice(node.startIndex, node.endIndex);
}

function sourceLine(source, row) {
  return (source.split(/\r?\n/)[row] || "").trim();
}

function stripKind(kind) {
  return kind.replace(/_(declaration|definition|item|specifier|directive)$/g, "");
}

function getName(source, node) {
  const fields = ["name", "declarator", "pattern", "left", "identifier"];
  for (const field of fields) {
    const child = node.childForFieldName ? node.childForFieldName(field) : null;
    if (child) {
      const text = nodeText(source, child).replace(/\s+/g, " ").trim();
      const match = text.match(/[A-Za-z_$][\w$]*/);
      if (match) return match[0];
    }
  }
  const text = nodeText(source, node).replace(/\s+/g, " ").trim();
  const match = text.match(/(?:function|class|interface|struct|enum|def|fn|func|trait|impl|const|let|var)\s+([A-Za-z_$][\w$]*)/);
  return match ? match[1] : text.slice(0, 80);
}

function isFunctionVariable(source, node) {
  if (node.type !== "variable_declarator") return true;
  const value = node.childForFieldName ? node.childForFieldName("value") : null;
  if (!value) return false;
  return /function|arrow_function|lambda|closure/.test(value.type) || /=>/.test(nodeText(source, value));
}

async function extractSymbols(lang, source) {
  const parser = await loadLanguage(lang);
  if (!parser) return { symbols: [], imports: [] };
  const tree = parser.parse(source);
  const symbols = [];
  const imports = [];
  const importSeen = new Set();
  const symbolSeen = new Set();
  const stack = [tree.rootNode];

  while (stack.length) {
    const node = stack.pop();
    if (IMPORT_NODES.has(node.type)) {
      const line = sourceLine(source, node.startPosition.row).slice(0, 200);
      if (line && !importSeen.has(line)) {
        importSeen.add(line);
        imports.push(line);
      }
    }
    if (DEF_NODES.has(node.type) && isFunctionVariable(source, node)) {
      const name = getName(source, node);
      const key = `${node.type}:${name}:${node.startPosition.row}`;
      if (name && !symbolSeen.has(key)) {
        symbolSeen.add(key);
        symbols.push({
          kind: stripKind(node.type),
          name: String(name).slice(0, 200),
          line: node.startPosition.row + 1,
        });
      }
    }
    for (let i = node.namedChildCount - 1; i >= 0; i -= 1) {
      stack.push(node.namedChild(i));
    }
  }
  return { symbols, imports };
}

function langForFile(file) {
  return EXT_LANG[path.extname(file).toLowerCase()] || "";
}

function walkRepo(root) {
  const absRoot = path.resolve(root);
  const stack = [absRoot];
  const files = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!EXT_LANG[ext]) continue;
      let stat;
      try {
        stat = fs.statSync(full);
      } catch (_) {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      files.push({
        relPath: path.relative(absRoot, full).replace(/\\/g, "/"),
        full,
        ext,
        size: stat.size,
      });
    }
  }
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

async function buildManifest(repoPath) {
  const root = path.resolve(repoPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`Not a directory: ${repoPath}`);
  const files = walkRepo(root);
  if (!files.length) throw new Error("No indexable files found");

  const repo = await db.query(
    `INSERT INTO repos(path, name)
     VALUES($1,$2)
     ON CONFLICT(path) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [root, path.basename(root)]
  );
  const repoId = repo.rows[0].id;
  const existingRows = await db.query("SELECT * FROM repo_files WHERE repo_id = $1", [repoId]);
  const existing = new Map(existingRows.rows.map((row) => [row.rel_path, row]));

  const upserts = [];
  let changed = 0;
  let reused = 0;

  for (const file of files) {
    const source = await fsp.readFile(file.full, "utf8");
    const hash = sha256(source);
    const old = existing.get(file.relPath);
    if (old && old.hash === hash) {
      reused += 1;
      upserts.push({
        relPath: file.relPath,
        hash,
        lang: old.lang,
        sizeBytes: file.size,
        symbols: old.symbols || [],
        imports: old.imports || [],
        summary: old.summary || "",
      });
      continue;
    }

    changed += 1;
    const lang = langForFile(file.relPath);
    const extracted = await extractSymbols(lang, source);
    const summary = await summarize.summarizeFile({
      relPath: file.relPath,
      lang,
      symbols: extracted.symbols,
      imports: extracted.imports,
      source,
    });
    upserts.push({
      relPath: file.relPath,
      hash,
      lang,
      sizeBytes: file.size,
      symbols: extracted.symbols,
      imports: extracted.imports,
      summary,
    });
  }

  const leaves = upserts.map((file) => sha256(`${file.relPath}:${file.hash}`));
  const rootHash = merkleRoot(leaves);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const file of upserts) {
      await client.query(
        `INSERT INTO repo_files(repo_id, rel_path, hash, lang, size_bytes, symbols, imports, summary, updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT(repo_id, rel_path) DO UPDATE SET
           hash = EXCLUDED.hash,
           lang = EXCLUDED.lang,
           size_bytes = EXCLUDED.size_bytes,
           symbols = EXCLUDED.symbols,
           imports = EXCLUDED.imports,
           summary = EXCLUDED.summary,
           updated_at = NOW()`,
        [
          repoId,
          file.relPath,
          file.hash,
          file.lang,
          file.sizeBytes,
          JSON.stringify(file.symbols),
          JSON.stringify(file.imports),
          file.summary,
        ]
      );
    }
    const rels = upserts.map((file) => file.relPath);
    await client.query("DELETE FROM repo_files WHERE repo_id = $1 AND NOT(rel_path = ANY($2))", [repoId, rels]);
    await client.query(
      "UPDATE repos SET merkle_root = $1, file_count = $2, last_indexed_at = NOW() WHERE id = $3",
      [rootHash, upserts.length, repoId]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const snapshot = {
    generated_at: new Date().toISOString(),
    repo: root,
    merkle_root: rootHash,
    file_count: upserts.length,
    files: upserts.map((file) => ({
      path: file.relPath,
      hash: file.hash,
      lang: file.lang,
      size_bytes: file.sizeBytes,
      symbols: file.symbols,
      imports: file.imports,
      summary: file.summary,
    })),
  };
  try {
    await fsp.writeFile(path.join(root, ".repo-index.json"), JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.error(`Warning: could not write .repo-index.json: ${err.message}`);
  }

  return { repoId, fileCount: upserts.length, changed, reused, merkleRoot: rootHash };
}

async function main() {
  const target = process.argv[2] || process.cwd();
  const result = await buildManifest(target);
  const enrich = require("./enrich");
  const enriched = await enrich.enrichRepo(result.repoId);
  console.log(JSON.stringify({ ...result, ...enriched }, null, 2));
  await db.end();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err.message);
    await db.end();
    process.exit(1);
  });
}

module.exports = {
  buildManifest,
  walkRepo,
  merkleRoot,
};
