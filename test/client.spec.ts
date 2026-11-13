import {mkdtemp, rm, truncate, writeFile} from 'node:fs/promises';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'vitest';

import {Bloomsight, BloomsightError} from '../src';

/**
 * Against a local fake of the blooms.ai API: nothing leaves the machine.
 * Each test queues the answers the fake gives, in order.
 */

const KEY = `blm_live_${'a'.repeat(64)}`;
const TEST_KEY = `blm_test_${'b'.repeat(64)}`;

interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: any; form?: FormData; raw: Buffer }
type Answer = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number } | 'hang' | 'close';

let server: Server;
let base: string;
let seen: Seen[] = [];
let answers: Answer[] = [];

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', c => chunks.push(c));
		req.on('end', async () => {
			const raw = Buffer.concat(chunks);
			const type = String(req.headers['content-type'] ?? '');
			const entry: Seen = {method: req.method!, path: req.url!, headers: req.headers, body: undefined, raw};
			// Take the answer before any await, so answers stay in arrival order.
			const answer = answers.shift() ?? {status: 200, body: {success: true, data: {}}};
			if (type.startsWith('multipart/form-data')) entry.form = await new Response(raw, {headers: {'content-type': type}}).formData();
			else if (raw.length) entry.body = JSON.parse(raw.toString());
			seen.push(entry);
			if (answer === 'hang') return;
			if (answer === 'close') { req.socket.destroy(); return; }
			if (answer.delayMs) await new Promise(r => setTimeout(r, answer.delayMs));
			if (res.destroyed) return;
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

describe('sendMail with attachments', () => {
	const MB = 1024 * 1024;
	const pdf = Buffer.from('%PDF-1.7\n' + 'x'.repeat(2000) + '\n%%EOF', 'latin1');
	const sentOk = (extra: Record<string, unknown> = {}): Answer =>
		({status: 200, body: {success: true, data: {id: 'job9', status: 'sent', attachmentCount: 1, test: false, missingVariables: [], ...extra}}});
	const fileOf = (form: FormData, i: number) => form.getAll('attachments')[i] as File;
	const later = (a: Answer, delayMs: number): Answer => ({...(a as Exclude<Answer, string>), delayMs});
	const bytesOf = async (form: FormData, i: number) => Buffer.from(await fileOf(form, i).arrayBuffer());

	let dir: string;
	beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'bloomsight-node-test-')); });
	afterAll(() => rm(dir, {recursive: true, force: true}));

	test('is sent as multipart: fields, data as JSON text, one attachments part per file with name, type and exact bytes', async () => {
		answers = [sentOk({attachmentCount: 2})];
		const csv = 'item,qty\nSaree,2\n';
		const send = await client().sendMail({
			templateId: 't1', engineId: 'e1', idempotencyKey: 'order-A-1042-invoice',
			data: {name: 'Asha', lines: [{item: 'Saree', qty: 2}], paid: true, note: null},
			attachments: [{filename: 'invoice-A-1042.pdf', content: pdf}, {filename: 'lines.csv', content: csv, contentType: 'text/csv; charset=utf-8'}],
		});
		expect(send).toMatchObject({id: 'job9', status: 'sent', attachmentCount: 2, test: false, replayed: false});

		const r = seen[0]!;
		expect(r.method).toBe('POST');
		expect(r.path).toBe('/api/v1/bloomsight/email/send');
		expect(r.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
		expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(r.headers.accept).toBe('application/json');
		expect(r.headers['user-agent']).toMatch(/^bloomsight-node\//);
		expect(r.headers['idempotency-key']).toBe('order-A-1042-invoice');
		expect(r.headers.origin).toBeUndefined();

		const form = r.form!;
		const names: string[] = [];
		form.forEach((_value, name) => { if (!names.includes(name)) names.push(name); });
		expect(names).toEqual(['templateId', 'engineId', 'data', 'attachments']);
		expect(form.get('templateId')).toBe('t1');
		expect(form.get('engineId')).toBe('e1');
		expect(JSON.parse(form.get('data') as string)).toEqual({name: 'Asha', lines: [{item: 'Saree', qty: 2}], paid: true, note: null});
		expect(form.has('priority')).toBe(false);
		expect(form.has('idempotencyKey')).toBe(false);
		expect(form.getAll('attachments')).toHaveLength(2);
		expect(fileOf(form, 0).name).toBe('invoice-A-1042.pdf');
		expect(fileOf(form, 0).type).toBe('application/pdf');
		expect((await bytesOf(form, 0)).equals(pdf)).toBe(true);
		expect(fileOf(form, 1).name).toBe('lines.csv');
		// Read from the wire: Node 18's FormData parser drops a type's parameters.
		expect(r.raw.toString('latin1')).toContain('Content-Disposition: form-data; name="attachments"; filename="lines.csv"\r\nContent-Type: text/csv; charset=utf-8\r\n');
		expect((await bytesOf(form, 1)).toString('utf8')).toBe(csv);
	});

	test('data is left out when not given; priority only when given', async () => {
		answers = [sentOk(), sentOk()];
		const c = client();
		await c.sendMail({templateId: 't', engineId: 'e', attachments: [{filename: 'a.txt', content: 'hi'}]});
		expect(seen[0]!.form!.has('data')).toBe(false);
		expect(seen[0]!.form!.has('priority')).toBe(false);
		await c.sendMail({templateId: 't', engineId: 'e', priority: 'transactional', attachments: [{filename: 'a.txt', content: 'hi'}]});
		expect(seen[1]!.form!.get('priority')).toBe('transactional');
	});

	test('a send without attachments (or with an empty list) is still JSON', async () => {
		answers = [ok({id: 'j1', status: 'queued'}), ok({id: 'j2', status: 'queued'})];
		const c = client();
		await c.sendMail({templateId: 't', engineId: 'e', data: {a: 1}});
		await c.sendMail({templateId: 't', engineId: 'e', data: {a: 1}, attachments: []});
		for (const r of seen) {
			expect(r.headers['content-type']).toBe('application/json');
			expect(r.form).toBeUndefined();
			expect(r.body).toEqual({templateId: 't', engineId: 'e', data: {a: 1}});
		}
	});

	test('a path is read at send time; every content form works; the type is guessed from the name', async () => {
		const onDisk = join(dir, 'statement.pdf');
		await writeFile(onDisk, pdf);
		const blobBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		answers = [sentOk({attachmentCount: 5})];
		await client().sendMail({templateId: 't', engineId: 'e', attachments: [
			{filename: 'Statement Nov.pdf', path: onDisk},
			{filename: 'photo.JPG', content: new Uint8Array([0xff, 0xd8, 0xff, 0xe0])},
			{filename: 'chart.png', content: new Blob([blobBytes])},
			{filename: 'meeting.ics', content: new Uint8Array([66, 69, 71, 73, 78]).buffer},
			{filename: 'data.bin', content: 'नमस्ते'},
		]});
		const form = seen[0]!.form!;
		const files = form.getAll('attachments') as File[];
		expect(files.map(f => [f.name, f.type])).toEqual([
			['Statement Nov.pdf', 'application/pdf'],
			['photo.JPG', 'image/jpeg'],
			['chart.png', 'image/png'],
			['meeting.ics', 'text/calendar'],
			['data.bin', 'application/octet-stream'],
		]);
		expect((await bytesOf(form, 0)).equals(pdf)).toBe(true);
		expect([...await bytesOf(form, 1)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
		expect((await bytesOf(form, 2)).equals(blobBytes)).toBe(true);
		expect((await bytesOf(form, 3)).toString()).toBe('BEGIN');
		expect((await bytesOf(form, 4)).toString('utf8')).toBe('नमस्ते');
	});

	test('the limits are inclusive: 5 files, a 5 MB file, 15 MB in all, a 150-character name', async () => {
		answers = [sentOk(), sentOk()];
		const c = client();
		const fiveMb = Buffer.alloc(5 * MB, 7);
		await c.sendMail({templateId: 't', engineId: 'e', attachments: [
			{filename: 'a.pdf', content: fiveMb}, {filename: 'b.pdf', content: fiveMb}, {filename: `${'n'.repeat(146)}.pdf`, content: fiveMb},
		]});
		const form = seen[0]!.form!;
		expect((form.getAll('attachments') as File[]).map(f => f.size)).toEqual([5 * MB, 5 * MB, 5 * MB]);
		expect(fileOf(form, 2).name).toHaveLength(150);
		await c.sendMail({templateId: 't', engineId: 'e', attachments: Array.from({length: 5}, (_, i) => ({filename: `f${i}.txt`, content: 'x'}))});
		expect(seen[1]!.form!.getAll('attachments')).toHaveLength(5);
	});

	const one = (a: Record<string, unknown>) => [a as any];
	test.each([
		['six files', () => Array.from({length: 6}, (_, i) => ({filename: `f${i}.txt`, content: 'x'})), 'TOO_MANY_ATTACHMENTS'],
		['a file over 5 MB', () => one({filename: 'big.pdf', content: Buffer.alloc(5 * MB + 1)}), 'ATTACHMENT_TOO_LARGE'],
		['a Blob over 5 MB', () => one({filename: 'big.pdf', content: new Blob([Buffer.alloc(5 * MB + 1)])}), 'ATTACHMENT_TOO_LARGE'],
		['over 15 MB together', () => Array.from({length: 4}, (_, i) => ({filename: `p${i}.pdf`, content: Buffer.alloc(4 * MB)})), 'ATTACHMENTS_TOO_LARGE'],
		['an empty file', () => one({filename: 'empty.txt', content: ''}), 'INVALID_ATTACHMENT'],
		['an empty Buffer', () => one({filename: 'empty.pdf', content: Buffer.alloc(0)}), 'INVALID_ATTACHMENT'],
		['no filename', () => one({content: 'x'}), 'INVALID_ATTACHMENT'],
		['a filename that cleans to nothing', () => one({filename: ' "\u0001" ', content: 'x'}), 'INVALID_ATTACHMENT'],
		['a filename that is only a folder', () => one({filename: 'invoices/', content: 'x'}), 'INVALID_ATTACHMENT'],
		['a 151-character filename', () => one({filename: `${'n'.repeat(147)}.pdf`, content: 'x'}), 'INVALID_ATTACHMENT'],
		['both content and path', () => one({filename: 'a.txt', content: 'x', path: '/etc/hosts'}), 'INVALID_ATTACHMENT'],
		['neither content nor path', () => one({filename: 'a.txt'}), 'INVALID_ATTACHMENT'],
		['content of an unsupported type', () => one({filename: 'a.txt', content: 42}), 'INVALID_ATTACHMENT'],
		['an invalid contentType', () => one({filename: 'a.txt', content: 'x', contentType: 'text/plain\r\nX-Evil: 1'}), 'INVALID_ATTACHMENT'],
		['a path that does not exist', () => one({filename: 'a.pdf', path: join(dir, 'missing.pdf')}), 'INVALID_ATTACHMENT'],
		['a path that is a folder', () => one({filename: 'a.pdf', path: dir}), 'INVALID_ATTACHMENT'],
		['a .exe behind a .pdf', () => one({filename: 'invoice.pdf.exe', content: 'x'}), 'ATTACHMENT_TYPE_BLOCKED'],
		['a .exe with a trailing dot and space (Windows drops them)', () => one({filename: 'invoice.exe. ', content: 'x'}), 'ATTACHMENT_TYPE_BLOCKED'],
		['a name that is all extension', () => one({filename: '.exe', content: 'x'}), 'ATTACHMENT_TYPE_BLOCKED'],
		['an upper-case .JS', () => one({filename: 'SETUP.JS', content: 'x'}), 'ATTACHMENT_TYPE_BLOCKED'],
		['.ex_', () => one({filename: 'old.ex_', content: 'x'}), 'ATTACHMENT_TYPE_BLOCKED'],
		['a blocked type revealed by cleaning', () => one({filename: 'report.pdf.e"xe', content: 'x'}), 'ATTACHMENT_TYPE_BLOCKED'],
	])('refused before any request: %s', async (_label, make, code) => {
		const err = await client().sendMail({templateId: 't', engineId: 'e', attachments: make()}).catch(e => e);
		expect(err).toBeInstanceOf(BloomsightError);
		expect(err.code).toBe(code);
		expect(seen).toHaveLength(0);
	});

	test('a file on disk over 5 MB is refused without being read or sent', async () => {
		const huge = join(dir, 'huge.pdf');
		await writeFile(huge, '');
		await truncate(huge, 6 * MB);
		const err = await client().sendMail({templateId: 't', engineId: 'e', attachments: [{filename: 'huge.pdf', path: huge}]}).catch(e => e);
		expect(err).toMatchObject({code: 'ATTACHMENT_TOO_LARGE', details: {attachment: 0, filename: 'huge.pdf'}});
		expect(seen).toHaveLength(0);
	});

	test('the filename is cleaned: folders, control characters and quotes removed, trimmed', async () => {
		answers = [sentOk({attachmentCount: 3})];
		await client().sendMail({templateId: 't', engineId: 'e', attachments: [
			{filename: '../../etc/passwd', content: 'root:x'},
			{filename: 'C:\\Users\\asha\\My "best" invoice\u0007\r\n.pdf ', content: pdf},
			{filename: '  tab\there.txt\u007f', content: 'x'},
		]});
		const names = (seen[0]!.form!.getAll('attachments') as File[]).map(f => f.name);
		expect(names).toEqual(['passwd', 'My best invoice.pdf', 'tabhere.txt']);
		expect(fileOf(seen[0]!.form!, 1).type).toBe('application/pdf');
	});

	test('503 SERVER_BUSY is retried after Retry-After with the same key and identical bytes', async () => {
		const original = Buffer.from(pdf);
		const callerBuffer = Buffer.from(pdf);
		answers = [
			{status: 503, body: {success: false, code: 'SERVER_BUSY', message: 'busy'}, headers: {'Retry-After': '5'}},
			{status: 429, body: {success: false, code: 'MAILBOX_BUSY', message: 'wait'}, headers: {'Retry-After': '2'}},
			sentOk(),
		];
		const c = client();
		// The caller scribbles over its buffer while the library waits: the retry must not care.
		c._setSleep(async ms => { waits.push(ms); callerBuffer.fill(0); });
		const send = await c.sendMail({templateId: 't', engineId: 'e', data: {n: 1}, attachments: [{filename: 'inv.pdf', content: callerBuffer}]});
		expect(send.status).toBe('sent');
		expect(seen).toHaveLength(3);
		expect(waits).toEqual([5000, 2000]);
		expect(new Set(seen.map(r => r.headers['idempotency-key'])).size).toBe(1);
		for (const r of seen) {
			expect(r.form!.get('templateId')).toBe('t');
			expect(r.form!.get('data')).toBe('{"n":1}');
			expect(fileOf(r.form!, 0).name).toBe('inv.pdf');
			expect((await bytesOf(r.form!, 0)).equals(original)).toBe(true);
		}
	});

	test('a Retry-After past the cap is thrown with retryAfter, as for any send', async () => {
		answers = [{status: 429, body: {success: false, code: 'MAILBOX_LIMIT', message: 'daily limit'}, headers: {'Retry-After': '3600'}}];
		const err = await client().sendMail({templateId: 't', engineId: 'e', attachments: [{filename: 'a.pdf', content: pdf}]}).catch(e => e);
		expect(err).toMatchObject({code: 'MAILBOX_LIMIT', status: 429, retryAfter: 3600});
		expect(seen).toHaveLength(1);
	});

	test('attachment sends wait attachmentTimeoutMs, not timeoutMs', async () => {
		// timeoutMs is short, attachmentTimeoutMs long: a 400 ms answer is waited for.
		answers = [later(sentOk(), 400)];
		const send = await client({timeoutMs: 100, attachmentTimeoutMs: 5000, maxRetries: 0})
			.sendMail({templateId: 't', engineId: 'e', attachments: [{filename: 'a.pdf', content: pdf}]});
		expect(send.status).toBe('sent');
	});

	test('attachmentTimeoutMs times an attachment send out, while a plain send keeps timeoutMs', async () => {
		const c = client({timeoutMs: 5000, attachmentTimeoutMs: 100, maxRetries: 1});
		answers = ['hang', 'hang'];
		const started = Date.now();
		const err = await c.sendMail({templateId: 't', engineId: 'e', attachments: [{filename: 'a.pdf', content: pdf}]}).catch(e => e);
		expect(err.code).toBe('TIMEOUT');
		expect(Date.now() - started).toBeLessThan(2000);
		expect(seen).toHaveLength(2);
		expect(new Set(seen.map(r => r.headers['idempotency-key'])).size).toBe(1);
		answers = [later(ok({id: 'j', status: 'queued'}), 400)];
		expect((await c.sendMail({templateId: 't', engineId: 'e'})).status).toBe('queued');
	});

	test.each(['failed', 'unknown', 'sending'])('status %s is returned as data, not thrown', async status => {
		answers = [sentOk({status, errorCode: status === 'failed' ? 'ADDRESS_REFUSED' : null})];
		const send = await client().sendMail({templateId: 't', engineId: 'e', attachments: [{filename: 'a.pdf', content: pdf}]});
		expect(send).toMatchObject({id: 'job9', status, attachmentCount: 1});
		expect(seen).toHaveLength(1);
	});

	test('a test key sends the files too and gets status test; a replay is reported', async () => {
		answers = [{status: 200, body: {success: true, data: {id: 'j', status: 'test', test: true, attachmentCount: 1}}, headers: {'Idempotent-Replayed': 'true'}}];
		const c = new Bloomsight({apiKey: TEST_KEY, baseUrl: base});
		const send = await c.sendMail({templateId: 't', engineId: 'e', attachments: [{filename: 'a.pdf', content: pdf}]});
		expect(send).toMatchObject({status: 'test', test: true, replayed: true});
		expect(seen[0]!.form!.getAll('attachments')).toHaveLength(1);
	});

	test('batches are unaffected: still JSON', async () => {
		answers = [ok({id: 'b1', status: 'running', rows: 1, accepted: 1, duplicates: 0, suppressed: 0})];
		await client().sendBatch({templateId: 't', engineId: 'e', recipients: [{data: {email: 'a@x.test'}}]});
		expect(seen[0]!.headers['content-type']).toBe('application/json');
		expect(seen[0]!.body).toEqual({templateId: 't', engineId: 'e', recipients: [{data: {email: 'a@x.test'}}]});
	});
});
