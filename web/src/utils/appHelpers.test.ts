import { describe, expect, it } from "vitest";
import { serverConfigValidation } from "./appHelpers";

function validCreateForm() {
  const form = new FormData();
  form.set("displayName", "Runtime test");
  form.set("nodeId", "node-1");
  form.set("acceptEula", "on");
  form.set("minecraftVersion", "1.21.4");
  return form;
}

describe("serverConfigValidation runtime fields", () => {
  it("accepts the canonical runtime version field", () => {
    const form = validCreateForm();
    form.set("runtimeVersion", "1.21.4-232");

    expect(serverConfigValidation(form, [], undefined, {
      requireNode: true,
      requireEula: true,
      requireRuntime: true
    })).toEqual([]);
  });

  it("keeps the legacy Fabric loader version field compatible", () => {
    const form = validCreateForm();
    form.set("loaderVersion", "0.16.10");

    expect(serverConfigValidation(form, [], undefined, { requireRuntime: true })).toEqual([]);
  });

  it("reports a runtime-neutral error when no runtime version is selected", () => {
    const errors = serverConfigValidation(validCreateForm(), [], undefined, { requireRuntime: true });

    expect(errors).toContainEqual({
      field: "runtimeVersion",
      message: "Choose a runtime version or keep the recommended option."
    });
  });
});
