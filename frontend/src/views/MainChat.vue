<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useMainChatStore } from '../stores/mainChat';
import ChatInput from '../components/ChatInput.vue';
import ChatMessageList from '../components/ChatMessageList.vue';

const store = useMainChatStore();
const sidebarCollapsed = ref(false);
const sidebarWidth = ref<number | null>(null);
const isResizing = ref(false);
let resizeStartX = 0;
let resizeStartWidth = 0;

function toggleSidebar() {
	sidebarCollapsed.value = !sidebarCollapsed.value;
}

function startResize(event: PointerEvent) {
	if (sidebarCollapsed.value) {
		return;
	}
	const sidebar = event.currentTarget as HTMLElement;
	resizeStartX = event.clientX;
	resizeStartWidth = sidebar.parentElement?.getBoundingClientRect().width ?? sidebar.offsetWidth;
	isResizing.value = true;
	window.addEventListener('pointermove', resizeSidebar);
	window.addEventListener('pointerup', stopResize, { once: true });
}

function resizeSidebar(event: PointerEvent) {
	if (!isResizing.value) {
		return;
	}
	const nextWidth = resizeStartWidth + event.clientX - resizeStartX;
	sidebarWidth.value = Math.min(380, Math.max(220, nextWidth));
}

function stopResize() {
	isResizing.value = false;
	window.removeEventListener('pointermove', resizeSidebar);
}

function handleSidebarToggle() {
	toggleSidebar();
}

onMounted(() => {
	store.fetchConversations();
	window.addEventListener('toggle-main-chat-sidebar', handleSidebarToggle);
});
onUnmounted(() => {
	stopResize();
	window.removeEventListener('toggle-main-chat-sidebar', handleSidebarToggle);
});

async function send(content: string) {
	await store.sendMessage(content);
}
</script>

<template>
	<section
		class="chat-layout"
		:class="{ 'sidebar-collapsed': sidebarCollapsed, 'is-resizing': isResizing }"
		:style="{ '--sidebar-width': sidebarWidth ? `${sidebarWidth}px` : undefined }"
	>
		<aside class="sidebar" :aria-hidden="sidebarCollapsed">
			<div class="sidebar-header">
				<h1>Conversations</h1>
				<button
					class="icon-button new-conversation"
					type="button"
					aria-label="New conversation"
					title="New conversation"
					@click="store.createConversation()"
				>
					+
				</button>
			</div>
			<button
				v-for="conversation in store.conversations"
				:key="conversation.id"
				class="conversation"
				:class="{ active: store.currentConversation?.id === conversation.id }"
				@click="store.fetchMessages(conversation)"
			>
				{{ conversation.title || 'Untitled conversation' }}
				<span v-if="store.loadingByConversation[conversation.id]" class="conversation-loading">
					<span class="loading-spinner" aria-hidden="true" />
					<span class="sr-only">Agent is responding</span>
				</span>
			</button>
			<p v-if="!store.conversations.length" class="muted">No conversations yet.</p>
			<div
				class="sidebar-resize-handle"
				role="separator"
				aria-label="Resize conversations panel"
				aria-orientation="vertical"
				@pointerdown="startResize"
			/>
		</aside>
		<div class="chat-panel">
			<div v-if="store.currentConversation" class="message-list">
				<p v-if="store.error" class="error-message">{{ store.error }}</p>
				<ChatMessageList
					:messages="store.messages"
					:loading="Boolean(store.loadingByConversation[store.currentConversation.id])"
					empty-text="Start the conversation."
				/>
			</div>
			<div v-else class="empty-state">
				<h2>Welcome to Orchestra</h2>
				<p>Create a conversation to begin.</p>
			</div>
			<ChatInput
				:disabled="!store.currentConversation"
				:busy="Boolean(store.currentConversation && store.loadingByConversation[store.currentConversation.id])"
				@send="send"
			/>
		</div>
	</section>
</template>
