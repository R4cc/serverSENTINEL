# Panel-node protocol

## Compatibility modes

The public node response computes one of four modes from the negotiated protocol version:

- `current`: protocol 3.1, including optimized monitoring and negotiated transport features.
- `fallback`: protocol 3.0, fully operational through the established individual commands and JSON/base64 transfers.
- `update-only`: protocol 2.0, authenticated only for `node.update` so a panel-first rollout can recover an older node.
- `incompatible`: all other protocol versions.

Protocol 3.1 nodes advertise transport features independently from command capabilities. The panel welcome echoes the negotiated protocol and the intersection of supported features. The current features are `request-cancel` and `binary-transfer`. A node does not execute requests until it has decoded and accepted a valid welcome.

## Connection and control bounds

Protocol 3.1 JSON control frames are limited to 8 MiB. Each connection permits 64 active RPCs, 32 ordinary streams, and four binary transfers. The panel pings every 15 seconds and terminates a node that has not returned a pong within 35 seconds; a node terminates a panel connection after 45 seconds without a ping. Reconnect delay uses jittered exponential backoff from one to 30 seconds and resets after a stable accepted session. A new authenticated connection for an existing node ID explicitly supersedes the old socket.

Requests include relative deadlines when cancellation is negotiated. The panel sends `cancel` after a deadline or caller cancellation. Cooperative work aborts where possible, and responses produced after cancellation are ignored. Filesystem mutations that have crossed their commit point may complete, but their response is discarded.

## Batched observations

`server.observe` accepts up to 32 compact server specifications and any combination of `status`, `stats`, `players`, `logs`, and `overviewFiles`. A node observes at most four servers concurrently, reuses one container inspection for a server's requested sections, and returns section-specific errors without failing the rest of the batch.

The panel coordinator polls status and resource stats every five seconds and adds player and log sections every second poll. It groups servers by node, chunks fleets above 32, and supplies the existing status, runtime-state, resource-stat, player, timeline, and overview consumers from the shared cache. Ten servers on one protocol 3.1 node therefore produce about 12 background observation RPCs per minute for that node rather than one independent RPC per consumer and server.

File logs use a cursor containing source, file identity, and byte offset. Append-only reads return deltas. Rotation, truncation, identity changes, or deltas larger than 128 KiB reset the cursor to the bounded 128 KiB tail. If `logs/latest.log` is unavailable, the existing bounded Docker log tail remains the fallback.

## Binary transfers and HTTP uploads

Transfers use `transferStart`, `transferReady`, `transferFinish`, `transferResult`, and `transferCancel`. A binary chunk contains byte `0x01`, the transfer UUID as 16 raw bytes, and at most 256 KiB of payload. Send callbacks serialize chunks and bound sender buffering. The finish control carries the observed length and SHA-256 digest.

Uploads write to a temporary sibling, validate the declared length, configured limit, file type, and digest, then atomically rename the file. Disconnects, cancellation, validation failures, and shutdown remove partial files. Downloads, archive entries, panel-generated archive bundles, and manual mod/plugin uploads use the streamed path when `binary-transfer` is negotiated. Web upload routes accept both the existing JSON body and multipart form data; clients must not set the multipart `Content-Type` boundary themselves.
