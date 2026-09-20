export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
	role: ChatRole;
	content: string;
}

export interface ModelProfile {
	id: string;
	name: string;
	contextWindow?: number;
}

export interface ChatRequest {
	model: string;
	messages: ChatMessage[];
	temperature?: number;
	stream?: boolean;
}

export interface ChatChunk {
	id: string;
	content: string;
	done: boolean;
}
