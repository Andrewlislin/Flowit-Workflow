export const FLOWIT_STUDIO_MANIFEST_FILENAME = 'flowit.package.json'

/**
 * JSON Schema for the public Flowit Studio Package v1 manifest.
 *
 * Keep this schema declarative: Marketplace/third-party packages must not gain
 * arbitrary install hooks, runtime download URLs, or executable bootstrap code.
 */
export const FLOWIT_STUDIO_MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://flowit.dev/schemas/studio-package-v1.json',
  title: 'Flowit Studio Package v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'displayName',
    'publisher',
    'version',
    'runtime',
    'supportedHosts',
    'entryPreset',
    'license',
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9.-]*[a-z0-9]$',
      minLength: 3,
    },
    displayName: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    publisher: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9.-]*[a-z0-9]$', minLength: 2 },
        displayName: { type: 'string', minLength: 1 },
        homepage: { type: 'string', format: 'uri' },
      },
    },
    version: {
      type: 'string',
      pattern: '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$',
    },
    runtime: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'bootstrap'],
      properties: {
        id: { const: 'flowit-workflow' },
        version: { type: 'string', minLength: 1 },
        bootstrap: { const: 'official' },
      },
    },
    supportedHosts: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string', minLength: 1 },
    },
    entryPreset: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
    license: {
      type: 'object',
      additionalProperties: false,
      required: ['type'],
      properties: {
        type: {
          enum: [
            'open-source',
            'freeware',
            'commercial-perpetual',
            'commercial-team',
            'commercial-enterprise',
          ],
        },
        licenseId: { type: 'string', minLength: 1 },
        notice: { type: 'string' },
      },
    },
    permissions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description', 'risk', 'reason'],
        properties: {
          id: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          risk: { enum: ['standard', 'elevated'] },
          reason: { type: 'string', minLength: 1 },
        },
      },
    },
    metadata: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
} as const
