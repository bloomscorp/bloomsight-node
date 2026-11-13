/**
 * Every failure is a `BloomsightError`, so callers branch on `code`, never on text.
 * Server codes pass through unchanged (`TEMPLATE_NOT_FOUND`, `KEY_SCOPE`,
 * `IDEMPOTENCY_CONFLICT`, `INVALID_ROWS`, …). The library's own:
 *   INVALID_API_KEY       the key is missing or not a Bloomsight key
 *   BROWSER_NOT_ALLOWED   constructed in a browser, where the key would leak
 *   NETWORK_FAILURE       blooms.ai could not be reached, after the retries
 *   TIMEOUT               an attempt took longer than `timeoutMs` (`attachmentTimeoutMs` for a
 *                         send with attachments), after the retries
 *   BAD_RESPONSE          blooms.ai answered with something that is not its JSON
 * Attachment rules, checked before anything is uploaded (the server uses the same codes):
 *   TOO_MANY_ATTACHMENTS     more than 5 files
 *   ATTACHMENT_TOO_LARGE     a file over 5 MB
 *   ATTACHMENTS_TOO_LARGE    all files together over 15 MB
 *   INVALID_ATTACHMENT       an empty file, a bad filename, not exactly one of content/path,
 *                            an unreadable path or an invalid contentType
 *   ATTACHMENT_TYPE_BLOCKED  a type mail providers refuse (.exe, .js, .bat, …)
 */
export class BloomsightError extends Error {
	readonly code: string;
	/** HTTP status, when the failure came from a response. */
	readonly status?: number;
	/** Seconds to wait before trying again, when blooms.ai said so. */
	readonly retryAfter?: number;
	/** The Idempotency-Key the request carried: retry with it to stay safe. */
	readonly idempotencyKey?: string;
	/** Extra detail from the server, e.g. `faults` for INVALID_ROWS, `fits` for MONTHLY_LIMIT. */
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, extra: {
		status?: number; retryAfter?: number; idempotencyKey?: string; details?: Record<string, unknown>;
	} = {}) {
		super(message);
		this.name = 'BloomsightError';
		this.code = code;
		this.status = extra.status;
		this.retryAfter = extra.retryAfter;
		this.idempotencyKey = extra.idempotencyKey;
		this.details = extra.details;
	}
}
