import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import type { PermissionKey, PublicUser, RolePreset } from '../types';
import { AppIcon } from './FileTypeIcon';
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

export function AuthPanel({
  setupRequired,
  notice,
  onSubmit,
  busy = false
}: {
  setupRequired: boolean;
  notice: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  busy?: boolean;
}) {
  return (
    <main className="authShell">
      <section className="authPanel">
        <div className="brandLockup">
          <img className="brandLogo" src="/logo.png" alt="" />
          <div>
            <h1>ServerSentinel</h1>
            <p>{setupRequired ? "Create the first admin account" : "Sign in to manage servers"}</p>
          </div>
        </div>
        {notice && <div className="notice">{notice}</div>}
        {setupRequired && (
          <div className="systemBanner accent compactBanner">
            <strong>First-run setup.</strong>
            <span>Create this admin account first. After sign-in, ServerSentinel will show Docker, node, server, and Modrinth setup actions as needed.</span>
          </div>
        )}
        <form onSubmit={onSubmit} className="appForm">
          <fieldset disabled={busy}>
            <label>
              Username
              <input name="username" autoComplete="username" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_.-]+" placeholder={setupRequired ? "admin" : "Username"} />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete={setupRequired ? "new-password" : "current-password"} required minLength={setupRequired ? 8 : 1} placeholder={setupRequired ? "At least 8 characters" : "Password"} />
            </label>
            {setupRequired && (
              <label>
                Confirm password
                <input name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} placeholder="Repeat password" />
              </label>
            )}
            <button>{busy ? "Checking..." : setupRequired ? "Create admin" : "Sign in"}</button>
          </fieldset>
        </form>
        <p className="muted">Use demo / demo to enter simulated mode without creating a real session.</p>
      </section>
    </main>
  );
}

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
  busy = false
}: {
  users: PublicUser[];
  currentUserId?: string;
  editingUser: "create" | PublicUser | null;
  busy?: boolean;
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

  return (
    <div className="usersSettings">
      <table className="usersTable">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Role</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td data-label="User">
                <div className="userNameCell">
                  <strong>{user.username}</strong>
                  {user.id === currentUserId && <span className="currentUserMark">Current user</span>}
                </div>
              </td>
              <td data-label="Role">
                <div className="roleCell">
                  <span className={`roleBadge ${displayedRolePreset(user)}`}>{rolePresetLabel(displayedRolePreset(user))}</span>
                  <span className="roleInfoWrap">
                    <button
                      type="button"
                      className="roleInfoButton"
                      aria-label={`${rolePresetLabel(displayedRolePreset(user))} preset details`}
                      aria-describedby={`role-tip-${user.id}`}
                    >
                      i
                    </button>
                    <span id={`role-tip-${user.id}`} role="tooltip" className="roleTooltip">
                      Roles are presets. Actual access is controlled by permissions.
                    </span>
                  </span>
                </div>
              </td>
              <td data-label="Actions">
                <div className="userActions">
                  <button type="button" className="secondaryButton" onClick={() => setPasswordUser(user)} disabled={busy || !canManageUsers} title={!canManageUsers ? "Manage users permission is required" : "Reset password"}>Reset Password</button>
                  <button type="button" className="secondaryButton" onClick={() => onOpenEdit(user)} disabled={busy || !canManageUsers} title={!canManageUsers ? "Manage users permission is required" : "Edit user"}>Edit</button>
                  <button
                    type="button"
                    className="dangerTextButton"
                    onClick={() => onDelete(user)}
                    disabled={busy || user.id === currentUserId || !canManageUsers}
                    title={user.id === currentUserId ? "You cannot delete your current user" : !canManageUsers ? "Manage users permission is required" : "Delete user"}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {users.length === 0 && (
            <tr>
              <td colSpan={3}>
                <div className="emptyInline noBorder">
                  <strong>No users yet</strong>
                  <span>Create a user to give someone access to this ServerSentinel panel.</span>
                </div>
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

  return (
    <div className="modalBackdrop" role="presentation">
      <section className="modalPanel userModalPanel" role="dialog" aria-modal="true" aria-labelledby="user-modal-title">
        <form onSubmit={onSubmit} className="userModalForm">
          <div className="userModalHeader">
            <h2 id="user-modal-title">{user ? "Edit User" : "New User"}</h2>
            <button
              type="button"
              className="iconButton modalCloseButton"
              onClick={onClose}
              disabled={busy}
              aria-label="Close user dialog"
              title={busy ? "User changes are still saving" : "Close user dialog"}
            >
              <AppIcon name="x" />
            </button>
          </div>

          <fieldset disabled={busy} className="userModalBody">
            <input type="hidden" name="rolePreset" value={inferredPreset} />
            <input type="hidden" name="permissions" value={JSON.stringify(permissions)} />

            <div className="userModalFields">
              <label>
                Username
                <input name="username" autoComplete="off" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_.-]+" defaultValue={user?.username ?? ""} />
              </label>
              {!user && (
                <label>
                  Password
                  <input name="password" type="password" autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" />
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
              <div className="permissionWarning">
                This user has unknown permissions from the backend: {unknownPermissions.join(", ")}.
              </div>
            )}

            <div className="permissionsSection">
              <div className="permissionsHeader">
                <h3>Permissions</h3>
                {adminPermissionsLocked && <span>Admin permissions are locked.</span>}
                {!canSave && <span>Choose at least one permission.</span>}
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
            <button type="button" className="secondaryButton" onClick={onClose} disabled={busy} title={busy ? "User changes are still saving" : "Cancel"}>Cancel</button>
            <button disabled={busy || !canSave} title={!canSave ? "Choose at least one permission." : busy ? "User changes are still saving" : user ? "Save user changes" : "Create user"}>
              {busy ? "Saving..." : user ? "Save changes" : "Create user"}
            </button>
          </div>
        </form>
      </section>
    </div>
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
  return (
    <div className="modalBackdrop" role="presentation">
      <section className="modalPanel userModalPanel" role="dialog" aria-modal="true" aria-labelledby="reset-password-title">
        <form onSubmit={onSubmit} className="userModalForm">
          <div className="userModalHeader">
            <h2 id="reset-password-title">Reset Password</h2>
            <button
              type="button"
              className="iconButton modalCloseButton"
              onClick={onClose}
              disabled={busy}
              aria-label="Close reset password dialog"
              title={busy ? "Password reset is still saving" : "Close reset password dialog"}
            >
              <AppIcon name="x" />
            </button>
          </div>
          <fieldset disabled={busy} className="userModalBody">
            <div className="userModalFields">
              <label>
                User
                <input value={user.username} readOnly />
              </label>
              <label>
                New password
                <input name="password" type="password" autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" />
              </label>
              <label>
                Confirm password
                <input name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} placeholder="Repeat password" />
              </label>
            </div>
          </fieldset>
          <div className="userModalFooter">
            <button type="button" className="secondaryButton" onClick={onClose} disabled={busy} title={busy ? "Password reset is still saving" : "Cancel"}>Cancel</button>
            <button disabled={busy} title={busy ? "Password reset is still saving" : "Reset password"}>{busy ? "Saving..." : "Reset password"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function permissionShortLabel(permission: PermissionKey) {
  for (const group of PERMISSION_GROUPS) {
    const found = group.permissions.find((item) => item.key === permission);
    if (found) return found.label;
  }
  return permission;
}
