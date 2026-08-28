import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import type { PermissionKey, PublicUser, RolePreset } from '../types';
import { AppIcon } from './FileTypeIcon';
import { Button, EmptyState, LoadingLabel, SkeletonBlock, StatusBadge } from './UiPrimitives';
import { DialogSurface } from './DialogSurface';
import { ActionMenu } from './ActionMenu';
import { TableSortButton } from './TableControls';
import {
  PERMISSION_DEPENDENCIES,
  PERMISSION_GROUPS,
  dependentPermissions,
  displayedRolePreset,
  expandPermissions,
  inferRolePreset,
  isPermissionKey,
  permissionsForPreset,
  rolePresetLabel,
  userPermissions
} from '../utils/permissions';
import { usernameInputPattern } from '../utils/inputPatterns';
import { nextTableSort, simpleTableAriaSort, type SimpleTableSort } from '../utils/table';

type UserSortColumn = "username" | "role";

export function UserManagement({
  users,
  currentUserId,
  editingUser,
  canManageUsers = true,
  onOpenEdit,
  onCloseModal,
  onCreate,
  onUpdate,
  onResetPassword,
  onDelete,
  busy = false,
  loading = false
}: {
  users: PublicUser[];
  currentUserId?: string;
  editingUser: "create" | PublicUser | null;
  busy?: boolean;
  loading?: boolean;
  canManageUsers?: boolean;
  onOpenEdit: (user: PublicUser) => void;
  onCloseModal: () => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onUpdate: (event: FormEvent<HTMLFormElement>, user: PublicUser) => void;
  onResetPassword: (event: FormEvent<HTMLFormElement>, user: PublicUser) => Promise<boolean>;
  onDelete: (user: PublicUser) => void;
}) {
  const modalUser = editingUser && editingUser !== "create" ? editingUser : null;
  const [passwordUser, setPasswordUser] = useState<PublicUser | null>(null);
  const [sort, setSort] = useState<SimpleTableSort<UserSortColumn>>({ id: "username", desc: false });
  const initialLoading = loading && users.length === 0;
  const sortedUsers = useMemo(() => [...users].sort((left, right) => {
    const leftValue = sort.id === "username" ? left.username : rolePresetLabel(displayedRolePreset(left));
    const rightValue = sort.id === "username" ? right.username : rolePresetLabel(displayedRolePreset(right));
    const comparison = leftValue.localeCompare(rightValue, undefined, { sensitivity: "base", numeric: true })
      || left.username.localeCompare(right.username, undefined, { sensitivity: "base", numeric: true })
      || left.id.localeCompare(right.id);
    return sort.desc ? -comparison : comparison;
  }), [sort, users]);

  return (
    <div className="usersSettings uiTableViewport">
      <table className="usersTable uiDataTable" aria-label="Users" aria-busy={initialLoading}>
        <thead className="uiTableHeader">
          <tr>
            <th scope="col" aria-sort={simpleTableAriaSort(sort, "username")}>
              <TableSortButton sorted={sort.id === "username" ? (sort.desc ? "desc" : "asc") : false} onClick={() => setSort((current) => nextTableSort(current, "username"))} label="User">User</TableSortButton>
            </th>
            <th scope="col" aria-sort={simpleTableAriaSort(sort, "role")}>
              <TableSortButton sorted={sort.id === "role" ? (sort.desc ? "desc" : "asc") : false} onClick={() => setSort((current) => nextTableSort(current, "role"))} label="Role">Role</TableSortButton>
            </th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {initialLoading && (
            <tr className="srOnly"><td colSpan={3}><LoadingLabel>Loading users</LoadingLabel></td></tr>
          )}
          {initialLoading && Array.from({ length: 3 }, (_, index) => (
            <tr className="userSkeletonRow" key={`user-skeleton-${index}`} aria-hidden="true">
              <td><SkeletonBlock className="userNameSkeleton" /></td>
              <td><SkeletonBlock className="uiSkeleton--badge" /></td>
              <td><div className="userActions"><SkeletonBlock className="userActionSkeleton" /><SkeletonBlock className="userActionSkeleton short" /><SkeletonBlock className="userActionSkeleton short" /></div></td>
            </tr>
          ))}
          {sortedUsers.map((user) => (
            <tr className="uiTableRow" key={user.id}>
              <td data-label="User">
                <div className="userNameCell">
                  {/* The cell truncates a long username, so the full value stays reachable. */}
                  <strong title={user.username}>{user.username}</strong>
                  {user.id === currentUserId && <span className="currentUserMark">Current user</span>}
                </div>
              </td>
              <td data-label="Role">
                <div className="roleCell">
                  <StatusBadge className={`roleBadge ${displayedRolePreset(user)}`}>{rolePresetLabel(displayedRolePreset(user))}</StatusBadge>
                  <span className="roleInfoWrap">
                    <Button
                      variant="ghost"
                      iconOnly
                      className="roleInfoButton"
                      aria-label={`${rolePresetLabel(displayedRolePreset(user))} preset details`}
                      aria-describedby={`role-tip-${user.id}`}
                    >
                      i
                    </Button>
                    <span id={`role-tip-${user.id}`} role="tooltip" className="roleTooltip">
                      Roles are presets. Actual access is controlled by permissions.
                    </span>
                  </span>
                </div>
              </td>
              <td data-label="Actions">
                <div className="userActions">
                  <ActionMenu
                    label={`Actions for ${user.username}`}
                    className="userActionMenu"
                    triggerClassName="userActionMenuTrigger"
                    disabled={busy}
                    items={[
                      { id: "reset-password", label: "Reset password", icon: <AppIcon name="refresh" />, onSelect: () => setPasswordUser(user), disabled: !canManageUsers, title: !canManageUsers ? "Manage users permission is required" : "Reset password" },
                      { id: "edit", label: "Edit", icon: <AppIcon name="edit" />, onSelect: () => onOpenEdit(user), disabled: !canManageUsers, title: !canManageUsers ? "Manage users permission is required" : "Edit user" },
                      {
                        id: "delete",
                        label: "Delete",
                        icon: <AppIcon name="trash" />,
                        onSelect: () => onDelete(user),
                        disabled: user.id === currentUserId || !canManageUsers,
                        title: user.id === currentUserId ? "You cannot delete your current user" : !canManageUsers ? "Manage users permission is required" : `Delete ${user.username}`,
                        critical: true,
                        separatorBefore: true
                      }
                    ]}
                    trigger={<AppIcon name="moreHorizontal" />}
                  />
                </div>
              </td>
            </tr>
          ))}
          {!initialLoading && users.length === 0 && (
            <tr>
              <td colSpan={3}>
                <EmptyState compact className="emptyInline noBorder" title="No users yet" message="Create a user to give someone access to this serverSENTINEL panel." />
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editingUser && (
        <UserPermissionModal
          user={modalUser}
          busy={busy}
          onClose={onCloseModal}
          onSubmit={(event) => modalUser ? onUpdate(event, modalUser) : onCreate(event)}
        />
      )}

      {passwordUser && (
        <ResetPasswordModal
          user={passwordUser}
          busy={busy}
          onClose={() => setPasswordUser(null)}
          onSubmit={async (event) => {
            const saved = await onResetPassword(event, passwordUser);
            if (saved) setPasswordUser(null);
          }}
        />
      )}
    </div>
  );
}

function UserPermissionModal({
  user,
  busy,
  onClose,
  onSubmit
}: {
  user: PublicUser | null;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const initialPermissions = useMemo(() => userPermissions(user), [user]);
  const [permissions, setPermissions] = useState<PermissionKey[]>(initialPermissions);
  const [selectedPreset, setSelectedPreset] = useState<RolePreset>(inferRolePreset(initialPermissions));
  const displayedPermissions = useMemo(() => new Set(permissions), [permissions]);
  const unknownPermissions = useMemo(() => {
    const raw = (user?.permissions ?? []) as string[];
    return raw.filter((permission) => !isPermissionKey(permission));
  }, [user]);
  const inferredPreset = inferRolePreset(permissions);
  const adminPermissionsLocked = Boolean(user && inferRolePreset(initialPermissions) === "admin");
  const canSave = permissions.length > 0;

  useEffect(() => {
    const nextPermissions = userPermissions(user);
    setPermissions(nextPermissions);
    setSelectedPreset(inferRolePreset(nextPermissions));
  }, [user]);

  function changePreset(event: ChangeEvent<HTMLSelectElement>) {
    const preset = event.target.value as RolePreset;
    setSelectedPreset(preset);
    if (preset !== "custom") {
      setPermissions(permissionsForPreset(preset));
    }
  }

  function togglePermission(permission: PermissionKey, checked: boolean) {
    const next = new Set(permissions);
    if (checked) {
      next.add(permission);
      expandPermissions([permission]).forEach((dependency) => next.add(dependency));
    } else {
      next.delete(permission);
      const removeDependents = (base: PermissionKey) => {
        for (const dependent of dependentPermissions(base)) {
          next.delete(dependent);
          removeDependents(dependent);
        }
      };
      removeDependents(permission);
    }
    const normalized = expandPermissions([...next]);
    setPermissions(normalized);
    setSelectedPreset(inferRolePreset(normalized));
  }

  // Escape closes this form, but a stray backdrop click must not discard in-progress edits.
  return (
    <DialogSurface backdrop dismissible={!busy} backdropDismiss={false} className="modalPanel userModalPanel" labelledBy="user-modal-title" onClose={onClose}>
      <form onSubmit={onSubmit} className="userModalForm">
        <div className="userModalHeader">
          <h2 id="user-modal-title">{user ? "Edit user" : "New user"}</h2>
          <Button
            variant="secondary"
            iconOnly
            className="iconButton modalCloseButton"
            onClick={onClose}
            disabled={busy}
            aria-label="Close user dialog"
            title={busy ? "User changes are still saving" : "Close user dialog"}
          >
            <AppIcon name="x" />
          </Button>
        </div>

        <fieldset disabled={busy} className="userModalBody">
          <input type="hidden" name="rolePreset" value={inferredPreset} />
          <input type="hidden" name="permissions" value={JSON.stringify(permissions)} />

          <div className="userModalFields">
            <label>
              Username
              <input
                name="username"
                autoComplete="off"
                required
                minLength={3}
                maxLength={32}
                pattern={usernameInputPattern}
                defaultValue={user?.username ?? ""}
                aria-describedby="user-modal-username-hint"
                title="Letters, numbers, dots, dashes, and underscores."
              />
              <small id="user-modal-username-hint" className="fieldHint">3 to 32 characters: letters, numbers, dots, dashes, and underscores.</small>
            </label>
            {!user && (
              <label>
                Password
                <input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} placeholder="At least 8 characters" />
              </label>
            )}
            <label>
              Role preset
              <select name="presetPicker" value={selectedPreset} onChange={changePreset} disabled={adminPermissionsLocked}>
                <option value="viewer">Viewer</option>
                <option value="operator">Operator</option>
                <option value="maintainer">Maintainer</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <div className="presetSummary" aria-live="polite">
              Current preset: <strong>{rolePresetLabel(inferredPreset)}</strong>
            </div>
          </div>

          {unknownPermissions.length > 0 && (
            <div className="permissionWarning" role="status">
              This user has unknown permissions from the backend: {unknownPermissions.join(", ")}.
            </div>
          )}

          <div className="permissionsSection">
            <div className="permissionsHeader">
              <h3>Permissions</h3>
              {adminPermissionsLocked && <span>Admin permissions are locked.</span>}
              {!canSave && <span id="user-modal-permission-hint">Choose at least one permission.</span>}
            </div>
            <div className="permissionGrid">
              {PERMISSION_GROUPS.map((group) => (
                <section className="permissionGroup" key={group.title}>
                  <h4>{group.title}</h4>
                  <div className="permissionRows">
                    {group.permissions.map(({ key, label }) => {
                      const dependency = PERMISSION_DEPENDENCIES[key][0];
                      const dependents = dependentPermissions(key);
                      const title = dependency
                        ? `Requires ${permissionShortLabel(dependency)}`
                        : dependents.length > 0
                          ? "Disabling this also disables dependent actions"
                          : undefined;
                      return (
                        <label className={`permissionRow ${dependency ? "dependent" : ""}`} key={key} title={title}>
                          <input
                            type="checkbox"
                            checked={displayedPermissions.has(key)}
                            disabled={adminPermissionsLocked}
                            onChange={(event) => togglePermission(key, event.target.checked)}
                          />
                          <span>
                            {label}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </fieldset>

        <div className="userModalFooter">
          <Button variant="secondary" onClick={onClose} disabled={busy} title={busy ? "User changes are still saving" : "Cancel"}>Cancel</Button>
          <Button type="submit" disabled={busy || !canSave} aria-describedby={!canSave ? "user-modal-permission-hint" : undefined} title={!canSave ? "Choose at least one permission." : busy ? "User changes are still saving" : user ? "Save user changes" : "Create user"} reserveLabel={user ? "Save changes" : "Create user"}>
            {busy ? "Saving..." : user ? "Save changes" : "Create user"}
          </Button>
        </div>
      </form>
    </DialogSurface>
  );
}

function ResetPasswordModal({
  user,
  busy,
  onClose,
  onSubmit
}: {
  user: PublicUser;
  busy?: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  // Escape closes this form, but a stray backdrop click must not discard in-progress edits.
  return (
    <DialogSurface backdrop dismissible={!busy} backdropDismiss={false} className="modalPanel userModalPanel" labelledBy="reset-password-title" onClose={onClose}>
      <form onSubmit={onSubmit} className="userModalForm">
        <div className="userModalHeader">
          <h2 id="reset-password-title">Reset password</h2>
          <Button
            variant="secondary"
            iconOnly
            className="iconButton modalCloseButton"
            onClick={onClose}
            disabled={busy}
            aria-label="Close reset password dialog"
            title={busy ? "Password reset is still saving" : "Close reset password dialog"}
          >
            <AppIcon name="x" />
          </Button>
        </div>
        <fieldset disabled={busy} className="userModalBody">
          <div className="userModalFields">
            <label>
              User
              <input value={user.username} readOnly />
            </label>
            <label>
              New password
              <input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={256} placeholder="At least 8 characters" />
            </label>
            <label>
              Confirm password
              <input name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={256} placeholder="Repeat password" />
            </label>
          </div>
        </fieldset>
        <div className="userModalFooter">
          <Button variant="secondary" onClick={onClose} disabled={busy} title={busy ? "Password reset is still saving" : "Cancel"}>Cancel</Button>
          <Button type="submit" disabled={busy} title={busy ? "Password reset is still saving" : "Reset password"} reserveLabel="Reset password">{busy ? "Saving..." : "Reset password"}</Button>
        </div>
      </form>
    </DialogSurface>
  );
}

function permissionShortLabel(permission: PermissionKey) {
  for (const group of PERMISSION_GROUPS) {
    const found = group.permissions.find((item) => item.key === permission);
    if (found) return found.label;
  }
  return permission;
}
