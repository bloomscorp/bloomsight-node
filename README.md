# @bloomscorp/bloomsight-node

Send [Bloomsight](https://bloomscorp.com) email templates from your Node.js backend.

Bloomsight decides what every email says: you send a **template id and values**, never
a subject or HTML. The template, its recipients and the mailbox it goes from are set up
in your project's Bloomsight dashboard.

- **Safe to retry.** Every send carries an idempotency key, so a retry, a timeout or a
  restarted process never sends the same email twice.
- **Retries for you** on network errors, `429` and `5xx`, honouring `Retry-After`.
- **One error type**, `BloomsightError`, with a `code` to branch on. Your key never
  appears in an error.
- **Typed**, ESM and CommonJS, no runtime dependencies, Node 18+.
- **Server only.** It refuses to start in a browser, where the key would be exposed.
  For browser forms, use `@bloomscorp/bloomsight.js`.

## Install

```bash
npm install @bloomscorp/bloomsight-node
```

## Set up

1. In the Bloomsight dashboard, open the template and set its **sending channel** to
   **API only**. A template that takes its recipient from the values (for example
   `{{email}}`) must be API only, so nobody can trigger it from a web page.
2. In **Project Settings → API keys**, create a key with the **`bloomsight-email`**
   scope. Keep it in your server's environment, never in code or a browser.
   A `blm_test_…` key checks everything and sends nothing: use it in development.

## Send an email

```ts
import {Bloomsight, BloomsightError} from '@bloomscorp/bloomsight-node';

const bloomsight = new Bloomsight({apiKey: process.env.BLOOMSIGHT_API_KEY!});

const send = await bloomsight.sendMail({
	templateId: '…',
	engineId: '…',                       // the mailbox to send from
	data: {name: 'Asha', email: 'asha@example.com', orderId: 'A-1042', lines: [{item: 'Saree', qty: 2}]},
	idempotencyKey: 'order-A-1042-confirmation',   // optional; one is made for you
});
// { id, status: 'queued', missingVariables: [] }

await bloomsight.getSend(send.id);       // queued → sending → sent | failed | unknown
```

A send is **queued** and goes out within about a second while the mailbox has budget.
If the mailbox is at its daily limit, it waits and goes when the budget frees.

`unknown` means the connection to the mail provider dropped mid-send, so it cannot be
known whether it arrived. It is never retried automatically, because a duplicate order
confirmation is worse than a missing one.

**Pass your own `idempotencyKey`** for anything that must go once: the same key and body
within 24 hours returns the original send (`replayed: true`); the same key with a
different body throws `IDEMPOTENCY_CONFLICT`.

## Attachments

```ts
import {readFile} from 'node:fs/promises';

const send = await bloomsight.sendMail({
	templateId, engineId,
	data: {name: 'Asha', email: 'asha@example.com', orderId: 'A-1042'},
	idempotencyKey: 'order-A-1042-invoice',
	attachments: [
		{filename: 'invoice-A-1042.pdf', content: await renderInvoicePdf(order)},   // a Buffer
		{filename: 'terms.pdf', path: '/srv/app/assets/terms.pdf'},                 // read when sent
		{filename: 'items.csv', content: 'item,qty\nSaree,2\n', contentType: 'text/csv'},
	],
});
// { id, status: 'sent', attachmentCount: 3, missingVariables: [] }
```

Each attachment has a `filename` and exactly one of `content` (a `Buffer`, `Uint8Array`,
`ArrayBuffer`, `Blob`, or a string sent as UTF-8 text) or `path` (a file on your server,
read at send time). `contentType` is optional: it is guessed from the extension (`pdf`,
`png`, `jpg`, `csv`, `docx`, `xlsx`, `ics`, …), otherwise `application/octet-stream`.

**A send with attachments is not queued.** Files are never stored by Bloomsight, so
blooms.ai sends the email while your call waits, up to `attachmentTimeoutMs` (2 minutes)
per attempt, and answers with how it went. These come back as the send, not as an error:

| `status` | Means |
|---|---|
| `sent` | The mail provider accepted it |
| `failed` | The provider refused it outright (for example a bad address); `errorCode` says why |
| `unknown` | The connection to the provider dropped mid-send: it may or may not have arrived. Never retried for you |
| `sending` | A retry met the first attempt still sending; follow it with `getSend(id)` |

When the mailbox has no budget left, or blooms.ai is busy, nothing is sent and the call is
retried for you with the same idempotency key (`429` / `503` with `Retry-After`), as for any
send; a wait longer than `maxRetryWaitMs` is thrown with `retryAfter`.

The files go on the **primary message only**, never on its auto-reply. A `blm_test_…` key
checks the files against every rule below too, and sends nothing (`status: 'test'`).

**Limits**, checked by the library before anything is uploaded (and again by blooms.ai):

| Rule | Code |
|---|---|
| 1 to 5 files | `TOO_MANY_ATTACHMENTS` |
| Each file at most 5 MB | `ATTACHMENT_TOO_LARGE` |
| All files together at most 15 MB | `ATTACHMENTS_TOO_LARGE` |
| No empty file; a `filename` of 1 to 150 characters after any folder part, control characters and `"` are removed; exactly one of `content` / `path`; a readable `path` | `INVALID_ATTACHMENT` |
| Not a type mail providers refuse: `.exe`, `.js`, `.bat`, `.msi`, `.jar`, `.scr`, `.vbs`, `.iso`, … (the last extension counts, so `invoice.pdf.exe` is refused) | `ATTACHMENT_TYPE_BLOCKED` |

Batches take no attachments.

## Send to a list

```ts
const batch = await bloomsight.sendBatch({
	templateId, engineId, name: 'November offer',
	recipients: subscribers.map(s => ({data: {email: s.email, name: s.name}})),   // up to 5,000
});

await bloomsight.getBatch(batch.id);     // progress: queued, sent, failed, …
await bloomsight.pauseBatch(batch.id);
await bloomsight.resumeBatch(batch.id);
await bloomsight.cancelBatch(batch.id);
```

- Every row is checked first; one bad row refuses the whole batch, and the error's
  `details.faults` lists the rows at fault.
- Repeated addresses and addresses on the unsubscribe list are dropped.
- Batches run at the mailbox's bulk share (70% of its daily limit), across days if
  needed, so they never use up the budget your transactional email relies on.
- Every batch email carries a one-click unsubscribe link (`List-Unsubscribe`). Show it
  in the template too with `{{unsubscribeUrl}}`.
- Bulk email must be included in the project's Bloomsight plan.

## Unsubscribes and budgets

```ts
await bloomsight.listUnsubscribes({limit: 100});
await bloomsight.addUnsubscribe('someone@example.com');      // e.g. opted out on your site
await bloomsight.removeUnsubscribe('someone@example.com');   // only when they opt back in

await bloomsight.getLimits();   // each mailbox: limits, used today, paused by its provider?
```

## Errors

```ts
try {
	await bloomsight.sendMail({templateId, engineId, data});
} catch (err) {
	if (err instanceof BloomsightError) {
		err.code;            // 'TEMPLATE_NOT_FOUND', 'TEMPLATE_PUBLIC_ONLY', 'INVALID_VARIABLES', …
		err.status;          // HTTP status, when there was a response
		err.retryAfter;      // seconds, when blooms.ai said when to try again
		err.idempotencyKey;  // retry with this to stay safe
		err.details;         // e.g. { faults } for INVALID_ROWS, { fits } for MONTHLY_LIMIT
	}
}
```

| Code | Meaning |
|---|---|
| `INVALID_API_KEY` | The key is missing, revoked or not a Bloomsight key |
| `KEY_SCOPE` | The key does not list the `bloomsight-email` scope |
| `TEMPLATE_NOT_FOUND`, `ENGINE_NOT_FOUND` | Not in this key's project |
| `TEMPLATE_PUBLIC_ONLY` | The template's channel is "Browser forms"; set it to "API only" or "Both" |
| `INVALID_VARIABLES` | A value name or size is not allowed (100 values, 5,000 characters each, 16 KB in all) |
| `IDEMPOTENCY_CONFLICT` | The key was used with a different request |
| `INVALID_ROWS`, `BULK_NOT_IN_PLAN`, `MONTHLY_LIMIT` | Batches |
| `TOO_MANY_ATTACHMENTS`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENTS_TOO_LARGE`, `INVALID_ATTACHMENT`, `ATTACHMENT_TYPE_BLOCKED` | [Attachments](#attachments) |
| `RATE_LIMITED` | Too many requests; retried for you, thrown when retries run out |
| `NETWORK_FAILURE`, `TIMEOUT`, `BAD_RESPONSE` | blooms.ai could not be reached or answered oddly, after retries |

## Options

```ts
new Bloomsight({
	apiKey,                      // required
	baseUrl: 'https://z.bloomscorp.com',
	timeoutMs: 15000,            // per attempt
	attachmentTimeoutMs: 120000, // per attempt, for a send with attachments (sent while you wait)
	maxRetries: 3,
	maxRetryWaitMs: 60000,       // a longer Retry-After is thrown, not waited out
});
```

## License

MIT
