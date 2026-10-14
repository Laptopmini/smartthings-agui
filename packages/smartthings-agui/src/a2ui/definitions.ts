/** The SmartThings A2UI catalog: component contracts (A2UI v0.9).
 *
 *  `zod/v3`, never bare `zod`: with Zod 4 the renderer silently drops every
 *  prop. For tsc, tsconfig `paths` maps `zod/v3` to the `zod-v3-types`
 *  devDependency (zod@3.25.76), the copy whose types the renderer and
 *  @a2ui/web_core use; at runtime it still resolves from zod@4.
 *
 *  Templates can't compute, so every display string (`stateText`) and every
 *  flag (`canToggle`, `canDim`) is computed in surfaces.ts and bound from the
 *  data model. Controls are A2UI Actions: the card dispatches them and
 *  Surface.tsx runs them through the same tool handlers the agent uses, so
 *  the safety policy applies to clicks too.
 *
 *  The agent never sees this catalog (no `a2ui` prop on <CopilotKit>; see
 *  CopilotKit #7802): it calls `show_devices`, and the browser builds the surface.
 */
import { CommonSchemas } from "@a2ui/web_core/v0_9";
import { z } from "zod/v3";

export const definitions = {
  TileGrid: {
    description: "A titled grid of tiles; children are usually a template over a data-model list.",
    props: z.object({
      title: CommonSchemas.DynamicString.optional(),
      children: CommonSchemas.ChildList,
    }),
  },
  DeviceTile: {
    description:
      "One device: name, room, a one-line state summary, a level slider when allowed, and an icon that shows " +
      "what the device is and its state and doubles as its main button (toggle, or ask to confirm).",
    props: z.object({
      label: CommonSchemas.DynamicString,
      room: CommonSchemas.DynamicString.optional(),
      stateText: CommonSchemas.DynamicString.optional(),
      // CSS colour of the bulb, or "" for none.
      color: CommonSchemas.DynamicString.optional(),
      isOn: CommonSchemas.DynamicBoolean.optional(),
      level: CommonSchemas.DynamicNumber.optional(),
      canDim: CommonSchemas.DynamicBoolean.optional(),
      // Icon name from icons.ts, its tone (on/off/alert/neutral), what a tap
      // does (toggle/confirm/none) and the button's accessible label.
      icon: CommonSchemas.DynamicString.optional(),
      tone: CommonSchemas.DynamicString.optional(),
      action: CommonSchemas.DynamicString.optional(),
      actionLabel: CommonSchemas.DynamicString.optional(),
      press: CommonSchemas.Action.optional(),
      changeLevel: CommonSchemas.Action.optional(),
    }),
  },
  SceneButton: {
    description: "Runs one scene when the person presses it.",
    props: z.object({
      name: CommonSchemas.DynamicString,
      run: CommonSchemas.Action,
    }),
  },
};
