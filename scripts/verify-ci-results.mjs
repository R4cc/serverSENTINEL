import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function validationSucceeded(checks, browserRequired, browser) {
  return checks === "success" && (
    browserRequired === "true" && browser === "success"
    || browserRequired === "false" && browser === "skipped"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { CHECKS_RESULT, BROWSER_REQUIRED, BROWSER_RESULT } = process.env;
  if (!validationSucceeded(CHECKS_RESULT, BROWSER_REQUIRED, BROWSER_RESULT)) {
    console.error(`CI validation failed: checks=${CHECKS_RESULT}, browser required=${BROWSER_REQUIRED}, browser=${BROWSER_RESULT}`);
    process.exitCode = 1;
  } else {
    console.log("All required validation jobs succeeded.");
  }
}
