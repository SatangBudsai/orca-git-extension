// Merge queue test against a fake GitLab: node tests/merge-queue.mjs
// Project 42 has !1 and !2 (same target), project 43 has !5. After !1 merges, GitLab first "checks"
// !2, then says it needs a rebase; the queue must rebase it and merge it only after !1. !5 (another
// project) must not wait for project 42. !1 is approved first; nothing is merged twice.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')))
const W = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'gitx-queue-'))
const gcfg = path.join(W, 'global.gitconfig')
fs.writeFileSync(gcfg, `[credential]\n\thelper = "!f() { echo username=u; echo password=TESTTOKEN; }; f"\n`)
process.env.GIT_CONFIG_GLOBAL = gcfg
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GITX_NO_BROWSER = '1'
process.env.GITX_API_KIND = 'gitlab'
process.env.GITX_QUEUE_POLL = '150'

let fails = 0
const ok = (cond, name, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : 'FAIL'} queue ${name}${extra && !cond ? ' :: ' + extra : ''}`)
}

// the fake projects
const mrs = {
  '42/1': { state: 'opened', st: 'mergeable', approved: false },
  '42/2': { state: 'opened', st: 'mergeable' },
  '43/5': { state: 'opened', st: 'mergeable' }
}
const events = []
const mergeBodies = {}
let checks = 0
const server = http.createServer((rq, rs) => {
  let body = ''
  rq.on('data', (d) => (body += d))
  rq.on('end', () => {
    const send = (code, obj) => (rs.writeHead(code, { 'Content-Type': 'application/json' }), rs.end(JSON.stringify(obj)))
    if (rq.headers['private-token'] !== 'TESTTOKEN' && rq.headers.authorization !== 'Bearer TESTTOKEN') return send(401, { message: 'no' })
    const u = rq.url.replace(/^\/api\/v4/, '')
    if (u === '/user') return send(200, { username: 'me' })
    const m = u.match(/^\/projects\/(\d+)\/merge_requests\/(\d+)(\/[a-z]+)?(\?.*)?$/)
    if (!m) return send(404, { message: 'no route ' + u })
    const key = `${m[1]}/${m[2]}`
    const mr = mrs[key]
    const sub = m[3] || ''
    if (rq.method === 'POST' && sub === '/approve') {
      mr.approved = true
      events.push(`approve ${key}`)
      return send(201, {})
    }
    if (rq.method === 'PUT' && sub === '/rebase') {
      events.push(`rebase ${key}`)
      mr.st = 'checking'
      setTimeout(() => (mr.st = 'mergeable'), 400)
      return send(202, { rebase_in_progress: true })
    }
    if (rq.method === 'PUT' && !sub) {
      // the merge request's own settings change (delete source branch, squash)
      const b = JSON.parse(body || '{}')
      events.push(`update ${key} ${JSON.stringify(b)}`)
      if ('remove_source_branch' in b) mr.force = b.remove_source_branch
      if ('squash' in b) mr.squash = b.squash
      return send(200, { state: mr.state, force_remove_source_branch: !!mr.force, squash: !!mr.squash })
    }
    if (rq.method === 'PUT' && sub === '/merge') {
      if (mr.st !== 'mergeable') return send(406, { message: 'Branch cannot be merged' })
      mergeBodies[key] = JSON.parse(body || '{}')
      mr.state = 'merged'
      events.push(`merge ${key}`)
      // the other one of the same project: GitLab checks it again, then wants a rebase
      for (const [k, o] of Object.entries(mrs))
        if (k !== key && k.startsWith(m[1] + '/') && o.state === 'opened') {
          o.st = 'checking'
          setTimeout(() => (o.st = 'need_rebase'), 500)
        }
      return send(200, { state: 'merged' })
    }
    if (sub === '/approvals') return send(200, { approvals_required: 1, approved_by: mr.approved ? [{ user: { username: 'me' } }] : [], user_has_approved: !!mr.approved, user_can_approve: true })
    if (sub === '/notes' || sub === '/commits') return send(200, [])
    if (!sub) {
      if (mr.st === 'checking') checks++
      const st = key === '42/1' && !mr.approved ? 'not_approved' : mr.st
      return send(200, { state: mr.state, force_remove_source_branch: !!mr.force, squash: !!mr.squash, detailed_merge_status: st, title: key, source_branch: 'f' + m[2], target_branch: 'main', author: { username: 'ann' }, user: { can_merge: true }, head_pipeline: { status: mr.pipe || 'success' } })
    }
    send(404, { message: 'no route ' + u })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
process.env.GITX_API_BASE = `http://127.0.0.1:${port}/api/v4`

const handlers = {}
const notes = []
const orca = { panels: { handle: (n, f) => (handlers[n] = f), post() {} }, host: { has: (n) => n === 'notifications.show', call: async (n, a) => (notes.push(a), {}) }, commands: { register() {} }, events: { on() {} }, log() {} }
const mod = await import(pathToFileURL(path.resolve(ROOT, '../worker/main.mjs')).href)
mod.default(orca)

