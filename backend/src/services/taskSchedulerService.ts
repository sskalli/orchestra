import type { FastifyInstance } from 'fastify';
import type { Task } from '@prisma/client';
import { recordAuditEvent } from './auditService.js';

function isDependencyList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// Finds `todo` tasks whose dependencies are all `done` and promotes them to `doing`.
export async function recomputeReadyTasks(fastify: FastifyInstance, workflowId: string): Promise<Task[]> {
	const tasks = await fastify.prisma.task.findMany({ where: { workflowId } });
	const statusById = new Map(tasks.map((task) => [task.id, task.status]));

	const promoted: Task[] = [];

	for (const task of tasks) {
		if (task.status !== 'todo') {
			continue;
		}

		const dependencies = isDependencyList(task.dependencies) ? task.dependencies : [];
		const dependenciesSatisfied = dependencies.every((dependencyId) => statusById.get(dependencyId) === 'done');
		if (!dependenciesSatisfied) {
			continue;
		}

		const updated = await fastify.prisma.task.update({ where: { id: task.id }, data: { status: 'doing' } });
		statusById.set(updated.id, updated.status);

		await recordAuditEvent(fastify, {
			boardId: updated.boardId,
			workflowId: updated.workflowId,
			taskId: updated.id,
			actor: 'kanban-agent',
			eventType: 'task.status_changed',
			payload: { from: 'todo', to: 'doing' },
		});

		fastify.broadcast(`board:${updated.boardId}:tasks`, {
			type: 'task.updated',
			target: 'task',
			targetId: updated.id,
			data: updated,
		});

		promoted.push(updated);
	}

	return promoted;
}
