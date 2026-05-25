import {describe, expect, it} from 'vitest';
import {
  checkDisplayNameI18nStability,
  type CartridgeValidationIssue,
  type EntityRow,
} from '../../devtools/validateCartridge.js';
import {
  CARTRIDGE_I18N_AUTHORING_SCHEMA,
  packFromJson,
} from '../../devtools/cartridgeI18nAuthoring.js';

function entity(i18n: Record<string, unknown>): EntityRow {
  return {
    id: 123,
    kind: 'person',
    display_name: 'Mikka',
    summary: null,
    profile: {},
    i18n,
    cartridge_id: 'test',
    dynamic_origin: false,
  };
}

describe('canonical display_name i18n', () => {
  it('rejects translated display_name values because they are @mention keys', () => {
    const issues: CartridgeValidationIssue[] = [];
    checkDisplayNameI18nStability(
      entity({display_name: {ru: 'Микка', ja: 'Mikka'}}),
      issues,
    );

    expect(issues.map(issue => issue.code)).toEqual([
      'entity_i18n_display_name_must_remain_canonical',
    ]);
    expect(issues[0]!.path).toBe('$.i18n.display_name.ru');
  });

  it('canonicalizes display_name entries in i18n authoring packs', () => {
    const pack = packFromJson(
      JSON.stringify({
        schema: CARTRIDGE_I18N_AUTHORING_SCHEMA,
        exportedAt: '2026-05-15T00:00:00.000Z',
        languages: ['en', 'ru', 'ja'],
        summary: {entries: 1, missingValues: 0, bySource: {entity: 1}},
        entries: [
          {
            entryId: 'entity:123:display_name',
            source: 'entity',
            field: 'display_name',
            base: 'Mikka',
            translations: {en: 'Mikka', ru: 'Микка', ja: 'ミッカ'},
            missingLanguages: [],
            entityId: 123,
            entityName: 'Mikka',
            kind: 'person',
            path: '$.display_name',
          },
        ],
      }),
    );

    const entry = pack.entries[0]!;
    expect(entry.translations.ru).toBe('Mikka');
    expect(entry.translations.ja).toBe('Mikka');
    expect(entry.missingLanguages).toEqual([]);
  });
});
