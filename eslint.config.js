const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'test-results/**', 'js/company-logo-manifest.js']
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        ...globals.node,
        STOCKS_DATA: 'readonly',
        MARKET_STATS: 'readonly',
        LOGO_ALIASES: 'readonly',
        CompanyLogo: 'readonly',
        COMPANY_LOGO_MANIFEST: 'readonly',
        updateSyncIndicator: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': 'off',
      'no-empty': 'off'
    }
  }
];
