import {randomUUID} from 'node:crypto';

import {BloomsightError} from './error';
import type {
	Batch, BloomsightOptions, MailboxLimits, Send, SendBatchInput, SendMailInput, Unsubscribe,
} from './types';
import {VERSION} from './version';

/**
 * A thin, typed client for sending Bloomsight email from a backend
 * (blooms.ai documentation/bloomsight/backend-sending.md §10).
 *
 * - Every send carries an Idempotency-Key (yours, or one made here), kept the same
 *   across retries, so a retry can never send twice.
 * - Network errors, 429 and 5xx are retried with backoff, honouring Retry-After.
 * - Failures throw `BloomsightError` with a `code`; the key never appears in one.
 * - It refuses to run in a browser, where the key would be exposed.
 */

const DEFAULT_BASE = 'https://z.bloomscorp.com';
const KEY_PATTERN = /^blm_(live|test)_[0-9a-f]{64}$/;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

interface RequestOptions {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	body?: unknown;
	idempotencyKey?: string;
	query?: Record<string, string | number | undefined>;
}

/** Internal seam for tests: how the client waits between attempts. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class Bloomsight {
	readonly #apiKey: string;
	readonly #base: string;
	readonly #timeoutMs: number;
	readonly #maxRetries: number;
	readonly #maxRetryWaitMs: number;
	readonly #fetch: typeof fetch;
	#sleep: Sleep = realSleep;

	constructor(options: BloomsightOptions) {
		if (typeof (globalThis as any).window !== 'undefined' && typeof (globalThis as any).document !== 'undefined') {
			throw new BloomsightError('BROWSER_NOT_ALLOWED',
				'@bloomscorp/bloomsight-node runs on servers only: in a browser your API key would be exposed. Use bloomsight.js for browser forms.');
		}
		const key = String(options?.apiKey ?? '').trim();
		if (!KEY_PATTERN.test(key)) {
			throw new BloomsightError('INVALID_API_KEY',
				'apiKey must be a Bloomsight API key (blm_live_… or blm_test_…). Create one with the bloomsight-email scope in Project Settings → API keys.');
		}
		const f = options.fetch ?? globalThis.fetch;
		if (typeof f !== 'function') {
			throw new BloomsightError('NO_FETCH', 'No fetch is available. Use Node.js 18 or later, or pass `fetch` in the options.');
		}
		this.#apiKey = key;
		this.#base = String(options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
		this.#timeoutMs = options.timeoutMs ?? 15000;
		this.#maxRetries = Math.max(0, options.maxRetries ?? 3);
		this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 60000;
		this.#fetch = f;
	}

	/** True for a `blm_test_…` key: everything is checked and nothing is sent. */
	get isTestKey(): boolean {
		return this.#apiKey.startsWith('blm_test_');
	}

	// ── Sending ──────────────────────────────────────────────────────────────

	/**
	 * Queue one email. It goes out within about a second when the mailbox has
	 * budget; follow it with `getSend(id)`.
	 */
	async sendMail(input: SendMailInput): Promise<Send> {
		const {idempotencyKey, ...body} = input;
		const {data, headers} = await this.#request<Send>({
			method: 'POST', path: '/send', body, idempotencyKey: idempotencyKey ?? randomUUID(),
		});
		return {...data, replayed: headers.get('idempotent-replayed') === 'true'};
	}

	async getSend(id: string): Promise<Send> {
		return (await this.#request<Send>({method: 'GET', path: `/sends/${encodeURIComponent(id)}`})).data;
	}

	/** Send one template to many recipients. Checked whole first; one bad row refuses all. */
	async sendBatch(input: SendBatchInput): Promise<Batch> {
		const {idempotencyKey, ...body} = input;
		const {data, headers} = await this.#request<Batch>({
			method: 'POST', path: '/batches', body, idempotencyKey: idempotencyKey ?? randomUUID(),
		});
		return {...data, replayed: headers.get('idempotent-replayed') === 'true'};
	}

	async getBatch(id: string): Promise<Batch> {
		return (await this.#request<Batch>({method: 'GET', path: `/batches/${encodeURIComponent(id)}`})).data;
	}

	async pauseBatch(id: string): Promise<Batch> {
		return (await this.#request<Batch>({method: 'POST', path: `/batches/${encodeURIComponent(id)}/pause`})).data;
	}

	async resumeBatch(id: string): Promise<Batch> {
		return (await this.#request<Batch>({method: 'POST', path: `/batches/${encodeURIComponent(id)}/resume`})).data;
	}

	/** Stops every email of the batch that has not started. Cannot be undone. */
	async cancelBatch(id: string): Promise<Batch> {
		return (await this.#request<Batch>({method: 'POST', path: `/batches/${encodeURIComponent(id)}/cancel`})).data;
	}

	// ── Budgets and the unsubscribe list ─────────────────────────────────────

	async getLimits(): Promise<MailboxLimits[]> {
		return (await this.#request<MailboxLimits[]>({method: 'GET', path: '/limits'})).data;
	}

	async listUnsubscribes(options: {limit?: number; before?: string} = {}): Promise<Unsubscribe[]> {
		return (await this.#request<Unsubscribe[]>({method: 'GET', path: '/unsubscribes', query: options})).data;
	}

	/** Returns false when the address was already on the list. */
	async addUnsubscribe(address: string): Promise<boolean> {
		return (await this.#request<{added: boolean}>({method: 'POST', path: '/unsubscribes', body: {address}})).data.added;
	}

	/** Only when the person has opted back in. Returns false when it was not on the list. */
	async removeUnsubscribe(address: string): Promise<boolean> {
		try {
			return (await this.#request<{removed: boolean}>({method: 'DELETE', path: `/unsubscribes/${encodeURIComponent(address)}`})).data.removed;
		} catch (err) {
			if (err instanceof BloomsightError && err.code === 'NOT_ON_LIST') return false;
			throw err;
		}
	}

	// ── Transport ────────────────────────────────────────────────────────────

	/** @internal test seam */
	_setSleep(sleep: Sleep): void {
		this.#sleep = sleep;
	}

	#redact(text: string): string {
		return String(text).split(this.#apiKey).join('blm_***');
	}

	async #request<T>(req: RequestOptions): Promise<{data: T; headers: Headers}> {
		const url = new URL(`${this.#base}/api/v1/bloomsight/email${req.path}`);
		for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.#apiKey}`,
			Accept: 'application/json',
			'User-Agent': `bloomsight-node/${VERSION}`,
		};
		if (req.body !== undefined) headers['Content-Type'] = 'application/json';
		if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;
		const body = req.body === undefined ? undefined : JSON.stringify(req.body);
		// GETs are safe to repeat; POSTs only with an idempotency key, which every
		// send has; the batch controls (pause/resume/cancel) and list edits are
		// idempotent by nature.
		const retryable = true;

		let attempt = 0;
		for (;;) {
			let response: Response;
			try {
				response = await this.#fetch(url, {method: req.method, headers, body, signal: AbortSignal.timeout(this.#timeoutMs)});
			} catch (cause) {
				const timedOut = (cause as Error)?.name === 'TimeoutError' || (cause as Error)?.name === 'AbortError';
				if (retryable && attempt < this.#maxRetries) {
					await this.#sleep(this.#backoff(attempt++));
					continue;
				}
				throw new BloomsightError(timedOut ? 'TIMEOUT' : 'NETWORK_FAILURE',
					this.#redact(`${timedOut ? 'blooms.ai did not answer in time' : 'could not reach blooms.ai'}: ${(cause as Error)?.message || cause}`),
					{idempotencyKey: req.idempotencyKey});
			}

			let parsed: any = null;
			try { parsed = await response.json(); } catch { parsed = null; }

			if (response.ok && parsed?.success === true) {
				return {data: parsed.data as T, headers: response.headers};
			}

			const retryAfter = Number(response.headers.get('retry-after'));
			const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
			if (RETRY_STATUSES.has(response.status) && retryable && attempt < this.#maxRetries
				&& (waitMs === null || waitMs <= this.#maxRetryWaitMs)) {
				await this.#sleep(waitMs ?? this.#backoff(attempt));
				attempt++;
				continue;
			}

			if (!parsed || typeof parsed !== 'object') {
				throw new BloomsightError('BAD_RESPONSE', `blooms.ai answered HTTP ${response.status} without its usual JSON`,
					{status: response.status, idempotencyKey: req.idempotencyKey});
			}
			const {success, code, message, data, ...rest} = parsed;
			throw new BloomsightError(code || `HTTP_${response.status}`, this.#redact(message || `request failed (HTTP ${response.status})`), {
				status: response.status,
				retryAfter: waitMs === null ? undefined : retryAfter,
				idempotencyKey: req.idempotencyKey,
				details: Object.keys(rest).length ? rest : undefined,
			});
		}
	}

	/** 0.5 s, 1 s, 2 s, 4 s … with up to 25% jitter, capped at 10 s. */
	#backoff(attempt: number): number {
		const base = Math.min(10000, 500 * 2 ** attempt);
		return Math.round(base * (1 + Math.random() * 0.25));
	}
}
