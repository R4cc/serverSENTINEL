import type { FastifyInstance, FastifyRequest } from "fastify";

import { randomUUID } from "node:crypto";
import { panelNodeConnections, services } from "../appServices.js";
import { config } from "../config.js";
import { appBuildId, appVersion } from "../buildInfo.js";
import { destructiveRateLimit, nodeJoinRateLimit } from "../http/rateLimits.js";
import { optionalNodeDataMount, optionalNodePanelUrl, requireStrictBoolean, validateDockerImageName, validateNodeName } from "../http/validation.js";
import { apiErrorResponse, operationInProgress, throwHttp } from "../http/errors.js";
import { dockerAvailable, dockerRequest } from "../docker/dockerClient.js";
import { compareVersionStrings } from "@serversentinel/contracts";
import { requireRequestPermission } from "../auth/sessionService.js";

import { activeNodeUpdates, cleanupNodeServerContainers, createJoinToken, hashNodeSecret, nodeInstallInstructions, nodeNotFound, nodeServerCleanupError, nodeUpdateAlreadyCurrent, nodeUpdateImageForBuild, nodeUpdateNeedsManualRecreate, optionalNodeTotalMemory, publicNodeWithSettings, publicNodes, readNodes, updateNodes, verifyNodeSecret } from "../nodes/nodeService.js";
import { setNodeUpdateNotificationsEnabled } from "../nodes/nodeUpdateNotifications.js";
import { clearNodeUpdateFailure, setNodeUpdateFailure } from "../nodes/nodeUpdateStatus.js";

import { listManagedServers } from "../servers/store.js";
import { logDebug, logInfo, logWarn, errorLogFields } from "../logging.js";
import type { CreateNodeResponse } from "@serversentinel/contracts";

import { nodeAdvertisesCapability, nodeFeatures, nodeProtocolVersion, normalizeNodeHello } from "../nodes/protocol.js";
import type { NodeHello, PanelWelcome } from "../nodes/protocol.js";
import { newNodeSecret } from "../nodes/nodeAgent.js";
import type { ManagedNode } from "../types.js";

/** How long a node may stay away after an update before the panel calls the attempt failed. Matches the Nodes page grace. */
const nodeUpdateReconnectGraceMs = 5 * 60 * 1000;

type CreateNodeRoute = {
  Body: { name?: string; tokenTtlMinutes?: number; dataMount?: string; panelUrl?: string };
};

async function createNode(request: FastifyRequest<CreateNodeRoute>): Promise<CreateNodeResponse> {
  await requireRequestPermission(request, "users.manage");
  const now = new Date().toISOString();
  const token = createJoinToken(request.body.tokenTtlMinutes);
  const nodeName = validateNodeName(request.body.name);
  const panelUrl = optionalNodePanelUrl(request.body.panelUrl);
  const dataMount = optionalNodeDataMount(request.body.dataMount);
  const node: ManagedNode = {
    id: randomUUID(),
    name: nodeName,
    type: "remote",
    status: "unknown",
    isInternal: false,
    createdAt: now,
    updatedAt: now,
    capabilities: [],
    joinTokenHash: hashNodeSecret(token.joinToken),
    joinTokenExpiresAt: token.expiresAt
  };
  services.nodesRepository.create(node);
  return {
    node: publicNodeWithSettings(node),
    joinToken: token.joinToken,
    expiresAt: token.expiresAt,
    install: nodeInstallInstructions({ panelUrl, joinToken: token.joinToken, dataMount, nodeName })
  };
}

async function markNodeOfflineIfConnectionUnchanged(node: ManagedNode) {
  const connectedAt = node.connectedAt;
  const now = new Date().toISOString();
  await updateNodes((nodes) => {
    const current = nodes.find((candidate) => candidate.id === node.id);
    if (!current || current.connectedAt !== connectedAt) return;
    current.status = "offline";
    current.updatedAt = now;
  });
}

