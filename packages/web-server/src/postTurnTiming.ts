/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Visible post-turn work is ordered by durable gui_events slots. These
// watchdogs are technical dead-man switches, not gameplay deadlines.
export const POST_TURN_SPECIALIST_WATCHDOG_MS = 90_000;
export const POST_TURN_SLOT_WATCHDOG_MS = 120_000;

