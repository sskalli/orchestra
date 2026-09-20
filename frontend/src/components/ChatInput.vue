<script setup lang="ts">
import { ref } from 'vue';

const props = withDefaults(
	defineProps<{
		placeholder?: string;
		disabled?: boolean;
		busy?: boolean;
	}>(),
	{ placeholder: 'Write a message...', disabled: false, busy: false },
);

const emit = defineEmits<{ send: [content: string] }>();
const draft = ref('');

function submit() {
	const content = draft.value.trim();
	if (!content || props.disabled || props.busy) {
		return;
	}
	draft.value = '';
	emit('send', content);
}

function handleKeydown(event: KeyboardEvent) {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		submit();
	}
}
</script>

<template>
	<form class="chat-composer" @submit.prevent="submit">
		<textarea
			v-model="draft"
			:placeholder="props.placeholder"
			:disabled="props.disabled || props.busy"
			rows="1"
			@keydown="handleKeydown"
		/>
		<button type="submit" aria-label="Send message" title="Send message" :disabled="props.disabled || props.busy">
			<span aria-hidden="true">↑</span>
		</button>
	</form>
</template>
