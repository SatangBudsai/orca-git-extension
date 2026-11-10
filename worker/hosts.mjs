// Where git runs: on this machine, or on a host Orca reaches over SSH.
//
// Orca runs this worker on the desktop, also for workspaces that live on an SSH host. The plugin API
// has no way to run a command there, so for those Git Control uses the system `ssh` itself (with
// the person's own ~/.ssh/config and keys), one multiplexed connection per host.
//
// A repository on a host is named by a locator, "ssh://<host>/<absolute path>", where <host> is the
// URI-encoded Orca SSH target id (or, typed by hand, an ssh destination). The panel only ever sees
// locators; the worker unwraps one per request and runs that request "on" the host, so every git
// call and file access below it goes there without being told. That is what `onHost` sets up.
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CTX = new AsyncLocalStorage()
const PREFIX = 'ssh://'
const LOCATOR = /^ssh:\/\/([^/]+)(\/.*)$/

export class HostError extends Error {
  constructor(message) {
    super(message)
    this.code = 'action_failed'
  }
}

// ---------- locators ----------

export const isLocator = (s) => typeof s === 'string' && LOCATOR.test(s)
/** { host, path } for a locator; { host: null, path: s } for a path on this machine. */
export function parseLocator(s) {
  const m = typeof s === 'string' ? s.match(LOCATOR) : null
  if (!m) return { host: null, path: s }
  let host
  try {
    host = decodeURIComponent(m[1])
  } catch {
    throw new HostError(`Not a valid remote repository: ${s}`)
  }
  return { host, path: m[2].replace(/\/+$/, '') || '/' }
}
export const locator = (host, p) => `${PREFIX}${encodeURIComponent(host)}${p.startsWith('/') ? '' : '/'}${p}`

/** The host the current request runs on (null: this machine). */
export const currentHost = () => CTX.getStore()?.host ?? null
/** Run `fn` with git and files on `host` (null: this machine). Everything it awaits stays there. */
export const onHost = (host, fn) => CTX.run({ host: host || null }, fn)
/** Run `fn(path)` where the locator (or local path) `repo` lives. */
export function inRepo(repo, fn) {
  const { host, path: p } = parseLocator(repo)
  return onHost(host, () => fn(p))
}
/** An absolute path on the current host, as the panel names it. */
export function toLocator(p) {
  const h = currentHost()
  return h && typeof p === 'string' && p.startsWith('/') ? locator(h, p) : p
}
/** A cache key that cannot mix up the same path on two machines. */
export const hostKey = (k) => {
  const h = currentHost()
  return h ? `${PREFIX}${h}|${k}` : k
}
/** Path functions for the current host: remote hosts are POSIX whatever this machine is. */
export const hpath = () => (currentHost() ? path.posix : path)

// ---------- processes ----------

/**
 * Run a program and collect its output. Never rejects: { code, out (Buffer), err, killedFor, spawnError }.
 * `maxBytes` stops it when stdout grows past that size.
 */
export function collect(bin, argv, { cwd, env, input, timeout = 30_000, signal, maxBytes = Infinity, what = bin } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      // a stand-in written in Node (tests, on any OS: Windows cannot run a #!/bin/sh one) runs with Node
      child = /\.mjs$/.test(bin) ? spawn(process.execPath, [bin, ...argv], { cwd: cwd || undefined, windowsHide: true, env }) : spawn(bin, argv, { cwd: cwd || undefined, windowsHide: true, env })
    } catch (e) {
      return resolve({ code: null, out: Buffer.alloc(0), err: '', killedFor: null, spawnError: e })
    }
    const out = []
    const err = []
    let size = 0
    let killedFor = null
    let spawnError = null
    const stop = (why) => {
      killedFor ||= why
      child.kill()
    }
    const timer = setTimeout(() => stop(`${what} timed out after ${Math.round(timeout / 1000)} s`), timeout)
    const onAbort = () => stop(`${what} was cancelled`)
    signal?.addEventListener('abort', onAbort)
    child.stdout.on('data', (d) => {
      size += d.length
      if (size > maxBytes) stop(`${what} output too large`)
      else out.push(d)
    })
    child.stderr.on('data', (d) => err.push(d))
    child.on('error', (e) => (spawnError = e))
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8').trim(), killedFor, spawnError })
    })
    child.stdin.on('error', () => {}) // it may exit before reading its input
    if (input != null) child.stdin.end(input)
    else child.stdin.end()
  })
}

