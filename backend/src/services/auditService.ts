import type { FastifyInstance } from 'fastify';
import type { InputJsonValue } from '@prisma/client/runtime/library';

interface AuditEventInput {
	boardId?: string | null;
	workflowId?: string | null;
	taskId?: string | null;
	actor: string;
	eventType: string;
	payload?: InputJsonValue;
}

export async function recordAuditEvent(fastify: FastifyInstance, event: AuditEventInput) {
	await fastify.prisma.auditEvent.create({
		data: {
			boardId: event.boardId ?? null,
			workflowId: event.workflowId ?? null,
			taskId: event.taskId ?? null,
			actor: event.actor,
			eventType: event.eventType,
			payload: event.payload ?? {},
		},
	});
}
