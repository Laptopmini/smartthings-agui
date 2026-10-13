import type { CatalogRenderers, RendererProps } from "@copilotkit/a2ui-renderer";
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { definitions } from "./definitions";

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
      style={{ width: "100%", margin: 0, boxSizing: "border-box" }}
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
    return (
      <div style={tile} data-testid="device-tile" data-label={label}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, minWidth: 0 }} title={label}>
          {color && (
            <span aria-hidden style={{ width: 10, height: 10, borderRadius: 5, background: color, flex: "none" }} />
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{label}</span>
        </div>
        {str(p.room) && <div style={muted}>{str(p.room)}</div>}
        {str(p.stateText) && <div style={{ fontSize: 13 }} data-testid="tile-state">{str(p.stateText)}</div>}
        {p.canToggle === true && (
          <button style={control} aria-pressed={p.isOn === true} onClick={() => call(p.toggle)}>
            {p.isOn ? "Turn off" : "Turn on"}
          </button>
        )}
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
        {str(p.note) && <div style={muted}>{str(p.note)}</div>}
      </div>
    );
  },

  SceneButton: ({ props }) => (
    <button style={{ ...control, justifySelf: "stretch", padding: "8px 12px" }} onClick={() => call(props.run)}>
      {str(props.name)}
    </button>
  ),
};
