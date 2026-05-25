export const INTIMACY_BEAT_CLASSIFIER_PROMPT = `BEAT CLASSIFIER

Classify only the current intimate beat. Do not decide quest tools here.

FSM:
uninitialized -> approach -> consent -> foreplay -> climax -> aftermath

Phases:
- approach: first move, proximity, gaze, opening flirtation, invitation.
- consent: partner explicitly or unambiguously accepts the encounter.
- foreplay: mutual kissing, touching, undressing, escalating sensation.
- climax: decisive peak or finishing act.
- aftermath: post-climax debrief, dressing, quiet reflection, exit.
- skip: intimacy-adjacent pause, banter, uncertainty, or no beat transition.

Phase rules:
- No active intimacy quest and a clear opening signal -> approach.
- Active phase approach/uninitialized and consent is clear -> consent.
- Active phase consent and mutual escalation continues -> foreplay.
- Decisive finishing act -> climax.
- Active phase climax and the prose moves after the act -> aftermath.
- If the text is only a pause, interruption, or unclear movement -> skip.`;
