/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RuntimeFieldValueMeta {
  id: number;
  field_key: string;
  value_type: string;
  allowed_values: unknown[] | null;
}

export interface RuntimeFieldValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateRuntimeFieldValue(
  field: RuntimeFieldValueMeta,
  value: unknown,
): RuntimeFieldValidationResult {
  if (!isJsonSerializable(value)) {
    return {ok: false, reason: 'value is not JSON-serializable'};
  }

  if (!matchesRuntimeValueType(field.value_type, value)) {
    return {
      ok: false,
      reason: `expected ${field.value_type}, received ${describeValue(value)}`,
    };
  }

  if (Array.isArray(field.allowed_values)) {
    const ok = field.allowed_values.some(
      av => JSON.stringify(av) === JSON.stringify(value),
    );
    if (!ok) {
      return {
        ok: false,
        reason: `value is not in allowed_values ${JSON.stringify(field.allowed_values)}`,
      };
    }
  }

  return {ok: true};
}

function matchesRuntimeValueType(valueType: string, value: unknown): boolean {
  switch (valueType) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'float':
      return typeof value === 'number' && Number.isFinite(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'enum':
      return typeof value === 'string';
    case 'entity_ref':
      return typeof value === 'number' && Number.isInteger(value) && value > 0;
    case 'json':
      return true;
    case 'dice':
      return typeof value === 'string' || isPlainObject(value);
    default:
      return false;
  }
}

function isJsonSerializable(value: unknown): boolean {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return false;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (value == null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(isJsonSerializable);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonSerializable);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
