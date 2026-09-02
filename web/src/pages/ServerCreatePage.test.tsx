import { serverRuntimeDefinitions } from "@serversentinel/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CreateServerStepper, NodeOverviewCard, ReviewSummaryCard, RuntimeWizardStep } from "./ServerCreatePage";

function renderPaperRuntime(input: { runtimeVersion?: string; noStableBuild?: boolean; loading?: boolean; minecraftLoading?: boolean } = {}) {
  const runtimeVersion = input.runtimeVersion ?? "132";
  return renderToStaticMarkup(
    <RuntimeWizardStep
      runtimeType="paper"
      runtimeDefinition={serverRuntimeDefinitions.paper}
      minecraftVersion={input.noStableBuild ? "26.2" : "1.21.11"}
      minecraftOptions={[{
        version: input.noStableBuild ? "26.2" : "1.21.11",
        stable: true,
        type: "release",
        recommended: !input.noStableBuild
      }]}
      runtimeVersion={input.noStableBuild ? "" : runtimeVersion}
      runtimeOptions={input.noStableBuild ? [] : [{ id: runtimeVersion, runtimeVersion, stable: true, recommended: true }]}
      recommendedRuntimeVersion={input.noStableBuild ? "" : runtimeVersion}
      minecraftVersionsLoading={input.minecraftLoading}
      runtimeVersionsLoading={input.loading}
      showSnapshots={false}
      javaVersion={input.noStableBuild ? 25 : 21}
      runtimeCompatible={!input.noStableBuild}
      onRuntimeTypeChange={vi.fn()}
      onMinecraftVersionChange={vi.fn()}
      onRuntimeVersionChange={vi.fn()}
      onShowSnapshotsChange={vi.fn()}
    />
  );
}

describe("RuntimeWizardStep", () => {
  it("offers Paper as a managed runtime with stable build terminology", () => {
    const html = renderPaperRuntime();

    expect(html).toContain("Paper build");
    expect(html).toContain("132 (Recommended)");
    expect(html).toContain("plugin ecosystem");
    expect(html).toContain("Server JAR filename");
    expect(html).not.toContain("Server JAR source");
    expect(html).toMatch(/aria-pressed="true"[^>]*title="Use Paper"/);
    expect(html).not.toMatch(/aria-pressed="true"[^>]*disabled/);
  });

  it("explains when a Minecraft version has no stable Paper build", () => {
    const html = renderPaperRuntime({ noStableBuild: true });

    expect(html).toContain("No stable Paper build is available for this Minecraft version");
    expect(html).toContain("enable development builds");
  });

  it("shows loading state without flashing the no-stable-build warning", () => {
    const html = renderPaperRuntime({ noStableBuild: true, loading: true });

    expect(html).toContain("Loading compatible Paper builds");
    expect(html).not.toContain("No stable Paper build is available");
  });

  it("shows Minecraft-version loading state without an availability warning", () => {
    const html = renderPaperRuntime({ noStableBuild: true, minecraftLoading: true });

    expect(html).toContain("Loading available Paper Minecraft versions");
    expect(html).not.toContain("No stable Paper build is available");
  });
});

describe("CreateServerStepper", () => {
  it("exposes ordered progress and the current step", () => {
    const html = renderToStaticMarkup(<CreateServerStepper activeStep={2} />);

    expect(html).toContain('role="list"');
    expect(html.match(/role="listitem"/g)).toHaveLength(4);
    expect(html).toMatch(/createWizardStep active[^>]*aria-current="step"/);
    expect(html).toContain("Completed");
    expect(html).toContain("Current step");
    expect(html).toContain("Not started");
  });

  it("gives each edit action a section-specific accessible name", () => {
    const html = renderToStaticMarkup(
      <ReviewSummaryCard title="Runtime" onEdit={vi.fn()}><span>Details</span></ReviewSummaryCard>
    );

    expect(html).toContain('aria-label="Edit Runtime"');
    expect(html).toContain("<span>Edit</span>");
  });
});

describe("NodeOverviewCard", () => {
  it("labels and displays the node total memory without inventing an available amount", () => {
    const html = renderToStaticMarkup(<NodeOverviewCard fallbackMemory={8 * 1024 ** 3} />);

    expect(html).toContain("Total memory");
    expect(html).toContain("8192.0 MiB");
    expect(html).not.toContain("Available memory");
    expect(html).not.toContain("8192.0 MiB / 8192.0 MiB");
  });
});
