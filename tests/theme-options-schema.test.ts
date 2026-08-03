import { describe, expect, it } from 'vitest';
import {
  themeOptionsFromSchemaDefaults,
  validateThemeOptionsAgainstSchema,
  validateThemeOptionsSchema,
} from '../src/theme/theme-options-schema';

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    accent: {
      type: 'string',
      enum: ['orange', 'yellow', 'pink'],
      default: 'orange',
    },
    borderWidth: {
      type: 'integer',
      minimum: 2,
      maximum: 8,
    },
    publicCount: { type: 'boolean' },
    labels: {
      type: 'array',
      items: { type: 'string', maxLength: 20 },
      maxItems: 4,
    },
    graph: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['compact', 'expanded'] },
      },
      required: ['mode'],
    },
  },
  required: ['accent', 'graph'],
};

describe('theme options schema', () => {
  it('accepts the bounded JSON Schema subset used by theme settings UI', () => {
    expect(validateThemeOptionsSchema(schema)).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['accent', 'graph'],
    });
  });

  it('validates and normalizes configured options', () => {
    expect(validateThemeOptionsAgainstSchema({
      graph: { mode: 'compact' },
      accent: 'orange',
      borderWidth: 4,
      labels: ['PUBLIC', 'INDEX'],
      publicCount: true,
    }, schema)).toEqual({
      accent: 'orange',
      borderWidth: 4,
      graph: { mode: 'compact' },
      labels: ['PUBLIC', 'INDEX'],
      publicCount: true,
    });
  });

  it('derives a complete deterministic smoke configuration from defaults', () => {
    expect(themeOptionsFromSchemaDefaults({
      type: 'object',
      additionalProperties: false,
      properties: {
        accent: { type: 'string', default: 'orange' },
        graph: {
          type: 'object',
          additionalProperties: false,
          properties: { mode: { type: 'string', default: 'compact' } },
          required: ['mode'],
        },
      },
      required: ['accent', 'graph'],
    })).toEqual({ accent: 'orange', graph: { mode: 'compact' } });
  });

  it('requires every non-object required smoke option to declare a default', () => {
    expect(() => themeOptionsFromSchemaDefaults({
      type: 'object',
      additionalProperties: false,
      properties: { accent: { type: 'string' } },
      required: ['accent'],
    })).toThrow(/must declare a default/);
  });

  it.each([
    [{ accent: 'blue', graph: { mode: 'compact' } }, 'allowed enum'],
    [{ accent: 'orange' }, 'Required theme option is missing: graph'],
    [{ accent: 'orange', graph: { mode: 'compact' }, radius: 8 }, 'Unknown theme option: radius'],
    [{ accent: 'orange', graph: { mode: 'wide' } }, 'allowed enum'],
    [{ accent: 'orange', graph: { mode: 'compact' }, borderWidth: 3.5 }, 'Expected integer'],
  ])('rejects invalid configured options %#', (options, message) => {
    expect(() => validateThemeOptionsAgainstSchema(options, schema)).toThrow(message);
  });

  it('rejects open, remote or unsupported schema behaviour', () => {
    expect(() => validateThemeOptionsSchema({
      type: 'object',
      additionalProperties: true,
    })).toThrow(/additionalProperties to false/);
    expect(() => validateThemeOptionsSchema({
      type: 'object',
      additionalProperties: false,
      $ref: 'https://example.com/schema.json',
    })).toThrow(/Unsupported schema keyword: \$ref/);
    expect(() => validateThemeOptionsSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        accent: { type: 'string', pattern: '.*' },
      },
    })).toThrow(/Unsupported schema keyword: pattern/);
  });

  it('rejects schema defaults that violate their own constraints', () => {
    expect(() => validateThemeOptionsSchema({
      type: 'object',
      additionalProperties: false,
      properties: {
        borderWidth: { type: 'integer', minimum: 2, default: 1 },
      },
    })).toThrow(/at least 2/);
  });
});
