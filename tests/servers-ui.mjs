// Servers in the panel, clicked through in headless Chrome: projects on SSH servers in the repository
// menu, the Servers page (one that cannot be reached shows how to fix it), adding a server by name,
// the ⋯ menu of a row, a server repository's header badge, and Repo Overview grouping by server. The
// real worker answers; ssh is a stand-in that runs the command on this machine, each server with its
// own home folder, so no real host is ever contacted.
//   node servers-ui.mjs <plugin folder> [shots folder]   (shots: also saves the README screenshots)
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { default: puppeteer } = await import('puppeteer-core')

const PLUGIN = path.resolve(process.argv[2] || '..')
const SHOTS = process.argv[3] ? path.resolve(process.argv[3]) : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
// Chrome where each OS puts it (or CHROME=/path/to/chrome)
const CHROME = process.env.CHROME || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform] || '/usr/bin/google-chrome'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))
const W = mkdtempSync(path.join(process.platform === 'win32' ? HERE : tmpdir(), process.platform === 'win32' ? '.tmp-servers-ui-' : 'gitx-servers-ui-'))
process.env.GIT_CONFIG_GLOBAL = path.join(W, 'global.gitconfig') // never the person's real config
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Satang B.\n\temail = satang@acme.example\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GITX_NO_BROWSER = '1'

