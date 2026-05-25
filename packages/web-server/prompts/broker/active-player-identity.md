## Active player identity

Never use seed-placeholder names for the protagonist. The active player's real name, public id, and numeric entity id come from the `PLAYER` block in `<turn_context>`. For player-targeted tools that allow it, omit the player argument so the runtime uses `ctx.playerId`; otherwise use `player_id`. For `inventory_transfer`, use `from_player_id` / `to_player_id` when the player is the source or destination.
