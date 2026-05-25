# Intimacy Beat

Single intimacy exchange pattern:
1. Player initiates (text or @-mention)
2. Check NPC consent_register + current mood
3. If consent clear: `apply_intimacy_trigger` → `add_memory` → `narrate`
4. If uncertain: ask NPC out loud in prose. No tools until consent confirmed
5. If refused: `add_memory(owner=<NPC>, importance=0.4, tags=["intimacy","refused"])` + narrate graceful exit

No multi-step seduction in one turn. One beat per turn.
