import {
  normalizeThemeOptions,
  ThemeContractError,
  type JsonValue,
  type ThemeOptions,
} from './theme-contract';

export interface ThemeOptionsSchema {
  type: 'object';
  properties?: Readonly<Record<string, ThemeOptionSchema>>;
  required?: readonly string[];
  additionalProperties: false;
}

export type ThemeOptionSchema =
  | ThemeStringOptionSchema
  | ThemeNumberOptionSchema
  | ThemeBooleanOptionSchema
  | ThemeArrayOptionSchema
  | ThemeObjectOptionSchema;

interface ThemeOptionBase {
  title?: string;
  description?: string;
  default?: JsonValue;
  enum?: readonly JsonValue[];
}

export interface ThemeStringOptionSchema extends ThemeOptionBase {
  type: 'string';
  minLength?: number;
  maxLength?: number;
}

export interface ThemeNumberOptionSchema extends ThemeOptionBase {
  type: 'number' | 'integer';
  minimum?: number;
  maximum?: number;
}

export interface ThemeBooleanOptionSchema extends ThemeOptionBase {
  type: 'boolean';
}

export interface ThemeArrayOptionSchema extends ThemeOptionBase {
  type: 'array';
  items: ThemeOptionSchema;
  minItems?: number;
  maxItems?: number;
}

export interface ThemeObjectOptionSchema extends ThemeOptionBase {
  type: 'object';
  properties?: Readonly<Record<string, ThemeOptionSchema>>;
  required?: readonly string[];
  additionalProperties: false;
}

const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_PROPERTIES = 128;

export function validateThemeOptionsSchema(value: unknown): ThemeOptionsSchema {
  const schema = validateObjectSchema(value, '$', 0, true);
  return schema;
}

export function validateThemeOptionsAgainstSchema(
  options: unknown,
  inputSchema: unknown,
): ThemeOptions {
  const normalized = normalizeThemeOptions(options);
  const schema = validateThemeOptionsSchema(inputSchema);
  validateValue(normalized, schema, 'site.theme.options');
  return normalized;
}

export function themeOptionsFromSchemaDefaults(
  inputSchema: unknown,
): ThemeOptions {
  const schema = validateThemeOptionsSchema(inputSchema);
  const value = defaultsForObject(schema, 'site.theme.options');
  validateValue(value, schema, 'site.theme.options');
  return value;
}

function validateSchema(
  value: unknown,
  path: string,
  depth: number,
): ThemeOptionSchema {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw schemaError('theme-schema-too-deep', path, 'Theme options schema is too deeply nested.');
  }
  const schema = record(value, path, 'Schema node must be an object.');
  const type = schema.type;
  if (type === 'object') return validateObjectSchema(schema, path, depth, false);
  if (type === 'array') return validateArraySchema(schema, path, depth);
  if (type === 'string') return validateStringSchema(schema, path);
  if (type === 'number' || type === 'integer') {
    return validateNumberSchema(schema, path, type);
  }
  if (type === 'boolean') return validateBooleanSchema(schema, path);
  throw schemaError(
    'unsupported-theme-schema-type',
    `${path}.type`,
    'Theme option type must be object, array, string, number, integer or boolean.',
  );
}

function validateObjectSchema(
  value: unknown,
  path: string,
  depth: number,
  root: boolean,
): ThemeObjectOptionSchema {
  const schema = record(value, path, 'Object schema must be an object.');
  assertKeys(
    schema,
    root
      ? ['type', 'properties', 'required', 'additionalProperties']
      : [
        'type',
        'title',
        'description',
        'default',
        'enum',
        'properties',
        'required',
        'additionalProperties',
      ],
    path,
  );
  if (schema.type !== 'object') {
    throw schemaError('invalid-theme-schema', `${path}.type`, 'Root schema type must be object.');
  }
  if (schema.additionalProperties !== false) {
    throw schemaError(
      'open-theme-options-schema',
      `${path}.additionalProperties`,
      'Object schemas must set additionalProperties to false.',
    );
  }
  const propertiesValue = schema.properties ?? {};
  const properties = record(
    propertiesValue,
    `${path}.properties`,
    'properties must be an object.',
  );
  if (Object.keys(properties).length > MAX_SCHEMA_PROPERTIES) {
    throw schemaError(
      'theme-schema-too-large',
      `${path}.properties`,
      `Theme options schema may define at most ${MAX_SCHEMA_PROPERTIES} properties per object.`,
    );
  }
  const validatedProperties: Record<string, ThemeOptionSchema> = {};
  for (const key of Object.keys(properties).sort()) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) {
      throw schemaError(
        'invalid-theme-option-name',
        `${path}.properties.${key}`,
        'Theme option names must be safe identifiers up to 64 characters.',
      );
    }
    validatedProperties[key] = validateSchema(
      properties[key],
      `${path}.properties.${key}`,
      depth + 1,
    );
  }
  const required = validateRequired(schema.required, validatedProperties, path);
  const common = validateCommon(schema, path);
  const result: ThemeObjectOptionSchema = {
    type: 'object',
    properties: validatedProperties,
    required,
    additionalProperties: false,
    ...common,
  };
  validateDefaultAndEnum(result, path);
  return result;
}

