import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { createWebSocketClient, type SocketEvent } from '../lib/websocketClient';

export interface Conversation {
	id: string;
	title: string | null;
	defaultModelProfile: string | null;
}

export interface Message {
	id: string;
	role: string;
	content: string;
	createdAt: string;
}

export const useMainChatStore = defineStore('mainChat', () => {
	const conversations = ref<Conversation[]>([]);
	const currentConversation = ref<Conversation | null>(null);
	const messages = ref<Message[]>([]);
	const loadingByConversation = ref<Record<string, boolean>>({});
	const error = ref('');
	const socket = createWebSocketClient();
	const subscriptionHandlers = new Map<string, (event: SocketEvent) => void>();
	let activeConversationChannel: string | null = null;

	const hasCurrentConversation = computed(() => currentConversation.value !== null);

	const syncConversationSubscription = (conversationId: string | null) => {
		if (!conversationId) {
			if (activeConversationChannel) {
				const handler = subscriptionHandlers.get(activeConversationChannel);
				if (handler) {
					socket.unsubscribe(activeConversationChannel, handler);
					subscriptionHandlers.delete(activeConversationChannel);
				}
				activeConversationChannel = null;
			}
			return;
		}

		const channel = `conversation:${conversationId}:messages`;

		if (activeConversationChannel === channel) {
			return;
		}

		if (activeConversationChannel) {
			const previousHandler = subscriptionHandlers.get(activeConversationChannel);
			if (previousHandler) {
				socket.unsubscribe(activeConversationChannel, previousHandler);
			}
			subscriptionHandlers.delete(activeConversationChannel);
		}

		const handler = (event: SocketEvent) => {
			const incomingMessage = event.data;
			if (!incomingMessage || typeof incomingMessage !== 'object' || !('id' in incomingMessage)) {
				return;
			}

			if (event.targetId !== conversationId) {
				return;
			}

			const incoming = incomingMessage as Message;
			const exists = messages.value.some((message) => message.id === incoming.id);
			if (!exists) {
				messages.value.push(incoming);
			}
		};

		subscriptionHandlers.set(channel, handler);
		socket.subscribe(channel, handler);
		activeConversationChannel = channel;
	};

	// Load the list and select the first conversation for a usable initial chat view.
	async function fetchConversations() {
		conversations.value = await fetch('/api/v1/conversations').then((response) => response.json());

		if (!currentConversation.value && conversations.value[0]) {
			await fetchMessages(conversations.value[0]);
		}
	}

	// Create the conversation and immediately make it the active chat.
	async function createConversation(title = 'New conversation') {
		const conversation = (await fetch('/api/v1/conversations', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title }),
		}).then((response) => response.json())) as Conversation;

		conversations.value.unshift(conversation);

		await fetchMessages(conversation);
	}

	// Changing conversations also refreshes the messages shown by the chat panel.
	async function fetchMessages(conversation: Conversation) {
		currentConversation.value = conversation;

		messages.value = await fetch(`/api/v1/conversations/${conversation.id}/messages`).then((response) =>
			response.json(),
		);

		syncConversationSubscription(conversation.id);
	}

	// Keep the composer responsive while the message request is in flight.
	async function sendMessage(content: string) {
		if (!currentConversation.value || !content.trim()) {
			return;
		}
		const conversationId = currentConversation.value.id;
		loadingByConversation.value[conversationId] = true;
		error.value = '';
		try {
			const response = await fetch(`/api/v1/conversations/${conversationId}/messages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content }),
			});
			const result = (await response.json()) as
				{ userMessage: Message; assistantMessage: Message } | { error: string };
			if (!response.ok || 'error' in result) {
				throw new Error('error' in result ? result.error : 'The AI response failed.');
			}
			if (currentConversation.value?.id === conversationId) {
				messages.value.push(result.userMessage, result.assistantMessage);
			}
		} catch (sendError) {
			error.value = sendError instanceof Error ? sendError.message : 'The AI response failed.';
		} finally {
			loadingByConversation.value[conversationId] = false;
		}
	}

	return {
		conversations,
		currentConversation,
		messages,
		loadingByConversation,
		error,
		hasCurrentConversation,
		fetchConversations,
		createConversation,
		fetchMessages,
		sendMessage,
	};
});
