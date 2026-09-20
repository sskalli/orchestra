import type { ChatChunk, ChatRequest, ModelProfile } from './index.js';
import type { ModelProvider } from './index.js';

export class OllamaProvider implements ModelProvider {
	constructor(private readonly baseUrl: string) {}

	async listModels(): Promise<ModelProfile[]> {
		return [];
	}

	async *chatCompletion(request: ChatRequest): AsyncIterable<ChatChunk> {
		const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...request, stream: true }),
		});

		if (!response.ok || !response.body) {
			throw new Error(`Model provider request failed: ${response.status} ${response.statusText}`);
		}

		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = '';
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) {
					break;
				}
				// A network chunk can end halfway through an SSE line, so retain the incomplete tail.
				buffer += value;
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					if (!line.startsWith('data:')) {
						continue;
					}
					const payload = line.slice(5).trim();
					if (payload === '[DONE]') {
						yield { id: request.model, content: '', done: true };
						return;
					}
					// Convert each provider delta into the app's provider-neutral chunk shape.
					const data = JSON.parse(payload) as {
						id?: string;
						choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
					};
					const choice = data.choices?.[0];
					yield {
						id: data.id ?? request.model,
						content: choice?.delta?.content ?? '',
						done: Boolean(choice?.finish_reason),
					};
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}
