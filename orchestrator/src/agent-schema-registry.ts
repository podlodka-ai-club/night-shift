import type { ZodTypeAny as ZodTypeAnyV3 } from 'zod/v3';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { changeMetadataJsonSchemaSource, changeMetadataSchema } from './change-metadata';
import { implementResponseJsonSchemaSource, implementResponseSchema } from './phases/implement/response';
import { specifyResponseJsonSchemaSource, specifyResponseSchema } from './phases/specify/response';
import type { AgentSchemaId } from './shared';

type RegisteredSchema = {
  parse: (value: unknown) => unknown;
};

const schemaRegistry = {
  'change-metadata-v1': changeMetadataSchema,
  'implement-response-v1': implementResponseSchema,
  'specify-response-v1': specifyResponseSchema,
} satisfies Record<AgentSchemaId, RegisteredSchema>;

const jsonSchemaRegistry: Record<AgentSchemaId, unknown> = {
  'change-metadata-v1': zodToJsonSchema(changeMetadataJsonSchemaSource as ZodTypeAnyV3, {
    target: 'openAi',
    $refStrategy: 'none',
  }),
  'implement-response-v1': zodToJsonSchema(implementResponseJsonSchemaSource as ZodTypeAnyV3, {
    target: 'openAi',
    $refStrategy: 'none',
  }),
  'specify-response-v1': zodToJsonSchema(specifyResponseJsonSchemaSource as ZodTypeAnyV3, {
    target: 'openAi',
    $refStrategy: 'none',
  }),
};

export function getAgentSchema(schemaId: AgentSchemaId) {
  const schema = schemaRegistry[schemaId];
  const jsonSchema = jsonSchemaRegistry[schemaId];

  return {
    schema,
    jsonSchema,
  };
}