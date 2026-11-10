// Git Control worker: runs git for the panel. No dependencies, plain Node.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collect as collectProc, commandLine, currentHost, fsx, hostKey, hpath, inRepo, isLocator, locator, onHost, parseLocator, remote, findRepos, setDestinationResolver, sshDestination, sshConfigAlias, sshConfigAliases, sshResolve, toLocator } from './hosts.mjs'

// Orca starts workers with a minimal environment. git (global config, credential helpers) and
// the Orca CLI need the usual user folders, so fill in whatever is missing.
const home = os.homedir()
const BASE_ENV = { ...process.env }
BASE_ENV.HOME ||= home
if (process.platform === 'win32') {
  BASE_ENV.USERPROFILE ||= home
  BASE_ENV.APPDATA ||= path.join(home, 'AppData', 'Roaming')
  BASE_ENV.LOCALAPPDATA ||= path.join(home, 'AppData', 'Local')
}

const NET_TIMEOUT = 110_000 // panel requests time out at 120 s
const LOCAL_TIMEOUT = 30_000

class GitError extends Error {
  constructor(message) {
    super(message)
    this.code = 'action_failed'
  }
}

/**
 * Run git and resolve with stdout; rejects with stderr on a non-zero exit unless `okCodes` allows it. When another git (an agent in a terminal, an editor) holds the repository lock for a
 * moment, wait and try again instead of failing.
 */
async function git(cwd, args, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gitOnce(cwd, args, opts)
    } catch (e) {
      if (attempt < 4 && /index\.lock': File exists|Unable to create '.*\.lock'/.test(e.message)) {
        await new Promise((res) => setTimeout(res, 250 * (attempt + 1)))
        continue
      }
      throw e
    }
  }
}

/** The last git commands, newest last, for the command log; anything that looks like a secret is masked. */
const CMD_LOG = []
const QUIET_GIT = new Set(['diff-tree', 'status', 'log', 'rev-parse', 'for-each-ref', 'show', 'diff', 'config', 'rev-list', 'cat-file', 'ls-files', 'name-rev', 'worktree', 'stash', 'remote', 'reflog', 'branch', 'tag', 'merge-base', 'ls-tree', 'blame', 'check-ignore', 'credential', 'var', 'symbolic-ref', 'describe', 'shortlog', 'count-objects', 'merge-file', 'hash-object', 'ls-remote'])
const SECRET = /(token|password|passwd|secret|authorization|private-token|extraheader)/i
function logCmd(args, code, ms, host) {
  // our own plumbing (-c core.editor=true, the rebase plan's sequence editor) is not what the person ran
  const plain = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && /^(core\.editor|sequence\.editor)=/.test(args[i + 1] || '')) i++
    else plain.push(args[i])
  }
  args = plain
  const shown = args.map((a) => (SECRET.test(a) ? a.replace(/=.*/, '=•••') : a))
  CMD_LOG.push({ at: Date.now(), host: host || undefined, cmd: 'git ' + shown.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' '), code, ms })
  if (CMD_LOG.length > 150) CMD_LOG.splice(0, CMD_LOG.length - 150)
}
function gitOnce(cwd, args, { input, timeout = LOCAL_TIMEOUT, okCodes = [0], signal, env, raw } = {}) {
  const t0 = Date.now()
  const host = currentHost()
  const gitEnv = {
    GIT_TERMINAL_PROMPT: '0', // never hang waiting for a password prompt
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    ...env
  }
  const opts = { input, timeout, signal, maxBytes: 8 * 1024 * 1024, what: `git ${args[0]}` } // keep answers well under the 1 MiB-ish budget after trimming
  // On an SSH host: the same git command line, run there in the repository's folder.
  const run = host
    ? remote(host, commandLine('git', args, { cwd, env: gitEnv }), opts)
    : collectProc('git', args, { ...opts, cwd, env: { ...BASE_ENV, ...gitEnv } })
  return run.then((r) => {
    // everyday reads (status, log, refs…) would bury the commands people ran; keep the ones that change things
    if (!QUIET_GIT.has(args[0])) logCmd(args, r.code, Date.now() - t0, host)
    if (r.spawnError) throw new GitError(r.spawnError.code === 'ENOENT' ? 'git was not found on PATH' : r.spawnError.message)
    if (r.killedFor) throw new GitError(r.killedFor)
    if (host && r.code === 127 && !r.out.length) throw new GitError(`git was not found on ${host} (${r.err || 'command not found'})`)
    if (okCodes.includes(r.code)) return raw ? r.out : r.out.toString('utf8')
    const stdout = r.out.toString('utf8')
    throw new GitError(r.err || stdout.trim() || `git ${args[0]} failed (exit ${r.code})`)
  })
}

const net = { timeout: NET_TIMEOUT }
const req = (v, name) => {
  if (typeof v !== 'string' || !v.trim()) throw new GitError(`${name} is required`)
  if (v.startsWith('-')) throw new GitError(`${name} may not start with "-"`)
  return v.trim()
}
const files = (list) => {
  if (!Array.isArray(list) || !list.length) throw new GitError('no files given')
  return list.map(String)
}
const trunc = (s, max = 400_000) =>
  s.length > max ? s.slice(0, max) + '\n… (truncated)' : s

// ---------- repository ----------

// --git-dir and --show-toplevel never change for a folder: ask git once per repository.
const repoPaths = new Map()
async function paths(repo) {
  const k = hostKey(repo)
  let p = repoPaths.get(k)
  if (!p) {
    p = git(repo, ['rev-parse', '--git-dir', '--show-toplevel']).then((out) => {
      const [d, top] = out.trim().split(/\r?\n/)
      return { gitDir: hpath().resolve(repo, d), toplevel: top || repo }
    })
    repoPaths.set(k, p)
    p.catch(() => repoPaths.delete(k))
  }
  return p
}
async function gitDir(repo) {
  return (await paths(repo)).gitDir
}

/**
 * The two sides of a merge, rebase, cherry-pick or revert in progress, by name, so conflicts read as
 * "Current (main)" and "Incoming (feature-x)". Current is always what HEAD holds (git's "ours").
 */
async function stateSides(repo, d, state, branch) {
  const P = hpath()
  const read = async (f) => (await fsx.read(P.join(d, f), 'utf8').catch(() => '')).trim()
  const nameOf = async (sha) => (sha ? (await git(repo, ['name-rev', '--name-only', '--no-undefined', '--exclude=refs/stash', sha]).catch(() => '')).trim().replace(/^(remotes\/|tags\/)/, '').replace(/\^0$/, '') || sha.slice(0, 7) : '')
  const subject = async (sha) => (await git(repo, ['log', '-1', '--format=%s', sha]).catch(() => '')).trim()
  if (state === 'merge') {
    const msg = (await read('MERGE_MSG')).split('\n')[0]
    const m = msg.match(/^Merge (?:remote-tracking )?(branch|tag|commit) '([^']+)'/)
    return { current: branch || 'HEAD', incoming: m ? m[2] : await nameOf((await read('MERGE_HEAD')).split('\n')[0]), incomingKind: m ? m[1] : 'commit' }
  }
  if (state === 'rebase') {
    const dir = (await fsx.exists(P.join(d, 'rebase-merge'))) ? 'rebase-merge' : 'rebase-apply'
    const [headName, onto, stopped, rebaseHead] = await Promise.all([read(`${dir}/head-name`), read(`${dir}/onto`), read(`${dir}/stopped-sha`), read('REBASE_HEAD')])
    const head = headName.replace(/^refs\/heads\//, '')
    const stop = stopped || rebaseHead
    return { current: await nameOf(onto), incoming: head ? `${head}${stop ? ` @ ${stop.slice(0, 7)}` : ''}` : stop.slice(0, 7), incomingKind: 'commit', incomingSubject: stop ? await subject(stop) : '' }
  }
  const pick = await read(state === 'cherry-pick' ? 'CHERRY_PICK_HEAD' : 'REVERT_HEAD')
  return { current: branch || 'HEAD', incoming: pick.slice(0, 7), incomingKind: 'commit', incomingSubject: pick ? await subject(pick) : '' }
}

/** What is in the git folder that tells an operation is under way (one look, also on a remote host). */
async function gitDirMarks(repo) {
  const names = await fsx.readdir(await gitDir(repo)).catch(() => [])
  return new Set(names)
}
function stateOf(marks) {
  if (marks.has('rebase-merge') || marks.has('rebase-apply')) return 'rebase'
  if (marks.has('MERGE_HEAD')) return 'merge'
  if (marks.has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (marks.has('REVERT_HEAD')) return 'revert'
  return null
}
async function repoState(repo) {
  return stateOf(await gitDirMarks(repo))
}

/** Whether Orca workspace `w` (its path a locator on a remote host) is the folder `p` of the current request. */
const isWorkspaceOf = (w, p) => norm(w.path) === norm(toLocator(hpath().resolve(String(p))))

/** A path for comparing; a relative one is taken against `base` (the repository). */
const norm = (p, base) => {
  if (isLocator(String(p))) return String(p).replace(/\/+$/, '') // a repository on another machine: compared as named
  const n = hpath().resolve(base || '', String(p)).replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' && !currentHost() ? n.toLowerCase() : n
}

let wsCache = null
async function listWorkspaces(orca) {
  if (wsCache && Date.now() - wsCache.at < 10000) return wsCache.list
  const list = await listWorkspacesUncached(orca)
  if (list.length) wsCache = { at: Date.now(), list } // an empty answer (Orca not ready yet) is not kept
  return list
}
async function listWorkspacesUncached(orca) {
  if (!orca.host.has('workspace.list')) return []
  try {
    const { workspaces } = await orca.host.call('workspace.list', {})
    // This machine's workspaces, and those on SSH hosts (named by a locator; git runs there over ssh).
    // A paired Orca server ("runtime:") runs its own plugins, so its workspaces are not listed here.
    const list = []
    for (const w of workspaces) {
      const host = sshTargetOf(w.hostId)
      if (host === undefined) continue
      list.push({ ...w, path: host ? locator(host, w.path) : w.path, host: host || undefined, hostLabel: host ? (await serverName(host)).name : undefined })
    }
    // Orca names a workspace after its branch; the repository's name comes from its shared git folder
    // (".../ecustom-web/.git" → "ecustom-web"), the same for every worktree of that repository.
    await Promise.all(
      list.map((w) =>
        inRepo(w.path, async (dir) => {
          const out = await gitOnce(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], { timeout: 8000 }).catch(() => '')
          const [common, top] = out.trim().split(/\r?\n/)
          if (!common) return
          const P = hpath()
          const c = common.replace(/[\\/]+$/, '')
          w.repoName = P.basename(/[\\/]\.git$/i.test(c) ? P.dirname(c) : c).replace(/\.git$/i, '')
          w.main = !!top && P.resolve(P.dirname(c)).toLowerCase() === P.resolve(top).toLowerCase()
        })
      )
    )
    return list
  } catch {
    return []
  }
}

// ---------- SSH hosts ----------
// Orca names a host "local", "ssh:<target id>" or "runtime:<environment id>". Git Control reaches an SSH
// target with the system ssh, by the name Orca shows for it (normally the ~/.ssh/config alias it was
// imported from); when that is an address, the ~/.ssh/config alias that logs in to it.

/** The SSH target id of an Orca host id; null for this machine; undefined for a host Git Control cannot reach. */
function sshTargetOf(hostId) {
  if (!hostId || hostId === 'local') return null
  if (!hostId.startsWith('ssh:')) return undefined
  try {
    return decodeURIComponent(hostId.slice(4)) || undefined
  } catch {
    return undefined
  }
}
/** Orca's SSH targets, as `orca host list` shows them: [{ id, name }]. */
function sshTargets() {
  return onHost(null, () =>
    memo('sshTargets', 60_000, async () => {
      const r = await runProc(ORCA_BIN, ['host', 'list', '--json'], { timeout: 15_000 }).catch(() => null)
      try {
        const hosts = JSON.parse(r?.stdout || '').result?.hosts || []
        return hosts.filter((h) => h.kind === 'ssh' && h.id).map((h) => ({ id: String(h.id), name: String(h.name || h.id) }))
      } catch {
        return []
      }
    })
  )
}
async function hostLabel(host) {
  return (await sshTargets()).find((t) => t.id === host)?.name || host
}
/**
 * How a server is shown: its ~/.ssh/config alias when Orca names it by address ("172.26.166.220" →
 * "office-server"), else Orca's name. `orcaName` keeps Orca's name when the two differ.
 */
async function serverName(host) {
  const label = await hostLabel(host)
  const alias = await sshConfigAlias(label).catch(() => label)
  return alias !== label && !/^ssh:\/\//.test(alias) ? { name: alias, orcaName: label } : { name: label, orcaName: null }
}
/**
 * The ssh destination for a host: the name Orca shows for it (or what was typed); an address there
 * becomes the ~/.ssh/config alias that logs in to it, when there is one.
 */
async function destinationFor(host) {
  return sshConfigAlias(await hostLabel(host))
}
setDestinationResolver(destinationFor)

// ---------- servers: SSH hosts whose repositories the picker lists ----------
// Every SSH host set up in Orca is a server here, and so is any ssh destination added in Git Control.
// Each is searched for Git repositories (the home folder by default), so its projects show up in the
// repository menu without opening each one in Orca first.

const SERVERS_KEY = 'servers.v1' // { manual: [destination], prefs: { [id]: { roots, hidden } } }
const SCANS_KEY = 'serverScans.v1' // { [id]: { at, dirs, error } }: shown at once after a restart
const DEFAULT_ROOTS = ['~']
const SCAN_TTL = 5 * 60_000
const OWNED_TARGET = /^(runtime-ssh-|machine-)/ // Orca's own VMs and machines: not the person's servers

async function storageGet(key) {
  if (!ORCA?.host.has('storage.get')) return null
  try {
    return (await ORCA.host.call('storage.get', { key })).value ?? null
  } catch {
    return null
  }
}
async function storageSet(key, value) {
  if (ORCA?.host.has('storage.set')) await ORCA.host.call('storage.set', { key, value })
}
async function serverConfig() {
  const c = (await storageGet(SERVERS_KEY)) || {}
  return { manual: Array.isArray(c.manual) ? c.manual.map(String) : [], prefs: c.prefs && typeof c.prefs === 'object' ? c.prefs : {} }
}
const cleanRoots = (roots) => {
  const list = (Array.isArray(roots) ? roots : String(roots || '').split(/[;\n]+/)).map((r) => String(r).trim()).filter(Boolean)
  for (const r of list) if (!/^(~(\/|$)|\/)/.test(r)) throw new GitError(`"${r}" is not a folder on the server: start it with / or ~`)
  return list.length ? [...new Set(list)].slice(0, 20) : DEFAULT_ROOTS
}

let scans = null // id -> { at, dirs, error, running }
async function scanState() {
  if (!scans) {
    scans = new Map()
    const saved = (await storageGet(SCANS_KEY)) || {}
    for (const [id, v] of Object.entries(saved)) if (v && Array.isArray(v.dirs)) scans.set(id, { at: +v.at || 0, dirs: v.dirs.map(String), error: v.error || null })
  }
  return scans
}
let saveScansTimer = null
function saveScans() {
  clearTimeout(saveScansTimer)
  saveScansTimer = setTimeout(() => {
    const out = {}
    for (const [id, v] of scans) out[id] = { at: v.at, dirs: v.dirs.slice(0, 2000), error: v.error }
    storageSet(SCANS_KEY, out).catch(() => {})
  }, 500)
  saveScansTimer.unref?.()
}

/** Every server: Orca's SSH hosts and the ones added here, with where to look and what was found. */
async function serverList() {
  const [cfg, targets, state] = await Promise.all([serverConfig(), sshTargets(), scanState()])
  const list = targets.filter((t) => !OWNED_TARGET.test(t.id)).map((t) => ({ id: t.id, label: t.name, source: 'orca' }))
  for (const d of cfg.manual) if (!list.some((x) => x.id === d)) list.push({ id: d, label: d, source: 'manual' })
  const names = await Promise.all(list.map((x) => serverName(x.id)))
  return list.map((x, i) => {
    const pref = cfg.prefs[x.id] || {}
    const st = state.get(x.id)
    return {
      ...x,
      label: names[i].name,
      orcaName: names[i].orcaName,
      roots: Array.isArray(pref.roots) && pref.roots.length ? pref.roots : DEFAULT_ROOTS,
      hidden: !!pref.hidden,
      scanning: !!st?.running,
      scannedAt: st?.at || null,
      repoCount: st?.dirs?.length ?? null,
      error: st?.error || null
    }
  })
}

/** Look for repositories on one server again (unless a recent answer is good enough). */
async function scanServer(server, { force = false } = {}) {
  const state = await scanState()
  const cur = state.get(server.id)
  if (cur?.running) return cur.running
  if (!force && cur?.at && Date.now() - cur.at < SCAN_TTL) return cur
  const running = onHost(server.id, () => findRepos(server.roots))
    .then(
      (dirs) => ({ at: Date.now(), dirs, error: null }),
      (e) => ({ at: Date.now(), dirs: cur?.dirs || [], error: e.message })
    )
    .then((r) => {
      state.set(server.id, r)
      saveScans()
      return r
    })
  state.set(server.id, { ...(cur || { dirs: [] }), running })
  return running
}

/** The repositories found on the servers that are not hidden, named by locator. */
async function serverRepos({ refresh = false, wait = 1500 } = {}) {
  const servers = (await serverList()).filter((x) => !x.hidden)
  const all = Promise.all(servers.map((x) => scanServer(x, { force: refresh })))
  // answer with what is known; a scan that takes longer reports back on the next call
  await Promise.race([all, new Promise((res) => setTimeout(res, wait).unref?.())])
  const state = await scanState()
  const repos = []
  for (const x of servers)
    for (const dir of state.get(x.id)?.dirs || [])
      repos.push({ id: `server:${locator(x.id, dir)}`, kind: 'folder', name: path.posix.basename(dir), repoName: path.posix.basename(dir), path: locator(x.id, dir), branch: null, host: x.id, hostLabel: x.label, discovered: true })
  return { servers: await serverList(), repos }
}

async function serverUpdate(id, change) {
  const cfg = await serverConfig()
  if (change.remove) {
    cfg.manual = cfg.manual.filter((d) => d !== id)
    delete cfg.prefs[id]
    ;(await scanState()).delete(id)
    saveScans()
  } else {
    if (change.add && !cfg.manual.includes(id)) cfg.manual.push(id)
    const pref = { ...(cfg.prefs[id] || {}) }
    if (change.roots !== undefined) pref.roots = cleanRoots(change.roots)
    if (change.hidden !== undefined) pref.hidden = !!change.hidden
    cfg.prefs[id] = pref
    if (change.roots !== undefined) (await scanState()).delete(id) // other folders: look again
  }
  await storageSet(SERVERS_KEY, cfg)
  shortMemo.clear() // the add-server suggestions mark which hosts are servers
  forgetFocusCaches()
}

/**
 * The ~/.ssh/config hosts to offer when adding a server: each with where it connects
 * ("frank@10.0.0.5:2222") and whether it already is a server by that name.
 */
function sshAliasChoices() {
  return onHost(null, () =>
    memo('sshAliasChoices', 60_000, async () => {
      const aliases = sshConfigAliases().slice(0, 100)
      const servers = await serverList()
      const where = []
      for (let i = 0; i < aliases.length; i += 8) where.push(...(await Promise.all(aliases.slice(i, i + 8).map((a) => sshResolve(a).catch(() => null)))))
      const taken = new Set(servers.map((x) => x.label.toLowerCase()))
      for (const x of servers) if (x.orcaName) taken.add(x.orcaName.toLowerCase())
      return aliases.map((name, i) => {
        const g = where[i]
        const detail = g ? `${g.user ? g.user + '@' : ''}${g.hostname}${g.port && g.port !== '22' ? ':' + g.port : ''}` : ''
        return { name, detail, added: taken.has(name.toLowerCase()) }
      })
    })
  )
}

/** Add a server by ssh destination: it must log in without a password; then its repositories are found. */
async function serverAdd({ dest, roots }) {
  const d = sshDestination(String(dest || '').trim()) // validates
  const targets = await sshTargets()
  if (targets.some((t) => t.id === d || t.name.toLowerCase() === d.toLowerCase())) throw new GitError(`${d} is already a server (from Orca)`)
  const r = await onHost(d, () => remote(d, 'git --version'))
  if (r.code !== 0) throw new GitError(`${d} answers over ssh, but git is not installed there (${r.err || `exit ${r.code}`})`)
  await serverUpdate(d, { add: true, roots: roots ?? DEFAULT_ROOTS })
  const server = (await serverList()).find((x) => x.id === d)
  const scan = await scanServer(server, { force: true })
  return { id: d, repoCount: scan.dirs.length, error: scan.error }
}

// The Orca CLI knows the exact focused worktree (`--worktree active`); the host API does not.
function orcaCli() {
  const exe = process.platform === 'win32' ? 'orca.exe' : 'orca'
  const dirs = [process.cwd(), path.dirname(process.execPath)]
  for (const d of dirs) {
    for (const p of [path.join(d, 'resources', 'bin', exe), path.join(d, '..', 'bin', exe)])
      if (existsSync(p)) return p
  }
  return 'orca' // on PATH
}
const ORCA_BIN = process.env.GIT_CONTROL_ORCA_BIN || orcaCli() // tests use a stand-in

/** Map terminal ids to their worktree paths with `orca terminal list --json` (cached briefly). */
let termCache = null
function terminalWorktrees() {
  if (termCache && Date.now() - termCache.at < 8000) return termCache.p
  const p = terminalWorktreesUncached()
  termCache = { at: Date.now(), p }
  return p // an empty map is cached too: no terminals is a normal answer
}
function forgetFocusCaches() {
  termCache = null
  wsCache = null
}
function terminalWorktreesUncached() {
  return new Promise((resolve) => {
    const child = /\.mjs$/.test(ORCA_BIN) ? spawn(process.execPath, [ORCA_BIN, 'terminal', 'list', '--json'], { windowsHide: true, env: BASE_ENV }) : spawn(ORCA_BIN, ['terminal', 'list', '--json'], { windowsHide: true, env: BASE_ENV })
    const out = []
    const timer = setTimeout(() => child.kill(), 5000)
    child.stdout.on('data', (d) => out.push(d))
    child.on('error', () => resolve({}))
    child.on('close', () => {
      clearTimeout(timer)
      const map = {}
      try {
        const list = JSON.parse(Buffer.concat(out).toString('utf8')).result?.terminals || []
        for (const t of list) {
          const host = sshTargetOf(t.executionHostId)
          if (t.handle && t.worktreePath && host !== undefined) map[t.handle] = host ? locator(host, t.worktreePath) : t.worktreePath
        }
      } catch {}
      resolve(map)
    })
  })
}

// ---------- status & diff ----------

function parseStatus(raw) {
  const parts = raw.split('\0')
  const res = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] }
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]
    if (!line) continue
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ')
      const val = rest.join(' ')
      if (key === 'branch.head') res.branch = val === '(detached)' ? null : val
      else if (key === 'branch.oid') res.oid = val === '(initial)' ? null : val
      else if (key === 'branch.upstream') res.upstream = val
      else if (key === 'branch.ab') {
        const m = val.match(/\+(\d+) -(\d+)/)
        if (m) [res.ahead, res.behind] = [+m[1], +m[2]]
      }
      continue
    }
    const kind = line[0]
    if (kind === '?') {
      res.files.push({ path: line.slice(2), x: '?', y: '?', untracked: true })
    } else if (kind === '1') {
      const f = line.split(' ')
      res.files.push({ path: f.slice(8).join(' '), x: f[1][0], y: f[1][1] })
    } else if (kind === '2') {
      const f = line.split(' ')
      const orig = parts[++i]
      res.files.push({ path: f.slice(9).join(' '), orig, x: f[1][0], y: f[1][1] })
    } else if (kind === 'u') {
      const f = line.split(' ')
      res.files.push({ path: f.slice(10).join(' '), x: f[1][0], y: f[1][1], conflict: true })
    }
  }
  return res
}

const STATUS_MAX = 3000
async function status(repo, { untracked = 'all' } = {}) {
  // One git process: --show-stash adds "# stash <n>" to the header (git 2.35+).
  const run = (u) => git(repo, ['status', '--porcelain=v2', '--branch', '--show-stash', '-z', `--untracked-files=${u}`])
  const [first, marks, { gitDir: d, toplevel }, refsSig] = await Promise.all([
    run(untracked === 'normal' ? 'normal' : 'all').catch((e) => (/too large/.test(e.message) ? null : Promise.reject(e))),
    gitDirMarks(repo),
    paths(repo),
    refsFingerprint(repo).catch(() => '') // any branch, tag or remote moving changes this
  ])
  // Thousands of new files (a build folder, node_modules not in .gitignore): list a new folder as one
  // line, the way `git status` does, and never send more than STATUS_MAX files (Orca's 1 MiB limit).
  let raw = first
  let st = raw != null ? parseStatus(raw) : null
  if (!st || (st.files.length > STATUS_MAX && untracked !== 'normal')) {
    raw = await run('normal')
    st = parseStatus(raw)
  }
  const total = st.files.length
  if (total > STATUS_MAX) {
    st.files.sort((a, b) => (a.conflict ? -2 : a.untracked ? 1 : 0) - (b.conflict ? -2 : b.untracked ? 1 : 0))
    st.files = st.files.slice(0, STATUS_MAX)
  }
  st.filesTotal = total
  const stashCount = +(raw.match(/(?:^|\0)# stash (\d+)/)?.[1] || 0)
  const state = stateOf(marks)
  const bisect = marks.has('BISECT_LOG')
  const sides = state ? await stateSides(repo, d, state, st.branch).catch(() => null) : null
  return { ...st, state, stashCount, toplevel: toLocator(toplevel), bisect, refsSig, sides }
}

async function diff(repo, { file, staged, untracked, context = 3 }) {
  const f = String(file)
  if (untracked) {
    const out = await git(repo, ['diff', '--no-color', '--no-index', '--', devNull(), f], {
      okCodes: [0, 1]
    })
    return trunc(out)
  }
  const args = ['diff', '--no-color', `-U${+context || 3}`]
  if (staged) args.push('--cached')
  args.push('--', f)
  return trunc(await git(repo, args))
}
// An image file at a revision ('' = the working tree, ':' = the index, else a commit-ish), as a data URL
// for the diff preview. Only common image types, at most 3 MB (it travels as base64).
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml' }
async function fileImage(repo, { ref = '', file }) {
  const f = String(file || '')
  const type = IMAGE_TYPES[f.split('.').pop().toLowerCase()]
  if (!type) throw new GitError('not an image')
  let buf
  if (ref === '') {
    buf = await fsx.read(await workPath(repo, f))
  } else {
    const r = String(ref)
    if (r.startsWith('-')) throw new GitError('bad revision')
    buf = await git(repo, ['show', r === ':' ? `:${f}` : `${r}:${f}`], { raw: true })
  }
  if (buf.length > 3 * 1024 * 1024) throw new GitError('Image is larger than 3 MB: open it in the editor to view')
  return { src: `data:${type};base64,${buf.toString('base64')}`, size: buf.length }
}
const devNull = () => (process.platform === 'win32' ? 'NUL' : '/dev/null')

// ---------- log ----------

const SEP = '\x1f'
const REC = '\x1e'

// ---------- shared cache: worktrees of one repository share history ----------
// Every worktree of a repository has the same commits and refs, so their log and commit details
// are cached once per repository (its common git dir). A cheap fingerprint of all refs tells when
// the cache is stale; only "which commit is HEAD" differs per worktree and is applied afterwards.
const commonDirs = new Map()
async function commonDir(repo) {
  const k = hostKey(norm(repo))
  if (!commonDirs.has(k)) {
    const d = (await git(repo, ['rev-parse', '--git-common-dir'])).trim()
    commonDirs.set(k, norm(hpath().resolve(repo, d)))
  }
  return commonDirs.get(k)
}
/** Share an answer for a moment: one refresh asks the same question several times. */
const shortMemo = new Map()
function cached(map, key, ms, fn) {
  key = hostKey(key) // the same path on two machines is two repositories
  const hit = map.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.p
  const p = Promise.resolve().then(fn)
  map.set(key, { at: Date.now(), p })
  p.catch(() => map.get(key)?.p === p && map.delete(key))
  if (map.size > 200) map.delete(map.keys().next().value)
  return p
}
const memo = (key, ms, fn) => cached(shortMemo, key, ms, fn)
function refsFingerprint(repo) {
  return memo('fp|' + repo, 300, async () => {
    const raw = await git(repo, ['for-each-ref', '--format=%(objectname) %(refname)'])
    return createHash('sha1').update(raw).digest('hex')
  })
}
/** HEAD's commit and branch (null when detached or before the first commit), in one git call. */
function headInfo(repo) {
  return memo('head|' + repo, 300, async () => {
    const out = await git(repo, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD', '--'], { okCodes: [0] }).catch(() => '') // no commits yet: nothing
    const [oid, name] = out.trim().split(/\s+/)
    return { oid: /^[0-9a-f]{40}$/.test(oid || '') ? oid : null, branch: name && name !== 'HEAD' ? name : null }
  })
}
const logCache = new Map() // key -> { sig, commits }
const showCache = new Map() // common|hash -> details (commits never change)
function remember(map, key, value, max) {
  map.delete(key)
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value)
  return value
}

/** Move the "HEAD" decoration onto this worktree's HEAD commit. */
async function applyHead(repo, commits) {
  const { oid: head, branch } = await headInfo(repo).catch(() => ({ oid: null, branch: null }))
  return commits.map((c) => {
    let refs = c.refs.filter((r) => r !== 'HEAD').map((r) => (r.startsWith('HEAD -> ') ? r.slice(8) : r))
    if (c.hash === head) {
      if (branch) refs = [`HEAD -> ${branch}`, ...refs.filter((r) => r !== branch)]
      else refs = ['HEAD', ...refs]
    }
    return refs === c.refs ? c : { ...c, refs }
  })
}

async function log(repo, opts = {}) {
  // Search results and single-file history are not shared; the plain graph is.
  const shareable = !opts.search && !opts.file
  if (!shareable) return logUncached(repo, opts)
  const [common, sig] = await Promise.all([commonDir(repo), refsFingerprint(repo)])
  // The current-branch view depends on this worktree's HEAD; the all-branches view does not.
  const headKey = opts.all ? '' : (await headInfo(repo)).oid || ''
  const key = hostKey(JSON.stringify([common, !!opts.all, opts.ref || '', headKey, +opts.limit || 200, +opts.skip || 0]))
  const hit = logCache.get(key)
  let commits
  if (hit && hit.sig === sig) commits = hit.commits
  else commits = remember(logCache, key, { sig, commits: await logUncached(repo, opts) }, 60).commits
  return applyHead(repo, commits)
}

async function logUncached(repo, { all = false, limit = 200, skip = 0, search = '', mode = 'all', ref, file } = {}) {
  const args = [
    'log',
    '--date-order', // newest first across branches: a compact graph, as Git Extensions shows
    `--max-count=${Math.min(+limit || 200, 1000)}`,
    `--skip=${+skip || 0}`,
    `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%D${SEP}%s${REC}`
  ]
  const q = String(search || '')
  if (q && (mode === 'all' || !mode)) return searchAll(repo, { all, limit, skip, search: q })
  if (q && mode === 'author') args.push(`--author=${q}`, '-i', '--fixed-strings')
  else if (q && mode === 'content') args.push(`-S${q}`)
  else if (q && mode === 'hash') args.push('--no-walk', req(q, 'hash'))
  else if (q && mode !== 'file') args.push(`--grep=${q}`, '-i', '--fixed-strings')
  if (file) args.push('--follow')
  // Stashes are listed in the Stash tab; in the graph their internal commits are only noise.
  if (all && mode !== 'hash') args.push('--exclude=refs/stash', '--all')
  else if (ref) args.push(req(ref, 'ref'))
  args.push('--')
  if (file) args.push(String(file))
  else if (q && mode === 'file') args.push(`*${q}*`)
  let raw
  try {
    raw = await git(repo, args)
  } catch (e) {
    if (/does not have any commits|bad default revision|unknown revision/.test(e.message)) return []
    throw e
  }
  return raw
    .split(REC)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, author, email, time, refs, subject] = r.split(SEP)
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        time: +time,
        refs: refs ? refs.split(', ') : [],
        subject
      }
    })
}

