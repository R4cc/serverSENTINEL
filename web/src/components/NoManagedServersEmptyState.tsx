import { Button, EmptyState } from "./UiPrimitives";

/**
 * Shown wherever the panel has no managed servers to work with. When the panel
 * has no usable node either, adding a node is offered first — a server cannot be
 * created without a host to create it on.
 */
export function NoManagedServersEmptyState({
  title,
  message,
  needsNodeFirst,
  onAddNode,
  addNodeDisabled,
  addNodeDisabledReason,
  onCreateServer,
  createServerDisabled,
  createServerDisabledReason
}: {
  title: string;
  message: string;
  needsNodeFirst: boolean;
  onAddNode: () => void;
  addNodeDisabled: boolean;
  addNodeDisabledReason: string;
  onCreateServer: () => void;
  createServerDisabled: boolean;
  createServerDisabledReason: string;
}) {
  return (
    <EmptyState
      title={title}
      message={message}
      action={needsNodeFirst ? (
        <Button
          onClick={onAddNode}
          disabled={addNodeDisabled}
          title={addNodeDisabledReason}
        >
          Add node
        </Button>
      ) : (
        <Button onClick={onCreateServer} disabled={createServerDisabled} title={createServerDisabled ? createServerDisabledReason : "Create a managed server"}>Create managed server</Button>
      )}
    />
  );
}
