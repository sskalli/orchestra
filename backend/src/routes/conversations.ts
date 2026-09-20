import type { FastifyPluginAsync } from 'fastify';
import type { InputJsonValue } from '@prisma/client/runtime/library';
import { config } from '../config.js';
import { createModelProvider } from '../services/modelProvider/index.js';
import type { ChatMessage } from '../types.js';

interface CreateConversationBody {
	title?: string;
	defaultModelProfile?: string;
}

interface CreateMessageBody {
	content?: string;
	role?: 'user' | 'assistant' | 'system';
	meta?: InputJsonValue;
}

const conversationsRoutes: FastifyPluginAsync = async (fastify) => {
	const modelProvider = createModelProvider(config.ollamaBaseUrl);

	fastify.get('/', async () =>
		fastify.prisma.conversation.findMany({
			where: { isArchived: false },
			orderBy: { updatedAt: 'desc' },
		}),
	);

	fastify.post<{ Body: CreateConversationBody }>('/', async (request, reply) => {
		const conversation = await fastify.prisma.conversation.create({
			data: {
				title: request.body.title?.trim() || 'New conversation',
				defaultModelProfile: request.body.defaultModelProfile ?? config.defaultModelProfile,
			},
		});
		return reply.code(201).send(conversation);
	});

	fastify.get<{ Params: { id: string } }>('/:id/messages', async (request, reply) => {
		const conversation = await fastify.prisma.conversation.findUnique({ where: { id: request.params.id } });
		if (!conversation) {
			return reply.code(404).send({ error: 'Conversation not found' });
		}
		return fastify.prisma.message.findMany({
			where: { conversationId: request.params.id },
			orderBy: { createdAt: 'asc' },
		});
	});

	fastify.post<{ Params: { id: string }; Body: CreateMessageBody }>('/:id/messages', async (request, reply) => {
		const content = request.body.content?.trim();
		if (!content) {
			return reply.code(400).send({ error: 'Message content is required' });
		}

		const conversation = await fastify.prisma.conversation.findUnique({ where: { id: request.params.id } });
		if (!conversation) {
			return reply.code(404).send({ error: 'Conversation not found' });
		}

		const previousMessages = await fastify.prisma.message.findMany({
			where: { conversationId: request.params.id },
			orderBy: { createdAt: 'asc' },
		});
		const userMessage = await fastify.prisma.message.create({
			data: {
				conversationId: request.params.id,
				role: 'user',
				content,
				meta: request.body.meta ?? {},
			},
		});

		fastify.broadcast(`conversation:${request.params.id}:messages`, {
			type: 'message.created',
			target: 'conversation',
			targetId: request.params.id,
			data: userMessage,
		});

		const chatMessages: ChatMessage[] = [
			...previousMessages.map(({ role, content: messageContent }: { role: string; content: string }) => ({
				role: role as ChatMessage['role'],
				content: messageContent,
			})),
			{ role: 'user', content },
		];

		let assistantContent = '';
		try {
			for await (const chunk of modelProvider.chatCompletion({
				model: conversation.defaultModelProfile ?? config.defaultModelProfile,
				messages: chatMessages,
				stream: true,
			})) {
				assistantContent += chunk.content;
			}
		} catch (error) {
			fastify.log.error({ err: error, conversationId: request.params.id }, 'Required model response failed');
			return reply.code(503).send({
				error: 'AI response unavailable. Start Ollama and ensure the configured model is installed.',
			});
		}

		if (!assistantContent.trim()) {
			return reply.code(503).send({ error: 'AI response unavailable. The model returned an empty response.' });
		}

		const assistantMessage = await fastify.prisma.message.create({
			data: {
				conversationId: request.params.id,
				role: 'assistant',
				content: assistantContent,
			},
		});

		fastify.broadcast(`conversation:${request.params.id}:messages`, {
			type: 'message.created',
			target: 'conversation',
			targetId: request.params.id,
			data: assistantMessage,
		});

		return reply.code(201).send({ userMessage, assistantMessage });
	});
};

export default conversationsRoutes;
