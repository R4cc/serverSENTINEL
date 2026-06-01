import { startServer } from "./app.js";
import { config } from "./config.js";
import { startNodeAgent } from "./nodes/nodeAgent.js";

if (config.runtimeMode === "node") {
  await startNodeAgent();
} else {
  await startServer();
}
