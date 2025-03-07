const js = require('@eslint/js');
const jsdoc = require('eslint-plugin-jsdoc');
const eslintPluginPrettier = require('eslint-plugin-prettier');

module.exports = [
    {
        ignores: ['eslint.config.js'],
    },
    {
        languageOptions: {
            ecmaVersion: 2021,
            sourceType: 'commonjs',
            globals: {
                define: 'readonly',
                log: 'readonly',
                Promise: 'readonly',
            },
        },
    },
    js.configs.recommended,
    {
        rules: {
            'no-unused-vars': [
                'error',
                // We check that all parameters are used to validate when a RequireJS module is no longer used in a file.
                {
                    args: 'all',
                    // Ignore variables with the exact string of "_". This pattern ignored so that we can deliberately
                    // skip parameters if we don't need them.
                    argsIgnorePattern: '^_$',
                },
            ],
            'array-callback-return': 'error',
            'no-self-compare': 'error',
            'no-template-curly-in-string': 'error',
            curly: ['error', 'all'],
            'default-case': 'error',
            'dot-notation': 'error',
            eqeqeq: 'error',
            'no-else-return': 'error',
            'no-var': 'error',
            'prefer-const': 'error',
            'prefer-template': 'error',
            radix: 'error',
            'no-useless-computed-key': 'error',
            'no-constant-condition': 'error',
            'spaced-comment': [
                'error',
                'always',
                {
                    exceptions: [
                        // Allow lines to start with a second *, which
                        // basically allows jsdoc to work.
                        '*',
                    ],
                },
            ],
        },
    },
    {
        plugins: {jsdoc},
        rules: {
            'jsdoc/require-asterisk-prefix': 'error',
            'jsdoc/check-alignment': 'error',
            'jsdoc/check-types': 'error',
            'jsdoc/require-description': 'error',
            'jsdoc/require-param': 'error',
            'jsdoc/require-param-name': 'error',
            'jsdoc/require-param-type': 'error',
            'jsdoc/require-returns': 'error',
        },
    },
    {
        plugins: {prettier: eslintPluginPrettier},
        rules: {
            'prettier/prettier': [
                'error',
                {
                    singleQuote: true,
                    tabWidth: 2,
                    printWidth: 80,
                    useTabs: false,
                    trailingComma: 'es5',
                    bracketSpacing: false,
                    arrowParens: 'avoid',
                },
            ],
        },
    },
];
