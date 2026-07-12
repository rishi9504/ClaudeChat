const { readdirSync } = require("fs");
const { join } = require("path");
const { spawnSync } = require("child_process");

const dir = __dirname;
const files = readdirSync(dir)
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => join(dir, file));

const result = spawnSync(process.execPath, ["--test", ...files], {
  stdio: "inherit",
});

process.exit(result.status || 0);
