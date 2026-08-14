# Minecraft runtime architecture

## Overview

serverSENTINEL manages the common Minecraft lifecycle without treating Fabric as the lifecycle itself. Runtime-specific behavior belongs behind an explicit runtime definition or provider. Fabric and Paper are both provisionable runtimes and both advertise managed-content capabilities with runtime-appropriate compatibility rules and terminology.

Container start/stop/restart, crash recovery, console, files, schedules, query, resource collection, ports, Java selection, and server properties do not inherently depend on Fabric and must stay runtime-neutral.

## Canonical model

`ServerRuntimeProfile` uses:

- `runtimeType`: the stable runtime identifier; supported values are `fabric` and `paper`.
- `runtimeVersion`: the runtime-specific version, such as a Fabric Loader version or Paper build.
- `minecraftVersion`, Java requirement, artifact provider, artifact metadata, and compatibility status.

The shared runtime catalog supplies display terminology, version labels, default artifact filenames, content kind and directory, Modrinth loader identifier, and explicit capability flags. Code must check capabilities instead of inferring them from a runtime name. The create and edit experiences consume this catalog, so enabling a provider does not require rebuilding a Fabric-specific wizard.

## Runtime boundaries

### Artifact provider

The provider registry accepts `runtimeType`, Minecraft version, and runtime version, then dispatches to the runtime's authoritative source:

- Fabric uses MCJars through the canonical runtime catalog endpoints and profile fields.
- Paper uses PaperMC's official Fill v3 downloads service. Minecraft releases, Paper build channels, immutable artifact URLs, sizes, and SHA-256 checksums come directly from PaperMC.

Paper requests use the identifying User-Agent required by PaperMC. Automatic resolution selects a stable build only. An unstable build is accepted only when an administrator explicitly exposes development builds and selects one; the provider never silently falls back from stable to unstable.

### Version detection

Minecraft version detection remains common. Runtime version detection is selected by `runtimeType`: Fabric launcher properties and logs are isolated from Paper log patterns, and Paper log tokens are normalized to their build number. Provider metadata remains the fallback when logs are unavailable.

### Lifecycle

Artifact download, content-directory creation, metadata writing, Docker/container configuration, start, stop, restart, recovery, console, files, schedules, and query handling consume the canonical profile. Both the panel-local and remote-node paths use the same runtime-neutral terminology and capability checks.

#### Shutdown

A serverSENTINEL restart sends the Minecraft `stop` command and only falls back to `docker stop` if the console route fails, so the world is saved by Minecraft itself. Every other way a container can be stopped bypasses that: a plain stop from the panel, a `docker stop` from the shell, and the stop the daemon issues to all of its containers when Docker is restarted or upgraded. Those deliver SIGTERM to the JVM, whose shutdown hook saves and closes the world, and Docker kills it if it has not exited within the container's stop timeout.

Docker's default of ten seconds is shorter than a world save, so managed containers are created with `StopTimeout` set from `SERVERSENTINEL_MINECRAFT_STOP_TIMEOUT_SECONDS` (60 seconds by default). The value is part of the runtime configuration hash, so a container built with an older timeout is replaced on the next start rather than kept with a stale grace period. Stop and restart requests also send `t` explicitly, which covers containers created before the timeout became part of that configuration, and the Docker socket read and the panel's remote-node command timeout are both widened past it because neither endpoint answers until the container is down.

The daemon derives its own shutdown grace period from the longest container stop timeout plus five seconds, so this setting is what buys the save time during a daemon restart — bounded in turn by the service manager's stop timeout for Docker. Keeping containers running through a daemon restart entirely is a host decision serverSENTINEL cannot make for the operator: it requires `"live-restore": true` in `/etc/docker/daemon.json`. The panel and the node agent read the flag from Docker's `/info` at startup and warn when it is off.

### Managed content

The shared managed-content service owns the safe reusable workflow: JAR inspection, hashes, Modrinth metadata, cached update plans, dependency planning, enable/disable renames, removal, manual upload, restart tracking, and the existing permission keys. Runtime definitions supply the visible terminology, content directory, Modrinth project type, and compatible loader set.

