import {readFile, stat} from 'node:fs/promises';

import {BloomsightError} from './error';
import type {Attachment} from './types';

/**
 * Attachment rules for `sendMail` (blooms.ai documentation/bloomsight/backend-sending.md §8.1).
 * They are checked here, before anything is uploaded, and again by the server, so the two
 * lists below must stay identical to the server's (`utils/bloomsight-email-attachments.util.js`).
 */

const MB = 1024 * 1024;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * MB;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 15 * MB;
export const MAX_FILENAME_LENGTH = 150;

/** Types Gmail refuses to deliver; refused up front instead of failing at the provider. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
	'ade', 'adp', 'apk', 'appx', 'appxbundle', 'bat', 'cab', 'chm', 'cmd', 'com', 'cpl', 'diagcab', 'diagcfg',
	'diagpack', 'dll', 'dmg', 'ex', 'ex_', 'exe', 'hta', 'img', 'ins', 'iso', 'isp', 'jar', 'jnlp', 'js', 'jse',
	'lib', 'lnk', 'mde', 'mjs', 'msc', 'msi', 'msix', 'msixbundle', 'msp', 'mst', 'nsh', 'pif', 'ps1', 'scr',
	'sct', 'shb', 'sys', 'vb', 'vbe', 'vbs', 'vhd', 'vxd', 'wsc', 'wsf', 'wsh', 'xll',
]);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	pdf: 'application/pdf',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	svg: 'image/svg+xml',
	csv: 'text/csv',
	txt: 'text/plain',
	html: 'text/html',
	ics: 'text/calendar',
	json: 'application/json',
	xml: 'application/xml',
	zip: 'application/zip',
	doc: 'application/msword',
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xls: 'application/vnd.ms-excel',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	ppt: 'application/vnd.ms-powerpoint',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	odt: 'application/vnd.oasis.opendocument.text',
	ods: 'application/vnd.oasis.opendocument.spreadsheet',
	rtf: 'application/rtf',
	mp3: 'audio/mpeg',
	mp4: 'video/mp4',
};
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';
/** `type/subtype`, optionally with parameters; printable ASCII only, so it cannot break the part's headers. */
const CONTENT_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(\s*;[\x20-\x7e]*)?$/i;

/** A file ready to upload: its cleaned name, its type and a private copy of its bytes. */
export interface PreparedAttachment {
	filename: string;
	contentType: string;
	bytes: Uint8Array<ArrayBuffer>;
}

/**
 * The name as the server will see it: the part after the last `/` or `\`, without
 * control characters (U+0000–U+001F, U+007F) or double quotes, trimmed.
 */
export function cleanFilename(name: string): string {
	const base = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
	return base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
}

/**
 * The last extension, lower case, without the dot ('' when there is none). Trailing dots
 * and spaces are ignored first, because Windows drops them (`invoice.exe.` opens as an
 * .exe), and a name that is all extension counts (`.exe` → `exe`). The server and the Java
 * library use the same rule.
 */
function extensionOf(filename: string): string {
	const trimmed = filename.replace(/[.\s]+$/, '');
	const dot = trimmed.lastIndexOf('.');
	return dot < 0 ? '' : trimmed.slice(dot + 1).toLowerCase();
}

export function guessContentType(filename: string): string {
	return CONTENT_TYPES[extensionOf(filename)] ?? DEFAULT_CONTENT_TYPE;
}

function fail(code: string, message: string, index: number, filename?: string): never {
	throw new BloomsightError(code, message, {details: {attachment: index, ...(filename !== undefined ? {filename} : {})}});
}

const tooLarge = (name: string) => `attachment '${name}' is larger than ${MAX_ATTACHMENT_BYTES / MB} MB`;

/**
 * Checks every rule of §8.1 and reads each file once, so every attempt of the send
 * uploads exactly the same bytes. Throws `BloomsightError` before anything is sent.
 */
