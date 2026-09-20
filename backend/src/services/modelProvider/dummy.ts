import { randomUUID } from 'node:crypto';
import type { ChatChunk, ChatRequest, ModelProfile } from './index.js';
import type { ModelProvider } from './index.js';

// Testing-only stand-in for OllamaProvider: responds instantly with a fresh UUID instead of calling a real model.
export class DummyModelProvider implements ModelProvider {
	async listModels(): Promise<ModelProfile[]> {
		return [{ id: 'dummy', name: 'Dummy model' }];
	}

	async *chatCompletion(request: ChatRequest): AsyncIterable<ChatChunk> {
		yield { id: request.model, content: randomUUID(), done: true };
	}
}
