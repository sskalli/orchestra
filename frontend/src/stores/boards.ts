import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { createWebSocketClient, type SocketEvent } from '../lib/websocketClient';

export interface Board {
	id: string;
	name: string;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Message {
	id: string;
	role: string;
	content: string;
	createdAt: string;
}

export interface BoardDetail extends Board {
	workflows: Workflow[];
	messages: Message[];
}

export interface Workflow {
	id: string;
	boardId: string;
	title: string;
	brief: unknown;
	status: string;
	createdAt: string;
	updatedAt: string;
}

export interface Task {
	id: string;
	boardId: string;
	workflowId: string;
	parentTaskId: string | null;
	title: string;
	description: string;
	type: string;
	status: string;
	priority: string | null;
	dependencies: string[];
	metadata: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export const useBoardsStore = defineStore('boards', () => {
	const boards = ref<Board[]>([]);
	const selectedBoard = ref<BoardDetail | null>(null);
	const agentMessages = ref<Message[]>([]);
	const workflows = ref<Workflow[]>([]);
	const tasks = ref<Task[]>([]);
	const selectedTaskId = ref<string | null>(null);
	const taskMessages = ref<Message[]>([]);
	const boardAgentLoading = ref<Record<string, boolean>>({});
	const taskAgentLoading = ref<Record<string, boolean>>({});
	const socket = createWebSocketClient();
	const channelSubscriptions = new Map<string, { channel: string; handler: (event: SocketEvent) => void }>();

	const hasBoards = computed(() => boards.value.length > 0);
	const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedTaskId.value) ?? null);

	// Subscribe to a channel, replacing any previous subscription tracked under the same key.
	const resubscribe = (key: string, channel: string | null, handler: (event: SocketEvent) => void) => {
		const previous = channelSubscriptions.get(key);
		if (previous) {
			socket.unsubscribe(previous.channel, previous.handler);
			channelSubscriptions.delete(key);
		}

		if (!channel) {
			return;
		}

		channelSubscriptions.set(key, { channel, handler });
		socket.subscribe(channel, handler);
	};

	const boardAgentHandler = (event: SocketEvent) => {
		const message = event.data as Message | undefined;
		if (!message || event.targetId !== selectedBoard.value?.id) {
			return;
		}
		if (!agentMessages.value.some((existing) => existing.id === message.id)) {
			agentMessages.value.push(message);
		}
	};

	const boardTasksHandler = (event: SocketEvent) => {
		const task = event.data as Task | undefined;
		if (!task || event.targetId === undefined) {
			return;
		}
		const index = tasks.value.findIndex((existing) => existing.id === task.id);
		if (index === -1) {
			tasks.value.push(task);
		} else {
			tasks.value[index] = task;
		}
	};

	const taskMessagesHandler = (event: SocketEvent) => {
		const message = event.data as Message | undefined;
		if (!message || event.targetId !== selectedTaskId.value) {
			return;
		}
		if (!taskMessages.value.some((existing) => existing.id === message.id)) {
			taskMessages.value.push(message);
		}
	};

	// Refresh the board list used by the boards view.
	async function fetchBoards() {
		boards.value = await fetch('/api/v1/boards').then((response) => response.json());
	}

