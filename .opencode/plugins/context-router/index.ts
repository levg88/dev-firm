import { Plugin } from "@opencode/plugin"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"

const MAX_TOPICS = 6
const NOISE = new Set(["agents", "cli", "providers", "settings", "tests", "tickets"])
const ROUTER_KEY = "context-router"
const INBOX_KEY = "context-inbox"

type TopicRow = { topic: string; aliases: string[]; path: string }

/** Parse the `## Topic table` from Context/ContextMapping.md. */
function parseTopicTable(markdown: string): TopicRow[] {
  const rows: TopicRow[] = []
  let inTable = false
  for (const raw of markdown.split(/\r?\n/)) {
    if (raw.startsWith("## ")) {
      inTable = raw.trim() === "## Topic table"
      continue
    }
    if (!inTable || !raw.trim().startsWith("|")) continue
    const cells = raw
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
    if (cells.length < 3) continue
    const [topic, aliases, rawPath] = cells
    if (!topic || topic === "Topic" || /^[-: ]+$/.test(topic)) continue
    rows.push({
      topic,
      aliases: aliases
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean),
      path: rawPath.replace(/^`/, "").replace(/`$/, ""),
    })
  }
  return rows
}

/** Match the Python hook's light plural/digit stemming. */
function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word
}

function matchesTerm(term: string, prompt: string): boolean {
  const words = term.split(/\s+/).filter(Boolean)
  if (!words.length) return false
  return words.every((word) => {
    const escaped = stem(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`\\b${escaped}(s|\\d+)?\\b`, "i").test(prompt)
  })
}

function matchTopics(prompt: string, rows: TopicRow[]): TopicRow[] {
  const out: TopicRow[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    for (const term of [row.topic, ...row.aliases]) {
      if (NOISE.has(term.toLowerCase())) continue
      if (!matchesTerm(term, prompt)) continue
      const key = `${row.topic}\u0000${row.path}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push(row)
      }
      break
    }
    if (out.length >= MAX_TOPICS) break
  }
  return out
}

async function readRouter(root: string): Promise<string> {
  try {
    return await readFile(path.join(root, "Context/ContextMapping.md"), "utf8")
  } catch {
    return ""
  }
}

async function inboxFiles(root: string): Promise<string[]> {
  const dir = path.join(root, "Context/_inbox")
  try {
    const names = await readdir(dir)
    const out: string[] = []
    for (const name of names.sort()) {
      if (!name.endsWith(".md") || name === "README.md") continue
      try {
        // A processed file the librarian truncated to 0 bytes is not pending work.
        if ((await stat(path.join(dir, name))).size > 0) out.push(name)
      } catch {
        // Skip unreadable entries.
      }
    }
    return out
  } catch {
    return []
  }
}

function routerText(matches: TopicRow[]): string {
  if (!matches.length) return ""
  const listing = matches.map((match) => `${match.topic} -> ${match.path}`).join("; ")
  return `[Context Router] Domain topics matched in Context/ContextMapping.md: ${listing}. GATE: read these Memory.md files (and any mirror file they point to) BEFORE grepping code or searching external sources. New domain findings go to Context/_inbox/ tagged (provider / OS, date) or (General).`
}

function inboxText(files: string[]): string {
  if (!files.length) return ""
  const shown = files.slice(0, 3).join(", ")
  const more = files.length > 3 ? ", …" : ""
  return `[Context Inbox] ${files.length} unprocessed finding file(s) in Context/_inbox/: ${shown}${more}. Run /curate-context when the current task is done; do not edit Memory.md directly.`
}

export default Plugin.define({
  id: "context-router",
  async setup(ctx) {
    const root = ctx.location.project?.canonical ?? ctx.location.directory

    await ctx.session.hook("prompt", async (event) => {
      try {
        const prompt = String(event.prompt.text ?? "")
        const [mapping, inbox] = await Promise.all([readRouter(root), inboxFiles(root)])
        const matches = prompt.trim().length >= 4 ? matchTopics(prompt, parseTopicTable(mapping)) : []
        const router = routerText(matches)
        const reminder = inboxText(inbox)

        if (router) {
          await ctx.session.instructions.entry.put({ sessionID: event.sessionID, key: ROUTER_KEY, value: router })
        } else {
          await ctx.session.instructions.entry.remove({ sessionID: event.sessionID, key: ROUTER_KEY }).catch(() => {})
        }

        if (reminder) {
          await ctx.session.instructions.entry.put({ sessionID: event.sessionID, key: INBOX_KEY, value: reminder })
        } else {
          await ctx.session.instructions.entry.remove({ sessionID: event.sessionID, key: INBOX_KEY }).catch(() => {})
        }
      } catch {
        // A broken context plugin must never block a prompt.
      }
    })
  },
})
