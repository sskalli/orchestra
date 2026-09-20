import type { FastifyPluginAsync } from 'fastify';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { decomposeWorkflowIntoTasks, getTaskAgentReply } from '../services/kanbanAgentService.js';
import { recomputeReadyTasks } from '../services/taskSchedulerService.js';
import { recordAuditEvent } from '../services/auditService.js';

interface CreateWorkflowBody {
	title?: string;
	brief?: InputJsonValue;
	sourceConversationId?: string | null;
}

interface UpdateTaskBody {
	status?: string;
	title?: string;
	description?: string;
	priority?: string;
	metadata?: InputJsonValue;
}

interface CreateTaskMessageBody {
	content?: string;
	role?: 'user' | 'assistant' | 'system';
	meta?: InputJsonValue;
}

const workflowsRoutes: FastifyPluginAsync = async (fastify) => {
	fastify.post<{ Params: { id: string }; Body: CreateWorkflowBody }>(
		'/boards/:id/workflows',
		async (request, reply) => {
			const board = await fastify.prisma.board.findUnique({ where: { id: request.params.id } });
			if (!board) {
				return reply.code(404).send({ error: 'Board not found' });
			}

			const title = request.body.title?.trim();
			if (!title) {
				return reply.code(400).send({ error: 'Workflow title is required' });
			}

			if (request.body.sourceConversationId) {
				const sourceConversation = await fastify.prisma.conversation.findUnique({
					where: { id: request.body.sourceConversationId },
				});
				if (!sourceConversation) {
					return reply.code(404).send({ error: 'Conversation not found' });
				}
			}

			const workflow = await fastify.prisma.workflow.create({
				data: {
					boardId: request.params.id,
					title,
					brief: request.body.brief ?? {},
					status: 'planned',
					sourceConversationId: request.body.sourceConversationId ?? null,
				},
			});

			return reply.code(201).send(workflow);
		},
	);

	fastify.get<{ Params: { id: string } }>('/boards/:id/workflows', async (request, reply) => {
		const board = await fastify.prisma.board.findUnique({ where: { id: request.params.id } });
		if (!board) {
			return reply.code(404).send({ error: 'Board not found' });
		}

		const workflows = await fastify.prisma.workflow.findMany({
			where: { boardId: request.params.id },
			orderBy: { updatedAt: 'desc' },
		});
		return workflows;
	});

	fastify.get<{ Params: { id: string } }>('/workflows/:id', async (request, reply) => {
		const workflow = await fastify.prisma.workflow.findUnique({
			where: { id: request.params.id },
			include: {
				tasks: true,
			},
		});

		if (!workflow) {
			return reply.code(404).send({ error: 'Workflow not found' });
		}

		return workflow;
	});

	fastify.post<{ Params: { id: string } }>('/workflows/:id/start', async (request, reply) => {
		const workflow = await fastify.prisma.workflow.findUnique({
			where: { id: request.params.id },
			include: { board: true },
		});

		if (!workflow) {
			return reply.code(404).send({ error: 'Workflow not found' });
		}

		const updatedWorkflow = await fastify.prisma.workflow.update({
			where: { id: request.params.id },
			data: { status: 'running' },
		});

		let createdTasks;
		try {
			createdTasks = await decomposeWorkflowIntoTasks(fastify, { ...updatedWorkflow, board: workflow.board });
		} catch (error) {
			fastify.log.error({ err: error, workflowId: workflow.id }, 'Kanban agent workflow decomposition failed');
			return reply.code(500).send({ error: 'Failed to start workflow' });
		}

		return reply.code(200).send({ workflow: updatedWorkflow, tasks: createdTasks });
	});

	fastify.get<{ Params: { id: string }; Querystring: { workflowId?: string } }>(
		'/boards/:id/tasks',
		async (request, reply) => {
			const board = await fastify.prisma.board.findUnique({ where: { id: request.params.id } });
			if (!board) {
				return reply.code(404).send({ error: 'Board not found' });
			}

			const tasks = await fastify.prisma.task.findMany({
				where: {
					boardId: request.params.id,
					...(request.query.workflowId ? { workflowId: request.query.workflowId } : {}),
				},
				orderBy: { createdAt: 'desc' },
			});

			return tasks;
		},
	);

	fastify.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
		const task = await fastify.prisma.task.findUnique({
			where: { id: request.params.id },
			include: {
				agentInstance: true,
				messages: true,
			},
		});

		if (!task) {
			return reply.code(404).send({ error: 'Task not found' });
		}

		return task;
	});

	fastify.patch<{ Params: { id: string }; Body: UpdateTaskBody }>('/tasks/:id', async (request, reply) => {
		const existingTask = await fastify.prisma.task.findUnique({ where: { id: request.params.id } });
		if (!existingTask) {
			return reply.code(404).send({ error: 'Task not found' });
		}

		const data: Record<string, unknown> = {};
		if (request.body.status !== undefined) data.status = request.body.status;
		if (request.body.title !== undefined) data.title = request.body.title;
		if (request.body.description !== undefined) data.description = request.body.description;
		if (request.body.priority !== undefined) data.priority = request.body.priority;
		if (request.body.metadata !== undefined) data.metadata = request.body.metadata;

		const task = await fastify.prisma.task.update({ where: { id: existingTask.id }, data });

		if (request.body.status && request.body.status !== existingTask.status) {
			fastify.log.info({ taskId: task.id, from: existingTask.status, to: task.status }, 'Task status changed');
			await recordAuditEvent(fastify, {
				boardId: task.boardId,
				workflowId: task.workflowId,
				taskId: task.id,
				actor: 'user',
				eventType: 'task.status_changed',
				payload: { from: existingTask.status, to: task.status },
			});
		}

		fastify.broadcast(`board:${task.boardId}:tasks`, {
			type: 'task.updated',
			target: 'task',
			targetId: task.id,
			data: task,
		});

		if (request.body.status === 'done' && existingTask.status !== 'done') {
			await recomputeReadyTasks(fastify, task.workflowId);
		}

		return task;
	});

	fastify.get<{ Params: { id: string } }>('/tasks/:id/messages', async (request, reply) => {
		const task = await fastify.prisma.task.findUnique({ where: { id: request.params.id } });
		if (!task) {
			return reply.code(404).send({ error: 'Task not found' });
		}

		return fastify.prisma.message.findMany({
			where: { taskId: request.params.id },
			orderBy: { createdAt: 'asc' },
		});
	});

	fastify.post<{ Params: { id: string }; Body: CreateTaskMessageBody }>(
		'/tasks/:id/messages',
		async (request, reply) => {
			const task = await fastify.prisma.task.findUnique({ where: { id: request.params.id } });
			if (!task) {
				return reply.code(404).send({ error: 'Task not found' });
			}

			const content = request.body.content?.trim();
			if (!content) {
				return reply.code(400).send({ error: 'Message content is required' });
			}

			const userMessage = await fastify.prisma.message.create({
				data: {
					taskId: task.id,
					role: request.body.role ?? 'user',
					content,
					meta: request.body.meta ?? {},
				},
			});

			fastify.broadcast(`task:${task.id}:messages`, {
				type: 'message.created',
				target: 'task',
				targetId: task.id,
				data: userMessage,
			});

			let assistantContent = '';
			try {
				assistantContent = await getTaskAgentReply(fastify, task, content);
			} catch (error) {
				fastify.log.error({ err: error, taskId: task.id }, 'Task agent response failed');
				return reply.code(503).send({
					error: 'AI response unavailable. Start Ollama and ensure the configured model is installed.',
				});
			}

			const assistantMessage = await fastify.prisma.message.create({
				data: {
					taskId: task.id,
					role: 'assistant',
					content: assistantContent,
				},
			});

			fastify.broadcast(`task:${task.id}:messages`, {
				type: 'message.created',
				target: 'task',
				targetId: task.id,
				data: assistantMessage,
			});

			return reply.code(201).send({ userMessage, assistantMessage });
		},
	);
};

export default workflowsRoutes;
