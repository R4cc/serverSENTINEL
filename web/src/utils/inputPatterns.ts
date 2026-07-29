/**
 * Regex sources for the `pattern` attribute on form inputs.
 *
 * Browsers compile `pattern` with the RegExp `v` flag, which reserves a set of punctuators inside
 * character classes for future syntax -- `-` and `/` among them. An unescaped one is a syntax
 * error, and a pattern the browser cannot compile is not treated as a lenient pattern: it is
 * discarded, so the field silently accepts anything until the server rejects it. Escape those
 * characters inside every class here, and keep `inputPatterns.test.ts` compiling each source under
 * that flag.
 *
 * Each source mirrors its server-side validator, so a value the field accepts is a value the API
 * accepts. Length bounds stay on the element as `minLength`/`maxLength` so the browser reports
 * them as their own message.
 */

/** Mirrors `validateUsername` in the server's users repository (length enforced on the element). */
export const usernameInputPattern = "[a-zA-Z0-9_.\\-]+";

/** Mirrors `validateDockerContainerName` in the server's HTTP validation helpers. */
export const dockerContainerNameInputPattern = "^[a-zA-Z0-9][a-zA-Z0-9_.\\-]{0,127}$";

/**
 * Mirrors `validateRuntimeJarFilename`: a local `.jar` filename, so no path separator and no `..`
 * segment. The lookahead is what carries the `..` rule the server enforces separately.
 */
export const runtimeJarFilenameInputPattern = "^(?!.*\\.\\.)[^\\\\\\/]*\\.jar$";
