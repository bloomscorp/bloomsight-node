import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'vitest';

import {Bloomsight, BloomsightError} from '../src';

/**
 * Against a local fake of the blooms.ai API: nothing leaves the machine.
 * Each test queues the answers the fake gives, in order.
 */

const KEY = `blm_live_${'a'.repeat(64)}`;
const TEST_KEY = `blm_test_${'b'.repeat(64)}`;

interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: any }
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'hang' | 'close';

let server: Server;
let base: string;
let seen: Seen[] = [];
let answers: Answer[] = [];

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', c => chunks.push(c));
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString();
			seen.push({method: req.method!, path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined});
			const answer = answers.shift() ?? {status: 200, body: {success: true, data: {}}};
			if (answer === 'hang') return;
			if (answer === 'close') { req.socket.destroy(); return; }
			res.writeHead(answer.status, {'Content-Type': 'application/json', ...(answer.headers || {})});
			res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
		});
	});
	await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => { seen = []; answers = []; });

const waits: number[] = [];
function client(extra: Record<string, unknown> = {}): Bloomsight {
	const c = new Bloomsight({apiKey: KEY, baseUrl: base, ...extra});
	waits.length = 0;
	c._setSleep(async ms => { waits.push(ms); });
	return c;
}
const ok = (data: unknown, headers?: Record<string, string>): Answer => ({status: 202, body: {success: true, data}, headers});

describe('construction', () => {
	test('a missing or malformed key is refused, without echoing it', () => {
		expect(() => new Bloomsight({apiKey: ''})).toThrow(BloomsightError);
		try { new Bloomsight({apiKey: 'sk_live_secret-value'}); } catch (e: any) {
			expect(e.code).toBe('INVALID_API_KEY');
			expect(e.message).not.toContain('secret-value');
		}
	});

	test('it refuses to run in a browser', () => {
		(globalThis as any).window = {};
		(globalThis as any).document = {};
		try {
			expect(() => new Bloomsight({apiKey: KEY})).toThrow(expect.objectContaining({code: 'BROWSER_NOT_ALLOWED'}));
		} finally {
			delete (globalThis as any).window;
			delete (globalThis as any).document;
		}
	});

	test('it knows a test key', () => {
		expect(new Bloomsight({apiKey: TEST_KEY}).isTestKey).toBe(true);
		expect(new Bloomsight({apiKey: KEY}).isTestKey).toBe(false);
	});
});

