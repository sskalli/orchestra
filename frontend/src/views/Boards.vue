<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useBoardsStore } from '../stores/boards';
import ChatInput from '../components/ChatInput.vue';
import ChatMessageList from '../components/ChatMessageList.vue';

const TASK_COLUMNS = [
	{ status: 'todo', label: 'To do' },
	{ status: 'doing', label: 'Doing' },
	{ status: 'review_pending', label: 'Review' },
	{ status: 'done', label: 'Done' },
];

const route = useRoute();
const router = useRouter();
const store = useBoardsStore();
const activeTab = ref<'boards' | 'agent'>('boards');
const isCreateModalOpen = ref(false);
const boardName = ref('');
const agentError = ref('');
const sidebarWidth = ref<number | null>(null);
const isResizing = ref(false);
let resizeStartX = 0;
let resizeStartWidth = 0;

const selectedBoardId = computed(() => route.params.id as string | undefined);
const taskColumns = computed(() =>
	TASK_COLUMNS.map((column) => ({
		...column,
		tasks: store.tasks.filter((task) => task.status === column.status),
	})),
);

async function loadBoard() {
	if (selectedBoardId.value) {
		await store.fetchBoard(selectedBoardId.value);
	} else {
		store.selectedBoard = null;
	}
}

onMounted(async () => {
	await store.fetchBoards();
	await loadBoard();
});
onUnmounted(stopResize);
watch(selectedBoardId, loadBoard);

function startResize(event: PointerEvent) {
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
	sidebarWidth.value = Math.min(420, Math.max(220, nextWidth));
}

function stopResize() {
	isResizing.value = false;
	window.removeEventListener('pointermove', resizeSidebar);
}

function selectBoard(boardId: string) {
	activeTab.value = 'boards';
	router.push(`/boards/${boardId}`);
}

async function createBoard() {
	const value = boardName.value.trim();
	if (!value) {
		return;
	}
	await store.createBoard(value);
	const createdBoard = store.boards[0];
	boardName.value = '';
	isCreateModalOpen.value = false;
	if (createdBoard) {
		selectBoard(createdBoard.id);
	}
}

async function sendAgentMessage(content: string) {
	agentError.value = '';
	try {
		await store.sendAgentMessage(content);
	} catch (error) {
		agentError.value = error instanceof Error ? error.message : 'The board agent response failed.';
	}
}

async function markTaskDone(taskId: string) {
	await store.updateTask(taskId, { status: 'done' });
}
</script>

<template>
	<section
		class="boards-workspace"
		:class="{ 'is-resizing': isResizing }"
		:style="{ '--boards-sidebar-width': sidebarWidth ? `${sidebarWidth}px` : undefined }"
	>
		<aside class="boards-sidebar">
			<div class="boards-tabs" role="tablist" aria-label="Board workspace views">
				<button
					class="boards-tab"
					:class="{ active: activeTab === 'boards' }"
					type="button"
					role="tab"
					:aria-selected="activeTab === 'boards'"
					@click="activeTab = 'boards'"
				>
					Boards
				</button>
				<button
					class="boards-tab"
					:class="{ active: activeTab === 'agent' }"
					type="button"
					role="tab"
					:disabled="!store.selectedBoard"
					:aria-selected="activeTab === 'agent'"
					@click="activeTab = 'agent'"
				>
					Agent
				</button>
			</div>

			<div v-if="activeTab === 'boards'" class="board-list-panel">
				<div class="board-list-heading">
					<span class="eyebrow">Workspace</span>
					<button
						class="icon-button"
						type="button"
						aria-label="Create board"
						title="Create board"
						@click="isCreateModalOpen = true"
					>
						+
					</button>
				</div>
				<button
					v-for="board in store.boards"
					:key="board.id"
					class="board-list-item"
					:class="{ active: selectedBoardId === board.id }"
					type="button"
					@click="selectBoard(board.id)"
				>
					<strong>{{ board.name }}</strong>
					<small>Updated {{ new Date(board.updatedAt).toLocaleDateString() }}</small>
				</button>
				<p v-if="!store.boards.length" class="muted">No boards yet.</p>
			</div>

			<div v-else class="agent-panel">
				<div class="board-list-heading">
					<div>
						<span class="eyebrow">Kanban agent</span>
						<h2>{{ store.selectedBoard?.name }}</h2>
					</div>
				</div>
				<ChatMessageList
					class="agent-message-list"
					:messages="store.agentMessages"
					:loading="Boolean(selectedBoardId && store.boardAgentLoading[selectedBoardId])"
					empty-text="Describe the work and the subtasks you want created."
				/>
				<p v-if="agentError" class="error-message">{{ agentError }}</p>
				<ChatInput
					class="agent-composer"
					placeholder="Message the Kanban agent..."
					:busy="Boolean(selectedBoardId && store.boardAgentLoading[selectedBoardId])"
					@send="sendAgentMessage"
				/>
			</div>
			<div
				class="boards-sidebar-resize-handle"
				role="separator"
				aria-label="Resize boards sidebar"
				aria-orientation="vertical"
				@pointerdown="startResize"
			/>
		</aside>

		<main class="boards-main">
			<template v-if="store.selectedBoard">
				<header class="boards-main-heading">
					<div>
						<span class="eyebrow">Board</span>
						<h1>{{ store.selectedBoard.name }}</h1>
					</div>
					<span class="tag">{{ store.tasks.length }} tasks</span>
				</header>

				<div class="kanban-board board-workspace-grid">
					<section v-for="column in taskColumns" :key="column.status" class="kanban-column">
						<div class="kanban-column-heading">
							<h3>{{ column.label }}</h3>
							<span>{{ column.tasks.length }}</span>
						</div>
						<div class="task-card-list">
							<article
								v-for="task in column.tasks"
								:key="task.id"
								class="task-card"
								:class="{ selected: store.selectedTaskId === task.id }"
							>
								<button class="task-card-button" type="button" @click="store.selectTask(task.id)">
									<strong>{{ task.title }}</strong>
									<span v-if="task.description" class="task-description">{{ task.description }}</span>
									<span class="tag">{{ task.type }}</span>
								</button>
								<button
									v-if="task.status === 'doing'"
									class="task-done-button"
									type="button"
									@click="markTaskDone(task.id)"
								>
									Done
								</button>
							</article>
							<p v-if="!column.tasks.length" class="muted task-empty">No tasks</p>
						</div>
					</section>
				</div>
			</template>
			<div v-else class="boards-placeholder">
				<span class="placeholder-mark">+</span>
				<h1>Select a board</h1>
				<p>Choose a board from the left panel to view its kanban workspace.</p>
			</div>
		</main>
	</section>

	<div v-if="isCreateModalOpen" class="modal-backdrop" @click.self="isCreateModalOpen = false">
		<section class="modal" role="dialog" aria-modal="true" aria-labelledby="create-board-title">
			<div class="modal-heading">
				<div>
					<span class="eyebrow">Workspace</span>
					<h2 id="create-board-title">Create a board</h2>
				</div>
				<button
					class="icon-button"
					type="button"
					aria-label="Close"
					title="Close"
					@click="isCreateModalOpen = false"
				>
					x
				</button>
			</div>
			<form class="modal-form" @submit.prevent="createBoard">
				<label for="board-name">Board name</label>
				<input id="board-name" v-model="boardName" autofocus placeholder="e.g. Product launch" />
				<div class="modal-actions">
					<button type="button" class="secondary-button" @click="isCreateModalOpen = false">Cancel</button>
					<button type="submit">Create board</button>
				</div>
			</form>
		</section>
	</div>
</template>
