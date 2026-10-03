# Backend access review — 2026-10-03

This review covers panel authentication and permissions, CSRF and proxy handling, node enrollment and transport, Docker access, runtime files, archives, outbound artifact URLs, and production dependencies. The changes are versioned as `26.10.4`.

## Patched findings

| Finding | Change |
| --- | --- |
| A node's overview read followed `server.properties` and `eula.txt` without containment validation. A managed workload could replace these with links to node files. | Both runtimes validate configuration paths, use file handles that refuse final-component symlinks on Linux, check regular-file types, and bound configuration reads to the existing 2 MiB editor limit. |
| Runtime settings and artifact writes could follow filesystem links or overwrite an external inode through a hard link. | Properties, version metadata, and runtime JAR updates publish complete temporary files by rename, with exclusive temporary creation and handle-based permission updates. Existing file modes and the normal umask for new files are preserved. |
| Replacing a managed server root with a symlink changed the filesystem boundary itself. | Local containment and node root resolution reject a symlinked server root. |
| Console tails, range reads, node downloads, and file duplication reopened validated paths while following their final component. | These operations use the contained-file helpers; duplication reads and copies the opened inode, and node downloads derive size and type from their opened handle. |
| Docker console readers accepted a configured container name without checking that the server owned the container. | Local and node log fallback and live streaming verify the managed server ownership label, then use the inspected container ID for the log request. |
| An authenticated console socket retained access after its session expired or was revoked, or its user's permissions changed. | Each output event checks the current session and user permissions. Idle sockets check every five seconds. Revocation stops output and detaches the upstream immediately, then closes the socket. |
| Account creation and password resets could finish after the requesting administrator lost access while password hashing waited. | Account mutations re-resolve the current session and check `users.manage` after hashing, before changing accounts. |

## Compatibility

- HTTP panel access and HTTP/WebSocket node connections remain supported. HTTPS cookies and existing reverse-proxy handling are retained.
- Panel-node protocol stays at 3.1; no new handshake fields, RPCs, capabilities, or migration are required.
- Normal login, settings updates, JAR updates, file copying, and owned-container logs retain their existing request and response formats.
- External filesystem links and symlinked server roots are rejected. Those paths cannot be treated as safe managed-server boundaries.
- Deploy the updated build to both the panel and remote nodes to apply the runtime fixes on both sides.

## Validation and remaining limits

Regression tests exercise account revocation, actual WebSocket revocation and delayed attachment, local and node container-log ownership, root and directory-link escapes, bounded configuration reads, hard-link-safe settings updates, and ordinary file behavior. Full repository tests, typecheck, build, version consistency, and console rendering/loading browser smokes are the handoff checks. `npm audit --omit=dev` reported zero known vulnerabilities.

The local environment is Windows. POSIX-only final-component symlink tests are present but skipped here; Linux CI must exercise them. Directory-junction containment, hard-link writes, account and socket revocation, and ownership tests run locally.

This patch does not make managed workloads a complete host filesystem sandbox. As documented in `server/src/core.ts`, a concurrently replaced ancestor directory can still race pathname validation; eliminating that class across every filesystem mutation requires descriptor-relative operations beyond the current path-based runtime. HTTP also retains its existing lack of transport encryption. Node secrets and the Docker socket remain privileged credentials/interfaces by design.
