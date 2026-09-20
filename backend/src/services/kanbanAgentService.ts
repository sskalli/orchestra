import type { FastifyInstance } from 'fastify';
import type { Board, Task, Workflow } from '@prisma/client';
import { config } from '../config.js';
import { createModelProvider } from './modelProvider/index.js';
import { recomputeReadyTasks } from './taskSchedulerService.js';
import type { ChatMessage } from '../types.js';

interface PlannedTask {
	title: string;
	description: string;
	type: string;
	// 0-based indices into the plan array identifying prerequisite tasks.
	dependencies: number[];
}

const FALLBACK_TASKS: PlannedTask[] = [
	{ title: 'Phase 1', description: 'Initial planning and setup work.', type: 'generic', dependencies: [] },
	{ title: 'Phase 2', description: 'Follow-up execution work.', type: 'generic', dependencies: [0] },
];

const KANBAN_PILOT_CONFIG_NAME = 'kanban-pilot';

const KANBAN_PLANNING_SYSTEM_PROMPT = [
	'You are the Kanban pilot agent for a local-first multi-agent workbench.',
	'Decompose the workflow brief into a dependency graph of concrete, actionable tasks.',
	'Write clear, specific titles and descriptions - avoid vague phases like "Phase 1".',
	'Each task must have an explicit type: "code" for implementation work, "review" for code review,',
	'"test" for verification work, or "generic" for anything else.',
	'List dependencies as the 0-based indices of other tasks in this same array that must be "done"',
	'before this task can start; use an empty array if a task has no prerequisites.',
	'Respond with ONLY a JSON array (no prose, no markdown fences) of objects shaped exactly like:',
	'[{"title": string, "description": string, "type": "code"|"review"|"test"|"generic", "dependencies": number[]}]',
].join(' ');

// TODO: replace this best-effort parser with schema validation once outputSchema enforcement is added.
function parsePlannedTasks(raw: string): PlannedTask[] {
	const candidates = [raw.trim()];
	const bracketMatch = raw.match(/\[[\s\S]*\]/);
	if (bracketMatch) {
		candidates.push(bracketMatch[0]);
	}

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (!Array.isArray(parsed) || parsed.length === 0) {
				continue;
			}

			return parsed.map((item, index) => ({
				title: typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : `Task ${index + 1}`,
				description: typeof item?.description === 'string' ? item.description : '',
				type: typeof item?.type === 'string' ? item.type : 'generic',
				dependencies: Array.isArray(item?.dependencies)
					? item.dependencies.filter((value: unknown): value is number => typeof value === 'number')
					: [],
			}));
		} catch {
			// Try the next candidate before giving up.
		}
	}

	throw new Error('Unable to parse a task plan from the model response');
}

async function getKanbanPilotConfig(fastify: FastifyInstance) {
	const agentConfig = await fastify.prisma.agentConfig.findFirst({
		where: { name: KANBAN_PILOT_CONFIG_NAME },
	});

	if (!agentConfig) {
		throw new Error('Kanban pilot agent config not found');
	}

	return agentConfig;
}

async function planWorkflowTasks(
	fastify: FastifyInstance,
	workflow: Workflow & { board: Board },
	systemPrompt: string,
): Promise<PlannedTask[]> {
	const modelProvider = createModelProvider(config.ollamaBaseUrl);

	const messages: ChatMessage[] = [
		{ role: 'system', content: systemPrompt },
		{
			role: 'user',
			content: [
				`Board: ${workflow.board.name}`,
				`Workflow: ${workflow.title}`,
				`Brief: ${JSON.stringify(workflow.brief)}`,
			].join('\n'),
		},
	];

	let response = '';
	for await (const chunk of modelProvider.chatCompletion({
		model: config.defaultModelProfile,
		messages,
		stream: true,
	})) {
		response += chunk.content;
	}

	try {
		return parsePlannedTasks(response);
	} catch (error) {
		fastify.log.warn(
			{ err: error, workflowId: workflow.id, response },
			'Falling back to dummy tasks: kanban agent plan could not be parsed',
		);
		return FALLBACK_TASKS;
	}
}

