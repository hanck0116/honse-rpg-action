const databaseName = process.argv[2];

if (!databaseName) {
  throw new Error("Usage: node scripts/find-d1-id.mjs <database-name>");
}

let input = "";

for await (const chunk of process.stdin) {
  input += chunk;
}

const databases = JSON.parse(input);

if (!Array.isArray(databases)) {
  throw new Error("Unexpected response from `wrangler d1 list --json`.");
}

const matches = databases.filter((database) => database.name === databaseName);

if (matches.length > 1) {
  throw new Error(`More than one D1 database is named ${databaseName}.`);
}

if (matches.length === 1) {
  process.stdout.write(matches[0].uuid);
}
