import { useLayoutEffect, useState } from "react";
import { createRequestScope } from "./requestScope";

export function useRequestScope(key?: string) {
  const [scope] = useState(createRequestScope);
  // Invalidate before passive effects start requests for the next owner, and on unmount.
  useLayoutEffect(() => {
    scope.invalidate();
    return () => scope.invalidate();
  }, [scope, key]);
  return scope;
}