/** Quote one word for a POSIX shell; also right for bash, zsh and fish login shells. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// ---------- ssh ----------

const SSH_BIN = process.env.GIT_CONTROL_SSH || 'ssh'
const MAX_SESSIONS = 6 // sshd allows 10 sessions per connection by default (MaxSessions)

/** One connection per host, shared by every command (not on Windows, whose OpenSSH cannot). */
function controlOpts() {
  if (process.platform === 'win32' || process.env.GIT_CONTROL_SSH_NO_MUX) return []
  const dir = path.join(os.homedir(), '.ssh')
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {}
  // %C is a hash of the connection: short enough for the socket path limit (104 bytes on macOS)
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(dir, 'git-control-%C')}`, '-o', 'ControlPersist=300']
}
const sshBaseArgs = () => [
  '-o', 'BatchMode=yes', // never wait for a password or a host key question nobody can answer
  '-o', 'ConnectTimeout=15',
  '-o', 'ServerAliveInterval=20',
  '-o', 'ServerAliveCountMax=3',
  ...controlOpts()
]

let resolveDestination = async (host) => host
/** How a host (an Orca SSH target id) becomes an ssh destination; set by the worker. */
export function setDestinationResolver(fn) {
  resolveDestination = fn
}

/** "host:port" and "user@host:port" (how Orca shows targets) become ssh:// URLs ssh understands. */
export function sshDestination(s) {
  const v = String(s || '').trim()
  if (!v || v.startsWith('-') || /\s/.test(v)) throw new HostError(`Not a usable ssh destination: "${v}"`)
  if (/^ssh:\/\//.test(v)) return v
  const m = v.match(/^((?:[^@\s]+@)?)([^:@\s]+):(\d+)$/)
  return m ? `ssh://${m[1]}${m[2]}:${m[3]}` : v
}

// ---------- ~/.ssh/config ----------
// Orca often shows a host by its address ("172.26.166.220"), while the user, port and key that log in
// to it live under an alias in ~/.ssh/config. Find that alias the way Orca matches them: ask OpenSSH
// (`ssh -G`) where each alias goes, and take the first whose host, port (and user, when given) agree.

const sshConfigFile = () => process.env.GIT_CONTROL_SSH_CONFIG || path.join(os.homedir(), '.ssh', 'config')