export function registerNodeRoutes(app: FastifyInstance) {
app.get("/api/nodes", async (request) => {
  await requireRequestPermission(request, "servers.view");
  return { nodes: await publicNodes(await readNodes()) };
});

app.post<CreateNodeRoute>("/api/nodes", destructiveRateLimit, createNode);

app.post<CreateNodeRoute>("/api/nodes/pending", destructiveRateLimit, createNode);

app.post<{ Params: { nodeId: string }; Body: { tokenTtlMinutes?: number; dataMount?: string; panelUrl?: string } }>("/api/nodes/:nodeId/rotate-token", destructiveRateLimit, async (request): Promise<CreateNodeResponse> => {
  await requireRequestPermission(request, "users.manage");
  const token = createJoinToken(request.body.tokenTtlMinutes);
  const panelUrl = optionalNodePanelUrl(request.body.panelUrl);
  const dataMount = optionalNodeDataMount(request.body.dataMount);
  const updatedNode = services.nodesRepository.updateById(request.params.nodeId, (node) => {
    if (node.isInternal) {
      throw new Error("Internal node tokens cannot be rotated");
    }
    return {
      ...node,
      joinTokenHash: hashNodeSecret(token.joinToken),
      joinTokenExpiresAt: token.expiresAt,
      updatedAt: new Date().toISOString()
    };
  });
  return {
    node: publicNodeWithSettings(updatedNode),
    joinToken: token.joinToken,
    expiresAt: token.expiresAt,
    install: nodeInstallInstructions({ panelUrl, joinToken: token.joinToken, dataMount, nodeName: updatedNode.name })
  };
});

app.get<{ Params: { nodeId: string }; Querystring: { panelUrl?: string; dataMount?: string } }>("/api/nodes/:nodeId/install", async (request) => {
  await requireRequestPermission(request, "servers.view");
  const panelUrl = optionalNodePanelUrl(request.query.panelUrl);
  const dataMount = optionalNodeDataMount(request.query.dataMount);
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  return {
    node: publicNodeWithSettings(node),
    install: nodeInstallInstructions({ panelUrl, dataMount, nodeName: node.name })
  };
});

app.put<{ Params: { nodeId: string }; Body: { enabled?: boolean } }>("/api/nodes/:nodeId/update-notifications", async (request) => {
  await requireRequestPermission(request, "users.manage");
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  const enabled = requireStrictBoolean(request.body?.enabled, "enabled");
  setNodeUpdateNotificationsEnabled(services.storageDatabase, node.id, enabled);
  logInfo({ action: "configure_node_update_notifications", nodeId: node.id, enabled, status: "succeeded" }, "Node update notification setting changed");
  return { ok: true, node: publicNodeWithSettings(node) };
});

app.post<{ Params: { nodeId: string }; Body: { image?: string } }>("/api/nodes/:nodeId/update", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const body = request.body ?? {};
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  if (node.isInternal) {
    throw new Error("Internal node cannot be updated from the Nodes page.");
  }
  const nodePanelVersionComparison = compareVersionStrings(node.agentVersion, appVersion);
  if (nodePanelVersionComparison === 1) {
    throw new Error(`Node agent ${node.agentVersion} is newer than this panel (${appVersion}). Update the panel before updating this node image.`);
  }
  if (node.agentVersion && node.agentVersion !== appVersion && nodePanelVersionComparison === null) {
    throw new Error(`Node agent version ${node.agentVersion} could not be compared with panel version ${appVersion}. Update the panel and node to matching release versions.`);
  }
  const alreadyCurrent = nodeUpdateAlreadyCurrent(node, body.image);
  if (alreadyCurrent) {
    return { ok: true, mode: "current", message: `Node ${node.name} is already running the current panel build.` };
  }
  if (activeNodeUpdates.has(node.id)) operationInProgress(`An update is already running for node ${node.name}`, "NODE_UPDATE_IN_PROGRESS");
  const image = validateDockerImageName(body.image?.trim() || nodeUpdateImageForBuild(config.nodeImage, appBuildId));
  if (nodeUpdateNeedsManualRecreate(node.agentVersion, body.image)) {
    return {
      ok: false,
      mode: "manual",
      // Deliberately no copyable command: the only correct one repeats this host's own volumes and
      // environment, and a plain `docker pull` reads like the whole fix while changing nothing.
      message: `Node agent ${node.agentVersion} cannot update itself to ${appVersion}: it builds its replacement container from the image it is running, whose entrypoint the current image no longer has. Pulling ${image} is not enough on its own — the running container keeps the old agent until it is replaced. Recreate the node container once on its host with the same volumes and environment (\`docker compose pull && docker compose up -d\`, or \`docker rm -f\` followed by the command under Install instructions). It rejoins with the identity in its data volume, and panel updates work again from then on.`,
      image
    };
  }
  if (node.status !== "online") {
    return {
      ok: false,
      mode: "offline",
      message: "Node is offline. Update it on the node host, then refresh this page.",
      image,
      command: `docker pull ${image}`
    };
  }
  if (!panelNodeConnections.isConnected(node.id)) {
    return {
      ok: false,
      mode: "offline",
      message: "Node is not connected to the panel right now. Update it on the node host, then refresh this page.",
      image,
      command: `docker pull ${image}`
    };
  }
  activeNodeUpdates.set(node.id, body.image?.trim() ? {} : { version: appVersion, buildId: appBuildId });
  clearNodeUpdateFailure(services.storageDatabase, node.id);
  let result: unknown;
  try {
    result = await panelNodeConnections.request(node, "node.update", { image }, 30_000);
  } catch (error) {
    activeNodeUpdates.delete(node.id);
    throw error;
  }
  const updateResult = result as { ok?: boolean; mode?: string };
  if (updateResult.ok && updateResult.mode === "self") {
    await markNodeOfflineIfConnectionUnchanged(node);
    // A node that reports its own failure clears this entry on its next handshake. One that never
    // comes back cannot report anything, so the panel records the outcome itself rather than
    // leaving the Nodes page showing an update that is still "in progress" hours later.
    setTimeout(() => {
      if (!activeNodeUpdates.delete(node.id)) return;
      setNodeUpdateFailure(services.storageDatabase, node.id, {
        at: new Date().toISOString(),
        stage: "reconnect",
        image,
        recovered: false,
        message: `${node.name} did not reconnect with the updated agent within ${Math.round(nodeUpdateReconnectGraceMs / 60_000)} minutes. Check the node host, then retry the update or recreate the node container manually.`
      });
      logWarn({ nodeId: node.id, nodeName: node.name, image, action: "node_update", status: "failed" }, "Node did not reconnect after an update");
    }, nodeUpdateReconnectGraceMs).unref();
  } else {
    activeNodeUpdates.delete(node.id);
  }
  return result;
});

