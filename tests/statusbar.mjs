// Status bar items: node tests/statusbar.mjs
// 1. The Git item stays visible when the focused worktree cannot be told (Orca gives no context).
// 2. A folder workspace holding two repositories: the Repos item counts both, and shows how many
//    need you ("1 of 2 repos").
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')))
process.env.GITX_NO_BROWSER = '1'
const W = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'gitx-bar-'))
process.env.GIT_CONFIG_GLOBAL = path.join(W, 'global.gitconfig')
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = T\n\temail = t@example.test\n')
process.env.GIT_CONFIG_NOSYSTEM = '1'
const repos = ['one', 'two'].map((n) => {
  const d = path.join(W, n)
  fs.mkdirSync(d)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d })
  fs.writeFileSync(path.join(d, 'a.txt'), 'a\n')
  execFileSync('git', ['add', '.'], { cwd: d })
  execFileSync('git', ['commit', '-qm', 'a'], { cwd: d })
  return d
})
fs.writeFileSync(path.join(repos[1], 'a.txt'), 'changed\n') // "two" needs you

const sent = []
const orca = {
  panels: { handle() {}, post() {} },
  host: {
    has: (n) => ['statusBar.update', 'workspace.list'].includes(n),
    call: async (n, a) => {
      // like Orca: a status bar tooltip over 256 characters is refused
      if (n === 'statusBar.update' && a.tooltip && a.tooltip.length > 256) throw new Error('tooltip: Too big: expected string to have <=256 characters')
      if (n === 'statusBar.update') sent.push(a)
      if (n === 'workspace.readContext') throw new Error('no context')
      // one Orca workspace: the plain folder that holds both repositories (ABC with A and B inside)
      if (n === 'workspace.list') return { workspaces: [{ name: 'parent', path: W, kind: 'folder', hostId: 'local' }] }
      return {}
    }
  },
  commands: { register() {} },
  events: { on() {} },
  log() {}
}
const mod = await import(pathToFileURL(path.resolve(ROOT, '../worker/main.mjs')).href)
mod.default(orca)
let fails = 0
const t0 = Date.now()
while ((!sent.some((s) => s.id === 'branch') || !sent.some((s) => s.id === 'repos')) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 100))
const b = sent.find((s) => s.id === 'branch')
const ok1 = !!b && b.visible === true && b.text === 'Git'
console.log(`${ok1 ? 'PASS' : 'FAIL'} statusbar: Git stays visible when the worktree is unknown${ok1 ? '' : ' :: ' + JSON.stringify(b)}`)
const r = sent.filter((s) => s.id === 'repos').pop()
const ok2 = !!r && r.visible === true && r.text === 'Overview 1/2' && /two/.test(r.tooltip)
console.log(`${ok2 ? 'PASS' : 'FAIL'} statusbar: Repos shows "1 of 2 repos" and names the one with changes${ok2 ? '' : ' :: ' + JSON.stringify(r)}`)
fails += !ok1 + !ok2
try {
  fs.rmSync(W, { recursive: true, force: true })
} catch {}
process.exit(fails ? 1 : 0)
