// Marketplace and README screenshots: the real Git Control tab on a made-up but realistic project
// ("acme-web") with a fake GitLab API. No real account, host or repository is ever used.
//   node screenshots.mjs <plugin folder> <output folder>
// Writes 1440×900 PNGs (16:10) for orca-plugin.json "screenshots" and the README.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import puppeteer from 'puppeteer-core'

const PLUGIN = process.argv[2]
const OUT = process.argv[3]
mkdirSync(OUT, { recursive: true })
// Chrome where each OS puts it (or CHROME=/path/to/chrome)
const CHROME = process.env.CHROME || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform] || '/usr/bin/google-chrome'

const root = mkdtempSync(path.join(tmpdir(), 'gitx-shots-'))
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'global.gitconfig') // never the person's real config
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Satang B.\n\temail = satang@acme.example\n')
process.env.GIT_CONFIG_NOSYSTEM = '1'
// Hide gh/glab: nothing may reach a real GitHub/GitLab account.
process.env.PATH = process.env.PATH.split(path.delimiter).filter((d) => !['gh.exe', 'glab.exe', 'gh', 'glab'].some((b) => { try { return statSync(path.join(d, b)).isFile() } catch { return false } })).join(path.delimiter)
process.env.GITX_NO_BROWSER = '1'

