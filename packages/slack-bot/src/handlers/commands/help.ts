import type { SayFn } from '@slack/bolt'

export const HELP_TEXT = `*Open Brain — Available Commands*

*Captures & Stats*
  \`!stats\`              — brain statistics (counts, pipeline health)
  \`!recent [N]\`         — last N captures (default 5, max 20)
  \`!retry <id>\`         — retry a failed capture pipeline

*Briefs*
  \`!brief\`              — generate weekly brief now
  \`!brief last\`         — show last generated brief

*Entities*
  \`!entities\`                       — list all known entities
  \`!entity <name>\`                  — entity detail + linked captures
  \`!entity merge <name1> <name2>\`   — merge name1 into name2
  \`!entity split <name> <alias>\`    — split alias out of entity

*Semantic Triggers*
  \`!trigger add "text"\` — create a semantic trigger
  \`!trigger list\`       — list all triggers with status
  \`!trigger delete <n>\` — deactivate a trigger by name/id
  \`!trigger test "text"\`— test query against existing captures

*Pipeline*
  \`!pipeline status\`    — pipeline queue health

*Governance Sessions*
  \`!board quick\`           — start quick board check (reply in thread to continue)
  \`!board quarterly\`       — start quarterly review (reply in thread to continue)
  \`!board resume <id>\`     — resume a paused session
  \`!board status\`          — list active/paused sessions
  (In session thread) \`!board pause\`    — pause session
  (In session thread) \`!board done\`     — complete + generate summary
  (In session thread) \`!board abandon\`  — abandon session

*Bet Tracking*
  \`!bet list [status]\`              — list bets (pending/correct/incorrect/ambiguous)
  \`!bet add <conf> <statement>\`     — create bet (conf = 0.0–1.0)
  \`!bet expiring [N]\`              — bets expiring in next N days (default 7)
  \`!bet resolve <id> <outcome>\`    — resolve: correct | incorrect | ambiguous
  \`!bet resolve <id> <outcome> <evidence>\` — resolve with evidence

  \`!help\`               — this message`

export async function handleHelp(ts: string, say: SayFn): Promise<void> {
  await say({ text: HELP_TEXT, thread_ts: ts })
}
