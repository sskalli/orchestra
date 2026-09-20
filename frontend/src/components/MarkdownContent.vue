<script setup lang="ts">
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';

const props = defineProps<{ content: string }>();

const markdown = new MarkdownIt({
	breaks: true,
	linkify: true,
	typographer: true,
});

function renderMarkdown(content: string) {
	return DOMPurify.sanitize(markdown.render(content), {
		USE_PROFILES: { html: true },
		FORBID_TAGS: ['style', 'script'],
		FORBID_ATTR: ['style', 'onerror', 'onclick'],
	});
}
</script>

<template>
	<div class="markdown-content" v-html="renderMarkdown(props.content)" />
</template>
