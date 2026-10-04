# Performance profiling

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
