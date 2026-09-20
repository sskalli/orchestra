import 'dotenv/config';

function required(value: string | undefined, name: string): string {
	if (!value) {
		throw new Error(`${name} is required`);
	}

	return value;
}

export const config = {
	port: Number(process.env.PORT ?? 3000),
	databaseUrl: required(process.env.DATABASE_URL, 'DATABASE_URL'),
	ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
	defaultModelProfile: process.env.DEFAULT_MODEL_PROFILE ?? 'local-coder',
	// TODO: remove once Ollama is re-wired; lets local testing skip slow/real model calls.
	useDummyModelProvider: process.env.USE_DUMMY_MODEL_PROVIDER === 'true',
};