app.delete<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/update-failure", async (request) => {
  await requireRequestPermission(request, "users.manage");
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  clearNodeUpdateFailure(services.storageDatabase, node.id);
  return { ok: true, node: publicNodeWithSettings(node) };
});

app.post<{ Params: { nodeId: string } }>("/api/nodes/:nodeId/restart", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  if (node.isInternal) {
    if (!dockerAvailable()) {
      throw new Error("Docker socket is not mounted on the panel container. Mount the Docker socket to restart the panel container.");
    }
    const containerId = process.env.HOSTNAME || "";
    if (!containerId) {
      throw new Error("Could not determine the panel container ID.");
    }
    setTimeout(() => {
      void dockerRequest("POST", `/containers/${encodeURIComponent(containerId)}/restart?t=10`, 204).catch((error) => {
        console.error(`Panel self-restart failed: ${(error as Error).message}`);
      });
    }, 500);
    return {
      ok: true,
      message: "Panel container restart started. The panel will reconnect shortly."
    };
  }

  if (node.status !== "online") {
    throwHttp(409, "Node is offline.", { code: "NODE_OFFLINE" });
  }
  if (!panelNodeConnections.isConnected(node.id)) {
    throwHttp(409, "Node is not connected to the panel right now.", { code: "NODE_OFFLINE" });
  }

  // The node schedules the container restart after responding. The socket close is the authoritative
  // offline transition; predicting it here leaves a live node stuck offline if Docker rejects the
  // delayed restart.
  return panelNodeConnections.request(node, "node.restart", {}, 30_000);
});

