// Bitbucket Cloud from start to end, against a fake api.bitbucket.org that behaves like the real one
// (no real account is used; the host is made up). First the worker on its own, then the real panel in
// headless Chrome, clicked like a person:
// - a saved login that cannot read pull requests (Git Credential Manager's OAuth token) shows the
//   Connect card with the reason and "Replace the saved login", not an error
// - "opened by me" refused by Bitbucket does not bring the list down; a rate limit says HTTP 429
// - Approve on someone else's pull request; on your own the page says why there is none
// - the Pipelines tab: Bitbucket Pipelines, their steps, a step's log, run again, stop
// - a new pull request with the repository's default reviewers picked
// node tests/bitbucket.mjs <plugin folder> <shots folder>
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const PLUGIN = path.resolve(process.argv[2] || '..')
const SHOTS = path.resolve(process.argv[3] || '../.orca/e2e')
mkdirSync(SHOTS, { recursive: true })
const CHROME = process.env.CHROME || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform] || '/usr/bin/google-chrome'
const HOST = 'bitbucket.example.test'
const WEB = `http://${HOST}/ws/app`

let fails = 0
const results = []
const ok = (cond, name, extra = '') => {
  if (!cond) fails++
  results.push([!!cond, name])
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra && !cond ? ' :: ' + String(extra).slice(0, 600) : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- the fake Bitbucket ----------
const uid = (n) => `{${String(n).repeat(8)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(4)}-${String(n).repeat(12)}}`
const ME = { uuid: uid(1), nickname: 'me', display_name: 'Me Myself', links: { avatar: { href: '' } } }
const BOB = { uuid: uid(2), nickname: 'bob', display_name: 'Bob Builder' }
const ANN = { uuid: uid(3), nickname: 'ann', display_name: 'Ann Reviewer' }
const P1 = '{aaaaaaaa-0000-0000-0000-000000000001}'
const P2 = '{aaaaaaaa-0000-0000-0000-000000000002}'
const S1 = '{bbbbbbbb-0000-0000-0000-000000000001}'
const S2 = '{bbbbbbbb-0000-0000-0000-000000000002}'
const S3 = '{bbbbbbbb-0000-0000-0000-000000000003}'
const bb = {
  auth: 'api', // 'oauth': only Bearer works, and only for /user (an OAuth token without the pull request scope)
  limit: false, // every pull request list answers 429
  noAccount: false, // a token without the account scope: /user answers 403
  paged: false, // the open list comes in two pages ("next")
  merge: null, // { allowed: [...], async: true }: the target branch's strategies; a merge done in the background
  calls: [],
  approved: new Set(),
  created: []
}
const iso = (minAgo = 0) => new Date(Date.now() - minAgo * 60000).toISOString()
function pr(id) {
  const mine = id === 22
  const author = mine ? ME : BOB
  const approvers = [...bb.approved].filter((x) => x === id).map(() => ({ user: ME, role: 'REVIEWER', approved: true, state: 'approved' }))
  return {
    id,
    title: mine ? 'Add the export button' : 'Fix the login page',
    state: 'OPEN',
    description: mine ? 'My change' : 'Fixes **login**',
    author,
    reviewers: mine ? [BOB] : [ME],
    participants: [...approvers, ...(mine ? [] : [{ user: ANN, role: 'PARTICIPANT', approved: true, state: 'approved' }])],
    source: { branch: { name: mine ? 'feat-b' : 'feat-a' }, commit: { hash: mine ? 'bbb2222' : 'aaa1111' } },
    destination: { branch: { name: 'main' }, repository: { full_name: 'ws/app' } },
    links: { html: { href: `${WEB}/pull-requests/${id}` } },
    created_on: iso(90),
    updated_on: iso(mine ? 5 : 10),
    comment_count: 0,
    close_source_branch: false
  }
}
const merged = (id) => ({ ...pr(21), id, title: `Old change ${id}`, state: 'MERGED', links: { html: { href: `${WEB}/pull-requests/${id}` } }, updated_on: iso(60 * 24 * (id - 10)) })
const pipeline = (uuid) =>
  uuid === P1
    ? { uuid: P1, build_number: 7, state: { name: 'COMPLETED', result: { name: 'FAILED' } }, target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main', commit: { hash: 'ccc3333' }, selector: { type: 'branches', pattern: 'main' } }, trigger: { name: 'PUSH' }, creator: ME, created_on: iso(30), completed_on: iso(28), duration_in_seconds: 95 }
    : { uuid: P2, build_number: 8, state: { name: 'IN_PROGRESS', stage: { name: 'RUNNING' } }, target: { type: 'pipeline_pullrequest_target', source: 'feat-a', destination: 'main', commit: { hash: 'aaa1111' }, destination_commit: { hash: 'ccc3333' }, pullrequest: { id: 21 }, selector: { type: 'pull-requests', pattern: '**' } }, trigger: { name: 'PUSH' }, creator: BOB, created_on: iso(2) }
const steps = (uuid) =>
  uuid === P1
    ? [
        { uuid: S1, name: 'Build', state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } }, started_on: iso(30), duration_in_seconds: 40 },
        { uuid: S2, name: 'Unit tests', state: { name: 'COMPLETED', result: { name: 'FAILED' } }, started_on: iso(29), duration_in_seconds: 50 }
      ]
    : [{ uuid: S3, name: 'Build', state: { name: 'IN_PROGRESS' } }]

