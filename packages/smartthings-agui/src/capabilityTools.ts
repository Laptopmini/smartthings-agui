import type { CapabilityDefinition, JsonSchema } from "./client";

/** Capabilities whose commands always need a person's confirmation.
 *
 *  Hard-coded on purpose: the API's per-command `sensitive` flag is not a
 *  safety signal. `GET /capabilities/lock/1` returns `"sensitive": false` for
 *  `unlock` (checked 13 Oct 2026); the flag marks commands whose *arguments*
 *  carry secrets, not commands with physical consequences.
 */
export const CONFIRM_CAPABILITIES: ReadonlySet<string> = new Set([
  "lock",
  "garageDoorControl",
  "securitySystem",
  "valve",
]);

export interface GeneratedTool {
  name: string;
  description: string;
  capability: string;
  command: string;
  /** Argument names in the order the SmartThings command expects them. */
  argumentNames: string[];
  parameters: JsonSchema;
  requiresConfirmation: boolean;
}

/** Tool names must match `^[a-zA-Z0-9_-]{1,64}$` for OpenAI-style APIs;
 *  namespaced capabilities like `synthetic.lightingEffectFade` have a dot. */
export function toolName(capability: string, command: string): string {
  return `${capability}_${command}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** A one-line, human-readable form of an argument schema.
 *
 *  The LlamaIndex AG-UI router (llama-index-protocols-ag-ui 0.5.0) rebuilds
 *  every frontend-tool parameter as a plain string, dropping `enum`, `type`,
 *  `minimum` and `maximum`, but it keeps `description`. Repeating the
 *  constraints in prose is what still reaches the model. Pinned by
 *  agent/tests/test_dynamic_tool_schema.py.
 */
export function describeSchema(schema: JsonSchema): string {
  const parts: string[] = [];
  if (Array.isArray(schema.enum)) parts.push(`one of: ${schema.enum.join(", ")}`);
  else if (typeof schema.type === "string") parts.push(schema.type);
  const min = schema.minimum;
  const max = schema.maximum;
  if (typeof min === "number" && typeof max === "number") parts.push(`${min} to ${max}`);
  else if (typeof min === "number") parts.push(`>= ${min}`);
  else if (typeof max === "number") parts.push(`<= ${max}`);
  return parts.join(", ");
}

/** Strip keys that add tokens but no meaning for a model. */
function cleanSchema(schema: JsonSchema): JsonSchema {
  const { title: _title, $schema: _$schema, ...rest } = schema;
  return rest;
}

/** One tool per command in a capability definition from the public API.
 *
 *  Every tool takes `deviceId` plus the command's own arguments, whose JSON
 *  Schemas come straight from `GET /capabilities/{id}/{version}`.
 */
export function capabilityToTools(definition: CapabilityDefinition): GeneratedTool[] {
  const requiresConfirmation = CONFIRM_CAPABILITIES.has(definition.id);
  return Object.values(definition.commands ?? {}).map((command) => {
    const args = command.arguments ?? [];
    const properties: Record<string, JsonSchema> = {
      deviceId: { type: "string", description: "Device id from list_devices" },
    };
    for (const arg of args) {
      const schema = cleanSchema(arg.schema);
      const constraint = describeSchema(schema);
      properties[arg.name] = { ...schema, description: constraint ? `${arg.name} (${constraint})` : arg.name };
    }
    return {
      name: toolName(definition.id, command.name),
      description:
        `Send the SmartThings "${command.name}" command of the "${definition.id}" capability to a device.` +
        (requiresConfirmation ? " The user must confirm before it runs." : ""),
      capability: definition.id,
      command: command.name,
      argumentNames: args.map((a) => a.name),
      parameters: {
        type: "object",
        properties,
        required: ["deviceId", ...args.filter((a) => !a.optional).map((a) => a.name)],
      },
      requiresConfirmation,
    };
  });
}

/** Wrap a plain JSON Schema as a Standard JSON Schema V1 object.
 *
 *  CopilotKit 1.79's `createToolSchema` takes any `~standard` schema and, when
 *  it exposes `jsonSchema.input`, uses that verbatim, so generated schemas
 *  need no Zod round trip. Validation here only checks required keys; the
 *  SmartThings API validates argument values itself and returns 422.
 */
export function jsonSchemaParameters<T extends Record<string, unknown>>(schema: JsonSchema) {
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    "~standard": {
      version: 1 as const,
      vendor: "smartthings-agui",
      validate(value: unknown) {
        if (typeof value !== "object" || value === null) {
          return { issues: [{ message: "Expected an object" }] };
        }
        const missing = required.filter((k) => !(k in value));
        return missing.length
          ? { issues: missing.map((k) => ({ message: `Missing ${k}`, path: [k] })) }
          : { value: value as T };
      },
      jsonSchema: { input: () => schema, output: () => schema },
      // Type-only: lets `useFrontendTool` infer the handler's argument type.
      types: undefined as unknown as { input: T; output: T },
    },
  };
}
