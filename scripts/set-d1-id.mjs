import { readFile, writeFile } from "node:fs/promises";

const databaseId = process.argv[2];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (!databaseId || !uuidPattern.test(databaseId)) {
  throw new Error("A valid D1 database UUID is required.");
}

const configPath = new URL("../wrangler.jsonc", import.meta.url);
const config = JSON.parse(await readFile(configPath, "utf8"));
const databases = config.d1_databases;

if (!Array.isArray(databases)) {
  throw new Error("wrangler.jsonc does not define d1_databases.");
}

const binding = databases.find((database) => database.binding === "DB");

if (!binding) {
  throw new Error("wrangler.jsonc does not define the DB binding.");
}

binding.database_id = databaseId;

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
