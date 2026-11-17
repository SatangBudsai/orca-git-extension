// Zoom inside the page (Ctrl/Cmd + = - 0, Ctrl+wheel, pinch): the real Git Control tab in headless Chrome.
// Menus and tooltips must still open at the pointer / their button, inside the window, and the level
// is kept after a reload. Set up like e2e.mjs (same fake Orca and worker).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import puppeteer from 'puppeteer-core'

const PLUGIN = process.argv[2]
const SHOTS = process.argv[3]
mkdirSync(SHOTS, { recursive: true })
// Chrome where each OS puts it (or CHROME=/path/to/chrome)
const CHROME = process.env.CHROME || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform] || '/usr/bin/google-chrome'

// ---------- fixture: a repo with a remote, branches, and a diverged sandbox ----------
const root = mkdtempSync(path.join(tmpdir(), 'gitx-e2e-'))
// Never touch the person's real ~/.gitconfig: git (ours and the worker's) reads this file instead.
const GLOBAL_CFG = path.join(root, 'global.gitconfig')
writeFileSync(GLOBAL_CFG, '[user]\n\tname = Global Tester\n\temail = global@e2e.test\n')
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG
process.env.GIT_CONFIG_NOSYSTEM = '1'
// Hide gh/glab: the test must never reach the person's real GitHub/GitLab accounts.
process.env.PATH = process.env.PATH.split(path.delimiter).filter((d) => !['gh.exe', 'glab.exe', 'gh', 'glab'].some((b) => { try { return statSync(path.join(d, b)).isFile() } catch { return false } })).join(path.delimiter)
process.env.GITX_NO_BROWSER = '1' // the merge request step must not open a real browser
let browser = null
const results = []
try {
const origin = path.join(root, 'origin.git')
const repo = path.join(root, 'app')
const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
execFileSync('git', ['clone', '-q', origin, repo])
g('config', 'user.name', 'Tester'); g('config', 'user.email', 't@e2e.test'); g('config', 'core.autocrlf', 'false')
const write = (f, t) => writeFileSync(path.join(repo, f), t)
write('a.txt', 'one\ntwo\nthree\n'); g('add', '.'); g('commit', '-qm', 'Initial commit'); g('push', '-q', '-u', 'origin', 'main')
write('b.txt', 'b\n'); g('add', '.'); g('commit', '-qm', 'Add b'); g('push', '-q')
g('switch', '-qc', 'feature'); write('f.txt', 'feature\n'); g('add', '.'); g('commit', '-qm', 'Feature work'); g('push', '-q', '-u', 'origin', 'feature')
g('switch', '-q', 'main'); g('switch', '-qc', 'sandbox'); write('s.txt', 'remote\n'); g('add', '.'); g('commit', '-qm', 'Remote sandbox work'); g('push', '-q', '-u', 'origin', 'sandbox')
g('reset', '-q', '--hard', 'HEAD~1'); write('l.txt', 'local\n'); g('add', '.'); g('commit', '-qm', 'Local sandbox work')
g('switch', '-q', 'main')
const REPO = repo.replace(/\\/g, '/')

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
browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--window-size=1500,900'] })
const page = await browser.newPage()
await page.setViewport({ width: 1500, height: 900 })
const consoleErrors = []
page.on('pageerror', (e) => consoleErrors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && !/favicon|status of 404/.test(m.text()) && consoleErrors.push(m.text()))
// Tests can stand in for the AI agent (no claude/codex here): name -> async (input) => output
const fakes = {}
const LATENCY = +process.env.GITX_E2E_LATENCY || 0 // e.g. 150: every request as slow as on a big repo
await page.exposeFunction('__orcaRequest', async (name, input) => {
  if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY))
  try {
    if (fakes[name]) return { out: await fakes[name](input) }
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
    await sleep(120)
  }
  throw new Error(`timed out: ${label}`)
}
const exists = (sel) => page.$(sel).then(Boolean)
const zoomOf = () => page.evaluate(() => document.documentElement.style.zoom || '1')
const check = (ok, label, extra = '') => (results.push([ok, label]), console.log(ok ? 'PASS' : 'FAIL', label, extra))
await page.goto('http://gitx.test/tab.html', { waitUntil: 'domcontentloaded' })
await until(() => page.$$eval('.commit-row', (r) => r.length >= 3), 'graph rows')
await page.mouse.click(700, 500)
const key = async (mod, k) => { await page.keyboard.down(mod); await page.keyboard.press(k); await page.keyboard.up(mod); await sleep(350) }
await key('Control', 'Equal'); check((await zoomOf()) === '1.1', 'Ctrl+= zooms in to 110%', await zoomOf())
check((await page.$eval('.zoom-badge', (b) => b.textContent).catch(() => '')) === '110%', 'badge shows 110%')
await key('Control', 'Equal'); check((await zoomOf()) === '1.25', 'again: 125%', await zoomOf())
await key('Control', 'Minus'); check((await zoomOf()) === '1.1', 'Ctrl+- : 110%', await zoomOf())
await key('Control', 'Digit0'); check((await zoomOf()) === '1', 'Ctrl+0 resets', await zoomOf())
await key('Meta', 'Equal'); check((await zoomOf()) === '1.1', 'Cmd+= (macOS) zooms in', await zoomOf())
await key('Meta', 'NumpadAdd'); check((await zoomOf()) === '1.25', 'Cmd+Numpad+ zooms in', await zoomOf())
await key('Meta', 'Digit0')
await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -100 }); await page.keyboard.up('Control'); await sleep(150)
check((await zoomOf()) === '1.1', 'Ctrl+wheel up zooms in', await zoomOf())
await page.keyboard.down('Control'); for (let i = 0; i < 10; i++) await page.mouse.wheel({ deltaY: -5 }); await page.keyboard.up('Control'); await sleep(150)
const pz = +(await zoomOf()); check(pz > 1.3 && pz < 2.1, 'pinch (small ctrl-wheel deltas) zooms smoothly', pz)
await key('Control', 'Digit0'); await key('Control', 'Equal'); await key('Control', 'Equal'); await key('Control', 'Equal') // 150%
check((await zoomOf()) === '1.5', 'at 150%', await zoomOf())
// context menu opens at the pointer
const row = await page.$('.commit-row:nth-child(2)'); const rb = await row.boundingBox()
const cx = Math.round(rb.x + 300), cy = Math.round(rb.y + rb.height / 2)
await page.mouse.click(cx, cy, { button: 'right' })
await until(() => exists('.menu'), 'menu')
const mr = await page.$eval('.menu', (m) => { const r = m.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
check(Math.abs(mr.x - cx) < 6 || mr.x + mr.w <= 1500, 'menu placed at the pointer', JSON.stringify({ cx, cy, mr }))
check(mr.x >= 0 && mr.x + mr.w <= 1500 + 1 && mr.y >= 0 && mr.y + mr.h <= 900 + 1, 'menu inside the window')
await page.screenshot({ path: path.join(SHOTS, 'zoom-150-menu.png') })
await page.keyboard.press('Escape'); await sleep(200)
// tooltip next to its button
const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button[title]')].find((b) => !b.textContent.trim() && b.getBoundingClientRect().width > 0)); const bb = await btn.boundingBox()
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(1200)
const tr = await page.$eval('.tip', (t) => { const r = t.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, on: t.classList.contains('on') } }).catch(() => null)
check(tr && tr.on && Math.abs(tr.x + tr.w / 2 - (bb.x + bb.width / 2)) < 20 && Math.abs(tr.y - (bb.y + bb.height)) < 30, 'tooltip under its button', JSON.stringify({ bb, tr }))
await page.screenshot({ path: path.join(SHOTS, 'zoom-150-tip.png') })
// remembered after reload
await page.reload({ waitUntil: 'domcontentloaded' }); await until(() => page.$$eval('.commit-row', (r) => r.length >= 3), 'graph rows again')
check((await zoomOf()) === '1.5', 'zoom kept after reload', await zoomOf())
await key('Control', 'Digit0')
check(consoleErrors.length === 0, 'no page errors', consoleErrors.join(' | '))
} catch (e) { console.log('ERROR', e.stack); results.push([false, 'crash']) } finally { await browser?.close(); try { rmSync(root, { recursive: true, force: true }) } catch {} }
console.log(results.filter((r) => r[0]).length + '/' + results.length + ' passed')
process.exit(results.every((r) => r[0]) ? 0 : 1)
