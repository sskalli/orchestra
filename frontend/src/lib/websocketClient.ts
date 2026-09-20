export interface SocketEvent<T = unknown> {
	type: string;
	channel?: string;
	target?: string;
	targetId?: string;
	data?: T;
}

export type SocketMessageHandler<T = unknown> = (event: SocketEvent<T>) => void;

interface WebSocketClientOptions {
	url?: string;
	onOpen?: () => void;
	onClose?: () => void;
	onError?: (event: Event) => void;
}

export function createWebSocketClient(options: WebSocketClientOptions = {}) {
	let socket: WebSocket | null = null;
	const messageHandlers = new Map<string, Set<SocketMessageHandler>>();
	const pendingChannels = new Set<string>();

	const getSocketUrl = () => {
		const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
		return `${protocol}://${window.location.host}${options.url ?? '/ws'}`;
	};

	const flushPendingSubscriptions = () => {
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return;
		}

		for (const channel of pendingChannels) {
			socket.send(JSON.stringify({ type: 'subscribe', channel }));
		}

		pendingChannels.clear();
	};

	const dispatchMessage = (message: unknown) => {
		if (!message || typeof message !== 'object') {
			return;
		}

		const event = message as SocketEvent;
		const handlers = messageHandlers.get(event.channel ?? event.target ?? '*');

		if (!handlers) {
			return;
		}

		for (const handler of handlers) {
			handler(event);
		}
	};

	const connect = () => {
		if (socket && socket.readyState === WebSocket.OPEN) {
			return socket;
		}

		if (socket && socket.readyState === WebSocket.CONNECTING) {
			return socket;
		}

		socket = new WebSocket(getSocketUrl());

		socket.addEventListener('open', () => {
			flushPendingSubscriptions();
			options.onOpen?.();
		});

		socket.addEventListener('close', () => {
			options.onClose?.();
		});

		socket.addEventListener('error', (event) => {
			options.onError?.(event);
		});

		socket.addEventListener('message', (event) => {
			try {
				const payload = JSON.parse(event.data) as SocketEvent;
				dispatchMessage(payload);
			} catch {
				// Ignore malformed live-update payloads from the local-only backend.
			}
		});

		return socket;
	};

	const close = () => {
		if (socket) {
			socket.close();
			socket = null;
		}
	};

	const send = (payload: Record<string, unknown>) => {
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return false;
		}

		socket.send(JSON.stringify(payload));
		return true;
	};

	const subscribe = (channel: string, handler: SocketMessageHandler) => {
		const existing = messageHandlers.get(channel) ?? new Set<SocketMessageHandler>();
		existing.add(handler);
		messageHandlers.set(channel, existing);
		pendingChannels.add(channel);

		if (socket && socket.readyState === WebSocket.OPEN) {
			flushPendingSubscriptions();
		} else {
			connect();
		}
	};

	const unsubscribe = (channel: string, handler?: SocketMessageHandler) => {
		const handlers = messageHandlers.get(channel);

		if (!handlers) {
			pendingChannels.delete(channel);
			return;
		}

		if (handler) {
			handlers.delete(handler);
			if (handlers.size === 0) {
				messageHandlers.delete(channel);
			}
		} else {
			messageHandlers.delete(channel);
		}

		pendingChannels.delete(channel);

		if (socket && socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: 'unsubscribe', channel }));
		}
	};

	return {
		connect,
		close,
		send,
		subscribe,
		unsubscribe,
	};
}
