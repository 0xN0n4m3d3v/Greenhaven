# Agent Cartridge Dataset Pipeline

This document defines the format an autonomous research agent should generate
when enriching the Grinhaven cartridge with internet-inspired locations, NPCs,
quests, scenes, events, and related world facts.

The goal is not to scrape prose into the game. The goal is to produce original,
playable Greenhaven content with traceable sources, stable slugs, explicit
relationships, and enough structure for a backend importer to compile it into
SQL migrations.

## Format Decision

Use a directory package with a JSON manifest and JSONL record files.

JSONL is the canonical content stream because it is append-friendly, easy to
diff, and each line can be validated independently. YAML can remain a human
draft format, but agent output must normalize to JSONL before import. Existing
Grinhaven YAML already proved that loose authoring is convenient but fragile:
invalid YAML, implicit references, and missing location records force the
compiler to guess.

`Cartridge Forge` is the planned first-class authoring tool for this format.
Forge is a separate Node application that lets a game master build the same
JSONL packs through forms, workflow nodes, DeepSeek-assisted fill steps, and
validation gates. External autonomous agents may still write packs directly,
but Forge is the preferred human-in-the-loop producer.

External anchors:

- JSON Lines: one UTF-8 JSON value per line.
- JSON Schema Draft 2020-12: machine validation contract.
- Frictionless Data Package: top-level package manifest pattern.
- W3C PROV: source/provenance discipline.
- RFC 9309: crawler agents must respect robots.txt.
- SPDX License List: stable license identifiers for sources.

## Package Layout

```text
agent-packs/<pack-slug>/
  manifest.json
  sources.jsonl
  records/
    locations.jsonl
    factions.jsonl
    npcs.jsonl
    quests.jsonl
    scenes.jsonl
    events.jsonl
    activities.jsonl
    dialogues.jsonl
    relationships.jsonl
    items.jsonl
  audit/
    agent-notes.md
    dedupe-candidates.jsonl
    rejected-ideas.jsonl
```

The pack is a patch, not a replacement, unless `manifest.mode` explicitly says
`new_cartridge`.

## Manifest

`manifest.json` identifies the pack and its import target:

```json
{
  "schema_version": "greenhaven.cartridge_ingest_pack.v1",
  "pack_slug": "grinhaven-tavern-guild-authority-batch-01",
  "mode": "append_patch",
  "target_cartridge_id": "grinhaven-full",
  "source_language": "en",
  "created_by": {
    "agent": "gemini-research-worker",
    "model": "gemini-2.5-pro",
    "prompt_id": "GH-DATASET-RESEARCH-v1"
  },
  "content_budget": {
    "locations": 20,
    "npcs": 50,
    "quests": 15,
    "scenes": 30
  },
  "density_goal": {
    "power_centers": ["tavern", "guild", "authority"],
    "minimum_hooks_per_location": 3
  }
}
```

Allowed `mode` values:

- `append_patch` adds or updates content in `grinhaven-full`.
- `sandbox_overlay` imports into a temporary cartridge for review.
- `new_cartridge` creates a separate cartridge from scratch.

## Source Records

Every non-original record must point to `sources.jsonl`.

```json
{"source_id":"src:web:medieval-guilds-britannica","url":"https://example.org/guilds","title":"Guilds overview","publisher":"Example","retrieved_at":"2026-05-07","license":"unknown","robots_status":"allowed","notes":"Used only for high-level social structure facts, not copied prose."}
```

Rules:

- Respect robots.txt and site terms before crawling.
- Record URL, title, publisher/author when known, retrieval date, license, and
  use note.
- Prefer public-domain, open-license, official, museum, university, or primary
  historical sources.
- Use SPDX identifiers when a source has a known license.
- Do not import copyrighted prose, quest text, NPC descriptions, or scene
  passages. Convert research into original Greenhaven fiction.
- Mark uncertain sources as `license: "unknown"` and use them only for factual
  inspiration, not adaptation.