	// Add the new board locally so it appears immediately without another list request.
	async function createBoard(name: string) {
		const board = (await fetch('/api/v1/boards', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name }),
		}).then((response) => response.json())) as Board;
		boards.value.unshift(board);
	}

	// Load one board plus its workflows/messages, then wire up live task and chat channels.
	async function fetchBoard(id: string) {
		const board = (await fetch(`/api/v1/boards/${id}`).then((response) => response.json())) as BoardDetail;
		selectedBoard.value = board;
		agentMessages.value = board.messages ?? [];
		workflows.value = board.workflows ?? [];
		selectedTaskId.value = null;
		taskMessages.value = [];

		resubscribe('board-agent', `board:${id}:agent:messages`, boardAgentHandler);
		resubscribe('board-tasks', `board:${id}:tasks`, boardTasksHandler);

		await fetchTasks(id);
	}

	// Send a message in the board-level Kanban agent chat.
	async function sendAgentMessage(content: string) {
		if (!selectedBoard.value || !content.trim()) {
			return;
		}
		const boardId = selectedBoard.value.id;
		boardAgentLoading.value[boardId] = true;
		try {
			const response = await fetch(`/api/v1/boards/${boardId}/agent/messages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content }),
			});
			const result = (await response.json()) as
				{ userMessage: Message; assistantMessage: Message } | { error: string };
			if (!response.ok || 'error' in result) {
				throw new Error('error' in result ? result.error : 'The board agent response failed.');
			}
			if (selectedBoard.value?.id === boardId) {
				for (const message of [result.userMessage, result.assistantMessage]) {
					if (!agentMessages.value.some((existing) => existing.id === message.id)) {
						agentMessages.value.push(message);
					}
				}
			}
		} finally {
			boardAgentLoading.value[boardId] = false;
		}
	}

	// Create a workflow for the selected board.
	async function createWorkflow(title: string, brief: unknown = {}) {
		if (!selectedBoard.value) {
			return;
		}
		const workflow = (await fetch(`/api/v1/boards/${selectedBoard.value.id}/workflows`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title, brief }),
		}).then((response) => response.json())) as Workflow;
		workflows.value.unshift(workflow);
	}

	// Start a workflow; the Kanban agent decomposes it into tasks, broadcast over the board tasks channel.
	async function startWorkflow(workflowId: string) {
		const response = await fetch(`/api/v1/workflows/${workflowId}/start`, { method: 'POST' });
		const result = (await response.json()) as { workflow: Workflow; tasks: Task[] } | { error: string };
		if (!response.ok || 'error' in result) {
			throw new Error('error' in result ? result.error : 'Failed to start workflow.');
		}

		const index = workflows.value.findIndex((existing) => existing.id === result.workflow.id);
		if (index !== -1) {
			workflows.value[index] = result.workflow;
		}

		for (const task of result.tasks) {
			if (!tasks.value.some((existing) => existing.id === task.id)) {
				tasks.value.push(task);
			}
		}
	}

	// Load the board's tasks, optionally scoped to a single workflow.
	async function fetchTasks(boardId: string, workflowId?: string) {
		const query = workflowId ? `?workflowId=${workflowId}` : '';
		tasks.value = await fetch(`/api/v1/boards/${boardId}/tasks${query}`).then((response) => response.json());
	}

	// Update a task's fields (most commonly its status) and let the server broadcast the change.
	async function updateTask(
		taskId: string,
		data: Partial<Pick<Task, 'status' | 'title' | 'description' | 'priority'>>,
	) {
		const task = (await fetch(`/api/v1/tasks/${taskId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(data),
		}).then((response) => response.json())) as Task;
		const index = tasks.value.findIndex((existing) => existing.id === task.id);
		if (index !== -1) {
			tasks.value[index] = task;
		}
	}

	// Select a task to inspect its chat, subscribing to its live message channel.
	async function selectTask(taskId: string) {
		selectedTaskId.value = taskId;
		taskMessages.value = await fetch(`/api/v1/tasks/${taskId}/messages`).then((response) => response.json());
		resubscribe('task-messages', `task:${taskId}:messages`, taskMessagesHandler);
	}

	// Send a message in the selected task's chat.
	async function sendTaskMessage(content: string) {
		if (!selectedTaskId.value || !content.trim()) {
			return;
		}
		const taskId = selectedTaskId.value;
		taskAgentLoading.value[taskId] = true;
		try {
			const response = await fetch(`/api/v1/tasks/${taskId}/messages`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content }),
			});
			const result = (await response.json()) as
				{ userMessage: Message; assistantMessage: Message } | { error: string };
			if (!response.ok || 'error' in result) {
				throw new Error('error' in result ? result.error : 'The task agent response failed.');
			}
			if (selectedTaskId.value === taskId) {
				for (const message of [result.userMessage, result.assistantMessage]) {
					if (!taskMessages.value.some((existing) => existing.id === message.id)) {
						taskMessages.value.push(message);
					}
				}
			}
		} finally {
			taskAgentLoading.value[taskId] = false;
		}
	}

	return {
		boards,
		selectedBoard,
		agentMessages,
		workflows,
		tasks,
		selectedTaskId,
		selectedTask,
		taskMessages,
		boardAgentLoading,
		taskAgentLoading,
		hasBoards,
		fetchBoards,
		createBoard,
		fetchBoard,
		sendAgentMessage,
		createWorkflow,
		startWorkflow,
		fetchTasks,
		updateTask,
		selectTask,
		sendTaskMessage,
	};
});
