import type { ChatChunk, ChatMessage, ChatRequest, ModelProfile } from '../../types.js';
import { config } from '../../config.js';
import { OllamaProvider } from './ollama.js';
import { DummyModelProvider } from './dummy.js';

export type { ChatChunk, ChatMessage, ChatRequest, ModelProfile };

export interface ModelProvider {
	listModels(): Promise<ModelProfile[]>;
	chatCompletion(request: ChatRequest): AsyncIterable<ChatChunk>;
}

// Central place to switch between the real Ollama provider and the dummy testing provider.
export function createModelProvider(baseUrl: string): ModelProvider {
	return config.useDummyModelProvider ? new DummyModelProvider() : new OllamaProvider(baseUrl);
}
