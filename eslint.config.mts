import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores([
    'node_modules',
    'main.js',
    'coverage',
    'release',
    'prototypes/**',
    'external-themes/**',
    'packages/*/dist/**',
    'hats/**/test-vault/**',
    'hats/**/.lan-environment/**',
    'hats/**/lan-preview/**',
    'esbuild.config.mjs',
    'versions.json',
    'package-lock.json',
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.json'],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', {
        brands: [
          'Cloudflare',
          'Frontmatter',
          'Keychain',
          'macOS',
          'Markdown',
          'Mermaid',
          'Node.js',
          'OAuth',
          'Obsidian',
          'Pages',
          'Pages Publish',
          'Quartz',
          'Vault',
          'clientScripts',
        ],
        acronyms: ['API', 'CSP', 'OAuth', 'PATH', 'URL'],
        enforceCamelCaseLower: true,
      }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-globals': 'off',
      // Loopback listener tests execute under Vitest's Node environment, where
      // a small `window` timer shim is required to exercise renderer code.
      'obsidianmd/no-global-this': 'off',
    },
  },
);
