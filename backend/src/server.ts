import Fastify from 'fastify';
import { config } from './config.js';
import prismaPlugin from './plugins/prisma.js';
import websocketPlugin from './plugins/websocket.js';
import boardsRoutes from './routes/boards.js';
import conversationsRoutes from './routes/conversations.js';
import workflowsRoutes from './routes/workflows.js';

const app = Fastify({
	logger: {
		transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
	},
});

await app.register(prismaPlugin);
await app.register(websocketPlugin);
await app.register(boardsRoutes, { prefix: '/api/v1/boards' });
await app.register(conversationsRoutes, { prefix: '/api/v1/conversations' });
await app.register(workflowsRoutes, { prefix: '/api/v1' });

// Keep a small probe endpoint independent of database-backed routes.
app.get('/health', async () => ({ status: 'ok' }));

// Avoid exposing internal errors while preserving their status code when available.
app.setErrorHandler((error, _request, reply) => {
	app.log.error(error);
	const statusCode =
		typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
			? error.statusCode
			: 500;
	return reply.code(statusCode).send({ error: 'Internal server error' });
});

try {
	await app.listen({ port: config.port, host: '0.0.0.0' });
	app.log.info(`Backend listening at http://localhost:${config.port}`);
} catch (error) {
	app.log.error(error);
	process.exit(1);
}