## Record Envelope

Every line in `records/*.jsonl` must match
[`greenhaven-cartridge-ingest-record.v1`](schemas/greenhaven-cartridge-ingest-record.v1.schema.json).

Required common fields:

```json
{
  "schema_version": "greenhaven.cartridge_ingest_record.v1",
  "record_id": "ghc:loc:ale-eats-back-stairs",
  "kind": "location",
  "slug": "ale-eats-back-stairs",
  "operation": "append",
  "source_language": "en",
  "canonical_name": "Ale & Eats Back Stairs",
  "summary": "A narrow service stair used by staff, runners, and people avoiding the front room.",
  "tags": ["location", "tavern", "indoor", "service-route"],
  "payload": {},
  "links": [],
  "provenance": [
    {
      "source_id": "src:greenhaven:internal",
      "use": "original",
      "note": "Original tavern expansion for Grinhaven density."
    }
  ],
  "quality": {
    "review_status": "draft",
    "playable": true,
    "density_role": "hub_spoke",
    "risk_flags": []
  }
}
```

Use slugs and `record_id` references only. The compiler assigns database ids.

## Kind Payloads

`location` payload:

```json
{
  "location_kind": "room",
  "parent_slug": "ale-eats",
  "power_center_role": "tavern",
  "exits": ["ale-eats", "ale-eats-kitchen"],
  "narrator_brief": "Keep the stair useful: staff movement, overheard fragments, and quiet route choices.",
  "mood_axes": {"warmth": 1, "danger": 1, "intimacy": 0, "pressure": 2},
  "default_hooks": ["overhear-staff-debt", "spot-sealed-crate"]
}
```

`person` payload:

```json
{
  "species": "human",
  "pronouns": "she/her",
  "occupation": "Guild intake clerk",
  "home_slug": "guildhall-front-counter",
  "faction_slug": "adventurers-guild",
  "archetype": "intake-clerk",
  "persona": "Precise, dry, and difficult to impress; respects clean evidence.",
  "speech_style": "short procedural sentences; asks for names, dates, proofs",
  "registers": [
    {
      "register_id": "first-commission",
      "trigger": "mc-asks-for-first-guild-work",
      "sample_line": "Name, rank if any, and whether you can read a map without arguing with it."
    }
  ]
}
```

`quest` payload:

```json
{
  "quest_type": "investigation",
  "giver_slug": "guild-intake-clerk",
  "start_location_slug": "guildhall-front-counter",
  "objective": "Find why three novice contracts point to the same false milepost.",
  "prepared_entity_slugs": ["false-milepost-slip", "south-road-marker-17"],
  "stages": [
    {
      "stage_slug": "take-brief",
      "goal": "Accept the filed discrepancy and ask for the contract slips.",
      "location_slug": "guildhall-front-counter"
    },
    {
      "stage_slug": "inspect-marker",
      "goal": "Compare the contract slips with the actual south-road marker.",
      "location_slug": "south-road-marker-17"
    }
  ],
  "resolution_variants": [
    {
      "outcome_slug": "clerical-error",
      "consequence": "Guild filing improves; no hostile actor found."
    }
  ]
}
```

`scene` payload:

```json
{
  "location_slug": "ale-eats",
  "participant_slugs": ["meidri", "guild-intake-clerk"],
  "entry": true,
  "state_fields": [
    {
      "key": "crowd_pressure",
      "scope": "scene",
      "type": "enum",
      "default": "busy",
      "allowed": ["quiet", "busy", "packed"]
    }
  ],
  "model_instructions": [
    "The scene should expose at least one playable lead within two narrator turns."
  ],
  "entry_points": [
    {
      "slug": "ask-for-work",
      "description": "MC asks for something useful to do; surface available hooks."
    }
  ]
}
```

`event`, `activity`, `dialogue`, `relationship`, `item`, and `faction` use the
same envelope. Their payloads must include explicit participant/location slugs,
trigger conditions, possible state changes, and downstream links.

