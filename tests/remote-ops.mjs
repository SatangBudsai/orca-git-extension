// Git Control on an SSH host, end to end through the worker: every request names its repository by a
// locator (ssh://<host>/<path>) and git and file access must happen "there". A stand-in for ssh runs
// the remote command line with sh on this machine, so quoting, the remote file helpers and the
// routing are all exercised without a server. Run: node tests/remote-ops.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// the stand-in ssh below is a shell script, so this suite needs a POSIX shell
if (process.platform === 'win32') {
  console.log('remote-ops: skipped on Windows (the stand-in ssh is a shell script)')
  process.exit(0)
}

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-remote-'))
const gcfg = path.join(W, 'global.gitconfig')
fs.writeFileSync(gcfg, `[user]\n\tname = T\n\temail = t@e\n[init]\n\tdefaultBranch = main\n`)
process.env.GIT_CONFIG_GLOBAL = gcfg
process.env.GIT_CONFIG_NOSYSTEM = '1'

// the stand-in ssh: skips options, refuses "down-host", logs the destination, runs the command line
const fakeSsh = path.join(W, 'fake-ssh')
const sshLog = path.join(W, 'ssh.log')
fs.writeFileSync(
  fakeSsh,
  `#!/bin/sh
# ssh -G: where a name goes (office-alias is the ~/.ssh/config alias of 127.0.0.9)
if [ "$1" = -G ]; then
  case "$2" in
    office-alias) printf 'hostname 127.0.0.9\nport 22\nuser frank\n' ;;
    wrong-port) printf 'hostname 127.0.0.9\nport 2222\nuser frank\n' ;;
    *) printf 'hostname %s\nport 22\nuser me\n' "$2" ;;
  esac
  exit 0
fi
while [ $# -gt 0 ]; do case "$1" in -o) shift 2;; --) shift;; -*) shift;; *) break;; esac; done
dest=$1; shift
export HOME='${path.join(W, 'home')}'
echo "$dest" >> '${sshLog}'
[ "$dest" = down-host ] && { echo "ssh: connect to host down-host port 22: Connection refused" >&2; exit 255; }
exec "\${FAKE_LOGIN_SHELL:-sh}" -c "$*"
`,
  { mode: 0o755 }
)
process.env.GIT_CONTROL_SSH = fakeSsh
process.env.GIT_CONTROL_SSH_NO_MUX = '1'
// Orca's CLI: its SSH hosts (one of them Orca's own VM, which is not a server of the person's)
const fakeOrca = path.join(W, 'fake-orca')
fs.writeFileSync(
  fakeOrca,
  `#!/bin/sh
[ "$1 $2" = "host list" ] || exit 1
echo '{"ok":true,"result":{"hosts":[{"kind":"local","name":"this machine","id":"local"},{"kind":"ssh","name":"office-orca","id":"tgt-9"},{"kind":"ssh","name":"127.0.0.9","id":"tgt-ip"},{"kind":"ssh","name":"vm","id":"runtime-ssh-1"}]}}'
`,
  { mode: 0o755 }
)
process.env.GIT_CONTROL_ORCA_BIN = fakeOrca
// the server's home folder, with a project 3 levels down
fs.mkdirSync(path.join(W, 'home', 'github', 'team', 'proj'), { recursive: true })
execFileSync('git', ['init', '-q', path.join(W, 'home', 'github', 'team', 'proj')])
// ~/.ssh/config: the alias that logs in to 127.0.0.9 sits in an Included file, after one with another port
fs.mkdirSync(path.join(W, 'conf.d'))
fs.writeFileSync(path.join(W, 'conf.d', 'office'), 'Host wrong-port\n  HostName 127.0.0.9\n  Port 2222\nHost office-alias\n  HostName 127.0.0.9\n  User frank\n')
fs.writeFileSync(path.join(W, 'ssh_config'), `Host *.example other-*\n  User x\n# comment\nInclude ${path.join(W, 'conf.d')}/*\n`)
process.env.GIT_CONTROL_SSH_CONFIG = path.join(W, 'ssh_config')

