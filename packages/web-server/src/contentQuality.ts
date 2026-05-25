/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ContentQualityEntity {
  id?: number;
  kind: string;
  display_name: string;
  summary?: string | null;
  profile?: Record<string, unknown> | null;
  tags?: string[] | null;
}

export interface EntityQuality {
  demoReady: boolean;
  placeholder: boolean;
  sparse: boolean;
  reasons: string[];
}

// LANGUAGE-REGEX-OK: cartridge-quality content-routing detector. Scans cartridge-author text fields on `entities` rows (`display_name`, `summary`) for the canonical placeholder/template/stub vocabulary the Greenhaven cartridge authoring pipeline uses to mark unfinished content. Same wire-format role as the `adventureArbiter.ts` cartridge-content delivery-item lookup — these tokens are an internal cartridge vocabulary, never raw player input. The matching SQL form lives in `qualitySqlPredicate` below and backs the demo-readiness / readiness-audit filters. Carry-forward: surface a cartridge-emitted `is_quality_placeholder` (or numeric `quality_score`) column on `entities` so the detector reads a structured field instead of regex-scanning prose, retiring this heuristic.
const PLACEHOLDER_TEXT_RE =
  /\b(placeholder|template|todo|tbd|lorem|dummy|stub|wip|fill me|to be written|not implemented|undefined)\b/i;
// LANGUAGE-REGEX-OK: same cartridge-quality routing family as `PLACEHOLDER_TEXT_RE`. The literal `unnamed` is the canonical cartridge fallback display_name emitted when an entity ships without a curated label; matched against the entity's `display_name`, never against player prose. Carry-forward: structured `is_quality_placeholder` column (see header above).
const UNNAMED_RE = /\bunnamed\b/i;
// LANGUAGE-REGEX-OK: cartridge-quality tag allowlist. Matches the cartridge tag vocabulary the authoring pipeline stamps on `entities.tags` to flag unfinished rows (`placeholder` / `template` / `stub` / `wip` / `dummy` / `test`); the anchored `^…$` keeps the match per-tag, never spanning prose. Scans cartridge tag rows, not player input. Carry-forward: structured `is_quality_placeholder` column (see header above).
const TEMPLATE_TAG_RE = /^(placeholder|template|stub|wip|dummy|test)$/i;

export function classifyEntityQuality(
  entity: ContentQualityEntity,
): EntityQuality {
  const reasons: string[] = [];
  const profile = entity.profile ?? {};
  const tags = entity.tags ?? [];
  const name = cleanText(entity.display_name);
  const summary = cleanText(entity.summary);

  if (!name) reasons.push('missing_name');
  if (PLACEHOLDER_TEXT_RE.test(name)) reasons.push('placeholder_name');
  if (UNNAMED_RE.test(name)) reasons.push('unnamed_name');
  if (summary && PLACEHOLDER_TEXT_RE.test(summary)) {
    reasons.push('placeholder_summary');
  }
  if (tags.some(tag => TEMPLATE_TAG_RE.test(tag))) {
    reasons.push('placeholder_tag');
  }
  if (readText(profile['source_category']) === 'discovered-location-ref') {
    reasons.push('generated_location_ref');
  }
  if (readBool(profile['placeholder']) || readBool(profile['is_placeholder'])) {
    reasons.push('placeholder_flag');
  }
  if (readText(profile['status']) === 'placeholder') {
    reasons.push('placeholder_status');
  }

  const sparseReason = sparseReasonFor(entity.kind, summary, profile);
  if (sparseReason) reasons.push(sparseReason);

  const placeholder = reasons.some(reason =>
    reason.startsWith('placeholder') ||
    reason === 'unnamed_name',
  );
  const sparse = reasons.some(reason => reason.startsWith('sparse_'));
  return {
    placeholder,
    sparse,
    demoReady: !placeholder && !sparse,
    reasons,
  };
}

export function isDemoVisibleEntity(entity: ContentQualityEntity): boolean {
  return !classifyEntityQuality(entity).placeholder;
}

export function qualitySqlPredicate(alias = 'entities'): string {
  return `NOT (
    COALESCE(${alias}.display_name, '') ~* '(placeholder|template|todo|tbd|lorem|dummy|stub|wip|fill me|to be written|not implemented|undefined|unnamed)'
    OR COALESCE(${alias}.summary, '') ~* '(placeholder|template|todo|tbd|lorem|dummy|stub|wip|fill me|to be written|not implemented|undefined)'
    OR COALESCE(${alias}.tags, ARRAY[]::text[]) && ARRAY['placeholder','template','stub','wip','dummy','test']::text[]
    OR COALESCE(${alias}.profile->>'placeholder', '') = 'true'
    OR COALESCE(${alias}.profile->>'is_placeholder', '') = 'true'
    OR COALESCE(${alias}.profile->>'status', '') = 'placeholder'
  )`;
}

function sparseReasonFor(
  kind: string,
  summary: string,
  profile: Record<string, unknown>,
): string | null {
  if (kind === 'person') {
    if (
      summary.length < 24 &&
      !hasAnyText(profile, [
        'role',
        'archetype',
        'speech_style',
        'personality',
        'goal',
        'narrator_brief',
        'backstory',
      ])
    ) {
      return 'sparse_person';
    }
  }
  if (kind === 'location' || kind === 'district' || kind === 'scene') {
    if (
      summary.length < 32 &&
      !hasAnyText(profile, ['narrator_brief', 'description', 'mood', 'sensory'])
    ) {
      return `sparse_${kind}`;
    }
  }
  if (kind === 'quest') {
    if (
      summary.length < 24 &&
      !hasAny(profile, ['stages', 'objectives', 'steps', 'hook'])
    ) {
      return 'sparse_quest';
    }
  }
  return null;
}

function hasAnyText(
  profile: Record<string, unknown>,
  keys: string[],
): boolean {
  return keys.some(key => cleanText(profile[key]).length > 0);
}

function hasAny(profile: Record<string, unknown>, keys: string[]): boolean {
  return keys.some(key => profile[key] != null);
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readBool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
