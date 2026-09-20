import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		ignores: ['**/dist/**', '**/node_modules/**', 'frontend/src/env.d.ts'],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	...vue.configs['flat/recommended'],
	{
		files: ['**/*.{ts,vue}'],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				parser: tseslint.parser,
				ecmaVersion: 'latest',
				sourceType: 'module',
			},
		},
		rules: {
			'vue/multi-word-component-names': 'off',
		},
	},
	eslintConfigPrettier,
);
