# Cartridge Forge

`Cartridge Forge` is the game-master authoring tool for Greenhaven cartridges.
It is a separate Node application in the same repository, parallel to the
playable game, and it exports strict cartridge ingest packs that the backend can
validate, compile into migrations, and load into the game.

Forge is not a generic chatbot. It is a workflow editor for building playable
world data: locations, NPCs, factions, quests, scenes, events, activities,
dialogue pools, relationships, items, and source/provenance records.

## Product Goal

A game master should be able to create cartridge content the way the player
creates a character: step by step, with structured fields, AI-assisted fill,
review cards, missing-field warnings, and a final export that can enter the
Greenhaven migration pipeline.

The target experience is "n8n for cartridge creation": a canvas of typed nodes,
execution logs, rerunnable steps, credentials kept out of node content, and
visible validation gates. The tool should remain Greenhaven-specific enough to
understand quests, scenes, state fields, power centers, source policy, and
playability.

## Architecture

```text
packages/cartridge-forge/
  src/core/              workflow runner, project store, node registry
  src/providers/         DeepSeek adapter and provider interfaces
  src/exporters/         JSONL pack and migration export orchestration
  src/validators/        schema, provenance, graph, duplicate, gameplay checks
  src/cli/               non-visual commands for automation
  src/server/            local Hono API for the browser editor
  src/visual/            visual pack store and Sticker Studio manifest bridge
  src/n8n-adapted/       copied n8n workflow graph/status helpers adapted for Forge
  public/                browser UI for projects, records, visuals, validation
  forge-projects/        local projects, ignored by git
```

The first browser editor is implemented as a lightweight static UI served by
the Forge Hono server. It follows the n8n-style workspace pattern: projects,
typed authoring nodes, inspector, execution/validation log, rerunnable actions,
and export gates.

## MVP Status

Runnable MVP exists in `packages/cartridge-forge`.

Current commands:

```powershell
npm --prefix packages/cartridge-forge run dev
npm --prefix packages/cartridge-forge run forge -- init <project-slug>
npm --prefix packages/cartridge-forge run forge -- add-record <project> <kind> <slug> <name> [summary...]
npm --prefix packages/cartridge-forge run forge -- ai-fill <project> <record-slug>
npm --prefix packages/cartridge-forge run forge -- attach-visuals <project> <sticker-manifest-jsonl>
npm --prefix packages/cartridge-forge run forge -- validate <project>
npm --prefix packages/cartridge-forge run forge -- export-pack <project>
```

Open the web editor at `http://127.0.0.1:4899` after `run dev`. The current UI
can create projects, add world records, edit summary/tags/payload JSON, run
DeepSeek fill, create visual packs, rebuild/attach visual manifests, add
sources, run the default validation/visual/export workflow, inspect execution
history, validate directly, and export an agent pack. It also includes a large
ComfyUI/n8n-inspired world canvas for pan/zoom/drag, graph links, graph
validation, visual-pack creation, and quest scaffolding from selected entities.

The MVP uses Ajv for JSON Schema validation and DeepSeek's official
OpenAI-compatible chat completions endpoint with JSON mode for schema-bound
fill steps. The visual assets bridge reuses the Node Sticker Studio
`character.yaml` / `manifest.jsonl` pack shape and adds `payload.visual_assets`
to matching cartridge records by `entity_slug`.

The workflow runner uses copied and adapted n8n source slices:

- `packages/workflow/src/execution-status.ts` -> Forge execution status values.
- `packages/workflow/src/graph/graph-utils.ts` -> Forge graph validation helpers.

The browser canvas currently reuses n8n-adapted graph helpers and a copied
ComfyUI/LiteGraph CSS slice, while keeping the data model Greenhaven-specific.
React Flow, Rete.js, or full LiteGraph remain candidates if the editor later
needs grouped subgraphs, node ports, or persisted client layouts.

## Project Model

A Forge project is a workspace directory:

```text
forge-projects/<project-slug>/
  forge.project.json
  workflows/<workflow-slug>.json
  sources.jsonl
  records/*.jsonl
  executions/*.jsonl
  visual-packs/<pack-name>/
  export/
```