- Fabric remains a `mod` adapter backed by `mods/`, the Modrinth `mod` project type, and the `fabric` loader. Its routes, stored preferences, permissions, node commands, and responses remain compatible with existing installations.
- Paper is a `plugin` adapter backed by `plugins/`, the Modrinth `plugin` project type, and Paper-compatible `paper`, `bukkit`, or `spigot` releases. Proxy-only, Folia-only, and Purpur-only releases are not treated as compatible Paper plugins.

The web workspace retains its internal route key for migration compatibility but displays Mods for Fabric and Plugins for Paper everywhere administrators interact with it. Modrinth is the managed discovery source for both runtimes; manual JAR upload remains available when a trusted plugin is distributed elsewhere. Paper reload is not used: plugin mutations retain the established restart-required lifecycle.

### Artifact trust and failure handling

Runtime download URLs are allowlisted per provider. Paper downloads must use `papermc.io` or a subdomain, and MCJars downloads retain their existing provider-host restrictions. Downloads are bounded to 512 MiB. Provider-supplied size, SHA-256, and SHA-1 metadata are verified before the target jar is written.

Version and build responses use a short success cache and a shorter stale-on-error window. Network, HTTP, malformed-response, missing-stable-build, invalid-build, unsafe-URL, size, and checksum failures remain distinct actionable errors. Provisioning cleanup retains the existing operation lifecycle, so failed creates do not leave a managed server record behind.

## Export and import

An export artifact is a ZIP holding `manifest.json` beside the real files, laid out as `servers/<key>/<path>`. The manifest carries the server records, mod preferences, the content lockfile, and a file index; the bytes are ordinary archive members, streamed in and out rather than held in memory. Files are read through the runtime abstraction, so a server on a remote node streams over the node protocol instead of being read from the panel's own disk.

Operators choose categories rather than receiving a fixed subset: server configuration, access control, mod and plugin configs, mods and plugins, world, panel settings, and logs. `backups`, `cache`, `libraries`, and `versions` are never exported because they regenerate. Ports, image, and runtime profile always travel because a record cannot be created or conflict-checked without them; schedules, Java arguments, and update channels ride on `panelSettings`.

The world category resolves `level-name` from the server's own properties, because a renamed level keeps none of its data in `world/`. It takes that folder, its Paper-style `_nether` and `_the_end` siblings, the conventional defaults as a fallback for an unreadable properties file, and `worlds/`. Datapacks live inside the level folder and travel with it. Fabric and vanilla nest the other dimensions inside the level folder, where the level entry already covers them.

The server jar is not exported: the runtime profile already names an immutable, checksummed artifact, so import downloads it the same way provisioning does. A failed download is reported per server rather than rolled back, since the rest of the restore is still worth keeping — but the server cannot start until it succeeds.

Mods and plugins default to a lockfile: content installed through the panel already records its Modrinth version, and manually uploaded jars are matched by the SHA-1 the mods list already computes. Only jars Modrinth cannot identify are carried whole. If the installed content cannot be enumerated at all, the export ships every jar instead, because that is the one case where the panel cannot know what a lockfile would leave out. Import re-downloads each lockfile entry and reports failures per file, because a Modrinth version can be withdrawn between export and import.

A path that is absent is not an export failure; any other filesystem or node error is, and it fails the export rather than producing an archive with files silently missing. Uploaded import archives are released when their operation settles, and maintenance reclaims abandoned uploads on the same tick that expires export artifacts.

Export is started from a single server's properties page and the API is given that one server id, though the endpoints still accept a list. The selected server must be stopped: a world copied from a running server can contain half-written chunks, so this is a refusal rather than a warning, checked both when the request arrives and again inside the operation. Import stays on the Nodes page because an archive can carry several servers and needs a node to restore onto; imports always create new servers and are restored onto the panel's own node, since the panel writes the files to its own servers directory.

## Upgrade floor

The direct upgrade floor is application version 1.6.2, SQLite schema 20, export schema 4, and panel-node protocol 3.1. Older databases must first be opened by version 1.6.2 so its migrations can complete.

Export schema 4 replaced the schema-3 base64-in-JSON artifact, which could only describe a handful of small configuration files. There is no conversion path: a schema-3 artifact is rejected and has to be recreated by an installation running this version.

Runtime profiles use `runtimeType` and `runtimeVersion` throughout the API, web app, panel, and node. The database reader still normalizes `loader` and `loaderVersion` when reading persisted profile JSON because an installation upgraded through 1.6.2 can retain those fields. Schema-4 manifests reject those aliases outright.
