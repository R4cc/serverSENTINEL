import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api";
import type { ActivePage, AuthSession, PublicUser } from "../../types";
import { errorMessage, setValidationNotice } from "../../utils/appHelpers";
import type { RequestConfirmation } from "../../components/ConfirmationModal";
import { createUserFormValues, resetPasswordFormValues, updateUserFormValues } from "./userForm";

type Notify = (type: "success" | "error" | "info" | "warning", text: string) => void;

type UsersWorkspaceInputs = {
  activePage: ActivePage;
  authSession: AuthSession | null;
  demoMode: boolean;
  canViewUsers: boolean;
  canManageUsers: boolean;
  settingsDataLoading: boolean;
  notify: Notify;
  requestConfirmation: RequestConfirmation;
  handleStaleSession(error: unknown): boolean;
  refreshAuth(): Promise<void>;
  logout(): Promise<void>;
};

export function useUsersWorkspace({
  activePage,
  authSession,
  demoMode,
  canViewUsers,
  canManageUsers,
  settingsDataLoading,
  notify,
  requestConfirmation,
  handleStaleSession,
  refreshAuth,
  logout
}: UsersWorkspaceInputs) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [editingUser, setEditingUser] = useState<"create" | PublicUser | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function loadUsers() {
    if (!canViewUsers) return;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ users: PublicUser[] }>("/api/users");
      setUsers(result.users);
    } catch (loadError) {
      if (handleStaleSession(loadError)) return;
      const message = errorMessage(loadError, "Could not load users. Check your permissions and try again.");
      setError(message);
      notify("error", message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (activePage !== "settings" || !authSession?.authenticated || !canViewUsers || demoMode) return;
    void loadUsers();
  }, [activePage, authSession?.authenticated, canViewUsers, demoMode]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageUsers || busy) return;
    const formElement = event.currentTarget;
    const values = createUserFormValues(new FormData(formElement));
    if (setValidationNotice(formElement, values.errors, (message) => notify("error", message))) return;
    setBusy(true);
    try {
      await api<PublicUser>("/api/users", {
        method: "POST",
        body: JSON.stringify({
          username: values.username,
          password: values.password,
          rolePreset: values.rolePreset,
          permissions: values.permissions
        })
      });
      formElement.reset();
      setEditingUser(null);
      notify("success", "User account created");
      await loadUsers();
    } catch (createError) {
      if (handleStaleSession(createError)) return;
      notify("error", (createError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function updateUser(event: FormEvent<HTMLFormElement>, user: PublicUser) {
    event.preventDefault();
    if (!canManageUsers || busy) return;
    const formElement = event.currentTarget;
    const values = updateUserFormValues(new FormData(formElement));
    if (setValidationNotice(formElement, values.errors, (message) => notify("error", message))) return;
    if (authSession?.user?.id === user.id && !values.permissions.includes("users.manage")) {
      const confirmed = await requestConfirmation({
        title: "Remove your own Manage users permission?",
        description: "Saving these changes may prevent you from managing user accounts again.",
        warning: "The backend may reject this change if it would remove the last full-access administrator.",
        confirmLabel: "Save anyway",
        variant: "critical"
      });
      if (!confirmed) return;
    }
    setBusy(true);
    try {
      await api<PublicUser>(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({
          username: values.username,
          rolePreset: values.rolePreset,
          permissions: values.permissions
        })
      });
      setEditingUser(null);
      notify("success", "User account updated");
      await loadUsers();
      if (authSession?.user?.id === user.id) {
        await refreshAuth();
      }
    } catch (updateError) {
      if (handleStaleSession(updateError)) return;
      notify("error", (updateError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetUserPassword(event: FormEvent<HTMLFormElement>, user: PublicUser) {
    event.preventDefault();
    if (!canManageUsers || busy) return false;
    const formElement = event.currentTarget;
    const values = resetPasswordFormValues(new FormData(formElement));
    if (setValidationNotice(formElement, values.errors, (message) => notify("error", message))) return false;
    setBusy(true);
    try {
      await api<PublicUser>(`/api/users/${user.id}`, {
        method: "PUT",
        body: JSON.stringify({ password: values.password })
      });
      formElement.reset();
      notify("success", `Password reset for ${user.username}`);
      return true;
    } catch (resetError) {
      if (handleStaleSession(resetError)) return false;
      notify("error", (resetError as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(user: PublicUser) {
    if (!canManageUsers || busy) return;
    const confirmed = await requestConfirmation({
      title: `Delete ${user.username}?`,
      description: "This immediately removes the user account and invalidates all of its active sessions.",
      warning: "This action cannot be undone.",
      confirmLabel: "Delete user",
      variant: "critical"
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await api(`/api/users/${user.id}`, { method: "DELETE" });
      notify("success", `Deleted ${user.username}`);
      await loadUsers();
      if (authSession?.user?.id === user.id) {
        await logout();
      }
    } catch (deleteError) {
      if (handleStaleSession(deleteError)) return;
      notify("error", (deleteError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return {
    users,
    currentUserId: authSession?.user?.id,
    editingUser,
    busy,
    loading: canViewUsers && users.length === 0 && !error && (settingsDataLoading || loading),
    error,
    canManage: canManageUsers,
    onOpenCreate: () => setEditingUser("create"),
    onOpenEdit: setEditingUser,
    onCloseModal: () => setEditingUser(null),
    onCreate: createUser,
    onUpdate: updateUser,
    onResetPassword: resetUserPassword,
    onDelete: deleteUser,
    onRetry: () => void loadUsers()
  };
}
