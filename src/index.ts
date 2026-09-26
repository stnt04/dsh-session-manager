/**
 * dsh-session-manager host plugin (v0.1.2: trash + restore).
 *
 * Routes:
 *   POST /dsh-session-manager/delete   body: { sessionId }  -> move to trash
 *   POST /dsh-session-manager/restore  body: { sessionId }  -> restore from trash
 *   POST /dsh-session-manager/purge    body: { sessionId }  -> permanently purge
 *   GET  /dsh-session-manager/trash                          -> list trash entries
 *
 * Delete flow (soft delete):
 *  1. Resolve the persisted session; refuse sessions whose agent is actively
 *     running a turn.
 *  2. Move the session's artifact directory into the plugin trash folder
 *     (a blank session without an artifact just records the entry).
 *  3. Archive the session so every client hides the row immediately.
 *  4. Record the entry (original path + deletedAt) in the plugin's storage
 *     domain; when the trash exceeds the limit, the oldest entries are
 *     purged for good.
 *
 * Restore flow:
 *  1. Find the trash entry; move the artifact back to its original path.
 *  2. Remove the session id from the workspace archive set through the
 *     workspace domain (the official broadcast refreshes every client).
 *  3. Drop the trash entry.
 *
 * Purge flow: remove the artifact directory and the trash entry.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: brings the ctx.webServer / ctx.sessionPersistence /
// ctx.workspaceRegistry / ctx.agents / ctx.storageDomain merges into this program.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session-persistence'
// 0.1.7-rc.2 renamed/reshaped the stored-session observation surface: `list()`
// now yields `SessionPersistenceSnapshot` objects whose metadata lives under
// `.header`, and `locate()` left the seam contract entirely.
import type {
  SessionHeader,
  SessionLocation,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-storage-domain'
// Type-only: brings the ctx.agentPresets service merge into this program.
// (0.1.7-rc.2: the package that declares the merge is `dsh-agent-preset-registry`;
// the old plural `dsh-agent-presets` no longer exists.)
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
// Type-only: brings the ctx.loader merge into this program.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

export const name = 'dsh-session-manager'
export const inject = [
  'webServer',
  'sessionPersistence',
  'workspaceRegistry',
  'agents',
  'storageDomain',
  'loader',
  'agentPresets',
]

const ROUTE_PREFIX = '/dsh-session-manager'
const MAX_BODY_BYTES = 64 * 1024
// Official session ids come in three shapes: `session-<uuid>` (web UI,
// created via the api), `session-<n>` (store-minted, e.g. forks created
// without an explicit id) and `<uuid>` (subagent children, created as
// `SessionId(randomUUID())`). Accept all three; keep the charset tight
// (hex + dashes only, plus the literal "session-" prefix) because the id
// is joined into a trash path.
const SESSION_ID_RE = /^(session-)?[0-9a-fA-F-]+$/
/** Maximum trash entries kept; the oldest overflow is purged automatically. */
export const TRASH_LIMIT = 10

export function openFolderCommand(platform: NodeJS.Platform): string {
  if (platform === 'win32') return 'explorer'
  if (platform === 'darwin') return 'open'
  return 'xdg-open'
}

