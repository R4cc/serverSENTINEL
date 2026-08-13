import { existsSync, readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const version = readJson("package.json").version;

const failures = [];
const calendarVersionPattern = /^\d{2}\.(?:[1-9]|1[0-2])\.[1-9]\d*$/;
if (!calendarVersionPattern.test(version)) {
  failures.push(`package.json version ${version} does not use YY.M.N calendar versioning`);
}
for (const manifest of ["server/package.json", "shared/package.json", "web/package.json"]) {
  const actual = readJson(manifest).version;
  if (actual !== version) failures.push(`${manifest} is ${actual}; expected ${version}`);
}

const expectedText = [
  // The 1.7.1 entry was missed because nothing checked for it; the release shipped with
  // the changelog's newest entry still reading 1.7.0. This script also runs inside the
  // Docker build stage, so every path listed here must be COPYed in before `npm run build`.
  ["CHANGELOG.md", `## ${version} - `],
  ["server/src/buildInfo.ts", `?? "${version}"`],
  ["web/src/app/appConfig.ts", `appVersion = "${version}"`],
  ["docker/Dockerfile", `ARG SS_VERSION=${version}`],
  ["docker/Dockerfile", "COPY docker-compose.yml .env.example README.md CHANGELOG.md ./"],
  ["docker-compose.yml", "image: nl2109/serversentinel:latest"],
  ["docker-compose.yml", "SERVERSENTINEL_NODE_IMAGE:-nl2109/serversentinel:latest"],
  [".env.example", "SERVERSENTINEL_NODE_IMAGE=nl2109/serversentinel:latest"],
  ["README.md", "image: nl2109/serversentinel:latest"],
  ["README.md", "SERVERSENTINEL_NODE_IMAGE:-nl2109/serversentinel:latest"]
];

for (const [path, expected] of expectedText) {
  if (!readText(path).includes(expected)) failures.push(`${path} is missing ${expected}`);
}

// The screenshot workflow runs the browser scripts inside Playwright's own container, which ships
// only the browser build its release pins. Bumping the playwright package without the image leaves
// the job to fail on missing binaries after the whole environment is already up. `.github` is not
// COPYed into the Docker build stage, so this check only runs from a checkout.
const screenshotWorkflow = "../.github/workflows/readme-screenshots.yml";
if (existsSync(new URL(screenshotWorkflow, import.meta.url))) {
  const playwrightVersion = readJson("package.json").devDependencies.playwright.replace(/^\D*/, "");
  const expectedImage = `mcr.microsoft.com/playwright:v${playwrightVersion}-noble`;
  if (!readText(".github/workflows/readme-screenshots.yml").includes(expectedImage)) {
    failures.push(`.github/workflows/readme-screenshots.yml is missing ${expectedImage}`);
  }
}

if (failures.length > 0) {
  console.error(`Version metadata does not match package.json (${version}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Version metadata is consistent at ${version}.`);
