import { describe, expect, it } from "vitest";
import { capabilityToTools, describeSchema, jsonSchemaParameters, toolName } from "../src/capabilityTools";
import type { CapabilityDefinition } from "../src/client";
import colorControl from "./fixtures/capability-colorControl.json";
import lock from "./fixtures/capability-lock.json";
import switchCap from "./fixtures/capability-switch.json";
import switchLevel from "./fixtures/capability-switchLevel.json";

// Fixtures are verbatim `GET /v1/capabilities/{id}/1` responses (13 Oct 2026).

const byName = (def: unknown) =>
  Object.fromEntries(capabilityToTools(def as CapabilityDefinition).map((t) => [t.name, t]));

describe("capabilityToTools", () => {
  it("makes one argument-less tool per switch command", () => {
    const tools = byName(switchCap);
    expect(Object.keys(tools).sort()).toEqual(["switch_off", "switch_on"]);
    expect(tools.switch_on.parameters).toEqual({
      type: "object",
      properties: { deviceId: { type: "string", description: "Device id from list_devices" } },
      required: ["deviceId"],
    });
    expect(tools.switch_on.requiresConfirmation).toBe(false);
  });

  it("carries argument schemas through, and keeps optional arguments optional", () => {
    const { switchLevel_setLevel: tool } = byName(switchLevel);
    expect(tool.argumentNames).toEqual(["level", "rate"]);
    expect(tool.parameters.required).toEqual(["deviceId", "level"]);
    const props = tool.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.level).toMatchObject({ type: "integer", minimum: 0, maximum: 100 });
    expect(props.level.description).toBe("level (integer, 0 to 100)");
    expect(props.rate).not.toHaveProperty("title");
  });

  it("handles object-typed arguments (colorControl.setColor)", () => {
    const { colorControl_setColor: tool } = byName(colorControl);
    const props = tool.parameters.properties as Record<string, Record<string, unknown>>;
    expect(props.color.type).toBe("object");
    expect(tool.parameters.required).toEqual(["deviceId", "color"]);
  });

  it("marks lock commands for confirmation even though the API says unlock isn't sensitive", () => {
    expect((lock as CapabilityDefinition).commands?.unlock.sensitive).toBe(false);
    const tools = byName(lock);
    expect(tools.lock_unlock.requiresConfirmation).toBe(true);
    expect(tools.lock_unlock.description).toMatch(/must confirm/);
  });
});

describe("helpers", () => {
  it("sanitises namespaced capability ids into valid tool names", () => {
    expect(toolName("synthetic.lightingEffectFade", "setFade")).toBe("synthetic_lightingEffectFade_setFade");
  });

  it("describes enums and ranges in prose", () => {
    expect(describeSchema({ type: "string", enum: ["on", "off"] })).toBe("one of: on, off");
    expect(describeSchema({ type: "integer", minimum: 0 })).toBe("integer, >= 0");
  });

  it("wraps a JSON Schema as a Standard JSON Schema that validates required keys", () => {
    const schema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
    const std = jsonSchemaParameters(schema)["~standard"];
    expect(std.jsonSchema.input()).toBe(schema);
    expect(std.validate({ a: "x" })).toEqual({ value: { a: "x" } });
    expect(std.validate({})).toHaveProperty("issues");
  });
});
