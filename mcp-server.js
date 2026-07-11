require("dotenv").config({ path: __dirname + "/.env" });

const db = require("./db");
const retrieve = require("./retrieve");

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function main() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const server = new McpServer({ name: "project-memory", version: "1.0.0" });
  const artifactType = z.enum(["decision", "fact", "solved_problem", "convention", "todo", "gotcha"]);

  function register(name, schema, handler) {
    if (typeof server.registerTool === "function") {
      server.registerTool(name, { inputSchema: schema }, handler);
    } else {
      server.tool(name, schema, handler);
    }
  }

  register(
    "get_project_summary",
    { project: z.string() },
    async ({ project }) => {
      const summary = await retrieve.getProjectSummary(project);
      return textResult(summary || { found: false, message: "Project not found" });
    }
  );

  register(
    "search_memory",
    {
      project: z.string(),
      query: z.string(),
      k: z.number().min(1).max(25).optional(),
      types: z.array(artifactType).optional(),
    },
    async ({ project, query, k, types }) => {
      const result = await retrieve.searchMemory(project, query, k || 8, types || null);
      return textResult(result);
    }
  );

  register(
    "get_project_context",
    {
      project: z.string(),
      max: z.number().min(1).max(40).optional(),
    },
    async ({ project, max }) => {
      const result = await retrieve.buildContextBlock(project, { maxArtifacts: max || 12 });
      return textResult(result ? result.text : "Project not found");
    }
  );

  register(
    "list_projects",
    {},
    async () => {
      const rows = await db.query(
        `SELECT p.*, COUNT(a.id)::int AS artifact_count
         FROM projects p
         LEFT JOIN artifacts a ON a.project_id = p.id
         GROUP BY p.id
         ORDER BY artifact_count DESC, p.name ASC`
      );
      return textResult(rows.rows);
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("project-memory MCP server ready");
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await db.end();
    process.exit(1);
  });
}

module.exports = { main };
