import { configuredApps } from "../src/config.js";
import { systemStatus } from "../src/media.js";

const configured = configuredApps();
console.log(JSON.stringify({ configured }, null, 2));

const ready = configured.filter((app) => app.configured).map((app) => app.name);
if (ready.length === 0) {
  console.warn("No configured apps found. Fill .env or pass env vars before running smoke.");
  process.exit(0);
}

const status = await systemStatus();
console.log(JSON.stringify({ status }, null, 2));
