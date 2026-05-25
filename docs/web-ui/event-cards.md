# EventCard variant catalog

The full taxonomy of system events that get rendered as a card in chat flow. Source: [packages/web-ui/src/components/chat/EventCard.tsx](../../packages/web-ui/src/components/chat/EventCard.tsx). The `SystemEventType` union at [packages/web-ui/src/components/chat/EventCard.tsx:39-70](../../packages/web-ui/src/components/chat/EventCard.tsx#L39-L70) is canonical.

Convention: bracketed header in small caps with a glyph, accent name in mono, deltas color-coded (gold = XP/quest, blue = memory, purple = strings/charm, red = damage, teal = inspiration). Header text must come from the localization layer; card structure stays one component, `switch (type)`.

For the bus flow (server SSE -> bridge -> `system:event` -> EventCard) see [sse-flow.md](sse-flow.md). Spec 81 routes chat-visible cards through `gui_events`; the bridge accepts both the legacy SSE type and normalized `gui:event`, dedupes by `eventId`, and replays released envelopes from `/api/session/:id/events`.

### memory:added

Header: "запомнил{a}" / "Memory recorded". Glyph `Brain`. Body: NPC portrait + first-person memo + `salience` badge. Color: blue.

### memory:enriched

Header: "задумался" / "Memory enriched". Glyph `Brain`. Body: NPC portrait + before/after salience delta. Used by spec 43 NPC Voice Engine cross-reference and spec 34 salience bumps. Color: blue.

### quest:created

Header: "Получен квест" / "Quest started". Glyph `ScrollText`. Body: quest title + 1-line summary + source badge (cartridge / broker / dynamic). Color: gold.

### quest:advanced

Header: "Прогресс по квесту" / "Quest advanced". Glyph `Compass`. Body: title + `from_stage → to_stage` + reason. Color: gold.

### quest:completed

Header: "Квест завершён" / "Quest completed". Glyph `CheckCircle2`. Body: title + outcome (`completed | failed | abandoned`) + reward summary. Color: gold (success) / red (fail) / muted (abandoned).

### quest:auto_advanced

Header: "Квест обновлён" / "Quest auto-updated". Glyph `TrendingUp`. Body: quest id/title fallback + watcher result (`advanced | completed`), optional stage, and reason. Color: gold. Emitted by Quest Watcher through the GUI outbox with `phase:'post_turn'`.

### string:changed

Header: "Связь изменилась" / "Bond shifted". Glyph `Heart`. Body: NPC name + delta (+1 / -2 etc.) + new threshold band (`cold | wary | warm | bonded | locked`). Color: purple.

### damage:dealt

Header: "Урон нанесён" / "Damage dealt". Glyph `Sword`. Body: target + amount + type + `defeated` flag. Color: red.

### xp:awarded

Header: "Получен опыт" / "XP gained". Glyph `Star`. Body: `+N XP` + reason. Color: gold.

### inspiration:gained

Header: "Получено вдохновение" / "Inspiration gained". Glyph `Sparkles`. Body: reason. Color: teal.

### mode:changed

Header: "Режим изменён" / "Mode shifted". Glyph mode-dependent (`Sword` for combat, `Heart` for intimacy, `MessageSquare` for dialogue, `Footprints` for travel, `Moon` for rest, `Eye` for exploration). Body: prev → new. Color: mode-tinted.

### dialogue:engaged

Header: "Диалог" / "Dialogue engaged". Glyph `MessageSquare`. Body: NPC display_name. Dedupe — same partner re-engaged is silent. Color: muted.

### dice:rolled

Header: "Бросок" / "Dice roll". Glyph `Dice5`. Body: roll value + modifier + DC + outcome (`success | failure`) + label. Position/effect chips when present. Color: outcome-tinted (green / red).

### sex_move:fired

Header: "Особый эффект" / "Sex move triggered". Glyph `Flame`. Body: NPC name + move name + brief effect summary. Color: rose.

### entity:revealed

Header: "Открыто" / "Discovered". Glyph `Eye`. Body: kind + display_name. Color: gold.

### entity:duplicate_warning

Header: "Похоже на дубликат" / "Possible duplicate". Glyph `AlertTriangle`. Body: new entity + best match + score + verdict (merge / rename / keep_both). Color: amber. Triggers a "Use existing" affordance if score ≥ 0.9.

### movement:teleport_detected

Header: "Замечен телепорт" / "Teleport detected". Glyph `AlertTriangle`. Body: flagged location + drift summary. Color: amber. Advisory — Movement Warden post-turn observer.

### companion:added

Header: "Спутник" / "Companion joined". Glyph `Users`. Body: NPC + reason. Color: muted.

### companion:removed

Header: "Спутник ушёл" / "Companion left". Glyph `Users`. Body: NPC + reason. Color: muted.

### companion:auto_departed

Header: "Спутник покинул отряд" / "Companion auto-departed". Glyph `Users`. Body: NPC + predicate + why. Color: amber. Distinct from `companion:removed` so the player can see this was triggered by `profile.depart_when`.

### npc:moved_with_player

Header: "NPC последовал" / "NPC followed". Glyph `Footprints`. Body: NPC + from → to. Color: muted.

### quest_pacer:overload

Header: "Перегруз квестами" / "Quest overload". Glyph `Flag`. Body: count + threshold + recent quests. Color: amber.

### quest_pacer:stale

Header: "Квест замер" / "Quest stale". Glyph `Flag`. Body: title + `ageTurns` + suggestion. Color: amber.

### quest_pacer:dead_npc_arc

Header: "Дуга мёртва" / "Dead arc". Glyph `Flag`. Body: title + giver-NPC name + last-seen. Color: amber.

### adventure:oracle_rolled

Header: localized adventure roll label. Glyph `Dice5`. Body: selected
adventure kind plus deterministic oracle roll details when present. Color:
adventure green.

### adventure:hook

Header: localized opportunity label. Glyph `Compass`. Body: title, literary
player-facing hook, danger tag, optional reward hint, and accept/ignore menu.
When MessageFlow provides turn context, the buttons submit normal turn actions
with `adventure.accept:<queueId>` / `adventure.ignore:<queueId>` so the
NPC/world can answer immediately. The player adventure routes remain fallback
paths for non-chat surfaces. Color: adventure green.

### adventure:accepted

Header: localized accepted label. Glyph `CheckCircle2`. Body: title, success
state, danger tag. The quest/entity cards produced by accepted tools remain
separate ordered EventCards. Color: adventure green.

### adventure:ignored / adventure:expired

Header: localized status label. Glyph `AlertTriangle`. Body: title plus quiet
status. `adventure:ignored` is emitted only for a hook that had already been
visible; ignoring an unseen row cancels it silently. Chat-turn ignore also
records baseline refusal evidence/consequence before the continuation response.

### narrate:quarantined

Header: localization key resolved by `EventCard`. Glyph `AlertTriangle`. Body: concise support status with `reason`, optional `author`, and `turnId`. The card intentionally does not render the quarantined raw text; it tells the player/operator that unsafe or technical narration was withheld instead of silently leaving the turn blank. Color: neutral.

### post_turn:slot_failed

Header: localization key resolved by `EventCard`. Glyph `AlertTriangle`. Body: hook name, slot status, and reason. Emitted by the Spec 86 post-turn slot registry when a chat-visible post-turn hook throws or misses its deadline, so the player sees a compact diagnostic before the next visible turn is released. Color: neutral.

## Sources

- [packages/web-ui/src/components/chat/EventCard.tsx](../../packages/web-ui/src/components/chat/EventCard.tsx) — `SystemEventType`, header lookups, glyph/colour mapping, per-type render switch
