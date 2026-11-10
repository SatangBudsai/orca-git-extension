// Notifications from the status bar poll: node tests/notify.mjs
// A fake GitLab; one repository open in Orca. The first poll only learns what is there. Then: a new MR
// in that repository by someone else, my MR's pipeline finishing (failed), and my other MR merged,
// each notify once; nothing notifies twice. No request is made for notifications beyond the poll.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const W = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'gitx-notify-'))
process.env.GIT_CONFIG_GLOBAL = path.join(W, 'global.gitconfig')
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = T\n\temail = t@e\n[credential]\n\thelper = "!f() { echo username=u; echo password=TESTTOKEN; }; f"\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GITX_NO_BROWSER = '1'
process.env.GITX_API_KIND = 'gitlab'
process.env.GITX_REVIEWS_POLL = '700'
process.env.PATH = process.env.PATH.split(path.delimiter).filter((d) => !['gh.exe', 'glab.exe', 'gh', 'glab'].some((b) => fs.existsSync(path.join(d, b)))).join(path.delimiter)

const mr = (iid, author, extra = {}) => ({ iid, project_id: 5, title: `MR ${iid}`, author: { username: author }, state: 'opened', web_url: `http://x/group/proj/-/merge_requests/${iid}`, references: { full: `group/proj!${iid}` }, source_branch: 's' + iid, target_branch: 'main', updated_at: new Date().toISOString(), reviewers: [], assignees: [], head_pipeline: { status: 'running' }, ...extra })
const db = { 1: mr(1, 'me'), 2: mr(2, 'me', { head_pipeline: { status: 'success' } }) }
let requests = 0
const server = http.createServer((rq, rs) => {
  requests++
  const send = (code, obj, headers = {}) => (rs.writeHead(code, { 'Content-Type': 'application/json', ...headers }), rs.end(JSON.stringify(obj)))
  const u = new URL(rq.url, 'http://x')
  const p = u.pathname.replace(/^\/api\/v4/, '')
  if (p === '/user') return send(200, { username: 'me' })
  const list = (state) => Object.values(db).filter((m) => m.state === state)
  if (/\/merge_requests$/.test(p)) {
    const state = u.searchParams.get('state') || 'opened'
    let l = list(state)
    if (u.searchParams.get('author_username')) l = l.filter((m) => m.author.username === u.searchParams.get('author_username'))
    else if (u.searchParams.get('reviewer_username') || u.searchParams.get('assignee_username')) l = []
    return send(200, l, { 'x-total': String(l.length) })
  }
  let m = p.match(/^\/projects\/\d+\/merge_requests\/(\d+)$/)
  if (m && db[m[1]]) return send(200, { ...db[m[1]], merged_at: db[m[1]].merged_at || null })
  if (/\/approvals$/.test(p)) return send(200, { approvals_required: 0, approved_by: [], user_has_approved: false })
  if (/^\/projects\/\d+$/.test(p)) return send(200, { id: 5, permissions: { project_access: { access_level: 30 } } })
  if (/protected_branches/.test(p)) return send(200, [])
  send(404, { message: 'no route ' + p })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
process.env.GITX_API_BASE = `http://127.0.0.1:${port}/api/v4`

const repo = path.join(W, 'proj')
execFileSync('git', ['init', '-q', repo])
execFileSync('git', ['remote', 'add', 'origin', `http://127.0.0.1:${port}/group/proj.git`], { cwd: repo })

let wsAsks = 0
const notes = []
const bar = []
const orca = {
  panels: { handle() {}, post() {} },
  host: {
    has: (n) => ['statusBar.update', 'notifications.show', 'workspace.list'].includes(n),
    call: async (n, a) => {
      // like Orca: a status bar tooltip over 256 characters is refused
      if (n === 'statusBar.update' && a.tooltip && a.tooltip.length > 256) throw new Error('tooltip: Too big: expected string to have <=256 characters')
      if (n === 'notifications.show') notes.push(a)
      if (n === 'statusBar.update' && a.id === 'reviews') bar.push(a.text)
      // right after the plugin starts Orca may not answer yet: the first ask fails, which must not be kept
      if (n === 'workspace.list' && wsAsks++ === 0) throw new Error('plugin is not enabled with current consent')
      if (n === 'workspace.list') return { workspaces: [{ id: 'w', kind: 'folder', name: 'proj', path: repo, hostId: 'local' }] }
      if (n === 'workspace.readContext') throw new Error('none')
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
const ok = (c, n, x = '') => (c || fails++, console.log(`${c ? 'PASS' : 'FAIL'} notify ${n}${!c && x ? ' :: ' + x : ''}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
  await sleep(2500) // the first polls learn what is there
  ok(notes.length === 0, 'nothing on the first poll', JSON.stringify(notes))
  ok(bar.at(-1) === 'MR/PR 2', 'the status bar counts every open one (mine too), not only those for me', JSON.stringify(bar))
  db[3] = mr(3, 'ann', { head_pipeline: { status: 'success' } }) // new, by someone else, in a repo open in Orca
  db[1].head_pipeline = { status: 'failed' } // my MR's pipeline finished
  db[2].state = 'merged' // my other MR merged
  db[2].merged_at = new Date().toISOString()
  await sleep(2500)
  const titles = notes.map((n) => n.title)
  ok(titles.some((t) => /^New merge request/.test(t)) && notes.some((n) => /!3/.test(n.body)), 'a new MR in a repo open in Orca', JSON.stringify(notes))
  ok(titles.includes('Pipeline failed') && notes.some((n) => n.title === 'Pipeline failed' && /!1/.test(n.body)), "my MR's pipeline failed", JSON.stringify(notes))
  ok(titles.includes('Merged') && notes.some((n) => n.title === 'Merged' && /!2/.test(n.body)), 'my MR merged', JSON.stringify(notes))
  const n1 = notes.length
  await sleep(2000)
  ok(notes.length === n1, 'nothing twice', JSON.stringify(notes.slice(n1)))
} catch (e) {
  fails++
  console.log('CRASH', e.stack)
}
console.log(`notify: ${fails ? fails + ' failed' : 'all passed'}`)
server.close()
try {
  fs.rmSync(W, { recursive: true, force: true })
} catch {}
process.exit(fails ? 1 : 0)
