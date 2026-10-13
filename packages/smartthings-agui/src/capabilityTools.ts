import type { CapabilityDefinition, JsonSchema } from "./client";
import { CONFIRM_CAPABILITIES } from "./policy";


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

/** Check command arguments against the capability definition's JSON Schemas.
 *
 *  Covers what models get wrong in practice: a missing or unknown command,
 *  argument count, primitive type, enum, and numeric range. Strings that hold
 *  numbers or JSON are coerced first, because the LlamaIndex router turns
 *  every frontend-tool parameter into a string (see describeSchema).
 *  Returns the coerced arguments, or throws with a message meant for the model.
 */
export function validateArguments(definition: CapabilityDefinition, command: string, args: unknown[]): unknown[] {
  const spec = definition.commands?.[command];
  if (!spec) {
    const known = Object.keys(definition.commands ?? {});
    throw new Error(
      `${definition.id} has no command "${command}". Commands: ${known.join(", ") || "(none; it's read-only)"}.`,
    );
  }
  const specs = spec.arguments ?? [];
  const required = specs.filter((a) => !a.optional).length;
  if (args.length < required || args.length > specs.length) {
    const names = specs.map((a) => (a.optional ? `${a.name}?` : a.name)).join(", ");
    throw new Error(`${definition.id}.${command} takes ${specs.length ? `arguments (${names})` : "no arguments"}.`);
  }
  return args.map((value, i) => checkValue(specs[i].name, specs[i].schema, value));
}

function checkValue(name: string, schema: JsonSchema, raw: unknown): unknown {
  let value = raw;
  const type = schema.type;
  if (typeof value === "string" && (type === "integer" || type === "number") && value.trim() !== "") {
    value = Number(value);
  } else if (typeof value === "string" && (type === "object" || type === "array")) {
    try {
      value = JSON.parse(value);
    } catch {
      // leave as is; the type check below reports it
    }
  }
  const fail = () => {
    throw new Error(`${name} must be ${describeSchema(schema) || String(type)}; got ${JSON.stringify(raw)}.`);
  };
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail();
  if (type === "integer" && !Number.isInteger(value)) fail();
  if (type === "number" && (typeof value !== "number" || Number.isNaN(value))) fail();
  if (type === "string" && typeof value !== "string") fail();
  if (type === "boolean" && typeof value !== "boolean") fail();
  if (type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) fail();
  if (type === "array" && !Array.isArray(value)) fail();
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) fail();
    if (typeof schema.maximum === "number" && value > schema.maximum) fail();
  }
  return value;
}
