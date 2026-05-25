/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export function stripEntityProfileAliases(
  profile: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!profile) return {};
  const next = {...profile};
  delete next.aliases;
  return next;
}

