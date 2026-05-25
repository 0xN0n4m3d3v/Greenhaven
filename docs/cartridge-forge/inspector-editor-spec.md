# Cartridge Forge Inspector Editor Spec

> Superseded direction: the operational target is now the full GM workspace in
> [gm-workspace-spec.md](gm-workspace-spec.md). This page remains as the
> lower-level storage/autosave repair note.

## Goal

The inspector must let a game-master edit the whole selected record without
reading clipped service JSON as prose. Every stored `IngestRecord` field is
visible, editable, saved back to the correct JSONL file, and round-trippable to
SQL export.

## Problems Found

- Imported `entities.summary` may contain a JSON object such as
  `primary/secondary/pending_reverse`; this is a role object, not player-facing
  summary text.
- Imported NPC records are stored in `npcs.jsonl`, but the old save path wrote
  edited persons to `persons.jsonl`, leaving duplicates.
- The UI only exposed `summary`, `tags`, and `payload`, hiding operation,
  language, provenance, quality, and links.

## Contract

- Inspector fields: kind, slug, record id, operation, source language,
  canonical name, summary, tags, payload JSON, links JSON, provenance JSON, and
  quality JSON.
- Save validates JSON fields before sending.
- Backend PUT replaces the previous record across JSONL files when kind, slug,
  or record id changes.
- Import/repair converts JSON-like service summaries on any record kind into
  readable text and keeps the source object in payload when available.

## Verification

- Unit/API: editing an imported NPC does not create a duplicate row.
- Import: role-object summaries become readable text.
- Browser smoke: edit name, summary, quality, links, save, reload, and confirm
  fields persist.