function validateArraySchema(
  schema: Record<string, unknown>,
  path: string,
  depth: number,
): ThemeArrayOptionSchema {
  assertKeys(
    schema,
    ['type', 'title', 'description', 'default', 'enum', 'items', 'minItems', 'maxItems'],
    path,
  );
  const minItems = optionalNonNegativeInteger(schema.minItems, `${path}.minItems`);
  const maxItems = optionalNonNegativeInteger(schema.maxItems, `${path}.maxItems`);
  if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
    throw schemaError('invalid-theme-schema-range', path, 'minItems cannot exceed maxItems.');
  }
  if (schema.items === undefined) {
    throw schemaError('invalid-theme-schema', `${path}.items`, 'Array schema requires items.');
  }
  const result: ThemeArrayOptionSchema = {
    type: 'array',
    items: validateSchema(schema.items, `${path}.items`, depth + 1),
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...validateCommon(schema, path),
  };
  validateDefaultAndEnum(result, path);
  return result;
}

function validateStringSchema(
  schema: Record<string, unknown>,
  path: string,
): ThemeStringOptionSchema {
  assertKeys(
    schema,
    ['type', 'title', 'description', 'default', 'enum', 'minLength', 'maxLength'],
    path,
  );
  const minLength = optionalNonNegativeInteger(schema.minLength, `${path}.minLength`);
  const maxLength = optionalNonNegativeInteger(schema.maxLength, `${path}.maxLength`);
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw schemaError('invalid-theme-schema-range', path, 'minLength cannot exceed maxLength.');
  }
  const result: ThemeStringOptionSchema = {
    type: 'string',
    ...(minLength === undefined ? {} : { minLength }),
    ...(maxLength === undefined ? {} : { maxLength }),
    ...validateCommon(schema, path),
  };
  validateDefaultAndEnum(result, path);
  return result;
}

function validateNumberSchema(
  schema: Record<string, unknown>,
  path: string,
  type: 'number' | 'integer',
): ThemeNumberOptionSchema {
  assertKeys(
    schema,
    ['type', 'title', 'description', 'default', 'enum', 'minimum', 'maximum'],
    path,
  );
  const minimum = optionalFiniteNumber(schema.minimum, `${path}.minimum`);
  const maximum = optionalFiniteNumber(schema.maximum, `${path}.maximum`);
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    throw schemaError('invalid-theme-schema-range', path, 'minimum cannot exceed maximum.');
  }
  const result: ThemeNumberOptionSchema = {
    type,
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
    ...validateCommon(schema, path),
  };
  validateDefaultAndEnum(result, path);
  return result;
}

function validateBooleanSchema(
  schema: Record<string, unknown>,
  path: string,
): ThemeBooleanOptionSchema {
  assertKeys(schema, ['type', 'title', 'description', 'default', 'enum'], path);
  const result: ThemeBooleanOptionSchema = {
    type: 'boolean',
    ...validateCommon(schema, path),
  };
  validateDefaultAndEnum(result, path);
  return result;
}

function validateCommon(
  schema: Record<string, unknown>,
  path: string,
): Pick<ThemeOptionBase, 'title' | 'description' | 'default' | 'enum'> {
  const title = optionalString(schema.title, `${path}.title`);
  const description = optionalString(schema.description, `${path}.description`);
  const defaultValue = schema.default === undefined
    ? undefined
    : normalizeJson(schema.default, `${path}.default`);
  let enumValues: JsonValue[] | undefined;
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw schemaError('invalid-theme-schema-enum', `${path}.enum`, 'enum must be a non-empty list.');
    }
    enumValues = schema.enum.map((item, index) =>
      normalizeJson(item, `${path}.enum[${index}]`));
    if (new Set(enumValues.map(stableJson)).size !== enumValues.length) {
      throw schemaError('invalid-theme-schema-enum', `${path}.enum`, 'enum values must be unique.');
    }
  }
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    ...(enumValues === undefined ? {} : { enum: enumValues }),
  };
}

function validateRequired(
  value: unknown,
  properties: Record<string, ThemeOptionSchema>,
  path: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw schemaError('invalid-theme-schema', `${path}.required`, 'required must be a list.');
  }
  const required: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = requiredString(value[index], `${path}.required[${index}]`);
    if (!(key in properties)) {
      throw schemaError(
        'invalid-theme-schema',
        `${path}.required[${index}]`,
        `Required option ${key} is not declared in properties.`,
      );
    }
    if (required.includes(key)) {
      throw schemaError('invalid-theme-schema', `${path}.required[${index}]`, 'required entries must be unique.');
    }
    required.push(key);
  }
  return required;
}

