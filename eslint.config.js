import tseslint from 'typescript-eslint';

/**
 * INV-2 is enforced here, not by convention.
 *
 * services/agent/src/egress.ts is the ONLY module permitted to import a
 * transport client. A rule you can run beats a convention you can only remember.
 *
 * See AGENTS.md and docs/WICK-TECHNICAL.md §6.3.
 */
const TRANSPORT_CLIENTS = [
  '@aws-sdk/client-apigatewaymanagementapi',
  '@aws-sdk/client-iot-data-plane',
  'mqtt',
  '**/transport/WebSocketChannel*',
  '**/transport/MqttChannel*',
];

export default tseslint.config(
  // .programmes holds HLS segments, whose .ts is MPEG transport stream, not TypeScript.
  { ignores: ['**/dist/**', '**/node_modules/**', '**/cdk.out/**', '**/.build/**', '.programmes/**', 'apps/tv-fireos/android/**'] },

  // Parse TypeScript everywhere.
  ...tseslint.configs.recommended,

  // The invariant.
  {
    files: ['services/**/*.ts', 'apps/**/*.ts', 'apps/**/*.tsx'],
    ignores: [
      'services/agent/src/egress.ts',
      'apps/tv-vega/src/transport/MqttChannel.ts',
      'apps/tv-vega/src/transport/WebSocketChannel.ts',
      'apps/tv-vega/src/transport/createDeviceChannel.ts',
      '**/__tests__/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: TRANSPORT_CLIENTS,
              message:
                'INV-2: all egress goes through services/agent/src/egress.ts, the only module allowed to touch a transport client.',
            },
          ],
        },
      ],
    },
  },

  // Stubs legitimately declare unused params ahead of implementation.
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Metro and Babel load their own config as plain CommonJS by convention —
  // not part of the app's ESM/TS source.
  {
    files: [
      'apps/tv-vega/metro.config.js',
      'apps/tv-vega/babel.config.js',
      'apps/tv-fireos/metro.config.js',
      'apps/tv-fireos/babel.config.js',
      'apps/tv-fireos/adapters.config.js',
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
