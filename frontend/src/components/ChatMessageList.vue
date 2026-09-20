<script setup lang="ts">
import MarkdownContent from './MarkdownContent.vue';

interface ChatMessage {
	id: string;
	role: string;
	content: string;
}

defineProps<{
	messages: ChatMessage[];
	emptyText?: string;
	loading?: boolean;
}>();
</script>

<template>
	<div class="chat-messages">
		<article v-for="message in messages" :key="message.id" class="chat-message" :class="message.role">
			<div v-if="message.role !== 'user'" class="chat-message-label">{{ message.role }}</div>
			<MarkdownContent :content="message.content" />
		</article>
		<div v-if="loading" class="chat-loading" role="status" aria-label="Agent is responding">
			<span class="loading-spinner" aria-hidden="true" />
			<span>Agent is responding...</span>
		</div>
		<p v-if="!messages.length" class="muted chat-empty">{{ emptyText ?? 'No messages yet.' }}</p>
	</div>
</template>
