# Minecraft runtime architecture

## Goal

serverSENTINEL manages the common Minecraft lifecycle without treating Fabric as the lifecycle itself. Runtime-specific behavior belongs behind an explicit runtime definition or provider. Fabric and Paper are both provisionable runtimes and both advertise managed-content capabilities with runtime-appropriate compatibility rules and terminology.

## Audit of the previous Fabric coupling

The Fabric assumption crossed every package boundary:

- Shared contracts described every runtime as a `loader` with a `loaderVersion`.
- SQLite stored that shape in `runtime_profile_json`; imports and node messages validated or forwarded it.
- The panel and remote node resolved only Fabric artifacts, downloaded a Fabric launcher, created `mods/`, and wrote Fabric-only version metadata.
- Version detection inspected Fabric `install.properties` and Fabric log messages.
- Server creation, editing, lists, summary cards, and workspace metadata displayed Fabric directly.
- Modrinth searches, dependency resolution, updates, restart tracking, and the original Mods workspace mixed reusable content behavior with Fabric-specific paths, project types, loaders, and copy.
- Release smoke documentation describes managed Fabric provisioning only.

Container start/stop/restart, crash recovery, console, files, schedules, query, resource collection, ports, Java selection, and server properties do not inherently depend on Fabric and must stay runtime-neutral.

## Canonical model

`ServerRuntimeProfile` now uses:

- `runtimeType`: the stable runtime identifier, currently `fabric` or `paper`.
- `runtimeVersion`: the runtime-specific version, such as a Fabric Loader version or Paper build.
- `minecraftVersion`, Java requirement, artifact provider, artifact metadata, and compatibility status.

The shared runtime catalog supplies display terminology, version labels, default artifact filenames, content kind and directory, Modrinth loader identifier, and explicit capability flags. Code must check capabilities instead of inferring them from a runtime name. The create and edit experiences consume this catalog, so enabling a provider does not require rebuilding a Fabric-specific wizard.

Fabric continues to emit legacy `loader` and `loaderVersion` aliases temporarily. New code must not use those aliases as its canonical model.

## Runtime boundaries

### Artifact provider

The provider registry accepts `runtimeType`, Minecraft version, and runtime version, then dispatches to the runtime's authoritative source:

- Fabric remains on MCJars and preserves all legacy endpoints and profile aliases.
- Paper uses PaperMC's official Fill v3 downloads service. Minecraft releases, Paper build channels, immutable artifact URLs, sizes, and SHA-256 checksums come directly from PaperMC.

Paper requests use the identifying User-Agent required by PaperMC. Automatic resolution selects a stable build only. An unstable build is accepted only when an administrator explicitly exposes development builds and selects one; the provider never silently falls back from stable to unstable.

### Version detection

Minecraft version detection remains common. Runtime version detection is selected by `runtimeType`: Fabric launcher properties and logs are isolated from Paper log patterns, and Paper log tokens are normalized to their build number. Provider metadata remains the fallback when logs are unavailable.

### Lifecycle

Artifact download, content-directory creation, metadata writing, Docker/container configuration, start, stop, restart, recovery, console, files, schedules, and query handling consume the canonical profile. Both the panel-local and remote-node paths use the same runtime-neutral terminology and capability checks.

### Managed content

The shared managed-content service owns the safe reusable workflow: JAR inspection, hashes, Modrinth metadata, cached update plans, dependency planning, enable/disable renames, removal, manual upload, restart tracking, and the existing permission keys. Runtime definitions supply the visible terminology, content directory, Modrinth project type, and compatible loader set.

- Fabric remains a `mod` adapter backed by `mods/`, the Modrinth `mod` project type, and the `fabric` loader. Its routes, stored preferences, permissions, node commands, and responses remain compatible with existing installations.
- Paper is a `plugin` adapter backed by `plugins/`, the Modrinth `plugin` project type, and Paper-compatible `paper`, `bukkit`, or `spigot` releases. Proxy-only, Folia-only, and Purpur-only releases are not treated as compatible Paper plugins.