function openFolder(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(openFolderCommand(platform), [path], {
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

const trashEntrySchema = z.object({
  sessionId: z.string(),
  cwd: z.string().optional(),
  originalPath: z.string().optional(),
  deletedAt: z.number(),
})
export type TrashEntry = z.infer<typeof trashEntrySchema>

/** The plugin's storage domain: trash entries plus the compaction threshold setting. */
const trashDomainSpec = defineDomain({
  name: 'dsh_delete_session',
  version: 1,
  global: {
    schema: z.object({
      entries: z.array(trashEntrySchema),
      // User-set compaction threshold (0.17–0.9); absent = not configured.
      thresholdRatio: z.number().optional(),
    }),
    initial: { entries: [] },
  },
  tables: {},
})

function trashRoot(): string {
  return dshHomePath('dsh-delete-session-trash')
}
function trashSessionDir(sessionId: string): string {
  return join(trashRoot(), sessionId)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
      if (data.length > MAX_BODY_BYTES) {
        req.destroy()
        reject(new Error('request body too large'))
      }
    })
    req.on('end', () => {
      if (data.length === 0) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function parseSessionId(body: unknown): SessionId | undefined {
  const sessionId = (body as { sessionId?: unknown } | null)?.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return undefined
  return sessionId as SessionId
}

/**
 * 0.1.7-rc.2 removed the preset-*file* model this feature used to mirror into.
 * `agentPresets.resolve()` now yields `{ id, name?, description?, order?, broken? }`
 * — no `path`, no `trust` — because a preset is an inline `@deepseek-ai/dsh-agent-preset`
 * bundle row, edited through a bundle patch (the plugin manager), never as a file.
 *
 * So the plugin's storage-domain value is the single source of truth for the
 * compaction threshold, and the route below no longer tries to read or write a
 * preset file. Consequence: a `thresholdRatio` set directly in the user's own
 * preset is no longer mirrored into this plugin's UI before the first save.
 */

/** Remove one session id from the workspace archive set. */
async function unarchive(ctx: Context, sessionId: SessionId): Promise<void> {
  // 0.1.7-rc.2 added the official inverse. It writes the durable domain *and*
  // the registry's cache in one `setState`, so the old direct-domain write plus
  // private `state` poke is neither needed nor safe (the durable shape gained
  // `initialized` / `pendingMutation` / `pinnedSessionIds`).
  await ctx.workspaceRegistry.unarchiveSession(sessionId)
}

/**
 * Where a stored session's artifact lives, as far as the active backend will say.
 *
 * 0.1.7-rc.2 removed `locate()` from the `SessionPersistence` contract: the seam
 * now exposes only `create` / `open` / `flush` / `stat` / `list`, and no
 * supported API returns a stored session's path. The shipped JSONL backend still
 * keeps `locate()` as a refusal-diagnostics hook taking a `SessionHeader`
 * (rather than a snapshot), so it is reached here through a narrow cast and
 * feature-detected — another backend (the sqlite one also shipping in
 * 0.1.7-rc.2) has no such method, and a hard cast would turn every delete into a
 * 500.
 */
interface SessionArtifactLocation {
  /** Whether the backend exposes stored-artifact paths at all. */
  readonly supported: boolean
  /** The session directory, when the backend resolved one. */
  readonly dir?: string
}

function locateSessionArtifact(ctx: Context, snapshot: SessionPersistenceSnapshot): SessionArtifactLocation {
  const backend = ctx.sessionPersistence as unknown as {
    locate?(meta: SessionHeader): SessionLocation | undefined
  }
  if (typeof backend.locate !== 'function') return { supported: false }
  try {
    const location = backend.locate(snapshot.header)
    return location === undefined ? { supported: true } : { supported: true, dir: dirname(location.path) }
  } catch (error) {
    ctx.logger.warn('[dsh-session-manager] backend locate() failed:', error)
    return { supported: true }
  }
}

/**
 * Apply a new threshold to the compaction engines of already-open sessions.
 * Sessions using the same preset share one engine in the preset's isolated
 * realm; the agentPresets service's `serviceFor` is the official channel
 * that reaches it (called on the HOST's service instance, so module state is
 * shared). The engine reads `this.config` at every decision, so updating the
 * resolved threshold field takes effect immediately. Best-effort: failures
 * only warn.
 */
async function applyThresholdToLiveAgents(ctx: Context, ratio: number): Promise<void> {
  try {
    const presets = ctx.get('agentPresets') as
      | { serviceFor?(agent: { ctx: Context }, name: string): unknown }
      | undefined
    if (presets?.serviceFor === undefined) return
    const snapshots = await ctx.sessionPersistence.list()
    for (const snapshot of snapshots) {
      const agent = ctx.agents.get(snapshot.header.id)
      if (agent === undefined) continue
      const engine = presets.serviceFor(agent, 'compaction') as
        | { config?: { thresholdRatio?: unknown } }
        | undefined
      if (engine === undefined || engine.config === undefined) continue
      engine.config.thresholdRatio = ratio
    }
  } catch (error) {
    ctx.logger.warn('[dsh-session-manager] live-agent threshold update failed:', error)
  }
}

export function apply(ctx: Context): Promise<() => Promise<void>> {
  return ctx.storageDomain.open(trashDomainSpec).then((trash) => {
    const getEntries = (): TrashEntry[] => (trash.global.get() as { entries: TrashEntry[] }).entries
    const setEntries = (entries: TrashEntry[]): Promise<void> => {
      const current = trash.global.get() as { entries: TrashEntry[]; thresholdRatio?: number }
      return trash.global.set({ ...current, entries }).catch((error) => {
        ctx.logger.warn('[dsh-session-manager] trash persist failed:', error)
        throw error
      })
    }

    let mutationTail: Promise<void> = Promise.resolve()
    const withMutationLock = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = mutationTail.then(operation, operation)
      mutationTail = result.then(() => undefined, () => undefined)
      return result
    }

    // The user-set compaction threshold, persisted in this plugin's storage
    // domain. Loaded at startup; updated on save. It applies to EVERY session
    // regardless of agent preset: each step-boundary enforcement below forces
    // the running engine's config to this value.
    let configuredThreshold: number | null = (trash.global.get() as { thresholdRatio?: number }).thresholdRatio ?? null
    const setConfiguredThreshold = async (ratio: number): Promise<void> => {
      const current = trash.global.get() as { entries: TrashEntry[]; thresholdRatio?: number }
      await trash.global.set({ ...current, thresholdRatio: ratio }).catch((error) => {
        ctx.logger.warn('[dsh-session-manager] threshold persist failed:', error)
        throw error
      })
      configuredThreshold = ratio
    }

    // Enforce the configured threshold on every session's compaction engine
    // at each step boundary, whatever preset the session uses. The engine
    // reads `this.config` per decision, so the assignment is enough. Silent
    // and cheap (one comparison); never blocks the step.
    {
      const presets = ctx.get('agentPresets') as
        | { serviceFor?(agent: { ctx: Context }, name: string): unknown }
        | undefined
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        try {
          if (configuredThreshold !== null && presets?.serviceFor !== undefined) {
            const engine = presets.serviceFor(agent, 'compaction') as
              | { config?: { thresholdRatio?: unknown } }
              | undefined
            if (engine?.config !== undefined && engine.config.thresholdRatio !== configuredThreshold) {
              engine.config.thresholdRatio = configuredThreshold
            }
          }
        } catch {
          // Never let enforcement break a step.
        }
        return next()
      }, { prepend: true })
    }

    // POST /dsh-session-manager/delete — soft delete into the trash.
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/delete`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          await withMutationLock(async () => {
            const snapshots = await ctx.sessionPersistence.list()
            const meta = snapshots.find((snapshot) => snapshot.header.id === id)
            const agent = ctx.agents.get(id)
            const live = agent !== undefined

            if (agent?.status === 'running') {
              respond(res, 409, { ok: false, error: 'session-live' })
              return
            }

            let originalPath: string | undefined
            if (meta !== undefined) {
              const location = locateSessionArtifact(ctx, meta)
              if (location.supported && location.dir === undefined) {
                respond(res, 500, { ok: false, error: 'no-artifact-location' })
                return
              }
              if (!location.supported) {
                ctx.logger.warn(`[dsh-session-manager] backend exposes no session artifact path; ${id} is archived without moving files`)
              }
              originalPath = location.dir
            }

            const workspace = ctx.storageDomain.get('workspace')
            const wasArchived = workspace !== undefined
              && (workspace.global.get() as { archivedSessionIds: string[] }).archivedSessionIds.includes(id)
            const trashPath = trashSessionDir(id)
            let archiveStarted = false
            let artifactMoved = false
            let failureCode = 'delete-failed'

            try {
              failureCode = 'archive-failed'
              archiveStarted = true
              await ctx.workspaceRegistry.archiveSession(id)
              failureCode = 'delete-failed'


              if (!live && originalPath !== undefined && existsSync(originalPath)) {
                await mkdir(trashRoot(), { recursive: true })
                await rm(trashPath, { recursive: true, force: true })
                await rename(originalPath, trashPath)
                artifactMoved = true
                ctx.logger.debug(`[dsh-session-manager] moved ${id} artifact to trash`)
              }

              const entries = getEntries()
              const existingIndex = entries.findIndex((entry) => entry.sessionId === id)
              let next: TrashEntry[]
              let overflow: TrashEntry[] = []
              if (existingIndex >= 0) {
                next = entries.map((entry, index) => index === existingIndex ? { ...entry, deletedAt: Date.now() } : entry)
              } else {
                next = [...entries, { sessionId: id, cwd: meta?.header.cwd, originalPath, deletedAt: Date.now() }]
                if (next.length > TRASH_LIMIT) {
                  overflow = next.slice(0, next.length - TRASH_LIMIT)
                  next = next.slice(next.length - TRASH_LIMIT)
                }
              }
              await setEntries(next)
              for (const entry of overflow) {
                await rm(trashSessionDir(entry.sessionId), { recursive: true, force: true }).catch(() => {})
              }

              respond(res, 200, { ok: true })
            } catch (error) {
              if (artifactMoved && originalPath !== undefined && existsSync(trashPath) && !existsSync(originalPath)) {
                try {
                  await mkdir(dirname(originalPath), { recursive: true })
                  await rename(trashPath, originalPath)
                } catch (rollbackError) {
                  ctx.logger.warn(`[dsh-session-manager] artifact rollback failed for ${id}:`, rollbackError)
                }
              }
              if (archiveStarted && !wasArchived) {
                try {
                  await unarchive(ctx, id)
                } catch (rollbackError) {
                  ctx.logger.warn(`[dsh-session-manager] archive rollback failed for ${id}:`, rollbackError)
                }
              }
              ctx.logger.warn(`[dsh-session-manager] ${failureCode} for ${id}:`, error)
              respond(res, 500, { ok: false, error: failureCode })
            }
          })
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] delete failed:', error)
          respond(res, 500, { ok: false, error: 'delete-failed' })
        }
      },
    })

    // POST /dsh-session-manager/restore — move the artifact back and unarchive.
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/restore`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          await withMutationLock(async () => {
            const entries = getEntries()
            const entry = entries.find((candidate) => candidate.sessionId === id)

            // No trash entry: this is an archived-but-present session being
            // restored from the "已归档" group. Just un-archive it.
            if (entry === undefined) {
              const snapshots = await ctx.sessionPersistence.list()
              const meta = snapshots.find((snapshot) => snapshot.header.id === id)
              const agent = ctx.agents.get(id)
              if (meta === undefined && agent === undefined) {
                return respond(res, 404, { ok: false, error: 'trash-entry-not-found' })
              }
              await unarchive(ctx, id)
              ctx.logger.debug(`[dsh-session-manager] restore ${id}: no trash entry, un-archived only`)
              return respond(res, 200, { ok: true })
            }

            // Move the artifact back only when the trash actually holds one; a
            // live session's artifact was never moved, so nothing to do here.
            const from = trashSessionDir(id)
            if (existsSync(from)) {
              if (entry.originalPath === undefined) {
                ctx.logger.warn(`[dsh-session-manager] restore ${id}: artifact exists in trash but entry has no original path`)
                return respond(res, 500, { ok: false, error: 'no-original-path' })
              }
              if (existsSync(entry.originalPath)) {
                // The original location was recreated (a live session kept
                // writing there): keep the newer file, discard the trash copy.
                await rm(from, { recursive: true, force: true })
                ctx.logger.warn(`[dsh-session-manager] restore ${id}: original path already exists, discarding trash copy`)
              } else {
                await mkdir(dirname(entry.originalPath), { recursive: true })
                await rename(from, entry.originalPath)
                ctx.logger.debug(`[dsh-session-manager] restored ${id} artifact from trash`)
              }
            } else {
              ctx.logger.debug(`[dsh-session-manager] restore ${id}: no artifact in trash (live or blank session)`)
            }

            // Only now — artifact safely back — un-archive and drop the entry.
            await unarchive(ctx, id)
            await setEntries(entries.filter((candidate) => candidate.sessionId !== id))
            respond(res, 200, { ok: true })
          })
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] restore failed:', error)
          respond(res, 500, { ok: false, error: 'restore-failed' })
        }
      },
    })

    // POST /dsh-session-manager/purge — permanently delete the trash entry.
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/purge`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          await withMutationLock(async () => {
            const entries = getEntries()
            const entry = entries.find((candidate) => candidate.sessionId === id)
            if (entry === undefined) {
              respond(res, 404, { ok: false, error: 'trash-entry-not-found' })
              return
            }

            // Remove the artifact: from the trash if it was moved there, and from
            // the original location too (a live session's artifact stayed put).
            await rm(trashSessionDir(id), { recursive: true, force: true })
            if (entry.originalPath !== undefined) {
              // A session that stayed live kept appending at its original
              // location after the trash move, so removing that directory here
              // would destroy history written after the delete. Leave a live
              // session's directory alone and say so.
              const agent = ctx.agents.get(id)
              if (agent === undefined) {
                await rm(entry.originalPath, { recursive: true, force: true })
              } else {
                ctx.logger.warn(`[dsh-session-manager] purge ${id}: kept ${entry.originalPath} because the session is live`)
              }
            }
            await setEntries(entries.filter((candidate) => candidate.sessionId !== id))
            respond(res, 200, { ok: true })
          })
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] purge failed:', error)
          respond(res, 500, { ok: false, error: 'purge-failed' })
        }
      },
    })

    // POST /dsh-session-manager/pause — stop a running session's current turn.
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/pause`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          const agent = ctx.agents.get(id)
          if (agent === undefined) {
            return respond(res, 404, { ok: false, error: 'agent-not-found' })
          }
          agent.cancel({ kind: 'user' })
          respond(res, 200, { ok: true })
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] pause failed:', error)
          respond(res, 500, { ok: false, error: 'pause-failed' })
        }
      },
    })

    // GET /dsh-session-manager/trash — list trash entries.
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/trash`,
      handler: async (_req, res) => {
        try {
          respond(res, 200, { ok: true, entries: getEntries(), limit: TRASH_LIMIT })
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] trash list failed:', error)
          respond(res, 500, { ok: false, error: 'trash-list-failed' })
        }
      },
    })

    // GET/POST /dsh-session-manager/compaction-threshold — read or update the
    // user-set threshold. The value lives in this plugin's storage domain and is
    // pushed onto every live session's compaction engine at each step boundary,
    // so it survives restarts without touching any preset (see the note above
    // `unarchive`: 0.1.7-rc.2 presets are bundle rows, not files).
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/compaction-threshold`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          // The storage domain is the only source: `null` means the user has
          // never saved, so the plugin default applies. `source` tells the UI
          // whether that default is a real saved value or not.
          const saved = configuredThreshold !== null
          respond(res, 200, { ok: true, ratio: saved ? configuredThreshold : 0.8, source: saved ? 'saved' : 'default' })
          return
        }
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const ratio = (body as { ratio?: unknown } | null)?.ratio
        // The engine requires thresholdRatio > retainRatio (default 0.16).
        if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.17 || ratio > 0.9) {
          return respond(res, 400, { ok: false, error: 'invalid-ratio' })
        }
        try {
          await withMutationLock(async () => {
            await setConfiguredThreshold(ratio)
            await applyThresholdToLiveAgents(ctx, ratio)
            respond(res, 200, { ok: true })
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn('[dsh-session-manager] compaction-threshold update failed:', error)
          respond(res, 500, { ok: false, error: message })
        }
      },
    })

    // POST /dsh-session-manager/open-folder — reveal a session's log directory
    // in the system file manager.
    ctx.webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/open-folder`,
      handler: async (req, res) => {
        if (req.method !== 'POST') return respond(res, 405, { ok: false, error: 'method-not-allowed' })
        let body: unknown
        try {
          body = await readJsonBody(req)
        } catch {
          return respond(res, 400, { ok: false, error: 'bad-request' })
        }
        const id = parseSessionId(body)
        if (id === undefined) return respond(res, 400, { ok: false, error: 'invalid-session-id' })

        try {
          // Prefer the live artifact location; fall back to the trash entry.
          let dir: string | undefined
          const snapshots = await ctx.sessionPersistence.list()
          const meta = snapshots.find((snapshot) => snapshot.header.id === id)
          if (meta !== undefined) {
            const location = locateSessionArtifact(ctx, meta)
            if (location.dir !== undefined) dir = location.dir
          }
          if (dir === undefined || !existsSync(dir)) {
            const entry = getEntries().find((candidate) => candidate.sessionId === id)
            if (entry?.originalPath !== undefined && existsSync(entry.originalPath)) {
              dir = entry.originalPath
            }
          }
          if (dir === undefined || !existsSync(dir)) {
            return respond(res, 404, { ok: false, error: 'folder-not-found' })
          }
          await openFolder(dir)
          respond(res, 200, { ok: true })
        } catch (error) {
          ctx.logger.warn('[dsh-session-manager] open-folder failed:', error)
          respond(res, 500, { ok: false, error: 'open-folder-failed' })
        }
      },
    })

    return () => trash.close()
  })
}
