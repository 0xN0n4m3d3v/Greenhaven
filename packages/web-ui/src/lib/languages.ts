export interface SupportedLanguage {
  code: string;
  name: string;
  native: string;
  flag: string;
}

export const SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  {code: 'en', name: 'English', native: 'English', flag: '🇺🇸'},
  {code: 'ru', name: 'Russian', native: 'Русский', flag: '🇷🇺'},
  {code: 'uk', name: 'Ukrainian', native: 'Українська', flag: '🇺🇦'},
  {code: 'bg', name: 'Bulgarian', native: 'Български', flag: '🇧🇬'},
  {code: 'sr', name: 'Serbian', native: 'Српски', flag: '🇷🇸'},
  {code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸'},
  {code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷'},
  {code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪'},
  {code: 'it', name: 'Italian', native: 'Italiano', flag: '🇮🇹'},
  {code: 'pt', name: 'Portuguese', native: 'Português', flag: '🇵🇹'},
  {code: 'ro', name: 'Romanian', native: 'Română', flag: '🇷🇴'},
  {code: 'he', name: 'Hebrew', native: 'עברית', flag: '🇮🇱'},
  {code: 'ar', name: 'Arabic', native: 'العربية', flag: '🇸🇦'},
  {code: 'fa', name: 'Persian', native: 'فارسی', flag: '🇮🇷'},
  {code: 'ur', name: 'Urdu', native: 'اردو', flag: '🇵🇰'},
  {code: 'hi', name: 'Hindi', native: 'हिन्दी', flag: '🇮🇳'},
  {code: 'mr', name: 'Marathi', native: 'मराठी', flag: '🇮🇳'},
  {code: 'ne', name: 'Nepali', native: 'नेपाली', flag: '🇳🇵'},
  {code: 'bn', name: 'Bengali', native: 'বাংলা', flag: '🇧🇩'},
  {code: 'th', name: 'Thai', native: 'ไทย', flag: '🇹🇭'},
  {code: 'el', name: 'Greek', native: 'Ελληνικά', flag: '🇬🇷'},
  {code: 'hy', name: 'Armenian', native: 'Հայերեն', flag: '🇦🇲'},
  {code: 'ka', name: 'Georgian', native: 'ქართული', flag: '🇬🇪'},
  {code: 'ko', name: 'Korean', native: '한국어', flag: '🇰🇷'},
  {code: 'ja', name: 'Japanese', native: '日本語', flag: '🇯🇵'},
  {code: 'zh', name: 'Chinese', native: '中文', flag: '🇨🇳'},
];

export const SUPPORTED_LANGUAGE_CODES = new Set(
  SUPPORTED_LANGUAGES.map(language => language.code),
);

export function normalizeSupportedLanguageCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const base = raw.split(/[-_]/)[0] ?? raw;
  return SUPPORTED_LANGUAGE_CODES.has(base) ? base : null;
}
