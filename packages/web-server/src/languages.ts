/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export const SUPPORTED_LANGUAGE_CODES = [
  'en',
  'ru',
  'uk',
  'bg',
  'sr',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'ro',
  'he',
  'ar',
  'fa',
  'ur',
  'hi',
  'mr',
  'ne',
  'bn',
  'th',
  'el',
  'hy',
  'ka',
  'ko',
  'ja',
  'zh',
] as const;

export type SupportedLanguageCode = typeof SUPPORTED_LANGUAGE_CODES[number];

export const SUPPORTED_LANGUAGE_NAMES: Record<SupportedLanguageCode, string> = {
  ar: 'Arabic',
  bn: 'Bengali',
  bg: 'Bulgarian',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  fa: 'Persian',
  fr: 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  hy: 'Armenian',
  it: 'Italian',
  ja: 'Japanese',
  ka: 'Georgian',
  ko: 'Korean',
  mr: 'Marathi',
  ne: 'Nepali',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sr: 'Serbian',
  th: 'Thai',
  uk: 'Ukrainian',
  ur: 'Urdu',
  zh: 'Chinese',
};

export const SUPPORTED_LANGUAGE_SET = new Set<string>(SUPPORTED_LANGUAGE_CODES);