/**
 * Search everything at once: message (title and description), author (name or email), changed file
 * paths, commit hash and branch/tag names. Each kind runs in parallel; the union is listed newest
 * first. Every commit says what matched (`match`) and, for files and refs, which one (`matchFile`,
 * `matchRef`), so the panel can show why a row is there. Short searches (under 3 characters) match
 * whole words only and skip file and branch names, where they would match almost everything.
 */
async function searchAll(repo, { all = false, limit = 200, skip = 0, search = '' } = {}) {
  const q = String(search || '').trim()
  if (!q) return []
  const short = q.length < 3
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(short ? `(^|[^\\p{L}\\p{N}_])${esc}($|[^\\p{L}\\p{N}_])` : esc, 'iu')
  const want = Math.min(+limit || 200, 1000) + (+skip || 0)
  const scope = all ? ['--exclude=refs/stash', '--all'] : []
  const RS = '\x1e'
  const US = '\x1f'
  const scan = (extra, format, tail = []) =>
    git(repo, ['log', '--date-order', `--max-count=${short ? want * 4 : want}`, `--format=${format}`, ...extra, ...scope, '--', ...tail]).catch(() => '')
  const glob = q.replace(/[*?[\]\\]/g, '\\$&') // the search text, literal, inside a pathspec pattern
  // Files: a "*text*" pattern makes git diff every commit (seconds on a big history). Matching the
  // files that exist now and asking for their exact paths is ~10x faster; the pattern is kept for
  // small histories, where it also finds deleted files.
  const fileScan = async () => {
    if (short) return ''
    const lower = q.toLowerCase()
    const now = (await git(repo, ['ls-files', '-z']).catch(() => '')).split('\0').filter((f) => f && f.toLowerCase().includes(lower))
    if (now.length && now.length <= 60) return scan(['--name-only'], `${RS}%H${US}%at`, now.map((f) => `:(literal)${f}`))
    const count = +(await git(repo, ['rev-list', '--count', ...(all ? ['--all'] : ['HEAD'])]).catch(() => '0')) || 0
    return count <= 5000 ? scan(['--name-only'], `${RS}%H${US}%at`, [`:(icase)*${glob}*`]) : ''
  }
  const [msgRaw, authRaw, fileRaw, hash, refs] = await Promise.all([
    scan(['--grep', q, '-i', '--fixed-strings'], `%H${US}%at${US}%s${US}%b${RS}`),
    scan(['--author', q, '-i', '--fixed-strings'], `%H${US}%at${US}%an${US}%ae${RS}`),
    fileScan(),
    /^[0-9a-f]{4,40}$/i.test(q)
      ? git(repo, ['rev-parse', '--verify', '-q', `${q}^{commit}`], { okCodes: [0, 1] })
          .then((h) => (h.trim() ? git(repo, ['log', '-1', `--format=%H${US}%at`, h.trim()]).then((o) => [o.trim().split(US)]) : []))
          .catch(() => [])
      : [],
    git(repo, ['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags'])
      .then((out) => out.split('\n').filter(Boolean).map((l) => l.split(' ')).filter(([, n]) => (short ? n.split(/[/_.-]/).some((p) => p.toLowerCase() === q.toLowerCase()) : n.toLowerCase().includes(q.toLowerCase()))))
      .catch(() => [])
  ])
  const hits = new Map() // hash -> { at, match:Set, file, ref }
  const add = (h, at, kind, extra = {}) => {
    if (!/^[0-9a-f]{40}$/.test(h || '')) return
    const e = hits.get(h) || { at: +at || 0, match: new Set() }
    e.match.add(kind)
    if (at) e.at = +at
    Object.assign(e, Object.fromEntries(Object.entries(extra).filter(([k]) => !e[k])))
    hits.set(h, e)
  }
  for (const rec of msgRaw.split(RS)) {
    const [h, at, subject = '', body = ''] = rec.replace(/^\n/, '').split(US)
    if (re.test(subject)) add(h, at, 'message')
    else if (re.test(body)) add(h, at, 'body')
  }
  for (const rec of authRaw.split(RS)) {
    const [h, at, name = '', mail = ''] = rec.replace(/^\n/, '').split(US)
    if (re.test(name) || re.test(mail)) add(h, at, 'author')
  }
  for (const rec of fileRaw.split(RS)) {
    const lines = rec.split('\n').filter(Boolean)
    if (!lines.length) continue
    const [h, at] = lines[0].split(US)
    const file = lines.slice(1).find((f) => f.toLowerCase().includes(q.toLowerCase())) || lines[1]
    add(h, at, 'file', { file })
  }
  for (const [h, at] of hash) add(h, at, 'hash')
  if (refs.length) {
    const byTip = new Map()
    for (const [h, n] of refs) if (!byTip.has(h)) byTip.set(h, n)
    const times = await git(repo, ['log', '--no-walk=unsorted', '--stdin', `--format=%H${US}%at`], { input: [...byTip.keys()].join('\n') + '\n' }).catch(() => '')
    for (const l of times.split('\n').filter(Boolean)) {
      const [h, at] = l.split(US)
      add(h, at, 'ref', { ref: byTip.get(h) })
    }
  }
  const ordered = [...hits.entries()].sort((a, b) => b[1].at - a[1].at).slice(+skip || 0, want)
  if (!ordered.length) return []
  const raw = await git(repo, ['log', '--no-walk=unsorted', '--stdin', `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%D${SEP}%s${REC}`], { input: ordered.map(([h]) => h).join('\n') + '\n' })
  return raw
    .split(REC)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash2, parents, author, email, time, refs2, subject] = r.split(SEP)
      const e = hits.get(hash2) || { match: new Set() }
      return { hash: hash2, parents: parents ? parents.split(' ') : [], author, email, time: +time, refs: refs2 ? refs2.split(', ') : [], subject, match: [...e.match], matchFile: e.file, matchRef: e.ref }
    })
}

async function commitShow(repo, args) {
  const key = hostKey((await commonDir(repo)) + '|' + req(args.hash, 'hash'))
  const hit = showCache.get(key)
  if (hit && /^[0-9a-f]{40}$/.test(args.hash)) {
    // refs move; read the current ones (cheap) instead of trusting the cache
    const refs = (await git(repo, ['log', '-1', '--format=%D', hit.hash])).trim()
    return { ...hit, refs: refs ? refs.split(', ') : [] }
  }
  const out = await commitShowUncached(repo, args)
  if (!/^[0-9a-f]{40}$/.test(args.hash)) return out
  remember(showCache, key, out, 400)
  return out
}

/** `--name-status -z`: STATUS\0path\0 (or STATUS\0old\0new\0 for renames and copies). */
function parseNameStatus(raw) {
  const ns = raw.split('\0').filter((x) => x !== '')
  const out = []
  for (let i = 0; i < ns.length; ) {
    const st = ns[i++]
    if (st[0] === 'R' || st[0] === 'C') out.push({ status: st[0], orig: ns[i++], path: ns[i++] })
    else out.push({ status: st[0], path: ns[i++] })
  }
  return out
}

async function commitShowUncached(repo, { hash }) {
  const h = req(hash, 'hash')
  const meta = await git(repo, [
    'show',
    '-s',
    `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%cn${SEP}%ct${SEP}%D${SEP}%B`,
    h
  ])
  const [full, parents, author, email, atime, committer, ctime, refs, body] = meta.split(SEP)
  // A merge commit has no single diff; like Git Extensions, show it against its first parent.
  const parentList = parents ? parents.split(' ') : []
  const target = parentList.length > 1 ? [parentList[0], h] : ['--root', h]
  const [numstat, nameStatus] = await Promise.all([
    git(repo, ['diff-tree', '--no-commit-id', '-r', '-M', '--numstat', '-z', ...target]),
    git(repo, ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', '-z', ...target])
  ])
  const filesOut = parseNameStatus(nameStatus)
  // numstat -z: "add\tdel\tpath\0" or "add\tdel\t\0old\0new\0"
  const nm = numstat.split('\0')
  const stats = {}
  for (let i = 0; i < nm.length; i++) {
    const m = nm[i].match(/^(\S+)\t(\S+)\t(.*)$/)
    if (!m) continue
    let p = m[3]
    if (!p) {
      i++
      p = nm[++i]
    }
    stats[p] = { add: m[1], del: m[2] }
  }
  for (const f of filesOut) Object.assign(f, stats[f.path] || {})
  return {
    hash: full,
    parents: parents ? parents.split(' ') : [],
    author,
    email,
    time: +atime,
    committer,
    ctime: +ctime,
    refs: refs ? refs.split(', ') : [],
    message: body.trim(),
    files: filesOut
  }
}

async function commitFileDiff(repo, { hash, file }) {
  const h = req(hash, 'hash')
  const out = await git(repo, [
    'show',
    '--no-color',
    '--format=',
    '-M',
    '--diff-merges=first-parent', // merges: the diff against the first parent
    h,
    '--',
    String(file)
  ])
  return trunc(out)
}

// ---------- branches & tags ----------

const refsCache = new Map() // repo -> { sig, value }
async function refs(repo) {
  const [sig, head] = await Promise.all([refsFingerprint(repo), headInfo(repo)])
  const key = sig + '|' + (head.branch || head.oid)
  const hit = refsCache.get(hostKey(repo))
  if (hit && hit.key === key) return hit.value
  const value = await refsUncached(repo)
  remember(refsCache, hostKey(repo), { key, value }, 30)
  return value
}

async function refsUncached(repo) {
  const fmt = [
    '%(refname)',
    '%(refname:short)',
    '%(objectname:short)',
    '%(upstream:short)',
    '%(upstream:track,nobracket)',
    '%(HEAD)',
    '%(committerdate:unix)',
    '%(subject)'
  ].join(SEP)
  const raw = await git(repo, [
    'for-each-ref',
    `--format=${fmt}`,
    '--sort=-committerdate',
    'refs/heads',
    'refs/remotes',
    'refs/tags'
  ])
  const local = []
  const remote = []
  const tags = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    const [full, name, hash, upstream, track, head, date, subject] = line.split(SEP)
    const item = { name, hash, date: +date, subject }
    if (full.startsWith('refs/heads/')) {
      const ahead = +(track.match(/ahead (\d+)/)?.[1] || 0)
      const behind = +(track.match(/behind (\d+)/)?.[1] || 0)
      local.push({ ...item, upstream, ahead, behind, gone: track === 'gone', current: head === '*' })
    } else if (full.startsWith('refs/remotes/')) {
      if (full.endsWith('/HEAD')) continue
      remote.push(item)
    } else tags.push(item)
  }
  return { local, remote, tags }
}

async function push(repo, { force = false, tags = false, remote, branch, hash } = {}) {
  const st = parseStatus(await git(repo, ['status', '--porcelain=v2', '--branch', '-z']))
  const b = branch ? req(branch, 'branch') : st.branch
  if (!b) throw new GitError('HEAD is detached; check out a branch to push')
  if (remote) req(remote, 'remote')
  const args = ['push']
  if (force) args.push('--force-with-lease')
  if (tags) args.push('--follow-tags')
  if (hash) {
    // push only up to this commit: <hash>:refs/heads/<branch> on the branch's remote
    if (!/^[0-9a-f]{4,40}$/i.test(hash)) throw new GitError('bad commit')
    const up = st.branch === b && st.upstream ? st.upstream.split('/')[0] : null
    const r = await defaultRemote(repo, remote || up)
    if (!r) throw new GitError('this repository has no remote; add one in Settings → Remotes')
    args.push(r, `${hash}:refs/heads/${b}`)
    return git(repo, args, net)
  }
  if (!st.upstream || branch) {
    const r = await defaultRemote(repo, remote)
    if (!r) throw new GitError('this repository has no remote; add one in Settings → Remotes')
    args.push('-u', r, b)
  }
  return git(repo, args, net)
}

// ---------- worktrees ----------

async function worktrees(repo) {
  const raw = await git(repo, ['worktree', 'list', '--porcelain'])
  const list = []
  let cur = null
  for (const line of raw.split('\n')) {
    if (!line) {
      if (cur) list.push(cur)
      cur = null
      continue
    }
    const sp = line.indexOf(' ')
    const key = sp < 0 ? line : line.slice(0, sp)
    const val = sp < 0 ? '' : line.slice(sp + 1)
    if (key === 'worktree') cur = { path: val, branch: null, head: null }
    else if (!cur) continue
    else if (key === 'HEAD') cur.head = val
    else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '')
    else if (key === 'detached') cur.detached = true
    else if (key === 'bare') cur.bare = true
    else if (key === 'locked') cur.locked = val || true
    else if (key === 'prunable') cur.prunable = val || true
  }
  if (cur) list.push(cur)
  const top = norm((await paths(repo)).toplevel)
  list.forEach((w, i) => {
    w.main = i === 0
    w.current = norm(w.path) === top
  })
  return list
}

async function worktreeAdd(repo, { path: p, branch, newBranch, base, detach }) {
  const target = req(p, 'path')
  const args = ['worktree', 'add']
  if (detach) args.push('--detach')
  if (newBranch) args.push('-b', req(newBranch, 'branch name'))
  args.push(hpath().resolve(repo, target))
  if (newBranch && base) args.push(req(base, 'base'))
  else if (branch) args.push(req(branch, 'branch'))
  return git(repo, args, net)
}

// ---------- config ----------

async function configList(repo, { scope }) {
  const s = scope === 'global' ? '--global' : '--local'
  const raw = await git(scope === 'global' ? undefined : repo, ['config', s, '--list', '-z'], {
    okCodes: [0, 1] // exit 1 when the global file does not exist yet
  })
  return raw
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const nl = e.indexOf('\n')
      return nl < 0 ? { key: e, value: '' } : { key: e.slice(0, nl), value: e.slice(nl + 1) }
    })
}

const CONFIG_KEY = /^[a-z0-9][a-z0-9-]*(\.[^\s=]+)*\.[a-z][a-z0-9-]*$/i

async function configSet(repo, { scope, key, value }) {
  const k = req(key, 'key')
  if (!CONFIG_KEY.test(k)) throw new GitError(`"${k}" is not a valid config key`)
  const s = scope === 'global' ? '--global' : '--local'
  return git(scope === 'global' ? undefined : repo, ['config', s, k, String(value ?? '')])
}

async function configUnset(repo, { scope, key }) {
  const k = req(key, 'key')
  const s = scope === 'global' ? '--global' : '--local'
  return git(scope === 'global' ? undefined : repo, ['config', s, '--unset-all', k], {
    okCodes: [0, 5]
  })
}

// ---------- stash ----------

async function stashList(repo) {
  const raw = await git(repo, ['stash', 'list', `--format=%gd${SEP}%H${SEP}%ct${SEP}%gs`])
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, hash, time, subject] = l.split(SEP)
      return { ref, hash, time: +time, subject }
    })
}
const stashRef = (r) => {
  if (!/^stash@\{\d+\}$/.test(String(r))) throw new GitError('invalid stash ref')
  return r
}

// ---------- helpers for external CLIs ----------

