/**
 * Request and response types for the Bloomsight email API
 * (blooms.ai documentation/bloomsight/backend-sending.md §4, §7, §8).
 */

/** Template values: text, numbers, true/false, null, and lists/objects of those (up to 4 levels). */
export type TemplateValue = string | number | boolean | null | TemplateValue[] | { [key: string]: TemplateValue };
export type TemplateData = Record<string, TemplateValue>;

export interface BloomsightOptions {
	/** A project API key with the `bloomsight-email` scope: `blm_live_…` or `blm_test_…`. */
	apiKey: string;
	/** Defaults to `https://z.bloomscorp.com`. */
	baseUrl?: string;
	/** Per attempt. Default 15 seconds. */
	timeoutMs?: number;
	/** Retries after the first attempt, for network errors, 429 and 5xx. Default 3. */
	maxRetries?: number;
	/** The longest `Retry-After` the library will wait out by itself. Default 60 seconds. */
	maxRetryWaitMs?: number;
	/** A `fetch` to use instead of the global one (tests, proxies). */
	fetch?: typeof fetch;
}

export interface SendMailInput {
	templateId: string;
	engineId: string;
	data?: TemplateData;
	/**
	 * Makes the send safe to repeat: the same key and body returns the original send
	 * for 24 hours. One is generated when you don't pass one; pass your own (for
	 * example `order-A-1042-confirmation`) so even a restarted process cannot send twice.
	 */
	idempotencyKey?: string;
}

export type SendStatus = 'queued' | 'paused' | 'sending' | 'sent' | 'failed' | 'unknown' | 'cancelled' | 'test';

export interface Send {
	id: string;
	status: SendStatus;
	templateId?: string;
	engineId?: string;
	priority?: 'transactional' | 'bulk';
	attempts?: number;
	recipientCount?: number;
	nextAttemptAt?: string | null;
	errorCode?: string | null;
	error?: string | null;
	createdAt?: string;
	finishedAt?: string | null;
	/** True when sent with a `blm_test_…` key: checked, nothing sent. */
	test?: boolean;
	/** Template values the template uses that this send did not supply. */
	missingVariables?: string[];
	/** True when an Idempotency-Key matched an earlier send and nothing new was queued. */
	replayed?: boolean;
}

export interface BatchRecipient {
	data: TemplateData;
}

export interface SendBatchInput {
	templateId: string;
	engineId: string;
	name?: string;
	/** 1 to 5,000 rows. Each row's values follow the `sendMail` rules. */
	recipients: BatchRecipient[];
	idempotencyKey?: string;
}

export interface BatchProgress {
	queued: number;
	paused: number;
	sending: number;
	sent: number;
	failed: number;
	unknown: number;
	cancelled: number;
}

export interface Batch {
	id: string | null;
	name?: string;
	status: 'running' | 'paused' | 'cancelled' | 'done' | 'test';
	templateId?: string;
	engineId?: string;
	rows: number;
	accepted: number;
	duplicates: number;
	suppressed: number;
	progress?: BatchProgress;
	expectedFinishAt?: string | null;
	createdAt?: string;
	cancelledAt?: string | null;
	test?: boolean;
	replayed?: boolean;
}

export interface MailboxLimits {
	engineId: string;
	name: string;
	fromEmail: string;
	/** `null` = not limited. */
	limits: {
		kind: 'workspace' | 'consumer' | 'smtp';
		perMinute: number | null;
		perDay: number | null;
		recipientsPerDay: number | null;
		uniqueRecipientsPerDay: number | null;
		publicPerDay: number | null;
		bulkPerDay: number | null;
	};
	used: { minute: number; day: number; recipients: number; unique: number; public: number; bulk: number };
	heldForMs: number;
}

export interface Unsubscribe {
	address: string;
	reason: 'unsubscribe' | 'manual' | 'api';
	createdAt: string;
}