function includeFiles(pattern) {
  let p = pattern.replace(/^~(?=[\\/]|$)/, os.homedir())
  if (!path.isAbsolute(p)) p = path.join(os.homedir(), '.ssh', p)
  if (!/[*?]/.test(path.basename(p))) return /[*?]/.test(p) ? [] : [p]
  const dir = path.dirname(p)
  if (/[*?]/.test(dir)) return [] // a pattern in a folder name: rare, not followed
  const re = new RegExp('^' + path.basename(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  try {
    return fs.readdirSync(dir).filter((n) => re.test(n)).sort().map((n) => path.join(dir, n))
  } catch {
    return []
  }
}

/** The concrete Host aliases of ~/.ssh/config and the files it Includes, in order (patterns skipped). */
export function sshConfigAliases(file = sshConfigFile(), seen = new Set()) {
  if (seen.has(file) || seen.size > 32) return []
  seen.add(file)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.replace(/(^|\s)#.*$/, '').trim().match(/^(\w+)(?:\s*=\s*|\s+)(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const words = (m[2].match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/^"|"$/g, ''))
    if (key === 'host') out.push(...words.filter((w) => w && !/[*?!]/.test(w)))
    else if (key === 'include') for (const w of words) for (const f of includeFiles(w)) out.push(...sshConfigAliases(f, seen))
  }
  return [...new Set(out)]
}

/** Where OpenSSH would connect for `name`: { hostname, port, user }, or null. */
export async function sshResolve(name) {
  if (!name || name.startsWith('-')) return null
  const r = await collect(SSH_BIN, ['-G', name], { timeout: 10_000, what: 'ssh -G' })
  if (r.code !== 0) return null
  const kv = {}
  for (const line of r.out.toString('utf8').split(/\r?\n/)) {
    const i = line.indexOf(' ')
    if (i > 0) kv[line.slice(0, i).toLowerCase()] ??= line.slice(i + 1).trim()
  }
  return kv.hostname ? { hostname: kv.hostname.toLowerCase(), port: kv.port || '22', user: kv.user || '' } : null
}

const aliasMemo = new Map()
/**
 * The ~/.ssh/config alias for a destination given by address ("[user@]host[:port]"), so ssh uses the
 * user, port and key set up there; the destination itself when it is already an alias or nothing matches.
 */
export function sshConfigAlias(dest) {
  const hit = aliasMemo.get(dest)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p
  const p = (async () => {
    const m = String(dest).match(/^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:@\s/]+)(?::(\d+))?$/)
    if (!m) return dest // an ssh:// URL or something else: used as given
    const [, user, rawHost, port] = m
    const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase()
    const self = await sshResolve(rawHost)
    if (self && self.hostname !== host) return dest // already an alias ssh knows
    const want = { host, port: port || self?.port || '22', user: user || '' }
    const aliases = sshConfigAliases().slice(0, 200)
    for (let i = 0; i < aliases.length; i += 8) {
      const batch = await Promise.all(aliases.slice(i, i + 8).map(async (a) => ({ a, g: await sshResolve(a) })))
      const found = batch.find(({ g }) => g && g.hostname === want.host && g.port === want.port && (!want.user || g.user === want.user))
      if (found) return found.a // the first one in the file, as ssh would pick
    }
    return dest
  })()
  aliasMemo.set(dest, { at: Date.now(), p })
  return p
}

// a few commands at a time per destination
const lanes = new Map()
function slot(dest) {
  let l = lanes.get(dest)
  if (!l) lanes.set(dest, (l = { busy: 0, queue: [] }))
  return new Promise((res) => {
    const go = () => {
      l.busy++
      res(() => {
        l.busy--
        l.queue.shift()?.()
      })
    }
    if (l.busy < MAX_SESSIONS) go()
    else l.queue.push(go)
  })
}