## Generation Workflow For Agents

1. Read `docs/ops/greenhaven-mission.md`, this file, and
   `docs/cartridge/authoring-guide.md`.
2. Pick one batch scope: tavern, guild, authority, or one named district linked
   to a power center.
3. Research supporting real-world material. Store only source metadata and brief
   factual notes; do not copy prose into cartridge content.
4. Generate source records first, then content records.
5. Ensure every new quest has prepared NPC/location/item/scene support.
6. Ensure every location has at least one exit, one mood brief, and three hooks.
7. Ensure every NPC has home, faction or social anchor, voice register, and at
   least one playable reason to talk to them.
8. Ensure every quest can survive player improvisation: refusal, shortcut,
   bargaining, wrong target, violence, intimacy request, theft, and confession.
9. Write rejected ideas into `audit/rejected-ideas.jsonl` with reasons instead
   of silently dropping them.
10. Produce a short `audit/agent-notes.md` summarizing what was added, source
    risks, unresolved references, and expected gameplay loops.

## Backend Import Pipeline

The backend importer should be built as a separate path instead of extending the
current loose Grinhaven compiler in-place.

Planned commands:

```powershell
npm --prefix packages/web-server run cartridge:agent-pack:validate -- --pack agent-packs/<slug>
npm --prefix packages/web-server run cartridge:agent-pack:preview -- --pack agent-packs/<slug>
npm --prefix packages/web-server run cartridge:agent-pack:compile -- --pack agent-packs/<slug> --write
npm --prefix packages/web-server run cartridge:grinhaven:release-check
```

Pipeline stages:

1. Schema validation: manifest, sources, and every JSONL record.
2. Source policy validation: source ids exist, license fields are present,
   robots status is recorded, and risky sources are flagged.
3. Reference validation: slugs are unique, links resolve within pack or active
   cartridge, no numeric database ids are accepted.
4. Gameplay validation: quests have stages and prepared entities; scenes have
   participants and state; locations have exits and hooks.
5. Dedupe validation: compare slugs, aliases, canonical names, and profiles
   against `grinhaven-full`.
6. Compile: allocate ids, write forward-only SQL migration, update local density
   summaries, and preserve `source_only` cartridge policy unless a translation
   pack is supplied.
7. Temp database smoke: apply migrations into PGlite, run cartridge validation,
   release check, and a targeted support smoke.
8. Live review: run a small playtest from the affected power center and record
   whether hooks surface naturally in the first turns.

## Done Criteria For Import

A pack is importable only when:

- all JSONL lines pass schema validation;
- every record has at least one provenance entry;
- no content requires copied web prose to work;
- no record uses database ids authored by the external agent;
- all cross-record links resolve;
- the density report improves at least one power center or district;
- a temporary migration applies cleanly and can be inspected before release;
- Gemini or another reviewer has produced a read-only critique of source risks,
  duplicates, and gameplay contradictions.

## Autonomous Agent Prompt Skeleton

```text
You are generating a Greenhaven cartridge ingest pack, not editing code.
Read docs/ops/greenhaven-mission.md, docs/cartridge/authoring-guide.md, and
docs/cartridge/agent-dataset-pipeline.md.

Scope: <power center or district>.
Output directory: agent-packs/<pack-slug>.
Use JSONL records matching greenhaven.cartridge_ingest_record.v1.
Do not author database ids. Use stable slugs and record_id values.
Do not copy web prose. Produce original Greenhaven content with provenance.
Every quest must include prepared NPC/location/item/scene support.
Every location must have exits, mood, and at least three playable hooks.
Every NPC must have home, faction/social anchor, voice, and a playable reason
to talk.
Write audit/agent-notes.md, audit/dedupe-candidates.jsonl, and
audit/rejected-ideas.jsonl.
Stop only after the pack is internally reference-complete.
```
