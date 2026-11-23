import { ChevronDown, ChevronRight, Link2, TriangleAlert } from "lucide-react";
import type { InstalledMod } from "../../types";
import { ActionMenu } from "../../components/ActionMenu";
import { modIconSource } from "../../utils/appHelpers";
import { ModIconImage } from "./ModIconImage";
import { enabledDependents, formatModNames, type ModDependencyLinks } from "./modDependencyGraph";
import type { ManagedContentTerminology } from "./contentTerminology";

type MissingDependency = NonNullable<InstalledMod["dependencyHealth"]>["missing"][number];

/**
 * The installed-list marker for a library: it names the mod that pulled it in and goes there. A
 * library several mods share opens a menu of them instead, so every link still lands on a mod and
 * never on a summary the reader then has to search. It turns to a warning when the library is off
 * while something enabled still needs it, the one state where the link explains a failure.
 */
export function RequiredByChip({ mod, requiredBy, terminology, onOpen }: {
  mod: InstalledMod;
  requiredBy: InstalledMod[];
  terminology: Pick<ManagedContentTerminology, "plural">;
  onOpen: (mod: InstalledMod) => void;
}) {
  if (requiredBy.length === 0) return null;
  const blocking = !mod.enabled && requiredBy.some((parent) => parent.enabled);
  const lead = blocking ? "Needed by" : "Required by";
  const className = `modsDependencyChip${blocking ? " isBlocking" : ""}`;
  const icon = blocking ? <TriangleAlert aria-hidden="true" /> : <Link2 aria-hidden="true" />;
  const names = formatModNames(requiredBy);

  if (requiredBy.length === 1) {
    const [parent] = requiredBy;
    return (
      <button type="button" className={className} onClick={() => onOpen(parent)} title={`${lead} ${parent.displayName}. Open ${parent.displayName}.`}>
        {icon}
        <span className="modsDependencyChipLead">{lead}</span>
        <strong>{parent.displayName}</strong>
        <ChevronRight className="modsDependencyChipEnd" aria-hidden="true" />
      </button>
    );
  }

  return (
    <ActionMenu
      label={`${lead} ${names}`}
      iconOnly={false}
      portal
      align="start"
      className="modsDependencyChipMenu"
      triggerClassName={className}
      menuClassName="modsDependencyMenu"
      note={`${mod.displayName} is shared by these ${terminology.plural}.`}
      trigger={<>
        {icon}
        <span className="modsDependencyChipLead">{lead}</span>
        <strong>{requiredBy.length} {terminology.plural}</strong>
        <ChevronDown className="modsDependencyChipEnd" aria-hidden="true" />
      </>}
      items={requiredBy.map((parent) => ({
        id: parent.filename,
        label: <span className="modsDependencyMenuLabel"><span>{parent.displayName}</span>{!parent.enabled && <small>Disabled</small>}</span>,
        icon: <ModIconImage src={modIconSource(parent.iconUrl)} fallback="JAR" />,
        title: `Open ${parent.displayName}`,
        onSelect: () => onOpen(parent)
      }))}
    />
  );
}

/**
 * Both directions of a mod's dependencies in its details drawer. Every installed entry opens that
 * mod's details in place, so the drawer doubles as a way to walk from a mod to its libraries and
 * back without returning to the list.
 */
export function ModDependencySection({ mod, links, missing, terminology, onOpen }: {
  mod: InstalledMod;
  links: ModDependencyLinks;
  missing: MissingDependency[];
  terminology: Pick<ManagedContentTerminology, "singular" | "plural">;
  onOpen: (mod: InstalledMod) => void;
}) {
  // A missing dependency that is only switched off is still an installed mod, so it is shown once,
  // as a linked row with its disabled state, rather than again as an unresolved gap.
  const unresolved = missing.filter((dependency) => !links.requires.some((installed) => (
    (dependency.projectId && installed.modrinth?.projectId === dependency.projectId)
    || (dependency.versionId && installed.modrinth?.versionId === dependency.versionId)
  )));
  const requiresCount = links.requires.length + unresolved.length;
  if (requiresCount === 0 && links.requiredBy.length === 0) return null;
  const dependents = enabledDependents(links);

  return (
    <section className="modsDependencySection" aria-labelledby="mod-dependencies-title">
      <h3 id="mod-dependencies-title">Dependencies</h3>
      {requiresCount > 0 && (
        <div className="modsDependencyGroup">
          <p className="modsDependencyGroupLabel">Requires <span>{requiresCount}</span></p>
          <ul>
            {links.requires.map((dependency) => (
              <li key={dependency.filename}>
                <DependencyLink mod={dependency} state={dependency.enabled ? { tone: "ready", label: "Installed" } : { tone: "blocking", label: "Disabled" }} onOpen={onOpen} />
              </li>
            ))}
            {unresolved.map((dependency, index) => (
              <li key={`${dependency.projectId || dependency.versionId || "dependency"}-${index}`}>
                <div className="modsDependencyLink isMissing">
                  <ModIconImage src={modIconSource(dependency.iconUrl)} fallback="?" />
                  <span className="modsDependencyLinkName"><strong>{dependency.title || dependency.projectId || "Required dependency"}</strong></span>
                  <span className="modsDependencyState blocking">{dependency.disabled ? "Disabled" : "Not installed"}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {links.requiredBy.length > 0 && (
        <div className="modsDependencyGroup">
          <p className="modsDependencyGroupLabel">Required by <span>{links.requiredBy.length}</span></p>
          <ul>
            {links.requiredBy.map((dependent) => (
              <li key={dependent.filename}>
                <DependencyLink mod={dependent} state={dependent.enabled ? undefined : { tone: "muted", label: "Disabled" }} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {dependents.length > 0 && (
            <p className={`modsDependencyNote${mod.enabled ? "" : " isBlocking"}`}>
              {mod.enabled
                ? `Disabling or removing this ${terminology.singular} stops ${formatModNames(dependents)} from loading.`
                : `${formatModNames(dependents)} cannot load until this ${terminology.singular} is enabled.`}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function DependencyLink({ mod, state, onOpen }: {
  mod: InstalledMod;
  state?: { tone: "ready" | "blocking" | "muted"; label: string };
  onOpen: (mod: InstalledMod) => void;
}) {
  return (
    <button type="button" className="modsDependencyLink" onClick={() => onOpen(mod)} title={`Open ${mod.displayName}`}>
      <ModIconImage src={modIconSource(mod.iconUrl)} fallback="JAR" />
      <span className="modsDependencyLinkName"><strong>{mod.displayName}</strong></span>
      {state && <span className={`modsDependencyState ${state.tone}`}>{state.label}</span>}
      <ChevronRight className="modsDependencyLinkEnd" aria-hidden="true" />
    </button>
  );
}
