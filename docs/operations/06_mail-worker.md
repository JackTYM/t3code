# Mail Worker

`infra/mail-worker` is a Cloudflare Email Worker. Gmail and iCloud accounts forward to one routing address on a domain you own on Cloudflare. Cloudflare Email Routing hands each message to the Worker, which turns it into a `BotMailMessage` and POSTs it, signed, to your box. Mail from any sender goes through; the sender is never a trust signal. Only `auth` is the receiving server's word, the rest is sender text.

Statements below come from the Cloudflare Email Service docs (developers.cloudflare.com/email-service) unless marked **unverified**. Nothing here was run against a live Cloudflare account.

## What the Worker trusts

Email Routing prepends an `Authentication-Results` header with the authserv-id `mx.cloudflare.net`; Cloudflare's docs say to read the _first_ such header, check that id, and not trust any other. The Worker does exactly that: only the topmost `Authentication-Results` header counts, and only if its id is `mx.cloudflare.net`. If it is missing or names another server, `dkim`, `spf` and `dmarc` are all `none`. DMARC is read from the header, never computed.

## Bulk mail

The Worker sets `bulk` on each message from the sender's own headers: `List-Unsubscribe`, `List-Id`, `Precedence: bulk`, `list` or `junk`, `Auto-Submitted` other than `no`, or a no-reply style sender (`noreply`, `no-reply`, `donotreply`, `newsletter`, `marketing`, `notifications`). The box stores bulk mail but never wakes the Bot for it. The rule lives in `src/bulk.ts` and is mirrored in the box's Mac Mail reader; change both together. A Worker deployed before this sends no `bulk`, and every message counts as ordinary until it is redeployed.

Expect `spf` to say `fail` or `softfail` for most forwarded mail: Cloudflare sees Google's or Apple's server, not the original sender's. `dkim` and `dmarc` carry the signal. This is reasoning from how forwarding works, **unverified** against real mail.

Cloudflare rejects some mail before the Worker runs: mail that fails both SPF and DKIM, fails the sender domain's DMARC policy, or comes from a blocklisted IP. Forwarding can trip a strict sender DMARC policy. Those messages never reach the box; Gmail or iCloud still holds its copy.

## Set up

1. **Domain.** In the Cloudflare dashboard go to Compute > Email Service > Email Routing > Onboard Domain and pick your domain. The domain must have no non-Cloudflare MX records on the root; onboarding fails with error 2008 otherwise.
2. **Deploy the Worker** from `infra/mail-worker`. Pin Wrangler:

   ```sh
   npx wrangler@4.159.0 deploy
   ```

3. **Bindings.** All three are secrets, so the mailbox list stays out of git. Run each and paste the value when prompted:

   ```sh
   npx wrangler@4.159.0 secret put BOX_URL        # https URL of the box's mail ingest endpoint
   npx wrangler@4.159.0 secret put WEBHOOK_SECRET # same value the box verifies signatures with
   npx wrangler@4.159.0 secret put MAILBOXES      # your addresses, comma-separated, e.g. me@gmail.com,me@icloud.com
   ```

   `BOX_URL` must be reachable from the public internet; Cloudflare cannot reach a private tailnet address. `MAILBOXES` is matched by exact lower-cased comparison, so list every spelling you receive mail at (Gmail dots and `+tags` are different addresses here). Mail that matches none is posted under its first `To` address, and the box drops it.

4. **Routing rule.** In Email Routing > Routing Rules > Create routing rule, enter the local part of your routing address (for example `mail-in`), set Action to Send to a Worker, and choose `t3code-mail-worker`.

## Forward Gmail

In each Gmail account, add the routing address as a forwarding address, then turn forwarding on. Gmail sends a confirmation message to the routing address, which the Worker catches instead of forwarding it to the box. It logs the confirmation code and link:

```sh
npx wrangler@4.159.0 tail t3code-mail-worker --format json
```

Start the tail, add the forwarding address in Gmail, and look for `"event":"gmail.forwarding_confirmation"`. Open the logged link, or paste the code into the confirmation field in Gmail. Do one account at a time. The Gmail menu path (Settings > Forwarding and POP/IMAP) and the body layout of the confirmation message are **unverified**: if no code or link is logged, the log line still appears with only the `messageId`, and the message is in Cloudflare's Email Routing activity log.

Choose the forwarding option that keeps Gmail's copy of each message (the exact label is **unverified**). If delivery to the box fails, the Worker drops the message rather than bouncing it.

## Forward iCloud

Per Apple's iCloud guide: on icloud.com/mail, open Settings > Mail Forwarding, select "Forward my email to", and enter the routing address. Leave "Delete messages after forwarding" off for the same reason as above.

Apple's docs, as far as I could find, describe no confirmation step for the forwarding address. This is **unverified**: if iCloud sends one, it arrives like any other message and shows in the tail as an ordinary `mail.delivered`, or in your box.

## Rotate the secret

1. Choose a quiet moment. Mail that arrives while the two sides disagree gets a non-2xx from the box and is dropped after the retries (about 20 seconds in total).
2. Change the secret on the box, then run `npx wrangler@4.159.0 secret put WEBHOOK_SECRET` with the same value.

Whether the box can accept the old and new secret at once is up to its ingest code.

## See failures

`wrangler tail t3code-mail-worker --format json` shows one line per message. Observability is also on, so the same lines are in the Worker's logs in the dashboard. Lines carry the Message-ID and the outcome, never addresses, subjects or bodies.

| `event`                         | Meaning                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `mail.delivered`                | The box returned 2xx. `attempts` says how many tries it took.                             |
| `mail.dropped`                  | Every attempt failed (`status` is the last HTTP status, absent if there was no response). |
| `mail.parse_failed`             | The message could not be parsed. Nothing was sent.                                        |
| `mail.not_configured`           | `BOX_URL` or `WEBHOOK_SECRET` is not set.                                                 |
| `gmail.forwarding_confirmation` | A Gmail confirmation was caught; it was not sent to the box.                              |

Cloudflare's own Email Routing activity log shows messages it rejected before the Worker ran. Inbound messages over 25 MiB are rejected. On the Workers Free plan, a large message can exceed the CPU limit (`EXCEEDED_CPU` in the Worker's logs); the Paid plan raises it.
