import type { CatalogRenderers, RendererProps } from "@copilotkit/a2ui-renderer";
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { definitions } from "./definitions.js";
import { ICONS } from "./iconComponents.js";
import type { IconName } from "./icons.js";

/** React renderers for the catalog.
 *
 *  Two things the renderer's d.ts doesn't say (createCatalog 1.79.0, as in
 *  1.67.1):
 *  1. A ChildList prop arrives resolved: a template becomes `{id, basePath}`
 *     nodes, one per data item.
 *  2. `children` is really `buildChild(id, basePath)`; without `basePath`
 *     relative bindings resolve against the root and render empty
 *     (CopilotKit PR #7801 fixes the typing).
 *
 *  Bound props also arrive with a setter (`setLevel` for `level`) that writes
 *  the data model, and Action props as functions that dispatch the action
 *  with its context resolved at that moment. The level slider uses both:
 *  write the new value, then dispatch `changeLevel`, whose context reads it.
 *
 *  Every prop can be undefined (partial data model), so nothing throws.
 */

type ChildNode = string | { id: string; basePath?: string };
type BuildChild = (id: string, basePath?: string) => ReactNode;

function renderChildren(list: unknown, children: RendererProps["children"]): ReactNode[] {
  if (!Array.isArray(list)) return [];
  const build = children as unknown as BuildChild;
  return list.map((c: ChildNode, i) =>
    typeof c === "string" ? (
      <Fragment key={`${c}-${i}`}>{build(c)}</Fragment>
    ) : (
      <Fragment key={`${c.id}-${i}`}>{build(c.id, c.basePath)}</Fragment>
    ),
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const call = (fn: unknown) => (typeof fn === "function" ? (fn as () => void)() : undefined);

const tile: CSSProperties = {
  border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
  borderRadius: 12,
  padding: "10px 12px",
  display: "grid",
  gap: 6,
  alignContent: "start",
  minWidth: 0,
};
const muted: CSSProperties = { opacity: 0.65, fontSize: 12 };
const iconBox: CSSProperties = {
  width: 44,
  height: 44,
  borderRadius: 22,
  display: "grid",
  placeItems: "center",
  flex: "none",
};
const iconButton: CSSProperties = { border: "none", padding: 0, cursor: "pointer" };

/** Tone → colours that read in light and dark themes alike. */
const TONES: Record<string, { color: string; background: string }> = {
  on: { color: "#e0a100", background: "color-mix(in srgb, #f5b301 20%, transparent)" },
  // 55%: at 45% a crossed-out bulb was hard to make out on white.
  off: { color: "color-mix(in srgb, currentColor 55%, transparent)", background: "color-mix(in srgb, currentColor 7%, transparent)" },
  alert: { color: "#e5484d", background: "color-mix(in srgb, #e5484d 16%, transparent)" },
  neutral: { color: "currentColor", background: "color-mix(in srgb, currentColor 10%, transparent)" },
};

const control: CSSProperties = {
  padding: "4px 12px",
  borderRadius: 999,
  border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 13,
  cursor: "pointer",
  justifySelf: "start",
};

/** The slider keeps a local value while dragging and commits on release, so a
 *  drag sends one command, not one per pixel (SmartThings rate-limits). */
function LevelSlider({ level, label, onCommit }: { level: number; label: string; onCommit: (n: number) => void }) {
  const [value, setValue] = useState(level);
  useEffect(() => setValue(level), [level]);
  return (
    <input
      type="range"
      min={0}
      max={100}
      value={value}
      aria-label={`${label} level`}
      // An explicit accent: in dark mode WebKit's default track all but vanished.
      style={{ width: "100%", margin: 0, boxSizing: "border-box", accentColor: "#3b82f6" }}
      onChange={(e) => setValue(Number(e.target.value))}
      onPointerUp={() => onCommit(value)}
      onKeyUp={() => onCommit(value)}
    />
  );
}

export const renderers: CatalogRenderers<typeof definitions> = {
  TileGrid: ({ props, children }) => (
    <div style={{ margin: "6px 0", maxWidth: 560 }} data-testid="tile-grid">
      {str(props.title) && <div style={{ fontWeight: 600, marginBottom: 6 }}>{str(props.title)}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
        {renderChildren(props.children, children)}
      </div>
    </div>
  ),

  DeviceTile: ({ props }) => {
    const p = props as typeof props & { setLevel?: (n: number) => void };
    const label = str(p.label);
    const color = str(p.color);
    const action = str(p.action) || "none";
    const actionLabel = str(p.actionLabel) || label;
    const Icon = ICONS[str(p.icon) as IconName] ?? ICONS.box;
    const tone = TONES[str(p.tone)] ?? TONES.neutral;
    // A colour bulb that's on shows its own colour.
    const iconColor = str(p.tone) === "on" && color ? color : tone.color;
    // The SVG strokes with currentColor; the colour is set on its container,
    // since an SVG attribute won't take CSS functions like color-mix().
    const picture = <Icon size={22} strokeWidth={2} aria-hidden />;
    return (
      <div style={tile} data-testid="device-tile" data-label={label}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "start" }}>
          <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
            {/* Up to two lines, then an ellipsis: on a phone a tile is ~170 px
                wide and one line cut most names after ~14 characters. */}
            <span
              title={label}
              style={{
                fontWeight: 600,
                display: "-webkit-box",
                WebkitBoxOrient: "vertical",
                WebkitLineClamp: 2,
                overflow: "hidden",
                overflowWrap: "anywhere",
              }}
            >
              {label}
            </span>
            {str(p.room) && <div style={muted}>{str(p.room)}</div>}
            {str(p.stateText) && (
              <div style={{ fontSize: 13 }} data-testid="tile-state">
                {str(p.stateText)}
              </div>
            )}
          </div>
          {/* The icon is the main button (toggle, or ask to confirm), as in most
              smart-home apps; its label keeps it usable with a keyboard and a
              screen reader now that the text button is gone. */}
          {action === "none" ? (
            <span style={{ ...iconBox, background: tone.background, color: iconColor }} data-testid="tile-icon" data-tone={str(p.tone)}>
              {picture}
            </span>
          ) : (
            <button
              type="button"
              style={{ ...iconBox, ...iconButton, background: tone.background, color: iconColor }}
              aria-label={actionLabel}
              title={actionLabel}
              aria-pressed={action === "toggle" ? p.isOn === true : undefined}
              data-testid="tile-icon"
              data-tone={str(p.tone)}
              onClick={() => call(p.press)}
            >
              {picture}
            </button>
          )}
        </div>
        {p.canDim === true && typeof p.level === "number" && (
          <LevelSlider
            level={p.level}
            label={label}
            onCommit={(n) => {
              p.setLevel?.(n);
              call(p.changeLevel);
            }}
          />
        )}
      </div>
    );
  },

  SceneButton: ({ props }) => (
    <button style={{ ...control, justifySelf: "stretch", padding: "8px 12px" }} onClick={() => call(props.run)}>
      {str(props.name)}
    </button>
  ),
};