app.delete<{ Params: { nodeId: string }; Querystring: { force?: string } }>("/api/nodes/:nodeId", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "users.manage");
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) nodeNotFound(request.params.nodeId);
  if (node.isInternal) {
    throw new Error("Internal node cannot be deleted");
  }
  const servers = await listManagedServers();
  const assignedServers = servers.filter((server) => server.nodeId === request.params.nodeId);
  const force = request.query.force === "true";
  const serverCleanup = await cleanupNodeServerContainers({
    node,
    assignedServers,
    isConnected: (candidate) => panelNodeConnections.isConnected(candidate.id),
    deleteServerContainer: (candidate, server) => panelNodeConnections.request(candidate, "server.delete", { server, input: { deleteFiles: false } }, 15_000)
  });
  const cleanupError = nodeServerCleanupError(serverCleanup);
  if (cleanupError && !force) {
    throw new Error(`${cleanupError} Use force remove only if the node is stale or you will clean up containers manually.`);
  }
  const canAttemptSelfRemoval = !cleanupError && nodeAdvertisesCapability(node, "node.remove") && panelNodeConnections.isConnected(node.id);
  let selfRemoval: { ok: boolean; message: string } = canAttemptSelfRemoval
    ? { ok: false, message: "Node container self-stop was not attempted." }
    : cleanupError
      ? { ok: false, message: "Node container self-stop was skipped because server container cleanup did not complete." }
      : { ok: false, message: "Node is offline or does not support panel-triggered self-stop. Stop its container manually if it is still running." };
  if (canAttemptSelfRemoval) {
    try {
      const result = await panelNodeConnections.request(node, "node.remove", undefined, 10_000) as { message?: string };
      selfRemoval = { ok: true, message: result.message || "Node container will stop itself." };
    } catch (error) {
      selfRemoval = {
        ok: false,
        message: error instanceof Error ? error.message : "Node container self-stop failed. Stop it manually if it is still running."
      };
    }
  }
  const { deletedServers } = services.nodesRepository.deleteWithServers(request.params.nodeId, force || assignedServers.length > 0);
  panelNodeConnections.disconnect(request.params.nodeId);
  return { ok: true, deletedServers, selfRemoval, serverCleanup: assignedServers.length ? serverCleanup : undefined };
});

app.get<{ Params: { nodeId: string } }>("/api/nodes/:nodeId", async (request, reply) => {
  await requireRequestPermission(request, "servers.view");
  const node = (await readNodes()).find((candidate) => candidate.id === request.params.nodeId);
  if (!node) {
    return reply.code(404).send(apiErrorResponse("NODE_NOT_FOUND", "Node not found"));
  }
  return (await publicNodes([node]))[0];
});

