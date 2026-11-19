// Worker test against a fake GitHub/GitLab/Bitbucket Cloud API: node tests/worker-api.mjs github|gitlab|bitbucket
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const KIND = process.argv[2]
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')))
const W = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'gitx-api-' + KIND + '-'))
fs.rmSync(W, { recursive: true, force: true })
fs.mkdirSync(W, { recursive: true })
const gcfg = path.join(W, 'global.gitconfig')
fs.writeFileSync(gcfg, `[user]\n\tname = T\n\temail = t@e\n[credential]\n\thelper = "!f() { echo username=u; echo password=TESTTOKEN; }; f"\n[init]\n\tdefaultBranch = main\n`)
process.env.GIT_CONFIG_GLOBAL = gcfg
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GITX_NO_BROWSER = '1'
process.env.GITX_API_KIND = KIND
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

let fails = 0
const ok = (cond, name, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${KIND} ${name}${extra && !cond ? ' :: ' + extra : ''}`)
}

// ---- fake server ----
const log = []
let deny = false
let emailOnly = false // bitbucket: an Atlassian API token, taken only with the account's email
const server = http.createServer((rq, rs) => {
  let body = ''
  rq.on('data', (d) => (body += d))
  rq.on('end', () => {
    const e = { method: rq.method, url: rq.url, auth: rq.headers.authorization, pt: rq.headers['private-token'], accept: rq.headers.accept, ua: rq.headers['user-agent'], body: body ? JSON.parse(body) : null }
    log.push(e)
    const send = (code, obj, type = 'application/json') => {
      rs.writeHead(code, { 'Content-Type': type })
      rs.end(typeof obj === 'string' ? obj : JSON.stringify(obj))
    }
    // gitlab: only PRIVATE-TOKEN works (tests the fallback); bitbucket: only Basic user:token (an app password)
    const authed = KIND === 'github' ? e.auth === 'Bearer TESTTOKEN' : KIND === 'bitbucket' ? e.auth === 'Basic ' + Buffer.from((emailOnly ? 't@e' : 'u') + ':TESTTOKEN').toString('base64') : e.pt === 'TESTTOKEN'
    if (deny || !authed) return send(401, { message: 'Bad credentials' })
    const u = rq.url
    const B = `http://127.0.0.1:${port}`
    if (KIND === 'github') {
      if (e.method === 'POST' && u === '/repos/o/r/pulls') return send(201, { html_url: `${B}/o/r/pull/7`, number: 7 })
      if (u === '/user') return send(200, { login: 'me' })
      if (u.startsWith('/search/issues')) {
        const q = decodeURIComponent(u.split('q=')[1])
        return send(200, { items: [{ html_url: `${B}/o/r/pull/7`, number: 7, title: 'PR ' + q, repository_url: `${B}/repos/o/r`, user: { login: 'me' }, updated_at: '2026-01-01T00:00:00Z', draft: false }] })
      }
      if (u === '/repos/o/r/pulls/7') return e.accept === 'application/vnd.github.diff' ? send(200, 'diff --git a/x b/x\n', 'text/plain') : send(200, { title: 'T', body: 'B', state: 'open', mergeable: true, mergeable_state: 'clean', user: { login: 'dev' }, head: { ref: 'feature', sha: 'abc123', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } })
      if (e.method === 'POST' && u === '/repos/o/r/pulls/7/reviews') return send(200, { id: 1 })
      if (e.method === 'PUT' && u === '/repos/o/r/pulls/7/merge') return send(200, { merged: true, sha: 'm1' })
      if (e.method === 'DELETE' && u === '/repos/o/r/git/refs/heads/feature') return send(204, '')
      if (e.method === 'GET' && u.startsWith('/repos/o/r/pulls/7/reviews')) return send(200, [{ user: { login: 'ann' }, state: 'CHANGES_REQUESTED', body: 'Fix x', submitted_at: '2026-01-01T00:00:00Z' }, { user: { login: 'ann' }, state: 'APPROVED', body: '', submitted_at: '2026-01-02T00:00:00Z' }, { user: { login: 'bob' }, state: 'COMMENTED', body: 'hm', submitted_at: '2026-01-02T00:00:00Z' }])
      if (e.method === 'GET' && u.startsWith('/repos/o/r/issues/7/comments')) return send(200, [{ user: { login: 'bob' }, body: 'Nice', created_at: '2026-01-01T01:00:00Z' }])
      if (e.method === 'GET' && u.startsWith('/repos/o/r/pulls/7/comments')) return send(200, [{ user: { login: 'bob' }, body: 'rename', path: 'x.js', line: 4, created_at: '2026-01-01T02:00:00Z' }])
      if (e.method === 'GET' && u.startsWith('/repos/o/r/pulls/7/commits')) return send(200, [{ sha: 'c0ffee1234', commit: { message: 'Do it\n\nbody', author: { name: 'Me', date: '2026-01-01T00:00:00Z' } } }])
      if (e.method === 'POST' && u === '/repos/o/r/pulls/7/comments') return send(201, { id: 2 })
      if (/\/commits\/\w+\/check-runs$/.test(u)) return send(200, { check_runs: [{ conclusion: 'success' }] })
      if (/\/commits\/\w+\/status$/.test(u)) return send(200, { statuses: [] })
    } else if (KIND === 'bitbucket') {
      const P = '/2.0'
      const R = `${P}/repositories/ws/repo`
      const meU = { uuid: '{me-1}', nickname: 'me', display_name: 'Me' }
      const html = `${B}/ws/repo/pull-requests/5`
      const pr = { id: 5, title: 'PR', state: 'OPEN', description: 'D', author: meU, reviewers: [meU, { uuid: '{bob-1}', nickname: 'bob' }], participants: [{ user: { uuid: '{ann-1}', nickname: 'ann' }, role: 'PARTICIPANT', approved: true }, { user: { uuid: '{bob-1}', nickname: 'bob' }, role: 'REVIEWER', approved: false }], source: { branch: { name: 'feature' }, commit: { hash: 'abc123' } }, destination: { branch: { name: 'main' }, repository: { full_name: 'ws/repo' } }, links: { html: { href: html } }, updated_on: '2026-01-01T00:00:00Z', created_on: '2026-01-01T00:00:00Z', comment_count: 1, close_source_branch: false }
      const path0 = u.split('?')[0]
      if (e.method === 'POST' && u === `${R}/pullrequests`) return send(201, { id: 5, links: { html: { href: html } } })
      if (u === `${P}/user`) return send(200, meU)
      if (path0 === `${R}/pullrequests` || path0 === `${P}/pullrequests/${encodeURIComponent('{me-1}')}`) return send(200, { values: /state=MERGED/.test(u) ? [] : [pr] })
      if (path0.startsWith(`${P}/user/permissions/repositories`)) return send(200, { values: [{ permission: 'write' }] })
      if (u === `${R}/pullrequests/5`) return send(200, pr)
      if (path0 === `${R}/pullrequests/5/statuses`) return send(200, { values: [{ state: 'SUCCESSFUL' }] })
      if (e.method === 'POST' && u === `${R}/pullrequests/5/approve`) return send(200, { approved: true })
      if (e.method === 'DELETE' && u === `${R}/pullrequests/5/approve`) return send(204, '')
      if (e.method === 'POST' && u === `${R}/pullrequests/5/request-changes`) return send(200, {})
      if (e.method === 'POST' && u === `${R}/pullrequests/5/comments`) return send(201, { id: 9 })
      if (e.method === 'POST' && u === `${R}/pullrequests/5/merge`) return send(200, { ...pr, state: 'MERGED' })
      if (path0 === `${R}/pullrequests/5/comments`) return send(200, { values: [{ content: { raw: 'Nice' }, user: { nickname: 'bob' }, created_on: '2026-01-01T01:00:00Z', inline: { path: 'b.txt', to: 1 } }, { deleted: true, content: { raw: 'gone' }, user: { nickname: 'bob' } }] })
      if (path0 === `${R}/pullrequests/5/commits`) return send(200, { values: [{ hash: 'c0ffee1234', message: 'Do it\n\nbody', author: { raw: 'Me <m@e>' }, date: '2026-01-01T00:00:00Z' }] })
      if (path0 === `${R}/pullrequests/5/diffstat`) return send(200, { values: [{ lines_added: 1, lines_removed: 0 }] })
      if (u === `${R}/pullrequests/5/diff`) return send(200, 'diff --git a/b.txt b/b.txt\n', 'text/plain')
      if (/\/commit\/\w+\/statuses/.test(path0)) return send(200, { values: [{ state: 'FAILED' }] })
    } else {
      const P = '/api/v4'
      const mr = { web_url: `${B}/group/sub/proj/-/merge_requests/3`, iid: 3, project_id: 42, title: 'MR', references: { full: 'group/sub/proj!3' }, author: { username: 'me' }, updated_at: '2026-01-01T00:00:00Z' }
      if (e.method === 'POST' && u === `${P}/projects/group%2Fsub%2Fproj/merge_requests`) return send(201, mr)
      if (u === `${P}/user`) return send(200, { username: 'me' })
      if (u.startsWith(`${P}/merge_requests?`) || u.startsWith(`${P}/projects/group%2Fsub%2Fproj/merge_requests?`)) return send(200, [mr])
      if (u === `${P}/projects/42/merge_requests/3/changes`) return send(200, { title: 'MR', description: 'D', source_branch: 'feature', target_branch: 'main', changes: [{ old_path: 'a.txt', new_path: 'b.txt', diff: '@@ -1 +1 @@\n-a\n+b\n' }], diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' } })
      if (e.method === 'POST' && u === `${P}/projects/42/merge_requests/3/notes`) return send(201, { id: 1 })
      if (e.method === 'POST' && u === `${P}/projects/42/merge_requests/3/approve`) return send(201, {})
      if (e.method === 'PUT' && u === `${P}/projects/42/merge_requests/3/merge`) return send(200, { state: 'merged' })
      if (e.method === 'POST' && u === `${P}/projects/42/merge_requests/3/unapprove`) return send(404, { message: '404 Not Found' })
      if (e.method === 'POST' && u === `${P}/projects/42/merge_requests/3/discussions`) return send(201, { id: 'x' })
      if (u === `${P}/projects/42/merge_requests/3`) return send(200, { head_pipeline: { status: 'success' }, title: 'MR', description: 'D', state: 'opened', author: { username: 'me' }, source_branch: 'feature', target_branch: 'main', sha: 'abc', reviewers: [{ username: 'ann' }, { username: 'bob' }], assignees: [], labels: ['x'], changes_count: '1' })
      if (u === `${P}/projects/42/merge_requests/3/approvals`) return send(200, { approvals_required: 1, approved_by: [{ user: { username: 'ann' } }] })
      if (u.startsWith(`${P}/projects/42/merge_requests/3/notes?`)) return send(200, [{ system: true, body: 'changed', author: { username: 'me' } }, { body: 'Nice', author: { username: 'bob' }, created_at: '2026-01-01T00:00:00Z', position: { new_path: 'b.txt', new_line: 1 } }])
      if (u.startsWith(`${P}/projects/42/merge_requests/3/commits`)) return send(200, [{ id: 'c0ffee1234', title: 'Do it', author_name: 'Me', created_at: '2026-01-01T00:00:00Z' }])
      if (u.startsWith(`${P}/projects/group%2Fsub%2Fproj/repository/commits/`)) return send(200, { last_pipeline: { status: 'failed', web_url: 'x' } })
    }
    send(404, { message: 'no route ' + u })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
process.env.GITX_API_BASE = KIND === 'github' ? `http://127.0.0.1:${port}` : KIND === 'bitbucket' ? `http://127.0.0.1:${port}/2.0` : `http://127.0.0.1:${port}/api/v4`

// ---- repo: pushed to a local bare remote, then the remote URL points at the fake server ----
const bare = path.join(W, 'remote.git')
const repo = path.join(W, 'repo')
g(W, 'init', '--bare', bare)
g(W, 'init', repo)
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
g(repo, 'add', '.')
g(repo, 'commit', '-m', 'first')
g(repo, 'remote', 'add', 'origin', bare)
g(repo, 'push', '-u', 'origin', 'main')
g(repo, 'switch', '-c', 'feature')
fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
g(repo, 'add', '.')
g(repo, 'commit', '-m', 'Add b')
g(repo, 'push', '-u', 'origin', 'feature')
const remotePath = { github: 'o/r', bitbucket: 'ws/repo' }[KIND] || 'group/sub/proj'
g(repo, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/${remotePath}.git`)

// ---- worker with a fake Orca ----
const handlers = {}
const orca = { panels: { handle: (n, f) => (handlers[n] = f), post() {} }, host: { has: () => false, call: async () => ({}) }, commands: { register() {} }, events: { on() {} }, log() {} }
const mod = await import(pathToFileURL(path.resolve(ROOT, '../worker/main.mjs')).href)
mod.default(orca)
const call = (n, a) => handlers[n](a)
const op = (o, args = {}) => handlers.git({ op: o, repo, args })

try {
  // mr.info
  const info = await call('mr.info', { repo, target: 'main' })
  ok(info.kind === KIND && info.path === remotePath && info.host === `127.0.0.1:${port}` && info.protocol === 'http', 'mr.info remote parsed', JSON.stringify(info))
  ok(info.tools.gitLogin === true && info.tools.via === 'git' && info.tools.signedIn === false, 'mr.info tools.gitLogin', JSON.stringify(info.tools))
  ok(!info.needsPush, 'no push needed')
  // web fallback
  const web = await call('mr.create', { repo, target: 'main', title: 'Hello', body: 'Body', web: true })
  ok(KIND === 'github' ? web.url.includes(`/${remotePath}/compare/main...feature?`) : KIND === 'bitbucket' ? web.url.endsWith(`/${remotePath}/pull-requests/new?source=feature&dest=main`) : web.url.includes(`/${remotePath}/-/merge_requests/new?`), 'web url', web.url)
  // create via git login
  log.length = 0
  const cr = await call('mr.create', { repo, target: 'main', title: 'Hello', body: 'Body', draft: true })
  const post = log.find((x) => x.method === 'POST')
  ok(cr.created && cr.number === ({ github: 7, bitbucket: 5 }[KIND] ?? 3) && cr.via === 'git' && /^http/.test(cr.url), 'create result', JSON.stringify(cr))
  if (KIND === 'github') {
    ok(post.auth === 'Bearer TESTTOKEN' && post.ua === 'git-control' && post.accept === 'application/vnd.github+json', 'github headers')
    ok(JSON.stringify(post.body) === JSON.stringify({ title: 'Hello', body: 'Body', head: 'feature', base: 'main', draft: true }), 'github body', JSON.stringify(post.body))
  } else if (KIND === 'bitbucket') {
    const posts = log.filter((x) => x.method === 'POST')
    ok(posts.length === 1 && /^Basic /.test(posts[0].auth || ''), 'bitbucket: Basic user:token, one request', JSON.stringify(posts))
    ok(JSON.stringify(post.body) === JSON.stringify({ title: 'Hello', description: 'Body', source: { branch: { name: 'feature' } }, destination: { branch: { name: 'main' } }, draft: true }), 'bitbucket body', JSON.stringify(post.body))
  } else {
    const posts = log.filter((x) => x.method === 'POST')
    // earlier calls found that this host takes PRIVATE-TOKEN (Bearer was refused once): sent that way at once
    ok(posts.length === 1 && posts[0].pt === 'TESTTOKEN' && !posts[0].auth, 'PRIVATE-TOKEN remembered: one request, no refused Bearer first', JSON.stringify(posts))
    ok(JSON.stringify(posts[posts.length - 1].body) === JSON.stringify({ source_branch: 'feature', target_branch: 'main', title: 'Draft: Hello', description: 'Body' }), 'gitlab body', JSON.stringify(posts[posts.length - 1].body))
  }
  // denied
  deny = true
  const err = await call('mr.create', { repo, target: 'main', title: 'Hello', body: '' }).then(() => null, (e) => e)
  ok(err && /saved Git login .* not allowed/.test(err.message) && err.data?.kind === 'git-login-denied', '401 → clear error', err?.message)
  deny = false
  ok(!JSON.stringify(err?.message || '').includes('TESTTOKEN'), 'token not leaked')
  // inbox
  const inbox = await call('reviews.list', { repo })
  const prov = inbox.providers.find((p) => p.host === `127.0.0.1:${port}`)
  ok(prov && prov.via === 'git' && prov.signedIn, 'inbox provider via git', JSON.stringify(inbox.providers))
  const it = inbox.items.find((x) => x.host === `127.0.0.1:${port}`)
  ok(it && (KIND === 'bitbucket' ? ['review', 'mine', 'repo'] : ['review', 'assigned', 'mine', 'repo']).every((r) => it.roles.includes(r)), 'inbox roles', JSON.stringify(inbox))
  if (KIND === 'bitbucket') {
    ok(it.provider === 'bitbucket' && it.number === 5 && it.repo === 'ws/repo' && it.source === 'feature' && it.target === 'main' && it.author === 'me', 'bitbucket item fields', JSON.stringify(it))
    ok(it.approvedCount === 1 && it.myApproved === false && it.canMerge === true, 'bitbucket approvals and permission', JSON.stringify([it.approvedCount, it.myApproved, it.canMerge]))
  }
  ok(it?.ci === 'passed', 'inbox item CI', it?.ci)
  ok(it?.me === 'me' && typeof it.approvedCount === 'number', 'inbox item knows me and approvals', JSON.stringify([it?.me, it?.approvedCount, it?.myApproved]))
  // review actions
  for (const action of ['approve', 'changes', 'comment']) {
    log.length = 0
    const r = await call('reviews.act', { ...it, action, body: action === 'approve' ? '' : 'Looks off' }).catch((e) => e)
    ok(r?.ok, `review ${action}`, r?.message)
    if (KIND === 'github') ok(log.find((x) => x.url.endsWith('/reviews'))?.body?.event === { approve: 'APPROVE', changes: 'REQUEST_CHANGES', comment: 'COMMENT' }[action], `github ${action} event`)
    if (KIND === 'bitbucket') {
      const sent = log.filter((x) => x.method !== 'GET').map((x) => `${x.method} ${x.url.replace(/^.*\/pullrequests\/5/, '')}`)
      const want = { approve: ['POST /approve'], changes: ['POST /comments', 'DELETE /approve', 'POST /request-changes'], comment: ['POST /comments'] }[action]
      ok(JSON.stringify(sent) === JSON.stringify(want), `bitbucket ${action} calls`, JSON.stringify(sent))
    }
  }
  // merge with options; GitLab: revoke approval too
  log.length = 0
  const mg = await call('reviews.act', { ...it, action: 'merge', options: { squash: true, removeSource: true } }).catch((e) => e)
  ok(mg?.ok && mg.state === 'merged', 'merge', mg?.message)
  const put = log.find((x) => x.method === 'PUT')
  if (KIND === 'github') {
    ok(put?.url === '/repos/o/r/pulls/7/merge' && put.body?.merge_method === 'squash' && put.body?.sha === 'abc123', 'github merge request', JSON.stringify(put))
    ok(log.some((x) => x.method === 'DELETE' && x.url === '/repos/o/r/git/refs/heads/feature'), 'github deletes the head branch')
    const un = await call('reviews.act', { ...it, action: 'unapprove' }).then(() => null, (e) => e)
    ok(un && /GitHub does not let you take back/.test(un.message), 'github revoke explains')
  } else if (KIND === 'bitbucket') {
    const mpost = log.find((x) => x.method === 'POST' && x.url.endsWith('/merge'))
    ok(JSON.stringify(mpost?.body) === JSON.stringify({ type: 'pullrequest_merge_parameters', merge_strategy: 'squash', close_source_branch: true }), 'bitbucket merge request', JSON.stringify(mpost))
    log.length = 0
    const un = await call('reviews.act', { ...it, action: 'unapprove' }).catch((e) => e)
    ok(un?.ok && log.some((x) => x.method === 'DELETE' && x.url.endsWith('/pullrequests/5/approve')), 'bitbucket takes back an approval', un?.message)
  } else {
    // the merge request's own settings are made to match first, then it is merged with them
    const upd = log.find((x) => x.method === 'PUT' && x.url.endsWith('/merge_requests/3'))
    const mput = log.find((x) => x.method === 'PUT' && x.url.endsWith('/merge_requests/3/merge'))
    ok(!upd || (upd.body?.remove_source_branch === true && upd.body?.squash === true), 'gitlab: its own settings follow the choice', JSON.stringify(upd))
    ok(mput && mput.body?.squash === true && mput.body?.should_remove_source_branch === true && !mput.body.merge_when_pipeline_succeeds, 'gitlab merge request', JSON.stringify(mput))
    log.length = 0
    await call('reviews.act', { ...it, action: 'merge', options: { auto: true } }).catch(() => null)
    ok(log.find((x) => x.method === 'PUT')?.body?.merge_when_pipeline_succeeds === true, 'gitlab auto-merge flag')
  }
  const noText = await call('reviews.act', { ...it, action: 'changes', body: '' }).then(() => null, (e) => e)
  ok(noText && /comment first/.test(noText.message), 'changes requires text')
  // the detail page: description, reviewers with their state, approvals, comments, commits
  const det = await call('reviews.detail', it)
  ok(det.title && det.source === 'feature' && det.target === 'main', 'detail basics', JSON.stringify([det.title, det.source, det.target]))
  ok(det.commits.length === 1 && det.commits[0].subject === 'Do it' && det.commits[0].sha === 'c0ffee1234', 'detail commits', JSON.stringify(det.commits))
  const ann = det.reviewers.find((x) => x.name === 'ann')
  ok(ann?.state === 'approved', 'reviewer state from the latest review', JSON.stringify(det.reviewers))
  ok(det.approvals.given === 1, 'approvals given', JSON.stringify(det.approvals))
  ok(det.me === 'me' && det.merge && typeof det.merge.ready === 'boolean', 'detail merge info', JSON.stringify([det.me, det.merge]))
  if (KIND === 'github') {
    ok(!det.reviewers.some((x) => x.name === 'bob'), 'a comment-only review is not a reviewer state', JSON.stringify(det.reviewers))
    ok(det.comments.some((c) => c.file === 'x.js' && c.line === 4) && det.comments.some((c) => c.kind === 'changes'), 'github comments (line + review)', JSON.stringify(det.comments))
  } else if (KIND === 'bitbucket') {
    ok(det.reviewers.find((x) => x.name === 'bob')?.state === 'pending' && det.body === 'D' && det.headSha === 'abc123' && det.stats.add === 1, 'bitbucket waiting reviewer, body, head, stats', JSON.stringify([det.reviewers, det.body, det.headSha, det.stats]))
    ok(det.comments.length === 1 && det.comments[0].file === 'b.txt' && det.comments[0].line === 1, 'bitbucket comments without deleted ones', JSON.stringify(det.comments))
    ok(det.commits[0].author === 'Me', 'bitbucket commit author from raw', JSON.stringify(det.commits))
  } else {
    ok(det.approvals.required === 1 && det.reviewers.find((x) => x.name === 'bob')?.state === 'pending', 'gitlab approvals and waiting reviewer', JSON.stringify([det.approvals, det.reviewers]))
    ok(det.comments.length === 1 && det.comments[0].file === 'b.txt', 'gitlab notes without system notes', JSON.stringify(det.comments))
  }
  // diff + line comment
  const d = await call('reviews.diff', it)
  ok(d.diff.includes('diff --git'), 'reviews.diff', JSON.stringify(d))
  log.length = 0
  const lc = await call('reviews.lineComment', { item: it, path: 'b.txt', line: 1, side: 'new', body: 'nit' }).catch((e) => e)
  ok(lc?.ok, 'line comment', lc?.message)
  const lcPost = log.find((x) => x.method === 'POST')
  if (KIND === 'github') ok(lcPost?.body?.commit_id === 'abc123' && lcPost.body.path === 'b.txt' && lcPost.body.side === 'RIGHT', 'github line comment body', JSON.stringify(lcPost))
  else if (KIND === 'bitbucket') ok(JSON.stringify(lcPost?.body) === JSON.stringify({ content: { raw: 'nit' }, inline: { path: 'b.txt', to: 1 } }), 'bitbucket line comment body', JSON.stringify(lcPost))
  else ok(lcPost?.body?.position?.old_path === 'a.txt' && lcPost.body.position.new_line === 1, 'gitlab renamed old_path', JSON.stringify(lcPost))
  if (KIND === 'bitbucket') {
    // an Atlassian API token: Git signs in with the user name, the API only with the email (Git's user.email here)
    emailOnly = true
    const viaEmail = 'Basic ' + Buffer.from('t@e:TESTTOKEN').toString('base64')
    log.length = 0
    const d1 = await call('reviews.detail', it).catch((e) => e)
    ok(d1?.title === 'PR' && log.some((x) => x.auth === viaEmail), 'bitbucket: API token with the Git email', d1?.message || JSON.stringify(log.map((x) => x.auth)))
    log.length = 0
    await call('reviews.detail', it)
    ok(log.length && log.every((x) => x.auth === viaEmail), 'bitbucket: the email way is remembered (no refused requests first)', JSON.stringify(log.map((x) => x.auth)))
    emailOnly = false
  }
  // CI for the repo
  const ci = await op('ciStatus', {})
  ok(ci.state === (KIND === 'github' ? 'passed' : 'failed'), 'ciStatus', JSON.stringify(ci))
  if (KIND === 'bitbucket') {
    // Bitbucket Pipelines through the same login (tests/bitbucket.mjs covers them in full)
    log.length = 0
    await op('pipelines', {}).catch(() => null)
    ok(log.some((x) => x.method === 'GET' && x.url.startsWith('/2.0/repositories/ws/repo/pipelines/?') && x.url.includes('target.branch=')), 'bitbucket pipelines asked of Bitbucket', JSON.stringify(log.map((x) => x.url)))
  }
  // SSH / enterprise remote parsing
  if (KIND === 'bitbucket') delete process.env.GITX_API_KIND // bitbucket.org is recognised by its name
  g(repo, 'remote', 'set-url', 'origin', { github: 'ssh://git@ghe.corp:2222/o/r.git', bitbucket: 'git@bitbucket.org:ws/repo.git' }[KIND] || 'git@gitlab.corp:group/sub/proj.git')
  const i2 = await call('mr.info', { repo, target: 'main' })
  ok(i2.protocol === 'https' && i2.host === ({ github: 'ghe.corp', bitbucket: 'bitbucket.org' }[KIND] || 'gitlab.corp') && i2.web === `https://${i2.host}/${remotePath}`, 'ssh → https host', JSON.stringify([i2.host, i2.web]))
  if (KIND === 'bitbucket') ok(i2.kind === 'bitbucket' && i2.tools.cli && i2.tools.installed === true && i2.tools.canInstall === false, 'bitbucket.org detected, no CLI to install', JSON.stringify([i2.kind, i2.tools]))
  g(repo, 'remote', 'set-url', 'origin', `https://h.corp:8443/${remotePath}.git`)
  const i3 = await call('mr.info', { repo, target: 'main' })
  ok(i3.host === 'h.corp:8443' && i3.web === `https://h.corp:8443/${remotePath}`, 'https port kept', i3.host)
} catch (e) {
  fails++
  console.log('CRASH', e.stack)
}
console.log(`${KIND}: ${fails ? fails + ' failed' : 'all passed'}`)
process.exit(fails ? 1 : 0)