function unreachable(dest, why) {
  const detail = (why || '').split('\n').filter(Boolean).pop() || 'no answer'
  // what to do, step by step: shown only here, when a server cannot be reached
  const auth = /permission denied|publickey|password|host key verification/i.test(detail)
  const net = /could not resolve|timed out|timeout|no route|refused|unreachable|no answer/i.test(detail)
  // an address (10.0.4.17, build.example.com) goes in HostName as is; a bare name is already an alias
  const host = dest.replace(/^.*@/, '').replace(/^ssh:\/\//, '')
  const address = /^[\d.:[\]]+$|^[\w-]+(\.[\w-]+)+(:\d+)?$/.test(host) ? host.replace(/:\d+$/, '') : '<its address>'
  const steps = [
    `In a terminal on this computer, run: ssh -o BatchMode=yes ${dest} 'git --version'`,
    ...(net && !auth ? ['If it cannot connect: check the address and that the server is on (and your VPN, if it needs one).'] : []),
    ...(!net || auth
      ? [`If it asks for a password or says "Permission denied": add your key to the server with ssh-copy-id ${dest}.`]
      : []),
    `If you log in to it with another name, user or key, put it in ~/.ssh/config, e.g.\n     Host my-server\n       HostName ${address}\n       User <you>\n       IdentityFile ~/.ssh/<key>\n   Git Control then uses that entry by itself.`,
    'Then try again.'
  ]
  return new HostError(`Could not reach ${dest} over SSH (${detail}).\n\nTo fix it:\n${steps.map((t, k) => `${k + 1}. ${t}`).join('\n')}`)
}

// The first command to a host opens the shared connection; the rest wait for it instead of racing
// to open one each.
const connecting = new Map()
function connect(dest) {
  let p = connecting.get(dest)
  if (!p) {
    p = collect(SSH_BIN, [...sshBaseArgs(), dest, 'exit 0'], { timeout: 30_000, what: 'ssh' }).then((r) => {
      if (r.spawnError) throw new HostError(r.spawnError.code === 'ENOENT' ? 'ssh was not found on PATH: Git Control needs OpenSSH to work on remote hosts' : r.spawnError.message)
      if (r.code !== 0) throw unreachable(dest, r.killedFor || r.err)
    })
    connecting.set(dest, p)
    // a host that cannot be reached fails fast for a little while instead of making every request wait
    p.catch(() => setTimeout(() => connecting.get(dest) === p && connecting.delete(dest), 20_000).unref?.())
  }
  return p
}

/** Run a shell command line on `host`; resolves like `collect`. */
export async function remote(host, cmd, opts = {}) {
  const dest = sshDestination(await resolveDestination(host))
  await connect(dest)
  const release = await slot(dest)
  try {
    const r = await collect(SSH_BIN, [...sshBaseArgs(), dest, cmd], { ...opts, env: undefined, cwd: undefined })
    if (r.code === 255 && !r.killedFor) {
      connecting.delete(dest) // the connection dropped: open it again next time
      throw unreachable(dest, r.err)
    }
    return r
  } finally {
    release()
  }
}

/** A command line for `bin args…` in `cwd` with `env`, for a remote login shell. */
export function commandLine(bin, args, { cwd, env = {} } = {}) {
  const words = ['env', ...Object.entries(env).filter(([, v]) => v != null).map(([k, v]) => shq(`${k}=${v}`)), bin, ...args.map(shq)]
  return (cwd ? `cd ${shq(cwd)} && ` : '') + words.join(' ')
}
/** A POSIX sh script with arguments, whatever the remote login shell is. */
const sh = (script, ...args) => `sh -c ${shq(script)} sh ${args.map(shq).join(' ')}`

async function remoteOk(cmd, opts) {
  const r = await remote(currentHost(), cmd, opts)
  if (r.code !== 0) throw Object.assign(new HostError(r.killedFor || r.err || `exit ${r.code}`), { exitCode: r.code })
  return r.out
}

// ---------- files, wherever the current request runs ----------

const notFound = (p) => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: 'ENOENT' })

// O_NOFOLLOW: opening a symlink fails (ELOOP) instead of writing to where it points
const NO_FOLLOW_WRITE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0)
const symlinkRefused = (p) => new HostError(`${p} is a symbolic link; Git Control does not write through it`)

