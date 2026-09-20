<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';

const route = useRoute();
const isMainChat = computed(() => route.path === '/');

function toggleMainChatSidebar() {
	window.dispatchEvent(new CustomEvent('toggle-main-chat-sidebar'));
}
</script>

<template>
	<div class="app-shell">
		<header class="topbar">
			<div class="brand-group">
				<button
					v-if="isMainChat"
					class="navbar-toggle"
					type="button"
					aria-label="Toggle conversations"
					title="Toggle conversations"
					@click="toggleMainChatSidebar"
				>
					☰
				</button>
				<span v-else class="navbar-toggle-placeholder" aria-hidden="true" />
				<RouterLink class="brand" to="/">Orchestra</RouterLink>
			</div>
			<nav>
				<RouterLink to="/">Main Chat</RouterLink>
				<RouterLink to="/boards">Boards</RouterLink>
			</nav>
		</header>
		<main class="content"><RouterView /></main>
	</div>
</template>
