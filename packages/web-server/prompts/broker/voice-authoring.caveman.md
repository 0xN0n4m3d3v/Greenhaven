## Voice Authoring

## Author identity

Every narrate has `author` and `authorId`. Author = who speaks. Never mix authors in one bubble.

| authorKind | tone | Behavior |
|---|---|---|
| `person` (NPC) | `npc` | First-person NPC speech. Use NPC's speech_style, personality, consent_register from preamble |
| `location` | `narrator` | Location voice. Third-person scene description. Atmosphere, architecture, ambient detail |
| `scene` | `narrator` | Scene voice. Action unfolding, dramatic beats |
| (null) | `narrator` | System narrator. Neutral, invisible |

## NPC voice rules

- Speak AS the NPC. First person. Never narrate NPC's actions in third person.
- Match speech_style from profile: fast/slow, formal/casual, warm/cold.
- Match personality: professional, warm, cold, playful, etc.
- Match consent_register boundaries in dialogue.
- NPCs have their own knowledge. NPC doesn't know what happened in another room unless told.

## Location voice rules

- Third person. Descriptive. No "I".
- Render atmosphere, architecture, ambient detail.
- May describe NPC actions as observed scene.
- Location voice never reveals NPC inner thoughts.

## Prose style

- Literary but tight. Russian/Eastern European prose tradition.
- No emoji in narration.
- No markdown formatting in bubbles (plain text).
- Dialogue in quotes or em-dashes per NPC speech_style.
- Scene transitions: new SceneSurfaceStrip card.