const results = []
const ok = (c, name, extra = '') => (results.push([!!c, name]), console.log(`${c ? 'PASS' : 'FAIL'} ${name}${!c && extra ? ' :: ' + extra : ''}`))
let browser = null
try {
  // ---------- servers: each one a home folder here; gpu-lab refuses the key ----------
  const homes = { 'office-server': path.join(W, 'office-server'), 'build-box': path.join(W, 'build-box') }
  let clock = Math.floor(Date.now() / 1000) - 6 * 86400
  const project = (home, rel, commits) => {
    const dir = path.join(home, rel)
    mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init', '-q', dir])
    for (const [file, msg, who] of commits) {
      clock += 5 * 3600
      writeFileSync(path.join(dir, file), `${msg}\n`)
      execFileSync('git', ['add', '-A'], { cwd: dir })
      execFileSync('git', ['-c', `user.name=${who}`, '-c', `user.email=${who.split(' ')[0].toLowerCase()}@acme.example`, 'commit', '-qm', msg], { cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: `${clock} +0700`, GIT_COMMITTER_DATE: `${clock} +0700` } })
    }
    return dir
  }
  const api = project(homes['office-server'], 'work/acme-api', [
    ['README.md', 'chore: set up the API service', 'Satang B.'],
    ['orders.ts', 'feat(orders): list and filter orders', 'Mali K.'],
    ['refunds.ts', 'feat(refunds): partial refunds', 'Niran P.'],
    ['orders.ts', 'fix(orders): totals with discounts', 'Mali K.']
  ])
  execFileSync('git', ['switch', '-qc', 'feature/webhooks'], { cwd: api })
  writeFileSync(path.join(api, 'hooks.ts'), 'export const hooks = []\n')
  execFileSync('git', ['add', '-A'], { cwd: api })
  execFileSync('git', ['commit', '-qm', 'feat(webhooks): send order events'], { cwd: api })
  execFileSync('git', ['switch', '-q', 'main'], { cwd: api })
  writeFileSync(path.join(api, 'orders.ts'), 'export const orders = [] // paging\n') // a change in progress
  project(homes['office-server'], 'work/infra', [['main.tf', 'chore: staging cluster', 'Ploy S.']])
  project(homes['office-server'], 'work/acme-web/node_modules/left-pad', [['index.js', 'dependency', 'x']]) // skipped
  project(homes['build-box'], 'ci/runner', [['run.sh', 'ci: build and test on push', 'Niran P.']])

  // the stand-in ssh (a Node script, so this runs on Windows, macOS and Linux): each server its own
  // home; gpu-lab refuses the key
  process.env.FAKE_SSH_G = JSON.stringify({
    'office-server': 'hostname 10.0.0.5\nport 22\nuser satang\n',
    'build-box': 'hostname 10.0.0.9\nport 22\nuser ci\n',
    'gpu-lab': 'hostname 10.0.4.17\nport 22\nuser satang\n'
  })
  process.env.FAKE_SSH_HOMES = JSON.stringify({ 'office-server': homes['office-server'], 'build-box': homes['build-box'] })
  process.env.GIT_CONTROL_SSH = path.join(HERE, 'fake-ssh.mjs')
  process.env.GIT_CONTROL_SSH_NO_MUX = '1'
  const sshConfig = path.join(W, 'ssh_config')
  writeFileSync(sshConfig, 'Host office-server\n  HostName 10.0.0.5\nHost build-box\n  HostName 10.0.0.9\n  User ci\nHost gpu-lab\n  HostName 10.0.4.17\n')
  process.env.GIT_CONTROL_SSH_CONFIG = sshConfig
  // Orca's SSH hosts: office-server and gpu-lab (build-box is added in the panel)
  process.env.FAKE_ORCA_HOSTS = JSON.stringify([{ kind: 'local', name: 'this machine', id: 'local' }, { kind: 'ssh', name: 'office-server', id: 'tgt-office' }, { kind: 'ssh', name: 'gpu-lab', id: 'tgt-gpu' }])
  process.env.GIT_CONTROL_ORCA_BIN = path.join(HERE, 'fake-orca.mjs')

  // ---------- a local repository, open in Orca ----------
  const local = project(path.join(W, 'code'), 'acme-web', [
    ['index.html', 'chore: set up the web app', 'Satang B.'],
    ['cart.ts', 'feat(cart): add to cart', 'Mali K.']
  ])

  // ---------- worker + browser ----------
  const { default: activate } = await import(pathToFileURL(path.join(PLUGIN, 'worker/main.mjs')).href)
  const handlers = {}
  const storage = new Map()
  activate({
    api: { major: 1, minor: 5 },
    log() {},
    panels: { handle: (n, f) => (handlers[n] = f), post() {} },
    commands: { register: () => ({ dispose() {} }) },
    events: { on: () => ({ dispose() {} }) },
    host: {
      has: (m) => ['settings.get', 'workspace.list', 'storage.get', 'storage.set'].includes(m),
      call: async (m, p) => {
        if (m === 'storage.get') return { value: storage.has(p.key) ? JSON.parse(storage.get(p.key)) : null }
        if (m === 'storage.set') return storage.set(p.key, JSON.stringify(p.value)), { ok: true }
        if (m === 'workspace.list') return { workspaces: [{ id: 'ws-web', name: 'acme-web', path: local, kind: 'folder', hostId: 'local' }], truncated: false }
        return { settings: { aiAgent: 'claude' } }
      }
    }
  })
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.exposeFunction('__orcaRequest', async (name, input) => {
    try {
      return { out: await handlers[name](input) }
    } catch (e) {
      return { error: e.message }
    }
  })
  await page.evaluateOnNewDocument((repoPath) => {
    document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('dark'))
    window.orca = Object.freeze({
      api: { major: 1, minor: 5 },
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
  }, local)
  await page.setRequestInterception(true)
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  page.on('request', (rq) => {
    const u = new URL(rq.url())
    if (u.hostname !== 'gitx.test') return rq.respond({ status: 404, body: '' })
    try {
      const f = path.join(PLUGIN, 'panel', u.pathname.replace(/^\//, ''))
      rq.respond({ status: 200, contentType: TYPES[path.extname(f)] || 'text/plain', body: readFileSync(f) })
    } catch {
      rq.respond({ status: 404, body: '' })
    }
  })
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, label, ms = 20000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        if (await fn()) return true
      } catch {}
      await sleep(150)
    }
    throw new Error('timed out: ' + label)
  }
  const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()))
  const clickText = (sel, text) => until(() => page.$$eval(sel, (els, t) => { const e = els.find((x) => x.textContent.includes(t)); if (e) e.click(); return !!e }, text), `click ${text}`)
  const shot = async (name, clip) => {
    if (!SHOTS) return
    await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()))
    await sleep(400)
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...(clip ? { clip } : {}) })
    console.log('saved', name)
  }

  await page.goto('http://gitx.test/tab.html', { waitUntil: 'domcontentloaded' })
  await until(() => page.$$eval('.commit-row', (r) => r.length >= 2), 'graph of the local repo')
  ok(await page.$eval('#repoHost', (e) => e.hidden), 'a local repository has no server badge')

  // 1. the repository menu lists the servers' projects, marked with the server
  await page.click('#repoBtn')
  await until(async () => (await texts('.menu .label')).some((t) => t.includes('acme-api · office-server')), 'server projects in the menu')
  const heads = await texts('.menu .label')
  ok(heads.some((t) => t === 'infra · office-server') && !heads.some((t) => /left-pad/.test(t)), 'menu: projects found on the server, dependency folders skipped', heads.join(' | '))
  ok(!heads.some((t) => /gpu-lab/.test(t)), 'menu: nothing from the server that cannot be reached')
  const serversItem = await texts('.menu button')
  ok(serversItem.some((t) => /^Servers/.test(t) && /1 unreachable/.test(t)), 'menu: Servers… says one cannot be reached', serversItem.join(' | '))
  await shot('ssh-repo-menu', { x: 0, y: 0, width: 720, height: 560 })

  // 2. the Servers page: name and status per row, the steps to fix only on the unreachable one
  await clickText('.menu button', 'Servers')
  await until(() => page.$$eval('.server-row', (r) => r.length === 2), 'two servers listed')
  const rows = await page.$$eval('.server-row', (rs) => rs.map((r) => ({ name: r.querySelector('.server-name')?.textContent, pill: r.querySelector('.pill')?.textContent, error: r.querySelector('.server-error')?.textContent || '', buttons: r.querySelectorAll('.row > button').length })))
  const office = rows.find((r) => r.name === 'office-server')
  const gpu = rows.find((r) => r.name === 'gpu-lab')
  ok(office && office.pill === '2 projects' && !office.error && office.buttons === 1, 'office-server: its name, "2 projects", and only a ⋯ button', JSON.stringify(office))
  ok(gpu && gpu.pill === 'Can’t connect' && /To fix it:/.test(gpu.error) && /1\. In a terminal.*ssh -o BatchMode=yes gpu-lab/.test(gpu.error) && /ssh-copy-id gpu-lab/.test(gpu.error), 'gpu-lab: Can’t connect, with step-by-step instructions', JSON.stringify(gpu))
  const intro = await page.$eval('.servers-intro', (e) => e.textContent)
  ok(!/ssh\/config|BatchMode|user@host|ssh-copy-id|password/.test(intro), 'no ssh details up front', intro)

  // 3. Add server: one field, the SSH hosts suggested as you type
  await clickText('.sheet-head button', 'Add server')
  await until(() => page.$('.dialog .combo input'), 'add dialog')
  const fields = await page.$$eval('.dialog .field', (f) => f.length)
  ok(fields === 1, 'Add server asks for one thing: the server', String(fields))
  ok(!(await page.$eval('.dialog', (d) => d.textContent)).match(/ssh\/config|user@host|BatchMode|Folders/), 'no ssh details or folders in the dialog')
  await page.type('.dialog .combo input', 'b')
  await until(async () => (await texts('.combo-item .combo-value')).includes('build-box'), 'suggestion')
  // the dialog with its suggestion list, and a margin around it
  const box = await page.evaluate(() => {
    const r = [document.querySelector('.dialog'), document.querySelector('.combo-list')].map((e) => e.getBoundingClientRect())
    const x = Math.min(...r.map((b) => b.left)) - 32
    const y = Math.min(...r.map((b) => b.top)) - 32
    return { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(...r.map((b) => b.right)) - x + 32, height: Math.max(...r.map((b) => b.bottom)) - y + 32 }
  })
  await shot('ssh-add-server', box)
  // a real press: the list picks on mousedown
  for (const it of await page.$$('.combo-item')) if ((await it.evaluate((e) => e.textContent)).includes('build-box')) await it.click()
  ok((await page.$eval('.dialog .combo input', (i) => i.value)) === 'build-box', 'a suggestion picked fills the field')
  await page.click('.dialog button[type=submit]')
  await until(() => page.$$eval('.server-row', (r) => r.some((x) => x.textContent.includes('build-box') && x.textContent.includes('1 project'))), 'build-box added and searched', 30000)
  ok(true, 'a server added by its name, searched in ~ by default')
  await page.mouse.move(1430, 890)
  await shot('servers')

  // 4. the ⋯ menu of a row holds the rest
  await page.$$eval('.server-row', (rs) => rs.find((r) => r.textContent.includes('build-box')).querySelector('.server-more').click())
  const more = await texts('.menu button')
  ok(['Search again', 'Folders to search', 'Hide from the menu', 'Remove'].every((l) => more.some((t) => t.startsWith(l))), '⋯: search again, folders, hide, remove', more.join(' | '))
  ok(more.some((t) => t.startsWith('Folders to search') && t.includes('~')), 'folders: ~ by default')
  await page.keyboard.press('Escape')
  await page.$$eval('.server-row', (rs) => rs.find((r) => r.textContent.includes('office-server')).querySelector('.server-more').click())
  ok(!(await texts('.menu button')).some((t) => t.startsWith('Remove')), "an Orca host is hidden here, not removed")
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // 5. a server project: the header shows the server as its own badge, beside a server icon
  await sleep(300)
  await page.click('#repoBtn')
  await until(async () => (await texts('.menu .label')).includes('acme-api · office-server'), 'menu again')
  await page.$$eval('.menu .label', (ls) => {
    const l = ls.find((x) => x.textContent.trim() === 'acme-api · office-server')
    let b = l.nextElementSibling
    while (b && b.tagName !== 'BUTTON') b = b.nextElementSibling
    b.click()
  })
  await until(() => page.$$eval('.commit-row', (r) => r.some((x) => x.textContent.includes('partial refunds'))), 'server repo graph')
  const header = await page.evaluate(() => ({ name: document.querySelector('#repoName').textContent, badge: document.querySelector('#repoHost').hidden ? null : document.querySelector('#repoHost').textContent, icon: !!document.querySelector('#repoIcon svg') }))
  ok(header.name === 'acme-api' && header.badge === 'office-server', 'header: the repo name, and the server as a badge', JSON.stringify(header))
  // narrow: the name is cut, the badge stays whole
  await page.setViewport({ width: 420, height: 800 })
  await sleep(400)
  const narrow = await page.evaluate(() => {
    const b = document.querySelector('#repoHost')
    return { badgeCut: b.scrollWidth > b.clientWidth + 1, badgeW: b.getBoundingClientRect().width }
  })
  ok(!narrow.badgeCut && narrow.badgeW > 40, 'narrow: the badge is never cut', JSON.stringify(narrow))
  await page.setViewport({ width: 1440, height: 900 })
  await sleep(400)
  await page.mouse.move(1430, 890)
  await shot('ssh-server-graph')

  // 6. Repo Overview: every repo, the servers' under each server
  await page.click('.rov-nav-btn')
  await until(() => page.$$eval('.rov-row', (r) => r.length >= 4), 'overview rows', 30000)
  const groups = await texts('.rov-grp .rov-grp-name')
  ok(groups.includes('office-server') && groups.includes('build-box') && groups.includes('On this computer'), 'overview: grouped by server, local ones apart', groups.join(' | '))
  // the group a row sits under: the nearest heading above it
  const apiRow = await page.$$eval('.rov-row', (rs) => {
    const r = rs.find((x) => x.textContent.includes('acme-api'))
    let g = r?.previousElementSibling
    while (g && !g.classList.contains('rov-grp')) g = g.previousElementSibling
    return { text: r?.textContent || '', group: g?.querySelector('.rov-grp-name')?.textContent }
  })
  ok(apiRow.group === 'office-server' && /1 changed/.test(apiRow.text), 'overview: a server repo under its server, read there (its change counted)', JSON.stringify(apiRow))
  await sleep(600)
  await shot('ssh-overview')

  ok(!errors.length, 'no page errors', errors.join(' | '))
} catch (e) {
  results.push([false, 'run'])
  console.log('FAIL', e.stack)
} finally {
  await browser?.close()
  rmSync(W, { recursive: true, force: true })
}
const failed = results.filter(([p]) => !p).length
console.log(failed ? `${failed} failed` : `all ${results.length} passed`)
process.exit(failed ? 1 : 0)
