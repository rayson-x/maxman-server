import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectTests(path);
      return entry.isFile() && entry.name.endsWith(".test.js") ? [path] : [];
    }),
  );
  return nested.flat();
}

const testFiles = (await collectTests(resolve("dist"))).sort();
if (testFiles.length === 0) {
  throw new Error("No compiled *.test.js files found under dist");
}

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...testFiles],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