/** Run any program; resolves { code, stdout, stderr }. `shell` is needed for .cmd shims on Windows. */
function runProc(bin, args, { cwd, input, timeout = 60_000, shell = false, env } = {}) {
  // Tools (gh, glab, the AI agents) run on this machine: a repository on a remote host has no folder
  // here, so they start in the temp folder and get what they need from git through their input.
  if (cwd && currentHost()) cwd = os.tmpdir()
  return new Promise((resolve) => {
    // a stand-in written in Node (tests, on any OS) runs with Node
    const child = /\.mjs$/.test(bin) ? spawn(process.execPath, [bin, ...args], { cwd, windowsHide: true, env: env ? { ...BASE_ENV, ...env } : BASE_ENV }) : spawn(bin, args, { cwd, shell, windowsHide: true, env: env ? { ...BASE_ENV, ...env } : BASE_ENV })
    const out = []
    const err = []
    const timer = setTimeout(() => {
      err.push(Buffer.from(`\n${bin} timed out after ${Math.round(timeout / 1000)} s`))
      child.kill()
    }, timeout)
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}

// ---------- full-tab graph ----------

// Orca names a tab after its file: "Git.control" reads as the tool's name (the .control extension opens
// Git Control). The extension stays lowercase: Orca's phone app matches it case-sensitively.
const TAB_FILE = 'Git.control'
const OLD_TAB_FILES = ['.orca-git-graph.gitgraph', 'Git.Control']

/**
 * Keep Git Control tab files (this one and the "untitled.gitgraph" the + menu creates) out of
 * `git status` in every worktree of the repo, through .git/info/exclude: never committed or shared.
 */
async function ignoreGraphFiles(repo) {
  const common = await commonDir(repo)
  const P = hpath()
  const exclude = P.join(common, 'info', 'exclude')
  const cur = await fsx.read(exclude, 'utf8').catch(() => '')
  const lines = cur.split(/\r?\n/)
  const add = ['*.gitgraph', TAB_FILE].filter((x) => !lines.includes(x))
  if (add.length) await fsx.mkdirp(P.dirname(exclude))
  if (add.length) await fsx.write(exclude, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + (lines.includes('*.gitgraph') ? '' : '# Git Control tabs\n') + add.join('\n') + '\n')
}

/**
 * Write the tab's marker file (ignored by git) and open it as an Orca editor tab. With `focus: false`
 * the tab opens in its worktree in the background, without changing what the person is looking at.
 */
async function openGraphTab(repo, { focus = true } = {}) {
  const P = hpath()
  // a folder that is not a repository but holds some (ABC with A, B and C inside): the tab lives in
  // the folder, and Git Control shows the repositories inside it
  let top
  try {
    top = (await paths(repo)).toplevel
  } catch (e) {
    if (currentHost() || !(await reposInside(repo)).children.length) throw e
    top = path.resolve(repo)
  }
  const file = P.join(top, TAB_FILE)
  if (await fsx.exists(P.join(top, '.git'))) await ignoreGraphFiles(top) // ignored before the file exists, so it never shows as a change
  // tab files of earlier versions; removed first, since on Windows and macOS "Git.Control" and
  // "Git.control" are one file and writing would keep the old spelling
  const names = await fsx.readdir(top).catch(() => [])
  for (const old of OLD_TAB_FILES) if (names.includes(old)) await fsx.rm(P.join(top, old)).catch(() => {})
  // the tab reads which repository it shows from its file: a locator for one on a remote host
  await fsx.write(file, JSON.stringify({ repo: toLocator(top) }) + '\n')
  await openInOrca(file, top, { focus, what: 'the tab' })
  return { opened: true }
}

/**
 * Open a file of a worktree as an Orca editor tab. On this machine through Orca's CLI (it can open in the
 * background); on a remote host through the host API, by the workspace Orca knows that folder as.
 */
async function openInOrca(file, top, { focus = true, what = 'the file' } = {}) {
  const host = currentHost()
  if (host) {
    if (!ORCA?.host.has('editor.open')) throw new GitError(`This Orca version cannot open ${what} on a remote host; update Orca`)
    const P = path.posix
    const inside = (w) => file === w.dir || file.startsWith(w.dir.replace(/\/+$/, '') + '/')
    const ws = (await listWorkspaces(ORCA))
      .map((w) => ({ ...w, ...parseLocator(w.path) }))
      .map((w) => ({ ...w, dir: w.path }))
      .filter((w) => w.host === host && inside(w))
      .sort((a, b) => b.dir.length - a.dir.length)[0]
    if (!ws) throw new GitError(`Orca has no workspace for ${top} on this host: add the folder in Orca to open ${what} there`)
    await ORCA.host.call('editor.open', { workspaceId: ws.id, path: P.relative(ws.dir, file) })
    return
  }
  const r = await runProc(ORCA_BIN, ['file', 'open', file, '--worktree', `path:${path.resolve(top)}`, ...(focus ? ['--focus'] : []), '--json'], {
    timeout: 15_000
  })
  let res = null
  try {
    res = JSON.parse(r.stdout)
  } catch {}
  if (!res?.ok) throw new GitError(res?.error?.message || r.stderr.trim() || `Orca could not open ${what}`)
}

// ---------- AI ----------

const AI = {
  claude: { bin: 'claude', args: ['-p', '--output-format', 'text'], shell: false, name: 'Claude Code' },
  codex: { bin: 'codex', args: ['exec', '--skip-git-repo-check', '-'], shell: process.platform === 'win32', name: 'Codex' }
}

async function aiCommitMessage(repo, agent, { instructions = '', scope: want = 'auto' } = {}) {
  const a = AI[agent] || AI.claude
  let diff = want === 'all' ? '' : await git(repo, ['diff', '--cached', '--no-color', '-U2'])
  let scope = 'staged changes'
  if (want === 'staged' && !diff.trim()) throw new GitError('Nothing is staged')
  if (!diff.trim()) {
    diff = await git(repo, ['diff', 'HEAD', '--no-color', '-U2'], { okCodes: [0, 128] })
    scope = 'all uncommitted changes'
  }
  if (!diff.trim()) throw new GitError('There are no changes to describe')
  const recent = await git(repo, ['log', '-8', '--format=%s'], { okCodes: [0, 128] }).catch(() => '')
  const prompt = [
    `Write a git commit message for the ${scope} below.`,
    'Rules: one subject line under 72 characters in the imperative mood; if the change is not trivial,',
    'add a blank line and a short body of bullet points. Match the style of the recent commits when there are any.',
    'Output ONLY the commit message: no quotes, no code fences, no explanations.',
    String(instructions).trim() ? `Extra instructions from the user: ${String(instructions).trim()}` : '',
    recent.trim() ? `\nRecent commits:\n${recent.trim()}` : '',
    `\nDiff:\n${diff.length > 60_000 ? diff.slice(0, 60_000) + '\n… (diff truncated)' : diff}`
  ].join('\n')
  const r = await runProc(a.bin, a.args, { cwd: repo, input: prompt, timeout: 100_000, shell: a.shell })
  if (r.code !== 0) {
    const why = r.code === -1 ? `${a.name} CLI (${a.bin}) was not found on PATH` : r.stderr.trim().split('\n').slice(-3).join('\n')
    throw new GitError(why || `${a.name} failed`)
  }
  return r.stdout
    .trim()
    .replace(/^```[a-z]*\n?|```$/g, '')
    .replace(/^(["'])([\s\S]*)\1$/, '$2') // only a matching pair around the whole message
    .trim()
}

/** Open a terminal in the repo's Orca workspace running the agent with a conflict-resolution prompt. */
async function aiResolve(orca, repo, agent) {
  const a = AI[agent] || AI.claude
  const ws = (await listWorkspaces(orca)).find((w) => isWorkspaceOf(w, repo))
  if (!ws) throw new GitError('This repository is not an Orca workspace, so a terminal cannot be opened for it')
  const state = await repoState(repo)
  const conflicted = (await git(repo, ['diff', '--name-only', '--diff-filter=U'])).trim().split('\n').filter(Boolean)
  const op = state || 'merge'
  const prompt =
    `A git ${op} is in progress in this repository and ${conflicted.length || 'some'} file${conflicted.length === 1 ? ' has' : 's have'} conflicts (run git status to list them). ` +
    'Resolve every conflict by understanding what both sides intended and keeping both changes where possible. ' +
    'Remove all conflict markers, make sure the code still builds, then stage the resolved files with git add. ' +
    `Do not commit and do not run git ${op} --continue or --abort; I will review and continue myself.`
  // The command goes through the terminal's shell: keep only plain characters (no quotes, %, $, \).
  const safe = prompt.replace(/[^\w .,:;()'\/-]/g, ' ')
  const command = a.bin === 'codex' ? `codex "${safe}"` : `claude "${safe}"`
  const { terminalId } = await orca.host.call('terminal.create', {
    workspaceId: ws.id,
    title: `AI ${op} (${a.name})`,
    command
  })
  return { terminalId, agent: a.name }
}

// ---------- merge requests (GitHub pull requests, GitLab merge requests) ----------

/**
 * Where a remote lives: host (with the port of an http(s) URL), project path (GitLab subgroups
 * included), protocol for the API and the credential lookup, and which service it is. SSH remotes
 * map to the https host without the SSH port.
 */
function parseRemote(url) {
  const s = String(url).trim()
  let m = s.match(/^(https?):\/\/(?:[^@/]+@)?([^/:]+)(?::(\d+))?\/(.+?)(?:\.git)?\/?$/)
  let protocol = 'https'
  let hostname
  let port = ''
  let p
  if (m) [, protocol, hostname, port = '', p] = m
  else {
    m = s.match(/^(?:ssh:\/\/)?[^@/]+@([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/)
    if (!m) return null
    ;[, hostname, p] = m
    hostname = hostname.replace(/^(ssh|altssh)\.(github\.com|gitlab\.com)$/i, '$2')
  }
  p = p.replace(/^\/+/, '')
  const host = port ? `${hostname}:${port}` : hostname
  const forced = process.env.GITX_API_KIND // tests only
  const kind = forced === 'github' || forced === 'gitlab' ? forced : /github/i.test(hostname) ? 'github' : 'gitlab' // self-hosted GitLab is the common case
  return { host, hostname, path: p, kind, protocol, web: `${protocol}://${host}/${p}` }
}

const toolOk = (bin, args, env) => runProc(bin, args, { timeout: 15_000, env }).then((r) => r.code === 0, () => false)
// Tool and sign-in checks are slow (a process each) and rarely change: remember them for a minute.
const toolMemo = new Map()
const slow = (key, fn, ms = 60_000) => cached(toolMemo, key, ms, fn)
const cliFor = (kind) => (kind === 'github' ? 'gh' : 'glab')
const installed = (bin) => slow('v|' + bin, () => toolOk(bin, ['--version']))
const canInstall = () => (process.platform === 'win32' ? slow('winget', () => toolOk('winget', ['--version'])) : Promise.resolve(false))
const cliSignedIn = (kind, host) =>
  slow(`auth|${kind}|${host}`, async () => (await installed(cliFor(kind))) && toolOk(cliFor(kind), ['auth', 'status', '--hostname', host]))

/**
 * The service of a remote. A host named neither github nor gitlab is GitHub Enterprise when
 * `git config gitcontrol.provider github` says so or gh is signed in to it; otherwise GitLab.
 */
async function remoteWhere(repo, remote) {
  const where = parseRemote((await git(repo, ['remote', 'get-url', remote])).trim())
  if (!where) return null
  const set = (await git(repo, ['config', '--get', 'gitcontrol.provider'], { okCodes: [0, 1] }).catch(() => '')).trim().toLowerCase()
  if (set === 'github' || set === 'gitlab') where.kind = set
  else if (!process.env.GITX_API_KIND && !/github|gitlab/i.test(where.hostname) && (await cliSignedIn('github', where.host))) where.kind = 'github'
  return where
}

/** The remote to use: `preferred` when given, else the branch's own, else origin, else the first one. */
async function defaultRemote(repo, preferred) {
  if (preferred) return req(preferred, 'remote')
  const remotes = (await git(repo, ['remote'])).split(/\s+/).filter(Boolean)
  return remotes.includes('origin') ? 'origin' : remotes[0] || null
}

// ---------- the saved Git login (credential helper) as an API token ----------

const credCache = new Map() // protocol://host -> { at, p }
/**
 * The token Git already uses for this host (`git credential fill`, never interactive). Only ever
 * used for API calls to that same host; never logged or sent to the panel.
 */
function gitCredential(where, cwd) {
  const key = hostKey(`${where.protocol}://${where.host}`)
  const hit = credCache.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p
  const fill = (dir) =>
    gitOnce(dir, ['-c', 'credential.interactive=never', 'credential', 'fill'], {
      input: `protocol=${where.protocol}\nhost=${where.host}\n\n`,
      timeout: 15_000,
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
    }).then(
      (out) => {
        const kv = Object.fromEntries(out.split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
        return kv.password ? { username: kv.username || '', token: kv.password } : null
      },
      () => null
    )
  // A repository on a remote host: the login git uses there (it pushes from there), else this machine's.
  const p = currentHost()
    ? fill(cwd || null).then((c) => c || onHost(null, () => fill(os.homedir())))
    : fill(cwd || os.homedir())
  const entry = { at: Date.now(), p, ttl: 10 * 60_000 }
  credCache.set(key, entry)
  p.then((c) => c || (entry.ttl = 60_000)) // no login: look again in a minute
  return p
}
const hasGitLogin = (where, cwd) => gitCredential(where, cwd).then((c) => !!c, () => false)

function apiBase(where) {
  if (process.env.GITX_API_BASE) return process.env.GITX_API_BASE.replace(/\/+$/, '') // tests only
  if (where.kind === 'github') return where.hostname === 'github.com' ? 'https://api.github.com' : `${where.protocol}://${where.host}/api/v3`
  return `${where.protocol}://${where.host}/api/v4`
}

const authStyle = new Map() // GitLab host → 'pat' | 'bearer': how its token is sent

/** Call the GitHub/GitLab REST API with the saved Git login. Resolves the JSON (or text with `raw`). */
async function forgeApi(where, method, apiPath, { body, accept, raw, cwd, total } = {}) {
  const cred = await gitCredential(where, cwd)
  if (!cred) throw new GitError(`There is no saved Git login for ${where.host}`)
  const send = (auth) =>
    fetch(apiBase(where) + apiPath, {
      method,
      headers: {
        ...auth,
        Accept: accept || (where.kind === 'github' ? 'application/vnd.github+json' : 'application/json'),
        'User-Agent': 'git-control',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000)
    })
  let res
  try {
    // GitLab: an OAuth token works as Bearer; a personal access token only as PRIVATE-TOKEN. Remember
    // which one this host took, so every later request is one request, not a refused one and a retry.
    const hostKey = `${where.protocol}://${where.host}`
    const pat = where.kind === 'gitlab' && authStyle.get(hostKey) === 'pat'
    res = await send(pat ? { 'PRIVATE-TOKEN': cred.token } : { Authorization: `Bearer ${cred.token}` })
    if (res.status === 401 && where.kind === 'gitlab') {
      res = await send(pat ? { Authorization: `Bearer ${cred.token}` } : { 'PRIVATE-TOKEN': cred.token })
      if (res.status !== 401) authStyle.set(hostKey, pat ? 'bearer' : 'pat')
    }
  } catch (e) {
    throw new GitError(`${where.host} could not be reached: ${e.cause?.message || e.message}`)
  }
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  // GitHub's rate limit (403 or 429): not a login problem; say when it lifts
  if ((res.status === 403 || res.status === 429) && (RATE_LIMIT.test(json?.message || '') || res.headers.get('x-ratelimit-remaining') === '0')) {
    const reset = +res.headers.get('x-ratelimit-reset') * 1000 || (+res.headers.get('retry-after') ? Date.now() + +res.headers.get('retry-after') * 1000 : 0)
    throw Object.assign(new GitError(`${where.host} rate limit reached${reset ? `; it lifts at ${new Date(reset).toLocaleTimeString()}` : ''}`), { status: res.status, resetAt: reset || null })
  }
  if (res.status === 401 || res.status === 403) {
    if (res.status === 401) credCache.delete(`${where.protocol}://${where.host}`)
    const detail = json?.message || json?.error_description || json?.error || ''
    throw Object.assign(
      new GitError(`The saved Git login for ${where.host} is not allowed to do this (HTTP ${res.status}${detail ? `: ${detail}` : ''}). It may lack the API scope; use the web page instead.`),
      { data: { kind: 'git-login-denied', status: res.status }, status: res.status }
    )
  }
  if (!res.ok) {
    const detail = json ? [json.message, ...(Array.isArray(json.errors) ? json.errors.map((x) => x.message || x) : json.errors ? [JSON.stringify(json.errors)] : [])].filter(Boolean).join('; ') || JSON.stringify(json) : text.slice(0, 300)
    throw Object.assign(new GitError(`${where.host}: ${detail || `HTTP ${res.status}`}`), { status: res.status, json })
  }
  // total: GitLab's count of everything a list has (X-Total), with the first page
  if (total) return { json, total: +res.headers.get('x-total') || (Array.isArray(json) ? json.length : 0) }
  return raw ? text : json
}

/** How to talk to a service: its CLI when signed in, else the saved Git login, else null. */
async function viaFor(where, cwd, prefer) {
  if (prefer !== 'git' && (await cliSignedIn(where.kind, where.host))) return 'cli'
  if (await hasGitLogin(where, cwd)) return 'git'
  return prefer === 'git' && (await cliSignedIn(where.kind, where.host)) ? 'cli' : null
}

/**
 * Title and description filled in the way GitLab does: one commit gives its subject and body;
 * several give the branch name made readable, with the commits listed. Draft for draft/ or wip/
 * branches, "Closes #12" for a branch named after an issue, and the repo's default merge
 * request / pull request template added when it has one.
 */
async function mrDefaults(repo, branch, commits, kind, { targetRef, where } = {}) {
  const draft = /^(draft|wip)[/_-]/i.test(branch)
  const issue = branch.replace(/^[^/]+\//, '').match(/^(\d+)[-_]/)?.[1]
  const readable = branch.replace(/^(draft|wip)[/_-]/i, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase())
  // As GitLab/GitHub do: one commit gives its subject and body; several give the branch name.
  const title = commits.length === 1 ? commits[0].subject : readable
  const parts = []
  if (commits.length === 1) parts.push(commits[0].body || `- ${commits[0].subject}`)
  else if (commits.length) parts.push(commits.map((c) => `- ${c.subject}`).join('\n'))
  if (issue) parts.push(`Closes #${issue}`)
  const template = await mrTemplate(repo, kind, { targetRef, where }).catch(() => '')
  if (template) parts.push(template)
  return { title, body: parts.join('\n\n'), draft }
}

/**
 * The description template the service would use: the project's own default (GitLab setting), else
 * the Default template file on the target branch (as the service reads it), else in the working tree.
 */
async function mrTemplate(repo, kind, { targetRef, where } = {}) {
  if (kind !== 'github' && where) {
    const via = await viaFor(where, repo).catch(() => null)
    if (via) {
      const proj = await forgeCall(where, via, 'GET', `/projects/${projectPath(where.path)}`, null, repo).catch(() => null)
      if (proj?.merge_requests_template?.trim()) return proj.merge_requests_template.trim()
    }
  }
  const dirs = kind === 'github' ? ['.github', '', 'docs'] : ['.gitlab/merge_request_templates']
  const want = kind === 'github' ? /^pull_request_template\.md$/i : /^default\.md$/i
  const readFrom = async (ref) => {
    for (const d of dirs) {
      const names = (await git(repo, ['ls-tree', '--name-only', `${ref}:${d}`], { okCodes: [0, 128] }).catch(() => '')).split('\n').filter(Boolean)
      const hit = names.find((n) => want.test(n))
      if (hit) return (await git(repo, ['show', `${ref}:${d ? d + '/' : ''}${hit}`]).catch(() => '')).trim()
    }
    return ''
  }
  if (targetRef) {
    const t = await readFrom(targetRef)
    if (t) return t
  }
  const top = (await paths(repo).catch(() => ({ toplevel: '' }))).toplevel
  for (const d of dirs) {
    if (!top) break
    const dir = hpath().join(top, d)
    const hit = (await fsx.readdir(dir).catch(() => [])).find((n) => want.test(n))
    if (hit) return (await fsx.read(hpath().join(dir, hit), 'utf8')).trim()
  }
  return ''
}

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function mrInfo(repo, target, source) {
  const head = await headInfo(repo)
  // the branch to merge: the given one, else the checked-out one
  const branch = source ? String(source).replace(/^(refs\/heads\/)/, '') : head.branch
  const oid = head.oid
  if (!branch) throw new GitError('Check out the branch you want to merge first (HEAD is detached)')
  if (/^-/.test(branch)) throw new GitError('bad branch name')
  const upstream = (await git(repo, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { okCodes: [0, 128] }).catch(() => '')).trim()
  const remote = upstream.split('/')[0] || (await defaultRemote(repo))
  if (!remote) throw new GitError('This repository has no remote to open a merge request on')
  const where = await remoteWhere(repo, remote)
  if (!where) throw new GitError('Could not tell where the remote is hosted')
  const targetName = String(target).replace(new RegExp(`^${escRe(remote)}/`), '')
  const targetRef = (await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${targetName}`], { okCodes: [0, 1] })).trim()
    ? `${remote}/${targetName}`
    : targetName
  // the source as git knows it: the local branch, or only its remote copy
  const hasLocal = !!(await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { okCodes: [0, 1] })).trim()
  const sourceRef = hasLocal ? branch : `${remote}/${branch}`
  const cli = cliFor(where.kind)
  const toolsP = Promise.all([installed(cli), cliSignedIn(where.kind, where.host), hasGitLogin(where, repo), canInstall()])
  const full = (await git(repo, ['log', '--format=%s%x1f%b%x1e', '-50', `${targetRef}..${sourceRef}`], { okCodes: [0, 128] }).catch(() => ''))
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [subject, body = ''] = r.split('\x1f')
      return { subject: subject.trim(), body: body.trim() }
    })
  const commits = full.map((c) => c.subject)
  const defaults = await mrDefaults(repo, branch, full, where.kind, { targetRef, where })
  const ahead = upstream ? +(await git(repo, ['rev-list', '--count', `${upstream}..${sourceRef}`]).catch(() => '0')).trim() : null
  // commits the other way round (target has, source lacks): the person likely meant the reverse
  const reverse = +(await git(repo, ['rev-list', '--count', `${sourceRef}..${targetRef}`], { okCodes: [0, 128] }).catch(() => '0')).trim() || 0
  const [inst, signedIn, gitLogin, install] = await toolsP
  // via: how "Create now" will create it: 'cli' (gh/glab), 'git' (the saved Git login), or null (web page only)
  const tools = { cli, installed: inst, signedIn, gitLogin, canInstall: install, via: signedIn ? 'cli' : gitLogin ? 'git' : null }
  return { source: branch, sourceRef, oid, target: targetName, remote, upstream: upstream || null, needsPush: hasLocal && (!upstream || ahead > 0), reverse, ...where, commits, defaults, tools }
}

/** The service's own "new merge request" page, prefilled: works with nothing installed. */
function mrWebUrl(info, { title, body, assignees = [], reviewers = [], removeSource, squash }) {
  const seg = (b) => encodeURIComponent(b).replace(/%2F/g, '/') // branch names keep their slashes in a path
  // pairs, so a key can repeat (GitLab's assignee_ids[])
  const q = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  if (info.kind === 'github')
    // GitHub's compare page takes assignees but not reviewers
    return `${info.web}/compare/${seg(info.target)}...${seg(info.source)}?${q([['expand', '1'], ['title', title], ['body', body], ['assignees', assignees.map((a) => a.username).join(',')]])}`
  return `${info.web}/-/merge_requests/new?${q([
    ['merge_request[source_branch]', info.source],
    ['merge_request[target_branch]', info.target],
    ['merge_request[title]', title],
    ['merge_request[description]', body],
    ...assignees.map((a) => ['merge_request[assignee_ids][]', a.id]),
    ...reviewers.map((r) => ['merge_request[reviewer_ids][]', r.id]),
    ['merge_request[force_remove_source_branch]', removeSource ? '1' : removeSource === false ? '0' : undefined],
    ['merge_request[squash]', squash ? '1' : squash === false ? '0' : undefined]
  ])}`
}

/** Open a web page in the person's default browser (the worker is not limited to a click like frames are). */
function openInBrowser(url) {
  // https, and http too: self-hosted GitLab often runs on plain http inside a company network
  if (!/^https?:\/\/[^\s"]+$/.test(url) || process.env.GITX_NO_BROWSER) return Promise.resolve(false) // tests keep the browser closed
  const [bin, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]] // no shell, so "&" in the URL is safe
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  const ok = (r) => r.code === 0 || r.code === null
  return runProc(bin, args, { timeout: 10_000 }).then(
    async (r) => {
      if (ok(r) || process.platform !== 'win32') return ok(r)
      // Windows fallback: the URL travels in an environment variable, never through a command line
      const p = await runProc('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:GITX_OPEN_URL'], { timeout: 15_000, env: { GITX_OPEN_URL: url } }).catch(() => null)
      return !!p && ok(p)
    },
    () => false
  )
}

const projectPath = (p) => encodeURIComponent(p) // GitLab: group/sub/project → group%2Fsub%2Fproject

/** One REST call through gh/glab (`via: 'cli'`) or the saved Git login. */
async function forgeCall(w, via, method, apiPath, body, cwd) {
  if (via === 'cli') {
    const bin = w.kind === 'github' ? 'gh' : 'glab'
    const args = ['api', '--hostname', w.host, '-X', method, apiPath.replace(/^\//, '')]
    if (body) args.push('-H', 'Content-Type: application/json', '--input', '-')
    const r = await runProc(bin, args, { cwd, input: body ? JSON.stringify(body) : undefined, timeout: 60_000 })
    if (r.code !== 0) throw new GitError((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || `${bin} api failed`)
    return jsonOf(r)
  }
  return forgeApi(w, method, apiPath.startsWith('/') ? apiPath : '/' + apiPath, { body, cwd })
}

const PERSON = /^[\w.-]{1,100}$/
/** People of the project who can be assignees/reviewers, plus who "me" is and the project's MR defaults. */
async function mrPeople(repo, { query = '' } = {}) {
  const remote = await defaultRemote(repo)
  if (!remote) throw new GitError('This repository has no remote')
  const w = await remoteWhere(repo, remote)
  if (!w) throw new GitError('Could not tell where the remote is hosted')
  const via = await viaFor(w, repo)
  if (!via) return { people: [], me: null, via: null, kind: w.kind, defaults: {} }
  const q = String(query).slice(0, 60)
  if (w.kind === 'github') {
    const [list, me] = await Promise.all([
      forgeCall(w, via, 'GET', `/repos/${w.path}/assignees?per_page=100`, null, repo).catch(() => []),
      forgeCall(w, via, 'GET', '/user', null, repo).catch(() => null)
    ])
    const people = (Array.isArray(list) ? list : []).map((u) => ({ id: u.id, username: u.login, name: u.name || u.login, avatar: u.avatar_url || '' }))
    return { people, me: me?.login ? { id: me.id, username: me.login, name: me.name || me.login } : null, via, kind: 'github', defaults: {} }
  }
  const p = projectPath(w.path)
  const [list, me, proj] = await Promise.all([
    forgeCall(w, via, 'GET', `/projects/${p}/members/all?per_page=100${q ? `&query=${encodeURIComponent(q)}` : ''}`, null, repo).catch(() => []),
    forgeCall(w, via, 'GET', '/user', null, repo).catch(() => null),
    forgeCall(w, via, 'GET', `/projects/${p}`, null, repo).catch(() => null)
  ])
  const people = (Array.isArray(list) ? list : []).filter((u) => u.state !== 'blocked').map((u) => ({ id: u.id, username: u.username, name: u.name || u.username, avatar: u.avatar_url || '' }))
  const squashOpt = proj?.squash_option || 'default_off'
  return {
    people,
    me: me?.username ? { id: me.id, username: me.username, name: me.name || me.username } : null,
    via,
    kind: 'gitlab',
    defaults: { removeSource: proj ? proj.remove_source_branch_after_merge !== false : undefined, squash: squashOpt === 'always' || squashOpt === 'default_on', squashLocked: squashOpt === 'always' || squashOpt === 'never' }
  }
}

/** Assignees / reviewers from the panel: [{ id, username }], checked. */
function cleanPeople(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, 20)
    .filter((p) => p && PERSON.test(String(p.username || '')) && Number.isInteger(+p.id))
    .map((p) => ({ id: +p.id, username: String(p.username) }))
}

// ---------- pipelines (GitHub Actions runs / GitLab pipelines) ----------

const PIPE_STATE = (s, c) => {
  const v = String(c || s || '').toLowerCase()
  if (/^(success|passed|completed_success)$/.test(v)) return 'passed'
  if (/^(failure|failed|timed_out|startup_failure|action_required)$/.test(v)) return 'failed'
  if (/^(cancelled|canceled|skipped|manual|neutral|stale)$/.test(v)) return v === 'manual' ? 'manual' : 'canceled'
  if (/^(queued|pending|waiting|requested|created|preparing|scheduled|waiting_for_resource)$/.test(v)) return 'pending'
  if (/^(in_progress|running)$/.test(v)) return 'running'
  return v || 'unknown'
}
const secs = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null)

async function pipeTarget(repo) {
  const remote = await defaultRemote(repo)
  if (!remote) throw new GitError('This repository has no remote')
  const w = await remoteWhere(repo, remote)
  if (!w) throw new GitError('Could not tell where the remote is hosted')
  const via = await viaFor(w, repo)
  if (!via) throw new GitError(`Sign in to ${w.host} first: ${cliFor(w.kind)}, or a saved Git login with API access`)
  return { w, via }
}
const pipeId = (v) => {
  if (!/^\d{1,20}$/.test(String(v))) throw new GitError('bad pipeline or job id')
  return String(v)
}

/** Pipelines for a branch (default: the checked-out one), newest first. */
// Finished pipelines' details and commit titles, kept for the session (they never change).
const PIPE_DONE = new Set(['success', 'failed', 'canceled', 'skipped'])
const pipeExtraCache = new Map()
const commitTitleCache = new Map()
function commitTitle(w, via, p, sha, repo) {
  const key = `${w.host}|${p}|${sha}`
  if (commitTitleCache.has(key)) return commitTitleCache.get(key)
  const pr = forgeCall(w, via, 'GET', `/projects/${p}/repository/commits/${sha}`, null, repo).then(
    (c) => c?.title || '',
    () => (commitTitleCache.delete(key), '') // a failure is not remembered
  )
  remember(commitTitleCache, key, pr, 3000)
  return pr
}

async function pipelines(repo, { branch, sha, all, light } = {}) {
  const { w, via } = await pipeTarget(repo)
  // all: every branch's recent runs (the Pipelines tab); otherwise one branch (the current one by default)
  const b = all ? null : branch ? req(branch, 'branch') : (await headInfo(repo)).branch
  const n = all ? 50 : 20
  if (w.kind === 'github') {
    const q = sha ? `head_sha=${encodeURIComponent(sha)}` : b ? `branch=${encodeURIComponent(b)}` : ''
    const r = await forgeCall(w, via, 'GET', `/repos/${w.path}/actions/runs?per_page=${n}${q ? '&' + q : ''}`, null, repo)
    return {
      kind: 'github',
      host: w.host,
      branch: b,
      web: `${w.web}/actions`,
      items: (r?.workflow_runs || []).map((x) => ({
        id: x.id,
        name: x.name || x.display_title || 'workflow',
        title: x.display_title || x.head_commit?.message?.split('\n')[0] || '',
        state: PIPE_STATE(x.status, x.status === 'completed' ? x.conclusion : x.status),
        branch: x.head_branch,
        sha: x.head_sha,
        event: x.event,
        by: x.actor?.login || '',
        at: Date.parse(x.run_started_at || x.created_at) / 1000,
        duration: x.status === 'completed' ? secs(x.run_started_at || x.created_at, x.updated_at) : null,
        url: x.html_url
      }))
    }
  }
  const p = projectPath(w.path)
  const q = sha ? `sha=${encodeURIComponent(sha)}` : b ? `ref=${encodeURIComponent(b)}` : ''
  const list = await forgeCall(w, via, 'GET', `/projects/${p}/pipelines?per_page=${n}${q ? '&' + q : ''}`, null, repo)
  // The list lacks who started it, the commit's message and the stages: for the Pipelines tab, fetch
  // them for the newest runs, 8 at a time. A finished run never changes and a commit's title never
  // does, so both are kept: a refresh asks only about runs still going. light: the list alone.
  const extra = new Map()
  if (all && !light && Array.isArray(list)) {
    const top = list.slice(0, 25)
    const base = `${w.host}|${p}|`
    let i = 0
    const worker = async () => {
      while (i < top.length) {
        const x = top[i++]
        const cached = pipeExtraCache.get(base + x.id)
        if (cached && cached.status === x.status) {
          extra.set(x.id, cached.e)
          continue
        }
        const [d, jobs, title] = await Promise.all([
          forgeCall(w, via, 'GET', `/projects/${p}/pipelines/${x.id}`, null, repo).catch(() => null),
          forgeCall(w, via, 'GET', `/projects/${p}/pipelines/${x.id}/jobs?per_page=100`, null, repo).catch(() => null),
          commitTitle(w, via, p, x.sha, repo)
        ])
        const stages = []
        for (const j of Array.isArray(jobs) ? jobs.slice().reverse() : []) {
          let s = stages.find((z) => z.name === j.stage)
          if (!s) stages.push((s = { name: j.stage, states: [] }))
          s.states.push(PIPE_STATE(j.status))
        }
        const e = { d, stages: stages.map((s) => ({ name: s.name, state: ['failed', 'running', 'pending', 'manual', 'canceled', 'skipped', 'passed'].find((k) => s.states.includes(k)) || 'passed', jobs: s.states.length })), title }
        extra.set(x.id, e)
        if (d && Array.isArray(jobs) && PIPE_DONE.has(x.status)) remember(pipeExtraCache, base + x.id, { status: x.status, e }, 2000)
      }
    }
    await Promise.all(Array.from({ length: 8 }, worker))
  }
  return {
    kind: 'gitlab',
    host: w.host,
    branch: b,
    web: `${w.web}/-/pipelines`,
    items: (Array.isArray(list) ? list : []).map((x) => ({
      ...(() => {
        const e = extra.get(x.id)
        if (!e) return {}
        return { by: e.d?.user?.username || '', byName: e.d?.user?.name || '', commitTitle: e.title || e.d?.name || '', stages: e.stages, tag: !!e.d?.tag, duration: e.d?.duration ?? null, finished: e.d?.finished_at ? Date.parse(e.d.finished_at) / 1000 : null }
      })(),
      id: x.id,
      name: `#${x.id}`,
      title: x.name || '',
      state: PIPE_STATE(x.status),
      branch: x.ref,
      sha: x.sha,
      event: x.source,
      at: Date.parse(x.created_at) / 1000,
      url: x.web_url,
      ...(extra.has(x.id) ? {} : { by: x.user?.username || '', duration: ['success', 'failed', 'canceled'].includes(x.status) ? secs(x.created_at, x.updated_at) : null })
    })).map((it) => ({ ...it, by: it.by || '', duration: it.duration ?? null }))
  }
}

/** Jobs of one pipeline, in stage order. */
async function pipelineJobs(repo, { id }) {
  const { w, via } = await pipeTarget(repo)
  id = pipeId(id)
  if (w.kind === 'github') {
    const r = await forgeCall(w, via, 'GET', `/repos/${w.path}/actions/runs/${id}/jobs?per_page=100`, null, repo)
    return (r?.jobs || []).map((j) => ({
      id: j.id,
      name: j.name,
      stage: j.workflow_name || 'jobs',
      state: PIPE_STATE(j.status, j.status === 'completed' ? j.conclusion : j.status),
      duration: secs(j.started_at, j.completed_at),
      url: j.html_url,
      steps: (j.steps || []).map((s) => ({ name: s.name, state: PIPE_STATE(s.status, s.status === 'completed' ? s.conclusion : s.status) }))
    }))
  }
  const list = await forgeCall(w, via, 'GET', `/projects/${projectPath(w.path)}/pipelines/${id}/jobs?per_page=100&include_retried=false`, null, repo)
  return (Array.isArray(list) ? list : [])
    .map((j) => ({ id: j.id, name: j.name, stage: j.stage, state: PIPE_STATE(j.status), duration: j.duration ? Math.round(j.duration) : null, url: j.web_url, allowFailure: !!j.allow_failure }))
    .sort((a, b) => a.id - b.id)
}

/** The log of one job (last 400 KB), with ANSI colour codes removed. */
async function jobLog(repo, { id }) {
  const { w, via } = await pipeTarget(repo)
  id = pipeId(id)
  const apiPath = w.kind === 'github' ? `/repos/${w.path}/actions/jobs/${id}/logs` : `/projects/${projectPath(w.path)}/jobs/${id}/trace`
  let text
  if (via === 'cli') {
    // logs are full of colour codes, which gh refuses to print unless told to (older gh lacks the flag)
    const base = ['api', '--hostname', w.host, apiPath.slice(1)]
    let r = await runProc(w.kind === 'github' ? 'gh' : 'glab', w.kind === 'github' ? [...base, '--allow-escape-sequences'] : base, { cwd: repo, timeout: 60_000 })
    if (r.code !== 0 && w.kind === 'github' && /unknown flag/i.test(r.stderr)) r = await runProc('gh', base, { cwd: repo, timeout: 60_000 })
    if (r.code !== 0) throw new GitError((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || 'could not read the job log')
    text = r.stdout
  } else text = await forgeApi(w, 'GET', apiPath, { raw: true, accept: 'text/plain', cwd: repo })
  text = String(text || '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r(?!\n)/g, '\n')
    .replace(/section_(start|end):\d+:[\w.-]+\n?/g, '') // GitLab collapsible section markers
  const max = 400_000
  return { log: text.length > max ? text.slice(-max) : text, truncated: text.length > max }
}

/** Retry / re-run failed / cancel a pipeline, or retry one job. */
async function pipelineAct(repo, { id, action, job }) {
  const { w, via } = await pipeTarget(repo)
  const gh = w.kind === 'github'
  const pid = id != null ? pipeId(id) : null
  const jid = job != null ? pipeId(job) : null
  const P = gh ? `/repos/${w.path}/actions` : `/projects/${projectPath(w.path)}`
  const route = {
    retry: gh ? `${P}/runs/${pid}/rerun` : `${P}/pipelines/${pid}/retry`,
    retryFailed: gh ? `${P}/runs/${pid}/rerun-failed-jobs` : `${P}/pipelines/${pid}/retry`,
    cancel: gh ? `${P}/runs/${pid}/cancel` : `${P}/pipelines/${pid}/cancel`,
    retryJob: gh ? `${P}/jobs/${jid}/rerun` : `${P}/jobs/${jid}/retry`
  }[action]
  if (!route || (action === 'retryJob' ? !jid : !pid)) throw new GitError('unknown pipeline action')
  await forgeCall(w, via, 'POST', route, gh ? {} : null, repo)
  shortMemo.clear()
  return { ok: true }
}

/** GitHub: add assignees and request reviewers on a new PR. Returns a warning text, or ''. */
async function githubAddPeople(w, via, number, assignees, reviewers, cwd) {
  const bad = []
  if (assignees.length)
    await forgeCall(w, via, 'POST', `/repos/${w.path}/issues/${number}/assignees`, { assignees: assignees.map((a) => a.username) }, cwd).catch((e) => bad.push(`assignees (${e.message})`))
  const others = reviewers.filter((r) => r.username) // GitHub refuses the PR author as reviewer
  if (others.length)
    await forgeCall(w, via, 'POST', `/repos/${w.path}/pulls/${number}/requested_reviewers`, { reviewers: others.map((r) => r.username) }, cwd).catch((e) => bad.push(`reviewers (${e.message})`))
  return bad.length ? `Created, but GitHub did not accept the ${bad.join(' and ')}` : ''
}

/** Create the merge request with the REST API and the saved Git login. */
async function mrCreateApi(repo, info, { title, body, draft, assignees = [], reviewers = [], removeSource, squash }) {
  if (info.kind === 'github') {
    const base = `/repos/${info.path}/pulls`
    try {
      const pr = await forgeApi(info, 'POST', base, { cwd: repo, body: { title, body, head: info.source, base: info.target, draft: !!draft } })
      const warn = await githubAddPeople(info, 'git', pr.number, assignees, reviewers, repo)
      return { created: true, url: pr.html_url, number: pr.number, ...(warn ? { warning: warn } : {}) }
    } catch (e) {
      if (e.status !== 422 || !/already exists/i.test(e.message)) throw e
      const owner = info.path.split('/')[0]
      const [pr] = (await forgeApi(info, 'GET', `${base}?state=open&head=${encodeURIComponent(`${owner}:${info.source}`)}`, { cwd: repo })) || []
      if (!pr) throw e
      return { created: false, exists: true, url: pr.html_url, number: pr.number }
    }
  }
  const base = `/projects/${projectPath(info.path)}/merge_requests`
  try {
    const t = draft && !/^(draft:|\[draft\])/i.test(title) ? `Draft: ${title}` : title
    const mr = await forgeApi(info, 'POST', base, {
      cwd: repo,
      body: {
        source_branch: info.source,
        target_branch: info.target,
        title: t,
        description: body,
        ...(assignees.length ? { assignee_ids: assignees.map((a) => a.id) } : {}),
        ...(reviewers.length ? { reviewer_ids: reviewers.map((r) => r.id) } : {}),
        ...(removeSource !== undefined ? { remove_source_branch: !!removeSource } : {}),
        ...(squash !== undefined ? { squash: !!squash } : {})
      }
    })
    // read back what GitLab kept: an option it did not take is set again on the new merge request
    const want = { ...(removeSource !== undefined ? { remove_source_branch: !!removeSource } : {}), ...(squash !== undefined ? { squash: !!squash } : {}) }
    const differs = (removeSource !== undefined && !!mr.force_remove_source_branch !== !!removeSource) || (squash !== undefined && !!mr.squash !== !!squash)
    if (differs && mr.iid) await forgeApi(info, 'PUT', `${base}/${mr.iid}`, { cwd: repo, body: want }).catch(() => null)
    return { created: true, url: mr.web_url, number: mr.iid }
  } catch (e) {
    if (e.status !== 409 && !/already exists/i.test(e.message)) throw e
    const q = `?state=opened&source_branch=${encodeURIComponent(info.source)}&target_branch=${encodeURIComponent(info.target)}`
    const [mr] = (await forgeApi(info, 'GET', base + q, { cwd: repo })) || []
    if (!mr) throw e
    return { created: false, exists: true, url: mr.web_url, number: mr.iid }
  }
}

/**
 * Push the branch if needed, then either
 * - web: open the service's prefilled "new merge request" page in the browser, or
 * - direct: create it with the service's CLI (gh / glab) when signed in, else with the saved Git login.
 */
async function mrCreate(repo, { target, source, title, body, draft, web, assignees, reviewers, removeSource, squash }) {
  assignees = cleanPeople(assignees)
  reviewers = cleanPeople(reviewers)
  removeSource = removeSource === undefined ? undefined : !!removeSource
  squash = squash === undefined ? undefined : !!squash
  const extra = { assignees, reviewers, removeSource, squash }
  const info = await mrInfo(repo, req(target, 'target branch'), source)
  if (info.source === info.target) throw new GitError('Pick a different branch to merge into')
  title = String(title || '').trim()
  body = String(body || '')
  const via = info.tools.via
  if (!web && !via) throw new GitError(`${info.tools.cli} is not set up and Git has no saved login for ${info.host}. Use "Open link" to create it on the web page.`)
  if (!web && !title) throw new GitError('A title is required')
  if (info.needsPush) await git(repo, ['push', '-u', info.remote, info.source], net)
  if (web) {
    const url = mrWebUrl(info, { title, body, ...extra })
    return { url, opened: await openInBrowser(url), pushed: info.needsPush }
  }
  if (via === 'git') return { ...(await mrCreateApi(repo, info, { title, body, draft, ...extra })), pushed: info.needsPush, via }
  // gh and glab find the repository from the folder they start in; one on a remote host has no folder here
  const repoFlag = currentHost() ? ['--repo', `${info.host}/${info.path}`] : []
  const r =
    info.kind === 'github'
      ? await runProc('gh', ['pr', 'create', ...repoFlag, '--base', info.target, '--head', info.source, '--title', title, '--body', body, ...(draft ? ['--draft'] : []), ...(assignees.length ? ['--assignee', assignees.map((a) => a.username).join(',')] : []), ...(reviewers.length ? ['--reviewer', reviewers.map((r) => r.username).join(',')] : [])], { cwd: repo, timeout: 90_000 })
      : await runProc('glab', ['mr', 'create', ...repoFlag, '--source-branch', info.source, '--target-branch', info.target, '--title', title, '--description', body, '--yes', ...(draft ? ['--draft'] : []), ...(assignees.length ? ['--assignee', assignees.map((a) => a.username).join(',')] : []), ...(reviewers.length ? ['--reviewer', reviewers.map((r) => r.username).join(',')] : []), ...(removeSource ? ['--remove-source-branch'] : []), ...(squash ? ['--squash-before-merge'] : [])], { cwd: repo, timeout: 90_000 })
  const all = r.stdout + '\n' + r.stderr
  const url = all.match(/https?:\/\/\S+\/(?:pull|merge_requests)\/\d+/)?.[0]
  const number = url ? +url.match(/(\d+)$/)[1] : undefined
  if (r.code === 0 && url) return { created: true, url, number, pushed: info.needsPush, via }
  if (url && /already exists/i.test(all)) return { created: false, exists: true, url, number, pushed: info.needsPush, via }
  throw new GitError(all.trim().split('\n').slice(-4).join('\n') || `${info.tools.cli} could not create it`)
}

/** The terminal command for one setup step (install or sign in to gh / glab). */
function setupCommand(step, host) {
  if (!/^[\w.:-]+$/.test(String(host || ''))) throw new GitError('unexpected host name')
  const commands = {
    'glab-install': 'winget install --id GLab.GLab -e --accept-package-agreements --accept-source-agreements',
    'glab-login': `glab auth login --hostname ${host}`,
    'gh-install': 'winget install --id GitHub.cli -e --accept-package-agreements --accept-source-agreements',
    'gh-login': `gh auth login --hostname ${host} --web --git-protocol https`
  }
  const command = commands[step]
  if (!command) throw new GitError('unknown setup step')
  return command
}
async function runSetup(orca, ws, step, host, title) {
  const command = setupCommand(step, host)
  toolMemo.clear() // signed in or installed afterwards: look again
  // gh and glab run on this machine: sign in here, in a terminal of a workspace on this machine
  if (ws?.host) ws = (await listWorkspaces(orca)).find((w) => !w.host)
  if (!ws || !orca.host.has('terminal.create')) return { ran: false, command }
  await orca.host.call('terminal.create', { workspaceId: ws.id, title, command })
  return { ran: true, command }
}

/** Set up one-click merge requests in an Orca terminal, where any prompt (a browser sign-in, a token) is visible. */
async function mrSetup(orca, repo, { step }) {
  const info = await mrInfo(repo, 'HEAD').catch(() => null)
  const host = info?.host || (/^gh-/.test(step) ? 'github.com' : 'gitlab.com')
  const ws = (await listWorkspaces(orca)).find((w) => isWorkspaceOf(w, repo))
  return runSetup(orca, ws, step, host, 'Merge request setup')
}

// ---------- review inbox: pull/merge requests waiting for you, across every repository ----------

/** Every GitHub/GitLab host the person's Orca workspaces push to, plus github.com and the open repo's host. */
let hostsCache = null
async function forgeHosts(orca, where) {
  // kept a minute, but only once Orca listed some workspaces (right after starting it may list none)
  const list = hostsCache && Date.now() - hostsCache.at < 60_000 ? hostsCache.list : await (async () => {
    const found = new Map([['github|github.com', { kind: 'github', host: 'github.com', hostname: 'github.com', protocol: 'https', path: '' }]])
    const ws = orca ? await listWorkspaces(orca) : []
    await Promise.all(
      ws.slice(0, 60).map(async (w) => {
        const r = await inRepo(w.path, (dir) => defaultRemote(dir).then((rm) => rm && remoteWhere(dir, rm))).catch(() => null)
        if (r) found.set(`${r.kind}|${r.host}`, { ...r, path: '' })
      })
    )
    const value = [...found.values()]
    if (ws.length) hostsCache = { at: Date.now(), list: value }
    return value
  })()
  const out = new Map(list.map((h) => [`${h.kind}|${h.host}`, h]))
  if (where) out.set(`${where.kind}|${where.host}`, { ...where, path: '' })
  return [...out.values()]
}

const jsonOf = (r) => {
  try {
    return JSON.parse(r.stdout)
  } catch {
    return null
  }
}

/** One inbox item list from four queries: review requested, assigned, opened by me, open in this repository. */
function collect(lists, make) {
  const items = new Map()
  for (const [list, role] of lists) {
    for (const x of Array.isArray(list) ? list : []) {
      const it = make(x)
      const prev = items.get(it.url) || { ...it, roles: [] }
      prev.roles.push(role)
      items.set(it.url, prev)
    }
  }
  return [...items.values()]
}

const MERGED_PAGE = 20

// GitHub allows 30 searches a minute. Each search is remembered for 90 s (the status bar poll, the
// panel's prefetch and the tab then share one answer), and when GitHub says the limit is reached no
// search is sent until it lifts: the last answer is shown instead.
const ghSearchCache = new Map() // host|query → { at, value }
const ghPausedUntil = new Map() // host → ms
const RATE_LIMIT = /rate limit|secondary rate|abuse detection/i
async function ghSearch(host, key, fn) {
  const k = `${host}|${key}`
  const hit = ghSearchCache.get(k)
  if (hit && Date.now() - hit.at < 90_000) return hit.value
  const until = ghPausedUntil.get(host) || 0
  if (Date.now() < until) {
    if (hit) return hit.value
    throw new GitError(`GitHub limits how often it can be searched; trying again at ${new Date(until).toLocaleTimeString()}`)
  }
  try {
    const value = await fn()
    remember(ghSearchCache, k, { at: Date.now(), value }, 200)
    return value
  } catch (e) {
    if (RATE_LIMIT.test(e.message)) {
      ghPausedUntil.set(host, Date.now() + (e.resetAt ? Math.max(30_000, e.resetAt - Date.now()) : 90_000))
      if (hit) return hit.value
      throw new GitError(`GitHub limits how often it can be searched; trying again at ${new Date(ghPausedUntil.get(host)).toLocaleTimeString()}`)
    }
    throw e
  }
}

/** opt.page: which page of merged ones; opt.mergedOnly: only that page (Show more). The list's .more says if more merged ones wait. */
const ghLogin = new Map() // host → the signed-in login
async function githubInbox(h, where, via, { page = 1, mergedOnly = false, merged: merged_ = mergedOnly, others = [] } = {}) {
  const otherRepos = others.filter((o) => o.kind === 'github' && o.host === h.host && /^[\w.-]+\/[\w.-]+$/.test(o.path)).map((o) => o.path).slice(0, 12)
  const here = where?.kind === 'github' && where.host === h.host && /^[\w.-]+\/[\w.-]+$/.test(where.path) ? where.path : null
  const base = { provider: 'github', host: h.host, protocol: h.protocol, via }
  if (via === 'cli') {
    const meR = await runProc('gh', ['api', 'user', '--jq', '.login'], { timeout: 20_000, env: h.host === 'github.com' ? undefined : { GH_HOST: h.host } }).catch(() => null)
    base.me = meR?.code === 0 ? meR.stdout.trim() : ''
    const fields = 'number,title,url,repository,author,updatedAt,isDraft,labels,commentsCount,state,assignees'
    const env = h.host === 'github.com' ? undefined : { GH_HOST: h.host }
    // a failed gh search (rate limit included) becomes an error, so ghSearch can pause and fall back
    const ghRun = (args) =>
      runProc('gh', args, { timeout: 30_000, env }).then((r) => (r.code === 0 ? r : Promise.reject(new GitError((r.stderr || r.stdout).trim() || 'gh could not search'))))
    const search = (...q) => ghSearch(h.host, `open ${q.join(' ')}`, () => ghRun(['search', 'prs', ...q, '--state=open', '--json', fields, '--limit', '50'])).catch((e) => ({ code: 1, stderr: e.message, stdout: '[]' }))
    // gh search has no page: ask for all up to this page, keep this page
    const merged = (...q) =>
      ghSearch(h.host, `merged ${page} ${q.join(' ')}`, () => ghRun(['search', 'prs', ...q, '--merged', '--sort', 'updated', '--json', fields, '--limit', String(MERGED_PAGE * page)])).then((r) => {
        const all = jsonOf(r)
        return { code: r.code, stderr: r.stderr, stdout: JSON.stringify(Array.isArray(all) ? all.slice(MERGED_PAGE * (page - 1)) : []) }
      })
    const none = Promise.resolve({ code: 0, stdout: '[]' })
    const open = (...q) => (mergedOnly ? none : search(...q))
    const done = (...q) => (merged_ ? merged(...q).catch((e) => ({ code: 1, stderr: e.message, stdout: '[]' })) : none)
    const otherArgs = otherRepos.flatMap((x) => ['--repo', x])
    const [rev, asg, mine, repo, dRev, dAsg, dMine, dRepo, oth] = await Promise.all([
      open('--review-requested=@me'),
      open('--assignee=@me'),
      open('--author=@me'),
      here ? open('--repo', here) : none,
      mergedOnly ? none : done('--involves=@me'), // All lists this repository's merged ones only
      none,
      none,
      here ? done('--repo', here) : none,
      otherArgs.length ? open(...otherArgs) : none
    ])
    if (!mergedOnly && rev.code !== 0 && asg.code !== 0) throw new GitError((rev.stderr || asg.stderr).trim() || 'gh could not list pull requests')
    if (mergedOnly && dRepo.code !== 0) throw new GitError(dRepo.stderr || 'gh could not list merged pull requests')
    const roles = ['review', 'assigned', 'mine', 'repo']
    const more = [dRev, dAsg, dMine, dRepo].some((r) => jsonOf(r)?.length >= MERGED_PAGE)
    return withMore(more, collect([...[rev, asg, mine, repo, dRev, dAsg, dMine, dRepo].map((r, i) => [jsonOf(r), roles[i % 4]]), [jsonOf(oth), 'repo']], (p) => ({
      ...base,
      state: p.state === 'MERGED' || p.state === 'merged' ? 'merged' : /closed/i.test(p.state || '') ? 'closed' : 'open',
      url: p.url,
      number: p.number,
      title: p.title,
      repo: p.repository?.nameWithOwner || p.repository?.name || '',
      author: p.author?.login || '',
      updated: Date.parse(p.updatedAt) / 1000,
      draft: !!p.isDraft,
      labels: (p.labels || []).map((l) => l.name).filter(Boolean),
      comments: p.commentsCount ?? null,
      noAssignee: Array.isArray(p.assignees) ? !p.assignees.length : undefined
    })))
  }
  // the saved Git login: @me works only for user tokens, so ask who that is first
  const login = ghLogin.get(h.host)
  const me = login ? { login } : await forgeApi(h, 'GET', '/user') // who that is does not change
  if (!me?.login) throw new GitError(`could not tell who is signed in to ${h.host}`)
  ghLogin.set(h.host, me.login)
  base.me = me.login
  const url = (s, st, n) => `/search/issues?per_page=${n}&sort=updated${st === 'merged' ? `&page=${page}` : ''}&q=${encodeURIComponent(`is:pr is:${st} ${s}`)}`
  const q = (s, st = 'open', n = 50) => ghSearch(h.host, url(s, st, n), () => forgeApi(h, 'GET', url(s, st, n))).then((r) => r?.items || [])
  const scopes = [`review-requested:${me.login}`, `assignee:${me.login}`, `author:${me.login}`, here ? `repo:${here}` : null]
  const roles = ['review', 'assigned', 'mine', 'repo']
  // open ones; merged ones only for the All tab: everything I am part of, and this repo (two searches)
  const doneScopes = [mergedOnly ? null : `involves:${me.login}`, null, null, here ? `repo:${here}` : null] // All: this repo's only
  const lists = await Promise.all([
    ...scopes.map((s) => (s && !mergedOnly ? q(s) : [])),
    ...doneScopes.map((s) => (s && merged_ ? q(s, 'merged', MERGED_PAGE).catch((e) => (mergedOnly ? Promise.reject(e) : [])) : []))
  ])
  // the other repositories open in Orca: all their open pull requests, in one search
  const othersList = otherRepos.length ? await q(otherRepos.map((x) => `repo:${x}`).join(' '), mergedOnly ? 'merged' : 'open', mergedOnly ? MERGED_PAGE : 100).catch(() => []) : []
  const more = lists.slice(4).some((l) => l.length >= MERGED_PAGE)
  return withMore(more, collect([...lists.map((l, i) => [l, roles[i % 4]]), [othersList, 'repo']], (p) => ({
    ...base,
    state: p.pull_request?.merged_at ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
    mergedAt: p.pull_request?.merged_at ? Date.parse(p.pull_request.merged_at) / 1000 : null,
    url: p.html_url,
    number: p.number,
    title: p.title,
    repo: String(p.repository_url || '').replace(/^.*\/repos\//, ''),
    author: p.user?.login || '',
    updated: Date.parse(p.updated_at) / 1000,
    draft: !!p.draft,
    labels: (p.labels || []).map((l) => l.name).filter(Boolean),
    comments: p.comments ?? null,
    noAssignee: Array.isArray(p.assignees) ? !p.assignees.length : undefined
  })))
}

const withMore = (more, list) => Object.assign(list, { more })
const lastProjectLists = new Map() // host|list url → the last answer (used when one does not come)

/** GET from the GitLab API through glab (cli) or the saved Git login (git); null when it fails. */
function gitlabGet(h, via, apiPath) {
  if (via === 'cli') return runProc('glab', ['api', '--hostname', h.host, apiPath], { timeout: 30_000 }).then(jsonOf)
  return forgeApi(h, 'GET', '/' + apiPath)
}

async function gitlabInbox(h, where, via, { page = 1, mergedOnly = false, merged: merged_ = mergedOnly, others = [] } = {}) {
  const me = await gitlabGet(h, via, 'user')
  if (!me?.username) throw new GitError(`${via === 'cli' ? 'glab is' : 'the saved Git login is'} not signed in to ${h.host}`)
  const q = 'merge_requests?state=opened&scope=all&per_page=50'
  const u = encodeURIComponent(me.username)
  const here = where?.kind === 'gitlab' && where.host === h.host ? `projects/${projectPath(where.path)}/merge_requests?state=opened&per_page=50` : null
  // each list is tried twice (a slow or flaky company network); a list that still fails is reported,
  // never silently shown as empty
  const once = (p) => gitlabGet(h, via, p).then((r) => (Array.isArray(r) ? r : Promise.reject(new Error('no list'))))
  const soft = (p) => once(p).catch(() => new Promise((res) => setTimeout(res, 800)).then(() => once(p))).catch(() => null)
  // merged ones too (for the All tab): the latest of each list
  const done = (p) => p.replace('state=opened', 'state=merged').replace('per_page=50', `per_page=${MERGED_PAGE}&page=${page}&order_by=updated_at`)
  const open = (p) => (mergedOnly ? [] : soft(p))
  const old = (p) => (merged_ && !mergedOnly ? soft(done(p)) : []) // the All tab lists this repo's merged ones only
  const [rev, asg, mine, repo, dRev, dAsg, dMine, dRepo] = await Promise.all([
    open(`${q}&reviewer_username=${u}`),
    open(`${q}&assignee_username=${u}`),
    open(`${q}&author_username=${u}`),
    here ? open(here) : [],
    old(`${q}&reviewer_username=${u}`),
    old(`${q}&assignee_username=${u}`),
    old(`${q}&author_username=${u}`),
    here && merged_ ? soft(done(here)) : []
  ])
  if (mergedOnly ? dRepo === null : rev === null && asg === null && mine === null) throw new GitError(`could not list merge requests on ${h.host} (it did not answer); showing the last list`)
  const more = [dRev, dAsg, dMine, dRepo].some((l) => l?.length >= MERGED_PAGE)
  // the ones of mine merged in the last 12 hours: a pipeline may still run after the merge, and they
  // stay in Review until it is done; plus how many this repository has merged in all (the All count)
  let recent = [[], [], []]
  let mergedTotal = null
  // the other repositories open in Orca: every open merge request, whoever opened it
  const otherProjects = others.filter((o) => o.kind === 'gitlab' && o.host === h.host && (!where || o.path !== where.path)).slice(0, 30)
  const othersLists = await pool(otherProjects, 4, async (o) => {
    const url = mergedOnly ? `projects/${projectPath(o.path)}/merge_requests?state=merged&per_page=${MERGED_PAGE}&page=${page}&order_by=updated_at` : `projects/${projectPath(o.path)}/merge_requests?state=opened&per_page=30`
    const got = await soft(url)
    // it did not answer this time (a slow network): its last list, so the count does not drop meanwhile
    if (got) return remember(lastProjectLists, `${h.host}|${url}`, got, 300)
    return lastProjectLists.get(`${h.host}|${url}`) || []
  })
  const othersMore = mergedOnly && othersLists.some((l) => l.length >= MERGED_PAGE)
  if (!mergedOnly) {
    const since = encodeURIComponent(new Date(Date.now() - 12 * 3600_000).toISOString())
    const r12 = (p) => soft(`${p.replace('state=opened', 'state=merged').replace('per_page=50', 'per_page=20')}&updated_after=${since}`).then((x) => x || [])
    recent = await Promise.all([r12(`${q}&reviewer_username=${u}`), r12(`${q}&assignee_username=${u}`), r12(`${q}&author_username=${u}`)])
    if (here && via === 'git') mergedTotal = await forgeApi(h, 'GET', '/' + here.replace('state=opened', 'state=merged').replace('per_page=50', 'per_page=1'), { total: true }).then((x) => x.total, () => null)
  }
  const list = collect([[rev, 'review'], [asg, 'assigned'], [mine, 'mine'], [repo, 'repo'], [dRev, 'review'], [dAsg, 'assigned'], [dMine, 'mine'], [dRepo, 'repo'], [recent[0], 'review'], [recent[1], 'assigned'], [recent[2], 'mine'], ...othersLists.map((l) => [l, 'repo'])], (m) => ({
    state: m.state === 'merged' ? 'merged' : m.state === 'closed' ? 'closed' : 'open',
    mergedAt: m.merged_at ? Date.parse(m.merged_at) / 1000 : null,
    provider: 'gitlab',
    host: h.host,
    protocol: h.protocol,
    via,
    me: me.username,
    url: m.web_url,
    number: m.iid,
    projectId: m.project_id,
    title: m.title,
    repo: m.references?.full?.replace(/!\d+$/, '') || '',
    author: m.author?.username || '',
    source: m.source_branch,
    target: m.target_branch,
    updated: Date.parse(m.updated_at) / 1000,
    draft: !!(m.draft || m.work_in_progress),
    labels: (m.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    comments: m.user_notes_count ?? null,
    conflicts: !!m.has_conflicts,
    noReviewer: Array.isArray(m.reviewers) && !m.reviewers.length,
    noAssignee: Array.isArray(m.assignees) ? !m.assignees.length : !m.assignee
  }))
  for (const it of list) if (it.state === 'merged' && it.mergedAt && Date.now() / 1000 - it.mergedAt < 12 * 3600) it.recent = true
  return Object.assign(withMore(more || othersMore, list), { mergedTotal })
}

/** Folders under each scan root (two levels deep) that hold a .git: repositories Orca does not list. */
function scanForRepos(roots) {
  const found = []
  const skip = /^(node_modules|\.git|\.hg|vendor|dist|build|target|\.venv|venv|\.cache)$/i
  const walk = (dir, depth) => {
    if (found.length >= 200) return
    let names
    try {
      names = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (names.some((n) => n.name === '.git')) return found.push(dir) // a repo: its own sub-folders are its business
    if (depth >= 2) return
    for (const n of names) if (n.isDirectory() && !skip.test(n.name) && !n.name.startsWith('.')) walk(path.join(dir, n.name), depth + 1)
  }
  for (const r of roots) if (r && existsSync(r)) walk(path.resolve(r), 0)
  return found
}

/**
 * What a folder is: a repository itself, or a plain folder with repositories inside (up to two levels
 * deep). Asked whenever the focus moves, so the answer is kept for a minute.
 */
const insideCache = new Map()
async function reposInside(dir) {
  const p = path.resolve(String(dir || ''))
  const hit = insideCache.get(p)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  let value
  try {
    const top = (await gitOnce(p, ['rev-parse', '--show-toplevel'], { timeout: 8000 })).trim()
    value = { path: p, isRepo: !!top, toplevel: top || null, children: [] }
  } catch {
    const found = existsSync(p) ? scanForRepos([p]).filter((c) => path.resolve(c) !== p) : []
    const children = await pool(found, 4, async (c) => {
      const branch = await gitOnce(c, ['branch', '--show-current'], { timeout: 8000 }).then((o) => o.trim(), () => '')
      return { path: c, name: path.relative(p, c).replace(/\\/g, '/'), branch }
    })
    value = { path: p, isRepo: false, toplevel: null, children: children.sort((a, b) => a.name.localeCompare(b.name)) }
  }
  remember(insideCache, p, { at: Date.now(), value }, 50)
  return value
}

/** Run fn over items, at most n at a time (many repos must not start many git processes at once). */
async function pool(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++
      out[k] = await fn(items[k], k)
    }
  }))
  return out
}

/**
 * Orca's Project Groups (the sidebar's ORA, Journal, …): which group each registered repo is in comes
 * from `orca repo list`; the groups' names and order are read, read-only, from Orca's own profile
 * state. Either may be missing (another Orca version, no CLI): then repos are simply not grouped.
 */
let groupsCache = null
async function orcaGroups() {
  if (groupsCache && Date.now() - groupsCache.at < 60_000) return groupsCache.value
  const value = { byPath: new Map(), groups: new Map() }
  // tests: groups from a file, and never the person's own Orca data
  if (process.env.GITX_GROUPS_JSON || process.env.GITX_NO_BROWSER) {
    try {
      const t = JSON.parse(readFileSync(process.env.GITX_GROUPS_JSON, 'utf8'))
      for (const [p, id, order] of t.repos) value.byPath.set(path.resolve(p).toLowerCase(), { id, order })
      for (const g of t.groups) value.groups.set(g.id, g)
    } catch {}
    groupsCache = { at: Date.now(), value }
    return value
  }
  try {
    const r = await runProc(ORCA_BIN, ['repo', 'list', '--json'], { timeout: 15_000 })
    for (const repo of JSON.parse(r.stdout)?.result?.repos || [])
      if (repo.path && repo.projectGroupId) value.byPath.set(path.resolve(repo.path).toLowerCase(), { id: repo.projectGroupId, order: repo.projectGroupOrder ?? 0 })
  } catch {}
  if (value.byPath.size) {
    try {
      const { DatabaseSync } = await import('node:sqlite')
      // Orca does not pass APPDATA to plugin workers: the usual places, from the home folder
      const bases = [process.env.APPDATA, path.join(os.homedir(), 'AppData', 'Roaming'), path.join(os.homedir(), 'Library', 'Application Support'), process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')].filter(Boolean)
      const roots = [...new Set(bases.flatMap((b) => [path.join(b, 'orca'), path.join(b, 'Orca')]))] // Windows, macOS, Linux; either spelling
      for (const root of roots) {
        const dir = path.join(root, 'profiles')
        if (!existsSync(dir)) continue
        for (const prof of readdirSync(dir)) {
          const file = path.join(dir, prof, 'profile-state.db')
          if (!existsSync(file)) continue
          const db = new DatabaseSync(file, { readOnly: true })
          try {
            const row = db.prepare("select payload from profile_state_documents where domain = 'projectGroups'").get()
            for (const g of JSON.parse(row?.payload || '[]')) if (g?.id && !value.groups.has(g.id)) value.groups.set(g.id, { id: g.id, name: String(g.name || ''), order: g.tabOrder ?? 0 })
          } finally {
            db.close()
          }
        }
      }
    } catch (e) {
      value.error = String(e.message || e).slice(0, 300)
    }
  }
  groupsCache = { at: Date.now(), value }
  return value
}

// ---------- tags on several repositories at once (Repo Overview) ----------
const TAG_PATTERN = /^[\w.*/-]{1,80}$/
/** The tag naming patterns these repositories use (v*, dev_v*, uat_v*…), most used first. */
async function tagPatterns(repos) {
  const count = new Map()
  await pool(repos, 4, async (r) => {
    const out = await inRepo(r, (p) => gitOnce(p, ['tag', '--list', '--sort=-creatordate'], { timeout: 15_000 })).catch(() => '')
    const seen = new Set()
    for (const t of out.split('\n').slice(0, 300)) {
      const m = t.trim().match(/^(.*?)\d+(?:\.\d+)*(.*)$/)
      if (!m || m[2]) continue // only names that end in a version
      const p = m[1] + '*'
      if (!seen.has(p)) seen.add(p), count.set(p, (count.get(p) || 0) + 1)
    }
  })
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([pattern, repos]) => ({ pattern, repos }))
}
/** The next version after a tag: its last number goes up by one (dev_v1.4.2 → dev_v1.4.3). */
function nextTag(latest, pattern) {
  if (!latest) return pattern.includes('*') ? pattern.replace('*', '1.0.0') : ''
  const m = latest.match(/^(.*?)(\d+)(\D*)$/)
  return m ? `${m[1]}${+m[2] + 1}${m[3]}` : ''
}
/**
 * For each repository: the newest tag matching the pattern, the commit the new tag would go on (the
 * branch as the remote has it, the checked-out commit, or the newest tag of another pattern), and
 * whether that commit already carries a tag of this pattern (nothing to do then).
 */
// "the branch as pushed": fetched from origin first, so the tag goes on what origin has now (kept a
// minute per repo and branch, so changing the pattern or a row does not fetch again)
const tagFetched = new Map()
async function fetchBranch(repo, branch) {
  const key = `${repo}|${branch}`
  const hit = tagFetched.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.p
  const p = (async () => {
    const remote = await defaultRemote(repo).catch(() => null)
    if (!remote) return null
    // one fetch: the branch as origin has it, and origin's tags (never overwriting a local one)
    await git(repo, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`, 'refs/tags/*:refs/tags/*'], { timeout: 45_000 })
    return null
  })().catch((e) => String(e.message || e).split('\n')[0])
  remember(tagFetched, key, { at: Date.now(), p }, 200)
  return p
}

async function tagPlan({ repos = [], pattern, base = {}, branches = {}, fetch = false } = {}) {
  if (!TAG_PATTERN.test(String(pattern || ''))) throw new GitError('Pick a tag pattern like v* or dev_v*')
  // branches: { repo: branch } picks a branch per repository (the tag window's per-row choice)
  for (const b of Object.values(branches)) req(b, 'branch')
  if (base.kind === 'tag' && !TAG_PATTERN.test(String(base.pattern || ''))) throw new GitError('Pick the pattern of the tag to start from')
  if (base.kind === 'branch') req(base.name, 'branch')
  // each repository where it is (a locator: on its server); the row names it as the panel does
  const rows = await pool(repos.slice(0, 100), 4, (named) => inRepo(named, async (repo) => {
    const g = (args) => gitOnce(repo, args, { timeout: 15_000 }).then((o) => o.trim(), () => '')
    const row = { repo: named, name: hpath().basename(repo) }
    const base_ = branches[named] ? { kind: 'branch', name: branches[named] } : base
    try {
      const tags = (await g(['tag', '--list', pattern, '--sort=-v:refname'])).split('\n').filter(Boolean)
      row.latest = tags[0] || null
      row.latestHash = row.latest ? (await g(['rev-list', '-n1', row.latest])).slice(0, 40) : null
      // where the new tag goes
      if (base_.kind === 'branch' && fetch) {
        const err = await fetchBranch(repo, base_.name)
        if (err) row.fetchError = err // the branch as last fetched is used; the row says so
        // origin's tags came with that fetch: the newest one again
        const tags2 = (await g(['tag', '--list', pattern, '--sort=-v:refname'])).split('\n').filter(Boolean)
        row.latest = tags2[0] || null
        row.latestHash = row.latest ? (await g(['rev-list', '-n1', row.latest])).slice(0, 40) : null
      }
      if (base_.kind === 'branch') {
        const remote = await defaultRemote(repo).catch(() => null)
        const remoteRef = remote ? `refs/remotes/${remote}/${base_.name}` : null
        row.at = remoteRef && (await g(['rev-parse', '--verify', '-q', remoteRef])) ? `${remote}/${base_.name}` : (await g(['rev-parse', '--verify', '-q', `refs/heads/${base_.name}`])) ? base_.name : null
        if (!row.at) throw new GitError(`no branch ${base_.name}`)
      } else if (base_.kind === 'tag') {
        row.at = (await g(['tag', '--list', base_.pattern, '--sort=-v:refname'])).split('\n').filter(Boolean)[0] || null
        if (!row.at) throw new GitError(`no tag like ${base_.pattern}`)
      } else row.at = (await g(['branch', '--show-current'])) || 'HEAD' // the checked-out branch, by name
      row.hash = await g(['rev-list', '-n1', row.at])
      if (!row.hash) throw new GitError(`cannot read ${row.at}`)
      row.subject = await g(['log', '-1', '--format=%s', row.hash])
      // already done: that commit carries a tag of this pattern
      row.already = (await g(['tag', '--points-at', row.hash, '--list', pattern])).split('\n').filter(Boolean)
      row.next = row.already.length ? '' : nextTag(row.latest, pattern)
      row.remote = await defaultRemote(repo).catch(() => null)
    } catch (e) {
      row.error = String(e.message || e).split('\n')[0]
    }
    return row
  }))
  return { rows }
}
/** Create (and push) the tags one repository after another, 4 at a time; each says how it went. */
async function tagApply({ items = [], push = true, message = '' } = {}) {
  return pool(items.slice(0, 100), 4, (item) => inRepo(String(item?.repo || ''), async (repo) => {
    const it = { ...item, repo }
    try {
      const name = req(it.name, 'tag name')
      if (!/^[\w.\/-]{1,120}$/.test(name) || name.includes('..')) throw new GitError(`${name} is not a valid tag name`)
      const hash = req(it.hash, 'commit')
      if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new GitError('bad commit')
      const exists = (await gitOnce(it.repo, ['tag', '--list', name], { timeout: 15_000 })).trim()
      if (exists) throw new GitError(`${name} already exists`)
      await git(it.repo, message ? ['tag', '-a', '-m', String(message), name, hash] : ['tag', name, hash])
      let pushed = false
      if (push) {
        const remote = await defaultRemote(it.repo).catch(() => null)
        if (remote) {
          await git(it.repo, ['push', remote, `refs/tags/${name}`], net)
          pushed = true
        }
      }
      return { repo: item.repo, name, ok: true, pushed }
    } catch (e) {
      return { repo: item.repo, name: it.name, ok: false, error: String(e.message || e).split('\n').slice(-2).join(' ') }
    }
  }))
}

/**
 * Every repository at once: Orca's workspaces (on this computer and on SSH hosts), the repos inside the
 * scanned folders, and, with `servers`, the ones found on the servers. A row's path is a locator when
 * the repo is on a server; its git runs there.
 */
async function reposOverview(workspaces, scan, { servers = true } = {}) {
  const rows = new Map()
  // on a server, paths are told apart by case (Linux); on this computer they are not (Windows, macOS)
  const key = (p) => (isLocator(p) ? String(p).replace(/\/+$/, '') : path.resolve(p).toLowerCase())
  const onServer = (w) => (w.host ? { host: w.host, hostLabel: w.hostLabel || w.host } : {})
  for (const w of workspaces) {
    if (!((w.kind === 'worktree' || w.kind === 'folder' || !w.kind) && w.path)) continue
    // a folder that is not a repository: the repositories inside it instead (ABC → A, B, C)
    if (!w.repoName && !isLocator(w.path)) {
      const inside = await reposInside(w.path).catch(() => null)
      if (inside && !inside.isRepo && inside.children.length) {
        for (const c of inside.children) if (!rows.has(key(c.path))) rows.set(key(c.path), { path: c.path, name: path.basename(c.path), workspace: w.name || '', main: true, source: 'folder', folder: path.basename(w.path) })
        continue
      }
    }
    rows.set(key(w.path), { path: w.path, name: w.repoName || path.posix.basename(String(w.path).replace(/\\/g, '/')), workspace: w.name || '', main: w.main !== false, source: 'orca', ...onServer(w) })
  }
  const roots = String(scan || '').split(/[;\n]/).map((x) => x.trim()).filter(Boolean)
  for (const p of scanForRepos(roots)) if (!rows.has(key(p))) rows.set(key(p), { path: p, name: path.basename(p), workspace: '', main: true, source: 'scan' })
  // the projects found on the servers (Servers… in the repository menu): what is known now, no waiting
  if (servers)
    for (const x of (await serverRepos({ wait: 0 }).catch(() => ({ repos: [] }))).repos)
      if (!rows.has(key(x.path))) rows.set(key(x.path), { path: x.path, name: x.name, workspace: '', main: true, source: 'server', ...onServer(x) })
  const list = [...rows.values()]
  // each row's git runs where the repo is: this computer or its server (the server's shared ssh connection)
  await pool(list, 4, (r) => inRepo(r.path, async (rp) => {
    try {
      const st = await status(rp, { untracked: 'normal' })
      Object.assign(r, {
        toplevel: st.toplevel,
        branch: st.branch,
        detached: !st.branch,
        oid: (st.oid || '').slice(0, 7),
        upstream: st.upstream,
        ahead: st.ahead,
        behind: st.behind,
        changes: st.filesTotal ?? st.files.length,
        conflicts: st.files.filter((f) => f.conflict).length,
        state: st.state || null,
        stashes: st.stashCount || 0
      })
      const where = await repoWhere(rp)
      if (where) Object.assign(r, { remote: where.path, remoteHost: where.host })
      // the newest tag (by when it was made), shown on the row
      const t = (await gitOnce(rp, ['for-each-ref', 'refs/tags', '--sort=-creatordate', '--count=1', '--format=%(refname:short)%09%(creatordate:unix)'], { timeout: 8000 }).catch(() => '')).trim()
      if (t) [r.tag, r.tagAt] = [t.split('	')[0], +t.split('	')[1] || null]
    } catch (e) {
      r.error = String(e.message || e).split('\n')[0].slice(0, 200)
    }
  }))
  // one row per folder git knows (two workspaces of the same folder are one repo)
  const seen = new Set()
  const out = list.filter((r) => !r.toplevel || (seen.has(key(r.toplevel)) ? false : seen.add(key(r.toplevel))))
  // the Orca Project Group of each: by its repository (a worktree finds it through its shared .git),
  // or by the registered folder it sits in (A inside the folder project ABC)
  const { byPath, groups } = await orcaGroups()
  // a server's repos are grouped under the server, after Orca's groups
  for (const r of out) if (r.host) r.group = { id: `server:${r.host}`, name: r.hostLabel, server: true, order: 1e8, repoOrder: 0 }
  if (byPath.size) {
    await pool(out.filter((r) => !r.host), 4, async (r) => {
      const common = await gitOnce(r.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 8000 }).then((o) => o.trim(), () => '')
      const main = common ? path.dirname(common.replace(/[\\/]+$/, '')) : r.path
      const cands = [main, r.path].map((p) => path.resolve(p).toLowerCase())
      let hit = cands.map((c) => byPath.get(c)).find(Boolean)
      if (!hit) for (const [p, g] of byPath) if (cands.some((c) => c.startsWith(p + path.sep))) hit = g
      if (hit) r.group = { id: hit.id, name: groups.get(hit.id)?.name || '', order: groups.get(hit.id)?.order ?? 999, repoOrder: hit.order }
    })
  }
  return { repos: out, roots, grouped: byPath.size > 0, servers: out.some((r) => r.host) }
}

/** Where the open repository's main remote lives, or null. */
async function repoWhere(repo) {
  if (!repo) return null
  try {
    const r = await defaultRemote(repo)
    return r ? await remoteWhere(repo, r) : null
  } catch {
    return null
  }
}

/**
 * May I merge into this merge request's target? GitLab: my access level in the project (Developer
 * and up), against who may merge into a protected target; GitHub: push access to the repository.
 * One request or two per project, kept for ten minutes.
 */
const permCache = new Map()
async function canMergeIn(it) {
  const key = `${it.provider}|${it.host}|${it.provider === 'github' ? it.repo : it.projectId}`
  let hit = permCache.get(key)
  if (!hit || Date.now() - hit.at > 10 * 60_000) {
    const { w, via } = await itemTarget(it)
    let value = null
    if (w.kind === 'github') {
      const repo = await forgeCall(w, via, 'GET', `/repos/${w.path}`).catch(() => null)
      value = repo?.permissions ? { push: !!(repo.permissions.push || repo.permissions.admin || repo.permissions.maintain) } : null
    } else {
      const project = String(it.projectId)
      const [proj, prot] = await Promise.all([gitlabGet(w, via, `projects/${project}`).catch(() => null), gitlabGet(w, via, `projects/${project}/protected_branches?per_page=100`).catch(() => null)])
      const p = proj?.permissions || {}
      const level = Math.max(p.project_access?.access_level || 0, p.group_access?.access_level || 0)
      value = proj ? { level, protected: Array.isArray(prot) ? prot.map((b) => ({ name: b.name, merge: Math.min(...(b.merge_access_levels || []).map((m) => m.access_level ?? 40).filter((x) => x > 0), 99) })) : [] } : null
    }
    hit = { at: Date.now(), value }
    remember(permCache, key, hit, 300)
  }
  const v = hit.value
  if (!v) return null
  if (it.provider === 'github') return v.push
  // a protected target needs its merge level (wildcards like release/* match too); otherwise Developer
  const rx = (n) => new RegExp('^' + n.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  const rule = (v.protected || []).find((b) => it.target && rx(b.name).test(it.target))
  return v.level >= (rule ? rule.merge : 30)
}

/** A status bar tooltip within Orca's 256 characters: whole lines while they fit, then "…and N more". */
function barTip(lines, last) {
  const out = []
  let used = last.length + 1
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k].length > 70 ? lines[k].slice(0, 69) + '…' : lines[k]
    const more = `…and ${lines.length - k} more`
    if (used + l.length + 1 + (k < lines.length - 1 ? more.length + 1 : 0) > 256) {
      out.push(more)
      break
    }
    out.push(l)
    used += l.length + 1
  }
  return [...out, last].join('\n').slice(0, 256)
}

/** Where the repositories open in Orca live (host and project), kept for five minutes. */
let remotesCache = null
async function orcaRemotes(orca) {
  if (remotesCache && Date.now() - remotesCache.at < 5 * 60_000) return remotesCache.value
  const ws = (await listWorkspaces(orca).catch(() => [])).filter((w) => w.path && (!w.hostId || w.hostId === 'local'))
  const seen = new Set()
  const value = []
  const { byPath, groups } = await orcaGroups().catch(() => ({ byPath: new Map(), groups: new Map() }))
  const found = await pool(ws, 4, async (w) => {
    const where = await repoWhere(w.path)
    if (!where) return null
    // its Orca Project Group: by the repository it belongs to (a worktree through its shared .git)
    let group = null
    if (byPath.size) {
      const common = await gitOnce(w.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 8000 }).then((o) => o.trim(), () => '')
      const main = path.resolve(common ? path.dirname(common.replace(/[\\/]+$/, '')) : w.path).toLowerCase()
      let hit = byPath.get(main) || byPath.get(path.resolve(w.path).toLowerCase())
      if (!hit) for (const [p, g] of byPath) if (main.startsWith(p + path.sep)) hit = g
      if (hit) group = { id: hit.id, name: groups.get(hit.id)?.name || '', order: groups.get(hit.id)?.order ?? 999, repoOrder: hit.order }
    }
    return { kind: where.kind, host: where.host, path: where.path, group }
  })
  for (const w of found) if (w && !seen.has(`${w.host}|${w.path}`)) seen.add(`${w.host}|${w.path}`), value.push(w)
  // nothing found (Orca not ready yet, as right after the plugin starts): asked again next time
  if (value.length) remotesCache = { at: Date.now(), value }
  return value
}

// One answer shared for 45 s, and one load in flight at a time: the status bar poll and an open
// MR / PR tab ask for the same list, so GitHub and GitLab are asked once, not twice.
const listShared = new Map() // key → { at, p }
function reviewsList(orca, repo, opts = {}) {
  const key = `${repo || ''}|${opts.page || 1}|${!!opts.mergedOnly}|${!!opts.merged}|${opts.fresh ? Date.now() : ''}`
  const hit = listShared.get(key)
  if (hit && Date.now() - hit.at < (process.env.GITX_REVIEWS_POLL ? 0 : 45_000)) return hit.p
  const p = reviewsListUncached(orca, repo, opts)
  remember(listShared, key, { at: Date.now(), p }, 20)
  p.catch(() => listShared.delete(key))
  return p
}
async function reviewsListUncached(orca, repo, { page = 1, mergedOnly = false, merged = mergedOnly } = {}) {
  const where = await repoWhere(repo)
  const items = []
  const errors = []
  let moreMerged = false
  let mergedTotal = null
  const others = await orcaRemotes(orca).catch(() => []) // the repos open in Orca: their open ones, and their merged ones for All
  const hosts = await forgeHosts(orca, where)
  const install = canInstall()
  // via: 'gh' | 'glab' (the CLI is signed in) or 'git' (the saved Git login), null when neither
  const providers = await Promise.all(
    hosts.map(async (h) => {
      const cli = cliFor(h.kind)
      const [inst, cliIn] = await Promise.all([installed(cli), cliSignedIn(h.kind, h.host)])
      const login = !cliIn && (await hasGitLogin(h, repo))
      return { provider: h.kind, host: h.host, cli, installed: inst, signedIn: cliIn || login, via: cliIn ? cli : login ? 'git' : null, canInstall: await install, _h: h }
    })
  )
  await Promise.all(
    providers
      .filter((p) => p.signedIn)
      .map((p) => {
        const via = p.via === 'git' ? 'git' : 'cli'
        const opt = { page: Math.max(1, Math.min(50, +page || 1)), mergedOnly: !!mergedOnly, merged: !!merged, others }
        return (p.provider === 'github' ? githubInbox(p._h, where, via, opt) : gitlabInbox(p._h, where, via, opt)).then(
          (list) => (items.push(...list), (moreMerged ||= !!list.more), list.mergedTotal != null && (mergedTotal = (mergedTotal || 0) + list.mergedTotal)),
          (e) => errors.push(`${p.host}: ${e.message}`)
        )
      })
  )
  providers.forEach((p) => delete p._h)
  items.sort((a, b) => b.updated - a.updated)
  await Promise.all(
    items.filter((it) => it.state === 'open' || it.recent).slice(0, 40).map(async (it) => {
      const [ci, ap] = await Promise.all([reviewCi(it).catch(() => null), reviewApprovals(it).catch(() => null)])
      it.ci = ci
      if (ap) Object.assign(it, ap)
    })
  )
  // the ones merged here (the queue) whose pipeline still runs after the merge: watched until it is
  // done, whoever's they are, so a merged row stays in Open, marked, instead of leaving and coming back
  if (!mergedOnly) {
    const seen = new Set(items.map((i) => i.url))
    const watch = [...mergeJobs.values()].filter((j) => j.state === 'merged' && !seen.has(j.it.url) && Date.now() - j.at < 2 * 3600_000).slice(0, 10)
    await pool(watch, 4, async (j) => {
      const ci = await reviewCi(j.it, 15_000).catch(() => null)
      if (ci === 'running' || ci === 'pending') items.push({ ...j.it, roles: j.it.roles?.length ? j.it.roles : ['repo'], state: 'merged', recent: true, watched: true, mergedAt: j.at / 1000, ci })
    })
  }
  // grouped like Orca's sidebar: the Project Group of the repository each one belongs to
  const byRepo = new Map(others.map((o) => [`${o.host}|${String(o.path).toLowerCase()}`, o]))
  for (const it of items) {
    const o = byRepo.get(`${it.host}|${String(it.repo).toLowerCase()}`)
    if (o) Object.assign(it, { inOrca: true, group: o.group || null })
  }
  // whether I may merge each open one: asked once per project (and remembered), never per MR
  await pool(items.filter((it) => it.state === 'open').slice(0, 80), 4, async (it) => {
    it.canMerge = await canMergeIn(it).catch(() => null)
  })
  return { items, providers, errors, moreMerged, mergedTotal, repoPath: where?.path || null, repoHost: where?.host || null }
}

/** A review item as an API target, and how to reach it (gh/glab or the saved Git login). */
async function itemTarget(it) {
  const host = String(it.host || (it.provider === 'github' ? 'github.com' : ''))
  if (!/^[\w.-]+(:\d+)?$/.test(host)) throw new GitError('bad host')
  const w = { kind: it.provider === 'github' ? 'github' : 'gitlab', host, hostname: host.replace(/:\d+$/, ''), protocol: it.protocol === 'http' ? 'http' : 'https', path: '' }
  if (w.kind === 'github') {
    const m = String(it.url).match(/^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)$/)
    if (!m || m[1].toLowerCase() !== host.toLowerCase()) throw new GitError('not a GitHub pull request link')
    w.path = m[2]
    w.number = +m[3]
  } else {
    if (!Number.isInteger(+it.projectId) || !Number.isInteger(+it.number)) throw new GitError('bad merge request')
    w.mr = `projects/${+it.projectId}/merge_requests/${+it.number}`
  }
  const via = await viaFor(w, undefined, it.via === 'git' ? 'git' : undefined)
  if (!via) throw new GitError(`Neither ${cliFor(w.kind)} nor a saved Git login can reach ${host}`)
  return { w, via }
}
const cliFail = (r, what) => new GitError((r.stderr || r.stdout).trim() || what)

/** My approval and the approval count of one pull/merge request, for the list. */
async function reviewApprovals(it) {
  const { w, via } = await itemTarget(it)
  if (w.kind === 'github') {
    const list = await forgeCall(w, via, 'GET', `/repos/${w.path}/pulls/${w.number}/reviews?per_page=100`)
    const latest = new Map()
    for (const r of Array.isArray(list) ? list : []) if (r.user?.login && r.state !== 'COMMENTED' && r.state !== 'PENDING') latest.set(r.user.login, r.state)
    return { myApproved: !!it.me && latest.get(it.me) === 'APPROVED', approvedCount: [...latest.values()].filter((s) => s === 'APPROVED').length, approvalsRequired: null }
  }
  const a = await gitlabGet(w, via, `${w.mr}/approvals`)
  if (!a || Array.isArray(a)) return null
  const by = (a.approved_by || []).map((x) => x.user?.username).filter(Boolean)
  return { myApproved: a.user_has_approved ?? (!!it.me && by.includes(it.me)), approvedCount: by.length, approvalsRequired: a.approvals_required ?? null }
}

/** Approve, request changes or comment on a pull/merge request. */
async function reviewAct(it) {
  listShared.clear() // an approval or a merge changes the list: the next one is read fresh
  const { action } = it
  const text = String(it.body || '').trim()
  if (!['approve', 'unapprove', 'merge', 'changes', 'comment'].includes(action)) throw new GitError('unknown review action')
  if ((action === 'changes' || action === 'comment') && !text) throw new GitError('Write a comment first')
  const { w, via } = await itemTarget(it)
  if (action === 'merge') return reviewMerge(w, via, it)
  if (action === 'unapprove') {
    if (w.kind === 'github') throw new GitError('GitHub does not let you take back an approval: request changes or comment instead')
    await forgeCall(w, via, 'POST', `/${w.mr}/unapprove`)
    return { ok: true }
  }
  if (w.kind === 'github') {
    if (via === 'cli') {
      const flag = { approve: '--approve', changes: '--request-changes', comment: '--comment' }[action]
      const r = await runProc('gh', ['pr', 'review', it.url, flag, ...(text ? ['--body', text] : [])], { timeout: 60_000 })
      if (r.code !== 0) throw cliFail(r, 'gh could not submit the review')
    } else {
      const event = { approve: 'APPROVE', changes: 'REQUEST_CHANGES', comment: 'COMMENT' }[action]
      await forgeApi(w, 'POST', `/repos/${w.path}/pulls/${w.number}/reviews`, { body: { event, ...(text ? { body: text } : {}) } })
    }
    return { ok: true }
  }
  const post = async (p, fields = {}) => {
    if (via === 'git') return forgeApi(w, 'POST', `/${p}`, { body: fields })
    const r = await runProc('glab', ['api', '--hostname', w.host, '-X', 'POST', ...Object.entries(fields).flatMap(([k, v]) => ['-f', `${k}=${v}`]), p], { timeout: 60_000 })
    if (r.code !== 0) throw Object.assign(cliFail(r, `could not post to ${p}`), { status: /404|not found/i.test(r.stderr + r.stdout) ? 404 : undefined })
    return jsonOf(r)
  }
  if (text) await post(`${w.mr}/notes`, { body: action === 'changes' ? `**Changes requested**\n\n${text}` : text })
  if (action === 'approve') await post(`${w.mr}/approve`)
  else if (action === 'changes') {
    // take back an earlier approval; "not approved yet" (404) is fine
    await post(`${w.mr}/unapprove`).catch((e) => {
      if (e.status !== 404) throw e
    })
  }
  return { ok: true }
}

/**
 * Merge a pull/merge request. GitLab: squash, delete the source branch, or auto-merge once the
 * pipeline passes. GitHub: merge or squash, then delete the head branch when asked.
 */
async function reviewMerge(w, via, it) {
  const o = it.options || {}
  if (w.kind === 'github') {
    const pr = await forgeCall(w, via, 'GET', `/repos/${w.path}/pulls/${w.number}`)
    const r = await forgeCall(w, via, 'PUT', `/repos/${w.path}/pulls/${w.number}/merge`, { merge_method: o.squash ? 'squash' : 'merge', sha: pr?.head?.sha })
    if (r && r.merged === false) throw new GitError(r.message || 'GitHub did not merge it')
    if (o.removeSource && pr?.head?.ref && pr.head.repo?.full_name === pr.base?.repo?.full_name)
      await forgeCall(w, via, 'DELETE', `/repos/${w.path}/git/refs/heads/${pr.head.ref.split('/').map(encodeURIComponent).join('/')}`).catch(() => null)
    return { ok: true, state: 'merged' }
  }
  const body = { squash: !!o.squash, should_remove_source_branch: !!o.removeSource }
  if (o.auto) body.merge_when_pipeline_succeeds = true
  let before = await forgeCall(w, via, 'GET', `/${w.mr}`).catch(() => null)
  // The merge request keeps its own "delete source branch" and "squash" (set when it was opened), and
  // GitLab follows those over the merge call's, above all when it merges later, once the pipeline
  // passes: make them say what was chosen here first.
  const fix = {}
  if (before && o.removeSource !== undefined && !!before.force_remove_source_branch !== !!o.removeSource) fix.remove_source_branch = !!o.removeSource
  if (before && o.squash !== undefined && !!before.squash !== !!o.squash) fix.squash = !!o.squash
  if (Object.keys(fix).length) before = (await forgeCall(w, via, 'PUT', `/${w.mr}`, fix).catch(() => null)) || before
  if (!o.auto && (before?.has_conflicts || before?.detailed_merge_status === 'conflict' || before?.detailed_merge_status === 'broken_status'))
    throw new GitError('It has merge conflicts: resolve them first (on GitLab, or merge the target branch into it and push)')
  let r = await forgeCall(w, via, 'PUT', `/${w.mr}/merge`, body)
  // GitLab can answer before the merge is done, or not merge at all: only "merged" counts
  if (!o.auto && r?.state !== 'merged') {
    await new Promise((res) => setTimeout(res, 1500))
    r = (await forgeCall(w, via, 'GET', `/${w.mr}`).catch(() => null)) || r
    if (r?.state !== 'merged') throw new GitError(`GitLab did not merge it${r?.merge_error ? `: ${r.merge_error}` : r?.detailed_merge_status ? ` (${String(r.detailed_merge_status).replace(/_/g, ' ')})` : ''}`)
  }
  // "Delete source branch" was asked for and the branch is still there after the merge: delete it
  const src = before?.source_branch
  const project = w.mr.split('/merge_requests/')[0]
  if (o.removeSource && !o.auto && r?.state === 'merged' && src && before?.source_project_id === before?.target_project_id) {
    const path = `/${project}/repository/branches/${encodeURIComponent(src)}`
    if (await forgeCall(w, via, 'GET', path).then(Boolean, () => false)) await forgeCall(w, via, 'DELETE', path).catch(() => null)
  }
  return { ok: true, state: r?.state === 'merged' ? 'merged' : 'auto' }
}

/**
 * Merge queue: "Approve & merge" on several runs here, in the background, so it goes on when the tab
 * closes. Merge requests of one project go one at a time (each merge changes the target branch, so the
 * next one has to be checked or rebased again); different projects run side by side.
 */
const mergeJobs = new Map() // url -> job
const mergeLanes = new Set() // projects with a runner going
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const laneOf = (it) => `${it.provider}|${it.host || ''}|${it.repo}`
const jobView = (j) => ({ url: j.it.url, repo: j.it.repo, number: j.it.number, title: j.it.title, state: j.state, note: j.note, error: j.error || null, position: j.position ?? null, at: j.at })

function queueMerges(items, { approve = true } = {}) {
  for (const it of items) {
    const cur = mergeJobs.get(it.url)
    if (cur && !['merged', 'failed'].includes(cur.state)) continue // already queued
    // the options chosen when it was queued (delete source branch, squash); none: the MR's own
    const options = it.options && typeof it.options === 'object' ? { squash: it.options.squash === undefined ? undefined : !!it.options.squash, removeSource: it.options.removeSource === undefined ? undefined : !!it.options.removeSource } : null
    const clean = { ...it, ci: undefined, action: undefined, options: undefined }
    mergeJobs.set(it.url, { it: clean, options, approve: approve && !!it.wantApprove, state: 'queued', note: 'Waiting for its turn', at: Date.now() })
  }
  for (const lane of new Set(items.map(laneOf))) if (!mergeLanes.has(lane)) runLane(lane)
  return mergeQueueState()
}

function mergeQueueState() {
  // finished ones are shown for a while, then dropped
  // failed ones go after 15 minutes; merged ones are kept 2 hours (their pipeline is watched meanwhile)
  for (const [url, j] of mergeJobs) if ((j.state === 'failed' && Date.now() - j.at > 15 * 60_000) || (j.state === 'merged' && Date.now() - j.at > 2 * 3600_000)) mergeJobs.delete(url)
  const lanes = new Map()
  for (const j of mergeJobs.values())
    if (j.state === 'queued') {
      const n = (lanes.get(laneOf(j.it)) || 0) + 1
      lanes.set(laneOf(j.it), n)
      j.position = n
    } else j.position = null
  return { jobs: [...mergeJobs.values()].map(jobView) }
}

async function runLane(lane) {
  mergeLanes.add(lane)
  try {
    for (;;) {
      const job = [...mergeJobs.values()].find((j) => j.state === 'queued' && laneOf(j.it) === lane)
      if (!job) break
      try {
        await runMergeJob(job)
      } catch (e) {
        Object.assign(job, { state: 'failed', note: 'Not merged', error: e?.message || String(e), at: Date.now() })
      }
      const ref = `${job.it.repo} ${job.it.provider === 'github' ? '#' : '!'}${job.it.number}`
      if (ORCA?.host?.has?.('notifications.show'))
        await ORCA.host.call('notifications.show', job.state === 'merged' ? { title: 'Merged', body: `${ref}: ${job.it.title}` } : job.state === 'auto' ? { title: 'Will merge when the pipeline passes', body: `${ref}: ${job.it.title}` } : { title: 'Could not merge', body: `${ref}: ${job.error}` }).catch(() => {})
    }
  } finally {
    mergeLanes.delete(lane)
  }
}

async function runMergeJob(job) {
  const set = (state, note) => (listShared.clear(), Object.assign(job, { state, note, at: Date.now() })) // each step changes the list
  const it = job.it
  if (job.approve) {
    set('approving', 'Approving')
    await reviewAct({ ...it, action: 'approve' }).catch((e) => {
      if (!/already|approved/i.test(e.message)) throw e
    })
  }
  const { w, via } = await itemTarget(it)
  const started = Date.now()
  let rebased = false
  let autoSet = false
  // GitLab and GitHub need a moment after each change (merge, rebase, approval) to say what is possible
  while (Date.now() - started < 60 * 60_000) {
    const d = await reviewDetail(it)
    if (d.state === 'merged') return set('merged', 'Merged')
    if (d.state !== 'open') throw new GitError(`It is ${d.state}`)
    const m = d.merge || {}
    const st = d.mergeable || ''
    if (m.ready) {
      set('merging', 'Merging')
      const r = await reviewMerge(w, via, { ...it, options: { squash: job.options?.squash ?? m.squash, removeSource: job.options?.removeSource ?? m.removeSource } })
      if (r.state === 'merged') return set('merged', 'Merged')
    } else if (['checking', 'unchecked', 'unknown', 'preparing'].includes(st)) {
      set('waiting', 'Waiting for ' + (d.provider === 'github' ? 'GitHub' : 'GitLab') + ' to check it')
    } else if ((st === 'need_rebase' || st === 'behind') && !rebased) {
      // the target moved on (often: the one merged just before): bring the branch up to date
      set('rebasing', d.provider === 'github' ? 'Updating the branch' : 'Rebasing onto the target')
      if (w.kind === 'github') await forgeCall(w, via, 'PUT', `/repos/${w.path}/pulls/${w.number}/update-branch`, {})
      else await forgeCall(w, via, 'PUT', `/${w.mr}/rebase`, {})
      rebased = true
    } else if (m.canAuto || m.autoSet || (rebased && ['ci_still_running', 'ci_must_pass'].includes(st))) {
      // only the pipeline is in the way: GitLab merges it when it passes; the next one waits for that
      if (!m.autoSet && !autoSet) {
        await reviewMerge(w, via, { ...it, options: { squash: job.options?.squash ?? m.squash, removeSource: job.options?.removeSource ?? m.removeSource, auto: true } }).catch(() => null)
        autoSet = true
      }
      set('pipeline', 'Merges when the pipeline passes')
    } else if (st === 'need_rebase' && rebased) {
      set('rebasing', 'Waiting for the rebase')
    } else throw new GitError(m.reason || 'It cannot be merged')
    await sleep(+process.env.GITX_QUEUE_POLL || (job.state === 'pipeline' ? 15_000 : 4_000))
  }
  // an hour on: it is set to merge by itself, let the next one go
  if (autoSet) return set('auto', 'Merges when the pipeline passes')
  throw new GitError('Waited an hour and it still cannot be merged')
}

/**
 * One pull/merge request in full, for the detail page: description, people and their review state,
 * approvals, comments (with file and line for inline ones) and commits. Same shape for GitHub and GitLab.
 */
async function reviewDetail(it) {
  const { w, via } = await itemTarget(it)
  const t = (s) => (s ? Date.parse(s) / 1000 : 0)
  const soft = (p) => p.catch(() => null)
  if (w.kind === 'github') {
    const get = (p) => forgeCall(w, via, 'GET', p)
    const base = `/repos/${w.path}`
    const [pr, reviews, issueComments, lineComments, commits, meU] = await Promise.all([
      get(`${base}/pulls/${w.number}`),
      soft(get(`${base}/pulls/${w.number}/reviews?per_page=100`)),
      soft(get(`${base}/issues/${w.number}/comments?per_page=100`)),
      soft(get(`${base}/pulls/${w.number}/comments?per_page=100`)),
      soft(get(`${base}/pulls/${w.number}/commits?per_page=100`)),
      soft(get('/user'))
    ])
    if (!pr) throw new GitError('could not read the pull request')
    const meG = meU?.login || it.me || ''
    // each person's latest review decides their state
    const latest = new Map()
    for (const r of Array.isArray(reviews) ? reviews : []) {
      const who = r.user?.login
      if (!who || r.state === 'COMMENTED' || r.state === 'PENDING') continue
      latest.set(who, r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes' : 'pending')
    }
    const people = new Map((pr.requested_reviewers || []).map((u) => [u.login, 'pending']))
    for (const [who, st] of latest) people.set(who, st)
    const comments = [
      ...(Array.isArray(issueComments) ? issueComments : []).map((c) => ({ author: c.user?.login || '', body: c.body || '', at: t(c.created_at) })),
      ...(Array.isArray(reviews) ? reviews : []).filter((r) => (r.body || '').trim()).map((r) => ({ author: r.user?.login || '', body: r.body, at: t(r.submitted_at), kind: r.state === 'APPROVED' ? 'approved' : r.state === 'CHANGES_REQUESTED' ? 'changes' : null })),
      ...(Array.isArray(lineComments) ? lineComments : []).map((c) => ({ author: c.user?.login || '', body: c.body || '', at: t(c.created_at), file: c.path, line: c.line || c.original_line || null }))
    ].sort((a, b) => a.at - b.at)
    return {
      provider: 'github',
      title: pr.title || '',
      body: pr.body || '',
      state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      draft: !!pr.draft,
      author: pr.user?.login || '',
      created: t(pr.created_at),
      source: pr.head?.ref || '',
      target: pr.base?.ref || '',
      headSha: pr.head?.sha || '',
      url: pr.html_url || it.url,
      labels: (pr.labels || []).map((l) => l.name).filter(Boolean),
      assignees: (pr.assignees || []).map((u) => u.login),
      reviewers: [...people].map(([name, state]) => ({ name, state })),
      approvals: { given: [...latest.values()].filter((s) => s === 'approved').length, required: null },
      stats: { files: pr.changed_files ?? null, add: pr.additions ?? null, del: pr.deletions ?? null },
      mergeable: pr.mergeable_state || null,
      me: meG,
      myApproved: !!meG && latest.get(meG) === 'approved',
      canApprove: !!meG && pr.user?.login !== meG,
      canUnapprove: false,
      merge: ghMergeInfo(pr),
      comments,
      commits: (Array.isArray(commits) ? commits : []).map((c) => ({ sha: c.sha, subject: String(c.commit?.message || '').split('\n')[0], author: c.commit?.author?.name || c.author?.login || '', at: t(c.commit?.author?.date) }))
    }
  }
  const [mr, approvals, notes, commits, meU] = await Promise.all([
    gitlabGet(w, via, w.mr),
    soft(gitlabGet(w, via, `${w.mr}/approvals`)),
    soft(gitlabGet(w, via, `${w.mr}/notes?sort=asc&order_by=created_at&per_page=100`)),
    soft(gitlabGet(w, via, `${w.mr}/commits?per_page=100`)),
    soft(gitlabGet(w, via, 'user'))
  ])
  if (!mr) throw new GitError('could not read the merge request')
  const meL = meU?.username || it.me || ''
  const approvedBy = new Set((approvals?.approved_by || []).map((a) => a.user?.username).filter(Boolean))
  const reviewers = (mr.reviewers || []).map((u) => ({ name: u.username, state: approvedBy.has(u.username) ? 'approved' : 'pending' }))
  for (const u of approvedBy) if (!reviewers.some((r) => r.name === u)) reviewers.push({ name: u, state: 'approved' })
  return {
    provider: 'gitlab',
    title: mr.title || '',
    body: mr.description || '',
    state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
    draft: !!(mr.draft || mr.work_in_progress),
    author: mr.author?.username || '',
    created: t(mr.created_at),
    source: mr.source_branch || '',
    target: mr.target_branch || '',
    headSha: mr.sha || '',
    url: mr.web_url || it.url,
    labels: (mr.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    assignees: (mr.assignees || []).map((u) => u.username),
    reviewers,
    approvals: { given: approvedBy.size, required: approvals ? (approvals.approvals_required ?? null) : null },
    stats: { files: mr.changes_count != null ? parseInt(mr.changes_count, 10) || null : null, add: null, del: null },
    mergeable: mr.detailed_merge_status || mr.merge_status || null,
    me: meL,
    myApproved: approvals?.user_has_approved ?? (!!meL && approvedBy.has(meL)),
    canApprove: approvals?.user_can_approve ?? (!!meL && mr.author?.username !== meL),
    canUnapprove: true,
    merge: glMergeInfo(mr, approvals),
    comments: (Array.isArray(notes) ? notes : [])
      .filter((n) => !n.system)
      .map((n) => ({ author: n.author?.username || '', body: n.body || '', at: t(n.created_at), file: n.position?.new_path || null, line: n.position?.new_line || null })),
    commits: (Array.isArray(commits) ? commits : []).map((c) => ({ sha: c.id, subject: c.title || String(c.message || '').split('\n')[0], author: c.author_name || '', at: t(c.created_at) }))
  }
}

/** Can it be merged now, and if not why (in GitLab's words); the merge options' defaults. */
function glMergeInfo(mr, approvals) {
  const st = mr.detailed_merge_status || ''
  const pipe = mr.head_pipeline?.status || mr.pipeline?.status || null
  const ci = pipe === 'success' ? 'passed' : pipe === 'failed' ? 'failed' : ['running', 'pending', 'created', 'waiting_for_resource', 'preparing', 'scheduled'].includes(pipe) ? 'running' : pipe ? pipe : null
  const why = {
    draft_status: 'Mark it as ready first: it is a draft',
    not_approved: `Needs approval${approvals?.approvals_left ? ` (${approvals.approvals_left} more)` : ''}`,
    conflict: 'Merge conflicts must be resolved first',
    broken_status: 'Merge conflicts must be resolved first',
    need_rebase: 'The source branch must be rebased onto the target first',
    discussions_not_resolved: 'All threads must be resolved first',
    ci_must_pass: 'The pipeline must pass first',
    ci_still_running: 'The pipeline is still running',
    blocked_status: 'Blocked by another merge request',
    not_open: 'It is not open',
    requested_changes: 'A reviewer requested changes',
    jira_association_missing: 'A Jira issue must be linked first',
    checking: 'GitLab is still checking whether it can be merged',
    unchecked: 'GitLab is still checking whether it can be merged'
  }[st]
  const can = mr.user?.can_merge !== false
  const ready = mr.state === 'opened' && (st ? st === 'mergeable' : !mr.has_conflicts && mr.merge_status !== 'cannot_be_merged')
  return {
    ready: ready && can,
    // GitLab merges a running pipeline's MR when it passes: offered when only the pipeline is in the way
    canAuto: can && mr.state === 'opened' && (st === 'ci_still_running' || (ready && ci === 'running')),
    autoSet: !!mr.merge_when_pipeline_succeeds,
    reason: !can ? 'You are not allowed to merge here' : ready ? null : why || (mr.has_conflicts ? 'Merge conflicts must be resolved first' : 'GitLab says it cannot be merged yet'),
    ci,
    squash: !!mr.squash || mr.squash_on_merge === true,
    removeSource: !!(mr.force_remove_source_branch ?? mr.should_remove_source_branch)
  }
}
function ghMergeInfo(pr) {
  const st = pr.mergeable_state || ''
  const why = { dirty: 'Merge conflicts must be resolved first', blocked: 'Blocked: needs approvals or passing checks', behind: 'The branch is out of date with the base branch', draft: 'Mark it as ready first: it is a draft', unknown: 'GitHub is still checking whether it can be merged', unstable: null, clean: null, has_hooks: null }[st]
  const ready = pr.state === 'open' && !pr.merged && pr.mergeable !== false && !pr.draft && !why
  return { ready, canAuto: false, autoSet: !!pr.auto_merge, reason: ready ? null : pr.draft ? 'Mark it as ready first: it is a draft' : why || 'GitHub says it cannot be merged yet', ci: null, squash: false, removeSource: true }
}

/** A pull/merge request's title, description and diff, from its service. */
async function reviewMaterial(it) {
  const { w, via } = await itemTarget(it)
  if (w.kind === 'github') {
    if (via === 'cli') {
      const [view, diff] = await Promise.all([
        runProc('gh', ['pr', 'view', it.url, '--json', 'title,body,baseRefName,headRefName,headRefOid'], { timeout: 60_000 }),
        runProc('gh', ['pr', 'diff', it.url], { timeout: 90_000 })
      ])
      if (diff.code !== 0) throw new GitError(diff.stderr.trim() || 'gh could not read the diff')
      const v = jsonOf(view) || {}
      return { title: v.title || '', body: v.body || '', source: v.headRefName, target: v.baseRefName, diff: diff.stdout, headSha: v.headRefOid }
    }
    const p = `/repos/${w.path}/pulls/${w.number}`
    const [v, diff] = await Promise.all([forgeApi(w, 'GET', p), forgeApi(w, 'GET', p, { accept: 'application/vnd.github.diff', raw: true })])
    return { title: v.title || '', body: v.body || '', source: v.head?.ref, target: v.base?.ref, diff, headSha: v.head?.sha }
  }
  const m = await gitlabGet(w, via, `${w.mr}/changes`)
  if (!m) throw new GitError('could not read the merge request')
  const diff = (m.changes || [])
    .map((c) => `diff --git a/${c.old_path} b/${c.new_path}\n--- a/${c.old_path}\n+++ b/${c.new_path}\n${c.diff}`)
    .join('\n')
  return { title: m.title || '', body: m.description || '', source: m.source_branch, target: m.target_branch, diff, diffRefs: m.diff_refs, changes: (m.changes || []).map((c) => ({ old_path: c.old_path, new_path: c.new_path })) }
}

/** Review a pull/merge request with the AI agent: summary, issues with file and line, a verdict. */
/**
 * Resolve one conflicted file with AI: it gets the file with its conflict markers and both sides' names
 * and returns the whole file, merged. Nothing is written here; the panel shows it or saves it.
 */
async function aiResolveFile(repo, file, agent) {
  const a = AI[agent] || AI.claude
  const full = await workPath(repo, file)
  const text = await fsx.read(full, 'utf8')
  if (!/^<<<<<<< /m.test(text)) throw new GitError(`${file} has no conflict markers`)
  if (text.length > 200_000) throw new GitError(`${file} is too large for AI (over 200 KB)`)
  const st = await status(repo, { untracked: 'normal' }).catch(() => null)
  const s = st?.sides || {}
  const prompt = [
    `Resolve the git merge conflicts in the file below (${file}).`,
    `"Current" (between <<<<<<< and =======) is ${s.current || 'HEAD'}; "Incoming" (between ======= and >>>>>>>) is ${s.incoming || 'the other side'}.`,
    'Keep the intent of both sides: combine them when both changes are needed, otherwise keep the one that is clearly right.',
    'Output ONLY the complete resolved file: no conflict markers, no code fences, no explanations.',
    `\n${text}`
  ].join('\n')
  const r = await runProc(a.bin, a.args, { cwd: repo, input: prompt, timeout: 110_000, shell: a.shell })
  if (r.code !== 0) throw new GitError(r.code === -1 ? `${a.name} CLI (${a.bin}) was not found on PATH` : r.stderr.trim().split('\n').slice(-3).join('\n') || `${a.name} failed`)
  let out = r.stdout.replace(/^\s*```[\w-]*\n/, '').replace(/\n```\s*$/, '')
  if (/^(<<<<<<<|>>>>>>>) /m.test(out)) throw new GitError(`${a.name} left conflict markers in ${file}`)
  if (!out.trim() && text.trim()) throw new GitError(`${a.name} returned nothing for ${file}`)
  if (text.endsWith('\n') && !out.endsWith('\n')) out += '\n'
  if (text.includes('\r\n') && !out.includes('\r\n')) out = out.replace(/\n/g, '\r\n')
  return { text: out, agent: a.name }
}

/**
 * Before a commit: what is worth a second look. Secret-looking files or lines being added, big files,
 * and committing straight to a main branch. Reads only what is staged; nothing is changed.
 */
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$)[\w.-]+)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]+\.(pem|p12|pfx|key|keystore|jks)|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i
const SECRET_LINE = [
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key'],
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY/, 'a private key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, 'a GitLab token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bsk-(live|proj|ant)?[-_]?[A-Za-z0-9]{24,}/, 'an API secret key'],
  [/\bAIza[0-9A-Za-z_-]{35}/, 'a Google API key']
]
async function commitCheck(repo) {
  const st = await status(repo, { untracked: 'normal' })
  const staged = st.files.filter((f) => f.x && f.x !== '.' && f.x !== '?' && !f.conflict).map((f) => f.path)
  const warnings = []
  for (const f of staged) if (SECRET_FILE.test(f)) warnings.push({ kind: 'secret', file: f, text: `${f} looks like a secrets file` })
  // big files: their size in the index
  const sizes = await Promise.all(staged.slice(0, 400).map((f) => git(repo, ['cat-file', '-s', `:${f}`]).then((s) => [f, +s.trim()], () => [f, 0])))
  for (const [f, s] of sizes) if (s > 5 * 1024 * 1024) warnings.push({ kind: 'big', file: f, text: `${f} is ${(s / 1048576).toFixed(1)} MB (big files make the repository slow for everyone)` })
  // secret-looking lines being added
  const diff = await git(repo, ['diff', '--cached', '--no-color', '-U0', '--diff-filter=AM']).catch(() => '')
  let file = ''
  const seen = new Set()
  for (const l of diff.slice(0, 3_000_000).split('\n')) {
    if (l.startsWith('+++ b/')) file = l.slice(6)
    else if (l.startsWith('+') && !l.startsWith('+++'))
      for (const [re, what] of SECRET_LINE)
        if (re.test(l) && !seen.has(file + what)) {
          seen.add(file + what)
          warnings.push({ kind: 'secret', file, text: `${file} adds what looks like ${what}` })
        }
  }
  // straight to a shared main branch: only when it tracks a branch on a server (not a folder or a solo repo)
  if (st.branch && st.upstream && /^(main|master|production|prod|release)$/.test(st.branch)) {
    const remote = st.upstream.split('/')[0]
    const url = (await git(repo, ['config', '--get', `remote.${remote}.url`]).catch(() => '')).trim()
    if (/^(https?:\/\/|ssh:\/\/|git@)/.test(url)) warnings.push({ kind: 'branch', text: `You are committing straight to ${st.branch}, which others pull from` })
  }
  return { warnings, branch: st.branch }
}

/** AI explains a commit or a pull/merge request in plain words: what changed, why, what to watch. */
async function aiExplain(input, agent) {
  const a = AI[agent] || AI.claude
  let title = ''
  let diff = ''
  if (input.item) {
    const m = await reviewMaterial(input.item)
    title = `${m.title}\n\n${(m.body || '').slice(0, 3000)}`
    diff = m.diff
  } else {
    const repo = req(input.repo, 'repo')
    const hash = req(input.hash, 'hash')
    diff = await git(repo, ['show', '--no-color', '--stat', '--patch', '-U2', '--format=%s%n%n%b', hash])
  }
  if (!diff.trim()) throw new GitError('Nothing to explain')
  const prompt = [
    `Explain this ${input.item ? 'pull/merge request' : 'commit'} to a teammate who has not seen it.`,
    'Write Markdown with exactly these parts, short and concrete:',
    '"## What changed" (3-6 bullets, by area or file), "## Why" (one or two sentences; say when you are guessing),',
    '"## Watch out" (risks, behaviour changes or follow-ups; write "Nothing special." when there are none).',
    String(input.instructions || '').trim() ? `Extra instructions: ${String(input.instructions).trim()}` : '',
    title ? `\nTitle and description:\n${title}` : '',
    `\nDiff:\n${diff.length > 80_000 ? diff.slice(0, 80_000) + '\n… (truncated)' : diff}`
  ].join('\n')
  const r = await runProc(a.bin, a.args, { cwd: os.tmpdir(), input: prompt, timeout: 110_000, shell: a.shell })
  if (r.code !== 0) throw new GitError(r.code === -1 ? `${a.name} CLI (${a.bin}) was not found on PATH` : r.stderr.trim().split('\n').slice(-3).join('\n') || `${a.name} failed`)
  return { text: r.stdout.trim(), agent: a.name }
}

async function aiReview(input, agent) {
  const a = AI[agent] || AI.claude
  const mat = await reviewMaterial(input)
  if (!mat.diff.trim()) throw new GitError('This request has no changes to review')
  const diff = mat.diff.length > 90_000 ? mat.diff.slice(0, 90_000) + '\n… (diff truncated)' : mat.diff
  const prompt = [
    'You are a careful senior engineer reviewing a pull request. Review the diff below.',
    'Write the review as Markdown with exactly these parts:',
    '1. A first line "Verdict: APPROVE", "Verdict: REQUEST CHANGES" or "Verdict: COMMENT".',
    '2. "## Summary": two or three sentences on what the change does and whether it is sound.',
    '3. "## Issues": real problems only (bugs, security, data loss, broken edge cases), each as',
    '   "- `path:line` problem, then the suggested fix". Write "None found." when there are none.',
    '4. "## Suggestions": optional smaller improvements, at most five. Omit the section when there are none.',
    'Be specific and brief. Do not praise. Do not restate the diff. Output only the review.',
    String(input.instructions || '').trim() ? `Extra instructions from the reviewer: ${String(input.instructions).trim()}` : '',
    `\nTitle: ${mat.title}`,
    mat.source ? `Branches: ${mat.source} -> ${mat.target}` : '',
    mat.body.trim() ? `\nDescription:\n${mat.body.trim().slice(0, 4000)}` : '',
    `\nDiff:\n${diff}`
  ].join('\n')
  const r = await runProc(a.bin, a.args, { cwd: os.tmpdir(), input: prompt, timeout: 110_000, shell: a.shell })
  if (r.code !== 0) {
    const why = r.code === -1 ? `${a.name} CLI (${a.bin}) was not found on PATH` : r.stderr.trim().split('\n').slice(-3).join('\n')
    throw new GitError(why || `${a.name} failed`)
  }
  const text = r.stdout.trim().replace(/^```(?:markdown)?\n?|```$/g, '').trim()
  const v = text.match(/^\s*\**verdict:?\**\s*(approve|request changes|comment)/im)?.[1]?.toLowerCase()
  const verdict = v === 'approve' ? 'approve' : v === 'request changes' ? 'changes' : 'comment'
  // the verdict line is for the person; the posted review starts at the summary
  const review = text.replace(/^\s*\**verdict:?\**.*\n+/i, '').trim()
  return { review, verdict, title: mat.title }
}

// ---------- AI: review on this machine, before a merge request exists ----------
// A branch against the branch it would merge into (what the merge request will show), or the staged
// changes before a commit. Nothing leaves the machine but the prompt to the AI CLI.
async function aiReviewLocal(repo, { source, target, staged, instructions } = {}, agent) {
  const a = AI[agent] || AI.claude
  let diff
  let what
  if (staged) {
    diff = await git(repo, ['diff', '--cached', '--no-color', '-U3'])
    what = 'staged changes about to be committed'
    if (!diff.trim()) {
      // nothing staged: "Commit all" commits every change, so review those (new files included)
      const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).slice(0, 200)
      diff = await git(repo, ['diff', 'HEAD', '--no-color', '-U3']).catch(() => git(repo, ['diff', '--no-color', '-U3']))
      for (const f of untracked) diff += await git(repo, ['diff', '--no-index', '--no-color', '-U3', '--', '/dev/null', f], { okCodes: [0, 1] }).catch(() => '')
      what = 'changes about to be committed'
    }
    if (!diff.trim()) throw new GitError('There are no changes to review')
  } else {
    // plain git, no GitHub/GitLab needed: works in any repository, with or without a remote
    const tgt = req(target, 'target branch').replace(/^refs\/heads\//, '')
    const src = source ? req(source, 'branch') : (await headInfo(repo)).branch
    if (!src) throw new GitError('HEAD is detached; pick the branch to review')
    const exists = async (ref) => !!(await git(repo, ['rev-parse', '--verify', '-q', ref], { okCodes: [0, 1] })).trim()
    // the target as the remote has it when there is one (what the merge request compares with)
    const remote = await defaultRemote(repo).catch(() => null)
    const base = remote && (await exists(`refs/remotes/${remote}/${tgt}`)) ? `${remote}/${tgt}` : tgt
    const head = (await exists(`refs/heads/${src}`)) ? src : remote && (await exists(`refs/remotes/${remote}/${src}`)) ? `${remote}/${src}` : src
    if (!(await exists(base))) throw new GitError(`There is no branch ${tgt}`)
    if (!(await exists(head))) throw new GitError(`There is no branch ${src}`)
    // from where the branch split off: exactly what the merge request will show
    diff = await git(repo, ['diff', '--no-color', '-U3', `${base}...${head}`]).catch(() => '')
    if (!diff.trim()) throw new GitError(`${src} has no changes compared with ${tgt}`)
    what = `branch ${src} before it is merged into ${tgt}`
  }
  // a very big diff: say which files were left out instead of cutting silently
  const MAX = 90_000
  const files = diff.split(/^(?=diff --git )/m)
  let kept = ''
  const left = []
  for (const f of files) {
    if (kept.length + f.length <= MAX) kept += f
    else left.push((f.match(/^diff --git a\/(.+?) b\//) || [])[1] || '?')
  }
  const prompt = [
    `You are a careful senior engineer. Review the ${what}, so the author can fix problems before asking teammates to review.`,
    'Write the review as Markdown with exactly these parts:',
    '1. A first line "Verdict: READY", "Verdict: FIX FIRST" or "Verdict: OK WITH NOTES".',
    '2. "## Summary": two or three sentences on what the change does and whether it is sound.',
    '3. "## Must fix": real problems only (bugs, security, data loss, broken edge cases), each as',
    '   "- `path:line` problem, then the fix". Write "None found." when there are none.',
    '4. "## Should fix": smaller problems worth fixing now, same format. Omit when there are none.',
    '5. "## Suggestions": at most five optional improvements. Omit when there are none.',
    'Use the file paths exactly as in the diff and the line numbers of the new file. Be specific and brief. Do not praise. Output only the review.',
    String(instructions || '').trim() ? `Extra instructions: ${String(instructions).trim()}` : '',
    left.length ? `\n(${left.length} more changed files were too big to include: ${left.slice(0, 20).join(', ')})` : '',
    `\nDiff:\n${kept}`
  ].join('\n')
  // tests only: GITX_AI_SCRIPT runs a fake agent (node <script>) instead of the real CLI
  const fake = process.env.GITX_AI_SCRIPT
  const r = await runProc(fake ? process.execPath : a.bin, fake ? [fake] : a.args, { cwd: os.tmpdir(), input: prompt, timeout: 170_000, shell: fake ? false : a.shell })
  if (r.code !== 0) {
    const why = r.code === -1 ? `${a.name} CLI (${a.bin}) was not found on PATH` : r.stderr.trim().split('\n').slice(-3).join('\n')
    throw new GitError(why || `${a.name} failed`)
  }
  const text = r.stdout.trim().replace(/^```(?:markdown)?\n?|```$/g, '').trim()
  const v = text.match(/^\s*\**verdict:?\**\s*(ready|fix first|ok with notes)/im)?.[1]?.toLowerCase()
  const verdict = v === 'ready' ? 'ready' : v === 'fix first' ? 'fix' : 'notes'
  const review = text.replace(/^\s*\**verdict:?\**.*\n+/i, '').trim()
  return { review, verdict, files: files.filter((f) => f.trim()).length, left, agent: a.name }
}

// ---------- AI: merge request title and description ----------
async function aiMrDescription(repo, { target, source, instructions }, agent) {
  const a = AI[agent] || AI.claude
  const info = await mrInfo(repo, req(target, 'target branch'), source)
  const remoteTarget = `${info.remote}/${info.target}`
  const base = (await git(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${remoteTarget}`], { okCodes: [0, 1] })).trim() ? remoteTarget : info.target
  let diff = await git(repo, ['diff', '--no-color', '-U2', `${base}...${info.sourceRef}`]).catch(() => '')
  if (!diff.trim() && !info.commits.length) throw new GitError(`${info.source} has no changes compared with ${info.target}`)
  if (diff.length > 80_000) diff = diff.slice(0, 80_000) + '\n… (diff truncated)'
  const prompt = [
    `Write the title and description for a ${info.kind === 'github' ? 'GitHub pull request' : 'GitLab merge request'} from ${info.source} into ${info.target}.`,
    'Output format, exactly:',
    'Line 1: the title, under 72 characters, no prefix like "Title:".',
    'Line 2: empty.',
    'Then a Markdown description with "## Summary" (two or three sentences: what and why) and "## Changes" (short bullets).',
    'Add "## Testing" only if the diff shows tests or clear manual steps. No other text, no code fences.',
    String(instructions || '').trim() ? `Extra instructions: ${String(instructions).trim()}` : '',
    info.commits.length ? `\nCommits:\n${info.commits.map((c) => `- ${c}`).join('\n')}` : '',
    `\nDiff:\n${diff}`
  ].join('\n')
  const r = await runProc(a.bin, a.args, { cwd: repo, input: prompt, timeout: 110_000, shell: a.shell })
  if (r.code !== 0) throw new GitError(r.code === -1 ? `${a.name} CLI (${a.bin}) was not found on PATH` : r.stderr.trim().split('\n').slice(-3).join('\n') || `${a.name} failed`)
  const out = r.stdout.trim().replace(/^```(?:markdown)?\n?|```$/g, '').trim()
  const [first, ...rest] = out.split(/\r?\n/)
  return { title: first.replace(/^(title:\s*|#+\s*)/i, '').trim(), body: rest.join('\n').trim() }
}

// ---------- CI / pipeline status ----------
const CI_STATE = (s) => {
  s = String(s || '').toLowerCase()
  if (['failure', 'failed', 'error', 'timed_out', 'action_required', 'startup_failure'].includes(s)) return 'failed'
  if (['success', 'passed', 'neutral', 'skipped', 'completed'].includes(s)) return 'passed'
  if (['canceled', 'cancelled'].includes(s)) return 'canceled'
  if (s) return 'running'
  return null
}
function rollup(states) {
  const list = states.map(CI_STATE).filter(Boolean)
  if (!list.length) return null
  if (list.includes('failed')) return 'failed'
  if (list.includes('running')) return 'running'
  if (list.every((x) => x === 'canceled')) return 'canceled'
  return 'passed'
}
/** GitHub check runs + commit statuses of one commit, through gh or the saved Git login; null when neither answers. */
async function githubCommitCi(w, via, sha, cwd) {
  const base = `repos/${w.path}/commits/${sha}`
  if (via === 'cli') {
    const [runs, st] = await Promise.all([
      runProc('gh', ['api', '--hostname', w.host, `${base}/check-runs`, '--jq', '[.check_runs[] | (.conclusion // .status)]'], { timeout: 30_000 }),
      runProc('gh', ['api', '--hostname', w.host, `${base}/status`, '--jq', '[.statuses[].state]'], { timeout: 30_000 })
    ])
    if (runs.code !== 0 && st.code !== 0) return undefined
    return rollup([...(jsonOf(runs) || []), ...(jsonOf(st) || [])])
  }
  const [runs, st] = await Promise.all([
    forgeApi(w, 'GET', `/${base}/check-runs`, { cwd }).catch(() => null),
    forgeApi(w, 'GET', `/${base}/status`, { cwd }).catch(() => null)
  ])
  if (!runs && !st) return undefined
  return rollup([...(runs?.check_runs || []).map((c) => c.conclusion || c.status), ...(st?.statuses || []).map((s) => s.state)])
}
async function ciStatus(repo, { ref = 'HEAD' } = {}) {
  const sha = (await git(repo, ['rev-parse', '--verify', '-q', req(ref, 'ref')], { okCodes: [0, 1] })).trim()
  if (!sha) return { state: null }
  const where = await repoWhere(repo)
  if (!where) return { state: null }
  return memo(`ci|${where.host}|${where.path}|${sha}`, 45_000, async () => {
    const via = await viaFor(where, repo)
    if (!via) return { state: null, reason: cliFor(where.kind) }
    if (where.kind === 'github') {
      const state = await githubCommitCi(where, via, sha, repo)
      if (state === undefined) return { state: null, reason: via === 'cli' ? 'gh' : 'git' }
      return { state, sha, url: `${where.web}/commit/${sha}/checks` }
    }
    const c = await gitlabGet(where, via, `projects/${projectPath(where.path)}/repository/commits/${sha}`).catch(() => null)
    if (!c) return { state: null, reason: via === 'cli' ? 'glab' : 'git' }
    return { state: CI_STATE(c.last_pipeline?.status), sha, url: c.last_pipeline?.web_url || `${where.web}/-/commit/${sha}` }
  })
}
/** CI state of one review item (pull/merge request head), remembered for a minute. */
function reviewCi(it, ttl = 60_000) {
  return slow('rci|' + it.url, async () => {
    const { w, via } = await itemTarget(it)
    if (w.kind === 'github') {
      if (via === 'cli') {
        const r = await runProc('gh', ['pr', 'view', it.url, '--json', 'statusCheckRollup', '--jq', '[.statusCheckRollup[] | (.conclusion // .state // .status)]'], { timeout: 30_000 })
        return r.code === 0 ? rollup(jsonOf(r) || []) : null
      }
      const pr = await forgeApi(w, 'GET', `/repos/${w.path}/pulls/${w.number}`)
      return pr?.head?.sha ? (await githubCommitCi(w, via, pr.head.sha)) ?? null : null
    }
    return CI_STATE((await gitlabGet(w, via, w.mr).catch(() => null))?.head_pipeline?.status)
  }, process.env.GITX_REVIEWS_POLL || process.env.GITX_API_BASE ? 1 : ttl) // tests: no caching
}

// ---------- line comments on a pull/merge request ----------
async function reviewLineComment(it, { path: file, line, side, body }) {
  const text = String(body || '').trim()
  if (!text) throw new GitError('Write a comment first')
  if (!Number.isInteger(+line) || +line < 1) throw new GitError('bad line')
  const f = String(file || '')
  if (!f) throw new GitError('file is required')
  const mat = await reviewMaterial(it)
  const { w, via } = await itemTarget(it)
  if (w.kind === 'github') {
    const fields = { body: text, commit_id: mat.headSha, path: f, line: +line, side: side === 'old' ? 'LEFT' : 'RIGHT' }
    const p = `repos/${w.path}/pulls/${w.number}/comments`
    if (via === 'git') await forgeApi(w, 'POST', '/' + p, { body: fields })
    else {
      const r = await runProc('gh', ['api', '--hostname', w.host, p, '-f', `body=${text}`, '-f', `commit_id=${mat.headSha}`, '-f', `path=${f}`, '-F', `line=${+line}`, '-f', `side=${fields.side}`], { timeout: 60_000 })
      if (r.code !== 0) throw cliFail(r, 'could not post the comment')
    }
    return { ok: true }
  }
  const d = mat.diffRefs || {}
  const oldPath = mat.changes?.find((c) => c.new_path === f)?.old_path || f // renamed files keep their old name on the old side
  const position = { position_type: 'text', base_sha: d.base_sha, start_sha: d.start_sha, head_sha: d.head_sha, new_path: f, old_path: oldPath, [side === 'old' ? 'old_line' : 'new_line']: +line }
  const p = `${w.mr}/discussions`
  if (via === 'git') await forgeApi(w, 'POST', '/' + p, { body: { body: text, position } })
  else {
    const args = ['api', '--hostname', w.host, '-X', 'POST', p, '-f', `body=${text}`, ...Object.entries(position).flatMap(([k, v]) => [typeof v === 'number' ? '-F' : '-f', `position[${k}]=${v}`])]
    const r = await runProc('glab', args, { timeout: 60_000 })
    if (r.code !== 0) throw cliFail(r, 'could not post the comment')
  }
  return { ok: true }
}

// ---------- files in the working tree (conflict resolution) ----------
/**
 * The real path of a working-tree file. Symlinks are resolved (for a new file: its nearest existing
 * folder), so a link pointing outside the repository cannot be read or written through.
 */
async function workPath(repo, file) {
  const P = hpath()
  const top = await fsx.realpath(P.resolve((await paths(repo)).toplevel))
  const real = await fsx.realpath(P.resolve(top, String(file)))
  const cmp = (x) => (process.platform === 'win32' && !currentHost() ? x.toLowerCase() : x)
  if (!cmp(real + P.sep).startsWith(cmp(top + P.sep)) || cmp(real) === cmp(top)) throw new GitError('That file is outside the repository')
  return real
}

// ---------- operations exposed to the panel ----------

const ops = {
  status: (r) => status(r),
  diff: (r, a) => diff(r, a),
  fileImage: (r, a) => fileImage(r, a),
  stage: (r, a) => git(r, ['add', '-A', '--', ...files(a.files)]),
  stageAll: (r) => git(r, ['add', '-A']),
  unstage: async (r, a) => {
    const hasHead = await git(r, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] })
    return hasHead.trim()
      ? git(r, ['restore', '--staged', '--', ...files(a.files)])
      : git(r, ['rm', '--cached', '-r', '-q', '--', ...files(a.files)])
  },
  unstageAll: async (r) => {
    const hasHead = await git(r, ['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [0, 1] })
    return hasHead.trim() ? git(r, ['reset', '-q']) : git(r, ['rm', '--cached', '-r', '-q', '.'])
  },
  discard: async (r, a) => {
    const tracked = a.files || []
    const untracked = a.untracked || []
    // from the index, so staged parts of the same file survive (and newly added files work)
    if (tracked.length) await git(r, ['restore', '--worktree', '--', ...tracked])
    if (untracked.length) await git(r, ['clean', '-f', '-d', '--', ...untracked])
    return ''
  },
  useSide: async (r, a) => {
    const side = a.side === 'theirs' ? '--theirs' : '--ours'
    await git(r, ['checkout', side, '--', String(a.file)])
    return git(r, ['add', '--', String(a.file)])
  },
  commit: async (r, a) => {
    const args = ['commit', '-F', '-']
    if (a.amend) args.push('--amend')
    if (a.signoff) args.push('--signoff')
    if (a.all) args.push('-a')
    if (a.allowEmpty) args.push('--allow-empty')
    const msg = String(a.message || '')
    if (!msg.trim()) throw new GitError('commit message is empty')
    const out = await git(r, args, { input: msg })
    if (a.push) {
      // the commit is made: a failed push must not look like a failed commit
      try {
        await push(r, {})
      } catch (e) {
        return { committed: true, output: out, pushError: e.message }
      }
    }
    return out
  },
  lastMessage: (r) => git(r, ['log', '-1', '--format=%B'], { okCodes: [0, 128] }),

  log: (r, a) => log(r, a),
  commitShow: (r, a) => commitShow(r, a),
  commitFileDiff: (r, a) => commitFileDiff(r, a),

  refs: (r) => refs(r),
  checkout: async (r, a) => {
    let ref = req(a.ref, 'ref')
    let local = null
    if (a.track) {
      // origin/x when a local x already exists: switch to the local branch (as Git Extensions does)
      // and report how the two compare, so the panel can offer a fast-forward.
      const name = ref.replace(/^[^/]+\//, '')
      const exists = (await git(r, ['rev-parse', '--verify', '-q', `refs/heads/${name}`], { okCodes: [0, 1] })).trim()
      if (exists) {
        const [behind, ahead] = (await git(r, ['rev-list', '--left-right', '--count', `${ref}...${name}`])).trim().split(/\s+/).map(Number)
        local = { name, remote: ref, ahead, behind }
        ref = name
        a = { ...a, track: false }
      }
    }
    const args = ['switch']
    if (a.discard) args.push('--discard-changes')
    else if (a.merge) args.push('--merge')
    // A remote branch: create a local tracking branch with the same name.
    if (a.track) args.push('--track')
    else if (a.detach) args.push('--detach')
    args.push(ref)
    let stashed = false
    let stashSha = null
    if (a.stash) {
      const dirty = (await git(r, ['status', '--porcelain'])).trim()
      if (dirty) {
        await git(r, ['stash', 'push', '--include-untracked', '-m', `Auto stash before switching to ${ref}`])
        stashSha = (await git(r, ['rev-parse', '--verify', '-q', 'refs/stash'], { okCodes: [0, 1] })).trim() || null
        stashed = true
      }
    }
    // Pop exactly the stash made above (another one may have been pushed meanwhile).
    const restore = async () => {
      const list = (await git(r, ['stash', 'list', '--format=%H']).catch(() => '')).split('\n').filter(Boolean)
      const i = stashSha ? list.indexOf(stashSha) : 0
      const ref = `stash@{${Math.max(i, 0)}}`
      if (i < 0) return `your changes are kept in stash ${stashSha.slice(0, 7)}`
      try {
        await git(r, ['stash', 'pop', ref])
        return null
      } catch {
        return `your changes are kept in ${ref} (${(stashSha || '').slice(0, 7)})`
      }
    }
    try {
      await git(r, args)
    } catch (e) {
      if (stashed) {
        const kept = await restore()
        if (kept) e.message += `\nCould not restore your changes: ${kept}.`
      }
      const inUse = e.message.match(/(?:already (?:checked out|used by worktree) at|is already used by worktree at) '([^']+)'/)
      if (inUse) throw Object.assign(new GitError(`${ref} is checked out in another worktree:\n${inUse[1]}`), { data: { kind: 'in-worktree', path: inUse[1] } })
      if (/would be overwritten|Please commit your changes or stash them/i.test(e.message))
        throw Object.assign(new GitError('You have changes that this checkout would overwrite.'), { data: { kind: 'dirty' } })
      throw e
    }
    // Reset with "also delete untracked files": only once the switch worked
    if (a.discard && a.clean) await git(r, ['clean', '-f', '-d'])
    if (stashed) {
      const kept = await restore()
      if (kept) return { switched: true, stashKept: true, stashMessage: `Switched, but ${kept}.`, local } // conflicts: the stash stays for the person to apply
    }
    return { switched: true, stashed, local }
  },
  branchCreate: (r, a) => {
    const name = req(a.name, 'branch name')
    const args = a.checkout ? ['switch', '-c', name] : ['branch', name]
    if (a.start) args.push(req(a.start, 'start point'))
    return git(r, args)
  },
  branchRename: (r, a) => git(r, ['branch', '-m', req(a.from, 'branch'), req(a.to, 'new name')]),
  branchDelete: (r, a) => git(r, ['branch', a.force ? '-D' : '-d', req(a.name, 'branch')]),
  remoteBranchDelete: (r, a) =>
    git(r, ['push', req(a.remote, 'remote'), '--delete', req(a.name, 'branch')], net),
  setUpstream: (r, a) =>
    git(r, ['branch', `--set-upstream-to=${req(a.upstream, 'upstream')}`, req(a.branch, 'branch')]),
  merge: (r, a) => {
    const args = ['merge']
    if (a.squash) args.push('--squash')
    else if (a.noFf) args.push('--no-ff')
    else if (a.ffOnly) args.push('--ff-only')
    if (a.noCommit && !a.squash) args.push('--no-commit')
    args.push(req(a.ref, 'ref'))
    return git(r, args)
  },
  rebase: (r, a) => git(r, ['rebase', req(a.onto, 'branch')]),
  abort: async (r) => {
    const s = await repoState(r)
    if (!s) throw new GitError('nothing to abort')
    return git(r, [s, '--abort'])
  },
  continue: async (r) => {
    const s = await repoState(r)
    if (!s) throw new GitError('nothing to continue')
    // core.editor=true keeps git from opening an editor for the merge message
    return git(r, ['-c', 'core.editor=true', s, '--continue'])
  },
  skip: async (r) => {
    const s = await repoState(r)
    if (s !== 'rebase' && s !== 'cherry-pick' && s !== 'revert')
      throw new GitError('skip only applies to rebase, cherry-pick or revert')
    return git(r, [s, '--skip'])
  },
  // noCommit applies the change without committing; a merge commit is picked or reverted against its first parent.
  cherryPick: (r, a) =>
    git(r, ['cherry-pick', ...(a.noCommit ? ['-n'] : []), ...(a.mainline ? ['-m', '1'] : []), req(a.hash, 'hash')]),
  revert: (r, a) =>
    git(r, ['revert', a.noCommit ? '-n' : '--no-edit', ...(a.mainline ? ['-m', '1'] : []), req(a.hash, 'hash')]),
  /** How two refs compare: commits only in `a` (ahead) and only in `b` (behind). */
  aheadBehind: async (r, a) => {
    const [ahead, behind] = (await git(r, ['rev-list', '--left-right', '--count', `${req(a.a, 'first ref')}...${req(a.b, 'second ref')}`])).trim().split(/\s+/).map(Number)
    return { ahead, behind }
  },
  reset: (r, a) => {
    const mode = ['soft', 'mixed', 'hard', 'keep', 'merge'].includes(a.mode) ? a.mode : 'mixed'
    return git(r, ['reset', `--${mode}`, req(a.hash, 'commit')])
  },
  /** A fixup! or squash! commit of the staged changes, for a later autosquash rebase. */
  fixupCommit: (r, a) => git(r, ['commit', `--${a.kind === 'squash' ? 'squash' : 'fixup'}=${req(a.hash, 'commit')}`, '--no-edit']),
  tagCreate: (r, a) => {
    const args = ['tag']
    if (a.message) args.push('-a', '-m', String(a.message))
    args.push(req(a.name, 'tag name'))
    if (a.hash) args.push(req(a.hash, 'commit'))
    return git(r, args)
  },
  tagDelete: (r, a) => git(r, ['tag', '-d', req(a.name, 'tag')]),
  tagPush: (r, a) => git(r, ['push', req(a.remote || 'origin', 'remote'), `refs/tags/${req(a.name, 'tag')}`], net),

  // a.timeout (s): Repo Overview fetches many at once and gives up on a slow remote sooner
  fetch: (r, a = {}) => git(r, ['fetch', '--all', ...(a.prune === false ? [] : ['--prune'])], a.timeout ? { timeout: Math.min(110, Math.max(10, +a.timeout || 45)) * 1000 } : net),
  pull: (r, a = {}) =>
    git(r, ['pull', a.rebase ? '--rebase' : a.ffOnly ? '--ff-only' : '--no-rebase'], net),
  push: (r, a) => push(r, a),

  stashList: (r) => stashList(r),
  stashSave: (r, a = {}) => {
    const args = ['stash', 'push']
    if (a.untracked) args.push('--include-untracked')
    if (a.keepIndex) args.push('--keep-index')
    if (a.message) args.push('-m', String(a.message))
    return git(r, args)
  },
  stashApply: (r, a) =>
    git(r, ['stash', 'apply', '--index', stashRef(a.ref)]).catch((e) => {
      // conflicts in the files themselves: report them; only an index-only failure retries without --index
      if (!/Conflicts in index|could not restore index|--index/i.test(e.message)) throw e
      return git(r, ['stash', 'apply', stashRef(a.ref)])
    }),
  stashPop: (r, a) => git(r, ['stash', 'pop', stashRef(a.ref)]),
  stashDrop: (r, a) => git(r, ['stash', 'drop', stashRef(a.ref)]),
  stashShow: async (r, a) =>
    trunc(await git(r, ['stash', 'show', '-p', '--include-untracked', '--no-color', stashRef(a.ref)]).catch(
      () => git(r, ['stash', 'show', '-p', '--no-color', stashRef(a.ref)])
    )),

  worktrees: async (r) => (await worktrees(r)).map((w) => ({ ...w, path: toLocator(w.path) })),
  worktreeAdd: (r, a) => worktreeAdd(r, a),
  worktreeRemove: async (r, a) => {
    const p = req(a.path, 'path')
    const listed = async () => (await worktrees(r)).find((x) => norm(x.path) === norm(p, r)) || null
    const w = await listed()
    if (!w) return { removed: true, alreadyGone: true } // removed elsewhere meanwhile: nothing to do
    if (w.main) throw new GitError('The main worktree cannot be removed')
    const reasons = []
    const done = async (extra = {}) => {
      // Git's own list is the truth: never report success while git still has the worktree.
      let still = await listed()
      if (still?.prunable || (still && !(await fsx.exists(hpath().join(w.path, '.git'))))) {
        await git(r, ['worktree', 'prune']).catch(() => {})
        still = await listed()
      }
      if (still) throw new GitError(`Git still lists this worktree.\n${reasons.join('\n') || 'It may be locked or in use by another program.'}`)
      // force removes a dirty worktree; only forceBranch deletes an unmerged branch (-D)
      if (a.deleteBranch && w.branch) {
        try {
          await git(r, ['branch', a.forceBranch ? '-D' : '-d', w.branch])
          extra.branchDeleted = w.branch
        } catch (e) {
          extra.branchKept = e.message.split('\n')[0]
        }
      }
      return { removed: true, leftover: await fsx.exists(w.path), ...extra }
    }
    // A worktree whose folder is gone or no longer linked ("missing"): drop its stale record.
    // Files left in the folder are not touched.
    if (w.prunable) return done({ pruned: true })

    // A worktree Orca shows as a workspace: let Orca remove it first. It stops the workspace's
    // terminals (on Windows git cannot delete a folder a terminal is still in) and drops it from the sidebar.
    // (Orca's CLI names worktrees on this machine by path; one on a remote host is removed with git there)
    if (ORCA && !currentHost() && (await listWorkspaces(ORCA)).some((x) => norm(x.path) === norm(p))) {
      const cli = ['worktree', 'rm', '--worktree', `path:${p}`, '--json']
      if (a.force) cli.push('--force')
      const res = await runProc(ORCA_BIN, cli, { timeout: 60_000 })
      forgetFocusCaches()
      let out = null
      try {
        out = JSON.parse(res.stdout)
      } catch {}
      const msg = out?.ok ? '' : out?.error?.message || res.stderr.trim()
      if (!a.force && /modified|untracked|dirty|uncommitted|changes/i.test(msg))
        throw new GitError(`${msg}\nTick "Force" to remove it anyway.`)
      if (msg) reasons.push(`Orca: ${msg}`)
      if (!(await listed())) return done({ viaOrca: true })
      // Orca dropped its record (or could not find it) but git still has the worktree: git removes it.
    }
    const args = ['worktree', 'remove']
    if (a.force) args.push('--force')
    if (a.force && w.locked) args.push('--force') // a locked worktree needs it twice
    try {
      await git(r, [...args, p])
    } catch (e) {
      if (!a.force && /modified|untracked|use --force/i.test(e.message)) throw e // the panel offers "remove anyway"
      reasons.push(`git: ${e.message}`)
    }
    return done()
  },
  worktreePrune: (r) => git(r, ['worktree', 'prune', '-v']),
  worktreeLock: (r, a) => git(r, ['worktree', a.unlock ? 'unlock' : 'lock', req(a.path, 'path')]),

  remotes: async (r) => {
    const raw = await git(r, ['remote', '-v'])
    const map = {}
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
      if (m) (map[m[1]] ||= { name: m[1] })[m[3]] = m[2]
    }
    return Object.values(map)
  },
  remoteAdd: (r, a) => git(r, ['remote', 'add', req(a.name, 'name'), req(a.url, 'url')]),
  remoteRemove: (r, a) => git(r, ['remote', 'remove', req(a.name, 'name')]),
  remoteSetUrl: (r, a) => git(r, ['remote', 'set-url', req(a.name, 'name'), req(a.url, 'url')]),

  configList: (r, a) => configList(r, a),
  configSet: (r, a) => configSet(r, a),
  configUnset: (r, a) => configUnset(r, a),

  ciStatus: (r, a) => ciStatus(r, a),
  pipelines: (r, a) => pipelines(r, a),
  pipelineJobs: (r, a) => pipelineJobs(r, a),
  jobLog: (r, a) => jobLog(r, a),
  pipelineAct: (r, a) => pipelineAct(r, a),
  readWorkFile: async (r, a) => {
    const p = await workPath(r, a.file)
    const buf = await fsx.read(p)
    if (buf.length > 4 * 1024 * 1024) throw new GitError('The file is too large to resolve here')
    return buf.toString('utf8')
  },
  writeWorkFile: async (r, a) => {
    const p = await workPath(r, a.file)
    const P = hpath()
    await fsx.mkdirp(P.dirname(p))
    await fsx.write(p, String(a.text ?? ''))
    if (a.stage) {
      const top = await fsx.realpath((await paths(r)).toplevel)
      await git(top, ['add', '--', P.relative(top, p).replace(/\\/g, '/')])
    }
    return ''
  },
  branchCleanup: async (r) => {
    const head = await headInfo(r)
    let base = (await git(r, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { okCodes: [0, 1] })).trim().replace(/^origin\//, '')
    const locals = (await git(r, ['for-each-ref', '--format=%(refname:short)%09%(upstream:track)', 'refs/heads'])).split('\n').filter(Boolean).map((l) => l.split('\t'))
    const names = locals.map(([n]) => n)
    if (!base || !names.includes(base)) base = ['main', 'master', 'develop', 'dev'].find((b) => names.includes(b)) || head.branch
    const keep = new Set([head.branch, base].filter(Boolean))
    const merged = base ? (await git(r, ['branch', '--merged', base, '--format=%(refname:short)'])).split('\n').filter((b) => b && !keep.has(b)) : []
    const gone = locals.filter(([n, t]) => t === '[gone]' && !keep.has(n)).map(([n]) => n)
    return { base, current: head.branch, merged, gone }
  },
  branchDeleteMany: async (r, a) => {
    const results = []
    for (const name of a.names || []) {
      const n = req(name, 'branch')
      try {
        await git(r, ['branch', a.force?.includes(n) ? '-D' : '-d', n])
        results.push({ name: n, ok: true })
      } catch (e) {
        results.push({ name: n, ok: false, error: e.message.split('\n')[0] })
      }
    }
    return results
  },
  undoInfo: async (r) => {
    if (await repoState(r)) return { blocked: 'Finish or abort the operation in progress first' }
    const raw = await git(r, ['reflog', '-2', `--format=%H${SEP}%gs${SEP}%ct`], { okCodes: [0, 128] }).catch(() => '')
    const [now, prev] = raw.split('\n').filter(Boolean).map((l) => {
      const [hash, subject, time] = l.split(SEP)
      return { hash, subject, time: +time }
    })
    if (!now || !prev) return { blocked: 'Nothing to undo' }
    const s = now.subject
    const base = { what: s, at: now.time, head: now.hash }
    const short = (h) => h.slice(0, 7)
    // checkout: switch back instead of moving any branch
    const co = s.match(/^checkout: moving from (\S+) to (\S+)$/)
    if (co) {
      const from = co[1]
      const isBranch = !!(await git(r, ['rev-parse', '--verify', '-q', `refs/heads/${from}`], { okCodes: [0, 1] })).trim()
      const switchTo = isBranch ? from : prev.hash
      return { ...base, to: prev.hash, mode: 'switch', switchTo, detach: !isBranch, description: isBranch ? `Switches back to ${from}. No branch moves; uncommitted changes go along.` : `Checks out ${short(prev.hash)} again (detached). No branch moves.` }
    }
    // rebase (also pull --rebase): back to where the branch was before it, from the branch's own reflog
    if (/^(rebase|pull --rebase)\b.*\(finish\)/.test(s) || /^rebase.*\(finish\)/.test(s)) {
      const { branch } = await headInfo(r)
      if (!branch) return { blocked: 'The rebase left HEAD detached; use the Reflog tab to go back' }
      const top = (await git(r, ['reflog', '-1', `--format=%gs`, `refs/heads/${branch}`]).catch(() => '')).trim()
      if (!/rebase/.test(top)) return { blocked: `Can't find where ${branch} was before the rebase; use the Reflog tab` }
      const to = (await git(r, ['rev-parse', '--verify', '-q', `refs/heads/${branch}@{1}`], { okCodes: [0, 1] })).trim()
      if (!to) return { blocked: `Can't find where ${branch} was before the rebase; use the Reflog tab` }
      return { ...base, to, mode: 'keep', description: `${branch} goes back to ${short(to)}, where it was before the rebase. Uncommitted changes are kept.` }
    }
    if (/^commit/.test(s)) return { ...base, to: prev.hash, mode: 'soft', description: `The branch goes back to ${short(prev.hash)}. The commit's changes stay staged, ready to commit again.` }
    if (/^(reset|merge|pull)\b/.test(s)) return { ...base, to: prev.hash, mode: 'keep', description: `The branch goes back to ${short(prev.hash)}. Uncommitted changes are kept.` }
    return { blocked: `"${s.split(':')[0]}" can't be undone automatically; use the Reflog tab` }
  },
  undoLast: async (r) => {
    const u = await ops.undoInfo(r)
    if (u.blocked) throw new GitError(u.blocked)
    const cur = (await git(r, ['rev-parse', 'HEAD'])).trim()
    if (cur !== u.head) throw new GitError('The repository changed meanwhile; look again before undoing')
    if (u.mode === 'switch') await git(r, ['switch', ...(u.detach ? ['--detach'] : []), u.switchTo])
    else await git(r, ['reset', `--${u.mode}`, u.to])
    return u
  },
  init: (_r, a) => git(req(a.path, 'path'), ['init']),
  clone: async (_r, a) => {
    const url = req(a.url, 'url')
    const P = hpath()
    const dir = P.resolve(req(a.path, 'folder'))
    await fsx.mkdirp(P.dirname(dir))
    await git(P.dirname(dir), ['clone', ...(a.recursive ? ['--recurse-submodules'] : []), url, dir], net)
    return toLocator(dir)
  },

  // Hunks: the panel sends a patch made of one file header and one hunk.
  applyPatch: (r, a) => {
    const args = ['apply', '--recount', '--whitespace=nowarn']
    if (a.cached) args.push('--cached')
    if (a.reverse) args.push('--reverse')
    args.push('-')
    return git(r, args, { input: String(a.patch || '') })
  },
  ignore: async (r, a) => {
    const line = String(a.pattern || '').trim()
    if (!line) throw new GitError('pattern is required')
    if (/[\r\n]/.test(line)) throw new GitError('one pattern per line, please')
    const file = hpath().join((await paths(r)).toplevel, '.gitignore')
    const cur = await fsx.read(file, 'utf8').catch(() => '')
    if (!cur.split(/\r?\n/).includes(line)) await fsx.write(file, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n')
    return ''
  },

  blame: async (r, a) => {
    const args = ['blame', '--porcelain']
    if (a.rev) args.push(req(a.rev, 'revision'))
    args.push('--', String(a.file))
    const raw = await git(r, args)
    const meta = {}
    const lines = []
    let cur = null
    for (const l of raw.split('\n')) {
      if (/^[0-9a-f]{40} \d+ \d+/.test(l)) cur = meta[l.slice(0, 40)] ||= { hash: l.slice(0, 40) }
      else if (l.startsWith('\t')) lines.push({ h: cur.hash, t: l.slice(1) })
      else if (cur) {
        const sp = l.indexOf(' ')
        const k = l.slice(0, sp)
        const v = l.slice(sp + 1)
        if (k === 'author') cur.author = v
        else if (k === 'author-time') cur.time = +v
        else if (k === 'summary') cur.summary = v
      }
    }
    return { commits: meta, lines: lines.slice(0, 20000) }
  },
  showFile: async (r, a) => trunc(await git(r, ['show', `${req(a.rev, 'revision')}:${String(a.file)}`])),
  treeFiles: async (r, a) =>
    (await git(r, ['ls-tree', '-r', '--name-only', '-z', req(a.rev, 'revision')])).split('\0').filter(Boolean).slice(0, 20000),

  compare: async (r, a) => {
    const x = req(a.a, 'first revision')
    const y = req(a.b, 'second revision')
    const files = parseNameStatus(await git(r, ['diff', '--name-status', '-M', '-z', x, y]))
    const counts = (await git(r, ['rev-list', '--left-right', '--count', `${x}...${y}`]).catch(() => '0 0')).trim().split(/\s+/)
    return { files, behind: +counts[0] || 0, ahead: +counts[1] || 0 }
  },
  compareFileDiff: async (r, a) =>
    trunc(await git(r, ['diff', '--no-color', '-M', req(a.a, 'first revision'), req(a.b, 'second revision'), '--', String(a.file)])),

  reflog: async (r) => {
    const raw = await git(r, ['reflog', '-n', '300', `--format=%H${SEP}%gd${SEP}%gs${SEP}%ct`], { okCodes: [0, 128] })
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, ref, subject, time] = l.split(SEP)
        return { hash, ref, subject, time: +time }
      })
  },

  bisect: (r, a) => {
    const act = a.action
    if (!['start', 'good', 'bad', 'skip', 'reset'].includes(act)) throw new GitError('invalid bisect action')
    const args = ['bisect', act]
    if (a.rev && act !== 'reset') args.push(req(a.rev, 'revision'))
    return git(r, args)
  },

  cleanPreview: async (r, a) =>
    (await git(r, ['clean', '-n', '-d', ...(a.ignored ? ['-x'] : [])]))
      .split('\n')
      .filter(Boolean)
      .map((l) => l.replace(/^Would remove /, '')),
  clean: (r, a) => git(r, ['clean', '-f', '-d', ...(a.ignored ? ['-x'] : [])]),
  gc: async (r) => {
    await git(r, ['gc', '--quiet'], { timeout: 110_000 })
    return git(r, ['count-objects', '-vH'])
  },

  submodules: async (r) => {
    if (!(await fsx.exists(hpath().join((await paths(r)).toplevel, '.gitmodules')))) return []
    const raw = await git(r, ['submodule', 'status', '--recursive'], { okCodes: [0, 128] })
    const states = { ' ': 'ok', '+': 'changed', '-': 'not initialized', U: 'conflict' }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const m = l.match(/^([ +\-U])([0-9a-f]+) (\S+)(?: \((.*)\))?/)
        return m ? { state: states[m[1]], hash: m[2], path: m[3], describe: m[4] || '' } : null
      })
      .filter(Boolean)
  },
  submoduleUpdate: (r) => git(r, ['submodule', 'update', '--init', '--recursive'], net),

  formatPatch: (r, a) => git(r, ['format-patch', '-1', '--stdout', req(a.hash, 'hash')]),
  rewordLast: (r, a) => {
    const msg = String(a.message || '')
    if (!msg.trim()) throw new GitError('message is empty')
    return git(r, ['commit', '--amend', '--only', '-F', '-'], { input: msg })
  },
  squashSince: async (r, a) => {
    const base = req(a.base, 'base commit')
    // exit 0 = ancestor; 1 = not (git() rejects on 1 since only 0 is ok)
    const isAncestor = await git(r, ['merge-base', '--is-ancestor', base, 'HEAD']).then(() => true, () => false)
    if (!isAncestor) throw new GitError('That commit is not in the current branch, so there is nothing to squash onto it')
    const msg = String(a.message || '')
    if (!msg.trim()) throw new GitError('message is empty')
    if ((await git(r, ['status', '--porcelain', '--untracked-files=no'])).trim())
      throw new GitError('Commit or stash your changes before squashing')
    const before = (await git(r, ['rev-parse', 'HEAD'])).trim()
    await git(r, ['reset', '--soft', base])
    try {
      return await git(r, ['commit', '-F', '-'], { input: msg })
    } catch (e) {
      await git(r, ['reset', '--soft', before]).catch(() => {}) // put the branch back as it was
      throw e
    }
  },
  conflictText: async (r, a) => {
    const f = String(a.file || '')
    if (!f || f.startsWith('-')) throw new GitError('bad file')
    const stage = (n) => git(r, ['show', `:${n}:${f}`]).catch(() => '')
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)])
    // the three sides as files where git runs (a temp folder there)
    const dir = await fsx.mkdtemp('orca-git-cf-')
    try {
      const P = hpath()
      const p = async (n, t) => (await fsx.write(P.join(dir, n), t), P.join(dir, n))
      const [o, b, t] = await Promise.all([p('ours', ours), p('base', base), p('theirs', theirs)])
      const out = await git(r, ['merge-file', '-p', '--diff3', '-L', 'current', '-L', 'base', '-L', 'incoming', o, b, t], { okCodes: Array.from({ length: 128 }, (_, i) => i) })
      return { text: out, hasBase: !!base }
    } finally {
      await fsx.rm(dir, { recursive: true }).catch(() => {})
    }
  },
  gitLog: async () => CMD_LOG.slice(-100),
  commitCheck: (r) => commitCheck(r),
  rebaseTodo: async (r, a) => {
    const raw = await git(r, ['log', '--reverse', `--format=%H${SEP}%s`, `${req(a.base, 'base')}..HEAD`])
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, subject] = l.split(SEP)
        return { hash, subject }
      })
  },
  rebaseInteractive: async (r, a) => {
    const base = req(a.base, 'base')
    const ACTIONS = new Set(['pick', 'squash', 'fixup', 'drop', 'reword'])
    // kept until the rebase is over: a reword after a conflict still needs its message file
    for (const t of a.todo || []) if (!ACTIONS.has(t.action) || !/^[0-9a-f]{7,40}$/.test(t.hash)) throw new GitError('invalid rebase plan')
    if (!(a.todo || []).length) throw new GitError('nothing to rebase')
    // kept where git runs (this machine or the remote host) until the rebase is over
    const P = hpath()
    const dir = await fsx.mkdtemp('orca-git-rebase-')
    const q = (p) => '"' + p.replace(/\\/g, '/') + '"'
    try {
      let n = 0
      const lines = []
      for (const t of a.todo) {
        const msg = t.action === 'reword' ? String(t.message || '').trim() : ''
        if (t.action !== 'reword') lines.push(`${t.action} ${t.hash}`)
        else if (!msg) lines.push(`pick ${t.hash}`)
        else {
          const mf = P.join(dir, `msg${n++}.txt`)
          await fsx.write(mf, msg + '\n')
          lines.push(`pick ${t.hash}\nexec git commit --amend --allow-empty -F ${q(mf)}`)
        }
      }
      const file = P.join(dir, 'todo.txt')
      await fsx.write(file, lines.join('\n') + '\n')
      // Git runs the sequence editor with the todo file's path; it copies our plan over it.
      if (currentHost()) {
        // on a remote host git's own sh does it: no Node there
        return await git(r, ['-c', `sequence.editor=cp ${q(file)}`, '-c', 'core.editor=true', 'rebase', '-i', base])
      }
      const script = P.join(dir, 'seq-editor.cjs')
      await fsx.write(script, "require('fs').copyFileSync(process.env.ORCA_GIT_TODO, process.argv[2])\n")
      return await git(r, ['-c', `sequence.editor=${q(process.execPath)} ${q(script)}`, '-c', 'core.editor=true', 'rebase', '-i', base], {
        env: { ELECTRON_RUN_AS_NODE: '1', ORCA_GIT_TODO: file }
      })
    } finally {
      if (!(await repoState(r).catch(() => null))) await fsx.rm(dir, { recursive: true }).catch(() => {})
    }
  }
}

const READ_ONLY_OPS = new Set(['fileImage', 
  'status', 'diff', 'log', 'commitShow', 'commitFileDiff', 'refs', 'worktrees', 'stashList', 'stashShow', 'remotes',
  'configList', 'blame', 'showFile', 'treeFiles', 'compare', 'compareFileDiff', 'reflog', 'cleanPreview', 'submodules',
  'aheadBehind', 'rebaseTodo', 'lastMessage', 'formatPatch', 'ciStatus', 'pipelines', 'pipelineJobs', 'jobLog', 'readWorkFile', 'branchCleanup', 'undoInfo', 'conflictText', 'gitLog', 'commitCheck'
])
const NO_REPO_OK = new Set(['configList', 'configSet', 'configUnset', 'init', 'clone'])

let ORCA = null

/**
 * The panel names a repository on a remote host by a locator ("ssh://host/path"), in `repo`, `path`
 * or an argument. Unwrap them to plain paths there and say which host the request runs on.
 */
const MANY_HOSTS = new Set(['repos.tagPatterns', 'repos.tagPlan', 'repos.tagApply'])
function unwrapRequest(input) {
  let host
  const strip = (v) => {
    if (!isLocator(v)) return v
    const l = parseLocator(v)
    if (host !== undefined && host !== l.host) throw new GitError('One request cannot work on two machines at once')
    host = l.host
    return l.path
  }
  const level = (o) =>
    o && typeof o === 'object' && !Array.isArray(o)
      ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map(strip) : strip(v)]))
      : o
  let out = level(input)
  if (out?.args) out = { ...out, args: level(out.args) }
  return { host: host ?? null, input: out }
}

