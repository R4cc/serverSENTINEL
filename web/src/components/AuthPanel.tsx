import { FormEvent } from 'react';
import type { PublicUser, UserRole } from '../types';
import { AppIcon } from './FileTypeIcon';

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
  onOpenEdit,
  onCloseModal,
  onCreate,
  onUpdate,
  onDelete,
  busy = false
}: {
  users: PublicUser[];
  currentUserId?: string;
  editingUser: "create" | PublicUser | null;
  busy?: boolean;
  onOpenEdit: (user: PublicUser) => void;
  onCloseModal: () => void;
  onCreate: (event: FormEvent<HTMLFormElement>) => void;
  onUpdate: (event: FormEvent<HTMLFormElement>, user: PublicUser) => void;
  onDelete: (user: PublicUser) => void;
}) {
  const roleMeta: Record<UserRole, { label: string; description: string }> = {
    basic: { label: "Basic", description: "Can start, stop, and restart assigned servers." },
    expanded: { label: "Expanded", description: "Basic access plus console commands and scheduled commands." },
    manager: { label: "Manager", description: "Can manage server settings, files, mods, and server lifecycle." },
    admin: { label: "Admin", description: "Full access, including user management." }
  };
  const modalUser = editingUser && editingUser !== "create" ? editingUser : null;

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
                  <span className={`roleBadge ${user.role}`}>{roleMeta[user.role].label}</span>
                  <span className="roleInfoWrap">
                    <button
                      type="button"
                      className="roleInfoButton"
                      aria-label={`${roleMeta[user.role].label} role details`}
                      aria-describedby={`role-tip-${user.id}`}
                    >
                      i
                    </button>
                    <span id={`role-tip-${user.id}`} role="tooltip" className="roleTooltip">
                      {roleMeta[user.role].description}
                    </span>
                  </span>
                </div>
              </td>
              <td data-label="Actions">
                <div className="userActions">
                  <button type="button" className="secondaryButton" onClick={() => onOpenEdit(user)} disabled={busy}>Edit</button>
                  <button
                    type="button"
                    className="dangerTextButton"
                    onClick={() => onDelete(user)}
                    disabled={busy || user.id === currentUserId}
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editingUser && (
        <div className="modalBackdrop" role="presentation">
          <section className="modalPanel" role="dialog" aria-modal="true" aria-labelledby="user-modal-title">
            <div className="panelHeader">
              <h2 id="user-modal-title">{modalUser ? "Edit User" : "New User"}</h2>
              <button type="button" className="iconButton" onClick={onCloseModal} aria-label="Close user dialog">
                <AppIcon name="x" />
              </button>
            </div>
            <form onSubmit={(event) => modalUser ? onUpdate(event, modalUser) : onCreate(event)} className="appForm">
              <fieldset disabled={busy}>
                <label>
                  Username
                  <input name="username" autoComplete="off" required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_.-]+" defaultValue={modalUser?.username ?? ""} />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required={!modalUser}
                    minLength={8}
                    placeholder={modalUser ? "Leave blank to keep current password" : "At least 8 characters"}
                  />
                </label>
                <label>
                  Role
                  <select name="role" defaultValue={modalUser?.role ?? "basic"}>
                    <option value="basic">Basic operations</option>
                    <option value="expanded">Expanded</option>
                    <option value="manager">Manager</option>
                    <option value="admin">Admin</option>
                  </select>
                </label>
                <div className="buttonRow">
                  <button type="button" className="secondaryButton" onClick={onCloseModal}>Cancel</button>
                  <button>{busy ? "Saving..." : modalUser ? "Save user" : "Create user"}</button>
                </div>
              </fieldset>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