const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
let fails = 0
const ok = (c, n, x = '') => (c || fails++, console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && x ? ' :: ' + x : ''}`))

// a repository "on the host", with a name that needs quoting
const repo = path.join(W, "it's a repo $HOME")
const write = (f, t) => (fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t))
const commit = (f, t, m) => (write(f, t), g(repo, 'add', '.'), g(repo, 'commit', '-m', m))
fs.mkdirSync(repo)
g(repo, 'init')
commit('a.txt', '1\n', 'one')
commit('a.txt', '2\n', 'two')

const HOST = 'tgt-1' // the Orca SSH target id
const loc = (p) => `ssh://${HOST}${p}`
const R = loc(repo)

const opened = []
const storage = new Map()
const handlers = {}
const orca = {
  panels: { handle: (n, f) => (handlers[n] = f), post() {} },
  host: {
    has: (m) => ['workspace.list', 'settings.get', 'editor.open', 'workspace.readContext', 'storage.get', 'storage.set'].includes(m),
    call: async (m, p) => {
      if (m === 'storage.get') return { value: storage.has(p.key) ? JSON.parse(storage.get(p.key)) : null }
      if (m === 'storage.set') return storage.set(p.key, JSON.stringify(p.value)), { ok: true }
      if (m === 'workspace.list')
        return {
          workspaces: [
            { id: 'ws-remote', kind: 'folder', name: 'remote', path: repo, branch: 'main', hostId: `ssh:${encodeURIComponent(HOST)}` },
            { id: 'ws-runtime', kind: 'folder', name: 'paired', path: '/elsewhere', branch: null, hostId: 'runtime:abc' }
          ],
          truncated: false
        }
      if (m === 'settings.get') return { settings: {} }
      if (m === 'editor.open') return opened.push(p), { opened: true }
      if (m === 'workspace.readContext') return null
      return {}
    }
  },
  commands: { register() {} },
  events: { on() {} },
  log() {}
}
;(await import(pathToFileURL(path.resolve(ROOT, '../worker/main.mjs')).href)).default(orca)
const op = (o, args = {}, r = R) => handlers.git({ op: o, repo: r, args })
const dests = () => fs.readFileSync(sshLog, 'utf8').split('\n').filter(Boolean)