`forge.project.json` stores cartridge target, source language, DeepSeek model
profile, import mode, and density goals. It must not store API keys.

Workflows are directed graphs:

```json
{
  "schema_version": "greenhaven.forge_workflow.v1",
  "workflow_slug": "tavern-density-batch",
  "nodes": [
    {"id": "brief", "type": "gm.brief", "config": {"scope": "Ale & Eats"}},
    {"id": "npc", "type": "entity.person.draft", "inputs": ["brief"]},
    {"id": "fill", "type": "deepseek.fill_missing", "inputs": ["npc"]},
    {"id": "gate", "type": "validate.playability", "inputs": ["fill"]},
    {"id": "export", "type": "export.agent_pack", "inputs": ["gate"]}
  ],
  "edges": [
    {"from": "brief", "to": "npc"},
    {"from": "npc", "to": "fill"},
    {"from": "fill", "to": "gate"},
    {"from": "gate", "to": "export"}
  ]
}
```

## Node Types

MVP node categories:

- `gm.brief`: human-authored goal, tone, power center, content budget.
- `source.add`: manual or fetched source metadata for `sources.jsonl`.
- `entity.location.draft`: location form with exits, mood, hooks, parent.
- `entity.person.draft`: NPC form with home, faction/social anchor, voice.
- `entity.quest.draft`: quest form with giver, stages, prepared entities.
- `entity.scene.draft`: scene form with participants, state fields, entries.
- `entity.item.draft`: item form with category, holder/location, use contract.
- `deepseek.fill_missing`: fills missing allowed fields from current draft.
- `deepseek.expand`: creates supporting records for a selected entity.
- `deepseek.critic`: finds contradictions, missing hooks, weak playability.
- `validate.schema`: JSON Schema validation.
- `validate.references`: slug/link resolution.
- `validate.provenance`: source/license/robots metadata checks.
- `validate.playability`: Greenhaven-specific quest/scene/NPC gates.
- `dedupe.scan`: compares slugs/names against active cartridge export.
- `export.agent_pack`: writes the JSONL pack.
- `export.migration_preview`: calls backend pack compiler in dry-run mode.

No MVP node may run arbitrary user JavaScript. Custom code nodes can come later
only with sandboxing and explicit security review.

## DeepSeek Integration

Forge uses provider settings from local environment or an ignored local config:

```text
DEEPSEEK_API_KEY=...
DEEPSEEK_BASE_URL=https://api.deepseek.com
CARTRIDGE_FORGE_MODEL=deepseek-reasoner
CARTRIDGE_FORGE_FAST_MODEL=deepseek-chat
```

Provider calls are task-scoped and schema-bound. The model receives:

- the project mission and selected cartridge scope;
- only the records needed for the node execution;
- the target output schema;
- source summaries and `source_id` values, not long copied source text;
- strict rules: no database ids, no copied web prose, no invented aliases, no
  unresolved slugs unless explicitly marked.

DeepSeek outputs JSON only. Forge validates the JSON before merging it into the
draft. Failed validation returns a node error and keeps the previous draft.

## Detail Wizards

Each entity editor should behave like character creation:

1. **Identity**: kind, canonical name, slug, short summary, tags.
2. **Anchor**: power center, parent location, faction, owner, giver, or holder.
3. **Voice or Mood**: NPC speech/registers or location/scene mood axes.
4. **Gameplay**: hooks, stages, state fields, choices, rewards, consequences.
5. **AI Fill**: ask DeepSeek to complete missing fields within the schema.
6. **Critique**: DeepSeek and deterministic validators flag weak or unsafe data.
7. **Export Readiness**: green/red checklist per record and per pack.

The AI may suggest, but the project state changes only after an accepted patch.

## Export Targets

Primary export:

```text
agent-packs/<pack-slug>/
```

This must match
[`agent-dataset-pipeline.md`](agent-dataset-pipeline.md) and
[`greenhaven-cartridge-ingest-record.v1`](schemas/greenhaven-cartridge-ingest-record.v1.schema.json).

Secondary exports:

