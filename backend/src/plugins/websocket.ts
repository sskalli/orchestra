import fp from 'fastify-plugin';
import { WebSocketServer, type WebSocket } from 'ws';

declare module 'fastify' {
	interface FastifyInstance {
		wss: WebSocketServer;
		broadcast: (channel: string, payload: unknown) => void;
	}
}

export default fp(async (fastify) => {
	const wss = new WebSocketServer({ noServer: true });
	const subscriptions = new Map<string, Set<WebSocket>>();

	const subscribeSocket = (socket: WebSocket, channel: string) => {
		const members = subscriptions.get(channel) ?? new Set<WebSocket>();

		members.add(socket);
		subscriptions.set(channel, members);
	};

	const unsubscribeSocket = (socket: WebSocket, channel: string) => {
		const members = subscriptions.get(channel);

		if (!members) {
			return;
		}

		members.delete(socket);

		if (members.size === 0) {
			subscriptions.delete(channel);
		}
	};

	const unsubscribeSocketFromAllChannels = (socket: WebSocket) => {
		for (const [channel, members] of subscriptions.entries()) {
			if (members.has(socket)) {
				members.delete(socket);
			}

			if (members.size === 0) {
				subscriptions.delete(channel);
			}
		}
	};

	const broadcast = (channel: string, payload: unknown) => {
		const members = subscriptions.get(channel);

		if (!members) {
			return;
		}

		const message = JSON.stringify(payload);

		for (const socket of members) {
			if (socket.readyState === socket.OPEN) {
				socket.send(message);
			}
		}
	};

	fastify.decorate('wss', wss);
	fastify.decorate('broadcast', broadcast);

	wss.on('connection', (socket) => {
		socket.on('message', (raw) => {
			try {
				const event = JSON.parse(raw.toString()) as { type?: string; channel?: string };

				if (event.type === 'subscribe' && typeof event.channel === 'string') {
					subscribeSocket(socket, event.channel);
				}
				if (event.type === 'unsubscribe' && typeof event.channel === 'string') {
					unsubscribeSocket(socket, event.channel);
				}
			} catch {
				// Ignore malformed websocket payloads in local-only mode.
			}
		});

		socket.on('close', () => unsubscribeSocketFromAllChannels(socket));
	});

	// Fastify owns the HTTP server, so hand only /ws upgrades to ws.
	fastify.server.on('upgrade', (request, socket, head) => {
		if (!request.url?.startsWith('/ws')) {
			return;
		}

		wss.handleUpgrade(request, socket, head, (client) => {
			wss.emit('connection', client, request);
		});
	});

	// Close the WebSocket server together with Fastify during shutdown.
	fastify.addHook('onClose', async () => wss.close());
});