try {
  // workspaces: the SSH one is listed by locator, the paired-runtime one is not
  const { workspaces } = await handlers['repo.resolve']({})
  ok(workspaces.length === 1 && workspaces[0].path === R && workspaces[0].host === HOST, 'remote workspace listed by locator', JSON.stringify(workspaces))
  ok(workspaces[0].repoName === path.basename(repo), 'remote workspace repo name read over ssh', workspaces[0].repoName)
  ok(dests().every((d) => d === HOST), 'ssh reaches the host by the name Orca shows', dests().join(','))

  // status
  write('new file "q".txt', 'x\n')
  const st = await op('status')
  ok(st.toplevel === R, 'status toplevel is a locator', st.toplevel)
  ok(st.branch === 'main' && st.files.some((f) => f.path === 'new file "q".txt' && f.untracked), 'status over ssh', JSON.stringify(st.files))

  // stage + commit with an awkward message
  await op('stage', { files: ['new file "q".txt'] })
  await op('commit', { message: `it's "quoted" $HOME \`x\`` }).catch(async () => g(repo, 'commit', '-m', `it's "quoted" $HOME \`x\``))
  ok(g(repo, 'log', '-1', '--format=%s') === `it's "quoted" $HOME \`x\``, 'commit message passes the remote shell untouched', g(repo, 'log', '-1', '--format=%s'))

  // log and diff
  const log = await op('log', { limit: 10 })
  const commits = log.commits || log
  ok(Array.isArray(commits) && commits.length === 3, 'log over ssh', JSON.stringify(log).slice(0, 200))
  write('a.txt', '3\n')
  ok(/\+3/.test(await op('diff', { file: 'a.txt' })), 'diff over ssh')
  g(repo, 'checkout', '--', 'a.txt')

  // working-tree files: read, write (new folder) + stage, and the outside-the-repo guard
  await op('writeWorkFile', { file: 'dir one/b.txt', text: 'hello\n', stage: true })
  ok(fs.readFileSync(path.join(repo, 'dir one/b.txt'), 'utf8') === 'hello\n' && /dir one\/b.txt/.test(g(repo, 'diff', '--cached', '--name-only')), 'writeWorkFile on the host, staged')
  ok((await op('readWorkFile', { file: 'dir one/b.txt' })) === 'hello\n', 'readWorkFile on the host')
  const outside = await op('readWorkFile', { file: '../outside.txt' }).then(() => null, (e) => e)
  ok(outside && /outside the repository/.test(outside.message), 'outside path rejected on the host', outside?.message)
  fs.writeFileSync(path.join(W, 'secret.txt'), 's')
  fs.symlinkSync(path.join(W, 'secret.txt'), path.join(repo, 'link.txt'))
  const viaLink = await op('readWorkFile', { file: 'link.txt' }).then(() => null, (e) => e)
  ok(viaLink && /outside the repository/.test(viaLink.message), 'symlink escape rejected on the host', viaLink?.message)
  fs.rmSync(path.join(repo, 'link.txt'))
  g(repo, 'commit', '-qm', 'b')

  // a merge conflict: state, sides, conflict text through a temp folder on the host
  g(repo, 'switch', '-qc', 'side')
  commit('a.txt', 'side\n', 'side change')
  g(repo, 'switch', '-q', 'main')
  commit('a.txt', 'main\n', 'main change')
  try {
    g(repo, 'merge', 'side')
  } catch {}
  const cst = await op('status')
  ok(cst.state === 'merge' && cst.sides?.incoming === 'side', 'merge state and sides read from the host', JSON.stringify({ state: cst.state, sides: cst.sides }))
  const ct = await op('conflictText', { file: 'a.txt' })
  ok(/<<<<<<< current[\s\S]*main[\s\S]*>>>>>>> incoming/.test(ct.text) && ct.hasBase, 'conflictText via temp files on the host', ct.text)
  g(repo, 'merge', '--abort')

  // interactive rebase: reword through the host's sh (no Node there)
  const base = g(repo, 'rev-parse', 'HEAD~2')
  const todo = await op('rebaseTodo', { base })
  await op('rebaseInteractive', { base, todo: todo.map((t, i) => (i === 0 ? { ...t, action: 'reword', message: 'reworded "on" host' } : { ...t, action: 'pick' })) })
  ok(g(repo, 'log', '-2', '--format=%s').split('\n').includes('reworded "on" host'), 'interactive rebase reword on the host', g(repo, 'log', '-3', '--format=%s'))

  // worktrees: listed and added by locator
  await op('worktreeAdd', { path: loc(path.join(W, 'wt two')), newBranch: 'wt-b' })
  const wts = await op('worktrees')
  ok(wts.length === 2 && wts.every((w) => w.path.startsWith(`ssh://${HOST}/`)), 'worktrees listed by locator', JSON.stringify(wts.map((w) => w.path)))
  const wst = await op('status', {}, loc(path.join(W, 'wt two')))
  ok(wst.branch === 'wt-b', 'a worktree locator works as a repository', wst.branch)

  // the Git Control tab and file opening go through editor.open with a workspace-relative path
  await handlers['tab.open']({ repo: R })
  const tabFile = JSON.parse(fs.readFileSync(path.join(repo, 'Git.control'), 'utf8'))
  ok(tabFile.repo === R, 'tab file names the repository by locator', JSON.stringify(tabFile))
  ok(opened.at(-1)?.workspaceId === 'ws-remote' && opened.at(-1)?.path === 'Git.control', 'tab opened in the remote workspace', JSON.stringify(opened))
  ok(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8').includes('Git.control'), 'tab file ignored on the host')
  await handlers['file.open']({ repo: R, file: 'dir one/b.txt' })
  ok(opened.at(-1)?.path === 'dir one/b.txt', 'file opened by workspace-relative path', JSON.stringify(opened.at(-1)))

  // Git.control and .gitignore committed as symlinks: never written through (the file they point to stays)
  const linkGuard = async (dir, r, where) => {
    const victim = path.join(W, `victim-${where}`)
    fs.writeFileSync(victim, 'keep\n')
    for (const f of ['Git.control', '.gitignore']) fs.rmSync(path.join(dir, f), { force: true }), fs.symlinkSync(victim, path.join(dir, f))
    const tabErr = await handlers['tab.open']({ repo: r }).then(() => null, (e) => e)
    ok(tabErr && fs.readFileSync(victim, 'utf8') === 'keep\n', `Git.control symlink not written through (${where})`, tabErr?.message)
    const ignErr = await op('ignore', { pattern: '*.log' }, r).then(() => null, (e) => e)
    ok(ignErr && /symbolic link/.test(ignErr.message) && fs.readFileSync(victim, 'utf8') === 'keep\n', `.gitignore symlink not written through (${where})`, ignErr?.message)
    for (const f of ['Git.control', '.gitignore']) fs.rmSync(path.join(dir, f), { force: true })
  }
  await linkGuard(repo, R, 'on the host')

  // repo.check gives a locator back
  const chk = await handlers['repo.check']({ path: R })
  ok(chk.ok && chk.toplevel === R, 'repo.check answers with a locator', JSON.stringify(chk))

  // an unreachable host: a clear error, and quickly the second time
  const down = `ssh://down-host${repo}`
  const e1 = await op('status', {}, down).then(() => null, (e) => e)
  ok(e1 && /Could not reach down-host over SSH/.test(e1.message) && /To fix it:\n1\. .*ssh -o BatchMode=yes down-host/.test(e1.message), 'unreachable host explains, step by step, what to do', e1?.message)
  const before = dests().filter((d) => d === 'down-host').length
  const e2 = await op('status', {}, down).then(() => null, (e) => e)
  ok(e2 && dests().filter((d) => d === 'down-host').length === before, 'unreachable host fails fast without dialing again')

  // a host Orca shows by its address reaches it through the ~/.ssh/config alias for that address
  const n0 = dests().length
  const byIp = await op('status', {}, `ssh://127.0.0.9${repo}`)
  const used = dests().slice(n0).filter((d) => d !== '127.0.0.9')
  ok(byIp.toplevel === `ssh://127.0.0.9${repo}` && used.length && used.every((d) => d === 'office-alias'), 'address resolved to its ~/.ssh/config alias (Include, port checked)', dests().slice(n0).join(','))

  // Orca's SSH hosts are servers without being added: their home folder is searched
  const auto = await handlers['servers.repos']({ refresh: true })
  const orcaSrv = auto.servers.find((x) => x.id === 'tgt-9')
  ok(orcaSrv && orcaSrv.source === 'orca' && orcaSrv.label === 'office-orca' && !auto.servers.some((x) => x.id === 'runtime-ssh-1'), "Orca's SSH hosts listed as servers (its own VMs not)", JSON.stringify(auto.servers))
  ok(auto.repos.some((r) => r.path === `ssh://tgt-9${path.join(W, 'home', 'github', 'team', 'proj')}` && r.hostLabel === 'office-orca'), 'their projects found under ~ without any setup', JSON.stringify(auto.repos.map((r) => r.path)))
  const noRemove = await handlers['servers.remove']({ id: 'tgt-9' }).then(() => null, (e) => e)
  ok(noRemove && /remove it in Orca/.test(noRemove.message) && (await handlers['servers.list']({})).find((x) => x.id === 'tgt-9')?.repoCount === 1, 'an Orca host cannot be removed here, only hidden', noRemove?.message)
  const byAddr = auto.servers.find((x) => x.id === 'tgt-ip')
  ok(byAddr?.label === 'office-alias' && byAddr.orcaName === '127.0.0.9', 'a server Orca names by address is shown by its ~/.ssh/config alias', JSON.stringify(byAddr))
  ok(auto.repos.filter((r) => r.host === 'tgt-ip').every((r) => r.hostLabel === 'office-alias') && auto.repos.some((r) => r.host === 'tgt-ip'), 'its projects are marked with the alias too')
  ok(auto.servers.find((x) => x.id === 'tgt-9')?.orcaName === null, 'a server Orca names by alias keeps that name')
  await handlers['servers.update']({ id: 'tgt-9', hidden: true })
  await handlers['servers.update']({ id: 'tgt-ip', hidden: true })

  // servers: add one, its projects are found (main folders and worktrees, odd names too), hide, remove
  fs.mkdirSync(path.join(W, 'deps', 'node_modules', 'pkg'), { recursive: true })
  g(path.join(W, 'deps', 'node_modules', 'pkg'), 'init', '-q') // inside node_modules: skipped
  fs.mkdirSync(path.join(W, '.hidden', 'r'), { recursive: true })
  g(path.join(W, '.hidden', 'r'), 'init', '-q') // in a hidden folder: skipped
  const added = await handlers['servers.add']({ dest: 'office-alias', roots: W })
  ok(added.id === 'office-alias' && !added.error && added.repoCount === 2, 'server added and searched', JSON.stringify(added))
  const choices = await handlers['servers.sshAliases']({})
  const ch = Object.fromEntries(choices.map((c) => [c.name, c]))
  ok(ch['office-alias']?.detail === 'frank@127.0.0.9' && ch['office-alias'].added && ch['wrong-port']?.detail === 'frank@127.0.0.9:2222' && !ch['wrong-port'].added, 'add-server suggestions show where each host connects and which are added', JSON.stringify(choices))
  const found = await handlers['servers.repos']({})
  const paths = found.repos.map((r) => r.path).sort()
  const want = [repo, path.join(W, 'wt two')].map((p) => `ssh://office-alias${p}`).sort()
  ok(JSON.stringify(paths) === JSON.stringify(want), 'projects found on the server by locator (dependencies and hidden folders skipped)', JSON.stringify(paths))
  ok(found.repos.every((r) => r.hostLabel === 'office-alias' && r.repoName), 'server projects carry the server name')
  const srv = found.servers.find((x) => x.id === 'office-alias')
  ok(srv && srv.source === 'manual' && srv.repoCount === 2 && !srv.error && srv.roots[0] === W, 'server listed with its folders and count', JSON.stringify(srv))
  const viaServer = await op('status', {}, found.repos.find((r) => r.path.endsWith(repo)).path)
  ok(viaServer.branch === 'main', 'a found project opens like any repository')

  // Repo Overview: the servers' projects too, under their server, each read where it is
  const ov = await handlers['repos.overview']({})
  const sr = ov.repos.find((r) => r.path === `ssh://office-alias${repo}`)
  ok(sr && sr.host === 'office-alias' && sr.source === 'server' && sr.group?.server && sr.group.name === 'office-alias' && sr.branch === 'main' && !sr.error && ov.servers, "Repo Overview lists a server's projects, grouped under the server", JSON.stringify(sr))
  const twin = ov.repos.filter((r) => r.path.toLowerCase() === `ssh://office-alias${repo}`.toLowerCase())
  ok(twin.length === 1, 'listed once', JSON.stringify(twin.map((r) => r.path)))
  // tags on a server repo and a local one in one go
  const localTag = path.join(W, '.local-tag') // hidden: not one of the server's projects
  g(W, 'init', '-q', localTag)
  g(localTag, 'commit', '-q', '--allow-empty', '-m', 'x')
  for (const d of [localTag, repo]) g(d, 'tag', 'v1.0.0', 'HEAD~0')
  g(repo, 'commit', '-q', '--allow-empty', '-m', 'after tag')
  g(localTag, 'commit', '-q', '--allow-empty', '-m', 'after tag')
  const tagRepos = [`ssh://office-alias${repo}`, localTag]
  const pats = await handlers['repos.tagPatterns']({ repos: tagRepos })
  ok(pats[0]?.pattern === 'v*' && pats[0].repos === 2, 'tag patterns read on both machines', JSON.stringify(pats))
  const plan = await handlers['repos.tagPlan']({ repos: tagRepos, pattern: 'v*' })
  ok(plan.rows.length === 2 && plan.rows.every((r) => !r.error && r.latest === 'v1.0.0' && r.next === 'v1.0.1') && plan.rows[0].repo === tagRepos[0], 'tags planned for a server repo and a local one together', JSON.stringify(plan.rows))
  const applied = await handlers['repos.tagApply']({ items: plan.rows.map((r) => ({ repo: r.repo, name: r.next, hash: r.hash })), push: false })
  ok(applied.every((a) => a.ok) && applied[0].repo === tagRepos[0] && g(repo, 'tag', '--list', 'v1.0.1') === 'v1.0.1' && g(localTag, 'tag', '--list', 'v1.0.1') === 'v1.0.1', 'each tag made on its own machine', JSON.stringify(applied))
  await handlers['servers.update']({ id: 'office-alias', hidden: true })
  ok((await handlers['servers.repos']({})).repos.length === 0, 'a hidden server lists no projects')
  await handlers['servers.update']({ id: 'office-alias', hidden: false })
  const badRoots = await handlers['servers.update']({ id: 'office-alias', roots: 'relative/dir' }).then(() => null, (e) => e)
  ok(badRoots && /start it with \/ or ~/.test(badRoots.message), 'folders must be absolute or under ~', badRoots?.message)
  const two = (await handlers['servers.update']({ id: 'office-alias', roots: `${W}; ~/elsewhere` })).find((x) => x.id === 'office-alias')
  ok(two?.roots.length === 2 && two.roots[1] === '~/elsewhere', 'folders separated with ; as in Scan folders', JSON.stringify(two?.roots))
  await handlers['servers.update']({ id: 'office-alias', roots: W })
  await handlers['servers.repos']({ refresh: true })
  const dup = await handlers['servers.add']({ dest: '-oProxyCommand=x' }).then(() => null, (e) => e)
  ok(dup && /Not a usable ssh destination/.test(dup.message), 'option-like destination refused', dup?.message)
  const downAdd = await handlers['servers.add']({ dest: 'down-host' }).then(() => null, (e) => e)
  ok(downAdd && /Could not reach down-host/.test(downAdd.message), 'unreachable server is not added', downAdd?.message)
  ok(!(await handlers['servers.list']({})).some((x) => x.id === 'down-host'), 'unreachable server left out of the list')
  // a restart: the last answer is shown at once, from storage
  await new Promise((r) => setTimeout(r, 700)) // saved shortly after a search
  ok(JSON.parse(storage.get('serverScans.v1') || '{}')['office-alias']?.dirs?.length === 2, 'found projects kept for the next start', storage.get('serverScans.v1'))
  await handlers['servers.remove']({ id: 'office-alias' })
  const after = await handlers['servers.repos']({})
  ok(!after.servers.some((x) => x.id === 'office-alias') && !after.repos.length, 'removed server and its projects are gone', JSON.stringify(after))

  // a local repository still runs locally
  const local = path.join(W, 'local')
  g(W, 'init', '-q', local)
  const n = dests().length
  const lst = await op('status', {}, local)
  ok(lst.toplevel === local && dests().length === n, 'local repository untouched by ssh', lst.toplevel)
  g(local, 'commit', '-q', '--allow-empty', '-m', 'init')
  await linkGuard(local, local, 'on this computer')
} catch (e) {
  fails++
  console.log('FAIL (crash)', e.stack)
} finally {
  fs.rmSync(W, { recursive: true, force: true })
}
console.log(fails ? `${fails} failed` : 'all passed')
process.exit(fails ? 1 : 0)
