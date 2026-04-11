import type { SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../../lib/core-api-client.js'
import { formatError } from '../../lib/formatters.js'
import { logger } from '@open-brain/shared'

/**
 * Handle `!email <subcommand>` — email draft management commands.
 *
 * Subcommands:
 *   !email send <to> <subject>    — create an email draft (brain will compose the body)
 *   !email drafts                 — list pending drafts
 *   !email approve <id>           — approve and send a draft
 *   !email reject <id>            — reject/discard a draft
 */
export async function handleEmailCommand(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  subCmd: string,
  subCmdRaw: string,
  args: string,
): Promise<void> {
  switch (subCmd) {
    case 'send':
      await handleEmailSend(ts, say, client, subCmdRaw, args)
      break

    case 'drafts':
      await handleEmailDrafts(ts, say, client)
      break

    case 'approve':
      await handleEmailApprove(ts, say, client, args)
      break

    case 'reject':
      await handleEmailReject(ts, say, client, args)
      break

    default:
      await say({
        text: [
          ':email: *Email Commands*',
          '',
          '`!email send <to> <subject>` — create an email draft',
          '`!email drafts` — list pending drafts',
          '`!email approve <id>` — approve and send a draft',
          '`!email reject <id>` — reject/discard a draft',
        ].join('\n'),
        thread_ts: ts,
      })
      break
  }
}

/**
 * !email send <to> <subject>
 * Parses `args` as: first token = recipient email, rest = subject line.
 * Creates a draft via core-api (the email-compose skill will fill the body).
 */
async function handleEmailSend(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  subCmdRaw: string,
  args: string,
): Promise<void> {
  // subCmdRaw is the first argument after "send" (parsed as subCmd position),
  // but parseCommand already consumed it. The actual tokens we need are in
  // the full args chain. Re-assemble: subCmdRaw is the <to>, args is the <subject>.
  // Actually, the command parser gives us:
  //   cmd = "email", subCmd = "send", subCmdRaw = "send", args = "<to> <subject>"
  // So we need to parse <to> and <subject> from args.
  const tokens = args.trim().split(/\s+/)
  const to = tokens[0] ?? ''
  const subject = tokens.slice(1).join(' ')

  if (!to || !to.includes('@')) {
    await say({
      text: ':warning: Usage: `!email send <to@email.com> <subject line>`',
      thread_ts: ts,
    })
    return
  }

  if (!subject.trim()) {
    await say({
      text: ':warning: Missing subject. Usage: `!email send <to@email.com> <subject line>`',
      thread_ts: ts,
    })
    return
  }

  await say({
    text: `_Creating email draft to ${to}…_`,
    thread_ts: ts,
  })

  try {
    const result = await client.email_drafts_create({
      to,
      subject,
      body: `[Draft requested via Slack]\n\nTo: ${to}\nSubject: ${subject}\n\nBody to be composed.`,
      source: 'slack',
    })

    await say({
      text: [
        `:email: Email draft created`,
        `*To:* ${to}`,
        `*Subject:* ${subject}`,
        `*ID:* \`${result.id}\``,
        `*Status:* ${result.status}`,
        '',
        `Use \`!email approve ${result.id}\` to send or \`!email reject ${result.id}\` to discard.`,
      ].join('\n'),
      thread_ts: ts,
    })
  } catch (err) {
    logger.error({ err, to, subject }, 'handleEmailSend: failed')
    await say({ text: formatError('Failed to create email draft', err), thread_ts: ts })
  }
}

/**
 * !email drafts — list pending email drafts.
 */
async function handleEmailDrafts(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
): Promise<void> {
  try {
    const result = await client.email_drafts_list('draft')

    if (result.items.length === 0) {
      await say({
        text: ':email: No pending email drafts.',
        thread_ts: ts,
      })
      return
    }

    const lines = [
      `:email: *Pending Email Drafts* (${result.total})`,
      '',
    ]

    for (const draft of result.items.slice(0, 10)) {
      const date = new Date(draft.created_at).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
      })
      lines.push(
        `• \`${draft.id.slice(0, 8)}\` — *${draft.subject}* → ${draft.to_address} (${date})`
      )
    }

    if (result.total > 10) {
      lines.push('', `_…and ${result.total - 10} more. View all in the dashboard._`)
    }

    await say({ text: lines.join('\n'), thread_ts: ts })
  } catch (err) {
    logger.error({ err }, 'handleEmailDrafts: failed')
    await say({ text: formatError('Failed to list email drafts', err), thread_ts: ts })
  }
}

/**
 * !email approve <id> — approve and send a draft.
 */
async function handleEmailApprove(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  idArg: string,
): Promise<void> {
  const id = idArg.trim()
  if (!id) {
    await say({
      text: ':warning: Usage: `!email approve <draft_id>`',
      thread_ts: ts,
    })
    return
  }

  await say({
    text: `_Approving and sending draft \`${id}\`…_`,
    thread_ts: ts,
  })

  try {
    const result = await client.email_drafts_send(id)
    await say({
      text: `:white_check_mark: Email sent! Draft \`${result.id}\` → status: *${result.status}*`,
      thread_ts: ts,
    })
  } catch (err) {
    logger.error({ err, id }, 'handleEmailApprove: failed')
    await say({ text: formatError('Failed to approve/send email draft', err), thread_ts: ts })
  }
}

/**
 * !email reject <id> — reject/discard a draft.
 */
async function handleEmailReject(
  ts: string,
  say: SayFn,
  client: CoreApiClient,
  idArg: string,
): Promise<void> {
  const id = idArg.trim()
  if (!id) {
    await say({
      text: ':warning: Usage: `!email reject <draft_id>`',
      thread_ts: ts,
    })
    return
  }

  try {
    const result = await client.email_drafts_reject(id)
    await say({
      text: `:x: Draft \`${result.id}\` rejected.`,
      thread_ts: ts,
    })
  } catch (err) {
    logger.error({ err, id }, 'handleEmailReject: failed')
    await say({ text: formatError('Failed to reject email draft', err), thread_ts: ts })
  }
}