let browser = null
try {
  // ---------- a realistic little project ----------
  const origin = path.join(root, 'origin.git')
  const code = path.join(root, 'code') // the folder the repos live in (Repos overview shows …\code\name)
  mkdirSync(code)
  const repo = path.join(code, 'acme-web')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, repo])
  const now = Math.floor(Date.now() / 1000)
  let clock = now - 9 * 86400
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
  const write = (f, t) => {
    mkdirSync(path.dirname(path.join(repo, f)), { recursive: true })
    writeFileSync(path.join(repo, f), t)
  }
  const people = [
    ['Satang B.', 'satang@acme.example'],
    ['Mali K.', 'mali@acme.example'],
    ['Niran P.', 'niran@acme.example'],
    ['Ploy S.', 'ploy@acme.example']
  ]
  const commit = (msg, who = 0, step = 3 * 3600) => {
    clock += step
    const [name, email] = people[who]
    execFileSync('git', ['add', '-A'], { cwd: repo })
    execFileSync('git', ['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-qm', msg], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: `${clock} +0700`, GIT_COMMITTER_DATE: `${clock} +0700` } })
  }
  g('config', 'core.autocrlf', 'false')
  write('package.json', '{\n  "name": "acme-web",\n  "version": "1.3.0"\n}\n')
  write('src/app.ts', 'export const app = () => "acme"\n')
  commit('chore: set up the web app with Vite and TypeScript', 0)
  write('src/auth/login.ts', 'export async function login(user: string) {\n  return fetch("/api/login", { method: "POST", body: user })\n}\n')
  commit('feat(auth): sign in with email and password', 1)
  write('src/cart/cart.ts', 'export const cart: string[] = []\n')
  commit('feat(cart): add items to the cart and keep them across reloads', 2)
  g('tag', '-a', 'v1.3.0', '-m', 'v1.3.0')
  g('push', '-q', '-u', 'origin', 'main', '--tags')
  // a finished feature merged back
  g('switch', '-qc', 'feature/checkout-flow')
  write('src/checkout/address.ts', 'export const address = {}\n')
  commit('feat(checkout): shipping address step', 3)
  write('src/checkout/payment.ts', 'export const payment = {}\n')
  commit('feat(checkout): card payment with 3-D Secure', 3)
  write('src/checkout/summary.ts', 'export const summary = {}\n')
  commit('feat(checkout): order summary and confirmation email', 1)
  g('push', '-q', '-u', 'origin', 'feature/checkout-flow')
  g('switch', '-q', 'main')
  write('src/auth/login.ts', 'export async function login(user: string) {\n  return fetch("/api/login", { method: "POST", body: user, signal: AbortSignal.timeout(15000) })\n}\n')
  commit('fix(auth): time out a hanging sign-in after 15 seconds', 2)
  clock += 3600
  execFileSync('git', ['-c', 'user.name=Mali K.', '-c', 'user.email=mali@acme.example', 'merge', '--no-ff', '-q', '-m', "Merge branch 'feature/checkout-flow'", 'feature/checkout-flow'], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: `${clock} +0700`, GIT_COMMITTER_DATE: `${clock} +0700` } })
  write('package.json', '{\n  "name": "acme-web",\n  "version": "1.4.0"\n}\n')
  commit('chore(release): 1.4.0', 0)
  g('tag', '-a', 'v1.4.0', '-m', 'v1.4.0')
  g('push', '-q', 'origin', 'main', '--tags')
  // work in progress on two branches
  g('switch', '-qc', 'feature/search-filters')
  write('src/search/filters.ts', 'export const filters = { price: [0, 100] }\n')
  commit('feat(search): price and brand filters', 0)
  write('src/search/facets.ts', 'export const facets = []\n')
  commit('feat(search): show result counts beside each filter', 0)
  g('push', '-q', '-u', 'origin', 'feature/search-filters')
  write('src/search/url.ts', 'export const toQuery = (f: object) => new URLSearchParams(f as any)\n')
  commit('feat(search): keep the chosen filters in the URL', 0, 5400)
  g('switch', '-q', 'main')
  g('switch', '-qc', 'fix/cart-rounding')
  write('src/cart/total.ts', 'export const total = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100\n')
  commit('fix(cart): round the total to two decimals', 2)
  g('push', '-q', '-u', 'origin', 'fix/cart-rounding')
  g('switch', '-q', 'main')
  write('src/home/hero.tsx', 'export const Hero = () => <h1>Spring sale</h1>\n')
  commit('feat(home): spring sale banner', 1, 4 * 3600)
  g('push', '-q', 'origin', 'main')
  write('src/home/hero.tsx', 'export const Hero = () => <h1>Spring sale: up to 40% off</h1>\n')
  commit('copy(home): say how big the sale is', 3, 2 * 3600)
  // the checked-out branch: search filters, with changes still being made
  g('switch', '-q', 'feature/search-filters')
  write('src/search/filters.ts', 'export const filters = {\n  price: [0, 100],\n  brand: [] as string[],\n  inStock: true\n}\n')
  write('src/search/facets.ts', 'export const facets = []\n\nexport function count(name: string) {\n  return facets.filter((f) => f === name).length\n}\n')
  write('src/search/sort.ts', 'export type Sort = "relevance" | "price-asc" | "price-desc" | "newest"\n')
  // looks like a GitLab project; pushes still go to the local test remote
  g('remote', 'set-url', 'origin', 'https://gitlab.example.test/acme/web.git')
  g('remote', 'set-url', '--push', 'origin', origin.replace(/\\/g, '/'))
  g('config', 'credential.helper', '!f() { echo username=satang; echo password=TESTTOKEN; }; f')
  const head = g('rev-parse', 'HEAD')

  // ---------- fake GitLab ----------
  const iso = (secAgo) => new Date((now - secAgo) * 1000).toISOString()
  const mrs = [
    { iid: 42, title: 'feat(search): price, brand and stock filters', author: 'mali', source: 'feature/search-filters', role: 'review', ago: 1800 },
    { iid: 41, title: 'fix(cart): round the total to two decimals', author: 'satang', source: 'fix/cart-rounding', role: 'mine', ago: 5400 },
    { iid: 39, title: 'feat(account): order history with reorder button', author: 'mali', source: 'feature/order-history', role: 'assigned', ago: 3 * 86400 }
  ]
  const mrJson = (m) => ({ iid: m.iid, project_id: 7, web_url: `https://gitlab.example.test/acme/web/-/merge_requests/${m.iid}`, title: m.title, author: { username: m.author }, source_branch: m.source, target_branch: 'main', updated_at: iso(m.ago), references: { full: `acme/web!${m.iid}` } })
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const u = new URL(req.url, 'http://x')
      const p = u.pathname.replace(/^\/api\/v4/, '')
      const send = (o, code = 200) => (res.writeHead(code, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)))
      if (p === '/user') return send({ id: 1, username: 'satang', login: 'satang', name: 'Satang B.' })
      if (p === '/projects/acme%2Fweb') return send({ id: 7, remove_source_branch_after_merge: true, squash_option: 'default_off' })
      if (p.endsWith('/members/all')) return send([{ id: 1, username: 'satang', name: 'Satang B.' }, { id: 2, username: 'mali', name: 'Mali K.' }, { id: 3, username: 'niran', name: 'Niran P.' }, { id: 4, username: 'ploy', name: 'Ploy S.' }])
      if (/\/merge_requests$/.test(p) && req.method === 'GET') {
        const role = u.search.includes('reviewer_username') ? 'review' : u.search.includes('assignee_username') ? 'assigned' : u.search.includes('author_username') ? 'mine' : 'repo'
        return send(mrs.filter((m) => role === 'repo' || m.role === role).map(mrJson))
      }
      const md = p.match(/^\/projects\/7\/merge_requests\/(\d+)(\/\w+)?$/)
      if (md) {
        const m = mrs.find((x) => x.iid === +md[1]) || mrs[1]
        const sub = md[2] || ''
        if (!sub)
          return send({
            ...mrJson(m),
            state: 'opened',
            description: '## Why\nShoppers asked to narrow long result lists without leaving the page.\n\n## What changed\n- **Price** range, **brand** and **in stock** filters on the results page\n- Each filter shows how many results it leaves\n- Chosen filters stay in the URL, so a search can be shared\n\n## Testing\n- [x] Unit tests for `toQuery` and `count`\n- [x] Manual check on mobile Safari\n- [ ] Product sign-off on the filter order',
            created_at: iso(2 * 86400),
            sha: head,
            labels: ['search', 'frontend'],
            reviewers: [{ username: 'satang' }, { username: 'niran' }],
            assignees: [{ username: 'mali' }],
            changes_count: '6',
            head_pipeline: { status: 'success' },
            detailed_merge_status: 'not_approved',
            squash: true,
            force_remove_source_branch: true,
            user: { can_merge: true }
          })
        if (sub === '/approvals') return send({ approvals_required: 2, approvals_left: 1, approved_by: [{ user: { username: 'niran' } }], user_has_approved: false, user_can_approve: true })
        if (sub === '/notes')
          return send([
            { system: true, body: 'added 3 commits', author: { username: 'mali' } },
            { body: 'Nice. The counts make the filters much easier to trust.', author: { username: 'niran' }, created_at: iso(86400) },
            { body: 'Could the brand list be sorted by result count instead of A–Z?', author: { username: 'niran' }, created_at: iso(20000), position: { new_path: 'src/search/facets.ts', new_line: 4 } },
            { body: 'Good idea, done in the latest commit.', author: { username: 'mali' }, created_at: iso(7200) }
          ])
        if (sub === '/commits')
          return send([
            { id: head, title: 'feat(search): keep the chosen filters in the URL', author_name: 'Mali K.', created_at: iso(5400) },
            { id: head.slice(0, 12) + 'a'.repeat(28), title: 'feat(search): show result counts beside each filter', author_name: 'Satang B.', created_at: iso(86400) },
            { id: head.slice(0, 12) + 'b'.repeat(28), title: 'feat(search): price and brand filters', author_name: 'Satang B.', created_at: iso(2 * 86400) }
          ])
      }
      // the project's recent pipelines: one branch's, or every branch's for the Pipelines tab
      const PIPES = [
        { id: 324, status: 'running', ref: 'refs/merge-requests/142/head', sha: 'c52c11e9a8', source: 'merge_request_event', at: 240, who: ['mali', 'Mali K.'], title: 'feat(search): keep the chosen filters in the URL' },
        { id: 321, status: 'success', ref: 'v1.4.0', tag: true, sha: '024b47e1a2', source: 'push', at: 1500, dur: 346, who: ['satang', 'Satang B.'], title: 'chore(release): 1.4.0' },
        { id: 318, status: 'failed', ref: 'feature/search-filters', sha: head, source: 'push', at: 5000, dur: 412, who: ['satang', 'Satang B.'], title: 'feat(search): price and brand filters' },
        { id: 316, status: 'success', ref: 'main', sha: 'fcfb7493b1', source: 'push', at: 9000, dur: 362, who: ['niran', 'Niran P.'], title: 'fix(cart): round the total once, at the end' },
        { id: 314, status: 'success', ref: 'refs/merge-requests/139/head', sha: '4251660c0d', source: 'merge_request_event', at: 15000, dur: 331, who: ['ploy', 'Ploy S.'], title: 'feat(account): order history page' },
        { id: 311, status: 'success', ref: 'feature/search-filters', sha: head, source: 'push', at: 90000, dur: 388, who: ['satang', 'Satang B.'], title: 'feat(search): show result counts beside each filter' },
        { id: 305, status: 'canceled', ref: 'feature/checkout-flow', sha: '2f1080d7e4', source: 'web', at: 170000, dur: 95, who: ['mali', 'Mali K.'], title: 'feat(checkout): card payment with 3-D Secure' }
      ]
      const pjson = (x) => ({ id: x.id, status: x.status, ref: x.ref, sha: x.sha, source: x.source, web_url: `https://gitlab.example.test/acme/web/-/pipelines/${x.id}`, created_at: iso(x.at), updated_at: iso(x.at - (x.dur || 0)) })
      const pc = p.match(/\/repository\/commits\/([0-9a-f]+)$/)
      if (pc && pc[1] !== head && PIPES.some((x) => x.sha === pc[1])) return send({ title: PIPES.find((x) => x.sha === pc[1]).title })
      if (/\/repository\/commits\/[0-9a-f]+$/.test(p)) return send({ title: 'feat(search): price and brand filters', last_pipeline: { id: 318, status: 'failed', web_url: 'https://gitlab.example.test/acme/web/-/pipelines/318' } })
      if (/\/pipelines$/.test(p)) return send(PIPES.filter((x) => !u.search.includes('ref=') || u.search.includes('ref=' + encodeURIComponent(x.ref))).map(pjson))
      const pd = p.match(/\/pipelines\/(\d+)$/)
      if (pd) {
        const x = PIPES.find((y) => y.id === +pd[1]) || PIPES[0]
        return send({ ...pjson(x), user: { username: x.who[0], name: x.who[1] }, duration: x.dur ?? null, finished_at: x.status === 'running' ? null : iso(x.at - (x.dur || 0)), tag: !!x.tag })
      }
      const pj = p.match(/\/pipelines\/(\d+)\/jobs$/)
      if (pj && +pj[1] === 324) return send([{ id: 9105, name: 'deploy preview', stage: 'deploy', status: 'created' }, { id: 9104, name: 'e2e', stage: 'test', status: 'running' }, { id: 9103, name: 'unit tests', stage: 'test', status: 'success' }, { id: 9101, name: 'build', stage: 'build', status: 'success' }])
      if (pj && +pj[1] !== 318) return send([{ id: 9205, name: 'deploy', stage: 'deploy', status: +pj[1] === 305 ? 'canceled' : 'success' }, { id: 9203, name: 'unit tests', stage: 'test', status: 'success' }, { id: 9201, name: 'build', stage: 'build', status: 'success' }])
      if (/\/pipelines\/\d+\/jobs$/.test(p))
        return send([
          { id: 9001, name: 'install', stage: 'build', status: 'success', duration: 41, web_url: 'https://x/j/9001' },
          { id: 9003, name: 'build', stage: 'build', status: 'success', duration: 96, web_url: 'https://x/j/9003' },
          { id: 9002, name: 'unit tests', stage: 'test', status: 'failed', duration: 128, web_url: 'https://x/j/9002' },
          { id: 9004, name: 'lint', stage: 'test', status: 'success', duration: 37, web_url: 'https://x/j/9004' },
          { id: 9005, name: 'deploy preview', stage: 'deploy', status: 'skipped', duration: null, web_url: 'https://x/j/9005' }
        ])
      if (/\/jobs\/9002\/trace$/.test(p))
        return (res.writeHead(200, { 'Content-Type': 'text/plain' }), res.end(['$ pnpm test --run', '', ' ✓ src/search/url.test.ts (4 tests) 12ms', ' ✓ src/cart/total.test.ts (6 tests) 9ms', ' ✗ src/search/facets.test.ts (3 tests | 1 failed) 21ms', '   × count › counts each brand once', '     AssertionError: expected 2 to be 1', '       at src/search/facets.test.ts:14:27', '', ' Test Files  1 failed | 2 passed (3)', '      Tests  1 failed | 12 passed (13)', 'ERROR: Job failed: exit code 1', ''].join('\n')))
      send([])
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  process.env.GITX_API_BASE = `http://127.0.0.1:${server.address().port}/api/v4`

  // ---------- more repositories beside it (Repos overview) ----------
  const sib = (name, branch = 'main') => {
    const bare = path.join(root, `${name}-origin.git`)
    const dir = path.join(code, name)
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare])
    execFileSync('git', ['clone', '-q', bare, dir])
    const run = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim()
    const put = (f, t) => (mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), writeFileSync(path.join(dir, f), t))
    put('README.md', `# ${name}\n`)
    run('add', '.')
    run('commit', '-qm', 'Initial commit')
    run('push', '-qu', 'origin', 'main')
    if (branch !== 'main') {
      run('switch', '-qc', branch)
      put('src/index.ts', 'export {}\n')
      run('add', '.')
      run('commit', '-qm', `Start ${branch}`)
      run('push', '-qu', 'origin', branch)
    }
    return { dir, bare, run, put }
  }
  const theirs = (repoInfo, branch, n) => {
    const other = path.join(root, path.basename(repoInfo.dir) + '-other')
    execFileSync('git', ['clone', '-q', '-b', branch, repoInfo.bare, other])
    for (let i = 0; i < n; i++) {
      writeFileSync(path.join(other, `change-${i}.md`), `change ${i}\n`)
      execFileSync('git', ['add', '.'], { cwd: other })
      execFileSync('git', ['commit', '-qm', `Teammate change ${i}`], { cwd: other })
    }
    execFileSync('git', ['push', '-q'], { cwd: other })
    rmSync(other, { recursive: true, force: true })
    repoInfo.run('fetch', '-q')
  }
  const api = sib('acme-api', 'feature/checkout-v2')
  theirs(api, 'feature/checkout-v2', 3) // behind by 3
  const admin = sib('acme-admin')
  admin.put('src/orders/table.tsx', 'export const Table = () => null\n')
  admin.run('add', '.')
  admin.run('commit', '-qm', 'Orders table')
  admin.put('src/orders/filters.tsx', 'export const Filters = () => null\n')
  admin.put('README.md', '# acme-admin\n\nOrders and refunds.\n') // 2 changes, 1 to push
  const mobile = sib('acme-mobile', 'release/2.4') // clean
  const ui = sib('shared-ui')
  ui.run('switch', '-qc', 'theme-tokens')
  ui.put('tokens.css', ':root { --brand: teal; }\n')
  ui.run('add', '.')
  ui.run('commit', '-qm', 'Teal brand')
  ui.run('switch', '-q', 'main')
  ui.put('tokens.css', ':root { --brand: indigo; }\n')
  ui.run('add', '.')
  ui.run('commit', '-qm', 'Indigo brand')
  try { ui.run('merge', 'theme-tokens') } catch {} // a merge with a conflict, still open
  sib('acme-docs') // clean
  void mobile

  // made-up Orca Project Groups, so Repo Overview shows its group headings
  const groupsFile = path.join(root, 'groups.json')
  writeFileSync(groupsFile, JSON.stringify({ repos: [[path.join(code, 'acme-web'), 'shop', 0], [path.join(code, 'acme-api'), 'shop', 1], [path.join(code, 'acme-admin'), 'shop', 2], [path.join(code, 'acme-mobile'), 'apps', 0], [path.join(code, 'shared-ui'), 'apps', 1]], groups: [{ id: 'shop', name: 'Shop', order: 0 }, { id: 'apps', name: 'Apps', order: 1 }] }))
  process.env.GITX_GROUPS_JSON = groupsFile

  // ---------- worker + browser ----------
  const { default: activate } = await import(pathToFileURL(path.join(PLUGIN, 'worker/main.mjs')).href)
  const handlers = {}
  activate({
    api: { major: 1, minor: 3 },
    log() {},
    panels: { handle: (n, f) => (handlers[n] = f), post() {} },
    commands: { register: () => ({ dispose() {} }) },
    events: { on: () => ({ dispose() {} }) },
    host: {
      has: (m) => m === 'settings.get' || m === 'workspace.list',
      // acme-web, acme-api and acme-admin are open in Orca; the others are found by scanning the folder
      call: async (m) =>
        m === 'workspace.list'
          ? { workspaces: ['acme-web', 'acme-api', 'acme-admin'].map((n) => ({ name: n, path: path.join(code, n), kind: 'folder', hostId: 'local' })) }
          : { settings: { aiAgent: 'claude', scanFolders: code } }
    }
  })
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  await page.exposeFunction('__orcaRequest', async (name, input) => {
    try {
      return { out: await handlers[name](input) }
    } catch (e) {
      return { error: e.message }
    }
  })
  const REPO = repo.replace(/\\/g, '/')
  await page.evaluateOnNewDocument((repoPath) => {
    document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('dark'))
    window.orca = Object.freeze({
      api: { major: 1, minor: 3 },
      locale: 'en',
      plugin: {
        request: async (name, input) => {
          const r = await window.__orcaRequest(name, input ?? null)
          if (r.error) throw new Error(r.error)
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
  page.on('request', (rq) => {
    const u = new URL(rq.url())
    if (u.hostname !== 'gitx.test') return rq.respond({ status: 404, body: '' })
    const f = path.join(PLUGIN, 'panel', u.pathname.replace(/^\//, ''))
    try {
      rq.respond({ status: 200, contentType: TYPES[path.extname(f)] || 'text/plain', body: readFileSync(f) })
    } catch {
      rq.respond({ status: 404, body: '' })
    }
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, label, ms = 15000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        if (await fn()) return
      } catch {}
      await sleep(150)
    }
    throw new Error('timed out: ' + label)
  }
  const clickText = (sel, text) => until(() => page.$$eval(sel, (els, t) => { const e = els.find((x) => x.textContent.includes(t)); if (e) e.click(); return !!e }, text), `click ${text}`)
  const settle = async () => {
    await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()))
    await page.mouse.move(1430, 890)
    await sleep(500)
  }
  const shot = async (name) => {
    await settle()
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
    console.log('saved', name)
  }

  await page.goto('http://gitx.test/tab.html', { waitUntil: 'domcontentloaded' })
  await until(() => page.$$eval('.commit-row', (r) => r.length > 8), 'graph')
  await page.evaluate(() => localStorage.clear())

  // 1. the graph with a commit's details docked beside it
  await clickText('.commit-row', 'Merge branch')
  await until(() => page.$eval('.sheet.dock', (e) => e.textContent.includes('payment')).catch(() => false), 'docked details')
  await shot('graph')
  await page.keyboard.press('Escape')

  // 2. the Commit tab: files on the left, the diff on the right
  await clickText('.tab', 'Commit')
  await until(() => page.$$eval('.changes-list .item', (r) => r.length >= 3), 'changes listed')
  await clickText('.changes-list .item', 'filters.ts')
  await until(() => page.$('.diff-pane .dv .l').then(Boolean), 'diff shown')
  await page.$eval('.commit-box textarea', (t) => ((t.value = 'feat(search): in-stock filter and sort order'), t.dispatchEvent(new Event('input', { bubbles: true }))))
  await shot('commit')

  // 3. a merge request read in full before deciding
  await clickText('.tab', 'MR / PR')
  await until(() => page.$$eval('.review-row', (r) => r.length >= 2), 'merge requests listed')
  await clickText('.review-row', 'price, brand and stock')
  await until(() => page.$eval('.mr-detail .mrd-thread', (t) => t.textContent.includes('sorted by result count')).catch(() => false), 'detail page')
  await shot('merge-request')
  await page.keyboard.press('Escape')

  // 4. a failed pipeline: jump straight to the error
  await clickText('.tab', 'Graph')
  await until(() => page.$('.ci.ci-failed').then(Boolean), 'CI badge')
  await page.$eval('.ci.ci-failed', (b) => b.click())
  await until(() => page.$$eval('.pipe-row', (r) => r.length >= 2), 'pipelines')
  await clickText('.pipe-row', '#318')
  await until(() => page.$('.pipe-failed').then(Boolean), 'failed jobs')
  await clickText('.pipe-failed .btn', 'Show the error')
  await until(() => page.$('.pipe-log .pl.cur').then(Boolean), 'error line')
  await shot('pipeline')
  await page.keyboard.press('Escape')

  // 5. a new merge request with reviewers picked from the project
  await until(() => page.$('.commit-row').then(Boolean), 'graph again')
  await page.evaluate(() => [...document.querySelectorAll('#side .item')].find((x) => x.textContent.trim().startsWith('main'))?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 200 })))
  await clickText('.menu button', 'Merge request')
  await clickText('.menu button', 'feature/search-filters → main')
  await until(() => page.$('.mr-dialog').then(Boolean), 'MR dialog')
  await sleep(1500)
  await shot('new-merge-request')
  await page.keyboard.press('Escape')

  // 6. the Pipelines tab: every branch's runs on one page
  await clickText('.tab', 'Pipelines')
  await until(() => page.$$eval('.pipe-list .pipe-row', (r) => r.length >= 6), 'pipelines tab')
  await sleep(600)
  await shot('pipelines')

  // 7. Repos overview: every repository at once
  await page.click('.rov-nav-btn')
  await until(() => page.$$eval('.rov-row', (r) => r.length >= 6), 'repos overview')
  await until(() => page.$('.rov-row .ci').then(Boolean), 'CI on acme-web', 20000).catch(() => {})
  await sleep(600)
  await shot('repos-overview')

  // 8. tag several repos at once: tick them, Tag…, everything filled in
  await page.evaluate(() => {
    for (const r of document.querySelectorAll('.rov-row')) if (/acme-(web|api|admin)/.test(r.textContent)) r.querySelector('.rov-pick')?.click()
  })
  await until(() => page.$('.rov-tag-btn').then(Boolean), 'tag button')
  await page.click('.rov-tag-btn')
  await until(() => page.$$eval('.tag-many-dialog .tm-name', (i) => i.length >= 2), 'tag window', 30000)
  await sleep(800)
  await shot('tag-many')
  await page.keyboard.press('Escape')
} catch (e) {
  console.log('FAILED', e.stack)
  process.exitCode = 1
} finally {
  await browser?.close()
  process.exit(process.exitCode || 0)
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
}