function validateDefaultAndEnum(schema: ThemeOptionSchema, path: string): void {
  if (schema.default !== undefined) validateValue(schema.default, schema, `${path}.default`);
  if (schema.enum !== undefined) {
    for (let index = 0; index < schema.enum.length; index += 1) {
      const enumValue = schema.enum[index];
      if (enumValue === undefined) continue;
      validateValue(enumValue, { ...schema, enum: undefined }, `${path}.enum[${index}]`);
    }
    const defaultValue = schema.default;
    if (
      defaultValue !== undefined &&
      !schema.enum.some((value) => stableJson(value) === stableJson(defaultValue))
    ) {
      throw schemaError('invalid-theme-schema-default', `${path}.default`, 'default must be one of enum.');
    }
  }
}

function validateValue(value: JsonValue, schema: ThemeOptionSchema, path: string): void {
  if (schema.enum !== undefined && !schema.enum.some((item) => stableJson(item) === stableJson(value))) {
    throw schemaError('invalid-theme-option', path, 'Value is not one of the allowed enum values.');
  }
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') throw valueType(path, 'string');
      if (schema.minLength !== undefined && Array.from(value).length < schema.minLength) {
        throw schemaError('invalid-theme-option', path, `String must contain at least ${schema.minLength} characters.`);
      }
      if (schema.maxLength !== undefined && Array.from(value).length > schema.maxLength) {
        throw schemaError('invalid-theme-option', path, `String must contain at most ${schema.maxLength} characters.`);
      }
      return;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw valueType(path, schema.type);
      if (schema.type === 'integer' && !Number.isInteger(value)) throw valueType(path, 'integer');
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw schemaError('invalid-theme-option', path, `Number must be at least ${schema.minimum}.`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw schemaError('invalid-theme-option', path, `Number must be at most ${schema.maximum}.`);
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw valueType(path, 'boolean');
      return;
    case 'array':
      if (!Array.isArray(value)) throw valueType(path, 'array');
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        throw schemaError('invalid-theme-option', path, `List must contain at least ${schema.minItems} items.`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        throw schemaError('invalid-theme-option', path, `List must contain at most ${schema.maxItems} items.`);
      }
      value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`));
      return;
    case 'object': {
      if (!isRecord(value)) throw valueType(path, 'object');
      const properties = schema.properties ?? {};
      for (const key of Object.keys(value)) {
        const propertySchema = properties[key];
        if (propertySchema === undefined) {
          throw schemaError('unknown-theme-option', `${path}.${key}`, `Unknown theme option: ${key}.`);
        }
        validateValue(value[key] as JsonValue, propertySchema, `${path}.${key}`);
      }
      for (const key of schema.required ?? []) {
        if (!(key in value)) {
          throw schemaError('missing-theme-option', `${path}.${key}`, `Required theme option is missing: ${key}.`);
        }
      }
      return;
    }
  }
}

function defaultsForObject(
  schema: ThemeObjectOptionSchema,
  path: string,
): ThemeOptions {
  const result: Record<string, JsonValue> = {};
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (property.default !== undefined) {
      result[key] = structuredClone(property.default);
      continue;
    }
    if (property.type === 'object') {
      const nested = defaultsForObject(property, `${path}.${key}`);
      if (Object.keys(nested).length > 0 || schema.required?.includes(key)) {
        result[key] = { ...nested };
      }
      continue;
    }
    if (schema.required?.includes(key)) {
      throw schemaError(
        'missing-theme-option-default',
        `${path}.${key}`,
        `Required theme option must declare a default for installation smoke: ${key}.`,
      );
    }
  }
  return Object.freeze(result);
}

function normalizeJson(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => normalizeJson(item, `${path}[${index}]`));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeJson(value[key], `${path}.${key}`)]),
    );
  }
  throw schemaError('invalid-theme-schema-json', path, 'Schema values must be JSON-compatible.');
}

function record(value: unknown, path: string, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw schemaError('invalid-theme-schema', path, message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertKeys(value: Record<string, unknown>, known: readonly string[], path: string): void {
  const allowed = new Set(known);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw schemaError('unknown-theme-schema-keyword', `${path}.${unknown}`, `Unsupported schema keyword: ${unknown}.`);
  }
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, path);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw schemaError('invalid-theme-schema', path, 'Expected a non-empty string.');
  }
  return value.trim();
}

function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw schemaError('invalid-theme-schema', path, 'Expected a non-negative integer.');
  }
  return value as number;
}

function optionalFiniteNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw schemaError('invalid-theme-schema', path, 'Expected a finite number.');
  }
  return value;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key] as JsonValue)}`).join(',')}}`;
}

function valueType(path: string, type: string): ThemeContractError {
  return schemaError('invalid-theme-option', path, `Expected ${type}.`);
}

function schemaError(code: string, path: string, message: string): ThemeContractError {
  return new ThemeContractError(code, path, message);
}
