import tseslint from 'typescript-eslint';
import calm from './packages/vega-calm-ui/eslint/index.js';

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
  // Web Push: a request to a family member's browser, by way of its push service.
  'web-push',
  // Amazon Translate. Not a way to a screen, but held to the same rule on
  // purpose: free text is put into the household's language on its way to
  // the resident's television and nowhere else (packages/contracts
  // language.ts), so the one module that sends there is the one module that
  // may hold a translator. Nothing bound for the family can be translated,
  // because nothing else can reach the client.
  '@aws-sdk/client-translate',
  // The S3 presigner: what makes a short-lived address to one of the family's
  // pictures (packages/contracts mantel.ts). Held to the same rule for the
  // same reason — an address is minted for the resident's television on the
  // way out, and nothing else in the agent plane or the Wick server can make
  // one. (The edge mints its own, by hand, for the television it is
  // answering: services/edge-device/lambda/presign.mjs.)
  '@aws-sdk/s3-request-presigner',
  '**/transport/WebSocketChannel*',
  '**/transport/MqttChannel*',
];

export default tseslint.config(
  // .programmes holds HLS segments, whose .ts is MPEG transport stream, not TypeScript.
  // .worktrees/ and .claude/worktrees/ hold other branches checked out side by side (.gitignore).
  { ignores: ['**/dist/**', '**/node_modules/**', '**/cdk.out/**', '**/.build/**', '.programmes/**', 'apps/tv-fireos/android/**', '.worktrees/**', '.claude/worktrees/**'] },

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

  // The calm floor on everything the resident's television draws: no type
  // under 32, no red, no fourth button, no card that dismisses itself
  // (AGENTS.md, product rules). The same rules vega-calm-ui publishes.
  {
    ...calm.configs.recommended,
    files: ['apps/tv-vega/src/**/*.ts', 'apps/tv-vega/src/**/*.tsx', 'packages/vega-calm-ui/src/**/*.ts', 'packages/vega-calm-ui/src/**/*.tsx'],
    ignores: ['**/__tests__/**'],
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
