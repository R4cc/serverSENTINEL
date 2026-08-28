# Web routing

The root `AGENTS.md` still applies. Use this table to avoid routing feature state through the app shell.

| Area | Start here |
| --- | --- |
| App-wide authentication, navigation, active server, console pipeline | `src/App.tsx` |
| Shell config, persisted navigation, guards, formatting state | `src/app/` |
| Optional feature modules and their lazy entries | `src/app/moduleRegistry.ts`; see `docs/modules.md` before adding one |
| Feature state and data loading | `src/features/<area>/` and its `use*Workspace.ts` or area hook; prefer this over adding state to `App.tsx` |
| Page presentation | `src/pages/`; pages primarily receive state and actions as props |
| Reusable UI and charts | `src/components/` |
| Pure helpers | `src/utils/`, with colocated unit tests |
| API and shared types | `src/api.ts`, `src/types.ts`; most frontend types are re-exported from `shared/src/index.ts` |
| Demo behavior | `src/demo.ts`, `src/demoRuntime.ts`, and the relevant feature fixture/helper |

# Stylesheet routing

CSS is global. `src/styles.css` import order is load-bearing and asserted by `src/styles.test.ts`; change a class in its owner instead of overriding it downstream.

| Stylesheet | Owns |
| --- | --- |
| `tokens.css`, `themes.css`, `fonts.css` | Custom properties, theme surfaces, font faces |
| `typography.css` | Shared type scale |
| `primitives.css` | `ui*` primitives and loading skeletons |
| `canonical-layout.css` | Cross-page shell geometry |
| `layout.css` | Shell chrome, runtime state, toasts, users table |
| `overview.css` | Overview and server timeline |
| `mods.css` | Mods workspace and drawers |
| `file-manager.css`, `files-console.css` | File tables; terminal, editor, and install rows |
| `schedules.css` | Schedule tables, runs, and steps |
| `settings.css`, `settings-nodes.css` | Settings hub; node wizard/drawer and `summaryTile` |
| `nodes.css` | Nodes list; loads after `responsive.css` and owns its layout end to end |
| `server-properties.css` | Properties form and danger panel |
| `auth.css`, `confirmation-modal.css`, `export-import.css` | Auth and modal workflows |
| `responsive.css` | Shared shell and cross-feature primitive breakpoints only |
| `motion.css` | Transitions and animation |

- Put feature breakpoints beside their base rules. `styles.test.ts` rejects feature-owned selectors in `responsive.css`.
- Feature styles use theme tokens, not raw hex or `rgb()`, and must not redefine `ui*` primitives.
- Keep `styles.test.ts` structural: test ownership, cascade, and retired classes, not declaration values. Use the browser smoke scripts for rendered behavior.

# Versioning

- The root `AGENTS.md` calendar-versioning policy applies to web changes. Use `YY.M.N`, increment the release number within the current month, and reset it to `1` when the year or month changes; do not classify changes as SemVer major, minor, or patch bumps.
