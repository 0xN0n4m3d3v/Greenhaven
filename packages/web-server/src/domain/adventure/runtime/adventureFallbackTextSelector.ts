import {detectScripts} from '../../../agents/scriptUtil.js';
import {
  EN_FALLBACK_TEXT,
  FALLBACK_TEXT_BY_LANGUAGE,
  FALLBACK_TEXT_BY_SCRIPT,
  type AdventureFallbackTextPack,
  type AdventureFallbackTextSource,
} from './adventureFallbackText.js';

export function fallbackTextsForMaterializerInput(
  input: AdventureFallbackTextSource,
): AdventureFallbackTextPack {
  const explicitLanguage = normalizeLanguageCode(
    input.queue.contextSnapshot['language'] ??
      input.queue.contextSnapshot['uiLanguage'] ??
      input.queue.contextSnapshot['locale'],
  );
  if (explicitLanguage) {
    const explicitPack = FALLBACK_TEXT_BY_LANGUAGE[explicitLanguage];
    if (explicitPack) return explicitPack;
  }

  const sampledText = [
    input.recentNarrative,
    String(input.queue.contextSnapshot['turnTextPreview'] ?? ''),
    String(input.queue.contextSnapshot['narrativePreview'] ?? ''),
  ].join(' ');
  const detection = detectScripts(sampledText);
  return (
    FALLBACK_TEXT_BY_LANGUAGE[detection.languageHint] ??
    FALLBACK_TEXT_BY_SCRIPT[detection.dominantScript] ??
    EN_FALLBACK_TEXT
  );
}

export function normalizeLanguageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const base = raw.split(/[-_]/)[0] ?? raw;
  if (base === 'iw') return 'he';
  if (base === 'in') return 'id';
  return base.length >= 2 ? base : null;
}