app.get("/api/nodes/connect", { websocket: true, ...nodeJoinRateLimit }, async (socket) => {
  const ws = socket as any;
  let helloTimer: NodeJS.Timeout | undefined;
  let socketClosed = false;
  const reject = (message: string) => {
    if (helloTimer) clearTimeout(helloTimer);
    const response: PanelWelcome = { type: "welcome", nodeId: "", accepted: false, error: message };
    ws.send(JSON.stringify(response));
    ws.close();
  };

  helloTimer = setTimeout(() => reject("Node hello timed out"), 10_000);
  helloTimer.unref();
  ws.once("close", () => {
    socketClosed = true;
    if (helloTimer) clearTimeout(helloTimer);
  });

  ws.once("message", async (raw: Buffer) => {
    if (helloTimer) clearTimeout(helloTimer);
    if (raw.byteLength > 64 * 1024) {
      reject("Node hello is too large");
      return;
    }
    let hello: NodeHello;
    try {
      hello = normalizeNodeHello(JSON.parse(raw.toString()));
    } catch (error) {
      reject(`Invalid node hello: ${(error as Error).message}`);
      return;
    }
    const now = new Date().toISOString();
    let acceptedNode: ManagedNode | undefined;
    let issuedSecret: string | undefined;
    await updateNodes((nodes) => {
      if (hello.nodeId && hello.nodeSecret) {
        const node = nodes.find((candidate) => candidate.id === hello.nodeId);
        if (!node || !verifyNodeSecret(hello.nodeSecret, node.secretHash)) return;
        acceptedNode = {
          ...node,
          name: hello.nodeName,
          status: "online",
          updatedAt: now,
          lastSeenAt: now,
          connectedAt: now,
          agentVersion: hello.agentVersion,
          buildId: hello.buildId,
          protocolVersion: hello.protocolVersion,
          capabilities: hello.capabilities,
          features: hello.features,
          dockerStatus: hello.dockerStatus,
          dataPathStatus: hello.dataPathStatus,
          totalMemory: optionalNodeTotalMemory(hello.totalMemory) ?? node.totalMemory
        };
        nodes[nodes.indexOf(node)] = acceptedNode;
        return;
      }

      if (hello.joinToken) {
        const node = nodes.find((candidate) => verifyNodeSecret(hello.joinToken, candidate.joinTokenHash)
          && candidate.joinTokenExpiresAt
          && new Date(candidate.joinTokenExpiresAt).getTime() > Date.now());
        if (!node) return;
        issuedSecret = newNodeSecret();
        acceptedNode = {
          ...node,
          name: hello.nodeName,
          type: "remote",
          status: "online",
          isInternal: false,
          updatedAt: now,
          lastSeenAt: now,
          connectedAt: now,
          agentVersion: hello.agentVersion,
          buildId: hello.buildId,
          protocolVersion: hello.protocolVersion,
          capabilities: hello.capabilities,
          features: hello.features,
          dockerStatus: hello.dockerStatus,
          dataPathStatus: hello.dataPathStatus,
          totalMemory: optionalNodeTotalMemory(hello.totalMemory) ?? node.totalMemory,
          secretHash: hashNodeSecret(issuedSecret),
          joinTokenHash: undefined,
          joinTokenExpiresAt: undefined
        };
        nodes[nodes.indexOf(node)] = acceptedNode;
      }
    });

    if (!acceptedNode) {
      logWarn({
        nodeId: hello.nodeId ?? undefined,
        nodeName: hello.nodeName,
        credential: hello.nodeSecret ? "node_secret" : hello.joinToken ? "join_token" : "none",
        action: "node_join",
        status: "rejected"
      }, "Node authentication failed");
      reject("Node authentication failed");
      return;
    }

    const markAcceptedNodeOffline = async () => {
      if (panelNodeConnections.isConnected(acceptedNode!.id)) return;
      await updateNodes((nodes) => {
        const node = nodes.find((candidate) => candidate.id === acceptedNode!.id);
        if (node && node.connectedAt === acceptedNode!.connectedAt) {
          node.status = "offline";
          node.updatedAt = new Date().toISOString();
        }
      }).catch(() => undefined);
    };
    ws.on("close", () => { void markAcceptedNodeOffline(); });
    if (socketClosed || ws.readyState !== ws.OPEN) {
      await markAcceptedNodeOffline();
      return;
    }

    logInfo({
      nodeId: acceptedNode.id,
      nodeName: acceptedNode.name,
      agentVersion: acceptedNode.agentVersion,
      buildId: acceptedNode.buildId,
      protocolVersion: acceptedNode.protocolVersion,
      credential: issuedSecret ? "join_token" : "node_secret",
      action: "node_join",
      status: "accepted"
    }, issuedSecret ? "Node registered and connected" : "Node reconnected");

    const welcome: PanelWelcome = {
      type: "welcome",
      nodeId: acceptedNode.id,
      nodeSecret: issuedSecret,
      accepted: true,
      protocolVersion: hello.protocolVersion,
      features: hello.protocolVersion === nodeProtocolVersion ? hello.features.filter((feature) => nodeFeatures.includes(feature)) : [],
      timeZone: config.timeZone
    };
    ws.send(JSON.stringify(welcome));
    panelNodeConnections.connect(acceptedNode, ws);
    void services.remoteObservationCoordinator?.refreshNode(acceptedNode.id).catch((error) => {
      logDebug({ nodeId: acceptedNode!.id, ...errorLogFields(error), category: "node_observation" }, "Remote observation refresh deferred after reconnect");
    });
    if (hello.startupId) {
      const metadataKey = `node.startup.${acceptedNode.id}`;
      const previousStartupId = services.storageDatabase.metadata(metadataKey);
      services.storageDatabase.setMetadata(metadataKey, hello.startupId);
      if (previousStartupId !== hello.startupId) {
        services.serversRepository.markStartOnNodeStart(acceptedNode.id);
        void services.runtimeStateCoordinator?.poll();
      }
    }
    const expectedUpdate = activeNodeUpdates.get(acceptedNode.id);
    if (expectedUpdate
      && (!expectedUpdate.version || acceptedNode.agentVersion === expectedUpdate.version)
      && (!expectedUpdate.buildId || acceptedNode.buildId === expectedUpdate.buildId)) {
      activeNodeUpdates.delete(acceptedNode.id);
      clearNodeUpdateFailure(services.storageDatabase, acceptedNode.id);
    }
    if (hello.updateFailure) {
      // The node came back on its old release to tell the panel why the update did not take. Recording
      // it here is what lets the Nodes page name the cause instead of reporting a silent timeout.
      activeNodeUpdates.delete(acceptedNode.id);
      setNodeUpdateFailure(services.storageDatabase, acceptedNode.id, hello.updateFailure);
      logWarn({
        nodeId: acceptedNode.id,
        nodeName: acceptedNode.name,
        image: hello.updateFailure.image,
        stage: hello.updateFailure.stage,
        recovered: hello.updateFailure.recovered,
        action: "node_update",
        status: "failed"
      }, hello.updateFailure.message);
    }
  });
});

}