// Decomposes a workflow brief into Task rows via the board's Kanban pilot agent.
export async function decomposeWorkflowIntoTasks(
	fastify: FastifyInstance,
	workflow: Workflow & { board: Board },
): Promise<Task[]> {
	const taskConfig = await getKanbanPilotConfig(fastify);

	const plannedTasks = await planWorkflowTasks(fastify, workflow, KANBAN_PLANNING_SYSTEM_PROMPT);

	const createdTasks: Task[] = [];

	for (const [index, planned] of plannedTasks.entries()) {
		const agentInstance = await fastify.prisma.agentInstance.create({
			data: {
				configId: taskConfig.id,
				scope: 'task',
				runtimeState: { workflowId: workflow.id, planIndex: index },
			},
		});

		const task = await fastify.prisma.task.create({
			data: {
				boardId: workflow.boardId,
				workflowId: workflow.id,
				parentTaskId: null,
				agentInstanceId: agentInstance.id,
				title: planned.title,
				description: planned.description,
				type: planned.type,
				// All tasks start as todo; the scheduler promotes tasks with satisfied dependencies below.
				status: 'todo',
				workspacePath: `./workspaces/${workflow.boardId}/${workflow.id}/task-${index + 1}`,
				permissionPolicy: {},
				limits: {},
				metadata: { planIndex: index },
				dependencies: [],
			},
		});

		await fastify.prisma.message.create({
			data: {
				taskId: task.id,
				role: 'assistant',
				content: `Goal: ${planned.description || planned.title}`,
			},
		});

		createdTasks.push(task);
	}

	// Resolve each planned task's dependency indices to the real task IDs created above.
	for (const [index, planned] of plannedTasks.entries()) {
		const dependencyIds = planned.dependencies
			.map((dependencyIndex) => createdTasks[dependencyIndex]?.id)
			.filter((id): id is string => Boolean(id) && id !== createdTasks[index].id);

		if (dependencyIds.length === 0) {
			continue;
		}

		createdTasks[index] = await fastify.prisma.task.update({
			where: { id: createdTasks[index].id },
			data: { dependencies: dependencyIds },
		});
	}

	for (const task of createdTasks) {
		fastify.broadcast(`board:${workflow.boardId}:tasks`, {
			type: 'task.updated',
			target: 'task',
			targetId: task.id,
			data: task,
		});
	}

	// Promote the tasks that have no unmet dependencies to `doing`.
	const promoted = await recomputeReadyTasks(fastify, workflow.id);
	const promotedById = new Map(promoted.map((task) => [task.id, task]));

	return createdTasks.map((task) => promotedById.get(task.id) ?? task);
}

// Generates a task-agent reply for the task chat, reusing the task's assigned agent config prompt.
export async function getTaskAgentReply(fastify: FastifyInstance, task: Task, content: string): Promise<string> {
	const agentInstance = await fastify.prisma.agentInstance.findUnique({
		where: { id: task.agentInstanceId },
		include: { config: true },
	});

	if (!agentInstance) {
		throw new Error('Task agent instance not found');
	}

	const modelProvider = createModelProvider(config.ollamaBaseUrl);
	const previousMessages = await fastify.prisma.message.findMany({
		where: { taskId: task.id },
		orderBy: { createdAt: 'asc' },
	});

	const messages: ChatMessage[] = [
		{ role: 'system', content: `${agentInstance.config.systemPrompt}\nTask: ${task.title}\n${task.description}` },
		...previousMessages.map(({ role, content: messageContent }) => ({
			role: role as ChatMessage['role'],
			content: messageContent,
		})),
		{ role: 'user', content },
	];

	let response = '';
	for await (const chunk of modelProvider.chatCompletion({
		model: agentInstance.config.modelProfile,
		messages,
		stream: true,
	})) {
		response += chunk.content;
	}

	if (!response.trim()) {
		throw new Error('AI response unavailable. The model returned an empty response.');
	}

	return response;
}
