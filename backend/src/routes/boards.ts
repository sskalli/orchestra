import type { FastifyPluginAsync } from 'fastify';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { config } from '../config.js';
import { decomposeWorkflowIntoTasks } from '../services/kanbanAgentService.js';
import { createModelProvider } from '../services/modelProvider/index.js';
import type { ChatMessage } from '../types.js';

interface CreateBoardBody {
	name?: string;
	settings?: InputJsonValue;
}

interface CreateBoardMessageBody {
	content?: string;
	role?: 'user' | 'assistant' | 'system';
	meta?: InputJsonValue;
}

const ensureDefaultKanbanConfig = async (fastify: Parameters<FastifyPluginAsync>[0]) => {
	const existing = await fastify.prisma.agentConfig.findFirst({
		where: { name: 'kanban-pilot' },
	});

	if (existing) {
		return existing;
	}

	return fastify.prisma.agentConfig.create({
		data: {
			name: 'kanban-pilot',
			role: 'Kanban pilot',
			type: 'template',
			systemPrompt: 'You are the board-level Kanban pilot. Organize plans and summarize updates simply.',
			modelProfile: config.defaultModelProfile,
			allowedTools: [],
			defaultLimits: {},
			outputSchema: {},
		},
	});
};

const isTaskPlanningRequest = (content: string) =>
	/\b(create|add|break\s+(this|it|that)?\s*down|decompose|plan|organize)\b/i.test(content) &&
	/\b(task|tasks|subtask|subtasks|work|steps|implementation|feature)\b/i.test(content);

const getBoardAgentReply = async (fastify: Parameters<FastifyPluginAsync>[0], boardId: string, content: string) => {
	const modelProvider = createModelProvider(config.ollamaBaseUrl);
	const previousMessages = await fastify.prisma.message.findMany({
		where: { boardId },
		orderBy: { createdAt: 'asc' },
	});
	const messages: ChatMessage[] = [
		{
			role: 'system',
			content:
				'You are the board Kanban agent. Discuss the work with the user. Only create tasks when the user explicitly asks for tasks, subtasks, a plan, or a breakdown.',
		},
		...previousMessages.map(({ role, content: messageContent }) => ({
			role: role as ChatMessage['role'],
			content: messageContent,
		})),
		{ role: 'user', content },
	];

	let response = '';
	for await (const chunk of modelProvider.chatCompletion({
		model: config.defaultModelProfile,
		messages,
		stream: true,
	})) {
		response += chunk.content;
	}

	if (!response.trim()) {
		throw new Error('AI response unavailable. The model returned an empty response.');
	}

	return response;
};

const boardsRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.get('/', async () =>
		fastify.prisma.board.findMany({
			where: { isArchived: false },
			orderBy: { updatedAt: 'desc' },
		}),
	);

	fastify.post<{ Body: CreateBoardBody }>('/', async (request, reply) => {
		const name = request.body.name?.trim();
		if (!name) {
			return reply.code(400).send({ error: 'Board name is required' });
		}

		const board = await fastify.prisma.board.create({
			data: { name, settings: request.body.settings ?? {} },
		});

		const agentConfig = await ensureDefaultKanbanConfig(fastify);

		await fastify.prisma.kanbanAgent.create({
			data: {
				boardId: board.id,
				agentConfigId: agentConfig.id,
				state: {},
			},
		});

		await fastify.prisma.agentInstance.create({
			data: {
				configId: agentConfig.id,
				boardId: board.id,
				scope: 'kanban',
				runtimeState: {},
			},
		});

		return reply.code(201).send(board);
	});

	fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
		const board = await fastify.prisma.board.findUnique({
			where: { id: request.params.id },
			include: {
				kanbanAgent: true,
				workflows: { orderBy: { updatedAt: 'desc' }, take: 20 },
				messages: { orderBy: { createdAt: 'asc' }, take: 100 },
			},
		});
		if (!board) {
			return reply.code(404).send({ error: 'Board not found' });
		}
		return board;
	});

	fastify.get<{ Params: { id: string } }>('/:id/agent/messages', async (request, reply) => {
		const board = await fastify.prisma.board.findUnique({ where: { id: request.params.id } });
		if (!board) {
			return reply.code(404).send({ error: 'Board not found' });
		}

		const messages = await fastify.prisma.message.findMany({
			where: { boardId: request.params.id },
			orderBy: { createdAt: 'asc' },
		});
		return messages;
	});

	fastify.post<{ Params: { id: string }; Body: CreateBoardMessageBody }>(
		'/:id/agent/messages',
		async (request, reply) => {
			const board = await fastify.prisma.board.findUnique({ where: { id: request.params.id } });
			if (!board) {
				return reply.code(404).send({ error: 'Board not found' });
			}

			const content = request.body.content?.trim();
			if (!content) {
				return reply.code(400).send({ error: 'Message content is required' });
			}

			const userMessage = await fastify.prisma.message.create({
				data: {
					boardId: request.params.id,
					role: request.body.role ?? 'user',
					content,
					meta: request.body.meta ?? {},
				},
			});

			fastify.broadcast(`board:${request.params.id}:agent:messages`, {
				type: 'message.created',
				target: 'board',
				targetId: request.params.id,
				data: userMessage,
			});

			let assistantContent = '';
			try {
				if (!isTaskPlanningRequest(content)) {
					assistantContent = await getBoardAgentReply(fastify, request.params.id, content);
				} else {
					const workflow = await fastify.prisma.workflow.create({
						data: {
							boardId: board.id,
							title: content.slice(0, 120),
							brief: { prompt: content },
							status: 'running',
						},
					});
					const tasks = await decomposeWorkflowIntoTasks(fastify, { ...workflow, board });
					const taskSummary = tasks
						.map((task, index) => {
							const dependencyCount = Array.isArray(task.dependencies) ? task.dependencies.length : 0;
							return `${index + 1}. ${task.title}${dependencyCount ? ` (${dependencyCount} prerequisite${dependencyCount === 1 ? '' : 's'})` : ''}`;
						})
						.join('\n');
					assistantContent = `Created ${tasks.length} linked task${tasks.length === 1 ? '' : 's'} for "${workflow.title}":\n${taskSummary}`;
				}
			} catch (error) {
				fastify.log.error({ err: error, boardId: request.params.id }, 'Board agent request failed');
				return reply.code(503).send({
					error: 'AI response unavailable. Start Ollama and ensure the configured model is installed.',
				});
			}

			const assistantMessage = await fastify.prisma.message.create({
				data: {
					boardId: request.params.id,
					role: 'assistant',
					content: assistantContent,
				},
			});

			fastify.broadcast(`board:${request.params.id}:agent:messages`, {
				type: 'message.created',
				target: 'board',
				targetId: request.params.id,
				data: assistantMessage,
			});

			return reply.code(201).send({ userMessage, assistantMessage });
		},
	);
};

export default boardsRoutes;
