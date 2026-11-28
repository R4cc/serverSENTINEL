# Performance profiling

## Release startup, idle activity, and size

Use two clean checkouts with the same Linux host, Node.js, npm, Playwright browser and build
settings. Copy `scripts/performance-release.mjs` into both checkouts so they use the same fixtures.
From each checkout, run the following commands. Keep other workloads and CPU affinity consistent.

```bash
npm ci --ignore-scripts
npm run build
node scripts/performance-release.mjs panel 11
node scripts/performance-release.mjs node 11
node scripts/performance-release.mjs fleet 11
node scripts/performance-release.mjs fleet 3 30
node scripts/performance-release.mjs browser 1 25  # Repeat three times per build, alternating builds.
node scripts/performance-release.mjs size
```

The startup clock runs from process spawn to HTTP listening or a node's accepted registration.
Each trial uses a fresh data directory. The fleet scenario seeds 12 running local servers with
720 five-second samples per server. A Unix socket fixture emulates Docker and counts inspections.
Idle CPU measures process CPU from Linux `/proc` and reports the percentage of one core. The fleet
also checks the public status and resource history responses after the timed interval.

The browser uses a fresh authenticated demo context per trial. Once Overview's chart has rendered
and had two seconds to settle, the script measures main-thread CPU time and code transfers without
user input. Retained JavaScript heap is sampled after garbage collection. The first Console
navigation is measured separately so the cost of loading on demand is visible.

The `size` scenario counts file bytes in the three compiled workspaces, including precompressed
web assets. For production dependencies, run the Dockerfile's `production-dependencies` stage for
each version and sum regular file sizes inside `/app/node_modules`. For a compression comparison,
archive that directory using `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner`
and `gzip -n` in both versions. Keep the base image and architecture identical if comparing full
container images.

### November 28, 2026 results

Median results for `e2652c8` and the optimized build on the same Linux x86-64 host. Both builds
used Node.js 26.13.1, npm 12.2.1, the locked dependencies, and `NODE_ENV=production` at runtime.
Server trials shared the same two-core affinity. Browser trials used one core each.

| Workload | Before | After |
| --- | ---: | ---: |
| Panel start to HTTP listening | 555.80 ms | 504.62 ms |
| Node start to accepted registration | 397.61 ms | 165.32 ms |
| Node RSS at registration | 101.60 MiB | 83.63 MiB |
| Seeded fleet start to HTTP listening | 654.19 ms | 589.79 ms |
| Seeded fleet RSS after 30 seconds idle | 146.14 MiB | 109.84 MiB |
| Seeded fleet Docker inspections in 30 seconds | 288 | 216 |
| Seeded fleet process CPU in 30 seconds | 230 ms | 220 ms |
| First fleet history response after startup | 13.90 ms | 18.62 ms |
| Browser main-thread CPU in 25 seconds idle | 267.68 ms | 217.35 ms |
| Browser retained JavaScript heap | 11.76 MiB | 10.81 MiB |
| Idle browser code requests and encoded bytes | 20 / 227,996 B | 0 / 0 B |
| Browser navigation to a rendered Overview chart | 1,387.92 ms | 1,369.63 ms |
| First Console navigation after the idle window | 427.06 ms | 528.83 ms |
| Compiled workspace files | 5,856,886 B | 5,853,040 B |
| Production npm dependency files | 6,878,037 B | 6,585,968 B |
| Production npm dependency archive, gzip | 2,228,740 B | 2,167,031 B |

The fleet process CPU ranges overlapped. The inspection count fell by 72 in every 30-second
trial. History returned 720 samples in each trial. Restoring just the old history cache in the
otherwise optimized build raised its median fleet startup from 567.72 to 599.28 ms and startup
RSS from 118.89 to 141.03 MiB in seven trials. Importing the password helpers in a fresh Node
process took a median of 54.96 ms before and 7.38 ms after across nine trials.

With the unattended workspace imports removed, first Console navigation pays for its own code
load. Pointer and keyboard preloading still warm the destination. A separate console smoke replay
measured one fewer Overview fetch for a qualifying log frame while Console was open, with the
events request still firing when Overview opened.

The dependency-size comparison ran both Dockerfile install and pruning steps locally. Both
pruned application trees started and served compressed and ranged asset requests. The counts
cover the application and dependency payloads. The full OCI image was outside this measurement.

## Request and data workloads

Build the current code and run `node scripts/performance-profile.mjs` with the same Node.js
runtime used for the application. The script prints JSON measurements and cleans up its
temporary filesystem, in-memory database and isolated demo process. It never opens production
data. Each workload has one warmup and seven measured iterations; the reported value is the
median. Startup is measured once.

The timeline fixture contains 120,960 samples at five-second intervals over seven days, including
50 anonymous player ping measurements per sample. It measures chart projection, stored history
reads and their combined cost separately. The filesystem fixture contains 2,000 small region
files and uses the application's real directory listing and path validation. Demo measurements
cover startup, authentication session reads, application metadata and the runtime catalog.
Server-specific demo data is simulated in the browser, so these demo timings do not represent
Minecraft, Docker or remote-node workloads.

## October 3, 2026 measurements

No serverSENTINEL or Minecraft process was running in the inspected workspace. Measurements
therefore used controlled local fixtures under Node.js 22, comparing commit `85e380a` with the
optimized code on the same machine. These are local benchmark results, not production latency
guarantees.

| Workload | Before, median ms | After, median ms |
| --- | ---: | ---: |
| Timeline projection, seven days to 900 points | 225.81 | 89.96 |
| Timeline history read, seven days | 408.50 | 415.78 |
| Timeline history read and projection | 595.29 | 477.52 |
| List 2,000 region files | 30.05 | 28.90 |
| Measure world size, 2,000 files | 391.27 | 115.64 |

The unchanged read/list operations show normal timing variation. Demo startup took approximately
0.81 seconds, and the basic authenticated reads took 2–5 ms. An earlier optimized run measured
117.96 ms for timeline projection and 118.16 ms for world measurement; repeat runs fluctuate,
while the reduction relative to the baseline remains clear.

CPU sampling identified repeated `readAt` timestamp parsing as the largest chart projection
cost. Projection now parses each timestamp once and reuses the baseline reading's parsed time.
Aggregation visits each bucket once rather than allocating mapped and filtered arrays for every
resource series. Missing readings, counter resets, repeated remote observations and downtime
continue to produce the same chart gaps and rates.

World scans still validate every selected file, but overlap up to 32 file resolutions at a time.
Directory traversal remains serial, so nested directories cannot multiply that concurrency.
Every batch settles before an error is returned; path-safety errors, entry limits, nesting limits
and files disappearing during a scan retain their existing behavior.

Stored history reads remain the largest timeline cost at this fixture size. Iterating SQLite rows,
removing ping arrays in SQL, extracting columns and extracting JSON tuples were all slower than
the existing bulk read in isolated trials, so the storage query was retained. Measuring live
Docker and remote-node workloads requires an installation running those services.
