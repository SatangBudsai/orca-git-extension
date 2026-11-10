// Right-sidebar check: panel/sidebar.html (the narrow Git Control panel) at sidebar width, wired to the
// real worker on a throwaway repository that Orca reports as the focused workspace.
//   node sidebar.mjs <plugin folder> <screenshot folder>
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import puppeteer from 'puppeteer-core'

const PLUGIN = process.argv[2]
const SHOTS = process.argv[3]
mkdirSync(SHOTS, { recursive: true })
// Chrome where each OS puts it (or CHROME=/path/to/chrome)
const CHROME = process.env.CHROME || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform] || '/usr/bin/google-chrome'

const root = mkdtempSync(path.join(tmpdir(), 'gitx-side-'))
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'global.gitconfig') // never the person's real config
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Side Tester\n\temail = side@e2e.test\n')
process.env.GIT_CONFIG_NOSYSTEM = '1'
// Hide gh/glab: the test must never reach the person's real GitHub/GitLab accounts.
process.env.PATH = process.env.PATH.split(path.delimiter).filter((d) => !['gh.exe', 'glab.exe', 'gh', 'glab'].some((b) => { try { return statSync(path.join(d, b)).isFile() } catch { return false } })).join(path.delimiter)
process.env.GITX_NO_BROWSER = '1'
let browser = null
const results = []
try {
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'app')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim()
  for (let i = 1; i <= 4; i++) {
    writeFileSync(path.join(repo, `f${i}.txt`), `${i}\n`)
    g('add', '.')
    g('commit', '-qm', `Commit number ${i}`)
  }
  g('remote', 'add', 'origin', origin)
  g('push', '-qu', 'origin', 'main')
  for (let i = 0; i < 18; i++) {
    writeFileSync(path.join(repo, 'f5.txt'), `${i}\n`)
    g('add', '.')
    g('commit', '-qm', `Not pushed yet ${i}`)
  }
  writeFileSync(path.join(repo, 'f1.txt'), 'changed\n')
  const repo2 = path.join(root, 'other')
  execFileSync('git', ['init', '-q', '-b', 'main', repo2])
  writeFileSync(path.join(repo2, 'o.txt'), 'o\n')
  execFileSync('git', ['add', '.'], { cwd: repo2 })
  execFileSync('git', ['commit', '-qm', 'Other project'], { cwd: repo2 })
  let focusedRepo = repo
  let slowStatus = 0

  const { default: activate } = await import(pathToFileURL(path.join(PLUGIN, 'worker/main.mjs')).href)
  const handlers = {}
  activate({
    api: { major: 1, minor: 3 },
    log() {},
    panels: { handle: (n, f) => (handlers[n] = f), post() {} },
    commands: { register: () => ({}) },
    events: { on: () => ({}) },
    host: {
      has: (m) => ['settings.get', 'workspace.list', 'workspace.readContext'].includes(m),
      call: async (m) => {
        if (m === 'workspace.list') return { workspaces: [{ name: 'main', branch: 'main', path: repo }, { name: 'other', branch: 'main', path: repo2 }] }
        if (m === 'workspace.readContext') return { displayName: focusedRepo === repo ? 'main' : 'other', branch: 'main', terminals: [] }
        return { settings: {} }
      }
    }
  })

  browser = await puppeteer.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage()
  await page.setViewport({ width: 340, height: 820 })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // Review & MR without any real account: a made-up list with long titles and paths
  const now = Date.now() / 1000
  const fakeReviews = {
    items: [
      { provider: 'gitlab', host: 'gitlab.example.test', url: 'https://gitlab.example.test/a/b/-/merge_requests/240', number: 240, projectId: 1, title: 'feat(approval): server decisionLevel + apv levels from all primary roles (TASK-128)', repo: 'eec/eec-custom/phase2/develop/web/ecustom-web', author: 'dev', source: 'task/TASK-128-apv-decision-level-remaining-modules', target: 'dev', updated: now, roles: ['assigned'], ci: 'passed' },
      { provider: 'github', host: 'github.com', url: 'https://github.com/o/r/pull/1', number: 1, title: 'feature : update hero ui and fix redux', repo: 'o/r', author: 'top', updated: now, roles: ['review'] }
    ],
    providers: [],
    errors: [],
    repoPath: null,
    repoHost: null
  }
  await page.exposeFunction('__orcaRequest', async (name, input) => {
    try {
      if (name === 'reviews.list') return { out: fakeReviews }
      if (slowStatus && name === 'git' && input?.op === 'status') await new Promise((res) => setTimeout(res, slowStatus))
      return { out: await handlers[name](input) }
    } catch (e) {
      return { error: e.message }
    }
  })
  await page.evaluateOnNewDocument(() => {
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
      host: { has: () => false, call: async () => ({}) },
      on: () => ({ dispose() {} })
    })
  })
  const html = readFileSync(path.join(PLUGIN, 'panel/sidebar.html'), 'utf8')
  await page.setRequestInterception(true)
  page.on('request', (req) => (new URL(req.url()).hostname === 'gitx.test' ? req.respond({ status: 200, contentType: 'text/html', body: html }) : req.respond({ status: 404, body: '' })))
  await page.goto('http://gitx.test/sidebar.html', { waitUntil: 'domcontentloaded' })

  const until = async (fn, label, ms = 10000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        if (await fn()) return
      } catch {}
      await new Promise((r) => setTimeout(r, 150))
    }
    throw new Error('timed out: ' + label)
  }
  const step = async (name, fn) => {
    try {
      await fn()
      results.push([true, name])
      console.log('PASS ', name)
    } catch (e) {
      results.push([false, name])
      console.log('FAIL ', name, '\n     ', e.message)
      await page.screenshot({ path: path.join(SHOTS, 'side-FAIL.png') }).catch(() => {})
    }
  }

  await step('follows the focused project and shows its changes', async () => {
    await until(() => page.$eval('#repoName', (e) => e.textContent === 'app'), 'repo name app')
    await until(() => page.$$eval('#main .item', (r) => r.some((x) => x.textContent.includes('f1.txt'))), 'changed file listed')
  })
  await step('push count on the Push button (green arrow), toolbar fits', async () => {
    await until(() => page.$eval('#toolbar [data-op="push"] .tb-count', (c) => c.textContent.includes('18')), 'push 18')
    const fit = await page.$eval('#toolbar [data-op="push"]', (b) => { const r = b.getBoundingClientRect(); const c = b.querySelector('.tb-count').getBoundingClientRect(); return c.right <= r.right - 2 && b.scrollWidth <= b.clientWidth + 1 })
    if (!fit) throw new Error('the push count runs outside its button')
    // every toolbar button inside the panel, at a few sidebar widths
    for (const w of [300, 340, 353, 400]) {
      await page.setViewport({ width: w, height: 820 })
      await new Promise((r) => setTimeout(r, 150))
      const out = await page.$$eval('#toolbar > button', (bs) => bs.filter((b) => b.getBoundingClientRect().right > innerWidth - 1 || b.getBoundingClientRect().left < 0).length)
      if (out) throw new Error(`${out} toolbar button(s) cut off at ${w}px`)
    }
    await page.setViewport({ width: 340, height: 820 })
    const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
    if (over) throw new Error('the panel scrolls sideways')
  })
  await step('one button opens the full Git Control tab', async () => {
    if (!(await page.$('#toolbar [title="Open Git Control in a full tab"]'))) throw new Error('no open-in-tab button')
  })
  await page.screenshot({ path: path.join(SHOTS, 'side-panel.png') })
  await step('a section head folds its files and opens them again', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.fold-head')].find((h) => h.textContent.includes('Changes')).click())
    await until(() => page.$$eval('#main .item', (r) => !r.some((x) => x.textContent.includes('f1.txt'))), 'files hidden')
    await page.evaluate(() => [...document.querySelectorAll('.fold-head')].find((h) => h.textContent.includes('Changes')).click())
    await until(() => page.$$eval('#main .item', (r) => r.some((x) => x.textContent.includes('f1.txt'))), 'files back')
  })
  await step('a wide sidebar keeps its own layout: repository, toolbar and branch on separate rows', async () => {
    await page.setViewport({ width: 935, height: 820 })
    await new Promise((r) => setTimeout(r, 300))
    const box = (sel) => page.$eval(sel, (e) => { const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width } })
    const repo = await box('#repoBtn')
    const tb = await box('#toolbar')
    const chip = await box('.branch-chip')
    const tabs = await box('#tabs')
    if (!(chip.w > 40)) throw new Error('branch chip hidden')
    if (!(tb.top >= repo.bottom - 1 && chip.top >= tb.bottom - 1 && tabs.top >= chip.bottom - 1)) throw new Error('rows overlap: ' + JSON.stringify({ repo, tb, chip, tabs }))
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('scrolls sideways')
    await page.screenshot({ path: path.join(SHOTS, 'side-wide.png') })
    await page.setViewport({ width: 340, height: 820 })
  })
  await step('switching projects shows a loading skeleton, then the new project; coming back restores the tab', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('Stash')).click())
    await until(() => page.$eval('.tab.active', (t) => t.textContent.includes('Stash')), 'on Stash')
    focusedRepo = repo2
    slowStatus = 1200
    await page.evaluate(() => document.querySelector('#toolbar [data-op="refresh"]').click())
    await until(() => page.$('.repo-loading').then(Boolean), 'skeleton while the other project loads', 4000)
    slowStatus = 0
    await until(() => page.$eval('#repoName', (e) => e.textContent === 'other'), 'other project shown')
    if (await page.$('.repo-loading')) throw new Error('skeleton stayed after loading')
    focusedRepo = repo
    await page.evaluate(() => document.querySelector('#toolbar [data-op="refresh"]').click())
    await until(() => page.$eval('#repoName', (e) => e.textContent === 'app'), 'back to app', 15000)
    await until(() => page.$eval('.tab.active', (t) => t.textContent.includes('Stash')), 'remembered tab (Stash) for app')
  })
  await step('Review & MR fits the sidebar: one row per request, no sideways scroll', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('MR / PR')).click())
    await until(() => page.$$eval('.review-row', (r) => r.length === 2), 'two requests listed')
    const rows = await page.$$eval('.review-row', (rs) => rs.map((r) => { const a = r.querySelector('.review-actions').getBoundingClientRect(); const t = r.querySelector('.review-title').getBoundingClientRect(); return { sameLine: a.top < t.bottom + 30, h: r.getBoundingClientRect().height } }))
    if (rows.some((x) => !x.sameLine)) throw new Error('row actions dropped to their own line: ' + JSON.stringify(rows))
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw new Error('scrolls sideways')
    await page.screenshot({ path: path.join(SHOTS, 'side-reviews.png') })
  })
  if (errors.length) results.push([false, 'page errors: ' + errors.join(' | ')]), console.log('FAIL  page errors', errors)
} catch (e) {
  results.push([false, 'crash'])
  console.log('CRASH', e.stack)
} finally {
  await browser?.close()
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {}
}
const passed = results.filter((r) => r[0]).length
console.log(`${passed}/${results.length} passed`)
process.exit(passed === results.length ? 0 : 1)