The web workspace retains its internal route key for migration compatibility but displays Mods for Fabric and Plugins for Paper everywhere administrators interact with it. Modrinth is the managed discovery source for both runtimes; manual JAR upload remains available when a trusted plugin is distributed elsewhere. Paper reload is not used: plugin mutations retain the established restart-required lifecycle.

### Artifact trust and failure handling

Runtime download URLs are allowlisted per provider. Paper downloads must use `papermc.io` or a subdomain, and MCJars downloads retain their existing provider-host restrictions. Downloads are bounded to 512 MiB. Provider-supplied size, SHA-256, and legacy SHA-1 metadata are verified before the target jar is written.

Version and build responses use a short success cache and a shorter stale-on-error window. Network, HTTP, malformed-response, missing-stable-build, invalid-build, unsafe-URL, size, and checksum failures remain distinct actionable errors. Provisioning cleanup retains the existing operation lifecycle, so failed creates do not leave a managed server record behind.

## Compatibility migration

No SQLite table migration is required because runtime profiles are stored as JSON. On read/import, the normalizer accepts either:

- canonical `runtimeType` and `runtimeVersion`; or
- the legacy Fabric `loader` and `loaderVersion` pair.

Legacy Fabric data is normalized to the canonical model and is written canonically on the next normal repository update. Fabric aliases remain in normalized profiles and responses during the rolling panel/node upgrade window so an updated panel can still communicate with an older node and an updated node can still serve an older web client. Conflicting canonical and legacy values are rejected rather than guessed.

New Paper profiles use `jarProvider: "papermc"`. Earlier imported Paper profiles that identify MCJars remain readable and controllable; a successful runtime refresh or version change moves their artifact metadata to PaperMC. This is another JSON-profile evolution and does not require a SQLite table migration.

Exports accept both shapes during the compatibility window. A later release may remove the aliases only after the minimum supported node protocol and export schema have advanced.

## Rollout order

1. Foundation: canonical contracts, legacy normalization, runtime catalog/capabilities, generic routes and lifecycle paths, runtime-aware UI, and Fabric-gated Mods behavior.
2. Paper core support: official artifact provider, stable build selection, integrity verification, create/edit/refresh, local and remote provisioning, and Paper-aware version information.
3. Core lifecycle rollout: verify start/stop/restart, console, files, schedules, query/monitoring, crash recovery, import/export, node reconnects, desktop, and mobile behavior.
4. Plugin management: enable the shared managed-content service for Paper, add canonical `content.*` node commands, keep legacy Fabric `mods.*` commands, and ship runtime-specific plugin UX and compatibility filters.
5. Compatibility cleanup: remove Fabric aliases only in a separately announced node protocol/export migration after the rolling-upgrade window closes.

## Test matrix

- Contract/profile: canonical Fabric, legacy Fabric upgrade, canonical Paper, conflicting aliases, unsupported runtime, unsafe artifacts.
- Persistence: existing SQLite JSON, reopen after normalization/write, Fabric and Paper import/export, malformed profiles.
- Provider: runtime dispatch, version/build selection, cache/failure behavior, unsupported adapters, download URL policy.
- Lifecycle: local and remote create/edit where enabled, container recreation, start/stop/restart/crash recovery, startup intent, Java/image selection, ports, console, files, schedules, query, and metadata.
- Content: Fabric Mods behavior unchanged; Paper reads and mutates only `plugins/`; search/version/install/update accept Paper, Bukkit, and Spigot plugin releases and reject unrelated loaders; both runtimes participate in cached background update refresh.
- Web: Mods terminology remains unchanged for Fabric; Paper consistently shows Plugins across navigation, discovery, upload, installed lists, compatibility review, details, jobs, update summaries, and permissions.
- Rollout: updated panel with legacy Fabric database, updated panel with older node, updated node with older panel payload, and export round trips across the compatibility window.
