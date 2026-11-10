import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'
const PLUGIN = process.argv[2]
const SHOTS = process.argv[3]
if (!PLUGIN || !SHOTS || !process.argv[4]) {
  console.error('usage: npm run perf -- <path to a large repo>')
  console.error('   or: node perf.mjs <plugin folder> <scratch folder> <path to a large repo>')
  process.exit(2)
}
mkdirSync(SHOTS, { recursive: true })
// Read-only timings: the worker must not take index locks or read the machine's system git config.
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_OPTIONAL_LOCKS = '0'
// Chrome where each OS puts it (or CHROME=/path/to/chrome)
const CHROME = process.env.CHROME || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform] || '/usr/bin/google-chrome'
const REPO = process.argv[4]
const repo = REPO
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
// ---------- the worker, with a stand-in Orca host ----------
const { default: activate } = await import(pathToFileURL(path.join(PLUGIN, 'worker/main.mjs')).href)
const handlers = {}
const settings = { aiAgent: 'claude', keepGraphOpen: false }
activate({
  api: { major: 1, minor: 3 },
  log() {},
  panels: { handle: (n, f) => (handlers[n] = f), post() {} },
  commands: { register: () => ({ dispose() {} }) },
  events: { on: () => ({ dispose() {} }) },
  host: {
    has: (m) => ['settings.get', 'settings.set', 'workspace.readContext', 'workspace.list'].includes(m),
    call: async (m, p) => {
      if (m === 'settings.get') return { settings }
      if (m === 'settings.set') return ((settings[p.key] = p.value), { ok: true })
      if (m === 'workspace.readContext') return null
      if (m === 'workspace.list') return { workspaces: [], truncated: false }
      return {}
    }
  }
})

// ---------- browser ----------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1500,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 900 })
const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && !/favicon|status of 404/.test(m.text()) && consoleErrors.push(m.text()))
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
  const f = path.join(PLUGIN, 'panel', u.pathname.replace(/^\//, ''))
  try {
    req.respond({ status: 200, contentType: TYPES[path.extname(f)] || 'text/plain', body: readFileSync(f) })
  } catch {
    req.respond({ status: 404, body: '' })
  }
})

// ---------- helpers: act like a person ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, ms = 8000) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try {
      last = await fn()
      if (last) return last
    } catch {}
    await sleep(16)
  }
  throw new Error(`timed out: ${label}`)
}
const exists = (sel) => page.$(sel).then(Boolean)
const clickSel = (sel) => until(() => page.$eval(sel, (el) => (el.click(), true)), `click ${sel}`)
/** click the first element matching `sel` whose text contains `text` */
const clickText = (sel, text) =>
  until(
    () =>
      page.evaluate(
        (sel, text) => {
          const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text) && !e.disabled)
          if (!el) return false
          el.click()
          return true
        },
        sel,
        text
      ),
    `click "${text}" in ${sel}`
  )
/** inside the row (`rowSel`) whose text contains `rowText`, click the control titled `title` */
const clickInRow = (rowSel, rowText, title) =>
  until(
    () =>
      page.evaluate(
        (rowSel, rowText, title) => {
          const row = [...document.querySelectorAll(rowSel)].find((r) => r.textContent.includes(rowText))
          const b = row && row.querySelector(`[title="${title}"]`)
          if (!b) return false
          b.click()
          return true
        },
        rowSel,
        rowText,
        title
      ),
    `"${title}" on row "${rowText}"`
  )
const tab = (label) => clickText('.tab', label)
const refresh = () => clickSel('[title="Refresh"]')
const dialogOpen = () => until(() => exists('.overlay .dialog'), 'dialog opens')
async function fill(selector, value) {
  await page.$eval(selector, (el, v) => {
    el.focus()
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}
async function submitDialog() {
  await clickSel('.overlay .dialog button[type=submit], .overlay .dialog .btn.primary')
  await until(() => page.$('.overlay').then((x) => !x), 'dialog closes')
}
const toastText = () => page.$$eval('.toast', (t) => t.map((x) => x.textContent).join(' | '))
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) })


await page.evaluateOnNewDocument(() => {
  window.__long = []
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true })
})
const t0 = Date.now()
await page.goto('http://gitx.test/tab.html', { waitUntil: 'domcontentloaded' })
await until(() => page.$$eval('.commit-row', (r) => r.length >= 50), 'rows', 20000)
console.log('cold open → graph rows        ', Date.now() - t0, 'ms')
// settle: the background refresh has finished and the page is idle
await until(() => page.$('.loading').then((x) => !x), 'loading bar gone', 20000)
await page.evaluate(() => new Promise((r) => requestIdleCallback(() => r(true), { timeout: 3000 })))
const long0 = await page.evaluate(() => window.__long.splice(0))
console.log('  long tasks during open      ', JSON.stringify(long0))
let t = Date.now(); await tab('Commit'); await until(() => page.$('.commit-box'), 'commit view'); console.log('Graph → Commit                ', Date.now() - t, 'ms')
t = Date.now(); await tab('Graph'); await until(() => page.$$eval('.commit-row', (r) => r.length >= 50), 'graph'); console.log('Commit → Graph                ', Date.now() - t, 'ms')
t = Date.now(); const n0 = await page.$$eval('.commit-row', (r) => r.length)
await page.evaluate(() => { const m = document.querySelector('#main'); m.scrollTop = m.scrollHeight })
await until(() => page.$$eval('.commit-row', (r) => r.length).then((n) => n > n0), 'more rows', 20000)
console.log('scroll: load 300 more         ', Date.now() - t, 'ms', '(rows', n0, '→', await page.$$eval('.commit-row', (r) => r.length) + ')')
await page.evaluate(() => (document.querySelector('#main').scrollTop = 0))
t = Date.now(); await page.evaluate(() => document.querySelectorAll('.commit-row')[3].click()); await until(() => page.$('.commit-inline .inline-files'), 'inline'); console.log('open commit details           ', Date.now() - t, 'ms')
const long1 = await page.evaluate(() => window.__long.splice(0))
console.log('  long tasks (ms) after open  ', JSON.stringify(long1))
const m = await page.metrics(); console.log('DOM nodes', m.Nodes, '| JS heap MB', (m.JSHeapUsedSize / 1e6).toFixed(1))
await page.reload({ waitUntil: 'domcontentloaded' }); t = Date.now()
await until(() => page.$$eval('.commit-row', (r) => r.length >= 50), 'rows')
console.log('reopen (snapshot) → graph rows', Date.now() - t, 'ms')
await browser.close(); process.exit(0)
