import { loadConfig } from "./config.js";
import { createFridayServer } from "./server.js";

const config = loadConfig();
const friday = await createFridayServer(config);
const address = await friday.start();

console.log(
  JSON.stringify({
    level: "info",
    event: "fridayd.ready",
    address,
    stateDir: config.stateDir,
  }),
);

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ level: "info", event: "fridayd.shutdown", signal }));
  await friday.stop();
  process.exitCode = 0;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

export { createFridayServer } from "./server.js";
export { loadConfig } from "./config.js";
