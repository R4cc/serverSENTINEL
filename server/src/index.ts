import { config } from "./config.js";
import { errorLogFields, hasLogSink, logError } from "./logging.js";

/**
 * Node terminates the process on an unhandled rejection. For the control plane of a set of running
 * game servers that trades one stray promise for every server losing its manager, so the rejection
 * is recorded and the process is kept alive. The node agent has no app logger, and a rejection can
 * also land before the panel's is built, so `console.error` covers both.
 */
process.on("unhandledRejection", (reason) => {
  if (hasLogSink()) {
    logError({ ...errorLogFields(reason), category: "unhandled_rejection" }, "Unhandled promise rejection");
  } else {
    console.error("Unhandled promise rejection", reason);
  }
});

if (config.runtimeMode === "node") {
  const { startNodeAgent } = await import("./nodes/nodeAgent.js");
  await startNodeAgent();
} else {
  const { startServer } = await import("./app.js");
  await startServer();
}
