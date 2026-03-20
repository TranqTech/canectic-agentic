/**
 * Cross-process event pub/sub.
 *
 * Lightweight fire-and-forget notifications between processes.  Uses raw
 * Redis pub/sub (not BullMQ jobs) because:
 *   - Missing a notification is acceptable (UI refreshes on next interaction)
 *   - No retry or durability needed
 *   - No job records to accumulate in Redis
 *
 * Uses a dedicated ioredis connection per publisher/subscriber (Redis pub/sub
 * requires dedicated connections — a subscribed client can't do other commands).
 */

import { createQueueConnection } from './connection.js';
import * as alogger from "../utils/alogger.js";

const CHANNEL = 'canectic:events';

// ---------------------------------------------------------------------------
// Event type constants
// ---------------------------------------------------------------------------

export const EVENTS = {
	// Worker → Gateway: new messages imported into areas
	MESSAGES_IMPORTED: 'messages:imported',

	// Worker → Gateway: PM delivered to a user's inbox
	PM_DELIVERED: 'pm:delivered',

	// Worker → Gateway/Mailer: toss cycle completed
	TOSS_COMPLETE: 'toss:complete',

	// Mailer → Gateway: session lifecycle (for admin dashboard)
	MAILER_SESSION_START: 'mailer:session:start',
	MAILER_SESSION_END: 'mailer:session:end',
	MAILER_TRANSFER_PROGRESS: 'mailer:transfer:progress',

	// Any process → All: config changed in DB, reload appConfig
	CONFIG_CHANGED: 'config:changed',
};

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

/**
 * Create an event publisher.
 *
 * Usage:
 *   const pub = createEventPublisher();
 *   pub.publish(EVENTS.MESSAGES_IMPORTED, { areas: ['GENERAL'], count: 12 });
 *   // on shutdown:
 *   pub.shutdown();
 */
export function createEventPublisher() {
	const redis = createQueueConnection();

	return {
		publish(eventType, data) {
			try {
				const payload = JSON.stringify({
					type: eventType,
					data: data || {},
					ts: Date.now(),
				});
				redis.publish(CHANNEL, payload);
			} catch (err) {
				alogger.writeAlog(3, "Event publish error: " + err.message, "yellow");
			}
		},

		shutdown() {
			try { redis.disconnect(); } catch (_) {}
		}
	};
}

// ---------------------------------------------------------------------------
// Subscriber
// ---------------------------------------------------------------------------

/**
 * Create an event subscriber.
 *
 * The handler receives parsed event objects: { type, data, ts }
 *
 * Usage:
 *   const sub = createEventSubscriber((event) => {
 *       if (event.type === EVENTS.MESSAGES_IMPORTED) {
 *           // push updates to connected WebSocket clients
 *       }
 *   });
 *   // on shutdown:
 *   sub.shutdown();
 */
export function createEventSubscriber(handler) {
	const redis = createQueueConnection();

	redis.subscribe(CHANNEL, (err) => {
		if (err) {
			alogger.writeAlog(2, "Event subscribe error: " + err.message, "redbright");
		}
	});

	redis.on('message', (channel, message) => {
		if (channel !== CHANNEL) return;
		try {
			const event = JSON.parse(message);
			handler(event);
		} catch (err) {
			alogger.writeAlog(4, "Event parse error: " + err.message, "yellow");
		}
	});

	return {
		shutdown() {
			try {
				redis.unsubscribe(CHANNEL);
				redis.disconnect();
			} catch (_) {}
		}
	};
}
