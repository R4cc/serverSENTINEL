import { lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * `React.lazy` suspends the first time it renders a component even when the chunk is already in
 * the module registry: it calls the factory during that render, and a native promise cannot settle
 * before the render finishes. Committing a fallback is not free — React then holds it for its
 * throttle window so it cannot flash — so the first visit to a page costs that window on top of
 * whatever the download cost, and prefetching the chunk alone does nothing about it.
 *
 * Holding the resolved component here moves the waiting into `preload`. Once that has run, the
 * factory hands React a thenable that resolves during the call, `lazy` resolves in the same render
 * pass, and the page commits with no fallback at all. Without a preload the factory still returns
 * an ordinary promise, so an unprefetched page falls back exactly as it does today.
 */
export function lazyPage<Module, Props>(load: () => Promise<Module>, pick: (module: Module) => ComponentType<Props>) {
  let resolved: ComponentType<Props> | null = null;
  let pending: Promise<void> | null = null;

  const preload = () => {
    if (resolved) return Promise.resolve();
    pending ??= load().then(
      (module) => {
        resolved = pick(module);
      },
      (error: unknown) => {
        // A chunk can fail for reasons that pass: a dropped connection, or a deploy that replaced
        // the file mid-session. Forgetting the rejection lets the next visit ask for it again
        // instead of failing forever on a cached failure.
        pending = null;
        throw error;
      }
    );
    return pending;
  };

  const Component = lazy(() => {
    if (resolved) {
      const settled = { default: resolved };
      // A thenable that calls back during `then` rather than on a microtask. React checks the
      // payload's status straight after subscribing, so this resolves the component in place.
      return { then: (onFulfilled: (value: typeof settled) => void) => onFulfilled(settled) } as unknown as Promise<typeof settled>;
    }
    return preload().then(() => ({ default: resolved as ComponentType<Props> }));
  }) as LazyExoticComponent<ComponentType<Props>>;

  return { Component, preload };
}