const item = (p, n, extra = {}) => ({ provider: 'gitlab', host: `127.0.0.1:${port}`, protocol: 'http', via: 'git', projectId: p, number: n, repo: `group/p${p}`, url: `http://127.0.0.1:${port}/group/p${p}/-/merge_requests/${n}`, title: `MR ${p}/${n}`, ...extra })
try {
  const first = await handlers['reviews.queue']({ items: [item(42, 1, { wantApprove: true }), item(42, 2), item(43, 5)] })
  const pos = Object.fromEntries(first.jobs.map((j) => [j.number, j]))
  ok(first.jobs.length === 3, 'three queued', JSON.stringify(first.jobs))
  // queueing the same one again does not add it twice
  const again = await handlers['reviews.queue']({ items: [item(42, 2)] })
  ok(again.jobs.length === 3, 'no duplicate job')
  ok(pos[2].state === 'queued' && pos[2].position === 1, 'the second of a project waits in line', JSON.stringify(pos[2]))
  const t0 = Date.now()
  let st
  while (Date.now() - t0 < 20_000) {
    st = await handlers['reviews.queueState']({})
    if (st.jobs.every((j) => ['merged', 'failed', 'auto'].includes(j.state))) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const by = Object.fromEntries(st.jobs.map((j) => [j.number, j]))
  ok(['1', '2', '5'].every((n) => by[n]?.state === 'merged'), 'all merged', JSON.stringify(st.jobs))
  const at = (e) => events.indexOf(e)
  ok(at('approve 42/1') >= 0 && at('approve 42/1') < at('merge 42/1'), 'approved before merging', events.join(', '))
  ok(at('merge 42/1') < at('rebase 42/2') && at('rebase 42/2') < at('merge 42/2'), 'same project: one after the other, rebased in between', events.join(', '))
  ok(at('merge 43/5') < at('merge 42/2'), 'another project does not wait', events.join(', '))
  ok(events.filter((e) => e.startsWith('merge')).length === 3, 'each merged once', events.join(', '))
  ok(checks > 0, 'waited while GitLab was checking')
  ok(notes.filter((n) => n.title === 'Merged').length === 3, 'a notification for each merge', JSON.stringify(notes))
  // something that cannot be merged fails with GitLab's reason and does not block the line
  mrs['42/7'] = { state: 'opened', st: 'conflict' }
  mrs['42/8'] = { state: 'opened', st: 'mergeable' }
  await handlers['reviews.queue']({ items: [item(42, 7), item(42, 8)] })
  const t1 = Date.now()
  while (Date.now() - t1 < 10_000) {
    st = await handlers['reviews.queueState']({})
    const j7 = st.jobs.find((j) => j.number === 7)
    const j8 = st.jobs.find((j) => j.number === 8)
    if (['merged', 'failed'].includes(j7?.state) && ['merged', 'failed'].includes(j8?.state)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const j7 = st.jobs.find((j) => j.number === 7)
  ok(j7?.state === 'failed' && /conflict/i.test(j7.error), 'conflict: failed with the reason', JSON.stringify(j7))
  ok(st.jobs.find((j) => j.number === 8)?.state === 'merged', 'the next one still merges')
  // made with "delete source branch" on; queued with it off: the merge request is changed first
  mrs['42/9'] = { state: 'opened', st: 'mergeable', force: true }
  await handlers['reviews.queue']({ items: [item(42, 9, { options: { removeSource: false, squash: false } })] })
  const t2 = Date.now()
  while (Date.now() - t2 < 10_000) {
    st = await handlers['reviews.queueState']({})
    if (['merged', 'failed'].includes(st.jobs.find((j) => j.number === 9)?.state)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  ok(mrs['42/9'].force === false && events.some((e) => e.startsWith('update 42/9') && e.includes('"remove_source_branch":false')), 'its own "delete source branch" is turned off before merging', events.filter((e) => e.includes('42/9')).join(' | '))
  ok(mergeBodies['42/9']?.should_remove_source_branch === false, 'and the merge asks not to delete it', JSON.stringify(mergeBodies['42/9']))
  // merged, and a pipeline runs after the merge: it stays in the list (watched), not gone and back
  mrs['42/9'].pipe = 'running'
  const l1 = await handlers['reviews.list']({ fresh: true })
  ok(l1.items.some((i) => i.number === 9 && i.state === 'merged' && i.watched && i.ci === 'running'), 'merged here, pipeline running: still listed, marked', JSON.stringify(l1.items.map((i) => [i.number, i.state, i.ci])))
  mrs['42/9'].pipe = 'success'
  const l2 = await handlers['reviews.list']({ fresh: true })
  ok(!l2.items.some((i) => i.number === 9), 'its pipeline done: it leaves', JSON.stringify(l2.items.map((i) => [i.number, i.state, i.ci])))
} catch (e) {
  fails++
  console.log('CRASH', e.stack)
}
console.log(`queue: ${fails ? fails + ' failed' : 'all passed'}`)
process.exit(fails ? 1 : 0)
