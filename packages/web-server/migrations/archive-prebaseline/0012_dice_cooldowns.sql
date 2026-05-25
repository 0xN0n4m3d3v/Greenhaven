-- 0012_dice_cooldowns.sql — 24h cooldown on non-combat ability checks.
--
-- Pattern: a player tries to seduce / persuade / shove / pick-lock
-- a specific target. Failed (or succeeded) — they wait a day before
-- they can attempt the SAME check on the SAME target again. Combat
-- rolls (attack, damage, save) are exempt: hits land instantly and
-- you can keep swinging.
--
-- The dice_check tool checks this table BEFORE rolling when args
-- include `target_id` and `category='check'`. If a row exists with
-- last_rolled_at within the cooldown window, the call returns early
-- with `cooldown=true` + `next_attempt_allowed_at`.

CREATE TABLE IF NOT EXISTS dice_check_cooldowns (
    player_id        BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    target_entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    /**
     * Free-form key the model passes — typically the social action
     * name ('seduce', 'persuade', 'intimidate') or the item check
     * ability+verb ('STR_shove', 'DEX_pick'). Lowercased + trimmed at
     * write/read time so capitalisation drift doesn't matter.
     */
    check_kind       TEXT   NOT NULL,
    last_rolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_outcome     TEXT,
    PRIMARY KEY (player_id, target_entity_id, check_kind)
);

CREATE INDEX IF NOT EXISTS idx_dice_cooldowns_player_target
    ON dice_check_cooldowns(player_id, target_entity_id);
