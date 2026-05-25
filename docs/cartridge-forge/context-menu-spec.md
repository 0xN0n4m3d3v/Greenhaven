# Cartridge Forge Context Menu Spec

## Goal

Right-click on the Forge canvas must expose direct editing actions for the
current context: empty canvas, entity node, visual node, or graph edge. The menu
is a workflow surface, not a browser replacement.

## Donor Patterns

- MDN `contextmenu`: cancel the native menu with `preventDefault()` and render a
  custom positioned UI.
- React Flow context menu example: node menu is opened from the event position
  and clamped inside the pane.
- LiteGraph/Comfy: menu items are structured as title, entries, dividers,
  disabled entries, and nested action groups.
- n8n canvas tests: context menu actions must be addressable by stable action ids
  for automation.

## Contexts

- **Canvas**: create entity at pointer, fit graph, switch canvas mode, validate,
  import/export.
- **Entity node**: inspect, AI-fill, create quest, create visual, create related
  child records, start link mode from this node, duplicate as draft.
- **Visual node**: select visual, rebuild/attach manifest.
- **Edge**: inspect source/target, create reverse link, remove manual link.

## Action Contract

Each action has a stable `data-action`, label, optional hint, optional danger
style, optional disabled reason, and one async handler. Menu closes on action,
outside click, Escape, scroll, project refresh, and mode change.

## Persistence

Entity creation uses existing `/api/projects/:slug/records`. Links use existing
link APIs plus a new delete-link API for edge cleanup. Canvas position is stored
in browser layout only; records do not yet persist absolute coordinates.

## Verification

- Unit/API: link removal is covered by server tests.
- Browser smoke: right-click canvas and nodes, execute create/link/delete
  actions, confirm menu is clamped and no console errors.
- Build gates: Cartridge Forge typecheck/test/build, Greenhaven release/i18n
  checks when SQL export is touched.