- `export/preview-report.json`: counts, density, source risks, duplicates.
- `export/<pack-slug>.migration.sql`: optional compiled SQL preview.
- `export/frontend-handoff.md`: only if new UI presentation contracts are
  needed by the game.
- `export/playtest-plan.md`: suggested live scenarios for validating the pack.

Forge never writes directly into production migrations without an explicit
compile command and reviewable diff.

## Local Commands

Implemented commands:

```powershell
npm --prefix packages/cartridge-forge run dev
npm --prefix packages/cartridge-forge run build
npm --prefix packages/cartridge-forge run typecheck
npm --prefix packages/cartridge-forge run test
npm --prefix packages/cartridge-forge run forge -- init <project-slug>
npm --prefix packages/cartridge-forge run forge -- add-record <project> <kind> <slug> <name> [summary...]
npm --prefix packages/cartridge-forge run forge -- ai-fill <project> <record-slug>
npm --prefix packages/cartridge-forge run forge -- attach-visuals <project> <sticker-manifest-jsonl>
npm --prefix packages/cartridge-forge run forge -- validate <project>
npm --prefix packages/cartridge-forge run forge -- export-pack <project>
```

The backend pack pipeline then consumes the result:

```powershell
npm --prefix packages/web-server run cartridge:agent-pack:validate -- --pack agent-packs/<slug>
npm --prefix packages/web-server run cartridge:agent-pack:preview -- --pack agent-packs/<slug>
npm --prefix packages/web-server run cartridge:agent-pack:compile -- --pack agent-packs/<slug> --write
```

## Execution Logs

Every workflow run writes `executions/<timestamp>.jsonl`.

Each node execution stores:

- node id/type/version;
- started/ended timestamps;
- input record ids and hashes;
- output record ids and hashes;
- validation errors/warnings;
- provider model, request id, token counts, and redacted prompt metadata;
- status: `success`, `failed`, `skipped`, or `needs_human_review`.

Secrets and full provider prompts are redacted by default. A developer-only
debug mode may store prompts locally, but those files must be git-ignored.

## Review Gates

A project is export-ready only when:

- all records validate against schemas;
- every record has provenance;
- all links resolve;
- no mandatory gameplay fields are missing;
- duplicates are reviewed or explicitly allowed;
- source risks are acknowledged;
- DeepSeek-generated patches have deterministic validation output;
- a migration preview applies to a temp DB;
- the generated playtest plan exists.

## Browser Editor

The browser editor is intentionally local-first and filesystem-backed. It uses
the same API and stores as the CLI:

- `GET/POST /api/projects` for project discovery and creation.
- `GET /api/projects/:slug` for records, sources, and visual summaries.
- `GET/POST /api/projects/:slug/sources` for provenance records.
- `POST/PUT /api/projects/:slug/records` for cartridge ingest records.
- `POST /api/projects/:slug/records/:recordSlug/link` for canvas-created graph
  edges.
- `POST /api/projects/:slug/records/:recordSlug/create-quest` for NPC/item/scene
  quest scaffolds.
- `POST /api/projects/:slug/records/:recordSlug/ai-fill` for DeepSeek fill.
- `POST /api/projects/:slug/validate` for schema and gameplay gates.
- `POST /api/projects/:slug/export` for `agent-packs/<slug>`.
- `GET /api/projects/:slug/graph` and `POST /api/projects/:slug/graph/validate`
  for the world canvas.
- `GET/PUT /api/projects/:slug/workflows/:workflowSlug` for saved workflows.
- `POST /api/projects/:slug/workflows/:workflowSlug/run` for execution runs.
- `GET /api/projects/:slug/executions` and `/executions/:executionId` for logs.
- `GET/POST/PUT /api/projects/:slug/visuals` for visual packs.
- `POST /api/projects/:slug/visuals/:name/manifest` and `/attach` for asset
  manifest rebuilding and record attachment.

The old frontend handoff spec remains as historical design context in
`docs/web-ui/frontend-agent-specs/cartridge-forge-ui.md`; the current MVP is
implemented directly in `packages/cartridge-forge/public`.
