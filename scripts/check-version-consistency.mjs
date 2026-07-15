import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const readText = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const version = readJson("package.json").version;

const failures = [];
for (const manifest of ["server/package.json", "shared/package.json", "web/package.json"]) {
  const actual = readJson(manifest).version;
  if (actual !== version) failures.push(`${manifest} is ${actual}; expected ${version}`);
}

const expectedText = [
  ["server/src/buildInfo.ts", `?? "${version}"`],
  ["web/src/app/appConfig.ts", `appVersion = "${version}"`],
  ["docker/Dockerfile", `ARG SS_VERSION=${version}`],
  ["docker-compose.yml", `image: nl2109/serversentinel:${version}`],
  ["docker-compose.yml", `SERVERSENTINEL_NODE_IMAGE:-nl2109/serversentinel:${version}`],
  [".env.example", `SERVERSENTINEL_NODE_IMAGE=nl2109/serversentinel:${version}`]
];

for (const [path, expected] of expectedText) {
  if (!readText(path).includes(expected)) failures.push(`${path} is missing ${expected}`);
}

if (failures.length > 0) {
  console.error(`Version metadata does not match package.json (${version}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`Version metadata is consistent at ${version}.`);