export const fsx = {
  async exists(p) {
    if (!currentHost()) return fs.existsSync(p)
    return (await remote(currentHost(), sh('test -e "$1"', p))).code === 0
  },
  /** Names in a folder; [] when it does not exist. */
  async readdir(p) {
    if (!currentHost()) return fs.existsSync(p) ? fs.readdirSync(p) : []
    const out = await remoteOk(sh('[ -d "$1" ] || exit 0; cd "$1" && for f in * .[!.]* ..?*; do [ -e "$f" ] || [ -L "$f" ] && printf "%s\\0" "$f"; done; exit 0', p))
    return out.toString('utf8').split('\0').filter(Boolean)
  },
  /** File contents: a string with `encoding`, else a Buffer. */
  async read(p, encoding) {
    if (!currentHost()) return fs.readFileSync(p, encoding)
    const r = await remote(currentHost(), sh('[ -f "$1" ] || exit 3; cat -- "$1"', p), { maxBytes: 64 * 1024 * 1024 })
    if (r.code === 3) throw notFound(p)
    if (r.code !== 0) throw new HostError(r.killedFor || r.err || `could not read ${p}`)
    return encoding ? r.out.toString(encoding) : r.out
  },
  /**
   * Write a file, never through a symlink: a repository can commit Git.control or .gitignore as a link,
   * and following it would overwrite a file outside the working tree.
   */
  async write(p, data) {
    if (!currentHost()) {
      try {
        return fs.writeFileSync(p, data, { flag: NO_FOLLOW_WRITE })
      } catch (e) {
        if (e.code === 'ELOOP' || (e.code === 'EEXIST' && fs.lstatSync(p).isSymbolicLink())) throw symlinkRefused(p)
        throw e
      }
    }
    const r = await remote(currentHost(), sh('[ -L "$1" ] && exit 4; cat > "$1"', p), { input: data })
    if (r.code === 4) throw symlinkRefused(p)
    if (r.code !== 0) throw new HostError(r.killedFor || String(r.err || '').trim() || `could not write ${p}`)
  },
  async mkdirp(p) {
    if (!currentHost()) return void fs.mkdirSync(p, { recursive: true })
    await remoteOk(sh('mkdir -p -- "$1"', p))
  },
  async rm(p, { recursive = false } = {}) {
    if (!currentHost()) return fs.rmSync(p, { recursive, force: true })
    await remoteOk(sh(recursive ? 'rm -rf -- "$1"' : 'rm -f -- "$1"', p))
  },
  /** The real path, symlinks resolved; for a path that does not exist yet, of its nearest existing folder. */
  async realpath(p) {
    if (!currentHost()) {
      let dir = p
      const rest = []
      while (!fs.existsSync(dir)) {
        rest.unshift(path.basename(dir))
        const up = path.dirname(dir)
        if (up === dir) break
        dir = up
      }
      return path.join(fs.realpathSync(dir), ...rest)
    }
    const script = [
      'p=$1; rest=',
      'while [ ! -e "$p" ] && [ ! -L "$p" ]; do rest="/${p##*/}$rest"; p=${p%/*}; [ -n "$p" ] || p=/; done',
      'r=$(readlink -f -- "$p" 2>/dev/null || realpath -- "$p" 2>/dev/null) || r=',
      '[ -n "$r" ] || { [ -d "$p" ] && r=$(cd -P -- "$p" && pwd -P); }',
      '[ -n "$r" ] || r=$p',
      'printf "%s%s" "${r%/}" "$rest"'
    ].join('\n')
    const out = (await remoteOk(sh(script, p))).toString('utf8')
    return out || '/'
  },
  /** A new private folder in the temp folder. */
  async mkdtemp(prefix) {
    if (!currentHost()) return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    return (await remoteOk(sh('mktemp -d "${TMPDIR:-/tmp}/$1XXXXXX"', prefix))).toString('utf8').trim()
  }
}

// ---------- finding repositories on a host ----------

/** Folders skipped while looking for repositories: dependencies, caches and hidden folders. */
const SKIP = ['node_modules', 'vendor', 'venv', '__pycache__', 'site-packages', 'Library', 'snap']

/**
 * The Git repositories (main folders and linked worktrees) under `roots` on the current host, at most
 * `depth` levels down. "~" and "~/…" are the remote home. Dependency and hidden folders are skipped.
 */
export async function findRepos(roots, depth = 4) {
  const host = currentHost()
  if (!host) throw new HostError('findRepos runs on a remote host')
  const prune = SKIP.map((n) => `-name ${shq(n)}`).join(' -o ')
  const script = [
    'd=$1; shift',
    'for root in "$@"; do',
    '  case $root in "~") root=$HOME ;; "~/"*) root=$HOME/${root#"~/"} ;; esac',
    '  [ -d "$root" ] || continue',
    '  find "$root" -maxdepth "$d" \\( ! -path "$root" \\( ' + prune + " -o \\( -name '.*' ! -name .git \\) \\) \\) -prune -o -name .git -print -prune 2>/dev/null",
    'done | head -n 2000',
    'exit 0'
  ].join('\n')
  const r = await remote(host, sh(script, String(Math.max(1, Math.min(8, +depth || 4))), ...roots), { timeout: 60_000 })
  if (r.code !== 0) throw new HostError(r.killedFor || r.err || `could not list repositories (exit ${r.code})`)
  const dirs = new Set()
  for (const line of r.out.toString('utf8').split('\n')) if (line.endsWith('/.git')) dirs.add(line.slice(0, -5))
  return [...dirs].sort()
}
