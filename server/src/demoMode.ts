import { ROLE_PRESETS, normalizePermissions } from "./permissions.js";
import type { StoredUser } from "./types.js";

export const DEMO_USERNAME = "demo";
export const DEMO_PASSWORD = "demo";
export const DEMO_USER_ID = "serversentinel-demo-user";

type DemoUsersRepository = {
  repairSystemUser(user: StoredUser): StoredUser;
};

export function isDemoUser(user: Pick<StoredUser, "username"> | null | undefined) {
  return user?.username.toLowerCase() === DEMO_USERNAME;
}

export function ensureDemoUser(
  users: DemoUsersRepository,
  hashPassword: (password: string) => { salt: string; passwordHash: string },
  now = new Date().toISOString()
) {
  return users.repairSystemUser({
    id: DEMO_USER_ID,
    username: DEMO_USERNAME,
    rolePreset: "admin",
    permissions: normalizePermissions(ROLE_PRESETS.admin),
    serverAccess: { mode: "all", serverIds: [] },
    createdAt: now,
    updatedAt: now,
    ...hashPassword(DEMO_PASSWORD)
  });
}
