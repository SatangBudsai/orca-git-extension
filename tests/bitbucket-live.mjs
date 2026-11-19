// Bitbucket Cloud for real: the worker and the panel against the real api.bitbucket.org, on a public
// repository (bitbucketpipelines/bitbucket-pipes-toolkit by default), with no account.
// A small proxy sits between them: it strips the login (public repositories answer without one),
// answers only /user with a made-up person (that one needs an account), and refuses every write, so
// the test never changes anything on Bitbucket. It checks that Bitbucket's real answers come out right:
// the pull request list, merged ones, a pull request's page, Pipelines with their steps and a step's log.
// node tests/bitbucket-live.mjs <plugin folder> <shots folder> [workspace/repo]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const PLUGIN = path.resolve(process.argv[2] || '..')
const SHOTS = path.resolve(process.argv[3] || '../.orca/e2e')
const FULL = process.argv[4] || 'bitbucketpipelines/bitbucket-pipes-toolkit'
mkdirSync(SHOTS, { recursive: true })
const CHROME = process.env.CHROME || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform] || '/usr/bin/google-chrome'
const HOST = 'bitbucket.org'
const REAL = 'https://api.bitbucket.org'

let fails = 0
const ok = (cond, name, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' :: ' + String(extra).slice(0, 500) : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- the proxy: reads only, no login ----------
const ME = { uuid: '{00000000-0000-0000-0000-00000000beef}', nickname: 'tester', display_name: 'Test Person', links: { avatar: { href: '' } } }
const seen = []
// Bitbucket allows few requests without an account (per address, per hour): each real answer is kept on
// disk, so running the test again asks only for what it has not seen (GITX_LIVE_FRESH=1 asks again)
const CACHE = path.join(tmpdir(), 'gitx-bblive-cache')
mkdirSync(CACHE, { recursive: true })
let asked = 0
const writes = []
const server = http.createServer(async (rq, rs) => {
  const send = (code, body, type = 'application/json') => {
    rs.writeHead(code, { 'Content-Type': type })
    rs.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  if (rq.method !== 'GET') {
    writes.push(`${rq.method} ${rq.url}`)
    return send(405, { type: 'error', error: { message: 'this test only reads' } })
  }
  if (rq.url === '/2.0/user') return send(200, ME)
  const file = path.join(CACHE, createHash('sha1').update(rq.url).digest('hex') + '.json')
  if (!process.env.GITX_LIVE_FRESH && existsSync(file)) {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    seen.push({ path: rq.url, status: c.status })
    return send(c.status, c.body, c.type)
  }
  try {
    asked++
    const r = await fetch(REAL + rq.url, { headers: { Accept: rq.headers.accept || 'application/json', 'User-Agent': 'git-control-test' }, signal: AbortSignal.timeout(30000) })
    seen.push({ path: rq.url, status: r.status })
    const body = await r.text()
    const type = r.headers.get('content-type') || 'application/json'
    if (r.status !== 429 && r.status < 500) writeFileSync(file, JSON.stringify({ status: r.status, type, body }))
    send(r.status, body, type)
  } catch (e) {
    seen.push({ path: rq.url, status: 0 })
    send(502, { type: 'error', error: { message: String(e.message) } })
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GITX_API_BASE = `http://127.0.0.1:${server.address().port}/2.0`
process.env.GITX_NO_BROWSER = '1'
process.env.GITX_BB_RETRY = '300'

// ---------- a local repository whose remote is the real one (it is not cloned) ----------
const viaProxy = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`)).json()
const meta = await viaProxy(`/2.0/repositories/${FULL}`)
const MAIN = meta.mainbranch?.name || 'master'
const root = mkdtempSync(path.join(tmpdir(), 'gitx-bblive-'))
const GLOBAL_CFG = path.join(root, 'global.gitconfig')
// a made-up saved login for bitbucket.org, only in this test's own Git config (the proxy drops it)
writeFileSync(GLOBAL_CFG, `[user]\n\tname = Tester\n\temail = t@e2e.test\n[init]\n\tdefaultBranch = ${MAIN}\n[credential]\n\thelper = "!f() { if [ \\"$1\\" = get ] && grep -q 'host=${HOST}'; then echo username=u; echo password=NOTAREALTOKEN; fi; }; f"\n`)
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'
process.env.PATH = process.env.PATH.split(path.delimiter).filter((d) => !['gh.exe', 'glab.exe', 'gh', 'glab'].some((b) => { try { return statSync(path.join(d, b)).isFile() } catch { return false } })).join(path.delimiter)
const repo = path.join(root, 'app')
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
execFileSync('git', ['init', '-q', '-b', MAIN, repo])
writeFileSync(path.join(repo, 'a.txt'), 'a\n')
g('add', '.'), g('commit', '-qm', 'First')
writeFileSync(path.join(repo, 'b.txt'), 'b\n')
g('add', '.'), g('commit', '-qm', 'Second')
g('remote', 'add', 'origin', `https://${HOST}/${FULL}.git`)
g('update-ref', `refs/remotes/origin/${MAIN}`, 'HEAD')
const REPO = repo.replace(/\\/g, '/')

// ---------- the worker ----------
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

let browser = null
let openItem = null
let failedPipe = null
let logGone = false
try {
  console.log(`real Bitbucket: ${FULL} (main branch ${MAIN})`)
  // ===================== the worker =====================
  const r = await call('reviews.list', { repo: REPO, fresh: true })
  const prov = r.providers.find((x) => x.host === HOST)
  const mine = r.items.filter((x) => x.host === HOST)
  ok(prov?.signedIn === true && prov.kind !== 'github', 'bitbucket.org is recognised and connected', JSON.stringify(prov))
  ok(mine.length === (await viaProxy(`/2.0/repositories/${FULL}/pullrequests?state=OPEN&pagelen=1`)).size, 'the open pull requests, as many as Bitbucket has', JSON.stringify(mine.map((x) => x.number)))
  ok(mine.every((x) => x.number > 0 && x.title && x.author && x.source && x.target && x.url.startsWith('https://bitbucket.org/') && x.repo === FULL), 'each with number, title, author, branches and link', JSON.stringify(mine[0]))
  console.log('      list errors:', JSON.stringify(r.errors))
  openItem = mine[0] || null

  const merged = await call('reviews.moreMerged', { repo: REPO })
  const mItems = merged.items.filter((x) => x.host === HOST)
  ok(mItems.length > 0 && mItems.every((x) => x.state === 'merged' && x.number > 0), 'merged pull requests (the All view)', JSON.stringify(mItems.slice(0, 3).map((x) => [x.number, x.state])))

  for (const it of [openItem, mItems[0]].filter(Boolean)) {
    const d = await call('reviews.detail', it)
    ok(d.provider === 'bitbucket' && d.title && d.author && d.source && d.target && /^[0-9a-f]{12,40}$/.test(d.headSha), `pull request #${it.number}: title, author, branches, commit`, JSON.stringify({ t: d.title, a: d.author, s: d.source, h: d.headSha }))
    ok(d.commits.length > 0 && d.commits.every((c) => c.sha && c.subject && c.at > 0), `pull request #${it.number}: its commits`, JSON.stringify(d.commits.slice(0, 2)))
    ok(d.stats.files > 0 && d.stats.add !== null, `pull request #${it.number}: files and lines changed`, JSON.stringify(d.stats))
    ok(d.canApprove === true && !d.approveBlock, `pull request #${it.number}: Approve offered (not mine)`, JSON.stringify([d.canApprove, d.approveBlock]))
    ok(Array.isArray(d.comments) && d.comments.every((c) => c.author && c.at > 0), `pull request #${it.number}: ${d.comments.length} comments read`, '')
  }

  const pipes = await op('pipelines', { all: true })
  ok(pipes.kind === 'bitbucket' && pipes.items.length > 0 && pipes.web === `https://bitbucket.org/${FULL}/pipelines`, 'Pipelines: the real ones are listed', JSON.stringify(pipes).slice(0, 300))
  ok(pipes.items.every((p) => /^#\d+$/.test(p.name) && p.state && p.state !== 'unknown' && p.url.includes('/pipelines/results/')), 'each with number, state and link', JSON.stringify(pipes.items.map((p) => [p.name, p.state])))
  ok(pipes.items.some((p) => p.sha && p.at > 0 && p.branch), 'with commit, time and branch', JSON.stringify(pipes.items[0]))
  ok(pipes.items.some((p) => p.stages?.length > 0), 'with their steps as dots', JSON.stringify(pipes.items.map((p) => p.stages?.length)))
  ok(pipes.items.some((p) => p.commitTitle), 'with the commit message', JSON.stringify(pipes.items.map((p) => p.commitTitle).slice(0, 3)))
  const br = pipes.items.find((p) => p.branch && !p.tag)?.branch // the tab filters by branch (a tag is not one)
  if (br) {
    const one = await op('pipelines', { branch: br })
    ok(one.items.length > 0 && one.items.every((p) => p.branch === br), `one branch's pipelines (${br}): the filter works on the real API`, JSON.stringify(one.items.map((p) => [p.name, p.branch])))
  }
  const sha = pipes.items.find((p) => p.sha)?.sha
  if (sha) {
    const bySha = await op('pipelines', { sha })
    ok(bySha.items.length > 0 && bySha.items.every((p) => sha.startsWith(p.sha) || p.sha.startsWith(sha.slice(0, 7))), 'one commit\'s pipelines: the filter works on the real API', JSON.stringify(bySha.items.map((p) => [p.name, p.sha])))
  }
  failedPipe = pipes.items.find((p) => p.state === 'failed') || pipes.items.find((p) => p.state === 'success') || pipes.items[0]
  const jobs = await op('pipelineJobs', { id: failedPipe.id })
  ok(jobs.length > 0 && jobs.every((j) => j.id.includes('~') && j.name && j.state), `pipeline ${failedPipe.name} (${failedPipe.state}): its steps`, JSON.stringify(jobs.map((j) => [j.name, j.state])))
  const job = jobs.find((j) => j.state === 'failed') || jobs.find((j) => j.state === 'success') || jobs[0]
  // without an account Bitbucket answers every step log with 404 ("not a valid uuid"): then the page must say so
  const log = await op('jobLog', { id: job.id }).then((x) => x, (e) => ({ error: e.message }))
  if (log.error) ok(/did not give this step's log/.test(log.error), `step "${job.name}": Bitbucket gives no log without an account, and the page says why`, log.error)
  else ok(typeof log.log === 'string' && log.log.length > 50 && !log.log.includes('\x1b'), `step "${job.name}": its log (${log.log.length} characters, no colour codes)`, log.log.slice(0, 200))
  logGone = !!log.error
  const people = await call('mr.people', { repo: REPO, query: '' }).then((x) => x, (e) => ({ error: e.message }))
  ok(!people.error, 'new pull request people: no crash without workspace access', JSON.stringify(people).slice(0, 300))
  ok(writes.length === 0, 'nothing was written to Bitbucket', writes.join(' | '))
  const odd = seen.filter((s) => s.status >= 500 || s.status === 0)
  ok(!odd.length, 'Bitbucket answered every request', JSON.stringify(odd))
  const limited = seen.filter((s) => s.status === 429)
  ok(!limited.length, 'Bitbucket did not limit this run (without an account it allows few requests an hour)', JSON.stringify(limited.slice(0, 3)))
  console.log(`      ${seen.length} requests, ${asked} sent to Bitbucket, the rest from the last runs`)
  const bad = seen.filter((s) => s.status === 400)
  ok(!bad.length, 'no request Bitbucket called malformed (HTTP 400)', JSON.stringify(bad))
  console.log('      Bitbucket answered:', [...new Set(seen.map((s) => `${s.status} ${s.path.replace(/\?.*/, '').replace(/\{[^}]+\}|%7B[^%]+%7D/gi, '{id}').replace(/\/\d+/g, '/N')}`))].join('\n        '))

  // ===================== the panel, with the real data =====================
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
  async function until(fn, label, ms = 30000) {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        const v = await fn()
        if (v) return v
      } catch {}
      await sleep(150)
    }
    throw new Error(`timed out: ${label}`)
  }
  const clickText = (sel, text) => until(() => page.evaluate((sel, text) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text) && !e.disabled); if (!el) return false; el.click(); return true }, sel, text), `click "${text}" in ${sel}`)
  const textOf = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((e) => e.textContent).join('\n'), sel)
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, `bitbucket-live-${name}.png`) })
  const step = async (name, fn) => {
    try {
      await fn()
    } catch (e) {
      ok(false, name, e.message)
      await shot('fail-' + name.replace(/\W+/g, '-').slice(0, 40)).catch(() => {})
    }
  }

  process.env.GITX_REVIEWS_POLL = '1'
  await page.goto('http://gitx.test/tab.html', { waitUntil: 'domcontentloaded' })
  await until(() => page.$$eval('.commit-row', (r) => r.length >= 2), 'graph rows')

  await step('UI: the real pull request list', async () => {
    await clickText('.tab', 'MR / PR')
    if (openItem) {
      await until(() => page.evaluate((t) => [...document.querySelectorAll('.review-row')].some((r) => r.textContent.includes(t)), openItem.title), 'the open pull request')
      ok((await textOf('.review-row')).includes(`#${openItem.number}`), 'UI: the open pull request listed with its number', await textOf('.review-row'))
    }
    ok(!(await page.$('.setup-card')), 'UI: no Connect card (signed in)')
    await shot('1-list')
  })

  if (openItem) await step('UI: a real pull request page', async () => {
    await clickText('.review-row', openItem.title)
    await until(() => page.$('.mrw-approve'), 'Approve button')
    await until(() => page.evaluate(() => /Commits\s*\d/.test(document.body.textContent) && /\d+ files? \+\d+/.test(document.body.textContent)), 'its commits and changes counted')
    ok(true, 'UI: the page opens with Approve, commits and files')
    await shot('2-pr-page')
    await page.keyboard.press('Escape')
    await sleep(300)
  })

  await step('UI: merged pull requests in All', async () => {
    await clickText('.tab', 'MR / PR')
    await clickText('.seg button, .chip, button', 'All')
    await until(() => page.evaluate((t) => [...document.querySelectorAll('.review-row')].some((r) => r.textContent.includes(t)), mItems[0].title), 'a merged one')
    ok(true, 'UI: merged pull requests show in All')
    await shot('3-all-merged')
  })

  await step('UI: the real Pipelines', async () => {
    await clickText('.tab', 'Pipelines')
    await until(() => page.$$eval('.pipes-tab .pipe-row', (r) => r.length > 0), 'pipelines')
    const toggle = await page.evaluate(() => [...document.querySelectorAll('.pipes-tab button, .pipes-tab .chip')].find((b) => /all branches/i.test(b.textContent)))
    if (toggle) await clickText('.pipes-tab button, .pipes-tab .chip', 'All branches').catch(() => {})
    await until(() => page.$$eval('.pipes-tab .pc-dot', (d) => d.length > 0), 'step dots')
    ok((await textOf('.pipes-tab .history-bar')).includes('Bitbucket Pipelines'), 'UI: Bitbucket Pipelines with steps and commit messages')
    await shot('4-pipelines')
    await clickText('.pipes-tab .pipe-row', failedPipe.name)
    await until(() => page.$$eval('.pipe-job', (j) => j.length > 0), 'the steps')
    ok(true, `UI: pipeline ${failedPipe.name}'s steps`)
    await shot('5-steps')
    const hasErr = await page.$('.pipe-failed .btn')
    if (hasErr) await clickText('.pipe-failed .btn', 'Show the error')
    else await page.click('.pipe-job')
    if (logGone) {
      await until(() => page.evaluate(() => document.body.textContent.includes("did not give this step's log")), 'the reason there is no log')
      ok(!!(await page.$('.pipe-log-open')), 'UI: no log from Bitbucket: the page says why, with a button to open the step on Bitbucket')
    } else {
      await until(() => page.$$eval('.pipe-log .pl', (l) => l.length > 3), 'the log')
      ok(true, 'UI: a step\'s real log')
    }
    await shot('6-log')
  })
  ok(!pageErrors.length, 'UI: no page errors', pageErrors.join(' | '))
} catch (e) {
  ok(false, 'ran to the end', e.stack)
} finally {
  await browser?.close().catch(() => {})
  server.close()
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
