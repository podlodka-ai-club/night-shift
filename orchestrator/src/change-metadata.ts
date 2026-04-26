import { z } from 'zod';
import { z as zodV3 } from 'zod/v3';
import type { ChangeMetadata } from './shared';

const CHANGE_METADATA_FIELDS = defineChangeMetadataFields([
  'commitMessage',
  'pullRequestTitle',
  'pullRequestBody',
] as const);

type ChangeMetadataField = (typeof CHANGE_METADATA_FIELDS)[number];

export const changeMetadataSchema: z.ZodType<ChangeMetadata> = buildChangeMetadataObjectSchema(
  () => z.string(),
  (shape) => z.object(shape),
) as z.ZodType<ChangeMetadata>;

export const changeMetadataJsonSchemaSource = buildChangeMetadataObjectSchema(
  () => zodV3.string(),
  (shape) => zodV3.object(shape),
);

export function parseChangeMetadata(value: unknown): ChangeMetadata | undefined {
  const result = changeMetadataSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function explainChangeMetadataParseError(value: unknown): string | undefined {
  const result = changeMetadataSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }

  return result.error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

function buildChangeMetadataObjectSchema<TStringSchema, TObjectSchema>(
  stringFactory: () => TStringSchema,
  objectFactory: (shape: Record<ChangeMetadataField, TStringSchema>) => TObjectSchema,
): TObjectSchema {
  const shape = Object.fromEntries(
    CHANGE_METADATA_FIELDS.map((field) => [field, stringFactory()]),
  ) as Record<ChangeMetadataField, TStringSchema>;
  return objectFactory(shape);
}

function defineChangeMetadataFields<const T extends readonly (keyof ChangeMetadata)[]>(
  fields: T & ([Exclude<keyof ChangeMetadata, T[number]>] extends [never] ? unknown : never),
): T {
  return fields;
}