export async function prepareAttachments(list: unknown): Promise<PreparedAttachment[]> {
	if (!Array.isArray(list)) {
		throw new BloomsightError('INVALID_ATTACHMENT', 'attachments must be a list of {filename, content | path}');
	}
	if (list.length > MAX_ATTACHMENTS) {
		throw new BloomsightError('TOO_MANY_ATTACHMENTS',
			`an email takes at most ${MAX_ATTACHMENTS} attachments; ${list.length} were given`);
	}

	const prepared: PreparedAttachment[] = [];
	let total = 0;
	for (const [index, item] of (list as Attachment[]).entries()) {
		if (!item || typeof item !== 'object') fail('INVALID_ATTACHMENT', `attachment ${index + 1} is not an object`, index);

		const filename = typeof item.filename === 'string' ? cleanFilename(item.filename) : '';
		if (filename.length < 1 || filename.length > MAX_FILENAME_LENGTH) {
			fail('INVALID_ATTACHMENT',
				`attachment ${index + 1} needs a filename of 1 to ${MAX_FILENAME_LENGTH} characters (after removing any folder, control characters and quotes)`,
				index);
		}
		if (BLOCKED_EXTENSIONS.has(extensionOf(filename))) {
			fail('ATTACHMENT_TYPE_BLOCKED', `'${filename}': .${extensionOf(filename)} files are refused by mail providers`, index, filename);
		}

		const hasContent = item.content !== undefined && item.content !== null;
		const hasPath = item.path !== undefined && item.path !== null;
		if (hasContent === hasPath) {
			fail('INVALID_ATTACHMENT', `attachment '${filename}' needs exactly one of content or path`, index, filename);
		}

		let contentType = DEFAULT_CONTENT_TYPE;
		if (item.contentType !== undefined && item.contentType !== null) {
			contentType = String(item.contentType).trim();
			if (!CONTENT_TYPE_PATTERN.test(contentType)) {
				fail('INVALID_ATTACHMENT', `attachment '${filename}' has an invalid contentType`, index, filename);
			}
		} else {
			contentType = guessContentType(filename);
		}

		let bytes: Uint8Array<ArrayBuffer>;
		if (hasPath) {
			if (typeof item.path !== 'string' || !item.path) fail('INVALID_ATTACHMENT', `attachment '${filename}': path must be a file path`, index, filename);
			try {
				const info = await stat(item.path);
				if (!info.isFile()) fail('INVALID_ATTACHMENT', `attachment '${filename}': ${item.path} is not a file`, index, filename);
				// Refuse a big file without reading it into memory.
				if (info.size > MAX_ATTACHMENT_BYTES) fail('ATTACHMENT_TOO_LARGE', tooLarge(filename), index, filename);
				bytes = new Uint8Array(await readFile(item.path));
			} catch (err) {
				if (err instanceof BloomsightError) throw err;
				fail('INVALID_ATTACHMENT', `attachment '${filename}': could not read ${item.path}: ${(err as Error)?.message || err}`, index, filename);
			}
		} else {
			const content = item.content;
			if (typeof content === 'string') {
				bytes = new Uint8Array(Buffer.from(content, 'utf8'));
			} else if (content instanceof Uint8Array) {
				bytes = new Uint8Array(content); // a copy: the caller may reuse its buffer while we retry
			} else if (content instanceof ArrayBuffer) {
				bytes = new Uint8Array(content.slice(0));
			} else if (typeof Blob !== 'undefined' && content instanceof Blob) {
				if (content.size > MAX_ATTACHMENT_BYTES) fail('ATTACHMENT_TOO_LARGE', tooLarge(filename), index, filename);
				bytes = new Uint8Array(await content.arrayBuffer());
			} else {
				fail('INVALID_ATTACHMENT',
					`attachment '${filename}': content must be a Buffer, Uint8Array, ArrayBuffer, Blob or string`, index, filename);
			}
		}

		if (bytes.byteLength === 0) fail('INVALID_ATTACHMENT', `attachment '${filename}' is empty`, index, filename);
		if (bytes.byteLength > MAX_ATTACHMENT_BYTES) fail('ATTACHMENT_TOO_LARGE', tooLarge(filename), index, filename);
		total += bytes.byteLength;
		if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
			throw new BloomsightError('ATTACHMENTS_TOO_LARGE',
				`attachments together may be at most ${MAX_ATTACHMENTS_TOTAL_BYTES / MB} MB`);
		}
		prepared.push({filename, contentType, bytes});
	}
	return prepared;
}
