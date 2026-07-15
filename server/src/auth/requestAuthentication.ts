import type { StoredUser } from "../types.js";

export type AuthenticatedRequest = {
  headers: { cookie?: string };
  authenticatedUser?: StoredUser | null;
  authenticationPromise?: Promise<StoredUser | null>;
};

export function currentUserForRequest(
  request: AuthenticatedRequest,
  resolveUser: (cookieHeader?: string) => Promise<StoredUser | null>
) {
  if (!request.authenticationPromise) {
    request.authenticationPromise = resolveUser(request.headers.cookie).then((user) => {
      request.authenticatedUser = user;
      return user;
    });
  }
  return request.authenticationPromise;
}