describe('sendMail', () => {
	test('posts the template, mailbox and values with the key and an idempotency key', async () => {
		answers = [ok({id: 'job1', status: 'queued', missingVariables: []})];
		const send = await client().sendMail({templateId: 't1', engineId: 'e1', data: {name: 'Asha', lines: [{item: 'Saree', qty: 2}]}});
		expect(send).toMatchObject({id: 'job1', status: 'queued', replayed: false});
		const r = seen[0]!;
		expect(r.method).toBe('POST');
		expect(r.path).toBe('/api/v1/bloomsight/email/send');
		expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(r.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
		expect(r.headers['user-agent']).toMatch(/^bloomsight-node\//);
		expect(r.headers.origin).toBeUndefined();
		expect(r.body).toEqual({templateId: 't1', engineId: 'e1', data: {name: 'Asha', lines: [{item: 'Saree', qty: 2}]}});
	});

	test('your own idempotency key is used as given, and a replay is reported', async () => {
		answers = [ok({id: 'job1', status: 'sent'}, {'Idempotent-Replayed': 'true'})];
		const send = await client().sendMail({templateId: 't', engineId: 'e', idempotencyKey: 'order-A-1042-confirmation'});
		expect(seen[0]!.headers['idempotency-key']).toBe('order-A-1042-confirmation');
		expect(seen[0]!.body).not.toHaveProperty('idempotencyKey');
		expect(send.replayed).toBe(true);
	});

	test('a 503 is retried with the same idempotency key, then succeeds', async () => {
		answers = [{status: 503, body: {success: false, message: 'busy'}}, {status: 502, body: 'Bad gateway'}, ok({id: 'job2', status: 'queued'})];
		const send = await client().sendMail({templateId: 't', engineId: 'e'});
		expect(send.id).toBe('job2');
		expect(seen).toHaveLength(3);
		expect(new Set(seen.map(s => s.headers['idempotency-key'])).size).toBe(1);
		expect(waits).toHaveLength(2);
		expect(waits[0]).toBeGreaterThanOrEqual(500);
		expect(waits[1]).toBeGreaterThanOrEqual(1000);
	});

	test('a 429 waits for Retry-After', async () => {
		answers = [{status: 429, body: {success: false, code: 'RATE_LIMITED', message: 'slow down'}, headers: {'Retry-After': '7'}}, ok({id: 'j', status: 'queued'})];
		await client().sendMail({templateId: 't', engineId: 'e'});
		expect(waits).toEqual([7000]);
	});

	test('a Retry-After longer than the cap is not waited out: it throws with retryAfter', async () => {
		answers = [{status: 429, body: {success: false, code: 'MAILBOX_LIMIT', message: 'daily limit'}, headers: {'Retry-After': '86400'}}];
		const err = await client().sendMail({templateId: 't', engineId: 'e'}).catch(e => e);
		expect(err).toBeInstanceOf(BloomsightError);
		expect(err).toMatchObject({code: 'MAILBOX_LIMIT', status: 429, retryAfter: 86400});
		expect(err.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
		expect(waits).toEqual([]);
	});

	test('a dropped connection is retried, then reported as NETWORK_FAILURE', async () => {
		answers = ['close', 'close', 'close', 'close'];
		const err = await client().sendMail({templateId: 't', engineId: 'e'}).catch(e => e);
		expect(err.code).toBe('NETWORK_FAILURE');
		expect(seen).toHaveLength(4);
		expect(new Set(seen.map(s => s.headers['idempotency-key'])).size).toBe(1);
		expect(err.message).not.toContain(KEY);
	});

	test('a slow answer times out', async () => {
		answers = ['hang', 'hang'];
		const err = await client({timeoutMs: 100, maxRetries: 1}).sendMail({templateId: 't', engineId: 'e'}).catch(e => e);
		expect(err.code).toBe('TIMEOUT');
		expect(seen).toHaveLength(2);
	});

	test('a 4xx is not retried, and its code and details come through', async () => {
		answers = [{status: 422, body: {success: false, code: 'INVALID_VARIABLES', message: "'bad-name' is not a valid variable name"}}];
		const err = await client().sendMail({templateId: 't', engineId: 'e', data: {'bad-name': 1}}).catch(e => e);
		expect(err).toMatchObject({code: 'INVALID_VARIABLES', status: 422});
		expect(seen).toHaveLength(1);
	});

	test('a response that is not blooms.ai JSON is BAD_RESPONSE', async () => {
		answers = [{status: 404, body: '<html>Not found</html>'}];
		const err = await client().sendMail({templateId: 't', engineId: 'e'}).catch(e => e);
		expect(err).toMatchObject({code: 'BAD_RESPONSE', status: 404});
	});

	test('the key never appears in an error, even if the server echoes it', async () => {
		answers = [{status: 401, body: {success: false, code: 'INVALID_API_KEY', message: `Invalid key ${KEY}`}}];
		const err = await client().sendMail({templateId: 't', engineId: 'e'}).catch(e => e);
		expect(err.message).not.toContain(KEY);
		expect(err.message).toContain('blm_***');
	});
});

describe('batches, sends, limits and unsubscribes', () => {
	test('sendBatch posts the rows with an idempotency key; INVALID_ROWS carries the faults', async () => {
		answers = [{status: 422, body: {success: false, code: 'INVALID_ROWS', message: '1 row(s) cannot be sent', faults: [{row: 3, code: 'INVALID_ADDRESS', message: 'bad'}]}}];
		const err = await client().sendBatch({templateId: 't', engineId: 'e', name: 'Nov', recipients: [{data: {email: 'a@x.test'}}]}).catch(e => e);
		expect(seen[0]!.path).toBe('/api/v1/bloomsight/email/batches');
		expect(seen[0]!.headers['idempotency-key']).toBeTruthy();
		expect(seen[0]!.body).toEqual({templateId: 't', engineId: 'e', name: 'Nov', recipients: [{data: {email: 'a@x.test'}}]});
		expect(err.code).toBe('INVALID_ROWS');
		expect(err.details.faults[0].row).toBe(3);
	});

	test('the batch controls and reads hit their paths', async () => {
		const c = client();
		answers = [ok({id: 'b1'}), ok({id: 'b1'}), ok({id: 'b1'}), ok({id: 'b1'}), ok({id: 'j1'}), ok([])];
		await c.getBatch('b1'); await c.pauseBatch('b1'); await c.resumeBatch('b1'); await c.cancelBatch('b1');
		await c.getSend('j1'); await c.getLimits();
		expect(seen.map(s => `${s.method} ${s.path}`)).toEqual([
			'GET /api/v1/bloomsight/email/batches/b1',
			'POST /api/v1/bloomsight/email/batches/b1/pause',
			'POST /api/v1/bloomsight/email/batches/b1/resume',
			'POST /api/v1/bloomsight/email/batches/b1/cancel',
			'GET /api/v1/bloomsight/email/sends/j1',
			'GET /api/v1/bloomsight/email/limits',
		]);
	});

	test('unsubscribes: list with paging, add, remove (false when not on the list)', async () => {
		const c = client();
		answers = [
			ok([{address: 'a@x.test', reason: 'api', createdAt: '2026-11-08T00:00:00Z'}]),
			ok({added: true}),
			ok({removed: true}),
			{status: 404, body: {success: false, code: 'NOT_ON_LIST', message: 'not on the list'}},
		];
		const list = await c.listUnsubscribes({limit: 10, before: '2026-11-09T00:00:00Z'});
		expect(list[0]!.address).toBe('a@x.test');
		expect(seen[0]!.path).toBe('/api/v1/bloomsight/email/unsubscribes?limit=10&before=2026-11-09T00%3A00%3A00Z');
		expect(await c.addUnsubscribe('a@x.test')).toBe(true);
		expect(await c.removeUnsubscribe('a+b@x.test')).toBe(true);
		expect(seen[2]!.path).toBe('/api/v1/bloomsight/email/unsubscribes/a%2Bb%40x.test');
		expect(await c.removeUnsubscribe('nobody@x.test')).toBe(false);
	});
});
