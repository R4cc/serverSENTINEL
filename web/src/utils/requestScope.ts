/** Owns results for one UI lifetime, with optional latest-request lanes. */
export function createRequestScope() {
  let generation = 0;
  const requests = new Map<string, symbol>();
  return {
    invalidate() {
      generation += 1;
      requests.clear();
    },
    capture() {
      const current = generation;
      return () => current === generation;
    },
    begin(key: string) {
      const current = generation;
      const request = Symbol(key);
      requests.set(key, request);
      return () => current === generation && requests.get(key) === request;
    }
  };
}
