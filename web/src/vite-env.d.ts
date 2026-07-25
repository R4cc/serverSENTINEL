/// <reference types="vite/client" />

interface ImportMetaEnv {
}

interface Navigator {
  /** Set by iOS on a home-screen launch. It predates, and still reports ahead of, the
      display-mode media query, so it is the reliable standalone signal on iPhone. */
  readonly standalone?: boolean;
}
