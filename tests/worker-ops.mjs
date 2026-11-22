import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')))
const W = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'gitx-ops-'))
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })
const gcfg = path.join(W, 'global.gitconfig')
fs.writeFileSync(gcfg, `[user]\n\tname = T\n\temail = t@e\n[init]\n\tdefaultBranch = main\n`)
process.env.GIT_CONFIG_GLOBAL = gcfg
process.env.GIT_CONFIG_NOSYSTEM = '1'
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
let fails = 0
const ok = (c, n, x = '') => (c || fails++, console.log(`${c ? 'PASS' : 'FAIL'} ${n}${!c && x ? ' :: ' + x : ''}`))
const handlers = {}
const orca = { panels: { handle: (n, f) => (handlers[n] = f), post() {} }, host: { has: () => false, call: async () => ({}) }, commands: { register() {} }, events: { on() {} }, log() {} }
;(await import(pathToFileURL(path.resolve(ROOT, '../worker/main.mjs')).href)).default(orca)
const repo = path.join(W, 'repo')
const op = (o, args = {}) => handlers.git({ op: o, repo, args })
const write = (f, t) => fs.writeFileSync(path.join(repo, f), t)
const commit = (f, t, m) => (write(f, t), g(repo, 'add', '.'), g(repo, 'commit', '-m', m))
g(W, 'init', repo)
commit('a.txt', '1\n', 'one')
commit('a.txt', '2\n', 'two')
try {
  // undo commit → soft
  let u = await op('undoInfo')
  ok(u.mode === 'soft' && /staged/.test(u.description), 'undo commit info', JSON.stringify(u))
  await op('undoLast')
  ok(g(repo, 'log', '-1', '--format=%s') === 'one' && g(repo, 'diff', '--cached', '--name-only') === 'a.txt', 'undo commit')
  g(repo, 'commit', '-m', 'two')
  // checkout → switch back
  g(repo, 'switch', '-c', 'side')
  u = await op('undoInfo')
  ok(u.mode === 'switch' && u.switchTo === 'main', 'undo checkout info', JSON.stringify(u))
  await op('undoLast')
  ok(g(repo, 'branch', '--show-current') === 'main', 'undo checkout switches back')
  // rebase → pre-rebase position
  g(repo, 'switch', 'side')
  commit('s.txt', 's\n', 'side work')
  const pre = g(repo, 'rev-parse', 'HEAD')
  g(repo, 'switch', 'main')
  commit('m.txt', 'm\n', 'main work')
  g(repo, 'switch', 'side')
  g(repo, 'rebase', 'main')
  u = await op('undoInfo')
  ok(u.mode === 'keep' && u.to === pre, 'undo rebase info', JSON.stringify(u))
  await op('undoLast')
  ok(g(repo, 'rev-parse', 'HEAD') === pre, 'undo rebase')
  // not undoable
  g(repo, 'cherry-pick', 'main')
  u = await op('undoInfo')
  ok(!!u.blocked, 'cherry-pick blocked', JSON.stringify(u))
  // checkout discard+clean: failed switch must not clean
  write('untracked.txt', 'x')
  await op('checkout', { ref: 'nope', discard: true, clean: true }).catch(() => {})
  ok(fs.existsSync(path.join(repo, 'untracked.txt')), 'failed switch keeps untracked files')
  await op('checkout', { ref: 'main', discard: true, clean: true })
  ok(!fs.existsSync(path.join(repo, 'untracked.txt')), 'successful switch cleans')
  // stash restore on failed switch
  write('a.txt', 'dirty\n')
  const e = await op('checkout', { ref: 'nope', stash: true }).then(() => null, (x) => x)
  ok(e && fs.readFileSync(path.join(repo, 'a.txt'), 'utf8') === 'dirty\n' && !g(repo, 'stash', 'list'), 'stash restored after failed switch', e?.message)
  g(repo, 'checkout', '--', 'a.txt')
  // squashSince failure restores HEAD
  const head = g(repo, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n')
  const se = await op('squashSince', { base: g(repo, 'rev-parse', 'HEAD~2'), message: 'sq' }).then(() => null, (x) => x)
  ok(se && g(repo, 'rev-parse', 'HEAD') === head, 'squash failure restores HEAD', se?.message)
  fs.rmSync(path.join(repo, '.git', 'hooks', 'pre-commit'))
  // commit+push failure (no remote)
  write('c.txt', 'c')
  g(repo, 'add', '.')
  const cp = await op('commit', { message: 'c', push: true })
  ok(cp.committed && cp.pushError, 'commit ok, push error returned', JSON.stringify(cp))
  // ignore newline rejected
  ok(await op('ignore', { pattern: 'a\nb' }).then(() => false, () => true), 'ignore rejects newline')
  // worktree remove: force without forceBranch keeps unmerged branch
  const wt = path.join(W, 'wt')
  g(repo, 'worktree', 'add', '-b', 'wtb', wt)
  fs.writeFileSync(path.join(wt, 'w.txt'), 'w')
  g(wt, 'add', '.')
  g(wt, 'commit', '-m', 'unmerged')
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'd')
  const wr = await op('worktreeRemove', { path: wt, force: true, deleteBranch: true })
  ok(wr.removed && wr.branchKept && g(repo, 'branch', '--list', 'wtb'), 'force keeps unmerged branch, reports branchKept', JSON.stringify(wr))
  g(repo, 'worktree', 'add', wt, 'wtb')
  const wr2 = await op('worktreeRemove', { path: wt, force: true, deleteBranch: true, forceBranch: true })
  ok(wr2.branchDeleted === 'wtb' && !g(repo, 'branch', '--list', 'wtb'), 'forceBranch deletes', JSON.stringify(wr2))
  // workPath escape
  ok(await op('readWorkFile', { file: '../global.gitconfig' }).then(() => false, () => true), 'readWorkFile outside rejected')
  try {
    fs.symlinkSync(W, path.join(repo, 'link'), 'junction')
    ok(await op('readWorkFile', { file: 'link/global.gitconfig' }).then(() => false, () => true), 'symlink escape rejected')
  } catch (x) {
    console.log('SKIP symlink', x.message)
  }
  await op('writeWorkFile', { file: 'sub/new.txt', text: 'n', stage: true }).catch((x) => ok(false, 'write new file', x.message))
  ok(g(repo, 'diff', '--cached', '--name-only').includes('sub/new.txt'), 'writeWorkFile stages new file in new dir')
  // push validation
  ok(await op('push', { remote: '--upload-pack=x' }).then(() => false, (x) => /may not start/.test(x.message)), 'push rejects option-like remote')
  // rebase interactive temp dir (start clean: the writeWorkFile case above staged a file)
  g(repo, 'reset', '-q', '--hard'); g(repo, 'clean', '-fdq')
  const before = fs.readdirSync(process.env.TEMP || '/tmp').filter((f) => f.startsWith('orca-git-rebase-')).length
  const todo = g(repo, 'log', '--reverse', '--format=%H', 'HEAD~2..HEAD').split('\n').map((hash) => ({ action: 'pick', hash }))
  await op('rebaseInteractive', { base: 'HEAD~2', todo })
  const after = fs.readdirSync(process.env.TEMP || '/tmp').filter((f) => f.startsWith('orca-git-rebase-')).length
  ok(after === before, 'rebase temp dir cleaned')
  // many tags (issue #8): refs over Orca's 1 MiB answer limit come in parts that join back losslessly
  const tip = g(repo, 'rev-parse', 'HEAD')
  const N = 22000
  const lines = Array.from({ length: N }, (_, i) => `create refs/tags/release/v${i}-ทดสอบ-${'x'.repeat(40)} ${tip}`).join('\n') + '\n'
  execFileSync('git', ['update-ref', '--stdin'], { cwd: repo, input: lines })
  const first = await op('refs')
  ok(first?.__parts?.count > 1 && JSON.stringify(first).length < 960 * 1024, 'big refs answer split in parts', JSON.stringify(first?.__parts))
  let joined = first.part
  for (let index = 1; index < first.__parts.count; index++) {
    const p = await handlers['answer.part']({ id: first.__parts.id, index })
    ok(Buffer.byteLength(JSON.stringify(p)) <= 960 * 1024, `part ${index} under the limit`)
    joined += p.part
  }
  const all = JSON.parse(joined)
  ok(all.tags.length === N && all.local.some((b) => b.current), 'every tag arrives', all.tags.length)
  ok(await Promise.resolve().then(() => handlers['answer.part']({ id: first.__parts.id, index: 1 })).then(() => false, () => true), 'parts are dropped once fetched')
} catch (x) {
  fails++
  console.log('CRASH', x.stack)
}
console.log(fails ? `${fails} failed` : 'all passed')
process.exit(fails ? 1 : 0)