export default function activate(orca) {
  // Orca accepts only plain JSON answers: a field left undefined (or NaN) made it refuse the whole reply
  // ("answered with a non-JSON value"). Every handler's answer is made plain JSON on the way out.
  const handle = orca.panels.handle.bind(orca.panels)
  const MAX_ANSWER = 960 * 1024
  orca = {
    ...orca,
    panels: {
      ...orca.panels,
      handle: (name, fn) =>
        handle(name, async (raw) => {
          // a request about repositories on several machines (Repo Overview) runs each one where it is
          const { host, input } = MANY_HOSTS.has(name) ? { host: null, input: raw } : unwrapRequest(raw)
          const r = await onHost(host, () => fn(input))
          if (r === undefined) return null
          const text = JSON.stringify(r)
          // Orca refuses answers over 1 MiB and the whole page breaks: say what happened instead
          if (text.length > MAX_ANSWER) throw new GitError(`The answer was too large to show (${(text.length / 1048576).toFixed(1)} MB). If the repository has many new files, add their folder (build output, node_modules…) to .gitignore.`)
          return JSON.parse(text)
        })
    }
  }
  ORCA = orca
  orca.panels.handle('git', async (input) => {
    const { op, repo } = input || {}
    const args = input?.args || {}
    const fn = ops[op]
    if (!fn) throw Object.assign(new Error(`unknown operation: ${op}`), { code: 'invalid_params' })
    const scopeGlobal = args.scope === 'global'
    if (!repo && !(NO_REPO_OK.has(op) && (scopeGlobal || op === 'init' || op === 'clone')))
      throw new GitError('no repository selected')
    if (args.fresh) shortMemo.clear() // an explicit Refresh: nothing from the short cache
    if (READ_ONLY_OPS.has(op)) return fn(repo, args)
    // Anything that may change the repository: drop the shared short-lived answers before and after.
    shortMemo.clear()
    try {
      return await fn(repo, args)
    } finally {
      shortMemo.clear()
    }
  })

  // Find the repository for the focused Orca workspace, plus every local workspace for the picker.
  // The repository the status bar last showed: what the person sees when they press it, used when
  // the focused workspace cannot be told apart at that moment (no terminal yet, same name and branch).
  let lastRepo = null
  async function resolveFocused() {
    const workspaces = await listWorkspaces(orca)
    let focused = null
    let ctx = null
    try {
      ctx = await orca.host.call('workspace.readContext', {})
    } catch {}
    if (ctx) {
      // Best: a terminal of the focused workspace tells us its exact worktree path.
      if (ctx.terminals?.length) {
        const map = await terminalWorktrees()
        focused = ctx.terminals.map((t) => map[t.id]).find(Boolean) || null
      }
      // Otherwise match by name and branch, but only when that is unambiguous.
      if (!focused) {
        const hits = workspaces.filter((w) => w.name === ctx.displayName && w.branch === ctx.branch)
        if (hits.length === 1) focused = hits[0].path
      }
    }
    if (focused) lastRepo = focused
    return { focused, workspaces }
  }
  orca.panels.handle('repo.resolve', () => resolveFocused())

  // servers: list, add, change, remove, and the repositories found on them
  orca.panels.handle('servers.repos', ({ refresh } = {}) => serverRepos({ refresh: !!refresh, wait: refresh ? 20_000 : 1500 }))
  orca.panels.handle('servers.list', () => serverList())
  orca.panels.handle('servers.add', (input = {}) => serverAdd(input))
  orca.panels.handle('servers.update', async ({ id, roots, hidden } = {}) => {
    await serverUpdate(req(id, 'server'), { roots, hidden })
    return serverList()
  })
  orca.panels.handle('servers.remove', async ({ id } = {}) => {
    if ((await sshTargets()).some((t) => t.id === id)) throw new GitError("This server comes from Orca's SSH hosts: remove it in Orca's settings, or hide it here")
    await serverUpdate(req(id, 'server'), { remove: true })
    return serverList()
  })
  orca.panels.handle('servers.sshAliases', () => sshAliasChoices())

  // Status bar: "⎇ branch ↑1 ↓2 • 3" for the focused worktree; pressing it opens Git Control in a tab.
  orca.commands.register('openGraph', async () => {
    const repo = (await resolveFocused().catch(() => ({}))).focused || lastRepo
    if (!repo) return 'No Git repository for the focused workspace'
    await openTabRetry(repo)
    return 'Opened Git Control'
  })
  // Opening the tab goes through Orca's CLI, which can miss once while Orca is busy: try again.
  async function openTabRetry(repo) {
    try {
      return await inRepo(repo, (p) => openGraphTab(p))
    } catch (e) {
      orca.log(`Git Control tab did not open (${e.message}); trying again`)
      await new Promise((res) => setTimeout(res, 400))
      return inRepo(repo, (p) => openGraphTab(p))
    }
  }
  let lastBar = ''
  let barBusy = false // a slow git must not pile up overlapping polls
  async function updateStatusBar() {
    if (barBusy || !orca.host.has('statusBar.update')) return false
    barBusy = true
    try {
      return await updateStatusBarOnce()
    } finally {
      barBusy = false
    }
  }
  // The Git item never disappears: when the focused worktree cannot be told (no terminal yet, two
  // workspaces with the same name) it reads just "Git"; when git is busy or slow (another tool holds
  // the index) the last good text stays. Orca can drop items (window reload), so it is re-sent each minute.
  let lastGood = null // { repo, item }
  let lastSent = 0
  async function updateStatusBarOnce() {
    const plain = { id: 'branch', text: 'Git', tone: 'neutral', tooltip: 'Open Git Control', visible: true }
    let item = plain
    let focused = null
    try {
      focused = (await resolveFocused()).focused
    } catch {}
    if (focused) {
      try {
        const st = await inRepo(focused, (p) => status(p, { untracked: 'normal' })) // a count is enough: no walk into new folders
        const parts = [st.branch || `detached ${(st.oid || '').slice(0, 7)}`]
        if (st.ahead) parts.push(`↑${st.ahead}`)
        if (st.behind) parts.push(`↓${st.behind}`)
        if (st.files.length) parts.push(`• ${st.files.length}`)
        const conflicts = st.files.some((f) => f.conflict)
        item = {
          ...plain,
          text: parts.join(' '),
          tone: conflicts || st.state ? 'warning' : 'neutral',
          tooltip: `${path.posix.basename(String(st.toplevel).replace(/\\/g, '/'))}${st.state ? ` · ${st.state} in progress` : ''}
Click to open Git Control`
        }
        lastGood = { repo: focused, item }
      } catch {
        if (lastGood?.repo === focused) item = lastGood.item
      }
    }
    const key = JSON.stringify(item)
    if (key === lastBar && Date.now() - lastSent < 60_000) return false
    const changed = key !== lastBar
    lastBar = key
    lastSent = Date.now()
    try {
      await orca.host.call('statusBar.update', item)
    } catch {}
    return changed
  }
  // Poll every 4 s while things change; slow down to 15 s while nothing does.
  let barDelay = 4000
  let barTimer = null
  const scheduleBar = () => {
    clearTimeout(barTimer)
    barTimer = setTimeout(async () => {
      const changed = await updateStatusBar().catch(() => false)
      barDelay = changed ? 4000 : Math.min(15_000, Math.round(barDelay * 1.5))
      scheduleBar()
    }, barDelay)
  }
  updateStatusBar()
  scheduleBar()

  // Orca keeps editor tabs per workspace, so the Git Control tab cannot follow the person from one
  // workspace to the next. Instead, each workspace they switch to gets its own Git Control tab:
  // - they were looking at Git Control when they switched: it opens and comes to the front;
  // - they were on anything else (a file, a terminal): it opens in the background once per Orca
  //   session, so their tab stays in front (closing it there is respected until Orca restarts).
  const keepOpen = async () => {
    try {
      return (await orca.host.call('settings.get', {})).settings.keepGraphOpen === true
    } catch {
      return false
    }
  }
  // Each Git Control tab reports when it is shown or hidden. Switching workspaces hides the old one a
  // moment before Orca reports the switch, so "was on Git Control" also covers a tab hidden just now.
  const SWITCH_WINDOW = 3000
  let graphShown = false
  let graphHiddenAt = 0
  orca.panels.handle('graph.visible', ({ visible } = {}) => {
    if (graphShown && !visible) graphHiddenAt = Date.now()
    graphShown = !!visible
    return { ok: true }
  })
  const graphOpenedIn = new Set()
  let lastFocused = null
  let opening = Promise.resolve()
  // Older Orca builds have no worker events; the rest of the plugin works without them.
  orca.events?.on?.('workspace.changed', () => {
    forgetFocusCaches() // a new focus: look it up again, and update the status bar now
    barDelay = 4000
    updateStatusBar()
    scheduleBar()
    // Read before awaiting anything: the new workspace's own tab may report itself shown meanwhile.
    const wasOnGraph = graphShown || Date.now() - graphHiddenAt < SWITCH_WINDOW
    opening = opening.then(async () => {
      if (!(await keepOpen())) return
      const { focused } = await resolveFocused()
      if (!focused) return
      const key = focused.replace(/\\/g, '/').toLowerCase()
      // The event also fires when terminals open or close; only a real switch counts.
      const switched = lastFocused !== null && lastFocused !== key
      lastFocused = key
      if (switched && wasOnGraph) {
        graphOpenedIn.add(key)
        graphHiddenAt = 0
        return inRepo(focused, (p) => openGraphTab(p, { focus: true })).catch((e) => orca.log(`Git Control tab not focused: ${e.message}`))
      }
      // Not on Git Control: leave the new project alone.
    })
    return opening
  })

  const agentSetting = async () => {
    try {
      return (await orca.host.call('settings.get', {})).settings.aiAgent || 'claude'
    } catch {
      return 'claude'
    }
  }
  orca.panels.handle('ai.commitMessage', async ({ repo, agent, instructions, scope } = {}) =>
    aiCommitMessage(req(repo, 'repo'), AI[agent] ? agent : await agentSetting(), { instructions, scope })
  )
  orca.panels.handle('ai.settings', async (input) => {
    const agent = input?.agent
    if (agent && AI[agent]) await orca.host.call('settings.set', { key: 'aiAgent', value: agent }).catch(() => {})
    const available = {}
    await Promise.all(
      Object.entries(AI).map(async ([k, v]) => {
        const r = await runProc(v.bin, ['--version'], { timeout: 8000, shell: v.shell })
        available[k] = r.code === 0
      })
    )
    return { agent: await agentSetting(), agents: Object.entries(AI).map(([id, v]) => ({ id, name: v.name, available: available[id] })) }
  })
  orca.panels.handle('ai.explain', async (input = {}) => aiExplain(input, AI[input.agent] ? input.agent : await agentSetting()))
  orca.panels.handle('ai.resolveFile', async ({ repo, file, agent } = {}) => aiResolveFile(req(repo, 'repo'), req(file, 'file'), AI[agent] ? agent : await agentSetting()))
  orca.panels.handle('ai.resolve', async ({ repo } = {}) => aiResolve(orca, req(repo, 'repo'), await agentSetting()))
  orca.panels.handle('repo.ignoreGraphFiles', async ({ repo } = {}) => ignoreGraphFiles(req(repo, 'repo')).then(() => ({ ok: true })))
  orca.panels.handle('mr.info', async ({ repo, target, source } = {}) => mrInfo(req(repo, 'repo'), target || 'HEAD', source))
  orca.panels.handle('mr.create', async (input = {}) => {
    shortMemo.clear()
    return mrCreate(req(input.repo, 'repo'), input)
  })
  orca.panels.handle('mr.people', async ({ repo, query } = {}) => mrPeople(req(repo, 'repo'), { query }))
  orca.panels.handle('mr.setup', async ({ repo, step } = {}) => mrSetup(orca, req(repo, 'repo'), { step }))
  orca.panels.handle('reviews.list', ({ repo, fresh } = {}) => reviewsList(orca, repo, { fresh }))
  // Show more under All: the next page of merged ones only
  orca.panels.handle('reviews.moreMerged', ({ repo, page } = {}) => reviewsList(orca, repo, { page, mergedOnly: true }))
  orca.panels.handle('ai.review', async (input = {}) => aiReview(input, AI[input.agent] ? input.agent : await agentSetting()))
  orca.panels.handle('ai.reviewLocal', async (input = {}) => aiReviewLocal(req(input.repo, 'repo'), input, AI[input.agent] ? input.agent : await agentSetting()))
  orca.panels.handle('reviews.act', (input = {}) => reviewAct(input))
  orca.panels.handle('reviews.detail', (input = {}) => reviewDetail(input))
  orca.panels.handle('reviews.queue', ({ items = [], approve = true } = {}) => queueMerges(items, { approve }))
  orca.panels.handle('reviews.queueState', () => mergeQueueState())
  orca.panels.handle('reviews.setup', async ({ host, step } = {}) => {
    // same terminal setup as the merge request dialog, for a host instead of a repository
    setupCommand(step, host) // validates before looking up workspaces
    return runSetup(orca, (await listWorkspaces(orca)).find((w) => !w.host), step, host, 'Review inbox setup')
  })
  orca.panels.handle('ai.mrDescription', async (input = {}) => aiMrDescription(req(input.repo, 'repo'), input, AI[input.agent] ? input.agent : await agentSetting()))
  orca.panels.handle('reviews.diff', async (input = {}) => {
    const m = await reviewMaterial(input)
    return { diff: m.diff.length > 1_500_000 ? m.diff.slice(0, 1_500_000) : m.diff, title: m.title }
  })
  orca.panels.handle('reviews.lineComment', async (input = {}) => reviewLineComment(input.item || {}, input))
  orca.panels.handle('ui.pending', () => {
    const p = pendingUi
    pendingUi = null
    return p
  })

  // Reviews in the status bar, and a desktop notification when a new request arrives.
  let pendingUi = null
  let knownReviews = null
  let knownStates = null // url → { state, ci } at the last poll (for "pipeline passed", "merged")
  let reviewsBusy = false
  async function pollReviews() {
    if (reviewsBusy || !orca.host.has('statusBar.update')) return
    reviewsBusy = true
    try {
      const { items, providers } = await reviewsList(orca)
      if (!providers.some((p) => p.signedIn)) return orca.host.call('statusBar.update', { id: 'reviews', visible: false }).catch(() => {})
      // waiting for me: asked of me or assigned, not mine, not approved by me yet (as the panel counts it)
      const waiting = items.filter((i) => i.state === 'open' && (i.roles.includes('review') || i.roles.includes('assigned')) && !(i.me && i.author === i.me) && !i.roles.includes('mine') && !i.myApproved)
      const openNow = items.filter((i) => i.state === 'open') // everything the Open tab lists (Everyone)
      const line = (i) => `${i.repo.split('/').pop()} ${i.provider === 'github' ? '#' : '!'}${i.number}: ${i.title}`
      await orca.host.call('statusBar.update', {
        id: 'reviews',
        // always there once signed in: how many are open (the Open tab's count), and how many of them
        // wait for you when some do; a click opens MR / PR
        visible: true,
        text: `MR/PR ${openNow.length}${waiting.length ? ` · ${waiting.length} for you` : ''}`,
        tone: waiting.length ? 'accent' : 'neutral',
        // Orca takes at most 256 characters here: the lines that fit, then how many more
        tooltip: barTip([...(waiting.length ? [`${waiting.length} waiting for you:`, ...waiting.map(line)] : ['Nothing waits for you']), `${openNow.length} open:`, ...openNow.filter((i) => !waiting.includes(i)).map(line)], 'Click to open MR / PR')
      }).catch((e) => {
        orca.log(`status bar: ${e.message}`)
        // Orca refuses while it (re)starts the plugin: try again in a few seconds, not at the next poll
        if (/consent|not enabled/i.test(e.message)) setTimeout(pollReviews, 10_000)
      })
      const urls = new Set(waiting.map((i) => i.url))
      // Notifications (desktop and Orca's phone app), all from this same list, no extra requests:
      // asked of me / assigned, a new MR in a repo open in Orca, a pipeline that just finished on one
      // that is mine or asked of me, and mine merged. The first poll only learns what is there.
      const ref = (i) => `${i.repo.split('/').pop()} ${i.provider === 'github' ? '#' : '!'}${i.number}`
      const mineOrMe = (i) => i.roles.includes('mine') || (i.me && i.author === i.me) || i.roles.includes('review') || i.roles.includes('assigned')
      const now = new Map(items.map((i) => [i.url, { state: i.state, ci: i.ci || null }]))
      if (knownReviews && knownStates && orca.host.has('notifications.show')) {
        const out = []
        for (const i of waiting.filter((x) => !knownReviews.has(x.url))) out.push({ title: i.roles.includes('review') ? 'Review requested' : 'Assigned to you', body: `${ref(i)}: ${i.title}` })
        for (const i of items) {
          const was = knownStates.get(i.url)
          const mine = i.roles.includes('mine') || (i.me && i.author === i.me)
          if (!was && i.state === 'open' && i.inOrca && !mine && !urls.has(i.url)) out.push({ title: `New merge request · ${i.repo.split('/').pop()}`, body: `${ref(i)}: ${i.title} (${i.author})` })
          if (was && ['running', 'pending'].includes(was.ci) && ['passed', 'failed'].includes(i.ci) && mineOrMe(i)) out.push({ title: i.ci === 'failed' ? 'Pipeline failed' : 'Pipeline passed', body: `${ref(i)}: ${i.title}` })
          if (was?.state === 'open' && i.state === 'merged' && mine) out.push({ title: 'Merged', body: `${ref(i)}: ${i.title}` })
        }
        for (const n of out.slice(0, 5)) await orca.host.call('notifications.show', n).catch(() => {})
      }
      knownReviews = urls
      knownStates = now
    } catch (e) {
      orca.log(`reviews poll: ${e.message}`)
    } finally {
      reviewsBusy = false
    }
  }
  // every 3 minutes (tests: GITX_REVIEWS_POLL ms, starting at once)
  const pollEvery = +process.env.GITX_REVIEWS_POLL || 3 * 60_000
  setTimeout(pollReviews, process.env.GITX_REVIEWS_POLL ? 50 : 15_000)
  setInterval(pollReviews, pollEvery)
  // the status bar's ↻ beside MR/PR: ask GitHub and GitLab now, not at the next poll
  orca.commands.register('checkReviews', async () => {
    listShared.clear()
    // Orca's status bar has no spinning icon: a spinner drawn with characters while it checks
    const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    let f = 0
    const spin = () => orca.host.has('statusBar.update') && orca.host.call('statusBar.update', { id: 'reviews-check', text: `${frames[f++ % frames.length]} Checking`, tooltip: 'Checking merge and pull requests…', tone: 'accent' }).catch(() => {})
    spin()
    const spinner = setInterval(spin, 120)
    try {
      await pollReviews()
    } finally {
      clearInterval(spinner)
    }
    orca.host.has('statusBar.update') && (await orca.host.call('statusBar.update', { id: 'reviews-check', text: '', tooltip: `Checked at ${new Date().toLocaleTimeString()}. Click to check again`, tone: 'neutral' }).catch(() => {}))
    orca.panels.post?.('reviews.changed', {})
    return 'Checked merge and pull requests'
  })
  orca.commands.register('openReviews', async () => {
    pendingUi = { tab: 'reviews' }
    orca.panels.post?.('ui.show', { tab: 'reviews' })
    const { focused } = await resolveFocused()
    if (focused || lastRepo) await openTabRetry(focused || lastRepo)
    return 'Opened Reviews'
  })
  // Several repositories open (or scanned): "⎇ 3 of 5 repos" in the status bar while some have
  // changes, commits to push or pull; a click opens Repos overview. Hidden with a single repo.
  let reposBusy = false
  async function pollRepos() {
    if (reposBusy || !orca.host.has('statusBar.update')) return
    reposBusy = true
    try {
      let scan = ''
      try {
        scan = (await orca.host.call('settings.get', {})).settings.scanFolders || ''
      } catch {}
      // in the background: no ssh to the servers' found projects every two minutes
      const { repos } = await reposOverview(await listWorkspaces(orca).catch(() => []), scan, { servers: false })
      const ok = repos.filter((r) => !r.error)
      const busy = ok.filter((r) => r.changes || r.ahead || r.behind || r.conflicts || r.state)
      const bad = ok.some((r) => r.conflicts || r.state)
      const line = (r) => `${r.name} (${r.branch || 'detached'})${r.ahead ? ` ↑${r.ahead}` : ''}${r.behind ? ` ↓${r.behind}` : ''}${r.conflicts ? ` · ${r.conflicts} conflicts` : r.changes ? ` · ${r.changes} changed` : ''}`
      await orca.host.call('statusBar.update', {
        id: 'repos',
        // always there: a click opens Repo Overview; how many repos need you when some do
        visible: ok.length > 0,
        text: busy.length ? `Overview ${busy.length}/${ok.length}` : 'Overview',
        tone: bad ? 'warning' : busy.length ? 'accent' : 'neutral',
        tooltip: barTip(busy.length ? [`${busy.length} of ${ok.length} repos need you:`, ...busy.map(line)] : [`${ok.length} repos, every one clean and up to date`], 'Click to open Repo Overview')
      }).catch(() => {})
    } catch (e) {
      orca.log(`repos poll: ${e.message}`)
    } finally {
      reposBusy = false
    }
  }
  setTimeout(pollRepos, 5_000)
  setInterval(pollRepos, 2 * 60_000)
  orca.commands.register('openRepos', async () => {
    pendingUi = { overview: true }
    orca.panels.post?.('ui.show', { overview: true })
    const { focused } = await resolveFocused().catch(() => ({}))
    if (focused || lastRepo) await openTabRetry(focused || lastRepo)
    return 'Opened Repos overview'
  })
  // open a repository file as an Orca editor tab (in its worktree)
  orca.panels.handle('file.open', async ({ repo, file } = {}) => {
    const p = await workPath(req(repo, 'repo'), req(file, 'file'))
    if (!(await fsx.exists(p))) throw new GitError('That file is not in the working tree (deleted or on another branch)')
    const { toplevel } = await paths(repo)
    await openInOrca(p, toplevel)
    return { opened: true }
  })
  orca.panels.handle('shell.open', async ({ url } = {}) => ({ opened: await openInBrowser(String(url || '')) }))
  orca.panels.handle('tab.open', async ({ repo } = {}) => openGraphTab(req(repo, 'repo')))

  // Repos overview: every local repository at once (Orca's workspaces, plus the sub-folders of the
  // folders in the "Scan folders" setting), each with its branch, ahead/behind and changes.
  orca.panels.handle('repos.overview', async () => {
    let scan = ''
    try {
      scan = (await orca.host.call('settings.get', {})).settings.scanFolders || ''
    } catch {}
    return reposOverview(await listWorkspaces(orca).catch(() => []), scan)
  })

  orca.panels.handle('repos.tagPatterns', ({ repos = [] } = {}) => tagPatterns(repos.map((r) => req(r, 'repo'))))
  orca.panels.handle('repos.tagPlan', (input = {}) => tagPlan({ ...input, repos: (input.repos || []).map((r) => req(r, 'repo')) }))
  orca.panels.handle('repos.tagApply', (input = {}) => tagApply(input))
  orca.panels.handle('repo.inside', ({ path: p } = {}) => reposInside(req(p, 'path')))
  orca.panels.handle('repos.setScan', async ({ folders = '' } = {}) => {
    const value = String(folders).split(/[;\n]/).map((x) => x.trim()).filter(Boolean).join('; ')
    await orca.host.call('settings.set', { key: 'scanFolders', value })
    return { folders: value }
  })
  orca.panels.handle('repo.check', async ({ path: p } = {}) => {
    try {
      const top = (await git(req(p, 'path'), ['rev-parse', '--show-toplevel'])).trim()
      return { ok: true, toplevel: toLocator(top) }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  // Show a worktree in Orca when Orca knows it as a workspace.
  orca.panels.handle('worktree.open', async ({ path: p } = {}) => {
    const ws = (await listWorkspaces(orca)).find((w) => isWorkspaceOf(w, p))
    if (!ws || !orca.host.has('workspace.open')) return { opened: false }
    try {
      await orca.host.call('workspace.open', { workspaceId: ws.id })
      return { opened: true }
    } catch {
      return { opened: false } // e.g. workspace:write not granted on this Orca version
    }
  })
}