const server = http.createServer((rq, rs) => {
  let data = ''
  rq.on('data', (d) => (data += d))
  rq.on('end', () => {
    const u = new URL(rq.url, 'http://x')
    const p = decodeURIComponent(u.pathname).replace(/^\/2\.0/, '')
    const auth = rq.headers.authorization || ''
    bb.calls.push({ method: rq.method, path: p, query: u.search, auth, body: data ? JSON.parse(data) : null })
    const send = (code, obj, headers = {}) => {
      rs.writeHead(code, { 'Content-Type': typeof obj === 'string' ? 'text/plain' : 'application/json', ...headers })
      rs.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
    }
    const basicOk = auth === 'Basic ' + Buffer.from('u:TESTTOKEN').toString('base64')
    const bearerOk = auth === 'Bearer TESTTOKEN'
    if (bb.auth === 'oauth') {
      if (!bearerOk) return send(401, { type: 'error', error: { message: 'Unauthorized' } })
      if (p === '/user') return send(200, ME)
      return send(403, { type: 'error', error: { message: 'Your credentials lack one or more required privilege scopes.', detail: { required: ['pullrequest'], granted: ['account'] } } })
    }
    if (!basicOk) return send(401, { type: 'error', error: { message: 'Unauthorized' } })
    const R = '/repositories/ws/app'
    if (p === '/user') return bb.noAccount ? send(403, { type: 'error', error: { message: 'Your credentials lack one or more required privilege scopes.', detail: { required: ['account'], granted: ['repository', 'pullrequest'] } } }) : send(200, ME)
    if (bb.limit && /pullrequests/.test(p)) return send(429, { type: 'error', error: { message: 'Rate limit for this resource has been exceeded' } }, { 'Retry-After': '2' })
    // "every pull request I opened": refused, as Bruno saw it
    if (p === `/pullrequests/${ME.uuid}`) return send(403, { type: 'error', error: { message: 'Your credentials lack one or more required privilege scopes.' } })
    if (rq.method === 'GET' && p === `${R}/pullrequests` && bb.paged && u.searchParams.get('state') === 'OPEN') {
      // a next link is a full URL on the API, as the real one gives it
      const pg = +(u.searchParams.get('page') || 1)
      return send(200, pg === 1 ? { values: [pr(21)], pagelen: 1, next: `http://${rq.headers.host}/2.0${R}/pullrequests?state=OPEN&page=2` } : { values: [pr(22)], pagelen: 1 })
    }
    if (rq.method === 'GET' && p === `${R}/pullrequests`) return send(200, { values: u.searchParams.get('state') === 'MERGED' ? [merged(11), merged(12)] : [pr(21), pr(22)], pagelen: 50 })
    if (rq.method === 'GET' && p === `${R}/refs/branches/main`) return send(200, { name: 'main', ...(bb.merge?.allowed ? { merge_strategies: bb.merge.allowed, default_merge_strategy: bb.merge.allowed[0] } : {}) })
    const tm = p.match(new RegExp(`^${R}/pullrequests/(\\d+)/merge/task-status/t1$`))
    if (tm) {
      // pending twice, then done (or failed: a conflict)
      if (++bb.taskPolls < 3) return send(200, { task_status: 'PENDING' })
      if (bb.merge?.fail) return send(400, { type: 'error', error: { message: 'Merge conflict in app.js' } })
      bb.mergedIds.add(+tm[1])
      return send(200, { task_status: 'SUCCESS', merge_result: { ...pr(+tm[1]), state: 'MERGED' } })
    }
    const m = p.match(new RegExp(`^${R}/pullrequests/(\\d+)(/[\\w-]+)?$`))
    if (m) {
      const id = +m[1]
      const sub = m[2] || ''
      if (rq.method === 'GET' && !sub) return send(200, bb.mergedIds?.has(id) ? { ...pr(id), state: 'MERGED' } : pr(id))
      if (rq.method === 'POST' && sub === '/merge') {
        bb.mergedIds ??= new Set()
        if (!bb.merge?.async) return bb.mergedIds.add(id), send(200, { ...pr(id), state: 'MERGED' })
        bb.taskPolls = 0
        return send(202, { task_status: 'PENDING', links: { self: { href: `http://${rq.headers.host}/2.0${R}/pullrequests/${id}/merge/task-status/t1` } } })
      }
      if (rq.method === 'GET' && sub === '/merge') return send(404, {})
      if (rq.method === 'POST' && sub === '/approve') return bb.approved.add(id), send(200, { approved: true, user: ME })
      if (rq.method === 'DELETE' && sub === '/approve') return bb.approved.delete(id), send(204, '')
      if (sub === '/statuses') return send(200, { values: id === 21 ? [{ state: 'INPROGRESS' }] : [{ state: 'SUCCESSFUL' }] })
      if (sub === '/comments') return send(200, { values: [] })
      if (sub === '/commits') return send(200, { values: [{ hash: id === 21 ? 'aaa1111' : 'bbb2222', message: 'The change', author: { raw: 'Bob <b@x>' }, date: iso(20) }] })
      if (sub === '/diffstat') return send(200, { values: [{ lines_added: 3, lines_removed: 1 }] })
    }
    if (rq.method === 'POST' && p === `${R}/pullrequests`) {
      bb.created.push(JSON.parse(data))
      return send(201, { id: 23, links: { html: { href: `${WEB}/pull-requests/23` } } })
    }
    if (p.startsWith('/user/permissions/repositories')) return send(200, { values: [{ permission: 'write' }] })
    if (p === `${R}/effective-default-reviewers`) return send(200, { values: [{ user: ANN, reviewer_type: 'repository' }] })
    if (p === '/workspaces/ws/members') return send(200, { values: [{ user: ME }, { user: BOB }, { user: ANN }] })
    if (/\/commit\/\w+\/statuses$/.test(p)) return send(200, { values: [{ state: 'SUCCESSFUL' }] })
    if (/\/commit\/\w+$/.test(p)) return send(200, { hash: p.split('/').pop(), message: 'Fix the thing\n\nlonger text' })
    // Pipelines
    if (rq.method === 'GET' && p === `${R}/pipelines/`) {
      const branch = u.searchParams.get('target.branch')
      const sha = u.searchParams.get('target.commit.hash')
      const all = [pipeline(P2), pipeline(P1)]
      return send(200, { values: all.filter((x) => (!branch || (x.target.ref_name || x.target.source) === branch) && (!sha || x.target.commit.hash === sha)) })
    }
    if (rq.method === 'POST' && p === `${R}/pipelines/`) return send(201, { uuid: '{aaaaaaaa-0000-0000-0000-000000000009}', build_number: 9 })
    const pm = p.match(new RegExp(`^${R}/pipelines/(\\{[\\w-]+\\})(/.*)?$`))
    if (pm) {
      const [, id, rest = ''] = pm
      if (rq.method === 'GET' && !rest) return send(200, pipeline(id))
      if (rq.method === 'GET' && rest === '/steps/') return send(200, { values: steps(id) })
      if (rq.method === 'GET' && rest === `/steps/${S2}/log`) return send(200, '\x1b[32m+ npm test\x1b[0m\nok 1 adds\nnot ok 2 subtracts\nERROR: tests failed\r\n')
      // like the real one: a log Bitbucket does not give (not started, or no longer kept) answers this 404
      if (rq.method === 'GET' && /\/steps\/.*\/log$/.test(rest)) return send(404, { error: { message: 'Not found', detail: 'The value provided is not a valid uuid.' } })
      const sm = rest.match(/^\/steps\/(\{[\w-]+\})$/)
      if (rq.method === 'GET' && sm) return send(200, steps(id).find((x) => x.uuid === sm[1]) || {})
      if (rq.method === 'POST' && rest === '/stopPipeline') return send(204, '')
    }
    send(404, { type: 'error', error: { message: `no route ${rq.method} ${p}` } })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GITX_API_BASE = `http://127.0.0.1:${server.address().port}/2.0`
process.env.GITX_QUEUE_POLL = '50'
process.env.GITX_BB_RETRY = '10'
process.env.GITX_NO_BROWSER = '1'

// ---------- a repository on "bitbucket" (pushed to a local bare repository; its URL then names the fake host) ----------
const root = mkdtempSync(path.join(tmpdir(), 'gitx-bb-'))
const GLOBAL_CFG = path.join(root, 'global.gitconfig')
// the saved Git login answers only for the fake Bitbucket host: github.com and the rest stay signed out
writeFileSync(GLOBAL_CFG, `[user]\n\tname = Tester\n\temail = t@e2e.test\n[init]\n\tdefaultBranch = main\n[credential]\n\thelper = "!f() { if [ \\"$1\\" = get ] && grep -q 'host=${HOST}'; then echo username=u; echo password=TESTTOKEN; fi; }; f"\n`)
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'
// gh and glab out of PATH: never the person's real accounts
process.env.PATH = process.env.PATH.split(path.delimiter).filter((d) => !['gh.exe', 'glab.exe', 'gh', 'glab'].some((b) => { try { return statSync(path.join(d, b)).isFile() } catch { return false } })).join(path.delimiter)
const repo = path.join(root, 'app')
const bare = path.join(root, 'origin.git')
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
execFileSync('git', ['init', '-q', '-b', 'main', repo])
g('config', 'core.autocrlf', 'false')
writeFileSync(path.join(repo, 'a.txt'), 'a\n')
g('add', '.'), g('commit', '-qm', 'First')
g('remote', 'add', 'origin', bare), g('push', '-q', '-u', 'origin', 'main')
g('switch', '-qc', 'feat-c')
writeFileSync(path.join(repo, 'c.txt'), 'c\n')
g('add', '.'), g('commit', '-qm', 'Add the C file')
g('push', '-q', '-u', 'origin', 'feat-c')
g('remote', 'set-url', 'origin', `http://${HOST}/ws/app.git`)
g('config', 'gitcontrol.provider', 'bitbucket')
const REPO = repo.replace(/\\/g, '/')

// ---------- the worker, with a stand-in Orca ----------
const handlers = {}
const { default: activate } = await import(pathToFileURL(path.join(PLUGIN, 'worker/main.mjs')).href)
activate({
  api: { major: 1, minor: 3 },
  log() {},
  panels: { handle: (n, f) => (handlers[n] = f), post() {} },
  commands: { register: () => ({ dispose() {} }) },
  events: { on: () => ({ dispose() {} }) },
  host: { has: (m) => ['settings.get', 'settings.set', 'workspace.list'].includes(m), call: async (m) => (m === 'settings.get' ? { settings: {} } : m === 'workspace.list' ? { workspaces: [], truncated: false } : {}) }
})
const call = (n, a) => handlers[n](a)
const op = (o, args = {}) => handlers.git({ op: o, repo: REPO, args })
const calls = (method, re) => bb.calls.filter((c) => c.method === method && re.test(c.path))
const prov = (r) => r.providers.find((x) => x.host === HOST)

let browser = null
try {
  // ===================== the worker =====================
  bb.auth = 'oauth'
  let r = await call('reviews.list', { repo: REPO, fresh: true })
  ok(prov(r) && prov(r).signedIn === false && /cannot read pull requests \(HTTP 403\)/.test(prov(r).problem || ''), 'a login that cannot read pull requests: not signed in, with the reason', JSON.stringify([prov(r), r.errors]))
  ok(!r.errors.some((e) => e.includes(HOST)), 'no error banner for it (the Connect card explains)', JSON.stringify(r.errors))

  bb.auth = 'api'
  r = await call('reviews.list', { repo: REPO, fresh: true })
  const nums = r.items.filter((x) => x.host === HOST).map((x) => x.number).sort()
  ok(prov(r)?.signedIn && JSON.stringify(nums) === '[21,22]', 'API token: the open pull requests are listed', JSON.stringify([nums, r.errors]))
  ok(!r.errors.length, '"opened by me" refused by Bitbucket: no error, the list still knows which are mine', JSON.stringify(r.errors))
  const it21 = r.items.find((x) => x.number === 21)
  const it22 = r.items.find((x) => x.number === 22)
  ok(it21?.roles.includes('review') && it22?.roles.includes('mine'), 'roles: asked to review 21, opened 22', JSON.stringify([it21?.roles, it22?.roles]))
  ok(it21?.ci === 'running' && it22?.ci === 'passed', 'CI of each pull request', JSON.stringify([it21?.ci, it22?.ci]))
  // All: the merged ones come page by page (Show more)
  const all = await call('reviews.moreMerged', { repo: REPO, page: 1 })
  ok(all.items.filter((x) => x.host === HOST && x.state === 'merged').length === 2 && !all.errors.length, 'All: the merged ones listed, no error', JSON.stringify([all.items.map((x) => [x.number, x.state]), all.errors]))

  // a rate limit: the lists already seen stay, and the page says HTTP 429
  bb.limit = true
  bb.calls.length = 0
  r = await call('reviews.list', { repo: REPO, fresh: true })
  ok(r.errors.some((e) => /HTTP 429/.test(e) && /showing the last list/.test(e)), 'rate limit: says HTTP 429 and shows the last list', JSON.stringify(r.errors))
  ok(r.items.filter((x) => x.host === HOST).length === 2, 'rate limit: the pull requests stay listed', JSON.stringify(r.items.map((x) => x.number)))
  ok(calls('GET', /pullrequests\?|pullrequests$/).length <= 3, 'rate limit: no retry storm', String(calls('GET', /pullrequests/).length))
  const n0 = bb.calls.length
  await call('reviews.list', { repo: REPO, fresh: true })
  ok(bb.calls.filter((c) => /pullrequests/.test(c.path)).length === bb.calls.slice(0, n0).filter((c) => /pullrequests/.test(c.path)).length, 'rate limit: no request until it lifts')
  bb.limit = false
  await sleep(2200)

  // a token without the account scope (the Connect card asks only for repositories and pull requests):
  // the list still comes, only "mine" / "to review" need who I am
  bb.noAccount = true
  r = await call('reviews.list', { repo: REPO, fresh: true })
  ok(prov(r)?.signedIn && r.items.filter((x) => x.host === HOST).length === 2 && !r.errors.length, 'a token that cannot say who it is: the pull requests are still listed, signed in, no error', JSON.stringify([prov(r), r.items.map((x) => x.number), r.errors]))
  bb.noAccount = false

  // more than one page of open pull requests: every page is read
  bb.paged = true
  r = await call('reviews.list', { repo: REPO, fresh: true })
  ok(JSON.stringify(r.items.filter((x) => x.host === HOST).map((x) => x.number).sort()) === '[21,22]' && calls('GET', /\/pullrequests$/).some((c) => /page=2/.test(c.query)), 'open pull requests over more pages: all listed (Bitbucket\'s next link followed)', JSON.stringify([r.items.map((x) => x.number), r.errors]))
  bb.paged = false

  // the pull request pages
  const d21 = await call('reviews.detail', it21)
  const d22 = await call('reviews.detail', it22)
  ok(d21.canApprove === true && !d21.approveBlock, 'someone else\'s pull request: Approve offered', JSON.stringify([d21.canApprove, d21.approveBlock]))
  ok(d22.canApprove === false && d22.approveBlock === 'own', 'my own pull request: no Approve, and why', JSON.stringify([d22.canApprove, d22.approveBlock]))
  await call('reviews.act', { ...it21, action: 'approve' })
  ok(calls('POST', /\/pullrequests\/21\/approve$/).length === 1, 'Approve posts to Bitbucket')
  bb.approved.clear()

  // Merge: the strategy the target branch allows, and a merge Bitbucket finishes in the background
  process.env.GITX_QUEUE_POLL = '20'
  bb.calls.length = 0
  bb.merge = { allowed: ['squash', 'fast_forward'] }
  const noMc = await call('reviews.act', { ...it21, action: 'merge', options: { squash: false } }).catch((e) => e)
  const mb = calls('POST', /\/pullrequests\/21\/merge$/)[0]?.body
  ok(noMc?.ok && mb?.type === 'pullrequest_merge_parameters' && !('merge_strategy' in mb), 'a branch without merge commits: Merge uses the branch\'s own default, not a refused merge_commit', JSON.stringify([noMc?.message, mb]))
  bb.mergedIds.clear()
  bb.merge = { allowed: ['merge_commit'] }
  const noSq = await call('reviews.act', { ...it21, action: 'merge', options: { squash: true } }).then(() => null, (e) => e)
  ok(/does not allow a squash merge/.test(noSq?.message || '') && !calls('POST', /\/merge$/).slice(1).length, 'squash on a branch that does not allow it: says so, nothing sent', noSq?.message)
  bb.merge = { allowed: ['merge_commit', 'squash'], async: true }
  const late = await call('reviews.act', { ...it21, action: 'merge', options: { squash: true } }).catch((e) => e)
  ok(late?.ok && late.state === 'merged' && calls('GET', /\/merge\/task-status\/t1$/).length === 3, 'a long merge (HTTP 202): followed to its end', JSON.stringify([late?.message, calls('GET', /task-status/).length]))
  bb.mergedIds.clear()
  bb.merge = { allowed: ['merge_commit'], async: true, fail: true }
  const conflict = await call('reviews.act', { ...it21, action: 'merge', options: {} }).then(() => null, (e) => e)
  ok(/Merge conflict in app\.js/.test(conflict?.message || ''), 'a long merge that fails: Bitbucket\'s reason shown', conflict?.message)
  bb.merge = null
  bb.mergedIds.clear()

  // people for a new pull request: the default reviewer picked, members to choose from
  const people = await call('mr.people', { repo: REPO })
  ok(people.kind === 'bitbucket' && people.people.length === 3 && people.me?.id === ME.uuid, 'members to pick reviewers from', JSON.stringify(people))
  ok(JSON.stringify(people.defaults.reviewers.map((x) => x.id)) === JSON.stringify([ANN.uuid]), 'the repository\'s default reviewer comes picked', JSON.stringify(people.defaults))
  const cr = await call('mr.create', { repo: REPO, target: 'main', source: 'feat-c', title: 'Add C', body: 'Body', reviewers: [{ id: ANN.uuid, username: 'ann' }, { id: ME.uuid, username: 'me' }, { id: 'not-a-uuid', username: 'x' }] })
  ok(cr.created && cr.number === 23, 'Create now makes the pull request', JSON.stringify(cr))
  ok(JSON.stringify(bb.created.at(-1)?.reviewers) === JSON.stringify([{ uuid: ANN.uuid }]), 'reviewers sent by uuid, without me (Bitbucket refuses the author)', JSON.stringify(bb.created.at(-1)))

  // Pipelines
  const pipes = await op('pipelines', { all: true })
  const p7 = pipes.items.find((x) => x.name === '#7')
  const p8 = pipes.items.find((x) => x.name === '#8')
  ok(pipes.kind === 'bitbucket' && pipes.items.length === 2 && pipes.caps?.retryJob === false && pipes.web === `${WEB}/pipelines`, 'Pipelines tab: Bitbucket Pipelines listed', JSON.stringify(pipes).slice(0, 400))
  ok(p7?.state === 'failed' && p7.branch === 'main' && p7.sha === 'ccc3333' && p7.event === 'push' && p7.by === 'me' && p7.duration === 95 && p7.url === `${WEB}/pipelines/results/7`, 'a finished pipeline: state, branch, commit, trigger, who, how long, link', JSON.stringify(p7))
  ok(p7?.stages?.map((s) => s.state).join() === 'passed,failed' && p7.commitTitle === 'Fix the thing', 'its steps as dots, and the commit message', JSON.stringify([p7?.stages, p7?.commitTitle]))
  ok(p8?.state === 'running' && p8.pr === 21 && p8.branch === 'feat-a' && p8.event === 'pull_request', 'a running pull request pipeline', JSON.stringify(p8))
  const one = await op('pipelines', { branch: 'main' })
  ok(one.items.length === 1 && one.items[0].name === '#7' && calls('GET', /\/pipelines\/$/).some((c) => c.query.includes('target.branch=main')), 'one branch\'s pipelines', JSON.stringify(one.items.map((x) => x.name)))
  const jobs = await op('pipelineJobs', { id: P1 })
  ok(jobs.length === 2 && jobs[1].name === 'Unit tests' && jobs[1].state === 'failed' && jobs[1].id === `${P1}~${S2}` && jobs[1].url === `${WEB}/pipelines/results/7/steps/${S2}`, 'a pipeline\'s steps', JSON.stringify(jobs))
  const log = await op('jobLog', { id: jobs[1].id })
  ok(log.log.includes('ERROR: tests failed') && !log.log.includes('\x1b'), 'a step\'s log, without colour codes', JSON.stringify(log))
  const empty = await op('jobLog', { id: `${P2}~${S3}` })
  ok(empty.log === '', 'a step that has not started: an empty log, not an error', JSON.stringify(empty))
  const gone = await op('jobLog', { id: `${P1}~${S1}` }).then(() => null, (e) => e)
  ok(/did not give this step's log/.test(gone?.message || '') && /not a valid uuid|Not found/.test(gone?.message || ''), 'a step that ran but whose log Bitbucket does not give: says so, not an empty log', gone?.message)
  bb.calls.length = 0
  await op('pipelineAct', { id: P1, action: 'retry' })
  const rerun = calls('POST', /\/pipelines\/$/)[0]
  ok(JSON.stringify(rerun?.body) === JSON.stringify({ target: { type: 'pipeline_ref_target', ref_type: 'branch', ref_name: 'main', commit: { type: 'commit', hash: 'ccc3333' } } }), 'Retry all runs the same pipeline on the same commit (Bitbucket picks it again from the commit)', JSON.stringify(rerun))
  await op('pipelineAct', { id: P2, action: 'retry' })
  const rerun2 = calls('POST', /\/pipelines\/$/)[1]
  ok(rerun2?.body?.target?.type === 'pipeline_pullrequest_target' && rerun2.body.target.pullrequest?.id === '21' && rerun2.body.target.source === 'feat-a' && rerun2.body.target.selector?.type === 'pull-requests' && rerun2.body.target.selector.pattern === '**', "Retry all of a pull request pipeline (as in Bitbucket's example)", JSON.stringify(rerun2))
  await op('pipelineAct', { id: P2, action: 'cancel' })
  ok(calls('POST', /\/stopPipeline$/).length === 1, 'Cancel stops the pipeline')
  const nope = await op('pipelineAct', { id: P1, action: 'retryJob', job: `${P1}~${S2}` }).then(() => null, (e) => e)
  ok(nope && /as a whole/.test(nope.message), 'retrying one step says Bitbucket runs the whole pipeline', nope?.message)
  const bad = await op('pipelineJobs', { id: '../../user' }).then(() => null, (e) => e)
  ok(bad && /bad pipeline id/.test(bad.message), 'a strange pipeline id is refused', bad?.message)

  // ===================== the panel =====================
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1500,950'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1500, height: 950 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.exposeFunction('__orcaRequest', async (name, input) => {
    try {
      return { out: await handlers[name](input) }
    } catch (e) {
      return { error: e.message, code: e.code }
    }
  })
  await page.evaluateOnNewDocument((repoPath) => {
    document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('dark'))
    window.orca = Object.freeze({
      api: { major: 1, minor: 3 },
      locale: 'en',
      plugin: {
        request: async (name, input) => {
          const r = await window.__orcaRequest(name, input ?? null)
          if (r.error) throw Object.assign(new Error(r.error), { code: r.code || 'action_failed' })
          return r.out
        }
      },
      document: { get: async () => ({ version: 1, readOnly: false, content: { kind: 'text', text: JSON.stringify({ repo: repoPath }) } }), onDidChange() {} },
      host: { has: () => false, call: async () => ({}) },
      on: () => ({ dispose() {} })
    })
  }, REPO)
  await page.setRequestInterception(true)
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.hostname !== 'gitx.test') return req.respond({ status: 404, body: '' })
    try {
      req.respond({ status: 200, contentType: TYPES[path.extname(u.pathname)] || 'text/plain', body: readFileSync(path.join(PLUGIN, 'panel', u.pathname.slice(1))) })
    } catch {
      req.respond({ status: 404, body: '' })
    }
  })
  async function until(fn, label, ms = 10000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        const v = await fn()
        if (v) return v
      } catch {}
      await sleep(120)
    }
    throw new Error(`timed out: ${label}`)
  }
  const clickText = (sel, text) => until(() => page.evaluate((sel, text) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text) && !e.disabled); if (!el) return false; el.click(); return true }, sel, text), `click "${text}" in ${sel}`)
  const textOf = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent).join('\n'), sel)
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `bitbucket-${name}.png`) })
  const step = async (name, fn) => {
    try {
      await fn()
    } catch (e) {
      ok(false, name, e.message)
      await shot('fail-' + name.replace(/\W+/g, '-').slice(0, 40)).catch(() => {})
    }
  }

  process.env.GITX_REVIEWS_POLL = '1' // the panel never gets the worker part's shared answers
  await page.goto('http://gitx.test/tab.html', { waitUntil: 'domcontentloaded' })
  await until(() => page.$$eval('.commit-row', (r) => r.length >= 2), 'graph rows')

  await step('UI: a login that cannot read pull requests', async () => {
    bb.auth = 'oauth'
    await clickText('.tab', 'MR / PR')
    await until(() => page.evaluate((h) => [...document.querySelectorAll('.setup-card')].some((c) => c.textContent.includes(h)), HOST), 'Connect card')
    const card = await page.evaluate((h) => [...document.querySelectorAll('.setup-card')].find((c) => c.textContent.includes(h))?.textContent || '', HOST)
    ok(/cannot read pull requests \(HTTP 403\)/.test(card) && card.includes('Replace the saved login') && card.includes('Create an API token'), 'UI: the Connect card says why and offers to replace the login', card)
    ok(!(await textOf('.banner')).includes(HOST), 'UI: no error banner for it', await textOf('.banner'))
    await shot('1-connect-replace')
  })

  await step('UI: the list with an API token', async () => {
    bb.auth = 'api'
    await clickText('.setup-card button', 'Check again')
    await until(() => page.$$eval('.review-row', (r) => r.length >= 2), 'two pull requests')
    const rows = await textOf('.review-row')
    ok(rows.includes('Fix the login page') && rows.includes('Add the export button') && rows.includes('#21'), 'UI: both pull requests listed with #numbers', rows)
    ok(!(await page.$('.banner')), 'UI: no banner (although "opened by me" is refused)', await textOf('.banner'))
    await shot('2-list')
  })

  await step('UI: Approve someone else\'s pull request', async () => {
    await clickText('.review-row', 'Fix the login page')
    await until(() => page.$('.mrw-approve'), 'Approve button')
    bb.calls.length = 0
    await page.click('.mrw-approve')
    await until(() => calls('POST', /\/pullrequests\/21\/approve$/).length === 1, 'approve posted')
    await until(() => page.evaluate(() => document.body.textContent.includes('you approved') || !!document.querySelector('.mrw-revoke')), 'shown as approved')
    ok(true, 'UI: Approve on the pull request page approves it')
    await shot('3-approved')
    await page.keyboard.press('Escape')
    await sleep(300)
  })

  await step('UI: my own pull request says why there is no Approve', async () => {
    await clickText('.tab', 'MR / PR')
    await clickText('.review-row', 'Add the export button')
    await until(() => page.$('.mrw-noapprove'), 'the reason')
    ok((await textOf('.mrw-noapprove')).includes('You opened it') && !(await page.$('.mrw-approve')), 'UI: own pull request: "You opened it, so you cannot approve it"', await textOf('.mrw-noapprove'))
    await shot('4-own')
    await page.keyboard.press('Escape')
    await sleep(300)
  })

  await step('UI: Pipelines tab', async () => {
    await clickText('.tab', 'Pipelines')
    await until(() => page.$$eval('.pipes-tab .pipe-row', (r) => r.length === 2 && r.some((x) => x.textContent.includes('Fix the thing'))), 'two pipelines with their commit messages')
    const bar = await textOf('.pipes-tab .history-bar')
    const rows = await textOf('.pipes-tab .pipe-row')
    ok(bar.includes('Bitbucket Pipelines'), 'UI: says Bitbucket Pipelines', bar)
    ok(rows.includes('#7') && rows.includes('#8') && rows.includes('Fix the thing') && rows.includes('#21'), 'UI: pipelines with number, commit message and pull request', rows)
    await until(() => page.$$eval('.pipes-tab .pc-dot', (d) => d.length >= 2), 'step dots')
    await shot('5-pipelines')
    bb.calls.length = 0
    await clickText('.pipes-tab .pipe-row', '#7')
    await until(() => page.$$eval('.pipe-job', (j) => j.length === 2), 'the steps')
    ok(!(await page.$('.pipe-job .icon-btn')) && !(await textOf('.history-bar')).includes('Retry failed'), 'UI: no per-step or failed-only retry (Bitbucket runs it whole)')
    await shot('6-steps')
    await clickText('.history-bar .btn', 'Retry all')
    await until(() => calls('POST', /\/pipelines\/$/).length === 1, 'rerun posted')
    ok(true, 'UI: Retry all runs it again')
    await clickText('.pipe-failed .btn', 'Show the error')
    await until(() => page.$$eval('.pipe-log .pl.bad', (l) => l.length > 0), 'the log with error lines')
    ok((await textOf('.pipe-log')).includes('ERROR: tests failed'), 'UI: the failed step\'s log, error lines marked')
    await shot('7-log')
    await page.keyboard.press('Escape')
    await sleep(300)
  })

  await step('UI: new pull request with the default reviewer', async () => {
    await clickText('.tab', 'Graph')
    await until(() => page.$('#side .item'), 'sidebar')
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('#side .item')].find((r) => r.textContent.trim().startsWith('main') || r.textContent.includes('main'))
      row.querySelector('[title="More"]').click()
    })
    await clickText('.menu button', 'Merge request')
    await clickText('.menu button', 'feat-c → main')
    await until(() => page.$('.mr-dialog'), 'dialog')
    await until(() => page.$$eval('.mr-dialog .pp-chip', (c) => c.some((x) => x.textContent.includes('Ann'))), 'Ann picked')
    const dlg = await textOf('.mr-dialog')
    ok(!dlg.includes('Assignees') && dlg.includes('Reviewers'), 'UI: reviewers only (Bitbucket has no assignees)', dlg)
    await shot('8-new-pr')
    bb.created.length = 0
    await clickText('.mr-dialog .btn', 'Create now')
    await until(() => bb.created.length === 1, 'created')
    ok(JSON.stringify(bb.created[0].reviewers) === JSON.stringify([{ uuid: ANN.uuid }]) && bb.created[0].title, 'UI: created with Ann as reviewer', JSON.stringify(bb.created[0]))
  })

  ok(!pageErrors.length, 'UI: no page errors', pageErrors.join(' | '))
} catch (e) {
  ok(false, 'crashed', e.stack)
} finally {
  await browser?.close()
  server.close()
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
}
console.log(`\n${results.filter((r) => r[0]).length}/${results.length} passed`)
process.exit(fails ? 1 : 0)
