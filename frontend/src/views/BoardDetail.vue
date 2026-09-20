<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
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
const store = useBoardsStore();

const boardId = computed(() => route.params.id as string);
const agentError = ref('');
const taskError = ref('');

const taskColumns = computed(() =>
	TASK_COLUMNS.map((column) => ({
		...column,
		tasks: store.tasks.filter((task) => task.status === column.status),
	})),
);

async function load() {
	await store.fetchBoard(boardId.value);
}

onMounted(load);
watch(boardId, load);

async function sendAgentMessage(content: string) {
	agentError.value = '';
	try {
		await store.sendAgentMessage(content);
	} catch (error) {
		agentError.value = error instanceof Error ? error.message : 'The board agent response failed.';
	}
}

async function selectTask(taskId: string) {
	taskError.value = '';
	await store.selectTask(taskId);
}

async function markTaskDone(taskId: string) {
	await store.updateTask(taskId, { status: 'done' });
}

async function sendTaskMessage(content: string) {
	taskError.value = '';
	try {
		await store.sendTaskMessage(content);
	} catch (error) {
		taskError.value = error instanceof Error ? error.message : 'The task agent response failed.';
	}
}
</script>

<template>
	<section v-if="store.selectedBoard" class="page-section">
		<div class="page-heading">
			<div>
				<p class="eyebrow">Board</p>
				<h1>{{ store.selectedBoard.name }}</h1>
			</div>
		</div>

		<section class="detail-block">
			<h2>Kanban agent chat</h2>
			<div class="message-list compact">
				<ChatMessageList :messages="store.agentMessages" :loading="Boolean(store.boardAgentLoading[boardId])" />
			</div>
			<p v-if="agentError" class="error-message">{{ agentError }}</p>
			<ChatInput
				placeholder="Message the Kanban agent..."
				:busy="Boolean(store.boardAgentLoading[boardId])"
				@send="sendAgentMessage"
			/>
		</section>

		<section class="detail-block">
			<h2>Tasks</h2>
			<div class="kanban-board">
				<div v-for="column in taskColumns" :key="column.status" class="kanban-column">
					<h3>{{ column.label }}</h3>
					<ul class="list">
						<li
							v-for="task in column.tasks"
							:key="task.id"
							:class="{ active: store.selectedTaskId === task.id }"
							@click="selectTask(task.id)"
						>
							<span>{{ task.title }}</span>
							<span class="tag">{{ task.type }}</span>
							<button v-if="task.status === 'doing'" @click.stop="markTaskDone(task.id)">
								Mark done
							</button>
						</li>
						<p v-if="!column.tasks.length" class="muted">None</p>
					</ul>
				</div>
			</div>
			<p v-if="!store.tasks.length" class="muted">No tasks yet. Ask the Kanban agent to create them.</p>
		</section>

		<section v-if="store.selectedTask" class="detail-block">
			<h2>Task chat: {{ store.selectedTask.title }}</h2>
			<div class="message-list compact">
				<ChatMessageList
					:messages="store.taskMessages"
					:loading="Boolean(store.selectedTaskId && store.taskAgentLoading[store.selectedTaskId])"
				/>
			</div>
			<p v-if="taskError" class="error-message">{{ taskError }}</p>
			<ChatInput
				placeholder="Message this task's agent..."
				:busy="Boolean(store.selectedTaskId && store.taskAgentLoading[store.selectedTaskId])"
				@send="sendTaskMessage"
			/>
		</section>
	</section>
</template>
