// Git Control panel. Plain JS, no dependencies. Talks to worker/main.mjs through orca.plugin.request.
'use strict'

/* =========================================================================
   tiny DOM helpers
   ========================================================================= */
/** The modifier as this keyboard writes it: ⌘ on a Mac, Ctrl+ elsewhere (both keys work everywhere). */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
const MOD = IS_MAC ? '⌘' : 'Ctrl+'
const $ = (sel, root = document) => root.querySelector(sel)

function h(tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k in el && typeof v !== 'string') el[k] = v
      else el.setAttribute(k, v === true ? '' : v)
    }
  }
  append(el, children)
  return el
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}
const clear = (el) => {
  el.replaceChildren()
  return el
}

/* =========================================================================
   i18n: the t function looks the English text up in the chosen language and falls back to English.
   The English text is the key, so the code stays readable. Translations live in panel/locales/<lang>.json;
   tools/build.mjs inlines them here (LOCALES) and tools/i18n.mjs checks every language has every key.
   ========================================================================= */
const LOCALES = /*@locales*/ {} /*@end*/
const LANGS = [
  ['en', 'English'],
  ['zh-CN', '简体中文'],
  ['ja', '日本語'],
  ['es', 'Español'],
  ['th', 'ไทย']
]
const LANG_KEY = 'gitx.lang'
const pickLang = (v) => (LOCALES[v] || v === 'en' ? v : 'en')
// The worker keeps the choice; the last value is kept here so the first paint is already in that language.
let LANG = 'en'
try {
  LANG = pickLang(localStorage.getItem(LANG_KEY) || 'en')
} catch {}
const DICT = LOCALES[LANG] || {}
function t(s, vars) {
  let out = DICT[s] || s
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  return out
}
// The language button at the top right: a globe and the language's code. The choice belongs to Git Control
// (the plugin's own storage, and kept here for the next start), not to Orca's settings.
function langPicker() {
  const code = LANG === 'zh-CN' ? '中' : LANG.toUpperCase()
  const pick = (v) => request('ui.language', { lang: v }, 10000).then(() => applyLang(v), () => applyLang(v))
  // the app's own menu (like every other one), the current language ticked, its English name beside it
  const NAMES = { en: 'English', 'zh-CN': 'Simplified Chinese', ja: 'Japanese', es: 'Spanish', th: 'Thai' }
  const open = (e) =>
    menu(e.currentTarget, [
      { header: t('Language') },
      ...LANGS.map(([v, l]) => ({ label: l, hint: v === 'en' ? '' : NAMES[v], icon: v === LANG ? 'check' : 'globe', cls: v === LANG ? 'lang-on' : '', onClick: () => v !== LANG && pick(v) }))
    ])
  return h('button', { class: 'icon-btn lang-pick', title: t('Language'), 'aria-label': t('Language'), 'aria-haspopup': 'menu', onClick: open }, icon('globe', 14), h('span', { class: 'lang-code' }, code), icon('down', 11))
}
// Applies a language picked with the globe (or in another Git Control window): strings are built once, so reload.
function applyLang(v) {
  const next = pickLang(v || 'en')
  try {
    localStorage.setItem(LANG_KEY, next)
  } catch {}
  if (next !== LANG) location.reload()
}

const ICONS = {
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  rows: '<rect width="18" height="7" x="3" y="3" rx="1"/><rect width="18" height="7" x="3" y="14" rx="1"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M7 16h10"/>',
  branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  pull: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  push: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  fetch: '<path d="M12 13v8l-4-4"/><path d="m12 21 4-4"/><path d="M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284"/>',
  stash: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  minus: '<path d="M5 12h14"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  pipeline: '<circle cx="5" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/><rect x="9.5" y="9" width="5" height="6" rx="1.2"/><path d="M7.2 12h2.3M14.5 12h2.3"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  commit: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  worktree: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  pr: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v6"/><path d="M18 15V9a3 3 0 0 0-3-3h-4"/><path d="m13 3-3 3 3 3"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  compare: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  current: '<circle cx="12" cy="12" r="10" fill="currentColor" stroke="none"/><path d="m8 12.5 2.6 2.6L16.5 9" stroke="var(--ref-head-ink, #14161b)" stroke-width="2.6"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  sparkle: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>',
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  edit: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/>'
}
function icon(name, size = 14) {
  const span = document.createElement('span')
  span.style.display = 'inline-flex'
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`
  return span
}
const iconBtn = (name, title, onClick, extra = {}) =>
  h('button', { class: 'icon-btn', title, 'aria-label': title, onClick, ...extra }, icon(name))

const basename = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
const dirname = (p) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}
function ago(ts) {
  const s = Date.now() / 1000 - ts
  if (s < 60) return t('just now')
  const units = [
    [31536000, (n) => t('{n}y ago', { n })],
    [2592000, (n) => t('{n}mo ago', { n })],
    [604800, (n) => t('{n}w ago', { n })],
    [86400, (n) => t('{n}d ago', { n })],
    [3600, (n) => t('{n}h ago', { n })],
    [60, (n) => t('{n}m ago', { n })]
  ]
  for (const [n, u] of units) if (s >= n) return u(Math.floor(s / n))
  return ''
}
const fullDate = (t) => new Date(t * 1000).toLocaleString(LANG)

/* =========================================================================
   worker bridge
   ========================================================================= */
const hasOrca = typeof window.orca !== 'undefined'
// Opened as a full editor tab (custom editor for .gitgraph files) rather than the sidebar panel.
const IN_TAB = hasOrca && !!window.orca.document
let docRepo = null
const ignoredGraphIn = new Set()

async function request(name, input, timeoutMs = 30000) {
  if (!hasOrca) throw new Error(t('Open this panel inside Orca'))
  input = JSON.parse(JSON.stringify(input ?? {})) // drop undefined values: Orca rejects them as invalid input
  try {
    if (window.orca.plugin?.request) return await window.orca.plugin.request(name, input, { timeoutMs })
    const r = await window.orca.host.call('plugin.request', { name, input, timeoutMs })
    return r.output
  } catch (e) {
    if (/changed or is no longer approved/i.test(e?.message || '')) pluginUpdated()
    throw e
  }
}
/** The plugin was updated (or needs approving again): this page is the old one. Offer to reload it. */
let updateShown = false
function pluginUpdated() {
  if (updateShown) return
  updateShown = true
  const bar = h(
    'div',
    { class: 'update-bar' },
    icon('refresh', 13),
    h('span', { class: 'grow' }, t('Git Control was updated. Reload this tab to use the new version (approve it in Orca first if it asks).')),
    h('button', { class: 'btn sm primary', onClick: () => location.reload() }, icon('refresh', 12), t('Reload'))
  )
  document.body.prepend(bar)
}
const NET_OPS = new Set(['fetch', 'pull', 'push', 'remoteBranchDelete', 'tagPush', 'worktreeAdd', 'commit', 'pipelines', 'pipelineJobs', 'jobLog', 'pipelineAct'])
const call = (op, args = {}) =>
  request('git', { op, repo: state.repo, args }, NET_OPS.has(op) ? 120000 : 30000)

/* =========================================================================
   state
   ========================================================================= */
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('gitx.' + k)
      return v == null ? d : JSON.parse(v)
    } catch {
      return d
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('gitx.' + k, JSON.stringify(v))
    } catch {}
  }
}

const state = {
  repo: null,
  pinned: IN_TAB ? null : store.get('pinnedRepo', null), // null = follow the focused Orca workspace
  workspaces: [],
  servers: [], // SSH hosts searched for projects (from Orca, or added here)
  serverRepos: [], // the projects found on them, by locator
  serversAt: 0,
  status: null,
  tab: IN_TAB ? 'history' : store.get('tab', 'changes'),
  busy: 0,
  history: { all: store.get('historyAllV2', true), search: '', commits: [], done: false },
  configScope: store.get('configScope', 'global'),
  commitDraft: '',
  amend: false,
  sheets: []
}

/* =========================================================================
   feedback: toasts, dialogs, menus
   ========================================================================= */
function toast(msg, kind = 'ok', ms, action) {
  const el = h('div', { class: `toast ${kind}` }, icon(kind === 'error' ? 'alert' : 'check'), h('div', { class: 'grow' }, msg), action && h('button', { class: 'toast-act', onClick: (e) => (e.stopPropagation(), el.remove(), action.run()) }, action.label))
  el.addEventListener('click', () => el.remove())
  $('#toasts').append(el)
  setTimeout(() => el.remove(), ms ?? (kind === 'error' ? 9000 : 2600))
}

/**
 * Every overlay and menu carries `dispose`: its own close (removes its key listeners, resolves its
 * promise). closeOverlays runs each one, so nothing is left waiting on a removed element.
 */
function closeOverlays(sel = '.menu, .overlay') {
  document.querySelectorAll(sel).forEach((e) => {
    const d = e.dispose
    e.dispose = null
    if (d) d()
    e.remove()
  })
}
/** Key handlers act only for the topmost overlay, and not while a menu is open over it. */
const isTopOverlay = (o) => {
  if (document.querySelector('.menu')) return false
  const all = document.querySelectorAll('.overlay')
  return all[all.length - 1] === o
}
/** Mount an overlay: stacked over an open one, or replacing whatever is open. */
function mountOverlay(overlay, dispose, stack = false) {
  overlay.dispose = dispose
  if (stack) overlay.classList.add('stacked')
  document.body.append(overlay)
  return overlay
}

/** fields: [{ key, label, value, placeholder, type: 'text'|'textarea'|'select'|'check', options: [[value,label]], hint }] */
function dialog({ title, message, fields = [], ok = t('OK'), danger = false, cancel = t('Cancel'), stack = false }) {
  if (stack) closeOverlays('.menu')
  else closeOverlays()
  return new Promise((resolve) => {
    const inputs = {}
    const form = h('form', { class: 'dialog', onSubmit: (e) => (e.preventDefault(), done(true)) })
    let closed = false
    const done = (okd) => {
      if (closed) return
      closed = true
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      if (!okd) return resolve(null)
      const out = {}
      for (const [k, el] of Object.entries(inputs)) out[k] = el.type === 'checkbox' ? el.checked : el.value
      resolve(out)
    }
    const onKey = (e) => e.key === 'Escape' && isTopOverlay(overlay) && (e.preventDefault(), done(false))
    append(form, [h('h3', null, title), message && h('p', null, message)])
    for (const f of fields) {
      let el
      if (f.type === 'check') {
        el = h('input', { type: 'checkbox', checked: !!f.value })
        form.append(h('label', { class: 'check' }, el, f.label))
      } else {
        if (f.type === 'select')
          el = h('select', null, f.options.map(([v, l]) => h('option', { value: v, selected: v === f.value }, l)))
        else if (f.type === 'textarea') el = h('textarea', { placeholder: f.placeholder || '' }, f.value || '')
        else el = h('input', { type: 'text', value: f.value || '', placeholder: f.placeholder || '', spellcheck: 'false', autocomplete: 'off' })
        // suggestions: a list under the field, filtered as the person types
        const box = f.suggestions?.length ? combo(el, f.suggestions) : el
        form.append(h('div', { class: 'field' }, h('label', null, f.label), box, f.hint && h('div', { class: 'hint' }, f.hint)))
      }
      inputs[f.key] = el
    }
    form.append(
      h(
        'div',
        { class: 'buttons' },
        cancel && h('button', { type: 'button', class: 'btn', onClick: () => done(false) }, cancel),
        h('button', { type: 'submit', class: `btn ${danger ? 'danger solid' : 'primary'}` }, ok)
      )
    )
    const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && done(false) }, form)
    mountOverlay(overlay, () => done(false), stack)
    document.addEventListener('keydown', onKey)
    const first = form.querySelector('input:not([type=checkbox]), textarea, select') || form.querySelector('button[type=submit]')
    first?.focus()
    first?.select?.()
  })
}
/**
 * A text field with suggestions below it: { value, detail?, disabled?, badge? }. Typing filters them
 * (by value or detail); ↑ ↓ move, Enter or a click picks one, Esc closes the list (not the dialog).
 */
function combo(input, items, { empty = t('No match: type the host or user@host') } = {}) {
  const list = h('div', { class: 'combo-list', role: 'listbox' })
  const caret = h('button', { type: 'button', class: 'combo-caret', tabindex: '-1', 'aria-label': t('Show suggestions'), onMousedown: (e) => (e.preventDefault(), list.hidden ? (input.focus(), show(true)) : hide()) }, icon('down', 12))
  const wrap = h('div', { class: 'combo' }, input, caret, list)
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  list.hidden = true
  let shown = []
  let active = -1
  const pick = (it) => {
    input.value = it.value
    hide()
    input.dispatchEvent(new Event('input'))
  }
  const draw = () => {
    clear(list)
    if (!shown.length) return list.append(h('div', { class: 'combo-empty' }, empty))
    shown.forEach((it, i) =>
      list.append(
        h(
          'div',
          { class: `combo-item${i === active ? ' active' : ''}${it.disabled ? ' disabled' : ''}`, role: 'option', 'aria-selected': String(i === active), onMousedown: (e) => (e.preventDefault(), !it.disabled && pick(it)), onMousemove: () => active !== i && ((active = i), draw()) },
          h('span', { class: 'combo-value' }, it.value),
          it.detail && h('span', { class: 'combo-detail' }, it.detail),
          it.badge && h('span', { class: 'pill' }, it.badge)
        )
      )
    )
    list.children[active]?.scrollIntoView({ block: 'nearest' })
  }
  const show = (all = false) => {
    const q = all ? '' : input.value.trim().toLowerCase()
    shown = items.filter((it) => !q || it.value.toLowerCase().includes(q) || (it.detail || '').toLowerCase().includes(q))
    // what was typed exactly: nothing left to suggest
    if (!all && shown.length === 1 && shown[0].value === input.value.trim()) shown = []
    if (!shown.length && q && !all) return hide()
    active = shown.findIndex((it) => !it.disabled)
    list.hidden = false
    wrap.classList.add('open')
    draw()
  }
  const hide = () => {
    list.hidden = true
    wrap.classList.remove('open')
  }
  const move = (d) => {
    if (!shown.length) return
    let i = active
    for (let n = 0; n < shown.length; n++) {
      i = (i + d + shown.length) % shown.length
      if (!shown[i].disabled) break
    }
    active = i
    draw()
  }
  input.addEventListener('input', (e) => e.isTrusted && show())
  input.addEventListener('focus', () => show(!input.value.trim()))
  input.addEventListener('blur', hide)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), list.hidden ? show(true) : move(1))
    else if (e.key === 'ArrowUp') (e.preventDefault(), !list.hidden && move(-1))
    else if (e.key === 'Enter' && !list.hidden && shown[active] && !shown[active].disabled) (e.preventDefault(), pick(shown[active]))
    else if (e.key === 'Escape' && !list.hidden) (e.preventDefault(), e.stopPropagation(), hide())
    else if (e.key === 'Tab') hide()
  })
  return wrap
}

/** Asked from inside an open modal, the confirm stacks over it: Cancel returns to the modal intact. */
const confirmBox = (title, message, ok = t('Confirm'), danger = false) =>
  dialog({ title, message, ok, danger, stack: !!document.querySelector('.overlay') }).then((r) => r !== null)

/** A right-click opens the row's menu at the pointer; `menu` reads it once. */
let menuPoint = null
/**
 * items: { label, icon, onClick, danger, disabled, hint, items } | '-' | { header }. anchor: an element
 * or { x, y }. An item with `items` is a cascading sub-menu: pointing at it opens the next level
 * beside it (Enter or → from the keyboard), and choosing anything closes every level.
 */
function menu(anchor, items, parent = null) {
  if (!parent) closeOverlays('.menu') // a menu may open from inside a dialog: leave dialogs alone
  const el = h('div', { class: 'menu', role: 'menu' })
  el.closeAll = () => {
    let root = el
    while (root.parentMenu) root = root.parentMenu
    root.closeChild?.()
    root.remove()
    root.cleanup?.()
  }
  if (!parent) el.dispose = () => el.closeAll()
  el.parentMenu = parent
  el.closeChild = () => {
    el.child?.closeChild?.()
    el.child?.remove()
    el.child = null
    el.querySelectorAll('button.open').forEach((b) => b.classList.remove('open'))
  }
  let hoverTimer = 0
  const openSub = (btn, it) => {
    if (el.child?.owner === btn) return
    el.closeChild()
    btn.classList.add('open')
    const r = btn.getBoundingClientRect()
    el.child = menu({ x: r.right - 2, y: r.top - 5, side: r.left + 2 }, it.items, el)
    el.child.owner = btn
  }
  for (const it of items) {
    if (!it) continue
    if (it === '-') el.append(h('hr'))
    else if (it.header) el.append(h('div', { class: 'label' }, it.header))
    else {
      const empty = it.items && !it.items.filter(Boolean).length
      const btn = h(
        'button',
        {
          class: [it.danger ? 'danger' : '', it.items ? 'has-sub' : '', it.cls || ''].join(' ').trim(),
          disabled: it.disabled || empty,
          'aria-haspopup': it.items ? 'menu' : null,
          onMouseenter: () => {
            clearTimeout(hoverTimer)
            // A short pause lets the pointer cross other items on its way to an open sub-menu.
            hoverTimer = setTimeout(() => (it.items ? openSub(btn, it) : el.closeChild()), it.items ? 80 : 160)
          },
          onKeydown: (e) => {
            if (it.items && e.key === 'ArrowRight') (e.preventDefault(), openSub(btn, it), el.child?.querySelector('button:not(:disabled)')?.focus())
            if (e.key === 'ArrowLeft' && parent) (e.preventDefault(), el.owner?.focus(), parent.closeChild())
          },
          onClick: () => {
            if (it.items) return openSub(btn, it)
            el.closeAll()
            it.onClick()
          }
        },
        it.icon ? icon(it.icon) : h('span', { style: { width: '14px' } }),
        h('span', { class: 'grow ellipsis', title: (it.full || it.label).replace(/…$/, '') }, it.label.replace(/…$/, '')),
        it.badge && h('span', { class: 'menu-badge' }, it.badge),
        it.hint && h('span', { class: 'dim', style: { fontSize: '11px' } }, it.hint),
        it.items && h('span', { class: 'dim sub-arrow', 'aria-hidden': 'true' }, '›')
      )
      el.append(btn)
    }
  }
  el.addEventListener('mouseenter', () => clearTimeout(hoverTimer))
  document.body.append(el)
  const point = menuPoint ?? (typeof anchor?.x === 'number' && !anchor.getBoundingClientRect ? anchor : null)
  menuPoint = null
  const mw = el.offsetWidth
  const mh = el.offsetHeight
  let left, top
  if (parent) {
    // Beside the item; to its left when there is no room on the right.
    left = point.x + mw > window.innerWidth - 8 ? Math.max(8, point.side - mw) : point.x
    top = Math.max(8, Math.min(point.y, window.innerHeight - mh - 8))
  } else {
    const r = point ? { left: point.x, right: point.x + mw, top: point.y, bottom: point.y } : anchor.getBoundingClientRect()
    left = Math.min(r.right - mw, window.innerWidth - mw - 8)
    if (left < 8) left = 8
    top = r.bottom + 4
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4)
  }
  el.style.left = left + 'px'
  el.style.top = top + 'px'
  if (!parent) {
    // One outside-click and one key listener for the whole cascade, removed when it closes.
    const off = (e) => {
      if (![...document.querySelectorAll('.menu')].some((m) => m.contains(e.target))) el.closeAll()
    }
    const onKey = (e) => {
      const menus = [...document.querySelectorAll('.menu')]
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        const focusBack = el.anchorEl
        el.closeAll()
        focusBack?.focus?.()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const cur = menus.find((m) => m.contains(document.activeElement)) || menus[menus.length - 1]
        const btns = [...cur.querySelectorAll(':scope > button:not(:disabled)')]
        if (!btns.length) return
        e.preventDefault()
        const i = btns.indexOf(document.activeElement)
        const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : i <= 0 ? btns.length - 1 : i - 1
        btns[next].focus()
      }
    }
    const timer = setTimeout(() => document.addEventListener('mousedown', off, true))
    document.addEventListener('keydown', onKey, true)
    el.anchorEl = anchor instanceof Element ? anchor : null
    el.cleanup = () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', off, true)
      document.removeEventListener('keydown', onKey, true)
      el.cleanup = null
    }
  }
  return el
}

/* =========================================================================
   running git operations
   ========================================================================= */
function setBusy(delta) {
  state.busy += delta
  let bar = $('.loading')
  if (state.busy > 0 && !bar) $('#main').prepend(h('div', { class: 'loading' }))
  if (state.busy <= 0) bar?.remove()
}

/**
 * Open a web link outside Orca. Desktop: the worker hands it to the system default browser (no Orca
 * prompt, no in-app tab). Orca's web client (e.g. on a phone): a new tab of that browser.
 */
// Orca's plugin frames do not always say "Electron", so only a phone or tablet counts as the web client;
// everywhere else the worker opens the link on this computer.
const isDesktop = /Electron/i.test(navigator.userAgent) || !/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
async function openLink(url) {
  if (!/^https?:\/\//.test(String(url))) return
  if (isDesktop) {
    try {
      const r = await request('shell.open', { url }, 15000)
      if (r?.opened) return
    } catch {}
  }
  const w = window.open(url, '_blank', 'noopener')
  if (!w) {
    await copy(url)
    toast(t('The link was copied: paste it into your browser.'))
  }
}
/** Run an op with a spinner and error toast, then refresh. Returns the result, or undefined on failure. */
async function run(op, args, { success, refresh = true, quiet = false } = {}) {
  const t0 = Date.now()
  setBusy(1)
  setWorking(op, true)
  // fetch, pull and push say what they changed once the view is fresh ("3 new commits", "up to date")
  const before = SYNC_NOTE[op] && state.status ? { oid: state.status.oid, ahead: state.status.ahead || 0, behind: state.status.behind || 0, upstream: state.status.upstream } : null
  let ok = false
  try {
    const out = await call(op, args)
    ok = true
    if (success && !before) toast(success)
    else if (!before && !quiet && typeof out === 'string' && out.trim() && NET_OPS.has(op)) toast(out.trim().split('\n').slice(-3).join('\n'))
    return out ?? ''
  } catch (e) {
    const msg = e?.message || String(e)
    // A conflict is a normal step, not a failure: say what happens next instead of git's error text.
    const files = [...msg.matchAll(/CONFLICT \([^)]*\): (?:Merge conflict in )?(\S+)/g)].map((m) => m[1])
    if (files.length || /fix conflicts and then commit|could not apply|after resolving the conflicts/i.test(msg))
      toast(files.length > 1 ? t('{n} files changed on both sides. Pick what to keep in each, then commit.', { n: files.length }) : files.length ? t('{n} file changed on both sides. Pick what to keep in each, then commit.', { n: files.length }) : t('Some files changed on both sides. Pick what to keep in each, then commit.'), 'ok', 7000)
    else toast(msg, 'error')
    return undefined
  } finally {
    setBusy(-1)
    if (refresh) await refreshAll()
    setWorking(op, false, ok)
    if (ok && before) toast(SYNC_NOTE[op](before, state.status || {}, success, args || {}))
    cmdNote(t0)
  }
}
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
const SYNC_NOTE = {
  fetch: (b, a, done) => {
    const n = (a.behind || 0) - b.behind
    done = done || t('Fetched')
    if (!a.upstream) return t('{done} · this branch has no remote branch', { done })
    if (n > 0) return n === 1 ? t('{done} · {n} new commit on {upstream} to pull', { done, n, upstream: a.upstream }) : t('{done} · {n} new commits on {upstream} to pull', { done, n, upstream: a.upstream })
    if (a.behind) return a.behind === 1 ? t('{done} · nothing new · {n} commit still to pull', { done, n: a.behind }) : t('{done} · nothing new · {n} commits still to pull', { done, n: a.behind })
    return t('{done} · already up to date', { done })
  },
  pull: (b, a, done) => (a.oid && a.oid !== b.oid ? (!b.behind ? t('{done} · now at {hash}', { done: done || t('Pulled'), hash: a.oid.slice(0, 7) }) : b.behind === 1 ? t('{done} · {n} commit · now at {hash}', { done: done || t('Pulled'), n: b.behind, hash: a.oid.slice(0, 7) }) : t('{done} · {n} commits · now at {hash}', { done: done || t('Pulled'), n: b.behind, hash: a.oid.slice(0, 7) })) : t('Already up to date · nothing to pull')),
  push: (b, a, done, args) => (args.branch && args.branch !== a.branch ? done || t('Pushed') : b.ahead > 0 || !b.upstream ? (!b.ahead ? done || t('Pushed') : b.ahead === 1 ? t('{done} · {n} commit', { done: done || t('Pushed'), n: b.ahead }) : t('{done} · {n} commits', { done: done || t('Pushed'), n: b.ahead })) : t('{done} · {remote} was already up to date', { done: done || t('Pushed'), remote: a.upstream || t('the remote') }))
}
/** Which toolbar buttons are busy (spinning) and which just finished (a short tick). */
const working = new Set()
const justDone = new Map()
const OP_BTN = { fetch: 'fetch', pull: 'pull', push: 'push', stashSave: 'stash', refresh: 'refresh', undoLast: 'undo' }
function setWorking(op, on, ok) {
  const key = OP_BTN[op]
  if (!key) return
  if (on) working.add(key)
  else {
    working.delete(key)
    if (ok) {
      justDone.set(key, Date.now())
      setTimeout(() => (justDone.delete(key), paintWorking()), 1300)
    }
  }
  paintWorking()
}
function paintWorking() {
  for (const b of document.querySelectorAll('#toolbar [data-op]')) {
    b.classList.toggle('working', working.has(b.dataset.op))
    b.classList.toggle('done', !working.has(b.dataset.op) && justDone.has(b.dataset.op))
  }
}

/* =========================================================================
   repository selection
   ========================================================================= */
/* A folder of repositories (ABC with A, B and C inside, no .git of its own) */
const folderCache = new Map() // path → { at, value }
async function folderInside(p) {
  const hit = folderCache.get(p)
  if (hit && Date.now() - hit.at < 60000) return hit.value
  const value = await request('repo.inside', { path: p }).catch(() => null)
  folderCache.set(p, { at: Date.now(), value })
  return value
}
const folderKey = (p) => 'folderRepo:' + String(p).replace(/\\/g, '/').toLowerCase()
/** Switch to another repository of the open folder; remembered for that folder. */
function pickFolderRepo(p) {
  if (!state.folder || sameRepoPath(p, state.repo || '')) return
  store.set(folderKey(state.folder.path), p)
  setRepo(p)
  renderFolderBar()
  renderAll()
  refreshAll()
}
/**
 * The open folder's repositories as tabs right under the header (up to 8; more go in a menu), so
 * switching is one click and you always see which one you are in.
 */
function renderFolderBar() {
  let bar = document.getElementById('folderBar')
  const f = state.folder
  if (!f) return bar?.remove()
  if (!bar) {
    bar = h('div', { id: 'folderBar', class: 'folder-bar', role: 'tablist', 'aria-label': t('Repositories in this folder') })
    const header = document.querySelector('header') || document.querySelector('#toolbar')?.closest('header, .header, .top')
    if (header) header.after(bar)
    else document.body.prepend(bar)
  }
  const shown = f.children.slice(0, 8)
  const rest = f.children.slice(8)
  const cur = (c) => sameRepoPath(c.path, state.repo || '')
  append(clear(bar), [
    h('span', { class: 'folder-bar-name', title: f.path }, icon('folder', 12), basename(f.path)),
    ...shown.map((c) =>
      h(
        'button',
        { class: `folder-tab ${cur(c) ? 'on' : ''}`, role: 'tab', 'aria-selected': cur(c) ? 'true' : 'false', title: c.branch ? t('{path}\non {branch}', { path: c.path, branch: c.branch }) : c.path, onClick: () => pickFolderRepo(c.path) },
        h('span', { class: 'folder-tab-name' }, c.name),
        c.branch ? h('span', { class: 'folder-tab-branch' }, c.branch) : null
      )
    ),
    rest.length
      ? h('button', { class: `folder-tab more ${rest.some(cur) ? 'on' : ''}`, title: t('More repositories in this folder'), onClick: (e) => menu(e.currentTarget, rest.map((c) => ({ label: c.name, hint: c.branch, icon: cur(c) ? 'check' : 'branch', onClick: () => pickFolderRepo(c.path) }))) }, `+${rest.length}`, icon('down', 10))
      : null,
  ].filter(Boolean))
}

async function resolveRepo() {
  if (IN_TAB && !docRepo) {
    // The tab's file names the repository it was opened from: a fallback when focus is unknown.
    try {
      const doc = await window.orca.document.get()
      docRepo = JSON.parse(doc.content.text || '{}').repo || null
    } catch {}
  }
  let res = { focused: null, workspaces: state.workspaces }
  // A tab whose file names its project (or that the person pointed elsewhere) has nothing to look up:
  // asking Orca which workspace is focused costs a process launch, so only follow focus otherwise.
  if (!(IN_TAB && (state.pinned || docRepo))) {
    try {
      res = await request('repo.resolve', {})
    } catch (e) {
      toast(e.message, 'error')
    }
    state.workspaces = res.workspaces || []
  }
  // A Git Control tab belongs to one project (its file lives there), so it shows that project.
  // The sidebar panel follows whatever is focused.
  let target = state.pinned || (IN_TAB ? docRepo || res.focused : res.focused)
  // a folder that is not a repository but holds some (ABC with A, B, C): show the one used there last
  state.folder = null
  if (target) {
    const inside = await folderInside(target)
    if (inside && !inside.isRepo && inside.children.length) {
      state.folder = inside
      const last = store.get(folderKey(inside.path), null)
      target = (inside.children.find((c) => sameRepoPath(c.path, last || '')) || inside.children[0]).path
    }
  }
  if (target !== state.repo) setRepo(target)
  renderFolderBar()
  // A Git Control tab file (untitled.gitgraph from the + menu) must never show up as a change.
  if (IN_TAB && target && !ignoredGraphIn.has(target)) {
    ignoredGraphIn.add(target)
    request('repo.ignoreGraphFiles', { repo: target }).catch(() => {})
  }
}

/** Point the view at another repository, showing its last snapshot right away when there is one. */
function setRepo(p) {
  // switching projects: the whole page shows a loading skeleton until the new repository answers
  // (its remembered tab, scroll and open commit still come back once it does)
  const switching = !!state.repo && !!p && p !== state.repo
  if (p !== state.repo) rowCache?.clear()
  state.repo = p
  state.loadingRepo = switching
  state.status = null
  state.refs = null
  resetHistory()
  state.history.open = null
  clearSheets()
  if (p) store.set('lastRepo', p)
  // come back where this repository was left: its tab, scroll position and open commit
  if (p) {
    const m = viewMem.get()
    if (m.tab && TABS.some(([id]) => id === m.tab)) state.tab = m.tab
    state.history.open = m.open || null
    viewRestore = m.scroll || m.open ? { ...m } : null
  }
  if (switching) return showLoadingSkeleton()
  const s = p && snap.load(p)
  if (s) {
    state.status = s.status
    state.refs = s.refs
    if (s.all === state.history.all && s.commits?.length && !state.history.search) {
      state.history.commits = s.commits
      state.history.stale = true
    }
  }
}

/** What each repository's view looked like when it was left (tab, scroll, open commit). */
let viewRestore = null
const viewMem = {
  key: () => 'view.' + String(state.repo || '').replace(/\\/g, '/').toLowerCase(),
  get() {
    const v = state.repo ? store.get(viewMem.key(), null) : null
    return v && typeof v === 'object' ? v : {}
  },
  set(patch) {
    if (state.repo) store.set(viewMem.key(), { ...viewMem.get(), ...patch })
  }
}
let scrollSaveTimer = null
document.addEventListener(
  'scroll',
  (e) => {
    if (e.target?.id !== 'main' || viewRestore) return
    clearTimeout(scrollSaveTimer)
    scrollSaveTimer = setTimeout(() => viewMem.set({ scroll: Math.round($('#main').scrollTop), scrollTab: state.tab }), 300)
  },
  true
)

/* Per-repository snapshot (status, refs, first page of history) so a view renders instantly. */
const snap = {
  key: (p) => 'gitx.snap.' + p.replace(/\\/g, '/').toLowerCase(),
  load(p) {
    try {
      return JSON.parse(localStorage.getItem(snap.key(p)) || 'null')
    } catch {
      return null
    }
  },
  save() {
    if (!state.repo || !state.status) return
    const H = state.history
    const prev = snap.load(state.repo) || {}
    const commits = !H.search && H.commits.length ? H.commits.slice(0, 150) : prev.all === H.all ? prev.commits : null
    try {
      localStorage.setItem(snap.key(state.repo), JSON.stringify({ status: state.status, refs: state.refs, all: H.all, commits }))
    } catch {}
  }
}

/** Paths on a server (ssh://…) are told apart by case, as Linux does; local ones are not (Windows, macOS). */
const isRemotePath = (p) => /^ssh:\/\//.test(String(p || ''))
const sameRepoPath = (a, b) => {
  if (isRemotePath(a) || isRemotePath(b)) return String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '')
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}
/** Where a repository lives when it is not on this computer: the SSH host's name, else null. */
function hostOf(repo) {
  const m = typeof repo === 'string' && repo.match(/^ssh:\/\/([^/]+)\//)
  if (!m) return null
  const w = [...state.workspaces, ...state.serverRepos].find((x) => {
    if (!x.host) return false
    const base = x.path.replace(/\/+$/, '')
    return repo === base || repo.startsWith(base + '/')
  })
  let host = m[1]
  try {
    host = decodeURIComponent(m[1])
  } catch {}
  return w?.hostLabel || state.servers.find((x) => x.id === host)?.label || host
}
/** Workspaces grouped by repository name (and host), repositories A–Z, the main folder first in each. */
function repoGroups(ws) {
  const groups = new Map()
  for (const w of ws) {
    // the same repository on this computer and on a server are two entries
    const name = (w.repoName || basename(w.path)) + (w.host ? ` · ${w.hostLabel || w.host}` : '')
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(w)
  }
  for (const list of groups.values()) list.sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0) || String(a.branch).localeCompare(String(b.branch)))
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
}
async function repoMenu(anchor) {
  if (!state.workspaces.length) state.workspaces = (await request('repo.resolve', {}).catch(() => null))?.workspaces || []
  // projects found on servers: the menu opens at once; the first time they are asked for, it is drawn
  // again (still open, same place) when they arrive. Later they are refreshed behind it.
  if (!state.serversAt) {
    if (!repoMenu.loading)
      repoMenu.loading = loadServerRepos().finally(() => {
        repoMenu.loading = null
        if (repoMenu.open?.isConnected && state.serverRepos.length) repoMenu.open = repoMenu.draw(anchor)
      })
  } else if (Date.now() - state.serversAt > 60_000) loadServerRepos()
  repoMenu.open = repoMenu.draw(anchor)
}
repoMenu.draw = (anchor) => {
  const open = state.workspaces.filter((w) => w.kind === 'worktree' || w.kind === 'folder')
  const ws = [...open, ...state.serverRepos.filter((r) => !open.some((w) => sameRepoPath(w.path, r.path)))]
  const scanning = state.servers.some((x) => x.scanning && !x.hidden)
  const f = state.folder
  return menu(anchor, [
    ...(f
      ? [
          { header: t('In {folder}', { folder: basename(f.path) }) },
          ...f.children.map((c) => ({ label: c.name, hint: c.branch || '', icon: sameRepoPath(c.path, state.repo || '') ? 'check' : 'branch', onClick: () => pickFolderRepo(c.path) })),
          '-'
        ]
      : []),
    { label: t('Repo Overview'), icon: 'grid', onClick: () => reposOverview() },
    '-',
    { header: t('Repository') },
    {
      label: t('Follow focused workspace'),
      icon: state.pinned ? null : 'check',
      onClick: async () => {
        state.pinned = null
        store.set('pinnedRepo', null)
        await resolveRepo()
        refreshAll()
      }
    },
    '-',
    // grouped by repository (its worktrees under it), so many "dev" or "main" can be told apart
    ...repoGroups(ws).flatMap(([repoName, list]) => [
      { header: repoName },
      ...list.map((w) => ({
        label: w.branch || w.name,
        hint: list.length > 1 && w.main ? t('main folder') : '',
        icon: state.repo && sameRepoPath(state.repo, w.path) ? 'check' : w.host ? 'server' : w.kind === 'worktree' ? 'branch' : 'folder',
        onClick: () => pinRepo(w.path)
      }))
    ]),
    ws.length ? '-' : null,
    scanning ? { label: t('Looking for projects on servers…'), icon: 'refresh', disabled: true } : null,
    { label: t('Servers…'), icon: 'server', hint: serversHint(), onClick: openServers },
    { label: t('Clone repository…'), icon: 'download', onClick: cloneRepo },
    {
      label: t('Open path…'),
      icon: 'folder',
      onClick: async () => {
        const r = await dialog({
          title: t('Open repository'),
          fields: [{ key: 'path', label: t('Folder path'), value: state.repo || '', placeholder: 'C:\\code\\my-repo' }],
          ok: t('Open')
        })
        if (!r?.path) return
        const chk = await request('repo.check', { path: r.path.trim() })
        if (chk.ok) pinRepo(chk.toplevel)
        else if ((await folderInside(r.path.trim()))?.children?.length) {
          // a folder of repositories: open it; its repositories show as tabs
          state.pinned = r.path.trim()
          if (!IN_TAB) store.set('pinnedRepo', state.pinned)
          await resolveRepo()
          renderAll()
          refreshAll()
        } else {
          const init = await confirmBox(t('Not a Git repository'), t('{path}\n\nInitialize a new repository here?', { path: r.path }), 'git init')
          if (init) {
            await request('git', { op: 'init', args: { path: r.path.trim() } }).catch((e) => toast(e.message, 'error'))
            pinRepo(r.path.trim())
          }
        }
      }
    }
  ])
}
/* =========================================================================
   Repos overview: every local repository at once
   ========================================================================= */
const ROV_FILTERS = [
  ['failed', t('last command failed'), (r) => rovState.errors.has(r.path)],
  ['attention', t('need attention'), (r) => rovScore(r) >= 3],
  ['changes', t('with changes'), (r) => r.changes > 0],
  ['behind', t('behind'), (r) => r.behind > 0],
  ['ahead', t('to push'), (r) => r.ahead > 0]
]
/** Higher first: something to fix, then something to do, then clean ones. */
function rovScore(r) {
  if (r.conflicts || r.state) return 5
  if (r.error) return 4
  if (r.ci === 'failed') return 3
  return r.behind || r.changes || r.ahead ? 2 : 0
}
/** A long folder path as its last two parts ("…\work\api"); the full one is in the tooltip. */
function shortPath(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  const sep = String(p).includes('\\') ? '\\' : '/'
  return parts.length > 2 ? `…${sep}${parts.slice(-2).join(sep)}` : p
}
/** Merge requests waiting for my review in this repository (from the last Review & MR list). */
function rovReviews(r) {
  const d = state.reviews
  if (!d?.items) return []
  // by the remote's project path (GitLab's "group/web" for a folder named acme-web), else by name
  const same = (it) => (r.remote ? String(it.repo).toLowerCase() === r.remote.toLowerCase() && (!r.remoteHost || it.host === r.remoteHost) : String(it.repo).split('/').pop().toLowerCase() === String(r.name).toLowerCase())
  return d.items.filter((it) => isOpenMr(it) && same(it))
}

/**
 * Tag one or several repositories, read like a sentence: "Create uat_v* tags on branch sandbox".
 * Everything is filled in: the naming pattern the repos already use, the branch most of them are on,
 * and per repo its newest tag and the next version. Each row can take another branch; a repo without
 * the chosen branch uses the one it has checked out, and says so. The tag goes on the branch as origin
 * has it (what is pushed), and a commit that already has such a tag is left alone.
 */
async function tagManyModal(repos, onDone) {
  closeOverlays('.menu')
  // two worktrees of one repository share its tags: one row per repository (the main folder first)
  const seenRepo = new Set()
  repos = [...repos]
    .sort((a, b) => (b.main ? 1 : 0) - (a.main ? 1 : 0))
    .filter((r) => {
      const k = r.remote ? `${r.remoteHost}|${r.remote}`.toLowerCase() : r.path
      return seenRepo.has(k) ? false : seenRepo.add(k)
    })
  const paths = repos.map((r) => r.path)
  const byPath = new Map(repos.map((r) => [r.path, r]))
  const prefs = store.get('tagManyPrefs', { pattern: '', branch: '', push: true })
  let pattern = ''
  let top = '' // the branch for every repo that has it
  const own = new Map() // repo → a branch picked on its row
  const branchesOf = new Map() // repo → Set of branch names (local and on origin)
  const checkedOut = new Map() // repo → the branch checked out now
  let plan = null
  let planSeq = 0
  let busy = false

  const patternSel = h('select', { class: 'tm-sel mono' })
  const branchItems = []
  const branchIn = h('input', { type: 'text', class: 'tm-branch-in mono', spellcheck: 'false', placeholder: 'branch' })
  const branchBox = combo(branchIn, branchItems, { empty: t('No branch by that name in these repositories') })
  const branchSel = { disabled: false, set disabled(v) { branchIn.disabled = v } } // enabled with the pattern
  const table = h('div', { class: 'tm-table' }, h('div', { class: 'inline-skeleton', style: { margin: '12px' } }, h('span'), h('span')))
  const status = h('div', { class: 'tm-status dim' })
  const push = h('input', { type: 'checkbox', checked: prefs.push !== false })
  const msgIn = h('input', { type: 'text', placeholder: t('A message makes annotated tags') })
  const okBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onClick: () => apply() }, icon('tag', 13), t('Create tags'))

  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && !busy && isTopOverlay(overlay) && close()
  const box = h(
    'div',
    { class: 'dialog tag-many-dialog', role: 'dialog' },
    h('div', { class: 'ai-title' }, h('span', { class: 'tm-badge' }, icon('tag', 14)), h('div', null, h('h3', null, repos.length === 1 ? t('Tag {name}', { name: repos[0].name }) : t('Tag {n} repositories', { n: repos.length })), h('p', null, t('Everything is filled in: check the new tag, then create.')))),
    // the whole choice as one sentence
    h('div', { class: 'tm-sentence' }, t('Create'), patternSel, t('tags on branch'), branchBox, h('span', { class: 'dim tm-fetch-note' }, t('fetched from origin first'))),
    table,
    h('div', { class: 'tm-opts' }, h('label', { class: 'check' }, push, t('Push the tags')), h('details', { class: 'tm-more' }, h('summary', null, t('Message')), msgIn), h('span', { class: 'grow' }), status),
    h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'btn', onClick: () => !busy && close() }, t('Close')), h('span', { class: 'grow' }), okBtn)
  )
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && !busy && close() }, box)
  mountOverlay(overlay, close)
  document.addEventListener('keydown', onKey)
  patternSel.disabled = branchSel.disabled = true // until the repos' patterns and branches are read
  // what to ask the server for each repo: its own pick, else the shared branch when it has it, else
  // the branch it has checked out
  const branchFor = (p) => own.get(p) || (branchesOf.get(p)?.has(top) ? top : checkedOut.get(p) || byPath.get(p)?.branch || top)

  // 1. the patterns these repos use and their branches, both at once
  const [patterns] = await Promise.all([
    request('repos.tagPatterns', { repos: paths }, 60000).catch(() => []),
    Promise.all(
      paths.map(async (p) => {
        const refs = await request('git', { op: 'refs', repo: p, args: {} }).catch(() => null)
        const set = new Set((refs?.local || []).map((b) => b.name))
        const cur = (refs?.local || []).find((b) => b.current)?.name
        if (cur) checkedOut.set(p, cur) // what is checked out now (the overview's copy may be older)
        for (const b of refs?.remote || []) if (/^[^/]+\//.test(b.name)) set.add(b.name.replace(/^[^/]+\//, ''))
        set.delete('HEAD')
        branchesOf.set(p, set)
      })
    )
  ])
  patternSel.disabled = branchSel.disabled = false
  const pats = patterns.length ? patterns.map((x) => x.pattern) : []
  pattern = prefs.pattern && pats.includes(prefs.pattern) ? prefs.pattern : pats[0] || 'v*'
  const fillPatterns = () => {
    clear(patternSel)
    for (const p of [...new Set([...pats, pattern, 'v*'])]) patternSel.append(h('option', { value: p, selected: p === pattern }, p))
    patternSel.append(h('option', { value: '__new' }, t('Another pattern…')))
  }
  fillPatterns()
  patternSel.addEventListener('change', async () => {
    if (patternSel.value === '__new') {
      const r = await dialog({ title: t('Tag pattern'), message: t('The part before the version, then *, e.g. v*, dev_v*, release-*'), fields: [{ key: 'p', label: t('Pattern'), value: pattern }], ok: t('Use'), stack: true })
      if (r?.p && /^[\w.*/-]+$/.test(r.p.trim())) pattern = r.p.trim()
      fillPatterns()
    } else pattern = patternSel.value
    loadPlan()
  })
  // the shared branch: the one most repos are on (the one used last, when they all have it)
  const count = new Map()
  for (const set of branchesOf.values()) for (const b of set) count.set(b, (count.get(b) || 0) + 1)
  const onNow = new Map()
  for (const r of repos) {
    const b = checkedOut.get(r.path) || r.branch
    if (b) onNow.set(b, (onNow.get(b) || 0) + 1)
  }
  top = prefs.branch && count.get(prefs.branch) === paths.length ? prefs.branch : [...onNow.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || [...count.keys()][0] || 'main'
  const names = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([b]) => b).slice(0, 300)
  branchItems.push(...names.map((b) => ({ value: b, detail: paths.length > 1 ? t('{n} of {total}', { n: count.get(b), total: paths.length }) : '' })))
  branchIn.value = top
  // a branch typed or picked that exists somewhere: the plan follows it (after a short pause while typing)
  let branchT = null
  branchIn.addEventListener('input', () => {
    clearTimeout(branchT)
    branchT = setTimeout(() => {
      const v = branchIn.value.trim()
      if (v && v !== top && count.has(v)) (top = v), own.clear(), loadPlan()
    }, 350)
  })

  async function loadPlan() {
    const my = ++planSeq
    const branches = Object.fromEntries(paths.map((p) => [p, branchFor(p)]))
    okBtn.disabled = true
    clear(table).append(h('div', { class: 'tm-empty dim tm-fetching' }, h('span', { class: 'spinner sm' }), ' ' + t('Fetching {branch} from origin…', { branch: top })))
    try {
      const r = await request('repos.tagPlan', { repos: paths, pattern, base: { kind: 'branch', name: top }, branches, fetch: true }, 150000)
      if (my !== planSeq) return
      plan = r.rows
      drawTable()
    } catch (e) {
      if (my !== planSeq) return
      clear(table).append(h('div', { class: 'ai-error tm-empty' }, icon('alert', 12), e.message))
    }
  }
  const inputs = new Map()
  function drawTable() {
    inputs.clear()
    clear(table).append(h('div', { class: 'tm-row tm-head' }, h('span'), h('span', null, t('Repository')), h('span', null, t('Branch')), h('span', null, t('Newest {pattern}', { pattern })), h('span', null, t('New tag'))))
    for (const row of plan) {
      const done = row.already?.length
      const b = branchFor(row.repo)
      const take = h('input', { type: 'checkbox', checked: !row.error && !done, disabled: !!row.error || !!done })
      const name = h('input', { type: 'text', class: 'tm-name mono', value: row.next || '', spellcheck: 'false' })
      name.addEventListener('input', () => ((take.checked = !!name.value.trim()), countUp()))
      take.addEventListener('change', countUp)
      const own_ = branchesOf.get(row.repo) || new Set()
      const rowIn = h('input', { type: 'text', class: 'tm-row-branch mono', value: b, spellcheck: 'false', title: t('The branch to tag in this repository') })
      const sel = combo(rowIn, [...own_].sort((a, c) => (a === b ? -1 : c === b ? 1 : a.localeCompare(c))).map((x) => ({ value: x })), { empty: t('No branch by that name here') })
      let rowT = null
      rowIn.addEventListener('input', () => {
        clearTimeout(rowT)
        rowT = setTimeout(() => {
          const v = rowIn.value.trim()
          if (v && v !== b && own_.has(v)) own.set(row.repo, v), loadPlan()
        }, 350)
      })
      const fallback = !own.has(row.repo) && b !== top
      inputs.set(row.repo, { take, name, row })
      table.append(
        h(
          'div',
          { class: `tm-row ${done ? 'done' : ''} ${row.error ? 'err' : ''}`, 'data-repo': row.repo },
          take,
          h('span', { class: 'tm-repo', title: row.repo }, byPath.get(row.repo)?.name || row.name),
          h(
            'span',
            { class: 'tm-branch' },
            sel,
            row.error
              ? h('span', { class: 'bad' }, icon('alert', 11), row.error)
              : h('span', { class: `ellipsis ${row.fetchError ? 'tm-warn' : 'dim'}`, title: `${row.at} · ${row.hash}\n${row.subject || ''}${row.fetchError ? '\n' + t('Could not fetch: {error}', { error: row.fetchError }) : ''}` }, row.fetchError ? t('not fetched (as last fetched) · ') : '', fallback ? t('no {branch} here · ', { branch: top }) : '', `${(row.hash || '').slice(0, 7)} ${row.subject || ''}`)
          ),
          h('span', { class: 'tm-latest mono' }, row.latest || h('span', { class: 'dim' }, t('none yet'))),
          h('span', { class: 'tm-new' }, done ? h('span', { class: 'pill tm-already', title: t('That commit already has {tag}: nothing to do', { tag: row.already[0] }) }, icon('check', 10), t('Already {tag}', { tag: row.already[0] })) : row.error ? h('span', { class: 'dim' }, '–') : [h('span', { class: 'tm-arrow dim' }, '→'), name])
        )
      )
    }
    countUp()
  }
  function countUp() {
    const take = [...inputs.values()].filter((x) => x.take.checked && x.name.value.trim())
    okBtn.disabled = busy || !take.length
    clear(okBtn).append(icon('tag', 13), take.length ? (take.length > 1 ? (push.checked ? t('Create {n} tags and push', { n: take.length }) : t('Create {n} tags', { n: take.length })) : push.checked ? t('Create {n} tag and push', { n: take.length }) : t('Create {n} tag', { n: take.length })) : t('Nothing to tag'))
    const done = plan ? plan.filter((r) => r.already?.length).length : 0
    status.textContent = plan ? [done ? t('{n} already tagged', { n: done }) : '', plan.some((r) => r.error) ? t('{n} cannot', { n: plan.filter((r) => r.error).length }) : ''].filter(Boolean).join(' · ') : ''
  }
  push.addEventListener('change', countUp)

  async function apply() {
    const take = [...inputs.values()].filter((x) => x.take.checked && x.name.value.trim())
    if (!take.length) return
    const list = take.map((x) => t('  • {repo}: {tag} on {branch} ({hash})', { repo: byPath.get(x.row.repo)?.name || x.row.name, tag: x.name.value.trim(), branch: x.row.at, hash: x.row.hash.slice(0, 7) })).join('\n')
    if (!(await confirmBox(take.length > 1 ? t('Create {n} tags?', { n: take.length }) : t('Create {n} tag?', { n: take.length }), `${list}${push.checked ? '\n\n' + t('Each is pushed to its remote.') : ''}`, push.checked ? t('Create and push') : t('Create')))) return
    store.set('tagManyPrefs', { pattern, branch: top, push: push.checked })
    busy = true
    countUp()
    for (const x of take) x.take.closest('.tm-row').classList.add('working')
    let res = []
    try {
      res = await request('repos.tagApply', { items: take.map((x) => ({ repo: x.row.repo, name: x.name.value.trim(), hash: x.row.hash })), push: push.checked, message: msgIn.value.trim() }, 300000)
    } catch (e) {
      toast(e.message, 'error')
    }
    busy = false
    for (const r of res) {
      const el = [...table.querySelectorAll('.tm-row')].find((x) => x.dataset.repo === r.repo)
      if (!el) continue
      el.classList.remove('working')
      el.classList.add(r.ok ? 'made' : 'failed')
      el.querySelector('.tm-new').replaceChildren(r.ok ? h('span', { class: 'pill tm-made' }, icon('check', 10), r.pushed ? t('{tag} · pushed', { tag: r.name }) : r.name) : h('span', { class: 'bad', title: r.error }, icon('alert', 11), r.error))
    }
    const good = res.filter((r) => r.ok).length
    toast(good === res.length ? (good === 1 ? t('Tagged {n} repository', { n: good }) : t('Tagged {n} repositories', { n: good })) : t('Tagged {n} of {total}', { n: good, total: res.length }), good === res.length ? 'ok' : 'error')
    okBtn.disabled = true
    clear(okBtn).append(icon('check', 13), t('Done'))
    onDone?.()
  }

  loadPlan()
}

/** Repos overview lives in its own tab; this opens it. */
function reposOverview() {
  if (state.tab === 'repos') return
  store.set('lastTabBeforeRepos', state.tab || 'history')
  setTab('repos')
}
// kept between visits: the tab draws at once from the last answer and refreshes behind it
const rovState = { data: null, at: 0, loading: null, busy: new Map(), filter: '', text: '', sel: new Set(), errors: new Map() }
async function viewRepos() {
  const root = h('div', { class: 'view rov-page' })
  const body = h('div', { class: 'rov' })
  const busy = rovState.busy // path → what runs there now
  let data = rovState.data
  let filter = rovState.filter
  let text = rovState.text
  const refreshBtn = h('button', { class: 'btn sm rov-refresh', title: t('Read every repository again'), onClick: () => load() }, rovState.loading ? h('span', { class: 'spinner sm' }) : icon('refresh', 12), t('Refresh'))
  root.append(
    h('div', { class: 'rov-top' }, h('div', { class: 'rov-heading' }, h('h2', null, t('Repo Overview')), h('span', { class: 'dim' }, t('Every repository at once'))), h('span', { class: 'grow' }), refreshBtn),
    body
  )
  // what a command acts on: the ticked repos, or every one shown when none is ticked
  const targets = () => {
    const all = (rovState.data?.repos || []).filter((r) => !r.error)
    return rovState.sel.size ? all.filter((r) => rovState.sel.has(r.path)) : shownRepos()
  }
  const summary = h('div', { class: 'rov-summary' })
  const fbar = h('div', { class: 'rov-filterbar-wrap' }) // sticky: selection and commands stay in view
  const list = h('div', { class: 'rov-list' })

  async function load() {
    if (rovState.loading) return rovState.loading
    if (!data) clear(body).append(h('div', { class: 'skeleton-list' }, ...Array.from({ length: 6 }, () => h('div', { class: 'skeleton-row' }, h('span', { class: 'bar' })))))
    rovState.loading = (async () => {
      try {
        const prevCi = new Map((rovState.data?.repos || []).map((r) => [r.path, [r.ci, r.ciUrl]]))
        const fresh = await request('repos.overview', {}, 120000)
        for (const r of fresh.repos) if (prevCi.has(r.path)) [r.ci, r.ciUrl] = prevCi.get(r.path)
        Object.assign(rovState, { data: fresh, at: Date.now() })
      } catch (e) {
        if (!rovState.data && root.isConnected) clear(body).append(h('div', { class: 'empty' }, icon('alert', 28), h('div', null, e.message)))
        else toast(e.message, 'error')
        return
      } finally {
        rovState.loading = null
      }
      if (state.tab === 'repos') renderView({ force: true }) // draws the fresh answer
      loadCi()
    })()
    return rovState.loading
  }
  // CI comes after the rows (it asks GitHub / GitLab), 3 at a time
  async function loadCi() {
    const todo = (rovState.data?.repos || []).filter((r) => !r.error && r.branch) // the latest answer, not this page's copy
    let i = 0
    await Promise.all(
      [0, 1, 2].map(async () => {
        while (i < todo.length && state.tab === 'repos') {
          const r = todo[i++]
          const c = await request('git', { op: 'ciStatus', repo: r.path, args: {} }, 40000).catch(() => null)
          r.ci = c?.state || null
          r.ciUrl = c?.url || null
          paintRow(r)
        }
      })
    )
    if (state.tab === 'repos') document.querySelector('.rov-page')?.dispatchEvent(new Event('rov-summary'))
  }
  async function refreshOne(r) {
    const fresh = await request('repos.overview', {}, 120000).catch(() => null)
    const n = fresh?.repos.find((x) => x.path === r.path)
    if (n) Object.assign(r, n, { ci: r.ci, ciUrl: r.ciUrl })
  }

  // open merge / pull requests across every repo, from the Review & MR list (no extra requests)
  function mrCard() {
    const d = state.reviews
    if (!d) {
      loadReviews().then(() => state.tab === 'repos' && document.querySelector('.rov-page')?.dispatchEvent(new Event('rov-summary')), () => {})
      return h('div', { class: 'rov-health rov-mr' }, h('div', { class: 'rov-health-head' }, h('span', { class: 'rov-tile-label' }, t('Merge requests')), h('span', { class: 'dim' }, h('span', { class: 'spinner sm' }), ' ', t('loading'))))
    }
    const open = (d.items || []).filter(isOpenMr)
    const go = (filter) => () => ((state.reviewFilter = filter), store.set('reviewsAllRepos', true), setTab('reviews'))
    // each kind its own colour (a dot, the count and the frame), dimmed when there are none
    const row = (label, n, tone, title) => h('button', { class: `rov-mr-i t-${tone} ${n ? '' : 'zero'}`, title, onClick: go('todo') }, h('span', { class: 'rov-mr-dot' }), h('b', null, String(n)), h('span', null, label))
    return h(
      'div',
      { class: 'rov-health rov-mr' },
      h('div', { class: 'rov-health-head' }, h('span', { class: 'rov-tile-label' }, t('Merge requests')), h('button', { class: 'linkish', onClick: go('todo') }, t('{n} for you →', { n: open.filter((it) => forMe(it) || isMine(it)).length }))),
      h(
        'div',
        { class: 'rov-mr-grid' },
        row(t('to review'), open.filter(needsMe).length, 'review', t('Waiting for your approval')),
        row(t('opened by you'), open.filter(isMine).length, 'mine', t('Your open merge requests')),
        row(t('approved, not merged'), open.filter((it) => it.myApproved && !isMine(it)).length, 'approved', t('You approved them; waiting to be merged')),
        row(t('pipeline running'), open.filter(ciBusy).length, 'running', t('Their pipeline is still running')),
        row(t('with conflicts'), open.filter((it) => it.conflicts).length, 'conflict', t('Need their conflicts resolved'))
      )
    )
  }
  // selected repos: what can be done to all of them at once
  const selBarEl = h('div', { class: 'rov-selbar' })
  rovState.bar = selBarEl // this page is the newest
  // rovState.data, not this page's copy: a row drawn again later may still call these
  const shownRepos = () => [...document.querySelectorAll('.rov-row')].map((x) => rovState.data?.repos.find((r) => r.path === x.dataset.path)).filter((r) => r && !r.error)
  // the page on screen, drawn again from what is known (no reading of the repos)
  const redrawPage = () => state.tab === 'repos' && renderView({ force: true })
  function drawSelBar() {
    if (!rovState.data) return
    // the newest page's bar (a row drawn by an earlier copy of the page calls this too)
    const selBar = rovState.bar || selBarEl
    for (const p of [...rovState.sel]) if (!rovState.data.repos.some((r) => r.path === p)) rovState.sel.delete(p)
    const n = rovState.sel.size
    const all = shownRepos()
    const failed = [...rovState.errors.keys()].filter((p) => rovState.data.repos.some((r) => r.path === p)).length
    const cmd = (ic, label, title, fn, cls = '') => h('button', { class: `btn sm ${cls}`, title, onClick: fn }, icon(ic, 12), label)
    const pick = h('input', { type: 'checkbox', class: 'rov-pick rov-pick-all', title: n ? t('Clear the selection') : t('Select every repository shown'), 'aria-label': t('Select all') })
    pick.checked = n > 0 && n >= all.length
    pick.indeterminate = n > 0 && n < all.length
    pick.addEventListener('change', () => (n ? rovState.sel.clear() : all.forEach((r) => rovState.sel.add(r.path)), redrawPage()))
    append(clear(selBar), [
      pick,
      n
        ? [
            h('span', { class: 'rov-sel-n' }, t('{n} selected', { n })),
            cmd('fetch', t('Fetch'), t('Fetch the {n} selected', { n }), () => fetchAll(), 'rov-fetch-sel'),
            cmd('pull', t('Pull'), t('Pull the selected, where it is safe'), () => pullAll(), 'rov-pull-all'),
            cmd('push', t('Push'), t('Push the selected, where it is safe'), () => pushAll(), 'rov-push-all'),
            cmd('tag', t('Tag…'), t('Tag the selected, each with its next version'), () => tagManyModal(targets(), () => load()), 'rov-tag-btn'),
            cmd('branch', t('Switch branch…'), t('Switch the selected to one branch'), () => switchAll(), 'rov-switch-all'),
            cmd('plus', t('New branch…'), t('Create the same branch in the selected'), () => newBranchMany(), 'rov-new-branch'),
            h('button', { class: 'btn sm ghost', title: t('Clear the selection'), onClick: () => (rovState.sel.clear(), redrawPage()) }, t('Clear'))
          ]
        : [h('span', { class: 'dim rov-sel-hint' }, t('Tick repositories to fetch, pull, push, tag or switch them together')), cmd('fetch', t('Fetch all'), t('Fetch every repository shown (4 at a time)'), () => fetchAll(), 'rov-fetch-all')],
      failed ? h('button', { class: `btn sm rov-failed ${filter === 'failed' ? 'on' : ''}`, title: t('Show only the repositories whose last command failed'), onClick: () => ((filter = rovState.filter = filter === 'failed' ? '' : 'failed'), draw()) }, icon('alert', 12), t('{n} failed', { n: failed })) : null
    ].flat().filter(Boolean))
  }
  // the dashboard: tiles that filter the list, and one bar of how healthy the repos are
  function drawSummary() {
    const rs = data.repos
    const branches = new Set(rs.filter((r) => r.branch).map((r) => r.branch))
    const setFilter = (k) => ((filter = filter === k ? '' : k), (rovState.filter = filter), draw())
    const sum = (f) => rs.reduce((n, r) => n + (r[f] || 0), 0)
    const count = (k) => rs.filter(ROV_FILTERS.find(([x]) => x === k)[2]).length
    const tile = (k, label, value, sub, tone) =>
      h(
        'button',
        { class: `rov-tile ${tone || ''} ${filter === k ? 'on' : ''}`, 'data-k': k || 'all', title: k ? t('Show only these: {label}', { label: label.toLowerCase() }) : t('Show every repository'), onClick: () => setFilter(k) },
        h('span', { class: 'rov-tile-label' }, label),
        h('span', { class: 'rov-tile-value' }, String(value)),
        h('span', { class: 'rov-tile-sub dim' }, sub)
      )
    const tiles = h(
      'div',
      { class: 'rov-tiles' },
      tile('', t('Repositories'), rs.length, branches.size > 1 ? t('on {n} branches', { n: branches.size }) : branches.size ? t('all on {branch}', { branch: [...branches][0] }) : '-'),
      tile('attention', t('Need attention'), count('attention'), t('conflicts or failed CI'), count('attention') ? 'bad' : ''),
      tile('changes', t('With changes'), count('changes'), t('{n} files changed', { n: sum('changes') }), count('changes') ? 'warn' : ''),
      tile('behind', t('To pull'), count('behind'), t('{n} commits behind', { n: sum('behind') }), count('behind') ? 'warn' : ''),
      tile('ahead', t('To push'), count('ahead'), t('{n} commits ahead', { n: sum('ahead') }), count('ahead') ? 'good' : '')
    )
    // health: each repo is clean, has something to do, or needs fixing (named, never colour alone)
    const tone = (r) => (r.error || r.conflicts || r.state || r.ci === 'failed' ? 'bad' : r.behind || r.changes || r.ahead ? 'warn' : 'ok')
    const parts = [
      ['ok', t('Clean'), rs.filter((r) => tone(r) === 'ok')],
      ['warn', t('Something to do'), rs.filter((r) => tone(r) === 'warn')],
      ['bad', t('Needs fixing'), rs.filter((r) => tone(r) === 'bad')]
    ]
    const health = h(
      'div',
      { class: 'rov-health' },
      h('div', { class: 'rov-health-head' }, h('span', { class: 'rov-tile-label' }, t('Health')), h('span', { class: 'dim' }, t('{n} of {total} clean and up to date', { n: parts[0][2].length, total: rs.length }))),
      h(
        'div',
        { class: 'rov-health-bar', role: 'img', 'aria-label': parts.map(([, l, x]) => `${l}: ${x.length}`).join(', ') },
        ...parts.filter(([, , x]) => x.length).map(([k, l, x]) => h('span', { class: `rov-seg ${k}`, style: { flexGrow: String(x.length) }, title: `${l}: ${x.length}\n${x.map((r) => r.name).join('\n')}` }))
      ),
      h('div', { class: 'rov-legend' }, ...parts.map(([k, l, x]) => h('span', { class: 'rov-legend-i' }, h('span', { class: `rov-key ${k}` }), `${l} `, h('b', null, String(x.length)))))
    )
    const search = h('input', { class: 'rov-search', type: 'search', placeholder: t('Filter by name or branch…'), value: text })
    search.addEventListener('input', () => ((text = search.value), (rovState.text = text), drawList()))
    const label = ROV_FILTERS.find(([x]) => x === filter)?.[1]
    append(clear(summary), [h('div', { class: 'rov-dash' }, tiles, h('div', { class: 'rov-side' }, health, mrCard()))])
    append(clear(fbar), [
      h('div', { class: 'rov-filterbar' }, selBarEl, label ? h('button', { class: 'rov-chip on', title: t('Show every repository'), onClick: () => setFilter(filter) }, t('Only {label}', { label }), icon('x', 10)) : null, h('span', { class: 'grow' }), search)
    ])
    drawSelBar()
  }
  function draw() {
    clear(body)
    drawSummary()
    body.append(summary, fbar, list)
    body.append(
      data.roots?.length
        ? h('div', { class: 'rov-foot dim', title: data.roots.join('\n') }, icon('folder', 12), t('Also listing the repos inside {folders}', { folders: data.roots.map(shortPath).join('; ') }), ' · ', h('button', { class: 'linkish', onClick: () => scanFolders() }, t('Change')))
        : h('div', { class: 'rov-foot dim' }, data.servers ? t('Lists the repositories opened in Orca and the ones on your servers. ') : t('Lists the repositories opened in Orca. '), h('button', { class: 'linkish', onClick: () => scanFolders() }, t('Scan a folder')), t(' to add the repos inside it too.')) // i18n: "[Scan a folder] to add the repos inside it too."
    )
    drawList()
  }
  function drawList() {
    const fn = ROV_FILTERS.find(([k]) => k === filter)?.[2] || (() => true)
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    const rows = data.repos
      .filter(fn)
      .filter((r) => words.every((w) => `${r.name} ${r.branch || ''} ${r.path}`.toLowerCase().includes(w)))
      .sort((a, b) => rovScore(b) - rovScore(a) || a.name.localeCompare(b.name))
    clear(list)
    if (!rows.length) list.append(h('div', { class: 'empty' }, icon('check', 24), h('div', null, data.repos.length ? t('No repository matches') : t('No repositories yet: open some in Orca, or scan a folder'))))
    // one branch column for every row: as wide as the longest name shown (140–320 px), so names show
    // in full when there is room and the columns line up
    const longest = Math.max(4, ...rows.map((r) => (r.branch || `detached ${r.oid || ''}`).length))
    list.style.setProperty('--rov-bw', `${Math.min(320, Math.max(140, Math.round(longest * 7.6 + 52)))}px`)
    const put = (r) => {
      const row = h('div', { class: 'rov-row', 'data-path': r.path })
      fillRow(row, r)
      list.append(row)
    }
    // grouped like Orca's sidebar (its Project Groups, in their order); the rest under "Other"
    // and a server's repos under that server
    if ((data.grouped || data.servers) && rows.some((r) => r.group)) {
      const groups = new Map()
      for (const r of rows) {
        const k = r.group?.id || ''
        if (!groups.has(k)) groups.set(k, { name: r.group ? r.group.name || t('Project group') : data.grouped ? t('Not in a project group') : t('On this computer'), server: !!r.group?.server, order: r.group ? r.group.order : data.grouped ? 1e9 : -1, rows: [] })
        groups.get(k).rows.push(r)
      }
      for (const g of [...groups.values()].sort((a, b) => a.order - b.order)) {
        // inside a group: Orca's own order, as its sidebar lists them
        g.rows.sort((a, b) => (a.group?.repoOrder ?? 1e9) - (b.group?.repoOrder ?? 1e9) || a.name.localeCompare(b.name))
        const need = g.rows.filter((r) => rovScore(r) >= 2).length
        list.append(h('div', { class: 'rov-grp' }, icon(g.server ? 'server' : 'folder', 12), h('span', { class: 'rov-grp-name' }, g.name), h('span', { class: 'rov-group-n' }, String(g.rows.length)), need ? h('span', { class: 'rov-grp-need' }, t('{n} need you', { n: need })) : null))
        g.rows.forEach(put)
      }
    } else rows.forEach(put)
  }
  function paintRow(r) {
    // the row on screen now (the tab may have been drawn again since this one was built)
    const row = [...document.querySelectorAll('.rov-row')].find((x) => x.dataset?.path === r.path)
    if (row) fillRow(row, r)
  }
  function fillRow(row, r) {
    const doing = busy.get(r.path)
    const here = state.repo && sameRepoPath(state.repo, r.toplevel || r.path)
    const tone = r.error || r.conflicts || r.state || r.ci === 'failed' ? 'bad' : r.behind || r.changes || r.ahead ? 'warn' : 'ok'
    const reviews = rovReviews(r)
    row.classList.toggle('busy', !!doing)
    const failure = rovState.errors.get(r.path)
    row.classList.toggle('failed', !!failure)
    const pick = h('input', { type: 'checkbox', class: 'rov-pick', 'aria-label': t('Select {name}', { name: r.name }), checked: rovState.sel.has(r.path), disabled: !!r.error })
    pick.addEventListener('change', () => (pick.checked ? rovState.sel.add(r.path) : rovState.sel.delete(r.path), row.classList.toggle('sel', pick.checked), drawSelBar()))
    row.classList.toggle('sel', rovState.sel.has(r.path))
    clear(row).append(
      pick,
      h('span', { class: `rov-dot ${tone}`, title: tone === 'ok' ? t('Clean and up to date') : tone === 'bad' ? t('Needs fixing') : t('Something to do') }),
      h(
        'div',
        { class: 'rov-name', title: r.path },
        h(
          'div',
          { class: 'rov-title' },
          h('span', { class: 'ellipsis' }, r.name),
          here && h('span', { class: 'pill' }, t('open here')),
          r.source === 'scan' && h('span', { class: 'pill', title: t('Found by scanning a folder; not opened in Orca') }, t('scanned'))
        ),
        failure
          ? h('div', { class: 'rov-fail', title: failure.message }, icon('alert', 11), h('span', { class: 'ellipsis' }, t('{op} failed: {error}', { op: { fetch: t('Fetch'), pull: t('Pull'), push: t('Push'), checkout: t('Switch'), branchCreate: t('New branch') }[failure.op] || t('Last command'), error: failure.message })))
          : h('div', { class: 'rov-path dim mono ellipsis' }, shortPath(r.host ? r.path.replace(/^ssh:\/\/[^/]+/, '') : r.path))
      ),
      r.error
        ? h('span', { class: 'rov-err', title: r.error }, icon('alert', 12), h('span', { class: 'ellipsis' }, r.error))
        : h(
            'div',
            { class: 'rov-cells' },
            h('button', { class: 'rov-branch', title: t('Switch branch'), disabled: !!doing, onClick: (e) => switchMenu(e.currentTarget, r) }, icon('branch', 11), h('span', { class: 'ellipsis' }, r.branch || t('detached {oid}', { oid: r.oid })), icon('down', 10)),
            h(
              'span',
              { class: 'rov-sync', title: r.upstream ? t('Compared with {upstream}', { upstream: r.upstream }) : t('This branch has no upstream') },
              r.ahead ? h('span', { class: 'up' }, `↑${r.ahead}`) : null,
              r.behind ? h('span', { class: 'down' }, `↓${r.behind}`) : null,
              !r.ahead && !r.behind ? h('span', { class: 'dim' }, r.upstream ? t('up to date') : t('no upstream')) : null
            ),
            h(
              'span',
              { class: `rov-changes ${r.changes ? 'has' : ''}` },
              r.conflicts ? h('span', { class: 'bad' }, r.conflicts > 1 ? t('{n} conflicts', { n: r.conflicts }) : t('{n} conflict', { n: r.conflicts })) : r.changes ? t('{n} changed', { n: r.changes }) : h('span', { class: 'dim' }, t('clean')),
              r.state ? h('span', { class: 'pill rv-conflict' }, `${r.state}`) : null
            ),
            h('span', { class: 'rov-tagcol' }, r.tag ? h('button', { class: 'rov-tag', title: r.tagAt ? t('Latest tag {tag} ({when}). Click to tag again', { tag: r.tag, when: ago(r.tagAt) }) : t('Latest tag {tag}. Click to tag again', { tag: r.tag }), onClick: () => tagManyModal([r], () => load()) }, icon('tag', 10), h('span', { class: 'ellipsis' }, r.tag)) : h('span', { class: 'dim' }, t('no tags'))),
            h('span', { class: 'rov-ci' }, r.ci ? h('button', { class: `ci ci-${r.ci}`, title: r.ciUrl ? t('Open the pipeline') : t('CI {state}', { state: r.ci }), onClick: () => r.ciUrl && openLink(r.ciUrl) }, ciIcon(r.ci), r.ci) : null),
            h(
              'span',
              { class: 'rov-rv' },
              // its open merge requests, and how many wait for me; a click shows them
              reviews.length
                ? h('button', { class: `pill ${reviews.some(needsMe) ? 'rv-new' : 'rov-mr-open'}`, title: reviews.map((it) => `${mrRef(it)} ${it.title}`).join('\n'), onClick: () => openRepo(r, 'reviews') }, icon('pr', 10), `${t('{n} open', { n: reviews.length })}${reviews.some(needsMe) ? ` · ${t('{n} to review', { n: reviews.filter(needsMe).length })}` : ''}`)
                : null
            )
          ),
      h(
        'div',
        { class: 'rov-actions' },
        doing
          ? h('span', { class: 'rov-doing dim' }, h('span', { class: 'spinner sm' }), doing)
          : [
              !r.error && iconBtn('fetch', t('Fetch {name}', { name: r.name }), () => act(r, 'fetch'), { class: 'icon-btn rov-fetch' }),
              !r.error && iconBtn('tag', t('Tag {name}: its next version', { name: r.name }), () => tagManyModal([r], () => load()), { class: 'icon-btn rov-tag-one' }),
              !r.error && r.behind > 0 ? h('button', { class: 'btn sm rov-pull', title: r.behind > 1 ? t('Pull {n} commits into {branch}', { n: r.behind, branch: r.branch }) : t('Pull {n} commit into {branch}', { n: r.behind, branch: r.branch }), onClick: () => act(r, 'pull') }, icon('pull', 12), t('Pull')) : null,
              h('button', { class: 'btn sm primary rov-open', title: t('Open {name} in Git Control', { name: r.name }), onClick: () => openRepo(r) }, t('Open')),
              iconBtn('more', t('More for {name}', { name: r.name }), (e) => rowMenu(e.currentTarget, r), { class: 'icon-btn rov-row-more' })
            ]
      )
    )
  }
  function rowMenu(anchor, r) {
    menu(anchor, [
      { label: t('Merge requests'), icon: 'pr', onClick: () => openRepo(r, 'reviews') },
      { label: t('Pipelines'), icon: 'pipeline', onClick: () => openRepo(r, 'pipelines') },
      { label: t('Commit tab'), icon: 'commit', onClick: () => openRepo(r, 'changes') },
      '-',
      !r.error && r.ahead > 0 ? { label: r.ahead > 1 ? t('Push {n} commits', { n: r.ahead }) : t('Push {n} commit', { n: r.ahead }), icon: 'push', onClick: () => act(r, 'push') } : null,
      { label: t('Copy path'), icon: 'copy', onClick: () => navigator.clipboard?.writeText(r.path).then(() => toast(t('Path copied')), () => toast(r.path)) }
    ].filter(Boolean))
  }
  // the branches of every repo: name → { local: [repo…], remote: [repo…] }
  async function branchMap(rs) {
    const map = new Map()
    const add = (name, kind, r) => {
      if (!map.has(name)) map.set(name, { local: new Set(), remote: new Set() })
      map.get(name)[kind].add(r.path)
    }
    let i = 0
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        while (i < rs.length) {
          const r = rs[i++]
          const refs = await request('git', { op: 'refs', repo: r.path, args: {} }).catch(() => null)
          for (const b of refs?.local || []) add(b.name, 'local', r)
          for (const b of refs?.remote || []) if (/^origin\//.test(b.name)) add(b.name.replace(/^origin\//, ''), 'remote', r)
        }
      })
    )
    return map
  }
  async function switchAll() {
    const rs = targets()
    toast(t('Reading the branches of every repo…'))
    const map = await branchMap(rs)
    // branches found in two repos or more first: those are the ones worth switching together
    const names = [...map.entries()]
      .map(([n, v]) => [n, new Set([...v.local, ...v.remote]).size])
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    if (!names.length) return toast(t('No branches found'))
    const res = await dialog({
      title: t('Switch all to a branch'),
      message: t('Every repo that has this branch (here or on origin) switches to it. The others stay where they are.'),
      fields: [{ key: 'name', label: t('Branch'), type: 'select', value: names[0][0], options: names.slice(0, 200).map(([n, c]) => [n, c > 1 ? t('{branch}  ({n} repos)', { branch: n, n: c }) : t('{branch}  ({n} repo)', { branch: n, n: c })]) }],
      ok: t('Next'),
      stack: true
    })
    if (!res?.name) return
    const name = res.name
    const v = map.get(name)
    const on = rs.filter((r) => r.branch === name)
    const go = rs.filter((r) => r.branch !== name && (v.local.has(r.path) || v.remote.has(r.path)))
    const none = rs.filter((r) => !v.local.has(r.path) && !v.remote.has(r.path))
    if (!go.length) return toast(on.length ? t('Every repo that has {branch} is already on it', { branch: name }) : t('No repo has {branch}', { branch: name }))
    const msg = [
      `${t('Switch to {branch}:', { branch: name })}\n${go.map((r) => `  • ${r.name} (${v.local.has(r.path) ? t('from {branch}', { branch: r.branch || t('detached') }) : t('from {branch}, new from origin', { branch: r.branch || t('detached') })})${r.changes ? ` · ${r.changes > 1 ? t('{n} uncommitted changes kept when they do not clash', { n: r.changes }) : t('{n} uncommitted change kept when they do not clash', { n: r.changes })}` : ''}`).join('\n')}`,
      on.length ? `\n${t('Already on it: {repos}', { repos: on.map((r) => r.name).join(', ') })}` : '',
      none.length ? `\n${t('No such branch, left as they are: {repos}', { repos: none.map((r) => r.name).join(', ') })}` : ''
    ].join('\n')
    if (!(await confirmBox(t('Switch {repos} to {branch}?', { repos: plural(go.length), branch: name }), msg, t('Switch')))) return
    const errs = await runEach(go, (r) => act(r, 'checkout', v.local.has(r.path) ? { ref: name } : { ref: `origin/${name}`, track: true }, true))
    errs.length ? toast(`${t('Switched {n} of {total}', { n: go.length - errs.length, total: go.length })}\n${errs.join('\n')}`, 'error') : toast(t('{repos} now on {branch}', { repos: plural(go.length), branch: name }))
  }
  async function newBranchMany() {
    const rs = targets()
    const shown = new Set([...list.children].map((x) => x.dataset?.path).filter(Boolean))
    const res = await dialog({
      title: t('New branch in several repos'),
      message: t('Creates the branch from the commit each repo is on now.'),
      fields: [
        { key: 'name', label: t('Branch name'), value: '', placeholder: 'feature/new-thing' },
        { key: 'checkout', label: t('Switch to it'), type: 'check', value: true },
        ...rs.map((r, i) => ({ key: `r${i}`, label: t('{name}  (on {branch})', { name: r.name, branch: r.branch || t('detached') }), type: 'check', value: shown.has(r.path) }))
      ],
      ok: t('Create'),
      stack: true
    })
    const name = res?.name?.trim()
    if (!name) return
    const pick = rs.filter((r, i) => res[`r${i}`])
    if (!pick.length) return toast(t('No repo picked'))
    const errs = await runEach(pick, (r) => act(r, 'branchCreate', { name, checkout: !!res.checkout }, true))
    errs.length ? toast(`${t('Created {branch} in {n} of {total}', { branch: name, n: pick.length - errs.length, total: pick.length })}\n${errs.join('\n')}`, 'error') : toast(t('Created {branch} in {repos}', { branch: name, repos: plural(pick.length) }))
  }
  async function pushAll() {
    const ahead = targets().filter((r) => r.ahead > 0)
    if (!ahead.length) return toast(t('Nothing to push: no repository has commits waiting'))
    const why = (r) => (r.behind ? (r.behind > 1 ? t('gone its own way: {n} commits to pull first', { n: r.behind }) : t('gone its own way: {n} commit to pull first', { n: r.behind })) : r.state || r.conflicts ? t('a merge or rebase is in progress') : !r.branch ? t('not on a branch') : '')
    const safe = ahead.filter((r) => !why(r))
    const skip = ahead.filter((r) => why(r))
    const msg = [
      safe.length ? `${t('Push:')}\n${safe.map((r) => `  • ${r.name} (${r.branch}) ↑${r.ahead}`).join('\n')}` : t('No repository can be pushed safely.'),
      skip.length ? `\n${t('Skipped (open them to sort it out):')}\n${skip.map((r) => `  • ${r.name}: ${why(r)}`).join('\n')}` : ''
    ].join('\n')
    if (!safe.length) return confirmBox(t('Push all'), msg, t('OK'))
    if (!(await confirmBox(t('Push {repos}?', { repos: plural(safe.length) }), msg, t('Push')))) return
    const errs = await runMany(safe, 'push')
    errs.length ? toast(`${t('Pushed {n} of {total}', { n: safe.length - errs.length, total: safe.length })}\n${errs.join('\n')}`, 'error') : toast(t('Pushed {repos}', { repos: plural(safe.length) }))
  }
  async function runEach(rs, fn) {
    let i = 0
    const errs = []
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        while (i < rs.length) {
          const r = rs[i++]
          const e = await fn(r)
          if (e) errs.push(`${r.name}: ${e}`)
        }
      })
    )
    return errs
  }
  async function act(r, op, args = {}, quiet = false) {
    busy.set(r.path, { fetch: t('Fetching…'), pull: t('Pulling…'), push: t('Pushing…'), checkout: t('Switching…'), branchCreate: t('Creating…') }[op])
    paintRow(r)
    let err = null
    try {
      // one slow or unreachable remote must not hold the others: fetch gives up after 45 s
      await request('git', { op, repo: r.path, args: op === 'pull' ? { ffOnly: true, ...args } : op === 'fetch' ? { timeout: 45, ...args } : args }, 180000)
    } catch (e) {
      err = e.message
    }
    busy.delete(r.path)
    if (err) rovState.errors.set(r.path, { op, message: String(err).split('\n')[0] })
    else rovState.errors.delete(r.path)
    await refreshOne(r)
    if (!root.isConnected) return err
    paintRow(r)
    drawSummary()
    drawSelBar()
    if (!quiet) err ? toast(`${r.name}: ${err}`, 'error') : toast(`${r.name}: ${{ fetch: t('fetched'), pull: t('pulled'), push: t('pushed'), branchCreate: t('created {branch}', { branch: args.name }), checkout: t('now on {branch}', { branch: r.branch }) }[op]}`)
    return err
  }
  async function runMany(rs, op) {
    let i = 0
    const errs = []
    await Promise.all(
      [0, 1, 2, 3].map(async () => {
        while (i < rs.length) {
          const r = rs[i++]
          const e = await act(r, op, {}, true)
          if (e) errs.push(`${r.name}: ${e}`)
        }
      })
    )
    return errs
  }
  const plural = (n) => (n === 1 ? t('{n} repository', { n }) : t('{n} repositories', { n }))
  async function fetchAll() {
    const rs = targets().filter((r) => !busy.has(r.path))
    const errs = await runMany(rs, 'fetch')
    errs.length ? toast(`${t('Fetched {n} of {total}', { n: rs.length - errs.length, total: rs.length })}\n${errs.join('\n')}`, 'error') : toast(t('Fetched {repos}', { repos: plural(rs.length) }))
  }
  async function pullAll() {
    const behind = targets().filter((r) => r.behind > 0)
    if (!behind.length) return toast(t('Nothing to pull: no repository is behind (Fetch all first to check)'))
    const why = (r) =>
      r.conflicts || r.state ? t('a merge or rebase is in progress') : r.changes ? (r.changes > 1 ? t('{n} uncommitted changes', { n: r.changes }) : t('{n} uncommitted change', { n: r.changes })) : r.ahead ? (r.ahead > 1 ? t('gone its own way: {n} local commits not pushed', { n: r.ahead }) : t('gone its own way: {n} local commit not pushed', { n: r.ahead })) : !r.branch ? t('not on a branch') : ''
    const safe = behind.filter((r) => !why(r))
    const skip = behind.filter((r) => why(r))
    const msg = [
      safe.length ? `${t('Pull, fast-forward only:')}\n${safe.map((r) => `  • ${r.name} (${r.branch}) ↓${r.behind}`).join('\n')}` : t('No repository can be pulled safely.'),
      skip.length ? `\n${t('Skipped (open them to pull by hand):')}\n${skip.map((r) => `  • ${r.name}: ${why(r)}`).join('\n')}` : ''
    ].join('\n')
    if (!safe.length) return confirmBox(t('Pull all'), msg, t('OK'))
    if (!(await confirmBox(t('Pull {repos}?', { repos: plural(safe.length) }), msg, t('Pull')))) return
    const errs = await runMany(safe, 'pull')
    errs.length ? toast(`${t('Pulled {n} of {total}', { n: safe.length - errs.length, total: safe.length })}\n${errs.join('\n')}`, 'error') : toast(t('Pulled {repos}', { repos: plural(safe.length) }))
  }
  async function switchMenu(anchor, r) {
    let refs
    try {
      refs = await request('git', { op: 'refs', repo: r.path, args: {} })
    } catch (e) {
      return toast(e.message, 'error')
    }
    const locals = refs.local.filter((b) => !b.current).slice(0, 30)
    menu(
      anchor,
      [
        { header: t('Switch {name} to', { name: r.name }) },
        ...locals.map((b) => ({ label: b.name, icon: 'branch', hint: b.behind ? `↓${b.behind}` : '', onClick: () => doSwitch(r, b.name) })),
        !locals.length && { label: t('No other local branch'), disabled: true },
        '-',
        { label: t('Open in Git Control (remote branches, new branch)'), icon: 'open', onClick: () => openRepo(r) }
      ].filter(Boolean)
    )
  }
  async function doSwitch(r, name) {
    if (r.changes && !(await confirmBox(t('Switch {name} to {branch}?', { name: r.name, branch: name }), r.changes > 1 ? t('{name} has {n} uncommitted changes. Git keeps them when they do not clash with {branch}; otherwise it stops and changes nothing.', { name: r.name, n: r.changes, branch: name }) : t('{name} has {n} uncommitted change. Git keeps them when they do not clash with {branch}; otherwise it stops and changes nothing.', { name: r.name, n: r.changes, branch: name }), t('Switch')))) return
    act(r, 'checkout', { ref: name })
  }
  /** Open that repo in Git Control, on a tab (its merge requests, pipelines…) when asked. */
  function openRepo(r, tab) {
    if (tab === 'reviews') store.set('reviewsAllRepos', false) // only this repo's merge requests
    pinRepo(r.toplevel || r.path)
    setTab(tab || 'history')
  }
  async function scanFolders() {
    const res = await dialog({
      title: t('Scan folders for repos'),
      message: t('Repos overview also lists the Git repositories inside these folders (up to two levels deep), for repos not opened in Orca. Separate folders with ;'),
      fields: [{ key: 'folders', label: t('Folders'), value: (data?.roots || []).join('; '), placeholder: 'C:\\work\\project' }],
      ok: t('Save'),
      stack: true
    })
    if (!res) return
    try {
      await request('repos.setScan', { folders: res.folders || '' })
    } catch (e) {
      return toast(e.message, 'error')
    }
    load()
  }
  root.addEventListener('rov-summary', () => data && drawSummary())
  if (data) draw()
  if (!data || Date.now() - rovState.at > 30000) load() // stale: read again behind what is shown
  return root
}

/* ---------- servers: SSH hosts whose projects the repository menu lists ---------- */
let serverPoll = null
/** Ask the worker which projects the servers have; while a server is still being searched, ask again. */
async function loadServerRepos({ refresh = false } = {}) {
  clearTimeout(serverPoll)
  try {
    const r = await request('servers.repos', { refresh }, refresh ? 60_000 : 30_000)
    state.servers = r.servers || []
    state.serverRepos = r.repos || []
    state.serversAt = Date.now()
  } catch (e) {
    state.serversAt = Date.now()
    if (refresh) toast(e.message, 'error')
  }
  if (state.servers.some((x) => x.scanning)) serverPoll = setTimeout(() => loadServerRepos().then(() => document.querySelector('.servers-sheet') && renderServers()), 3000)
  return state.servers
}
function serversHint() {
  const shown = state.servers.filter((x) => !x.hidden)
  const bad = shown.filter((x) => x.error).length
  return bad ? t('{n} unreachable', { n: bad }) : shown.length ? `${shown.length}` : ''
}
function openServers() {
  openSheet(t('Servers'), h('div', { class: 'servers-sheet' }), [
    h('button', { class: 'btn sm', title: t('Look for projects on every server again'), onClick: async () => (await loadServerRepos({ refresh: true }), renderServers()) }, icon('refresh', 13), h('span', null, t('Rescan'))),
    h('button', { class: 'btn sm primary', onClick: addServer }, icon('plus', 13), h('span', null, t('Add server')))
  ])
  renderServers()
  loadServerRepos().then(renderServers)
}
function renderServers() {
  const root = document.querySelector('.servers-sheet')
  if (!root) return
  const intro = h('p', { class: 'servers-intro' }, t('Projects on these servers show up in the repository menu.'))
  if (!state.servers.length)
    return clear(root).append(intro, h('div', { class: 'empty' }, icon('server', 28), h('div', null, t('No servers yet')), h('div', { class: 'empty-actions' }, h('button', { class: 'btn primary', onClick: addServer }, icon('plus', 13), h('span', null, t('Add server'))))))
  const row = (x) => {
    const status = x.scanning
      ? h('span', { class: 'pill' }, t('Searching…'))
      : x.error
        ? h('span', { class: 'pill server-bad' }, t('Can’t connect'))
        : x.hidden
          ? h('span', { class: 'pill' }, t('Hidden'))
          : x.repoCount != null
            ? h('span', { class: 'pill on' }, x.repoCount === 1 ? t('{n} project', { n: x.repoCount }) : t('{n} projects', { n: x.repoCount }))
            : h('span', { class: 'pill' }, t('Not searched'))
    const rescan = async () => {
      await request('servers.update', { id: x.id, roots: x.roots })
      await loadServerRepos({ refresh: true })
      renderServers()
    }
    const more = (anchor) =>
      menu(anchor, [
        { label: t('Search again'), icon: 'refresh', onClick: rescan },
        { label: t('Folders to search…'), icon: 'folder', hint: x.roots.join('; '), onClick: () => editServerRoots(x) },
        {
          label: x.hidden ? t('Show in the menu') : t('Hide from the menu'),
          icon: x.hidden ? 'eye' : 'eyeOff',
          onClick: async () => {
            state.servers = await request('servers.update', { id: x.id, hidden: !x.hidden })
            await loadServerRepos()
            renderServers()
          }
        },
        x.source === 'manual' ? '-' : null,
        x.source === 'manual'
          ? {
              label: t('Remove'),
              icon: 'trash',
              danger: true,
              onClick: async () => {
                if (!(await confirmBox(t('Remove {name}?', { name: x.label }), t('Its projects leave the repository menu. Nothing on the server changes.'), t('Remove'), true))) return
                state.servers = await request('servers.remove', { id: x.id })
                await loadServerRepos()
                renderServers()
              }
            }
          : null
      ])
    const fix =
      x.error &&
      !x.scanning &&
      h('div', { class: 'server-error' }, h('div', { class: 'server-error-text' }, x.error), h('div', { class: 'row server-error-actions' }, h('button', { class: 'btn sm', onClick: rescan }, icon('refresh', 13), h('span', null, t('Try again')))))
    return h(
      'div',
      { class: `server-row${x.hidden ? ' hidden-server' : ''}`, title: x.orcaName ? t('{name} (in Orca: {orca})', { name: x.label, orca: x.orcaName }) : x.label },
      h('div', { class: 'row' }, icon('server', 16), h('div', { class: 'grow server-name' }, x.label), status, iconBtn('more', t('More for {name}', { name: x.label }), (e) => more(e.currentTarget), { class: 'icon-btn server-more' })),
      fix
    )
  }
  clear(root).append(intro, ...state.servers.map(row))
}
async function addServer() {
  const aliases = await request('servers.sshAliases', {}).catch(() => [])
  const r = await dialog({
    title: t('Add a server'),
    message: t('Its Git projects will show up in the repository menu.'),
    stack: true,
    fields: [{ key: 'dest', label: t('Server'), placeholder: 'my-server', suggestions: aliases.map((a) => ({ value: a.name, detail: a.detail, disabled: a.added, badge: a.added ? t('Added') : '' })) }],
    ok: t('Add')
  })
  if (!r?.dest?.trim()) return
  toast(t('Connecting to {server}…', { server: r.dest.trim() }))
  try {
    const res = await request('servers.add', { dest: r.dest.trim() }, 90_000)
    toast(res.error ? t('Added {server}, but searching it failed: {error}', { server: res.id, error: res.error }) : res.repoCount === 1 ? t('{n} project found on {server}', { n: res.repoCount, server: res.id }) : t('{n} projects found on {server}', { n: res.repoCount, server: res.id }), res.error ? 'error' : 'ok')
  } catch (e) {
    await dialog({ title: t('Could not add the server'), message: e.message, cancel: null, stack: true })
    return
  }
  await loadServerRepos()
  renderServers()
}
async function editServerRoots(x) {
  const r = await dialog({
    title: t('Folders to search on {server}', { server: x.label }),
    stack: true,
    fields: [{ key: 'roots', label: t('Folders'), value: x.roots.join('; '), hint: t('Separate folders with ; (~ is your home folder there). Searched 4 levels deep.') }],
    ok: t('Search')
  })
  if (!r) return
  try {
    state.servers = await request('servers.update', { id: x.id, roots: r.roots })
  } catch (e) {
    return toast(e.message, 'error')
  }
  renderServers()
  await loadServerRepos({ refresh: true })
  renderServers()
}

/** The server a repository is on, as a badge beside its name in the header: it never truncates (the name does). */
function renderHostBadge() {
  const el = $('#repoHost')
  if (!el) return
  const where = hostOf(state.repo)
  el.hidden = !where
  if (!where) return clear(el)
  clear(el).append(icon('server', 12), h('span', null, where))
  el.title = t('On {server}: git runs on that server', { server: where })
}

function pinRepo(p) {
  // one of the open folder's repositories: stay in the folder (its tabs stay), just switch
  if (state.folder?.children.some((c) => sameRepoPath(c.path, p))) return pickFolderRepo(p)
  state.folder = null
  renderFolderBar()
  state.pinned = p
  if (!IN_TAB) store.set('pinnedRepo', p)
  setRepo(p)
  renderAll()
  refreshAll()
}

/* =========================================================================
   header
   ========================================================================= */
function renderHeader() {
  const st = state.status
  // on a server: its icon, so it is clear that actions run on another machine
  clear($('#repoIcon')).append(icon(hostOf(state.repo) ? 'server' : state.pinned ? 'folder' : 'worktree', 14))
  $('#repoName').textContent = state.repo ? (state.folder ? `${basename(state.folder.path)} › ` : '') + basename(st?.toplevel || state.repo) : t('No repository')
  renderHostBadge()
  $('#repoBtn').title = state.repo || t('Choose a repository')
  clear($('#repoCaret')).append(icon('down', 12))
  const side = $('#sideToggle')
  if (side && !side.querySelector('svg')) clear(side).append(icon('menu', 16))

  const tb = clear($('#toolbar'))
  const dis = !state.repo || !st
  // In the full tab the main actions carry a label, like a toolbar; in the narrow panel icons only.
  const phoneLbl = (b, text) => (b.append(h('span', { class: 'tb-label tb-phone' }, text)), b) // only phones show it
  const lbl = (b, text) => (b.append(h('span', { class: 'tb-label' }, text)), b) // narrow screens hide it, except on a button with work waiting
  // Pull/Push carry how many commits wait (↓ to pull, ↑ to push) and stand out while any do.
  const diverged = st?.ahead > 0 && st?.behind > 0
  const counted = (b, n, title) => {
    if (n > 0) {
      const up = b.title === t('Push')
      b.append(h('span', { class: `tb-count ${up ? 'ab-up' : 'ab-down'}`, title: diverged ? t('{title}. The branch and its remote have gone separate ways: pull before pushing', { title }) : title }, h('span', { class: 'tb-arrow' }, up ? '↑' : '↓'), String(n)))
      b.classList.add('tb-hot')
      if (diverged) b.classList.add('diverged')
    }
    return b
  }
  const st0 = st || {}
  const sep = () => IN_TAB && h('span', { class: 'tb-sep' })
  append(tb, [
    lbl(iconBtn('fetch', t('Fetch all (prune)'), () => run('fetch', {}, { success: t('Fetched') }), { disabled: dis }), t('Fetch')),
    counted(lbl(iconBtn('pull', t('Pull'), (e) => pullMenu(e.currentTarget), { disabled: dis }), t('Pull')), st0.behind, st0.behind > 1 ? t('Pull: {n} commits on {upstream}', { n: st0.behind, upstream: st0.upstream || t('the remote') }) : t('Pull: {n} commit on {upstream}', { n: st0.behind, upstream: st0.upstream || t('the remote') })),
    counted(lbl(iconBtn('push', t('Push'), (e) => pushMenu(e.currentTarget), { disabled: dis }), t('Push')), st0.ahead, st0.ahead > 1 ? t('Push: {n} commits not on {upstream} yet', { n: st0.ahead, upstream: st0.upstream || t('the remote') }) : t('Push: {n} commit not on {upstream} yet', { n: st0.ahead, upstream: st0.upstream || t('the remote') })),
    sep(),
    IN_TAB && lbl(iconBtn('stash', t('Stash changes'), () => run('stashSave', { untracked: true }, { success: t('Stashed') }), { disabled: dis || !st0.files?.length }), t('Stash')),
    sep(),
    phoneLbl(iconBtn('refresh', t('Refresh'), () => manualRefresh(), { disabled: !state.repo }), t('Refresh')),
    phoneLbl(iconBtn('undo', t('Undo the last action (commit, reset, merge, rebase…)'), undoLast, { disabled: dis }), t('Undo')),
    IN_TAB && phoneLbl(iconBtn('search', t('Commands ({key})', { key: MOD + '.' }), () => commandPalette(), { disabled: dis }), t('Actions')),
    phoneLbl(iconBtn('settings', t('Git settings (identity, HTTPS, remotes)'), () => setTab('settings'), { disabled: !state.repo }), t('Settings')),
    !IN_TAB && iconBtn('expand', t('Open Git Control in a full tab'), openTab, { disabled: dis }),
    langPicker()
  ])
  const ops = { [t('Fetch all (prune)')]: 'fetch', [t('Pull')]: 'pull', [t('Push')]: 'push', [t('Stash changes')]: 'stash', [t('Refresh')]: 'refresh', [t('Undo the last action (commit, reset, merge, rebase…)')]: 'undo' }
  for (const b of tb.querySelectorAll('button')) if (ops[b.title]) b.dataset.op = ops[b.title]
  paintWorking()

  const bl = clear($('#branchLine'))
  if (!st) return
  append(bl, [
    h(
      'button',
      { class: 'branch-chip', title: t('Switch branch'), onClick: (e) => quickSwitch(e.currentTarget) },
      icon('branch', 12),
      h('span', { class: 'ellipsis' }, st.branch || t('detached @ {sha}', { sha: (st.oid || '').slice(0, 7) })),
      icon('down', 11)
    ),
    // every repository at once: its own page (the button shows it is open; pressed again, back)
    h('button', { class: `rov-nav-btn ${state.tab === 'repos' ? 'on' : ''}`, title: t('Repo Overview: every repository, its changes, pipelines and merge requests'), onClick: () => (state.tab === 'repos' ? setTab(store.get('lastTabBeforeRepos', 'history')) : reposOverview()) }, icon('grid', 12), h('span', { class: 'rov-nav-t' }, t('Repo Overview'))),
    // ahead/behind live on the Pull and Push buttons; here only what they cannot say
    !st.upstream && st.branch && h('span', { class: 'sync', title: t('This branch has no remote branch yet: Push publishes it') }, t('not published')),
    ciBadge()
  ])
}

async function openTab() {
  setBusy(1)
  try {
    await request('tab.open', { repo: state.repo }, 20000)
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    setBusy(-1)
  }
}

/** Refresh from the button or F5: the icon spins, then a short tick and what changed. */
async function manualRefresh() {
  if (working.has('refresh')) return
  const before = state.status ? state.status.oid + '|' + (state.status.files?.length || 0) + '|' + (state.status.ahead || 0) + '|' + (state.status.behind || 0) : ''
  setWorking('refresh', true)
  let ok = false
  try {
    await refreshAll(true)
    ok = true
  } finally {
    setWorking('refresh', false, ok)
  }
  const after = state.status ? state.status.oid + '|' + (state.status.files?.length || 0) + '|' + (state.status.ahead || 0) + '|' + (state.status.behind || 0) : ''
  if (ok) toast(after === before ? t('Refreshed · no changes') : t('Refreshed · updated'), 'ok', 1800)
}

/** Ask the AI agent (Settings → Plugins → Git Control) to resolve the current conflicts in a terminal. */
async function resolveWithAi() {
  setBusy(1)
  try {
    const r = await request('ai.resolve', { repo: state.repo }, 30000)
    toast(t('{agent} is resolving the conflicts in a new terminal. Review its work, then press Continue.', { agent: r.agent }), 'ok', 7000)
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    setBusy(-1)
  }
}

function pullMenu(anchor) {
  menu(anchor, [
    { label: t('Pull (merge)'), icon: 'pull', onClick: () => run('pull', {}, { success: t('Pulled') }) },
    { label: t('Pull (rebase)'), icon: 'pull', onClick: () => run('pull', { rebase: true }, { success: t('Pulled with rebase') }) },
    { label: t('Pull (fast-forward only)'), icon: 'pull', onClick: () => run('pull', { ffOnly: true }, { success: t('Pulled') }) },
    '-',
    { label: t('Fetch all'), icon: 'fetch', onClick: () => run('fetch', {}, { success: t('Fetched') }) }
  ])
}
function pushMenu(anchor) {
  menu(anchor, [
    { label: t('Push'), icon: 'push', onClick: () => run('push', {}, { success: t('Pushed') }) },
    '-',
    {
      label: t('Force push (with lease)…'),
      icon: 'alert',
      danger: true,
      onClick: async () => {
        if (await confirmBox(t('Force push?'), t('This overwrites the remote branch if nobody else pushed since your last fetch.'), t('Force push'), true))
          run('push', { force: true }, { success: t('Force pushed') })
      }
    }
  ])
}

async function quickSwitch(anchor) {
  let r
  try {
    r = await call('refs')
  } catch (e) {
    return toast(e.message, 'error')
  }
  const local = r.local.filter((b) => !b.current).slice(0, 15)
  menu(anchor, [
    { header: t('Switch to') },
    ...local.map((b) => ({ label: b.name, icon: 'branch', onClick: () => checkout(b.name) })),
    local.length ? '-' : null,
    { label: t('New branch…'), icon: 'plus', onClick: () => newBranch() },
    { label: t('All branches'), icon: 'right', onClick: () => setTab('branches') }
  ])
}

function renderBanner() {
  const b = clear($('#banner'))
  const st = state.status
  if (st?.bisect && !st.state) return b.append(bisectBanner(st))
  if (!st?.state) return
  const conflicts = st.files.filter((f) => f.conflict).length
  const labels = { merge: t('Merge'), rebase: t('Rebase'), 'cherry-pick': t('Cherry-pick'), revert: t('Revert') }
  b.append(
    h(
      'div',
      { class: 'banner' },
      h('div', { class: 'row' }, icon('alert'), h('strong', null, t('{op} in progress', { op: labels[st.state] })), st.sides && h('span', { class: 'cf-route sm' }, sideChip('incoming', st.sides.incoming), icon('right', 12), sideChip('current', st.sides.current))),
      h(
        'div',
        { class: 'dim', style: { fontSize: '11.5px' } },
        conflicts ? (conflicts > 1 ? t('{n} conflicted files. Resolve them, then continue.', { n: conflicts }) : t('{n} conflicted file. Resolve them, then continue.', { n: conflicts })) : t('No conflicts left. Continue to finish.')
      ),
      h(
        'div',
        { class: 'row' },
        conflicts > 0 && h('button', { class: 'btn sm primary', onClick: openConflicts }, icon('edit', 12), t('Resolve conflicts')),
        conflicts > 0 && h('button', { class: 'btn sm', onClick: resolveWithAi }, icon('wand', 12), t('Resolve with AI')),
        h('button', { class: `btn sm ${conflicts ? '' : 'primary'}`, disabled: conflicts > 0, onClick: () => run('continue', {}, { success: st.state === 'merge' ? t('Merge committed') : t('Continued') }) }, st.state === 'merge' ? t('Commit merge') : t('Continue')),
        st.state !== 'merge' && h('button', { class: 'btn sm', onClick: () => run('skip', {}, { success: t('Skipped') }) }, t('Skip')),
        h(
          'button',
          {
            class: 'btn sm danger',
            onClick: async () => (await confirmBox(t('Abort {op}?', { op: st.state }), t('Your branch goes back to how it was before.'), t('Abort'), true)) && run('abort', {}, { success: t('Aborted') })
          },
          t('Abort')
        )
      )
    )
  )
}

/* =========================================================================
   tabs
   ========================================================================= */
const TABS = [
  ['history', IN_TAB ? t('Graph') : t('History'), 'layers'],
  ['changes', IN_TAB ? t('Commit') : t('Changes'), 'commit'],
  ['reviews', 'MR / PR', 'pr'],
  ['pipelines', t('Pipelines'), 'pipeline'],
  ['branches', t('Branches'), 'branch'],
  ['worktrees', t('Worktrees'), 'worktree'],
  ['stash', t('Stash'), 'stash'],
  ['reflog', t('Reflog'), 'history'],
  ['settings', t('Settings'), 'settings']
].filter(([id]) => !(IN_TAB && id === 'branches')) // the tab shows branches in its sidebar
function renderTabs() {
  const nav = clear($('#tabs'))
  const st = state.status
  for (const [id, label, ic] of TABS) {
    const count = id === 'changes' ? st?.files.length : id === 'stash' ? st?.stashCount : id === 'reviews' ? reviewCount() : 0
    nav.append(
      h('button', { class: `tab ${state.tab === id ? 'active' : ''}`, onClick: () => setTab(id) }, icon(ic, 13), label, count ? h('span', { class: `badge tb-${id} ${id === 'reviews' && reviewForMe() ? 'hot' : ''}`, title: id === 'reviews' ? (reviewForMe() ? t('{n} open, {waiting} waiting for you', { n: count, waiting: reviewForMe() }) : t('{n} open', { n: count })) : null }, count) : null)
    )
  }
  // on a narrow screen the tabs scroll: keep the chosen one in view
  const on = nav.querySelector('.tab.active')
  if (on && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = Math.max(0, on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2)
}
function setTab(id) {
  state.tab = id
  document.querySelector('.rov-nav-btn')?.classList.toggle('on', id === 'repos')
  clearSheets()
  if (id !== 'history') state.history.open = null
  store.set('tab', id)
  viewRestore = null
  viewMem.set({ tab: id, scroll: 0, scrollTab: id, open: id === 'history' ? state.history.open : null })
  renderTabs()
  renderView({ force: true })
}

/* =========================================================================
   refresh
   ========================================================================= */
let refreshing = null
let pendingRefresh = null
let pendingFull = false
async function refreshAll(full = false) {
  if (refreshing) {
    // something changed since that refresh started (an operation finished, the repo switched): run once
    // more, as a full refresh if any of the callers queued behind it asked for one
    pendingFull ||= full
    pendingRefresh ||= refreshing.catch(() => {}).then(() => {
      const f = pendingFull
      pendingRefresh = null
      pendingFull = false
      return refreshAll(f)
    })
    return pendingRefresh
  }
  refreshing = (async () => {
    if (full || !state.repo) {
      const before = state.repo
      await resolveRepo()
      if (state.repo !== before && state.status) renderAll() // snapshot of the new repo: show it now
    }
    const repo = state.repo
    if (repo) {
      try {
        const [st, refs] = await Promise.all([call('status', full ? { fresh: true } : {}), call('refs').catch(() => state.refs)])
        if (repo !== state.repo) return // switched meanwhile: the queued refresh handles the new repo
        // any branch, tag or remote moving (our own push, fetch, commit…) redraws the graph's labels
        if (state.status && (st.oid !== state.status.oid || st.refsSig !== state.status.refsSig)) state.history.stale = true
        state.status = st
        state.refs = refs
        state.loadingRepo = false
        prefetchReviews()
      } catch (e) {
        if (repo !== state.repo) return
        state.status = null
        state.statusError = e.message
        state.loadingRepo = false
      }
    } else state.status = null
    if (full) state.history.stale = true // reload quietly instead of emptying the list
    if (full) state.ci = null // an explicit Refresh asks CI again too
    await renderAll()
    snap.save()
    loadCi()
  })()
  try {
    await refreshing
  } finally {
    refreshing = null
  }
}

async function renderAll() {
  renderHeader()
  renderBanner()
  renderTabs()
  if (IN_TAB) renderSide()
  await renderView()
}

/** Light status poll: only re-render when something changed. */
/** Is this tab on screen? Orca hides other projects' tabs, sometimes only by shrinking them to nothing. */
const isShown = () => document.visibilityState === 'visible' && window.innerWidth > 0 && window.innerHeight > 0
async function pollStatus(force) {
  if (!force && (!isShown() || !state.repo || state.busy || refreshing || document.querySelector('.overlay'))) return
  const repo = state.repo
  try {
    const st = await call('status')
    if (repo !== state.repo) return
    if (JSON.stringify(st) !== JSON.stringify(state.status)) {
      // HEAD moving, or any branch/tag/remote moving (an agent committing, a fetch), redraws the graph
      const headMoved = st.oid !== state.status?.oid || st.refsSig !== state.status?.refsSig
      let refs = state.refs
      if (headMoved) refs = await call('refs').catch(() => state.refs)
      if (repo !== state.repo) return // switched while the refs loaded
      state.status = st
      if (headMoved) {
        state.history.stale = true
        state.refs = refs
      }
      if (IN_TAB && headMoved) renderSide()
      renderHeader()
      renderBanner()
      renderTabs()
      if ((!state.sheets.length || force) && (state.tab === 'changes' || headMoved)) renderView()
    }
  } catch {}
}

/* =========================================================================
   view host + sheets
   ========================================================================= */
let lastTabRendered = null
let renderSeq = 0
// A form the person is typing into (Settings and the like) must not be redrawn under them by a
// background refresh. Typing marks it; switching tabs or saving (which re-renders by tab) clears it.
document.addEventListener('input', (e) => {
  if (e.target.closest?.('#main .form')) e.target.closest('.view')?.setAttribute('data-editing', '1')
})
/**
 * A place in a view being built for an element that is on the page now (a search box being typed in):
 * the element stays where it is until the new view goes in, then moves in the same moment, so no key is lost.
 */
const liveSlot = (el) => Object.assign(h('span', { class: 'live-slot' }), { _live: el })
const SNAP_TABS = new Set(['worktrees', 'stash', 'reflog', 'branches'])
let staleTimer = null
const tabSnaps = new Map() // repo|tab → that tab's last view (shown at once when switching back)
async function renderView({ force = false } = {}) {
  const main = $('#main')
  if (!force && lastTabRendered === state.tab && main.querySelector('.view[data-editing]')) return
  const keepScroll = main.scrollTop
  // the field being typed in, taken before the new view is built: building it moves a reused search box
  // out of the page, which drops its focus; it gets focus and caret back once the view is in
  const typing = document.activeElement?.matches?.('input, textarea') ? document.activeElement : null
  const loading = main.querySelector('.loading')
  if (!state.repo) {
    clear(main).append(emptyRepo())
    return
  }
  if (state.loadingRepo) return showLoadingSkeleton()
  document.body.classList.remove('is-loading-repo')
  if (!state.status) {
    clear(main).append(
      h('div', { class: 'empty' }, icon('alert', 28), h('div', null, /not a git repository/i.test(state.statusError || '') || !state.statusError ? t('Not a Git repository') : t('Could not read this repository')), h('div', { class: 'dim mono', style: { marginTop: '6px' } }, state.statusError || state.repo))
    )
    return
  }
  const views = { changes: viewChanges, history: viewHistory, branches: viewBranches, worktrees: viewWorktrees, stash: viewStash, reflog: viewReflog, reviews: viewReviews, pipelines: viewPipelinesTab, repos: viewRepos, settings: viewSettings }
  if (!views[state.tab]) state.tab = 'history'
  // Nothing on screen yet (first open, no snapshot): show placeholder rows instead of a blank area.
  if (!main.querySelector('.view')) {
    clear(main).append(h('div', { class: 'view skeleton-list' }, Array.from({ length: 14 }, (_, i) => h('div', { class: 'skeleton-row', style: { animationDelay: `${i * 40}ms` } }, h('span', { class: 'dot' }), h('span', { class: 'bar', style: { width: `${35 + ((i * 37) % 45)}%` } })))))
    if (loading) main.prepend(loading)
  }
  // Switching tabs: show that tab as it was last time at once (it is replaced as soon as the fresh one
  // is built), or placeholder rows if it takes a moment, so a click never waits on git or the network.
  const snapKey = `${state.repo}|${state.tab}`
  // only plain lists: tabs with forms, menus or their own caches (Graph, Commit, Review, Pipelines,
  // Settings) are fast already and must never show an old copy
  const snapshots = SNAP_TABS.has(state.tab)
  const switching = lastTabRendered !== state.tab
  let placeholder = null
  if (switching && snapshots) {
    const snap = tabSnaps.get(snapKey)
    if (snap) {
      snap.classList.remove('view-enter')
      // looked at, not used, until the fresh one lands: a click or edit here would act on old data
      main.classList.add('stale')
      clearTimeout(staleTimer)
      staleTimer = setTimeout(() => main.classList.remove('stale'), 3000) // never stuck
      clear(main).append(snap)
      lastTabRendered = state.tab
    } else
      placeholder = setTimeout(() => {
        if (state.tab !== snapKey.split('|').pop()) return
        clear(main).append(h('div', { class: 'view skeleton-list' }, Array.from({ length: 10 }, (_, i) => h('div', { class: 'skeleton-row', style: { animationDelay: `${i * 40}ms` } }, h('span', { class: 'dot' }), h('span', { class: 'bar', style: { width: `${35 + ((i * 37) % 45)}%` } })))))
      }, 80)
  }
  // Views load asynchronously; when renders overlap, only the newest may land. An older one
  // (built for another tab, scope or repository) would otherwise replace it.
  const seq = ++renderSeq
  let el
  try {
    el = await views[state.tab]()
  } catch (e) {
    el = h('div', { class: 'view' }, state.tab === 'history' && searchBox && h('div', { class: 'history-bar' }, h('div', { class: 'graph-search-wrap' }, searchBox, iconBtn('x', t('Clear search'), () => ((searchBox.value = ''), (state.history.search = ''), resetHistory(), renderView()), { class: 'icon-btn search-clear' }))), h('div', { class: 'empty' }, icon('alert', 28), h('div', null, e.message)))
  }
  clearTimeout(placeholder)
  if (seq !== renderSeq) return
  if (lastTabRendered !== state.tab) el.classList.add('view-enter')
  main.classList.remove('stale')
  if (snapshots) {
    tabSnaps.delete(snapKey)
    tabSnaps.set(snapKey, el)
    if (tabSnaps.size > 12) tabSnaps.delete(tabSnaps.keys().next().value)
  }
  lastTabRendered = state.tab
  // a field being typed in (the graph's search box is reused across redraws) keeps focus and caret
  // the caret as it is now (typing may have gone on while the view was built)
  const caret = typing?.isConnected ? [typing.selectionStart, typing.selectionEnd] : null
  clear(main).append(el)
  el.querySelectorAll('.live-slot').forEach((s) => s.replaceWith(s._live))
  if (typing && typing.isConnected && document.activeElement !== typing) {
    typing.focus({ preventScroll: true })
    try {
      if (caret) typing.setSelectionRange(caret[0], caret[1])
    } catch {}
  }
  if (loading) main.prepend(loading)
  if (state.sheets.length) placeSheet(state.sheets[state.sheets.length - 1].el)
  main.scrollTop = keepScroll
  applyViewRestore()
}
/** Once the remembered tab has its content: scroll back and reopen the commit that was open. */
function applyViewRestore() {
  const m = viewRestore
  if (!m) return
  const main = $('#main')
  if (state.tab === 'history' && !state.history.commits.length) return // wait for the list
  viewRestore = null
  if (m.scroll && (m.scrollTab || m.tab) === state.tab) main.scrollTop = m.scroll
  if (state.tab === 'history' && m.open && dockMode() && !state.sheets.length) {
    const c = state.history.commits.find((x) => x.hash === m.open)
    if (c) openDock(c)
  }
}

/** Placeholder rows over the whole page (list, header, sidebar) while another project loads. */
function showLoadingSkeleton() {
  const main = $('#main')
  if (!main) return
  const rows = (n, w0 = 35) => Array.from({ length: n }, (_, i) => h('div', { class: 'skeleton-row', style: { animationDelay: `${i * 40}ms` } }, h('span', { class: 'dot' }), h('span', { class: 'bar', style: { width: `${w0 + ((i * 37) % 45)}%` } })))
  clear(main).append(h('div', { class: 'view skeleton-list repo-loading' }, h('div', { class: 'skeleton-bar-row' }, h('span', { class: 'bar wide' }), h('span', { class: 'bar short' })), rows(16)))
  const side = document.getElementById('side')
  if (side) clear(side).append(h('div', { class: 'skeleton-list side-skel' }, rows(6, 40)))
  const bl = document.getElementById('branchLine')
  if (bl) clear(bl).append(h('span', { class: 'skeleton-chip' }))
  document.body.classList.add('is-loading-repo')
}

function emptyRepo() {
  return h(
    'div',
    { class: 'empty' },
    icon('worktree', 32),
    h('div', null, t('No repository for this workspace')),
    h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onClick: (e) => repoMenu(e.currentTarget) }, icon('repo', 12), t('Choose repository')))
  )
}

function openSheet(title, body, actions = []) {
  const under = state.sheets[state.sheets.length - 1]
  // stacked on another sheet: Back returns to it (Esc too); Close shuts them all
  const back = under && h('button', { class: 'sheet-back', title: t('Back (Esc)'), 'aria-label': t('Back'), onClick: closeSheet }, icon('left', 14), h('span', { class: 'sheet-back-t' }, under.dock ? t('Details') : t('Back')))
  const closeAll = () => {
    while (state.sheets.length) closeSheet()
  }
  const el = h(
    'div',
    { class: 'sheet' },
    h('div', { class: 'sheet-head' }, back, h('div', { class: 'sheet-title', title }, title), ...actions, actions.length > 0 && h('span', { class: 'sheet-sep' }), iconBtn('x', under ? t('Close all') : t('Close (Esc)'), under ? closeAll : closeSheet, { class: 'icon-btn sheet-close' })),
    h('div', { class: 'sheet-body' }, body)
  )
  document.querySelectorAll('.sheet').forEach((x) => x.remove())
  state.sheets.push({ el })
  placeSheet(el)
}
function closeSheet() {
  const gone = state.sheets.pop()
  gone?.el.remove()
  if (gone?.dock) {
    state.history.open = null
    viewMem.set({ open: null })
    document.querySelectorAll('#main .commit-row.selected').forEach((r) => r.classList.remove('selected'))
  }
  const prev = state.sheets[state.sheets.length - 1]
  if (prev) placeSheet(prev.el)
  syncDock()
}
// A press outside the open sheet closes it (the merge request page, pipelines, diffs), like a modal.
// The docked commit details stay: the graph beside them is meant to be clicked while they are open.
// The header, menus, dialogs and toasts never count as outside.
document.addEventListener(
  'mousedown',
  (e) => {
    const top = state.sheets[state.sheets.length - 1]
    if (!top || top.dock || e.button !== 0) return
    if (e.target.closest?.('.sheet, .overlay, .menu, .tip, #toasts, header, .side-backdrop')) return
    if (!e.target.isConnected) return
    closeSheet()
  },
  true
)
/** Drop every sheet (tab or repository switch). */
function clearSheets() {
  state.sheets = []
  document.querySelectorAll('.sheet-host > .sheet').forEach((x) => x.remove())
  syncDock()
}

/* ---------- split view: on a wide graph the commit details dock to the right ---------- */
const dockMode = () => IN_TAB && state.tab === 'history' && window.innerWidth >= 1000
/** While the details are docked the graph makes room for them instead of sliding under. */
function syncDock() {
  const host = $('#main')?.parentElement
  if (!host) return
  const d = state.sheets.find((s) => s.dock)
  host.classList.toggle('docked', !!d)
  if (d) host.style.setProperty('--dock-w', `${(d.el.isConnected ? d.el.getBoundingClientRect().width : 0) || store.get('sheetWidth', 0) || Math.min(560, host.clientWidth * 0.45)}px`)
}
/** Show a commit in the docked pane (opening it if needed); the list keeps its place. */
async function openDock(c) {
  const H = state.history
  H.open = c.hash
  viewMem.set({ open: c.hash })
  document.querySelectorAll('#main .commit-row.selected').forEach((r) => r.classList.remove('selected'))
  document.querySelector(`#main .commit-row[data-hash="${c.hash}"]`)?.classList.add('selected')
  document.querySelector('#main .commit-inline')?.remove()
  let top = state.sheets[state.sheets.length - 1]
  if (!top?.dock) {
    clearSheets()
    openSheet('', null)
    top = state.sheets[state.sheets.length - 1]
    top.dock = true
    top.el.classList.add('dock')
  }
  const title = top.el.querySelector('.sheet-title')
  title.textContent = `${c.hash.slice(0, 7)} · ${c.subject || ''}`
  title.title = c.subject || ''
  const body = clear(top.el.querySelector('.sheet-body'))
  body.append(h('div', { class: 'inline-skeleton', style: { margin: '12px' } }, h('span'), h('span'), h('span')))
  syncDock()
  try {
    const full = await commitDetails(c.hash)
    if (H.open !== c.hash || !top.el.isConnected) return
    clear(body).append(commitBody(full))
  } catch (e) {
    if (H.open === c.hash && top.el.isConnected) clear(body).append(h('div', { class: 'dim', style: { padding: '12px' } }, e.message))
  }
}
/**
 * A sheet sits beside the scrolling area, not inside it, so it stays whole while the graph scrolls
 * behind it. It starts right under the tabs; its left edge drags to resize (remembered).
 */
function placeSheet(el) {
  const main = $('#main')
  const host = main.parentElement
  host.classList.add('sheet-host')
  el.style.top = `${main.offsetTop}px`
  // wide pages (merge request, pipelines, review diff) remember their own width, apart from the side sheets
  const wkey = el.classList.contains('wide-sheet') ? 'wideSheetWidth' : 'sheetWidth'
  const w = store.get(wkey, 0)
  el.style.width = w ? `${Math.min(w, host.clientWidth - 120)}px` : ''
  if (!el.querySelector('.sheet-grip')) {
    const grip = h('div', { class: 'sheet-grip', title: t('Drag to resize') })
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.setPointerCapture(e.pointerId)
      const right = host.getBoundingClientRect().right
      const move = (ev) => ((el.style.width = `${Math.max(320, Math.min(right - ev.clientX, host.clientWidth - 120))}px`), syncDock())
      const up = () => {
        grip.removeEventListener('pointermove', move)
        store.set(el.classList.contains('wide-sheet') ? 'wideSheetWidth' : 'sheetWidth', el.getBoundingClientRect().width)
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up, { once: true })
    })
    el.prepend(grip)
  }
  if (el.parentElement !== host) host.append(el)
  syncDock()
}

/* =========================================================================
   diff rendering
   ========================================================================= */
/** Split a unified diff into hunks, each a standalone patch (file header + one hunk). */
function splitHunks(text) {
  const hunks = []
  let header = []
  let cur = null
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      header = [line]
      cur = null
    } else if (line.startsWith('@@')) {
      cur = { lines: [line], header: header.slice() }
      hunks.push(cur)
    } else if (cur) {
      if (line !== '') cur.lines.push(line)
    } else header.push(line)
  }
  return hunks.map((x) => [...x.header, ...x.lines].join('\n') + '\n')
}

/** Parse a unified diff into files → hunks → lines. */
function parseDiff(text) {
  const files = []
  let file = null
  let hunk = null
  let o = 0
  let n = 0
  let patch = -1
  const newFile = () => {
    file = { path: '', oldPath: '', badges: [], hunks: [], add: 0, del: 0, binary: false }
    files.push(file)
    hunk = null
  }
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      newFile()
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/)
      if (m) [file.oldPath, file.path] = [m[1], m[2]]
    } else if (!file && (line.startsWith('--- ') || line.startsWith('@@'))) newFile()
    if (!file) continue
    if (line.startsWith('diff --git') || line.startsWith('index ')) continue
    if (line.startsWith('--- ')) {
      const p = line.slice(4).replace(/^a\//, '')
      if (p !== '/dev/null' && p !== 'NUL') file.oldPath = p
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '')
      if (p !== '/dev/null' && p !== 'NUL') file.path = p
      else file.path = file.oldPath
    } else if (line.startsWith('new file')) file.badges.push('new')
    else if (line.startsWith('deleted file')) file.badges.push('deleted')
    else if (line.startsWith('rename from') || line.startsWith('similarity')) !file.badges.includes('renamed') && file.badges.push('renamed')
    else if (line.startsWith('Binary files')) file.binary = true
    else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/)
      if (m) [o, n] = [+m[1], +m[3]]
      hunk = { oldStart: o, newStart: n, newCount: m ? +(m[4] ?? 1) : 0, oldCount: m ? +(m[2] ?? 1) : 0, context: m ? m[5] : line, lines: [], patch: ++patch }
      file.hunks.push(hunk)
    } else if (hunk && line.startsWith('+')) {
      hunk.lines.push({ k: 'add', n: n++, t: line.slice(1) })
      file.add++
    } else if (hunk && line.startsWith('-')) {
      hunk.lines.push({ k: 'del', o: o++, t: line.slice(1) })
      file.del++
    } else if (hunk && line.startsWith(' ')) hunk.lines.push({ k: 'ctx', o: o++, n: n++, t: line.slice(1) })
    else if (hunk && line.startsWith('\\')) hunk.lines.at(-1) && (hunk.lines.at(-1).noEol = true)
  }
  return files.filter((f) => f.hunks.length || f.binary || f.badges.length)
}

/** Text with the changed middle part marked, against its paired line (common prefix/suffix kept plain). */
function markChange(text, other) {
  if (other == null || text === other) return [text]
  let p = 0
  while (p < text.length && p < other.length && text[p] === other[p]) p++
  let q = 0
  while (q < text.length - p && q < other.length - p && text[text.length - 1 - q] === other[other.length - 1 - q]) q++
  const mid = text.slice(p, text.length - q)
  // a near-total rewrite reads better without marks
  if (!mid || mid.length > text.length * 0.85) return [text]
  return [text.slice(0, p), h('mark', null, mid), text.slice(text.length - q)]
}

/** Pair runs of removed and added lines, so each changed line can be shown against its counterpart. */
function pairLines(lines) {
  const out = []
  for (let i = 0; i < lines.length; ) {
    if (lines[i].k !== 'del') {
      out.push({ left: lines[i].k === 'ctx' ? lines[i] : null, right: lines[i] })
      i++
      continue
    }
    const dels = []
    while (i < lines.length && lines[i].k === 'del') dels.push(lines[i++])
    const adds = []
    while (i < lines.length && lines[i].k === 'add') adds.push(lines[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ left: dels[k] || null, right: adds[k] || null, changed: true })
  }
  return out
}

/**
 * A readable diff: per file a header (+added −removed), hunks labelled by their lines, unified or
 * side by side (remembered), changed words marked, optional wrapping.
 * hunkActions: [{ label, icon, run(patch) }] on every hunk; onLine({ path, side, line, text }) makes lines clickable.
 */
function renderDiff(text, hunkActions, { onLine, images } = {}) {
  if (!text.trim()) return h('div', { class: 'empty' }, t('No changes to show (binary or identical file)'))
  const files = parseDiff(text)
  const patches = hunkActions?.length ? splitHunks(text) : []
  const root = h('div', { class: 'dv' })
  const body = h('div')
  let mode = store.get('diffMode', 'unified')
  let wrapOn = store.get('diffWrap', false)
  const seg = h('div', { class: 'segmented' })
  const wrapBtn = h('button', { class: 'btn sm dv-wrap', title: t('Wrap long lines') }, icon('layers', 12), t('Wrap'))
  const drawBar = () => {
    clear(seg).append(
      h('button', { class: mode === 'unified' ? 'on' : '', onClick: () => ((mode = 'unified'), store.set('diffMode', mode), draw()) }, t('Unified')),
      h('button', { class: mode === 'split' ? 'on' : '', onClick: () => ((mode = 'split'), store.set('diffMode', mode), draw()) }, t('Split'))
    )
    wrapBtn.classList.toggle('on', wrapOn)
  }
  wrapBtn.addEventListener('click', () => ((wrapOn = !wrapOn), store.set('diffWrap', wrapOn), draw()))
  const total = files.reduce((t, f) => [t[0] + f.add, t[1] + f.del], [0, 0])
  root.append(
    h(
      'div',
      { class: 'dv-bar' },
      seg,
      wrapBtn,
      h('span', { class: 'grow' }),
      files.length > 1 && h('span', { class: 'dim' }, t('{n} files', { n: files.length })),
      files.length === 1 && !files[0].badges.includes('deleted') && h('button', { class: 'btn sm', title: t('Open {file} in the editor', { file: files[0].path }), onClick: () => openRepoFile(files[0].path) }, icon('file', 12), t('Open file')),
      h('span', { class: 'dv-count' }, h('span', { class: 'a' }, `+${total[0]}`), h('span', { class: 'd' }, `−${total[1]}`))
    ),
    body
  )
  const cell = (ln, side, f) => {
    if (!ln) return [h('span', { class: 'n' }), h('span', { class: 'c empty-cell' })]
    return [h('span', { class: 'n' }, side === 'old' ? ln.o : ln.n), h('span', { class: 'c' }, ...(ln.mark || [ln.t]))]
  }
  const clickable = (el, f, ln, side) => {
    if (!onLine || !ln) return el
    el.classList.add('commentable')
    el.title = t('Click to comment on this line')
    el.addEventListener('click', () => onLine({ path: f.path, side, line: side === 'old' ? ln.o : ln.n, text: ln.t }))
    return el
  }
  // A huge file (a lockfile, generated code) shows its first lines; the rest on request.
  const MAX_LINES = 3000
  const expanded = new Set()
  function draw() {
    drawBar()
    root.classList.toggle('dv-wrapped', wrapOn)
    root.classList.toggle('dv-split', mode === 'split')
    const frag = document.createDocumentFragment()
    for (const f of files) {
      const showHead = files.length > 1 || !!onLine || f.badges.length > 0 // one plain file: the panel title names it
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : ''
      if (showHead) frag.append(
        h(
          'div',
          { class: 'dv-file' },
          icon('file', 13),
          h('span', { class: 'dv-path link', title: t('Open {file} in the editor', { file: f.path }), onClick: () => openRepoFile(f.path) }, dir && h('span', { class: 'dim' }, dir), h('strong', null, f.path.slice(dir.length))),
          ...f.badges.map((b) => h('span', { class: `pill dv-${b}` }, { new: t('new'), deleted: t('deleted'), renamed: t('renamed') }[b] || b)),
          f.badges.includes('renamed') && f.oldPath !== f.path && h('span', { class: 'dim mono' }, t('from {path}', { path: f.oldPath })),
          h('span', { class: 'grow' }),
          h('span', { class: 'dv-count' }, h('span', { class: 'a' }, `+${f.add}`), h('span', { class: 'd' }, `−${f.del}`))
        )
      )
      if (f.binary) frag.append((images && imagePreview(f, images)) || h('div', { class: 'dv-note' }, t('Binary file: no text to compare')))
      const lineCount = f.hunks.reduce((t, hk) => t + hk.lines.length, 0)
      let budget = expanded.has(f) ? Infinity : MAX_LINES
      for (const hk of f.hunks) {
        if (budget <= 0) break
        const patch = patches[hk.patch]
        const last = hk.newStart + Math.max(0, hk.newCount - 1)
        frag.append(
          h(
            'div',
            { class: 'dv-hunk' },
            h('span', { class: 'dv-range' }, hk.newCount ? (last > hk.newStart ? t('Lines {from}–{to}', { from: hk.newStart, to: last }) : t('Line {n}', { n: hk.newStart })) : t('Removed at line {n}', { n: hk.oldStart })),
            hk.context && h('span', { class: 'dv-ctx mono' }, hk.context),
            h('span', { class: 'grow' }),
            patch && hunkActions.map((a) => h('button', { class: `hunk-btn ${a.danger ? 'danger' : ''}`, title: t('{action} this hunk', { action: a.label }), onClick: () => a.run(patch) }, icon(a.icon, 11), a.label))
          )
        )
        const lines = hk.lines.length > budget ? hk.lines.slice(0, budget) : hk.lines
        budget -= lines.length
        const pairs = pairLines(lines)
        for (const pr of pairs) {
          if (pr.changed && pr.left && pr.right) {
            pr.left.mark = markChange(pr.left.t, pr.right.t)
            pr.right.mark = markChange(pr.right.t, pr.left.t)
          }
        }
        if (mode === 'split') {
          for (const pr of pairs) {
            const lk = pr.left ? pr.left.k : 'none'
            const rk = pr.right ? (pr.right.k === 'ctx' && pr.left ? 'ctx' : pr.right.k) : 'none'
            frag.append(
              h(
                'div',
                { class: 'ds' },
                clickable(h('div', { class: `ds-side ${lk}` }, ...cell(pr.left, 'old', f)), f, pr.left, 'old'),
                clickable(h('div', { class: `ds-side ${rk}` }, ...cell(pr.right, 'new', f)), f, pr.right, 'new')
              )
            )
          }
        } else {
          for (const ln of lines) {
            const side = ln.k === 'del' ? 'old' : 'new'
            frag.append(
              clickable(
                h('div', { class: `l ${ln.k}` }, h('span', { class: 'n' }, ln.k === 'add' ? '' : ln.o), h('span', { class: 'n' }, ln.k === 'del' ? '' : ln.n), h('span', { class: 'sg' }, ln.k === 'add' ? '+' : ln.k === 'del' ? '−' : ''), h('span', { class: 'c' }, ...(ln.mark || [ln.t]))),
                f,
                ln,
                side
              )
            )
          }
        }
      }
      if (!expanded.has(f) && lineCount > MAX_LINES)
        frag.append(
          h(
            'div',
            { class: 'dv-note dv-more' },
            t('Showing the first {shown} of {total} lines.', { shown: MAX_LINES, total: lineCount }) + ' ',
            h('button', { class: 'btn sm', onClick: () => (expanded.add(f), draw()) }, t('Show all {n} lines', { n: lineCount }))
          )
        )
    }
    clear(body).append(frag)
  }
  draw()
  return root
}

async function openRepoFile(file) {
  try {
    await request('file.open', { repo: state.repo, file }, 20000)
  } catch (e) {
    toast(e.message, 'error')
  }
}

/** The list on the left, the selected item's diff on the right (Commit and Stash tabs, full tab only). */
function splitWrap(root, hint) {
  const empty = () => h('div', { class: 'empty' }, icon('file', 26), h('div', null, hint), h('div', { class: 'dim' }, t('↑ ↓ move between files')))
  const pane = h('div', { class: 'diff-pane' }, empty())
  pane._empty = () => {
    clear(pane).append(empty())
    root.querySelectorAll('.item.sel').forEach((x) => x.classList.remove('sel'))
    if (state.tab === 'changes') state.changesSel = null
  }
  root.classList.add('changes-list')
  root.classList.remove('view')
  return h('div', { class: 'view changes-split' }, root, pane)
}
// Before/after preview of a changed image. images = { old, new }: the revision of each side
// ('' working tree, ':' index, a commit), or null when that side does not exist.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i
function imagePreview(f, images) {
  if (!IMAGE_RE.test(f.path)) return null
  const oldRef = f.badges.includes('new') ? null : images.old
  const newRef = f.badges.includes('deleted') ? null : images.new
  const side = (label, ref, file, del) => {
    const box = h('div', { class: 'img-side' }, h('div', { class: 'img-label ' + (del ? 'del' : 'add') }, label), h('div', { class: 'img-frame' }, h('div', { class: 'inline-skeleton' }, h('span'), h('span'))))
    const meta = h('div', { class: 'img-meta dim' })
    box.append(meta)
    call('fileImage', { ref, file }).then(
      ({ src, size }) => {
        const img = h('img', { src, alt: file })
        img.onload = () => (meta.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${size < 1024 ? size + ' B' : size < 1048576 ? (size / 1024).toFixed(1) + ' KB' : (size / 1048576).toFixed(1) + ' MB'}`)
        img.onclick = () => openRepoFile(file)
        img.title = t('Open in the editor')
        clear(box.querySelector('.img-frame')).append(img)
      },
      (e) => clear(box.querySelector('.img-frame')).append(h('div', { class: 'dv-note' }, e.message))
    )
    return box
  }
  const sides = []
  if (oldRef != null) sides.push(side(newRef == null ? t('Deleted') : t('Before'), oldRef, f.oldPath || f.path, true))
  if (newRef != null) sides.push(side(oldRef == null ? t('Added') : t('After'), newRef, f.path, false))
  if (!sides.length) return null
  return h('div', { class: 'img-preview' + (sides.length > 1 ? ' two' : '') }, ...sides)
}

async function showDiff(title, loader, actions = [], hunkActions, images) {
  // In the Commit and Stash tabs the diff opens beside the list, not over it.
  const pane = IN_TAB && (state.tab === 'changes' || state.tab === 'stash') ? document.querySelector('#main .diff-pane') : null
  let sheet
  if (pane) {
    clear(pane).append(
      h('div', { class: 'sheet-head' }, h('div', { class: 'sheet-title', title }, title), ...actions, h('span', { class: 'sheet-sep' }), iconBtn('x', t('Close'), () => pane._empty?.(), { class: 'icon-btn sheet-close' })),
      h('div', { class: 'sheet-body' }, h('div', { class: 'inline-skeleton' }, h('span'), h('span'), h('span')))
    )
    sheet = { el: pane, inPane: true }
  } else {
    openSheet(title, h('div', { class: 'empty' }, t('Loading…')), actions)
    sheet = state.sheets[state.sheets.length - 1]
  }
  const load = async () => {
    try {
      const text = await loader()
      const body = sheet.el.querySelector('.sheet-body')
      if (!text.trim() && hunkActions) {
        if (sheet.inPane) clear(sheet.el).append(h('div', { class: 'empty' }, t('No changes left in this file')))
        else if (state.sheets.includes(sheet)) closeSheet()
        return
      }
      clear(body).append(
        renderDiff(
          text,
          hunkActions?.map((a) => ({
            ...a,
            run: async (patch) => {
              if (a.danger && !(await confirmBox(t('Discard this hunk?'), t('The lines go back to how they were. This cannot be undone.'), t('Discard'), true))) return
              try {
                await call('applyPatch', { patch, ...a.args })
                toast(a.done)
              } catch (e) {
                toast(e.message, 'error')
              }
              await pollStatus(true)
              load()
            }
          })),
          { images }
        )
      )
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  await load()
}
const HUNK_STAGE = [
  { label: t('Discard'), icon: 'undo', danger: true, args: { reverse: true }, done: t('Hunk discarded') },
  { label: t('Stage'), icon: 'plus', args: { cached: true }, done: t('Hunk staged') }
]
const HUNK_UNSTAGE = [{ label: t('Unstage'), icon: 'minus', args: { cached: true, reverse: true }, done: t('Hunk unstaged') }]

/* =========================================================================
   Changes
   ========================================================================= */
function fileRow(f, { staged, onClick, actions }) {
  const letter = f.conflict ? 'U' : f.untracked ? '?' : staged ? f.x : f.y === '.' ? f.x : f.y
  const name = basename(f.path)
  const dir = dirname(f.path)
  return h(
    'div',
    { class: 'item', title: f.orig ? `${f.orig} → ${f.path}` : f.path, 'data-path': f.path, 'data-staged': staged ? '1' : '0', onClick: (e) => (markSelected(e.currentTarget), onClick && onClick(e)) },
    h('span', { class: `status-letter s-${letter}`, title: f.untracked ? t('Untracked') : '' }, f.untracked ? 'U' : letter),
    h('span', { class: 'file-name' }, name),
    dir && h('span', { class: 'file-dir grow' }, dir),
    !dir && h('span', { class: 'grow' }),
    h('div', { class: 'hover-actions', onClick: (e) => e.stopPropagation() }, actions)
  )
}

async function viewChanges() {
  const st = state.status
  const conflicts = st.files.filter((f) => f.conflict)
  const staged = st.files.filter((f) => !f.conflict && !f.untracked && f.x !== '.')
  const unstaged = st.files.filter((f) => !f.conflict && (f.untracked || f.y !== '.'))

  const root = h('div', { class: 'view', style: { paddingTop: 0 } })
  if (st.filesTotal > st.files.length)
    root.append(h('div', { class: 'banner' }, h('div', { class: 'row' }, icon('alert'), h('strong', null, t('Showing {shown} of {total} changed files', { shown: st.files.length.toLocaleString(LANG), total: st.filesTotal.toLocaleString(LANG) }))), h('div', { class: 'dim', style: { fontSize: '11.5px' } }, t('So many usually means a build or dependency folder is not ignored. Add it to .gitignore and the list gets short again.'))))

  // commit box
  const ta = h('textarea', {
    placeholder: st.branch ? t('Message for {branch} · Ctrl+Enter', { branch: st.branch }) : t('Commit message'),
    value: state.commitDraft,
    onInput: (e) => {
      state.commitDraft = e.target.value
      updateCommitBtn()
    },
    onKeydown: (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit({})
    }
  })
  ta.value = state.commitDraft
  const amend = h('input', {
    type: 'checkbox',
    checked: state.amend,
    onChange: async (e) => {
      state.amend = e.target.checked
      if (state.amend && !state.commitDraft.trim()) {
        const last = await call('lastMessage').catch(() => '')
        state.commitDraft = (last || '').trim()
        ta.value = state.commitDraft
      }
      updateCommitBtn()
    }
  })
  let pushMode = null // 'push' | 'publish' when there is nothing to commit but something to send
  const commitBtn = h('button', { class: 'btn primary', onClick: () => (pushMode ? run('push', {}, { success: pushMode === 'publish' ? t('Published {branch}', { branch: st.branch }) : t('Pushed') }) : doCommit({})) })
  const commitMore = h('button', { class: 'btn primary', title: t('More commit options'), onClick: (e) => commitMenu(e.currentTarget) }, icon('down', 12))
  function updateCommitBtn() {
    const n = staged.length
    const nothing = !n && !unstaged.length && !state.amend
    pushMode = nothing && st.branch && !st.detached ? (!st.upstream ? 'publish' : st.ahead > 0 ? 'push' : null) : null
    commitBtn.classList.toggle('push-mode', !!pushMode)
    commitMore.style.display = pushMode ? 'none' : ''
    if (pushMode) {
      commitBtn.disabled = false
      commitBtn.title = pushMode === 'publish' ? t('Push {branch} to the remote for the first time', { branch: st.branch }) : st.ahead > 1 ? t('Push {n} commits to {upstream}', { n: st.ahead, upstream: st.upstream }) : t('Push {n} commit to {upstream}', { n: st.ahead, upstream: st.upstream })
      clear(commitBtn).append(icon('push', 13), pushMode === 'publish' ? t('Publish {branch}', { branch: st.branch }) : st.ahead > 1 ? t('Push {n} commits', { n: st.ahead }) : t('Push {n} commit', { n: st.ahead }))
      return
    }
    commitBtn.title = ''
    const can = !!state.commitDraft.trim() && (n > 0 || state.amend || (unstaged.length > 0))
    commitBtn.disabled = !can
    commitMore.disabled = !state.commitDraft.trim()
    clear(commitBtn).append(icon('check', 13), state.amend ? t('Amend') : n ? (n > 1 ? t('Commit {n} files', { n }) : t('Commit {n} file', { n })) : unstaged.length ? t('Commit all') : t('Commit'))
  }
  updateCommitBtn()

  async function doCommit(extra) {
    if (!state.commitDraft.trim()) return
    const args = { message: state.commitDraft, amend: state.amend, ...extra }
    if (!staged.length && !state.amend && !extra.allowEmpty) {
      if (!unstaged.length) return
      // Nothing staged: stage everything first, the usual "commit all".
      if (!(await confirmBox(t('Nothing staged'), t('Stage all changes and commit them?'), t('Stage all & commit')))) return
      await call('stageAll').catch((e) => toast(e.message, 'error'))
    }
    if (!state.amend && !(await preCommitCheck())) return
    const out = await run('commit', args, { success: extra.push || !state.amend ? undefined : t('Amended'), quiet: true })
    // forgot a file or a typo? one click puts the last commit back in the box to amend
    if (out !== undefined && !extra.push && !state.amend) toast(t('Committed'), 'ok', 8000, { label: t('Amend'), run: () => ((state.amend = true), call('lastMessage').then((m) => ((state.commitDraft = m || ''), setTab('changes'), renderView({ force: true })), () => setTab('changes'))) })
    if (extra.push && out !== undefined) out?.pushError ? toast(t('Committed, but the push failed: {error}', { error: out.pushError }), 'error') : toast(t('Committed and pushed'))
    if (out !== undefined) {
      state.commitDraft = ''
      state.amend = false
      resetHistory()
      refreshAll()
    }
  }
  function commitMenu(anchor) {
    menu(anchor, [
      { label: t('Commit & push'), icon: 'push', onClick: () => doCommit({ push: true }) },
      { label: t('Commit with sign-off'), icon: 'user', onClick: () => doCommit({ signoff: true }) },
      { label: t('Empty commit'), icon: 'commit', onClick: () => doCommit({ allowEmpty: true }) }
    ])
  }

  root.append(
    h(
      'div',
      { class: 'commit-box' },
      ta,
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'check' }, amend, t('Amend last commit')),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn sm ai-review-btn', title: t('AI reviews what you are about to commit (the staged changes, or every change when nothing is staged)'), onClick: () => localReviewModal({ staged: true, onNext: () => ta.focus() }) }, icon('sparkle', 12), t('Review')),
        h(
          'button',
          {
            class: 'btn sm',
            title: t('Generate a commit message with AI'),
            disabled: !st.files.length,
            onClick: () =>
              aiCommitModal({
                staged: staged.length,
                total: st.files.length,
                onUse: (msg) => {
                  state.commitDraft = msg
                  ta.value = msg
                  updateCommitBtn()
                  ta.focus()
                },
                onCommit: (msg) => {
                  state.commitDraft = msg
                  ta.value = msg
                  doCommit({})
                }
              })
          },
          icon('wand', 12),
          t('AI message')
        )
      ),
      h('div', { class: 'split' }, commitBtn, commitMore)
    )
  )

  if (!st.files.length) {
    if (IN_TAB) {
      root.append(h('div', { class: 'empty clean-note' }, icon('check', 28), h('div', null, t('Working tree clean')), h('div', { class: 'dim', style: { fontSize: '12px', marginTop: '4px' } }, pushMode === 'push' ? (st.ahead > 1 ? t('Nothing to commit · {n} commits waiting to push', { n: st.ahead }) : t('Nothing to commit · {n} commit waiting to push', { n: st.ahead })) : pushMode === 'publish' ? t('Nothing to commit · {branch} is not on the remote yet', { branch: st.branch }) : t('Nothing to commit. Edits you make will show up here.'))))
      return splitWrap(root, t('Nothing to show: the working tree is clean'))
    }
    root.append(h('div', { class: 'empty clean-note' }, icon('check', 28), h('div', null, t('Working tree clean'))))
    return root
  }

  const folded = store.get('commitFolds', {}) || {}
  const foldHead = (key, ...kids) => {
    const head = h('div', { class: `section-head fold-head ${folded[key] ? 'folded' : ''}`, role: 'button', tabindex: 0, 'aria-expanded': !folded[key], title: folded[key] ? t('Show the files') : t('Hide the files') }, h('span', { class: 'fold-chev' }, icon('down', 12)), ...kids)
    const toggle = (e) => {
      if (e.target.closest('.actions')) return
      store.set('commitFolds', { ...folded, [key]: !folded[key] })
      renderView({ force: true })
    }
    head.addEventListener('click', toggle)
    head.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(e)))
    return head
  }
  if (conflicts.length) {
    root.append(foldHead('conflicts', t('Conflicts'), h('span', { class: 'count' }, conflicts.length)))
    if (!folded.conflicts) for (const f of conflicts)
      root.append(
        fileRow(f, {
          onClick: () => resolveConflict(f.path),
          actions: [
            iconBtn('more', t('Resolve'), (e) =>
              menu(e.currentTarget, [
                { label: t('Accept current ({side})', { side: conflictSides().current }), icon: 'left', onClick: () => run('useSide', { file: f.path, side: 'ours' }) },
                { label: t('Accept incoming ({side})', { side: conflictSides().incoming }), icon: 'right', onClick: () => run('useSide', { file: f.path, side: 'theirs' }) },
                { label: t('Mark as resolved'), icon: 'check', onClick: () => run('stage', { files: [f.path] }) }
              ])
            )
          ]
        })
      )
  }

  if (staged.length) {
    root.append(
      foldHead('staged', t('Staged'), h('span', { class: 'count' }, staged.length), h('div', { class: 'actions' }, iconBtn('minus', t('Unstage all'), () => run('unstageAll', {}))))
    )
    if (!folded.staged) for (const f of staged)
      root.append(
        fileRow(f, {
          staged: true,
          onClick: () => showDiff(f.path, () => call('diff', { file: f.path, staged: true }), [iconBtn('minus', t('Unstage file'), () => (closeSheet(), run('unstage', { files: [f.path] })))], HUNK_UNSTAGE, { old: 'HEAD', new: ':' }),
          actions: [iconBtn('more', t('More'), (e) => fileMenu(e.currentTarget, f)), iconBtn('minus', t('Unstage'), () => run('unstage', { files: [f.path] }))]
        })
      )
  }

  if (unstaged.length) {
    root.append(
      foldHead('changes', t('Changes'), h('span', { class: 'count' }, unstaged.length), h('div', { class: 'actions' }, iconBtn('undo', t('Discard all changes'), () => discard(unstaged)), iconBtn('plus', t('Stage all'), () => run('stage', { files: unstaged.map((f) => f.path) }))))
    )
    if (!folded.changes) for (const f of unstaged)
      root.append(
        fileRow(f, {
          onClick: () =>
            showDiff(
              f.path,
              () => call('diff', { file: f.path, untracked: f.untracked }),
              [iconBtn('undo', t('Discard file'), () => discard([f], true)), iconBtn('plus', t('Stage file'), () => (closeSheet(), run('stage', { files: [f.path] })))],
              f.untracked ? undefined : HUNK_STAGE,
              { old: f.untracked ? null : ':', new: '' }
            ),
          actions: [
            iconBtn('more', t('More'), (e) => fileMenu(e.currentTarget, f)),
            iconBtn('undo', t('Discard changes'), () => discard([f])),
            iconBtn('plus', t('Stage'), () => run('stage', { files: [f.path] }))
          ]
        })
      )
  }
  if (!IN_TAB) return root
  // Full tab: the file list on the left, the selected file's diff on the right (↑/↓ to move).
  const split = splitWrap(root, t('Select a file to see its changes'))
  requestAnimationFrame(() => {
    const sel = state.changesSel
    const row = sel && [...root.querySelectorAll('.item[data-path]')].find((r) => r.dataset.path === sel.path && r.dataset.staged === sel.staged)
    if (row) row.click()
  })
  return split
}

function markSelected(row) {
  row.parentElement?.closest('.view, .changes-list')?.querySelectorAll('.item.sel').forEach((r) => r.classList.remove('sel'))
  row.classList.add('sel')
  if (row.dataset.path) state.changesSel = { path: row.dataset.path, staged: row.dataset.staged }
}
document.addEventListener('keydown', (e) => {
  if (state.tab !== 'changes' || !IN_TAB || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
  if (e.target.closest?.('input, textarea, select, .overlay, .menu')) return
  const rows = [...document.querySelectorAll('#main .changes-list .item[data-path]')]
  if (!rows.length) return
  e.preventDefault()
  const i = rows.findIndex((r) => r.classList.contains('sel'))
  const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))] || rows[0]
  next.click()
  next.scrollIntoView({ block: 'nearest' })
})

async function discard(list, fromSheet) {
  const what = list.length === 1 ? basename(list[0].path) : t('{n} files', { n: list.length })
  const anyUntracked = list.some((f) => f.untracked)
  if (!(await confirmBox(t('Discard changes to {what}?', { what }), anyUntracked ? t('Untracked files will be deleted. This cannot be undone.') : t('This cannot be undone.'), t('Discard'), true))) return
  if (fromSheet) closeSheet()
  run('discard', { files: list.filter((f) => !f.untracked).map((f) => f.path), untracked: list.filter((f) => f.untracked).map((f) => f.path) }, { success: t('Discarded') })
}

/* =========================================================================
   History + graph
   ========================================================================= */
// 8 clearly different hues, so two lines never look alike
const LANE_COLORS = ['#6d9eeb', '#7cbf6a', '#d9a84e', '#b48be8', '#4fbfcf', '#e07a8b', '#e08f55', '#a8b85a']
/** The graph colour each commit was drawn with, so its labels elsewhere (the details card) match. */
const laneOfCommit = new Map()

/**
 * Lay out commits as lanes, the way Git Extensions draws its graph:
 * - a branch keeps one colour from top to bottom;
 * - when a commit's parent is already on screen, its line joins that lane instead of opening a new one;
 * - gaps close by sliding lanes left, so the graph stays narrow.
 * Each row lists the line segments to draw: [fromLane, fromY, toLane, toY, colour].
 */
function layoutGraph(commits) {
  let lanes = [] // [{ h: hash this lane is waiting for, c: colour index }]
  let nextColor = 0
  const rows = []
  for (const c of commits) {
    const top = lanes
    let col = top.findIndex((l) => l.h === c.hash)
    const hadTop = col !== -1
    const work = top.slice()
    if (!hadTop) {
      col = work.length
      work.push({ h: c.hash, c: nextColor++ })
    }
    const color = work[col].c
    const edges = []
    const merging = []
    top.forEach((l, i) => {
      if (i !== col && l.h === c.hash) merging.push(i)
    })
    if (hadTop) edges.push([col, 0, col, 'mid', color])
    for (const i of merging) edges.push([i, 0, col, 'mid', top[i].c])
    for (const i of merging) work[i] = null

    // parents
    const targets = [] // [laneIndexInWork, colour]
    if (c.parents.length) {
      const p0 = c.parents[0]
      const k = work.findIndex((l, i) => l && i !== col && l.h === p0)
      if (k !== -1) {
        work[col] = null
        targets.push([k, work[k].c])
      } else {
        work[col] = { h: p0, c: color }
        targets.push([col, color])
      }
      for (const p of c.parents.slice(1)) {
        let j = work.findIndex((l) => l && l.h === p)
        if (j === -1) {
          j = work.length
          work.push({ h: p, c: nextColor++ })
        }
        targets.push([j, work[j].c])
      }
    } else work[col] = null

    // compact: lanes slide left over the gaps
    const newIdx = []
    const next = []
    work.forEach((l, i) => {
      if (l) {
        newIdx[i] = next.length
        next.push(l)
      }
    })
    top.forEach((l, i) => {
      if (i === col || merging.includes(i) || !work[i] || work[i] !== l) return
      edges.push([i, 0, newIdx[i], 'bottom', l.c]) // a lane passing through (maybe shifting left)
    })
    for (const [t, tc] of targets) edges.push([col, 'mid', newIdx[t], 'bottom', t === col || tc === color ? color : tc])

    rows.push({ col, color, edges, before: top.map((l) => l.h), after: next.map((l) => l.h), lanes: Math.max(top.length, next.length, col + 1) })
    lanes = next
  }
  return rows
}

// Row height: compact (28) or comfortable (34) in the tab, chosen from the graph bar.
let ROW_H = IN_TAB ? (store.get('density', 'compact') === 'comfortable' ? 34 : 28) : 40
document.documentElement.style.setProperty('--row-h', `${ROW_H}px`)
// A narrow full tab works like the sidebar panel: shrinking icon buttons, Push/Pull in words when work waits, every tab visible.
const syncCompact = () => document.body.classList.toggle('compact', IN_TAB && innerWidth <= 820)
syncCompact()
addEventListener('resize', syncCompact)
function setDensity(v) {
  store.set('density', v)
  ROW_H = v === 'comfortable' ? 34 : 28
  document.documentElement.style.setProperty('--row-h', `${ROW_H}px`)
  rowCache.clear()
  renderView({ force: true })
}
const LANE_W = IN_TAB ? 14 : 11
const MAX_LANES = 40 // drawing width cap; lanes past it are clipped, never squashed together
const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length]
function graphSvg(row, width, merge, head) {
  const x = (i) => 9 + i * LANE_W
  const Y = { 0: 0, mid: ROW_H / 2, bottom: ROW_H }
  const curve = (x1, y1, x2, y2) =>
    x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
  let paths = ''
  for (const [a, ya, b, yb, ci] of row.edges)
    paths += `<path d="${curve(x(a), Y[ya], x(b), Y[yb])}" stroke="${laneColor(ci)}" stroke-width="2" stroke-opacity="1" fill="none" stroke-linecap="round"/>`
  const c = laneColor(row.color)
  const cx = x(row.col)
  const cy = ROW_H / 2
  const dot = merge
    ? `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--bg)" stroke="${c}" stroke-width="2"/>`
    : `<circle cx="${cx}" cy="${cy}" r="4.2" fill="${c}" stroke="var(--bg)" stroke-width="1.5"/>`
  // the checked-out commit: a ring around its node, like Git Extensions' HEAD marker
  const ring = head ? `<circle cx="${cx}" cy="${cy}" r="7.5" fill="none" stroke="${c}" stroke-width="1.5" opacity=".9"/>` : ''
  const wrap = document.createElement('span')
  wrap.style.display = 'flex'
  wrap.innerHTML = `<svg class="graph" width="${width}" height="${ROW_H}" style="overflow:hidden">${paths}${ring}${dot}</svg>`
  return wrap.firstChild
}
/** Graph column width for a set of rows. */
const graphWidth = (rows) => 9 + Math.min(MAX_LANES, Math.max(1, ...rows.map((r) => r.lanes))) * LANE_W

/** Ref labels. With a lane, branch labels take that lane's colour, as in VS Code's Git Graph. */
function refPills(refs, lane) {
  const out = []
  const style = lane == null ? null : { '--lane': laneColor(lane) }
  const lanePill = (el) => {
    if (style && !el.classList.contains('tag')) {
      el.classList.add('laned')
      el.style.setProperty('--lane', style['--lane'])
    }
    return el
  }
  const pill = (cls, iconName, text, title) => {
    const kind = cls.includes('tag') ? 'tag' : cls.includes('remote') ? 'remote' : 'branch'
    const ok = iconName !== 'stash'
    return lanePill(h('span', { class: `ref ${cls}`, title, 'data-ref': ok ? text : null, 'data-kind': kind, draggable: ok ? 'true' : null, 'data-drag-ref': ok ? text : null, 'data-drag-kind': ok ? kind : null, 'data-drop-ref': ok && kind !== 'tag' ? text : null, 'data-drop-kind': ok ? kind : null }, icon(iconName, 10), h('span', { class: 'ref-t' }, text)))
  }
  const isRemote = (r) => r.includes('/') && !r.startsWith('tag: ') && !state.localNames?.has(r)
  const remoteName = (r) => r.slice(0, r.indexOf('/'))
  const branchOf = (r) => r.slice(r.indexOf('/') + 1)

  // What is checked out at this commit: a branch ("HEAD -> x") or the commit itself (detached "HEAD").
  const headBranch = refs.find((r) => r.startsWith('HEAD -> '))?.slice(8) || null
  const detached = refs.includes('HEAD')
  const names = refs.filter((r) => r !== 'HEAD' && !r.startsWith('HEAD -> '))
  const locals = [headBranch, ...names.filter((r) => !r.startsWith('tag: ') && !isRemote(r) && r !== 'stash' && !r.startsWith('refs/stash'))].filter(Boolean)

  // A local branch and the same branch on a remote, at the same commit, are one label (they are in
  // sync): "main │ ☁ origin". Out of sync they stay two labels on two commits. Worked out first,
  // because git may list the remote before the local branch.
  const syncedOf = new Map()
  const merged = new Set()
  for (const l of locals) {
    const rs = names.filter((r) => isRemote(r) && branchOf(r) === l)
    if (rs.length) {
      syncedOf.set(l, rs)
      rs.forEach((r) => merged.add(r))
    }
  }
  const withRemotes = (el, local) => {
    const rs = syncedOf.get(local)
    if (!rs) return el
    el.classList.add('synced')
    el.title += '\n' + t('In sync with {remotes}', { remotes: rs.join(', ') })
    el.append(h('span', { class: 'ref-remote' }, icon('cloud', 10), h('span', null, rs.map(remoteName).join(', '))))
    return el
  }

  if (headBranch) out.push(withRemotes(pill('head current', 'current', headBranch, t('{branch} (checked out)', { branch: headBranch })), headBranch))
  let marked = false
  for (const r of names) {
    if (merged.has(r)) continue
    if (r.startsWith('tag: ')) out.push(pill('tag', 'tag', r.slice(5), t('Tag {name}', { name: r.slice(5) })))
    else if (r.startsWith('refs/stash') || r === 'stash') out.push(pill('', 'stash', 'stash', t('Stash')))
    else if (isRemote(r)) {
      if (detached && !marked) {
        // detached on a remote branch: that label is what is checked out
        marked = true
        out.push(pill('remote head current', 'current', r, t('{branch} (checked out, detached HEAD)', { branch: r })))
      } else out.push(pill('remote', 'globe', r, t('Remote branch {branch}, not on this computer', { branch: r })))
    } else if (detached && !marked) {
      marked = true
      out.push(withRemotes(pill('head current', 'current', r, t('{branch} (checked out, detached HEAD)', { branch: r })), r))
    } else out.push(withRemotes(pill('', 'branch', r, t('Branch {branch}', { branch: r })), r))
  }
  if (detached && !marked) out.push(pill('head current', 'current', 'HEAD', t('Detached HEAD (checked out)')))
  return out
}

/**
 * Every reset of the list (repo, Branch/All, search, mode, an operation that rewrote history) bumps
 * the generation, so a page or quiet reload that was in flight for the old list is dropped.
 */
let historyGen = 0
function resetHistory() {
  historyGen++
  state.history.commits = []
  state.history.done = false
  loadingMorePromise = null
}
let loadingMorePromise = null
let searchBox = null
/** Text with every case-insensitive occurrence of `q` wrapped in <mark>, as DOM nodes. */
// The same rule as the worker's search: under 3 characters, whole words only.
const searchRe = (q) => {
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return q.length < 3 ? new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'giu') : new RegExp(esc, 'giu')
}
const hasHit = (text, q) => !!q && searchRe(q).test(String(text ?? ''))
function marked(text, q) {
  text = String(text ?? '')
  if (!q) return text
  const out = []
  let i = 0
  for (const m of text.matchAll(searchRe(q))) {
    if (m.index > i) out.push(text.slice(i, m.index))
    out.push(h('mark', { class: 'hit' }, m[0]))
    i = m.index + m[0].length
  }
  if (i < text.length) out.push(text.slice(i))
  return out
}

async function loadHistory(more = false) {
  const H = state.history
  // One "load more" at a time: the scroll sentinel, the button and goToHead share it.
  if (more && loadingMorePromise) return loadingMorePromise
  const repo = state.repo
  const gen = historyGen
  const page = 300
  const p = (async () => {
    const commits = await call('log', { all: H.all, limit: page, skip: more ? H.commits.length : 0, search: H.search, mode: H.mode || 'message' })
    if (repo !== state.repo || gen !== historyGen) return
    if (more) {
      const seen = new Set(H.commits.map((c) => c.hash)) // safety net against an overlapping page
      H.commits = H.commits.concat(commits.filter((c) => !seen.has(c.hash)))
    } else H.commits = commits
    H.done = commits.length < page
  })()
  if (!more) return p
  loadingMorePromise = p
  try {
    return await p
  } finally {
    if (loadingMorePromise === p) loadingMorePromise = null
  }
}

/** Built graph rows by commit, reused across renders while their look is unchanged. */
const rowCache = new Map()
// The "3m ago" text and the set of local branch names (which pills show as local) are part of the look.
const rowSignature = (c, row, width, open, names) =>
  [c.refs.join(','), open ? 1 : 0, width, names, ago(c.time), row ? row.color + ':' + row.col + ':' + JSON.stringify(row.edges) : '-'].join('|')

/** Reload the first page in the background; redraw only when something changed. */
let reloadingHistory = false
let reloadAgain = false
async function reloadHistoryQuietly() {
  const H = state.history
  // A reload already running may have read the repository before the latest change: run once more after it.
  if (reloadingHistory) return void (reloadAgain = true)
  reloadingHistory = true
  const repo = state.repo
  const gen = historyGen
  try {
    // as many commits as are on screen (at least a page), so a reload never shortens the list
    const limit = Math.min(1000, Math.max(300, H.commits.length))
    const commits = await call('log', { all: H.all, limit, skip: 0, search: H.search, mode: H.mode || 'message' })
    if (repo !== state.repo || gen !== historyGen) return
    if (loadingMorePromise) await loadingMorePromise.catch(() => {}) // let a page in flight land first
    if (repo !== state.repo || gen !== historyGen) return
    const sig = (list) => list.map((c) => c.hash + c.refs.join()).join()
    if (sig(commits) !== sig(H.commits.slice(0, commits.length)) || commits.length !== Math.min(H.commits.length, limit)) {
      H.commits = commits
      H.done = commits.length < limit
      if (state.tab === 'history') renderView()
    }
    snap.save()
  } catch {
  } finally {
    reloadingHistory = false
    if (reloadAgain) {
      reloadAgain = false
      reloadHistoryQuietly()
    }
  }
}

/** Scroll the graph to the checked-out commit, loading older pages until it is found. */
async function goToHead() {
  const H = state.history
  const oid = state.status?.oid
  if (!oid) return
  if (state.tab !== 'history') setTab('history')
  const gen = historyGen
  let row = document.querySelector(`.commit-row[data-hash="${oid}"]`)
  for (let i = 0; !row && !H.done && i < 15; i++) {
    await loadHistory(true)
    if (gen !== historyGen || state.tab !== 'history') return // the list was reset or left meanwhile
    await renderView()
    row = document.querySelector(`.commit-row[data-hash="${oid}"]`)
  }
  if (!row) return toast(t('The checked-out commit is not in the loaded history (try All branches).'), 'error')
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  row.classList.add('flash')
  setTimeout(() => row.classList.remove('flash'), 1400)
}

/** Loads the next page when it scrolls into view (a button too, for keyboards). */
let loadingMore = false
let moreObserver = null
function loadMoreSentinel() {
  const more = async () => {
    if (loadingMore) return
    loadingMore = true
    clear(btn).append(h('span', { class: 'spinner' }), t('Loading…'))
    try {
      await loadHistory(true)
      await renderView()
    } finally {
      loadingMore = false
    }
  }
  const btn = h('button', { class: 'btn sm load-more', onClick: more }, icon('down', 12), t('Load more'))
  moreObserver?.disconnect()
  const io = (moreObserver = new IntersectionObserver((ents) => ents.some((e) => e.isIntersecting) && (io.disconnect(), more()), { root: $('#main'), rootMargin: '1500px' }))
  requestAnimationFrame(() => btn.isConnected && io.observe(btn))
  return btn
}

async function viewHistory() {
  const H = state.history
  if (!H.commits.length && !H.done) await loadHistory()
  else if (H.stale) {
    H.stale = false
    reloadHistoryQuietly()
  }
  if (!state.refs) state.refs = await call('refs').catch(() => null)
  if (state.refs) state.localNames = new Set(state.refs.local.map((b) => b.name))
  const root = h('div', { class: 'view', style: { paddingTop: '8px' } })
  H.mode = 'all'
  let typing = null
  const runSearch = (v) => {
    clearTimeout(typing)
    if (v === H.search) return
    H.search = v
    resetHistory()
    $('#main').scrollTop = 0 // a new search starts at the top, the box in view
    // a search through a big history can take a while: say so, and let it be stopped
    const bar = document.querySelector('#main .history-bar')
    if (v && bar && !bar.querySelector('.search-busy')) {
      const busy = h('span', { class: 'search-busy' }, h('span', { class: 'spinner' }), t('Searching…'), h('button', { class: 'btn sm', onClick: () => ((search.value = ''), runSearch('')) }, icon('x', 11), t('Stop')))
      setTimeout(() => bar.isConnected && !busy.isConnected && bar.append(busy), 400)
    }
    renderView()
  }
  // One search box for the life of the panel: results redraw the view around it, never the box
  // itself, so nothing typed meanwhile is lost and the caret stays put.
  const search = (searchBox ||= h('input', {
    type: 'text',
    class: 'graph-search',
    placeholder: t('Search commits'),
    title: t('Messages, authors, changed files, hashes, branches and tags'),
    value: H.search,
    onInput: (e) => {
      clearTimeout(typing)
      const v = e.target.value.trim()
      typing = setTimeout(() => runSearch(v), v ? 300 : 0)
    },
    onKeydown: (e) => {
      if (e.key === 'Enter') runSearch(e.target.value.trim())
      else if (e.key === 'Escape' && e.target.value) {
        e.preventDefault()
        e.stopPropagation()
        e.target.value = ''
        runSearch('')
      }
    }
  }))
  if (document.activeElement !== search) search.value = H.search
  const seg = h(
    'div',
    { class: 'segmented' },
    h('button', { class: H.all ? '' : 'on', title: t('Only the history of the branch you are on'), onClick: () => setAll(false) }, t('This branch')),
    h('button', { class: H.all ? 'on' : '', title: t('Every branch, tag and remote'), onClick: () => setAll(true) }, t('All branches'))
  )
  function setAll(v) {
    H.all = v
    store.set('historyAllV2', v)
    resetHistory()
    renderView()
  }
  const headBtn = h('button', { class: 'btn sm', title: t('Scroll to the checked-out commit'), onClick: () => goToHead() }, icon('current', 12), 'HEAD')
  const dense = IN_TAB && iconBtn('rows', ROW_H > 28 ? t('Compact rows') : t('Comfortable rows'), () => setDensity(ROW_H > 28 ? 'compact' : 'comfortable'), { class: `icon-btn density-btn ${ROW_H > 28 ? 'on' : ''}` })
  // an × inside the box clears the search (Esc does too)
  const searchWrap = h('div', { class: 'graph-search-wrap' }, liveSlot(search), H.search && iconBtn('x', t('Clear search'), () => ((search.value = ''), runSearch('')), { class: 'icon-btn search-clear' }))
  root.append(h('div', { class: 'history-bar' }, searchWrap, seg, headBtn, dense))
  if (IN_TAB) root.append(h('div', { class: 'date-float-wrap' }, h('div', { class: 'date-float', id: 'dateFloat' })))

  if (!H.commits.length) {
    root.append(
      h(
        'div',
        { class: 'empty' },
        icon('history', 28),
        h('div', null, H.search ? t('Nothing matches “{query}”', { query: H.search }) : t('No commits yet')),
        H.search && h('div', { class: 'dim' }, H.all ? t('Searched messages, authors, changed files, hashes, branches and tags.') : t('Searched messages, authors, changed files, hashes, branches and tags on this branch.')),
        H.search &&
          h(
            'div',
            { class: 'empty-actions' },
            !H.all && h('button', { class: 'btn sm primary', onClick: () => setAll(true) }, icon('search', 12), t('Search all branches')),
            h('button', { class: 'btn sm', onClick: () => ((search.value = ''), runSearch('')) }, icon('x', 12), t('Clear search'))
          ),
        !H.search && h('div', { class: 'empty-actions' }, h('button', { class: 'btn sm primary', onClick: () => setTab('changes') }, icon('commit', 12), t('Make the first commit')))
      )
    )
    return root
  }
  // The graph is only meaningful for an unfiltered log.
  const rows = H.search ? null : layoutGraph(H.commits)
  if (rows) rows.forEach((r, i) => laneOfCommit.set(H.commits[i].hash, r.color))
  const width = rows ? graphWidth(rows) + 4 : 8
  const list = h('div')
  const frag = document.createDocumentFragment()
  const names = state.localNames ? [...state.localNames].sort().join(' ') : '' // branch names cannot hold spaces
  H.commits.forEach((c, i) => {
    // Rows are rebuilt only when what they show changed (lines, labels, selection): switching tabs,
    // refreshing or loading more reuses the rest instead of rebuilding hundreds of SVG rows.
    const sig = rowSignature(c, rows && rows[i], width, H.open === c.hash, names) + '|' + (H.search || '')
    const cached = rowCache.get(c.hash)
    let row = cached && cached.sig === sig ? cached.el : null
    if (!row) {
      row = buildRow(c, i)
      rowCache.set(c.hash, { sig, el: row })
    }
    row.classList.toggle('selected', H.open === c.hash) // toggleInline changes it in place
    frag.append(row)
    if (H.open === c.hash && !dockMode()) frag.append(inlineDetail(c))
  })
  if (rowCache.size > 4000) rowCache.clear()
  list.append(frag)
  // a hit only in its files, hash or a branch name: say where, since nothing in the row is marked
  function matchNote(c) {
    if (!H.search || !c.match?.length) return null
    if (hasHit(c.subject, H.search) || hasHit(c.author, H.search)) return null // already marked in the row
    const why = c.match.includes('body')
      ? t('in description')
      : c.match.includes('file')
        ? t('file: {file}', { file: c.matchFile })
        : c.match.includes('ref')
          ? (/^tag: |^v?\d/.test(c.matchRef || '') ? t('tag: {ref}', { ref: c.matchRef }) : t('branch: {ref}', { ref: c.matchRef }))
          : c.match.includes('hash')
            ? t('commit hash')
            : c.match.includes('author')
              ? t('author email')
              : ''
    return why ? h('span', { class: 'match-note', title: why }, why) : null
  }
  function buildRow(c, i) {
    const row = h(
        'div',
        { class: `commit-row ${H.open === c.hash ? 'selected' : ''}`, 'data-hash': c.hash, 'data-time': c.time, onClick: () => (dockMode() ? openDock(c) : toggleInline(c, row)), onContextmenu: (e) => commitContextMenu(e, c) },
        rows ? graphSvg(rows[i], width, c.parents.length > 1, c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> '))) : h('span', { style: { width: '8px' } }),
        IN_TAB
          ? [
              h('div', { class: 'commit-text' }, h('div', { class: 'commit-subject' }, refPills(c.refs, rows && rows[i] ? rows[i].color : null), h('span', { class: 's', title: c.subject }, marked(c.subject, H.search)), matchNote(c))),
              h('div', { class: 'col-author ellipsis', title: c.email }, marked(c.author, H.search)),
              h('div', { class: 'col-date', title: fullDate(c.time) }, new Date(c.time * 1000).toLocaleString(LANG, { dateStyle: 'medium', timeStyle: 'short' })),
              h('div', { class: 'col-hash mono' }, H.search && c.hash.toLowerCase().startsWith(H.search.toLowerCase()) ? marked(c.hash.slice(0, Math.max(7, H.search.length)), H.search) : c.hash.slice(0, 7)),
              rowActions(c)
            ]
          : h(
              'div',
              { class: 'commit-text' },
              h('div', { class: 'commit-subject' }, refPills(c.refs, rows && rows[i] ? rows[i].color : null), h('span', { class: 's', title: c.subject }, marked(c.subject, H.search)), matchNote(c)),
              h('div', { class: 'commit-meta', title: fullDate(c.time) }, marked(c.author, H.search), ` · ${ago(c.time)} · `, h('span', { class: 'mono' }, c.hash.slice(0, 7)))
            )
      )
    return row
  }
  root.append(list)
  if (!H.done)
    root.append(
      h(
        'div',
        { style: { padding: '10px', textAlign: 'center' } },
        loadMoreSentinel()
      )
    )
  return root
}

/* ---------- commit details, shown in a row under the commit (or in a sheet elsewhere) ---------- */
const detailCache = new Map()
async function commitDetails(hash) {
  const key = state.repo + '|' + hash
  if (!detailCache.has(key)) {
    const p = call('commitShow', { hash })
    detailCache.set(key, p)
    p.catch(() => detailCache.delete(key))
    if (detailCache.size > 200) detailCache.delete(detailCache.keys().next().value)
  }
  return detailCache.get(key)
}

function toggleInline(c, row) {
  const H = state.history
  const list = row.parentElement
  list.querySelector('.commit-inline')?.remove()
  list.querySelector('.commit-row.selected')?.classList.remove('selected')
  if (H.open === c.hash) {
    H.open = null
    viewMem.set({ open: null })
    return
  }
  H.open = c.hash
  viewMem.set({ open: c.hash })
  row.classList.add('selected')
  const el = inlineDetail(c)
  row.after(el)
  // keep the opened details in view without jumping
  requestAnimationFrame(() => {
    const main = $('#main')
    const r = el.getBoundingClientRect()
    const m = main.getBoundingClientRect()
    if (r.bottom > m.bottom) main.scrollBy({ top: Math.min(r.bottom - m.bottom + 8, r.top - m.top - 40), behavior: 'smooth' })
  })
}

function inlineDetail(c) {
  const close = () => {
    state.history.open = null
    el.previousElementSibling?.classList.remove('selected')
    el.remove()
  }
  const body = h('div', { class: 'inline-body' }, h('div', { class: 'inline-skeleton' }, h('span'), h('span'), h('span')))
  const el = h(
    'div',
    { class: 'commit-inline', onClick: (e) => e.stopPropagation() },
    h(
      'div',
      { class: 'inline-head' },
      h('span', { class: 'mono dim' }, c.hash.slice(0, 7)),
      h('strong', { class: 'grow ellipsis', title: c.subject }, c.subject),
      iconBtn('open', t('Open in a side sheet'), () => openCommit(c.hash)),
      iconBtn('x', t('Close'), close)
    ),
    body
  )
  commitDetails(c.hash).then(
    (full) => el.isConnected && clear(body).append(commitBody(full, { inline: true })),
    (e) => el.isConnected && clear(body).append(h('div', { class: 'dim', style: { padding: '8px' } }, e.message))
  )
  return el
}

/** The commit's message, metadata, actions and changed files. */
function commitBody(c, { inline = false } = {}) {
  const short = c.hash.slice(0, 7)
  const body = h('div', { class: inline ? 'inline-grid' : '' })
  const [subject, ...rest] = c.message.split('\n')
  body.append(
    h(
      'div',
      { class: 'detail' },
      !inline && h('div', { style: { fontWeight: 600 } }, subject),
      rest.join('\n').trim() && h('div', { class: 'msg dim' }, rest.join('\n').trim()),
      c.refs.length ? h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '4px' } }, refPills(c.refs, laneOfCommit.get(c.hash))) : null,
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, t('Author')),
        h('dd', { title: c.email }, `${c.author}`),
        h('dt', null, t('Date')),
        h('dd', null, fullDate(c.time)),
        c.committer !== c.author && [h('dt', null, t('Committer')), h('dd', null, c.committer)],
        h('dt', null, t('Commit')),
        h('dd', { class: 'mono' }, c.hash),
        c.parents.length ? [h('dt', null, c.parents.length > 1 ? t('Parents') : t('Parent')), h('dd', { class: 'mono' }, c.parents.map((p) => p.slice(0, 7)).join(' '))] : null
      ),
      h(
        'div',
        { class: 'actions-wrap' },
        h('button', { class: 'btn sm', onClick: () => checkoutCommit(c.hash) }, icon('commit', 12), t('Checkout')),
        h('button', { class: 'btn sm', onClick: () => newBranch(c.hash) }, icon('branch', 12), t('Branch')),
        h('button', { class: 'btn sm ai-gen', title: t('AI explains what this commit changes and why'), onClick: () => explainSheet({ hash: c.hash, subject: (c.message || '').split('\n')[0] }) }, icon('wand', 12), t('Explain')),
        // a branch of this commit that is not the one you are on: merge it in one click
        (() => {
          const cur = state.status?.branch
          const other = (c.refs || []).map((r) => r.replace(/^HEAD -> /, '')).find((r) => r !== 'HEAD' && !r.startsWith('tag: ') && state.localNames?.has(r) && r !== cur)
          return cur && other && c.hash !== state.status?.oid ? h('button', { class: 'btn sm', title: t('Merge {branch} into {current}, the branch you are on', { branch: other, current: cur }), onClick: () => mergeRef(other) }, icon('merge', 12), t('Merge {branch} → {current}', { branch: nm(other, 18), current: nm(cur, 18) })) : null
        })(),
        h('button', { class: 'btn sm', onClick: (e) => commitMenu(e.currentTarget, c) }, icon('more', 12), t('More'))
      )
    )
  )
  // inline: the outer box takes the row's height, the inner one scrolls inside it
  const outer = h('div', { class: inline ? 'inline-files' : '' })
  const filesBox = inline ? h('div', { class: 'if-scroll' }) : outer
  if (inline) outer.append(filesBox)
  body.append(outer)
  filesBox.append(h('div', { class: 'section-head' }, t('Files'), h('span', { class: 'count' }, c.files.length), c.parents.length > 1 && h('span', { class: 'dim', style: { textTransform: 'none', fontWeight: 400 } }, t('vs first parent {hash}', { hash: c.parents[0].slice(0, 7) }))))
  for (const f of c.files) {
    filesBox.append(
      h(
        'div',
        { class: 'item', title: f.orig ? `${f.orig} → ${f.path}` : f.path, onClick: () => showDiff(`${basename(f.path)} @ ${short}`, () => call('commitFileDiff', { hash: c.hash, file: f.path }), [], undefined, { old: c.parents?.length ? c.parents[0] : null, new: c.hash }) },
        h('span', { class: `status-letter s-${f.status}` }, f.status),
        h('span', { class: 'file-name' }, basename(f.path)),
        h('span', { class: 'file-dir grow' }, dirname(f.path)),
        f.add != null && h('span', { class: 'stat' }, f.add === '-' ? t('bin') : [h('span', { class: 'a' }, `+${f.add}`), ' ', h('span', { class: 'd' }, `-${f.del}`)])
      )
    )
  }
  if (!c.files.length) filesBox.append(h('div', { class: 'dim', style: { padding: '4px 10px' } }, t('No file changes')))
  return body
}

async function openCommit(hash) {
  openSheet(hash.slice(0, 7), h('div', { class: 'inline-skeleton', style: { margin: '12px' } }, h('span'), h('span'), h('span')))
  const sheet = state.sheets[state.sheets.length - 1]
  let c
  try {
    c = await commitDetails(hash)
  } catch (e) {
    if (state.sheets.includes(sheet)) closeSheet()
    return toast(e.message, 'error')
  }
  if (!sheet.el.isConnected) return
  sheet.el.querySelector('.sheet-title').textContent = sheet.el.querySelector('.sheet-title').title = `${hash.slice(0, 7)} · ${c.message.split('\n')[0]}`
  clear(sheet.el.querySelector('.sheet-body')).append(commitBody(c))
}

/** Right-click on a commit row: the commit's menu at the pointer (the full message is loaded first). */
async function commitContextMenu(e, c) {
  e.preventDefault()
  const point = { x: e.clientX, y: e.clientY }
  const lab = e.target.closest?.('.ref[data-ref]')
  const clicked = lab ? { name: lab.dataset.ref, kind: lab.dataset.kind } : null
  let full = c
  if (c.message == null) full = { ...c, ...(await call('commitShow', { hash: c.hash }).catch(() => ({ message: c.subject || '' }))), refs: c.refs, parents: c.parents }
  commitMenu(point, full, clicked)
}

/**
 * Everything Git Extensions offers on a revision, grouped the same way: checkout and new refs, the
 * actions on the current branch, the branches and tags at this commit, inspecting, and copying.
 */
function commitMenu(anchor, c, clicked) {
  const cur = state.status?.branch || 'HEAD'
  const short = c.hash.slice(0, 7)
  // the graph's own labels say which commit is checked out; the status can lag a commit made outside the app
  const isHead = c.refs ? c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> ')) : c.hash === state.status?.oid
  const isMerge = (c.parents?.length ?? 0) > 1
  const bis = state.status?.bisect
  const refs = (c.refs || []).filter((r) => r !== 'HEAD')
  const branches = refs.map((r) => r.replace(/^HEAD -> /, '')).filter((r) => !r.startsWith('tag: '))
  const local = branches.filter((b) => state.localNames?.has(b))
  const remote = branches.filter((b) => !state.localNames?.has(b) && b.includes('/'))
  const tags = refs.filter((r) => r.startsWith('tag: ')).map((r) => r.slice(5))
  const staged = state.status?.files?.some((f) => f.staged)
  const date = c.time ? new Date(c.time * 1000).toISOString() : ''
  // Everyday actions on top; everything else in one "More" submenu, so the menu reads at a glance.
  const branchItems = [
    ...local.map((b) => ({
      label: t('Branch {branch}', { branch: b }),
      icon: 'branch',
      items: [
        b !== cur && { label: t('Checkout'), icon: 'right', onClick: () => checkout(b) },
        { label: t('Push'), icon: 'push', onClick: () => run('push', b === cur ? {} : { branch: b }, { success: t('Pushed {ref}', { ref: b }) }) },
        { label: t('Rename…'), icon: 'edit', onClick: () => renameBranch(b) },
        { label: t('Show only this branch'), icon: 'history', onClick: () => showBranchLog(b) },
        b !== cur && cur && { label: mergeLabel(b, cur), full: t('Merge {branch} → {current}', { branch: b, current: cur }), icon: 'merge', onClick: () => mergeRef(b) },
        ...(b !== cur ? withAiReview(mrBoth(b, cur)) : []),
        b !== cur && { label: t('Delete…'), icon: 'trash', danger: true, onClick: () => deleteBranch(b) }
      ]
    })),
    ...tags.map((tg) => ({
      label: t('Tag {name}', { name: tg }),
      icon: 'tag',
      items: [
        cur && { label: mergeLabel(tg, cur), full: t('Merge tag {tag} → {current}', { tag: tg, current: cur }), icon: 'merge', onClick: () => mergeRef(tg) },
        { label: t('Push tag'), icon: 'push', onClick: () => run('tagPush', { name: tg }, { success: t('Pushed {ref}', { ref: tg }) }) },
        { label: t('Delete (local)…'), icon: 'trash', danger: true, onClick: async () => (await confirmBox(t('Delete tag {tag}?', { tag: tg }), t('Only the local tag is deleted.'), t('Delete'), true)) && run('tagDelete', { name: tg }) }
      ]
    }))
  ]
  // What can be merged from here: the label right-clicked, else every branch and tag at this commit.
  const pickRef = clicked?.name && clicked.name !== cur ? clicked.name : null
  const mergeables = [...local.filter((b) => b !== cur), ...remote.filter((r) => !r.endsWith('/HEAD')), ...tags]
  const mergeOne = (ref) => ({ label: mergeLabel(ref, cur), full: t('Merge {branch} → {current}', { branch: ref, current: cur }), icon: 'merge', onClick: () => mergeRef(ref) })
  const mergeItem =
    mergeables.length > 1
      ? { label: t('Merge into {current}', { current: nm(cur) }), icon: 'merge', items: [...mergeables.map(mergeOne), { label: t('This commit ({hash}) → {current}', { hash: short, current: nm(cur) }), icon: 'commit', onClick: () => mergeRef(c.hash) }] }
      : mergeOne(mergeables[0] || c.hash)
  menu(anchor, [
    { header: pickRef ? (clicked.kind === 'tag' ? t('Tag {name}', { name: pickRef }) : clicked.kind === 'remote' ? t('Remote branch {name}', { name: pickRef }) : t('Branch {name}', { name: pickRef })) : `${short} · ${(c.subject || c.message || '').split('\n')[0].slice(0, 48)}` },
    pickRef && cur && mergeOne(pickRef),
    pickRef && '-',
    {
      label: t('Checkout'),
      icon: 'right',
      items: [
        ...local.filter((b) => b !== cur).map((b) => ({ label: t('Branch {branch}', { branch: b }), icon: 'branch', onClick: () => checkout(b) })),
        ...remote.map((b) => ({ label: state.localNames?.has(b.replace(/^[^/]+\//, '')) ? t('Remote {branch}…', { branch: b }) : t('Remote {branch}', { branch: b }), icon: 'globe', onClick: () => checkout(b, { track: true }) })),
        { label: t('This commit (detached HEAD)'), icon: 'commit', onClick: () => checkoutCommit(c.hash) }
      ]
    },
    ...local.map((b) => ({ label: b === cur && state.status?.ahead ? t('Push {branch} ({n})', { branch: b, n: state.status.ahead }) : t('Push {branch}', { branch: b }), icon: 'push', onClick: () => run('push', b === cur ? {} : { branch: b }, { success: t('Pushed {ref}', { ref: b }) }) })),
    !local.length && cur && cur !== 'HEAD' && state.status?.ahead > 0 && { label: t('Push {branch} up to here', { branch: cur }), icon: 'push', hint: short, onClick: () => run('push', { branch: cur, hash: c.hash }, { success: t('Pushed {branch} up to {hash}', { branch: cur, hash: short }) }) },
    { label: t('Create branch here…'), icon: 'plus', onClick: () => newBranch(c.hash) },
    { label: t('Create tag here…'), icon: 'tag', onClick: () => newTag(c.hash) },
    { label: t('New worktree here…'), icon: 'worktree', onClick: () => addWorktree({ base: c.hash }) },
    '-',
    !pickRef && !isHead && cur && mergeItem,
    ...withAiReview(mrItem(local, remote, cur)),
    !isHead && { label: pickRef ? t('Rebase {branch} onto {onto}…', { branch: nm(cur), onto: nm(pickRef) }) : t('Rebase {branch} onto this…', { branch: cur }), icon: 'merge', onClick: () => rebaseOnto(pickRef || local[0] || c.hash) },
    !isHead && { label: t('Cherry-pick'), icon: 'commit', onClick: () => run('cherryPick', { hash: c.hash, mainline: isMerge }, { success: t('Cherry-picked') }) },
    { label: t('Revert…'), icon: 'undo', onClick: async () => (await confirmBox(t('Revert {hash}?', { hash: short }), t('A new commit that undoes it will be created.'), t('Revert'))) && run('revert', { hash: c.hash, mainline: isMerge }, { success: t('Reverted') }) },
    !isHead && { label: t('Reset {branch} to here…', { branch: cur }), icon: 'undo', onClick: () => resetTo(c.hash) },
    branchItems.length && '-',
    branchItems.length === 1 ? branchItems[0] : branchItems.length && { label: t('Branches and tags here'), icon: 'branch', items: branchItems },
    '-',
    { label: t('Pipeline'), icon: 'refresh', onClick: () => openPipelines({ sha: c.hash }) },
    { label: t('Compare with HEAD'), icon: 'compare', onClick: () => compareSheet(c.hash, 'HEAD') },
    isMerge && { label: t('Compare with first parent'), icon: 'compare', onClick: () => compareSheet(c.parents[0], c.hash) },
    {
      label: t('Copy'),
      icon: 'copy',
      items: [
        { label: t('Full hash'), icon: 'copy', hint: short, onClick: () => copy(c.hash) },
        { label: t('Short hash'), icon: 'copy', onClick: () => copy(short) },
        { label: t('Message'), icon: 'copy', onClick: () => copy(c.message || c.subject || '') },
        { label: t('Subject'), icon: 'copy', onClick: () => copy((c.subject || c.message || '').split('\n')[0]) },
        c.author && { label: t('Author'), icon: 'copy', onClick: () => copy(c.email ? `${c.author} <${c.email}>` : c.author) },
        date && { label: t('Date'), icon: 'copy', onClick: () => copy(date) },
        ...branches.map((b) => ({ label: t('Branch name {branch}', { branch: b }), icon: 'copy', onClick: () => copy(b) })),
        ...tags.map((tg) => ({ label: t('Tag name {tag}', { tag: tg }), icon: 'copy', onClick: () => copy(tg) }))
      ]
    },
    {
      label: t('More'),
      icon: 'more',
      items: [
        !isHead && { label: t('Interactive rebase from here…'), icon: 'layers', onClick: () => interactiveRebase(c.hash) },
        isHead && { label: t('Reword message…'), icon: 'edit', onClick: () => rewordLast(c) },
        !isHead && { label: t('Squash later commits into one…'), icon: 'layers', onClick: () => squashSince(c.hash) },
        { label: t('Create fixup! commit of staged changes'), icon: 'commit', disabled: !staged, onClick: () => run('fixupCommit', { hash: c.hash, kind: 'fixup' }, { success: t('fixup! commit for {hash}', { hash: short }) }) },
        !isHead && { label: t('Cherry-pick without committing'), icon: 'commit', onClick: () => run('cherryPick', { hash: c.hash, mainline: isMerge, noCommit: true }, { success: t('Changes applied; review and commit') }) },
        { label: t('Revert without committing'), icon: 'undo', onClick: () => run('revert', { hash: c.hash, mainline: isMerge, noCommit: true }, { success: t('Undo applied; review and commit') }) },
        '-',
        { label: t('Browse files at this commit'), icon: 'folder', onClick: () => treeSheet(c.hash) },
        { label: t('Save as patch…'), icon: 'download', onClick: () => savePatch(c) },
        bis
          ? { label: t('Bisect'), icon: 'search', items: [
              { label: t('Mark good'), icon: 'check', onClick: () => run('bisect', { action: 'good', rev: c.hash }, { success: t('Marked good') }) },
              { label: t('Mark bad'), icon: 'x', onClick: () => run('bisect', { action: 'bad', rev: c.hash }, { success: t('Marked bad') }) },
              { label: t('Skip'), icon: 'right', onClick: () => run('bisect', { action: 'skip', rev: c.hash }, { success: t('Skipped') }) },
              { label: t('Stop bisect'), icon: 'x', onClick: () => run('bisect', { action: 'reset' }, { success: t('Bisect stopped') }) }
            ] }
          : { label: t('Start bisect (this is good, HEAD is bad)'), icon: 'search', onClick: () => startBisect(c.hash) }
      ]
    }
  ])
}
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    toast(t('Copied'))
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text)
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    toast(t('Copied'))
  }
}

/* =========================================================================
   Branches
   ========================================================================= */
/**
 * Check out origin/x when a local x already exists. Same commit: just switch. Only behind: switch
 * and fast-forward, so you land on the remote's commit. Diverged or ahead: let the person choose.
 */
async function checkoutRemoteOverLocal(remote, local) {
  let ab
  try {
    ab = await call('aheadBehind', { a: local, b: remote }) // ahead = only in local, behind = only in remote
  } catch (e) {
    return toast(e.message, 'error')
  }
  const afterSwitch = async (fn) => {
    const ok = await checkout(local, { resolved: true, quietJump: true })
    if (ok !== true) return // the switch failed or was cancelled: change nothing else
    if (fn) await fn()
    state.history.stale = true
    await refreshAll()
    if (state.tab === 'history') setTimeout(goToHead, 120)
  }
  if (!ab.behind) return afterSwitch() // local already has everything the remote has
  if (!ab.ahead) return afterSwitch(() => run('merge', { ref: remote, ffOnly: true }, { success: t('{local} is now at {remote}', { local, remote }), refresh: false }))
  const r = await dialog({
    title: t('Check out {remote}', { remote }),
    message: ab.ahead > 1 ? t('Your local {local} already exists and has gone its own way: {ahead} commits only on {local}, {behind} only on {remote}.', { local, ahead: ab.ahead, behind: ab.behind, remote }) : t('Your local {local} already exists and has gone its own way: {ahead} commit only on {local}, {behind} only on {remote}.', { local, ahead: ab.ahead, behind: ab.behind, remote }),
    fields: [
      {
        key: 'how',
        label: t('What should happen to your local branch?'),
        type: 'select',
        value: 'merge',
        options: [
          ['merge', t('Merge {remote} into {local} (keeps both)', { remote, local })],
          ['rebase', t('Rebase {local} onto {remote} (your {n} commits on top)', { local, remote, n: ab.ahead })],
          ['reset', t('Reset {local} to {remote} (drops your {n} local commits)', { local, remote, n: ab.ahead })],
          ['detach', t('Just look at {remote} (detached, {local} unchanged)', { remote, local })],
          ['local', t('Switch to {local} as it is', { local })]
        ]
      }
    ],
    ok: t('Check out')
  })
  if (!r) return
  if (r.how === 'detach') return checkout(remote, { detach: true, resolved: true })
  if (r.how === 'local') return checkout(local, { resolved: true })
  if (r.how === 'reset' && !(await confirmBox(ab.ahead > 1 ? t('Drop {n} local commits?', { n: ab.ahead }) : t('Drop {n} local commit?', { n: ab.ahead }), t('{local} will point at {remote}. The dropped commits stay in the Reflog tab for a while if you need them back.', { local, remote }), t('Reset'), true))) return
  const after = {
    merge: () => run('merge', { ref: remote }, { success: t('Merged {remote} into {local}', { remote, local }), refresh: false }),
    rebase: () => run('rebase', { onto: remote }, { success: t('Rebased {local} onto {remote}', { local, remote }), refresh: false }),
    reset: () => run('reset', { hash: remote, mode: 'keep' }, { success: t('{local} now matches {remote}', { local, remote }), refresh: false })
  }[r.how]
  return afterSwitch(after)
}

/**
 * Switch branch. The two usual failures get a choice instead of an error: changes in the way
 * (stash & switch, or discard & switch) and a branch already checked out in another worktree.
 */
/**
 * Git Extensions' "local changes" choice before a checkout: keep, stash, merge or reset.
 * Resolves { mode, clean } or null (cancelled). "Remember" stores the choice (never for reset).
 */
function checkoutChangesDialog(label, count, { collided = false } = {}) {
  closeOverlays()
  return new Promise((resolve) => {
    const options = [
      ['keep', t("Don't change"), t('Take the changes along. If they collide with the other branch you are asked again.')],
      ['stash', t('Stash'), t('Put them aside, switch, then bring them back.')],
      ['merge', t('Merge'), t('Merge them into the other branch (may leave conflicts to resolve).')],
      ['reset', t('Reset'), t('Discard them. This cannot be undone.')]
    ]
    if (collided) options.shift() // "Don't change" is what just failed
    let mode = collided ? 'stash' : 'keep'
    const clean = h('input', { type: 'checkbox' })
    const remember = h('input', { type: 'checkbox' })
    const cleanRow = h('label', { class: 'check co-clean hidden' }, clean, t('Also delete untracked files'))
    const rows = options.map(([v, title, desc]) => {
      const radio = h('input', { type: 'radio', name: 'co-mode', value: v, checked: v === mode, onChange: () => pick(v) })
      return h('label', { class: `co-option ${v === 'reset' ? 'danger' : ''}`, 'data-mode': v }, radio, h('div', null, h('div', { class: 'co-title' }, title), h('div', { class: 'dim' }, desc)))
    })
    const ok = h('button', { type: 'submit', class: 'btn primary' }, t('Checkout {label}', { label }))
    function pick(v) {
      mode = v
      rows.forEach((r) => r.classList.toggle('on', r.dataset.mode === v))
      cleanRow.classList.toggle('hidden', v !== 'reset')
      remember.disabled = v === 'reset'
      if (v === 'reset') remember.checked = false
      ok.className = `btn ${v === 'reset' ? 'danger solid' : 'primary'}`
      ok.textContent = v === 'reset' ? t('Reset & checkout {label}', { label }) : t('Checkout {label}', { label })
    }
    let closed = false
    const done = (val) => {
      if (closed) return
      closed = true
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      resolve(val)
    }
    const onKey = (e) => e.key === 'Escape' && isTopOverlay(overlay) && done(null)
    const form = h(
      'form',
      {
        class: 'dialog co-dialog',
        onSubmit: (e) => {
          e.preventDefault()
          const val = { mode, clean: clean.checked }
          if (remember.checked && mode !== 'reset') store.set('checkoutChanges', val)
          done(val)
        }
      },
      h('h3', null, t('Checkout {label}', { label })),
      h('p', null, collided ? t('Your uncommitted changes would be overwritten by {label}. What should happen to them?', { label }) : count > 1 ? t('You have {count} uncommitted changes. What should happen to them?', { count }) : t('You have {count} uncommitted change. What should happen to it?', { count })),
      h('div', { class: 'co-options' }, rows),
      cleanRow,
      h('label', { class: 'check' }, remember, t('Remember my choice (change it in Settings)')),
      h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'btn', onClick: () => done(null) }, t('Cancel')), ok)
    )
    pick(mode)
    const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && done(null) }, form)
    mountOverlay(overlay, () => done(null))
    document.addEventListener('keydown', onKey)
    ok.focus()
  })
}

async function checkout(name, opts = {}) {
  closeOverlays()
  // origin/x while a local x exists at another commit: ask what to do, as Git Extensions does.
  if (opts.track && !opts.resolved) {
    const local = name.replace(/^[^/]+\//, '')
    const refs = state.refs || (await call('refs').catch(() => null))
    if (refs?.local.some((b) => b.name === local)) return checkoutRemoteOverLocal(name, local)
  }
  const label = opts.track ? name.replace(/^[^/]+\//, '') : name
  // Uncommitted changes: ask first what to do with them, as Git Extensions does.
  const dirty = state.status?.files?.length || 0
  if (dirty && !opts.stash && !opts.merge && !opts.discard && !opts.keep) {
    const how = store.get('checkoutChanges', null) || (await checkoutChangesDialog(label, dirty))
    if (!how) return
    const flags = { keep: how.mode === 'keep', stash: how.mode === 'stash', merge: how.mode === 'merge', discard: how.mode === 'reset', clean: how.mode === 'reset' && how.clean }
    return checkout(name, { ...opts, ...flags })
  }
  setBusy(1)
  let out
  try {
    const { keep, ...rest } = opts
    out = await call('checkout', { ref: name, ...rest })
  } catch (e) {
    setBusy(-1)
    const inUse = e.message.match(/checked out in another worktree:\s*(.+)$/)
    if (inUse) {
      const where = inUse[1].trim()
      const r = await dialog({
        title: t('{label} is open in another worktree', { label }),
        message: `${where}

${t('A branch can be checked out in only one worktree at a time.')}`,
        ok: t('Open that worktree'),
        cancel: t('Cancel')
      })
      if (r) {
        const opened = await request('worktree.open', { path: where }).catch(() => null)
        if (!opened?.opened) pinRepo(where)
      }
      return
    }
    if (/changes that this checkout would overwrite/.test(e.message)) {
      // "Don't change" collided with the other branch: ask again, without that option
      const r = await checkoutChangesDialog(label, state.status?.files?.length || 1, { collided: true })
      if (!r) return
      return checkout(name, { ...opts, keep: false, stash: r.mode === 'stash', merge: r.mode === 'merge', discard: r.mode === 'reset', clean: r.mode === 'reset' && r.clean })
    }
    toast(e.message, 'error')
    await refreshAll()
    return false
  }
  setBusy(-1)
  const loc = out?.local
  const shown = loc?.name || label
  if (out?.stashKept) toast(out.stashMessage || t('Switched to {branch}. Your changes did not apply cleanly, so they are kept in the stash.', { branch: shown }), 'error', 9000)
  else toast(out?.stashed ? t('Switched to {branch} with your changes', { branch: shown }) : t('Switched to {branch}', { branch: shown }))
  // origin/x checked out while a local x exists: we switched to the local one; offer to catch it up.
  if (loc && loc.behind > 0 && loc.ahead === 0) {
    if (await confirmBox(t('Update {branch}?', { branch: loc.name }), loc.behind > 1 ? t('Your local {branch} is {n} commits behind {remote}. Fast-forward it?', { branch: loc.name, n: loc.behind, remote: loc.remote }) : t('Your local {branch} is {n} commit behind {remote}. Fast-forward it?', { branch: loc.name, n: loc.behind, remote: loc.remote }), t('Fast-forward')))
      await run('merge', { ref: loc.remote, ffOnly: true }, { success: t('{branch} is up to date with {remote}', { branch: loc.name, remote: loc.remote }) })
  } else if (loc && loc.behind > 0)
    toast(t('Local {branch} and {remote} have diverged ({ahead} ahead, {behind} behind). Merge or rebase when you are ready.', { branch: loc.name, remote: loc.remote, ahead: loc.ahead, behind: loc.behind }), 'ok', 8000)
  if (opts.quietJump) return true
  state.history.stale = true
  await refreshAll()
  // show where you are now, even when that commit is far down the graph
  if (state.tab === 'history') setTimeout(goToHead, 120)
  return true
}
async function checkoutCommit(hash) {
  if (!(await confirmBox(t('Checkout commit?'), t('HEAD will be detached at {hash}. Create a branch if you want to keep new commits.', { hash: hash.slice(0, 7) }), t('Checkout')))) return
  closeSheet()
  checkout(hash, { detach: true })
}
async function newBranch(start) {
  const r = await dialog({
    title: t('New branch'),
    fields: [
      { key: 'name', label: t('Branch name'), placeholder: 'feature/my-change' },
      { key: 'start', label: t('Start from'), value: start || '', placeholder: 'HEAD' },
      { key: 'checkout', label: t('Switch to it'), type: 'check', value: true }
    ],
    ok: t('Create')
  })
  if (!r?.name.trim()) return
  if (state.sheets.length) closeSheet()
  resetHistory()
  run('branchCreate', { name: r.name.trim(), start: r.start.trim() || undefined, checkout: r.checkout }, { success: t('Created {branch}', { branch: r.name.trim() }) })
}
async function mergeRef(ref) {
  const cur = state.status?.branch || 'HEAD'
  const name = /^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 7) : ref
  const r = await dialog({
    title: t('Merge {name} → {branch}', { name, branch: cur }),
    message: t('Brings the changes of {name} into {branch}, the branch you are on. If both changed the same lines, you pick what to keep, side by side.', { name, branch: cur }),
    fields: [
      {
        key: 'mode',
        label: t('How'),
        type: 'select',
        value: 'default',
        options: [
          ['default', t('Merge (fast-forward when possible)')],
          ['noFf', t('Always create a merge commit')],
          ['ffOnly', t('Fast-forward only')],
          ['squash', t('Squash into one change (you commit it)')]
        ]
      },
      { key: 'ai', label: t('Let AI resolve conflicts instead'), type: 'check', value: false }
    ],
    ok: t('Merge')
  })
  if (!r) return
  if (state.sheets.length) closeSheet()
  resetHistory()
  const out = await run('merge', { ref, [r.mode]: r.mode !== 'default' }, { success: r.mode === 'squash' ? t('Squashed; review and commit') : t('Merged {name} into {branch}', { name, branch: cur }) })
  if (out === undefined && state.status?.files.some((f) => f.conflict)) r.ai ? resolveWithAi() : openConflicts()
}
async function rebaseOnto(ref) {
  const cur = state.status?.branch || 'HEAD'
  if (!(await confirmBox(t('Rebase {branch} onto {ref}?', { branch: cur, ref }), t('Your commits will be replayed on top of it. Avoid this on branches others already pulled.'), t('Rebase')))) return
  resetHistory()
  const out = await run('rebase', { onto: ref }, { success: t('Rebased') })
  if (out === undefined && state.status?.files.some((f) => f.conflict) && true) openConflicts()
}
async function newTag(hash) {
  const r = await dialog({
    title: t('Create tag'),
    fields: [
      { key: 'name', label: t('Tag name'), placeholder: 'v1.0.0' },
      { key: 'message', label: t('Message (optional, makes an annotated tag)'), type: 'textarea' },
      { key: 'push', label: t('Push the tag to the remote'), type: 'check', value: store.get('tagPush', false) }
    ],
    ok: t('Create')
  })
  if (!r?.name.trim()) return
  const name = r.name.trim()
  store.set('tagPush', !!r.push)
  resetHistory()
  const made = await run('tagCreate', { name, message: r.message.trim() || undefined, hash }, { success: r.push ? undefined : t('Tagged {name}', { name }), refresh: !r.push })
  if (made !== undefined && r.push) run('tagPush', { name }, { success: t('Tagged and pushed {name}', { name }) })
}

async function viewBranches() {
  const r = await call('refs')
  const root = h('div', { class: 'view', style: { paddingTop: '8px' } })
  const filter = h('input', { type: 'text', placeholder: t('Filter branches and tags…'), value: state.branchFilter || '' })
  filter.value = state.branchFilter || ''
  const listWrap = h('div')
  root.append(h('div', { class: 'history-bar' }, filter, iconBtn('plus', t('New branch'), () => newBranch())))
  root.append(listWrap)
  const draw = () => {
    const q = (state.branchFilter || '').toLowerCase()
    const m = (x) => !q || x.name.toLowerCase().includes(q)
    clear(listWrap)
    const local = r.local.filter(m)
    listWrap.append(h('div', { class: 'section-head' }, t('Local'), h('span', { class: 'count' }, local.length)))
    for (const b of local) listWrap.append(localBranchRow(b))
    const remote = r.remote.filter(m)
    if (remote.length) {
      listWrap.append(h('div', { class: 'section-head' }, t('Remote'), h('span', { class: 'count' }, remote.length)))
      for (const b of remote) listWrap.append(remoteBranchRow(b, r.local))
    }
    const tags = r.tags.filter(m)
    if (tags.length) {
      listWrap.append(h('div', { class: 'section-head' }, t('Tags'), h('span', { class: 'count' }, tags.length)))
      for (const t of tags) listWrap.append(tagRow(t))
    }
  }
  filter.addEventListener('input', () => {
    state.branchFilter = filter.value
    draw()
  })
  draw()
  return root
}

function trackInfo(b) {
  if (b.gone) return h('span', { class: 'pill', title: t('Upstream was deleted') }, t('gone'))
  if (!b.upstream) return null
  if (!b.ahead && !b.behind) return null
  const div = b.ahead && b.behind
  const why = div
    ? t('{ahead} to push and {behind} to pull: {branch} and {upstream} have gone separate ways. Pull (merge or rebase) before pushing', { ahead: b.ahead, behind: b.behind, branch: b.name, upstream: b.upstream })
    : b.ahead
      ? b.ahead > 1 ? t('{n} commits to push to {upstream}', { n: b.ahead, upstream: b.upstream }) : t('{n} commit to push to {upstream}', { n: b.ahead, upstream: b.upstream })
      : b.behind > 1 ? t('{n} commits to pull from {upstream}', { n: b.behind, upstream: b.upstream }) : t('{n} commit to pull from {upstream}', { n: b.behind, upstream: b.upstream })
  return h(
    'span',
    { class: `sync-ab mono ${div ? 'diverged' : ''}`, title: why },
    b.ahead > 0 && h('span', { class: 'ab-up' }, `↑${b.ahead}`),
    b.behind > 0 && h('span', { class: 'ab-down' }, `↓${b.behind}`)
  )
}

function localBranchRow(b) {
  const b0 = b
  return h(
    'div',
    { class: `item ${b.current ? 'current' : ''}`, draggable: 'true', 'data-drag-ref': b.name, 'data-drag-kind': 'branch', 'data-drop-ref': b.name, 'data-drop-kind': 'branch', title: `${b.name}${b.upstream ? ` → ${b.upstream}` : ''}\n${b.subject}\n${t('Drag onto another branch to merge or rebase')}`, onDblclick: () => !b.current && checkout(b.name) },
    b.current ? icon('check', 13) : icon('branch', 13),
    h('span', { class: 'grow ellipsis' }, b.name),
    h('span', { class: 'meta-right row' }, trackInfo(b), h('span', { class: 'dim', style: { fontSize: '11px' } }, ago(b.date))),
    h(
      'div',
      { class: 'hover-actions', onClick: (e) => e.stopPropagation() },
      !b.current && iconBtn('right', t('Checkout'), () => checkout(b.name)),
      iconBtn('more', t('More'), (e) => branchMenu(e.currentTarget))
    )
  )
  // Built when it opens: the checked-out branch may have changed since this row was drawn.
  function branchMenu(anchor) {
    const cur = state.status?.branch
    const b = { ...b0, current: b0.name === cur }
    return menu(anchor, [
          !b.current && { label: t('Checkout'), icon: 'right', onClick: () => checkout(b.name) },
          !b.current && cur && { label: mergeLabel(b.name, cur), full: t('Merge {name} → {branch}', { name: b.name, branch: cur }), icon: 'merge', onClick: () => mergeRef(b.name) },
          ...(!b.current ? withAiReview(mrBoth(b.name, cur)) : []),
          !b.current && cur && { label: t('Rebase {branch} onto this', { branch: cur }), icon: 'merge', onClick: () => rebaseOnto(b.name) },
          { label: t('New branch from here…'), icon: 'plus', onClick: () => newBranch(b.name) },
          { label: t('New worktree…'), icon: 'worktree', onClick: () => addWorktree({ branch: b.name }) },
          { label: t('Show history'), icon: 'history', onClick: () => showBranchLog(b.name) },
          !b.current && { label: t('Compare with {ref}', { ref: cur || 'HEAD' }), icon: 'compare', onClick: () => compareSheet(cur || 'HEAD', b.name) },
          '-',
          b.current && { label: t('Push'), icon: 'push', onClick: () => run('push', {}, { success: t('Pushed') }) },
          !b.current && { label: t('Push'), icon: 'push', onClick: () => run('push', { branch: b.name }, { success: t('Pushed {name}', { name: b.name }) }) },
          { label: t('Set upstream…'), icon: 'globe', onClick: () => setUpstream(b) },
          { label: t('Rename…'), icon: 'edit', onClick: () => renameBranch(b.name) },
          { label: t('Copy name'), icon: 'copy', onClick: () => copy(b.name) },
          !b.current && '-',
          !b.current && { label: t('Delete…'), icon: 'trash', danger: true, onClick: () => deleteBranch(b.name) }
        ])
  }
}
function remoteBranchRow(b, local) {
  const short = b.name.replace(/^[^/]+\//, '')
  const remote = b.name.split('/')[0]
  const hasLocal = local.some((l) => l.name === short)
  const curNow = () => state.status?.branch // read when the menu opens, not when the row was drawn
  return h(
    'div',
    { class: 'item', draggable: 'true', 'data-drag-ref': b.name, 'data-drag-kind': 'remote', 'data-drop-ref': b.name, 'data-drop-kind': 'remote', title: `${b.name}\n${b.subject}` },
    icon('globe', 13),
    h('span', { class: 'grow ellipsis' }, b.name),
    h('span', { class: 'meta-right dim', style: { fontSize: '11px' } }, ago(b.date)),
    h(
      'div',
      { class: 'hover-actions', onClick: (e) => e.stopPropagation() },
      iconBtn('more', t('More'), (e) => {
        const cur = curNow()
        return menu(e.currentTarget, [
          // Always go through the remote: when a local branch exists, checkout() asks how to bring it up to date.
          { label: hasLocal ? t('Checkout {name}…', { name: b.name }) : t('Checkout as {name}', { name: short }), icon: 'right', onClick: () => checkout(b.name, { track: true }) },
          cur && { label: mergeLabel(b.name, cur), full: t('Merge {name} → {branch}', { name: b.name, branch: cur }), icon: 'merge', onClick: () => mergeRef(b.name) },
          ...withAiReview(mrBoth(b.name.replace(/^[^/]+\//, ''), cur)),
          cur && { label: t('Rebase {branch} onto this', { branch: cur }), icon: 'merge', onClick: () => rebaseOnto(b.name) },
          { label: t('New branch from here…'), icon: 'plus', onClick: () => newBranch(b.name) },
          { label: t('New worktree…'), icon: 'worktree', onClick: () => addWorktree({ newBranch: short, base: b.name }) },
          { label: t('Show history'), icon: 'history', onClick: () => showBranchLog(b.name) },
          { label: t('Compare with {ref}', { ref: cur || 'HEAD' }), icon: 'compare', onClick: () => compareSheet(cur || 'HEAD', b.name) },
          '-',
          {
            label: t('Delete from {remote}…', { remote }),
            icon: 'trash',
            danger: true,
            onClick: async () =>
              (await confirmBox(t('Delete {name}?', { name: b.name }), t('The branch is removed from the remote "{remote}" for everyone.', { remote }), t('Delete'), true)) &&
              run('remoteBranchDelete', { remote, name: short }, { success: t('Deleted {name}', { name: b.name }) })
          }
        ])
      })
    )
  )
}
function tagRow(tag) {
  return h(
    'div',
    { class: 'item', draggable: 'true', 'data-drag-ref': tag.name, 'data-drag-kind': 'tag', title: `${tag.name}\n${tag.subject}` },
    icon('tag', 13),
    h('span', { class: 'grow ellipsis' }, tag.name),
    h('span', { class: 'meta-right dim mono' }, tag.hash),
    h(
      'div',
      { class: 'hover-actions', onClick: (e) => e.stopPropagation() },
      iconBtn('more', t('More'), (e) =>
        menu(e.currentTarget, [
          { label: t('Checkout (detached)'), icon: 'right', onClick: () => checkout(tag.name, { detach: true }) },
          { label: t('New branch from tag…'), icon: 'plus', onClick: () => newBranch(tag.name) },
          state.status?.branch && { label: mergeLabel(tag.name, state.status.branch), full: t('Merge tag {name} → {branch}', { name: tag.name, branch: state.status.branch }), icon: 'merge', onClick: () => mergeRef(tag.name) },
          { label: t('Push tag'), icon: 'push', onClick: () => run('tagPush', { name: tag.name }, { success: t('Pushed {name}', { name: tag.name }) }) },
          '-',
          { label: t('Delete (local)…'), icon: 'trash', danger: true, onClick: async () => (await confirmBox(t('Delete tag {name}?', { name: tag.name }), t('Only the local tag is deleted.'), t('Delete'), true)) && run('tagDelete', { name: tag.name }) }
        ])
      )
    )
  )
}
async function showBranchLog(ref) {
  openSheet(t('History · {ref}', { ref }), h('div', { class: 'empty' }, t('Loading…')))
  let commits
  try {
    commits = await call('log', { ref, limit: 200 })
  } catch (e) {
    closeSheet()
    return toast(e.message, 'error')
  }
  const rows = layoutGraph(commits)
  const width = graphWidth(rows) + 4
  const list = h('div')
  commits.forEach((c, i) =>
    list.append(
      h(
        'div',
        { class: 'commit-row', onClick: () => openCommit(c.hash), onContextmenu: (e) => commitContextMenu(e, c) },
        graphSvg(rows[i], width, c.parents.length > 1, c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> '))),
        h(
          'div',
          { class: 'commit-text' },
          h('div', { class: 'commit-subject' }, refPills(c.refs, rows && rows[i] ? rows[i].color : null), h('span', { class: 's' }, c.subject)),
          h('div', { class: 'commit-meta' }, `${c.author} · ${ago(c.time)} · ${c.hash.slice(0, 7)}`)
        )
      )
    )
  )
  clear(state.sheets[state.sheets.length - 1].el.querySelector('.sheet-body')).append(list)
}
async function renameBranch(from) {
  const r = await dialog({ title: t('Rename branch'), fields: [{ key: 'to', label: t('New name'), value: from }], ok: t('Rename') })
  if (!r?.to.trim() || r.to.trim() === from) return
  run('branchRename', { from, to: r.to.trim() }, { success: t('Renamed') })
}
async function deleteBranch(name) {
  const r = await dialog({
    title: t('Delete {name}?', { name }),
    fields: [{ key: 'force', label: t('Force delete even if not merged'), type: 'check', value: false }],
    ok: t('Delete'),
    danger: true
  })
  if (!r) return
  run('branchDelete', { name, force: r.force }, { success: t('Deleted {name}', { name }) })
}
async function setUpstream(b) {
  const r = await dialog({ title: t('Upstream for {branch}', { branch: b.name }), fields: [{ key: 'up', label: t('Remote branch'), value: b.upstream || `origin/${b.name}` }], ok: t('Set') })
  if (!r?.up.trim()) return
  run('setUpstream', { branch: b.name, upstream: r.up.trim() }, { success: t('Upstream set') })
}

/* =========================================================================
   Worktrees
   ========================================================================= */
async function addWorktree(pre = {}) {
  let refsList = { local: [], remote: [] }
  try {
    refsList = await call('refs')
  } catch {}
  const top = state.status?.toplevel || state.repo
  const parent = top.replace(/[\\/][^\\/]+[\\/]?$/, '')
  const repoName = basename(top)
  const sep = top.includes('\\') ? '\\' : '/'
  const existing = !!pre.branch
  const r = await dialog({
    title: t('New worktree'),
    message: t('A worktree is a second checkout of this repository in its own folder, on its own branch.'),
    fields: [
      {
        key: 'mode',
        label: t('Branch'),
        type: 'select',
        value: existing ? 'existing' : 'new',
        options: [
          ['new', t('Create a new branch')],
          ['existing', t('Use an existing branch')],
          ['detach', t('Detached at a commit')]
        ]
      },
      { key: 'name', label: t('Branch name (new) or existing branch / commit'), value: pre.branch || pre.newBranch || '', placeholder: 'feature/x' },
      {
        key: 'base',
        label: t('Base for a new branch'),
        type: 'select',
        value: pre.base || state.status?.branch || 'HEAD',
        options: [['HEAD', t('HEAD (current)')], ...refsList.local.map((b) => [b.name, b.name]), ...refsList.remote.map((b) => [b.name, b.name])]
      },
      { key: 'path', label: t('Folder'), value: '', placeholder: `${parent}${sep}${repoName}-<branch>`, hint: t('Leave empty to use the placeholder path.') }
    ],
    ok: t('Create worktree')
  })
  if (!r?.name.trim()) return
  const name = r.name.trim()
  const p = r.path.trim() || `${parent}${sep}${repoName}-${name.replace(/[\\/:*?"<>|\s]+/g, '-')}`
  const args = { path: p }
  if (r.mode === 'new') Object.assign(args, { newBranch: name, base: r.base === 'HEAD' ? undefined : r.base })
  else if (r.mode === 'existing') args.branch = name
  else Object.assign(args, { detach: true, branch: name })
  const out = await run('worktreeAdd', args, { success: t('Worktree created at {path}', { path: p }) })
  if (out !== undefined && state.tab !== 'worktrees') setTab('worktrees')
}

async function viewWorktrees() {
  const list = await call('worktrees')
  const root = h('div', { class: 'view' })
  root.append(
    h('p', { class: 'dim tab-intro' }, t('A worktree is another folder with another branch checked out, from the same repository: work on two branches at once without stashing.')),
    h(
      'div',
      { class: 'section-head' },
      t('Worktrees'),
      h('span', { class: 'count' }, list.length),
      h('div', { class: 'actions' }, iconBtn('trash', t('Prune stale worktrees'), async () => (await confirmBox(t('Prune stale worktrees?'), t('Removes the records of worktrees whose folders no longer exist. Worktrees on disk are not touched.'), t('Prune'))) && run('worktreePrune', {}, { success: t('Pruned') })), iconBtn('plus', t('New worktree'), () => addWorktree()))
    )
  )
  for (const w of list) {
    const name = w.bare ? t('(bare)') : w.branch || t('detached @ {hash}', { hash: (w.head || '').slice(0, 7) })
    root.append(
      h(
        'div',
        { class: 'card', 'data-wt': w.path },
        h(
          'div',
          { class: 'row' },
          icon(w.branch ? 'branch' : 'commit', 13),
          h('strong', { class: 'grow ellipsis', title: name }, name),
          w.current && h('span', { class: 'pill on' }, t('here')),
          w.main && h('span', { class: 'pill' }, t('main')),
          w.locked && h('span', { class: 'pill', title: typeof w.locked === 'string' ? w.locked : '' }, t('locked')),
          w.prunable && h('span', { class: 'pill', title: typeof w.prunable === 'string' ? w.prunable : '' }, t('missing'))
        ),
        h('div', { class: 'wt-path' }, w.path),
        h(
          'div',
          { class: 'row' },
          !w.current &&
            h(
              'button',
              {
                class: 'btn sm',
                title: t('Switch Orca to this worktree'),
                onClick: async () => {
                  const r = await request('worktree.open', { path: w.path }).catch((e) => (toast(e.message, 'error'), null))
                  if (r && !r.opened) toast(t('Orca does not list this worktree as a workspace. Use "View here" instead.'), 'error')
                }
              },
              icon('open', 12),
              t('Open in Orca')
            ),
          !w.current && h('button', { class: 'btn sm', title: t('Show this worktree in the panel without switching Orca'), onClick: () => pinRepo(w.path) }, icon('open', 12), t('View here')),
          h('span', { class: 'grow' }),
          !w.main &&
            iconBtn('more', t('More'), (e) =>
              menu(e.currentTarget, [
                { label: w.locked ? t('Unlock') : t('Lock'), icon: 'lock', onClick: () => run('worktreeLock', { path: w.path, unlock: !!w.locked }) },
                { label: t('Copy path'), icon: 'copy', onClick: () => copy(w.path) },
                '-',
                {
                  label: t('Remove…'),
                  icon: 'trash',
                  danger: true,
                  onClick: async (ev) => {
                    const r = await dialog({
                      title: w.prunable ? t('Remove missing worktree?') : t('Remove worktree?'),
                      message: w.prunable ? `${w.path}

${t('Git no longer finds this worktree. Its record is removed; any files left in the folder stay on disk.')}` : w.path,
                      fields: w.prunable
                        ? []
                        : [
                            { key: 'force', label: w.locked ? t('Force (it is locked, and discard its uncommitted changes)') : t('Force (discard its uncommitted changes)'), type: 'check', value: !!w.locked },
                            w.branch && { key: 'deleteBranch', label: t('Also delete branch {branch} (only if it is merged)', { branch: w.branch }), type: 'check', value: false },
                            w.branch && { key: 'forceBranch', label: t('Delete {branch} even if it has unmerged commits', { branch: w.branch }), type: 'check', value: false }
                          ].filter(Boolean),
                      ok: t('Remove'),
                      danger: true
                    })
                    if (!r) return
                    const card = document.querySelector(`[data-wt="${CSS.escape(w.path)}"]`)
                    card?.classList.add('leaving')
                    let out
                    setBusy(1)
                    try {
                      out = await call('worktreeRemove', { path: w.path, force: r.force, deleteBranch: r.deleteBranch || r.forceBranch, forceBranch: r.forceBranch })
                    } catch (err) {
                      // Uncommitted or untracked files: say so plainly and offer to remove it anyway.
                      if (!r.force && !/still lists/.test(err.message) && /modified|untracked|use --force/i.test(err.message)) {
                        setBusy(-1)
                        const yes = await confirmBox(t('This worktree has uncommitted changes'), `${w.path}

${t('Removing it deletes those changes. This cannot be undone.')}`, t('Remove anyway'), true)
                        setBusy(1) // balanced by finally
                        if (yes) out = await call('worktreeRemove', { path: w.path, force: true, deleteBranch: r.deleteBranch || r.forceBranch, forceBranch: r.forceBranch }).catch((e2) => (toast(e2.message, 'error'), undefined))
                      } else toast(err.message, 'error')
                    } finally {
                      setBusy(-1)
                    }
                    if (out === undefined) card?.classList.remove('leaving')
                    else if (out.alreadyGone) toast(t('That worktree was already removed. The list is up to date now.'))
                    else if (out.leftover) toast(`${t('Worktree removed from Git. Some files are left in the folder:')}
${w.path}`, 'ok', 7000)
                    else toast(t('Worktree removed'))
                    if (out?.branchKept) toast(t('Branch {branch} was kept: {reason}', { branch: w.branch, reason: out.branchKept }), 'error', 8000)
                    if (out !== undefined) await new Promise((res) => setTimeout(res, 180)) // let the card fold away
                    // always reload the list: on failure too, so an entry removed elsewhere disappears
                    await refreshAll()
                    if (state.tab === 'worktrees') renderView({ force: true })
                  }
                }
              ])
            )
        )
      )
    )
  }
  return root
}

/* =========================================================================
   Stash
   ========================================================================= */
async function viewStash() {
  const list = await call('stashList')
  const root = h('div', { class: 'view' })
  const msg = h('input', { type: 'text', placeholder: t('Stash message (optional)') })
  const untracked = h('input', { type: 'checkbox', checked: true })
  const keepIndex = h('input', { type: 'checkbox' })
  const dirty = state.status.files.length > 0
  root.append(
    h(
      'div',
      { class: 'form stash-form' },
      msg,
      h('div', { class: 'row', style: { gap: '12px' } }, h('label', { class: 'check' }, untracked, t('Include untracked')), h('label', { class: 'check' }, keepIndex, t('Keep staged'))),
      h(
        'button',
        {
          class: 'btn primary',
          disabled: !dirty,
          onClick: () => run('stashSave', { message: msg.value.trim(), untracked: untracked.checked, keepIndex: keepIndex.checked }, { success: t('Stashed') })
        },
        icon('stash', 13),
        dirty ? t('Stash changes') : t('Nothing to stash')
      )
    )
  )
  root.append(h('div', { class: 'section-head' }, t('Stashes'), h('span', { class: 'count' }, list.length)))
  if (!list.length) root.append(h('div', { class: 'empty' }, icon('stash', 26), h('div', null, t('No stashes')), h('div', { class: 'dim' }, t('Stash your changes to set them aside and come back later'))))
  for (const s of list) {
    root.append(
      h(
        'div',
        { class: 'item', title: s.subject, onClick: (e) => (root.querySelectorAll('.item.sel').forEach((x) => x.classList.remove('sel')), e.currentTarget.classList.add('sel'), showDiff(s.subject, () => call('stashShow', { ref: s.ref }), [iconBtn('check', t('Apply'), () => (closeSheet(), run('stashApply', { ref: s.ref }, { success: t('Applied') })))], undefined, { old: s.ref + '^1', new: s.ref })) },
        icon('stash', 13),
        h(
          'div',
          { class: 'grow', style: { minWidth: 0 } },
          h('div', { class: 'ellipsis', style: { color: 'var(--t1)' } }, s.subject.replace(/^(WIP on|On) [^:]+: /, '') || s.ref),
          h('div', { class: 'stash-meta' }, icon('branch', 10), (s.subject.match(/^(?:WIP on|On) ([^:]+):/) || [])[1] || '?', ` · ${ago(s.time)} · `, h('span', { class: 'mono' }, s.ref))
        ),
        h(
          'div',
          { class: 'stash-actions', onClick: (e) => e.stopPropagation() },
          h('button', { class: 'btn sm', title: t('Apply and keep the stash'), onClick: () => run('stashApply', { ref: s.ref }, { success: t('Applied') }) }, icon('check', 12), t('Apply')),
          h('button', { class: 'btn sm', title: t('Apply and remove the stash'), onClick: () => run('stashPop', { ref: s.ref }, { success: t('Popped') }) }, icon('pull', 12), t('Pop')),
          iconBtn('trash', t('Drop'), async () => (await confirmBox(t('Drop stash?'), s.subject, t('Drop'), true)) && run('stashDrop', { ref: s.ref }, { success: t('Dropped') }))
        )
      )
    )
  }
  return IN_TAB ? splitWrap(root, t('Select a stash to see its changes')) : root
}

/* =========================================================================
   Settings: git config (global / repository) + remotes
   ========================================================================= */
const COMMON = [
  { group: t('Identity') },
  { key: 'user.name', label: t('Name'), placeholder: 'Jane Doe' },
  { key: 'user.email', label: t('Email'), placeholder: 'jane@example.com' },
  { group: t('Behavior') },
  {
    key: 'pull.rebase',
    label: t('Pull strategy'),
    options: [
      ['', t('Not set (merge)')],
      ['false', t('Merge')],
      ['true', t('Rebase')],
      ['merges', t('Rebase, keep merges')]
    ]
  },
  {
    key: 'core.autocrlf',
    label: t('Line endings (core.autocrlf)'),
    options: [
      ['', t('Not set')],
      ['true', t('true (Windows: CRLF ↔ LF)')],
      ['input', t('input (convert to LF on commit)')],
      ['false', t('false (no conversion)')]
    ]
  },
  { key: 'init.defaultBranch', label: t('Default branch for new repos'), placeholder: 'main', globalOnly: true },
  {
    key: 'push.autoSetupRemote',
    label: t('Auto set upstream on first push'),
    options: [
      ['', t('Not set')],
      ['true', t('Yes')],
      ['false', t('No')]
    ]
  },
  {
    key: 'fetch.prune',
    label: t('Prune deleted remote branches on fetch'),
    options: [
      ['', t('Not set')],
      ['true', t('Yes')],
      ['false', t('No')]
    ]
  },
  {
    key: 'commit.gpgsign',
    label: t('Sign commits'),
    options: [
      ['', t('Not set')],
      ['true', t('Yes')],
      ['false', t('No')]
    ]
  },
  { key: 'core.editor', label: t('Editor'), placeholder: 'code --wait' },
  { group: t('HTTPS & credentials') },
  {
    key: 'credential.helper',
    label: t('Credential helper (remembers your HTTPS login)'),
    options: [
      ['', t('Not set')],
      ['manager', t('manager (Git Credential Manager, recommended)')],
      ['store', t('store (plain-text file)')],
      ['cache', t('cache (in memory for a while)')]
    ]
  },
  {
    key: 'http.sslVerify',
    label: t('Verify HTTPS certificates'),
    options: [
      ['', t('Not set (yes)')],
      ['true', t('Yes')],
      ['false', t('No (only for self-signed servers you trust)')]
    ]
  },
  {
    key: 'http.sslBackend',
    label: t('TLS backend'),
    options: [
      ['', t('Not set')],
      ['schannel', t('schannel (Windows certificate store)')],
      ['openssl', 'openssl']
    ]
  },
  { key: 'http.proxy', label: t('HTTP proxy'), placeholder: 'http://proxy.example.com:8080' },
  { key: 'https.proxy', label: t('HTTPS proxy'), placeholder: 'http://proxy.example.com:8080' },
  { key: 'http.sslCAInfo', label: t('Custom CA certificate file'), placeholder: 'C:\\certs\\company-ca.pem' },
  { key: 'http.postBuffer', label: t('Upload buffer (bytes, for large pushes)'), placeholder: '524288000' }
]

/**
 * Saved identities (name + email, optionally a signing key): pick one for this repository or make
 * it the global one, instead of typing them again. Kept in the plugin's own storage.
 */
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
async function identityProfiles() {
  const [g, l] = await Promise.all([call('configList', { scope: 'global' }).catch(() => []), state.repo ? call('configList', { scope: 'local' }).catch(() => []) : []])
  const get = (list, k) => list.find((e) => e.key.toLowerCase() === k)?.value || ''
  const cur = {
    global: { name: get(g, 'user.name'), email: get(g, 'user.email') },
    local: { name: get(l, 'user.name'), email: get(l, 'user.email') }
  }
  let list = store.get('identityProfiles', [])
  // first run: offer what is set already as profiles
  if (!list.length) {
    for (const c of [cur.global, cur.local]) if (c.name && c.email && !list.some((p) => p.email === c.email && p.name === c.name)) list.push({ id: newId(), label: '', ...c })
    if (list.length) store.set('identityProfiles', list)
  }
  const save = (next) => (store.set('identityProfiles', next), renderView({ force: true }))
  const same = (p, c) => p.name === c.name && p.email === c.email
  const effective = cur.local.name || cur.local.email ? cur.local : cur.global

  async function apply(p, scope) {
    setBusy(1)
    try {
      await call('configSet', { scope, key: 'user.name', value: p.name })
      await call('configSet', { scope, key: 'user.email', value: p.email })
      if (p.signingKey) await call('configSet', { scope, key: 'user.signingkey', value: p.signingKey })
      toast(scope === 'global' ? t('{name} is now your global identity', { name: p.label || p.name }) : t('This repository now commits as {name}', { name: p.label || p.name }))
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(-1)
      renderView({ force: true })
    }
  }
  async function useGlobalHere() {
    setBusy(1)
    try {
      await call('configUnset', { scope: 'local', key: 'user.name' }).catch(() => {})
      await call('configUnset', { scope: 'local', key: 'user.email' }).catch(() => {})
      toast(t('This repository uses the global identity again'))
    } finally {
      setBusy(-1)
      renderView({ force: true })
    }
  }
  async function edit(p) {
    const r = await dialog({
      title: p ? t('Edit profile') : t('New profile'),
      fields: [
        { key: 'label', label: t('Profile name (optional)'), value: p?.label || '', placeholder: t('Work, Personal, Client…') },
        { key: 'name', label: t('Name (user.name)'), value: p?.name || '' },
        { key: 'email', label: t('Email (user.email)'), value: p?.email || '' },
        { key: 'signingKey', label: t('Signing key (optional, user.signingkey)'), value: p?.signingKey || '' }
      ],
      ok: t('Save')
    })
    if (!r) return
    if (!r.name.trim() || !/^[^\s@]+@[^\s@]+$/.test(r.email.trim())) return toast(t('A name and a valid email are needed'), 'error')
    const item = { id: p?.id || newId(), label: r.label.trim(), name: r.name.trim(), email: r.email.trim(), signingKey: r.signingKey.trim() || undefined }
    save(p ? list.map((x) => (x.id === p.id ? item : x)) : [...list, item])
  }

  const card = (p) => {
    const isGlobal = same(p, cur.global)
    const isLocal = same(p, cur.local)
    const inUse = same(p, effective)
    return h(
      'div',
      { class: `idp ${inUse ? 'on' : ''}` },
      h('span', { class: 'idp-av' }, (p.label || p.name || '?')[0].toUpperCase()),
      h(
        'div',
        { class: 'idp-main' },
        h('div', { class: 'idp-title' }, h('b', null, p.label || p.name), p.label && h('span', { class: 'dim' }, p.name), isGlobal && h('span', { class: 'pill idp-global' }, t('Global')), isLocal && h('span', { class: 'pill idp-local' }, t('This repo')), inUse && state.repo && h('span', { class: 'pill idp-use' }, icon('check', 10), t('Commits use this'))),
        h('div', { class: 'dim mono idp-mail' }, p.email)
      ),
      h(
        'div',
        { class: 'idp-actions' },
        state.repo && !isLocal && h('button', { class: 'btn sm', title: t('Commit as this identity in this repository only'), onClick: () => apply(p, 'local') }, icon('check', 12), t('Use for this repo')),
        !isGlobal && h('button', { class: 'btn sm', title: t('Make this the identity for every repository'), onClick: () => apply(p, 'global') }, icon('globe', 12), t('Set global')),
        iconBtn('edit', t('Edit profile'), () => edit(p)),
        iconBtn('trash', t('Delete profile (Git settings stay as they are)'), async () => (await confirmBox(t('Delete profile {name}?', { name: p.label || p.name }), t('Only the saved profile is removed; your Git settings stay as they are.'), t('Delete'), true)) && save(list.filter((x) => x.id !== p.id)))
      )
    )
  }
  return h(
    'div',
    { class: 'idp-section' },
    h('div', { class: 'section-head' }, t('Identity profiles'), h('span', { class: 'count' }, list.length), h('div', { class: 'actions' }, iconBtn('plus', t('New profile'), () => edit(null)))),
    h(
      'div',
      { class: 'idp-now dim' },
      state.repo
        ? cur.local.name || cur.local.email
          ? [t('This repository commits as '), h('b', null, `${cur.local.name} <${cur.local.email}>`), t(' (its own setting). '), h('button', { class: 'link-btn', onClick: useGlobalHere }, t('Use the global identity instead'))] // i18n: sentence split around the identity
          : [t('This repository uses the global identity '), h('b', null, cur.global.name ? `${cur.global.name} <${cur.global.email}>` : t('(not set)')), t('.')]
        : [t('Global identity: '), h('b', null, cur.global.name ? `${cur.global.name} <${cur.global.email}>` : t('(not set)'))]
    ),
    list.length ? h('div', { class: 'idp-list' }, list.map(card)) : h('div', { class: 'dim idp-empty' }, t('No profiles yet. Add one with +, then switch with one click.'))
  )
}

async function viewSettings() {
  const scope = state.configScope
  // everything the page needs, asked at the same time (one after another was 4 round trips)
  const profilesP = identityProfiles()
  const remotesP = scope === 'global' ? null : call('remotes').catch(() => [])
  const maintenanceP = scope === 'local' ? maintenanceSection() : null
  const [entries, globals] = await Promise.all([
    call('configList', { scope }),
    scope === 'local' ? call('configList', { scope: 'global' }).catch(() => []) : Promise.resolve([])
  ])
  const map = {}
  for (const e of entries) map[e.key.toLowerCase()] = e.value
  const gmap = {}
  for (const e of globals) gmap[e.key.toLowerCase()] = e.value
  const root = h('div', { class: 'view' })

  const seg = h(
    'div',
    { class: 'segmented' },
    h('button', { class: scope === 'global' ? 'on' : '', onClick: () => setScope('global') }, t('Global')),
    h('button', { class: scope === 'local' ? 'on' : '', onClick: () => setScope('local') }, t('This repository'))
  )
  function setScope(s) {
    if (s === state.configScope) return
    state.configScope = s
    store.set('configScope', s)
    // Show the choice at once and lock the old form until the new scope's values arrive, so
    // nothing typed meanwhile is saved to the wrong scope.
    seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', (i === 0) === (s === 'global')))
    root.classList.add('pending')
    renderView({ force: true })
  }
  root.append(
    h('div', { style: { padding: '4px 10px 2px' } }, seg),
    h(
      'div',
      { class: 'dim', style: { padding: '4px 10px 0', fontSize: '11px' } },
      scope === 'global' ? t('Applies to every repository for your user (~/.gitconfig).') : t('Applies only to this repository (.git/config) and overrides global values.')
    )
  )

  root.append(await profilesP)

  // identity + common options
  if (scope !== 'global') root.append(h('div', { class: 'dim', style: { padding: '6px 16px 0', fontSize: '11.5px' } }, t('Empty fields use the global value shown in grey.')))
  const inputs = {}
  const form = h('div', { class: 'form' })
  for (const f of COMMON) {
    if (f.group) {
      form.append(h('div', { class: 'cfg-group' }, f.group))
      continue
    }
    if (f.globalOnly && scope !== 'global') continue
    const cur = map[f.key.toLowerCase()] ?? ''
    const inherited = gmap[f.key.toLowerCase()]
    let el
    if (f.options) {
      const opts = (f.options.some(([v]) => v === cur) ? f.options : [...f.options, [cur, cur]]).map(([v, l]) =>
        v === '' && inherited != null ? ['', t('Use global ({value})', { value: inherited })] : [v, l]
      )
      el = h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)))
    } else
      el = h('input', {
        type: 'text',
        value: cur,
        placeholder: inherited != null ? t('{value}  (global)', { value: inherited }) : f.placeholder || '',
        spellcheck: 'false'
      })
    el.value = cur
    inputs[f.key] = { el, cur }
    form.append(h('div', { class: 'field' }, h('label', null, f.label, h('span', { class: 'dim mono', style: { marginLeft: '6px', fontSize: '10px' } }, f.key)), el))
  }
  form.append(
    h(
      'div',
      { class: 'row cfg-save' },
      h('span', { class: 'dim cfg-save-note' }, scope === 'global' ? t('Saves to your global git config') : t('Saves to this repository\'s .git/config')),
      h('span', { class: 'grow' }),
      h(
        'button',
        {
          class: 'btn primary',
          onClick: async () => {
            setBusy(1)
            try {
              for (const [key, { el, cur }] of Object.entries(inputs)) {
                const v = el.value.trim()
                if (v === cur) continue
                if (v === '') await call('configUnset', { scope, key })
                else await call('configSet', { scope, key, value: v })
              }
              toast(scope === 'global' ? t('Global config saved') : t('Repository config saved'))
            } catch (e) {
              toast(e.message, 'error')
            } finally {
              setBusy(-1)
              renderView({ force: true })
            }
          }
        },
        t('Save')
      )
    )
  )
  root.append(form)

  // remotes
  if (scope === 'local') {
    const remotes = await (remotesP || call('remotes').catch(() => []))
    root.append(h('div', { class: 'section-head' }, t('Remotes'), h('span', { class: 'count' }, remotes.length), h('div', { class: 'actions' }, iconBtn('plus', t('Add remote'), addRemote))))
    if (!remotes.length) root.append(h('div', { class: 'dim', style: { padding: '2px 10px 8px', fontSize: '11.5px' } }, t('No remotes yet.')))
    for (const r of remotes)
      root.append(
        h(
          'div',
          { class: 'cfg-row' },
          h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600 } }, r.name), h('div', { class: 'cfg-key', style: { wordBreak: 'break-all' } }, r.fetch)),
          h(
            'div',
            { class: 'row', style: { gap: 0 } },
            /^https?:\/\//.test(r.fetch) || /^git@|^ssh:\/\//.test(r.fetch)
              ? iconBtn('globe', /^https?:/.test(r.fetch) ? t('Switch to SSH') : t('Switch to HTTPS'), async () => {
                  const url = swapProtocol(r.fetch)
                  if (url && (await confirmBox(t('Use {protocol} for {remote}?', { protocol: /^https?:/.test(url) ? 'HTTPS' : 'SSH', remote: r.name }), url, t('Switch'))))
                    run('remoteSetUrl', { name: r.name, url }, { success: t('Remote updated') })
                })
              : null,
            iconBtn('edit', t('Change URL'), async () => {
              const v = await dialog({ title: t('URL for {remote}', { remote: r.name }), fields: [{ key: 'url', label: t('URL'), value: r.fetch }], ok: t('Save') })
              if (v?.url.trim()) run('remoteSetUrl', { name: r.name, url: v.url.trim() }, { success: t('Remote updated') })
            }),
            iconBtn('trash', t('Remove remote'), async () => (await confirmBox(t('Remove remote {remote}?', { remote: r.name }), t('Its remote-tracking branches are removed too.'), t('Remove'), true)) && run('remoteRemove', { name: r.name }, { success: t('Remote removed') }))
          )
        )
      )
  }

  const remembered = store.get('checkoutChanges', null)
  if (remembered)
    root.append(
      h('div', { class: 'section-head' }, t('Checkout')),
      h(
        'div',
        { class: 'cfg-row' },
        h('div', null, h('div', null, t('With uncommitted changes, checkout always does: '), h('strong', null, { keep: t("Don't change"), stash: t('Stash'), merge: t('Merge') }[remembered.mode] || remembered.mode)), h('div', { class: 'cfg-key' }, t('Saved from the checkout dialog'))),
        h('button', { class: 'btn sm', onClick: () => (store.set('checkoutChanges', null), toast(t('Checkout will ask again')), renderView({ force: true })) }, t('Ask every time'))
      )
    )
  if (scope === 'local') root.append(await maintenanceP)

  // every entry
  root.append(h('div', { class: 'section-head' }, t('All entries'), h('span', { class: 'count' }, entries.length), h('div', { class: 'actions' }, iconBtn('plus', t('Add entry'), () => editEntry(scope)))))
  for (const e of entries)
    root.append(
      h(
        'div',
        { class: 'cfg-row' },
        h('div', { style: { minWidth: 0 } }, h('div', { class: 'cfg-key' }, e.key), h('div', { class: 'cfg-val' }, e.value)),
        h(
          'div',
          { class: 'row', style: { gap: 0 } },
          iconBtn('edit', t('Edit'), () => editEntry(scope, e)),
          iconBtn('trash', t('Unset'), async () => (await confirmBox(t('Unset {key}?', { key: e.key }), scope === 'global' ? t('Removes it from the global config.') : t('Removes it from the repository config.'), t('Unset'), true))
 && run('configUnset', { scope, key: e.key }))
        )
      )
    )
  return root
}
/** https://host/owner/repo.git ⇄ git@host:owner/repo.git */
function swapProtocol(url) {
  let m = url.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?\/?$/)
  if (m) return `git@${m[1]}:${m[2]}.git`
  m = url.match(/^git@([^:]+):(.+?)(\.git)?$/) || url.match(/^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(\.git)?$/)
  if (m) return `https://${m[1]}/${m[2]}.git`
  return null
}

async function editEntry(scope, e) {
  const r = await dialog({
    title: e ? t('Edit {key}', { key: e.key }) : t('Add config entry'),
    fields: [
      { key: 'key', label: t('Key'), value: e?.key || '', placeholder: 'section.name' },
      { key: 'value', label: t('Value'), value: e?.value || '' }
    ],
    ok: t('Save')
  })
  if (!r?.key.trim()) return
  run('configSet', { scope, key: r.key.trim(), value: r.value }, { success: t('Saved') })
}
async function addRemote() {
  const r = await dialog({
    title: t('Add remote'),
    fields: [
      { key: 'name', label: t('Name'), value: 'origin' },
      { key: 'url', label: t('URL'), placeholder: 'https://github.com/owner/repo.git' }
    ],
    ok: t('Add')
  })
  if (!r?.name.trim() || !r.url.trim()) return
  run('remoteAdd', { name: r.name.trim(), url: r.url.trim() }, { success: t('Remote added') })
}


/* =========================================================================
   Git Extensions extras: file menu, blame, file history, compare, tree,
   reflog, bisect, interactive rebase, squash, patches, clone, maintenance
   ========================================================================= */
function fileMenu(anchor, f) {
  const ext = f.path.includes('.') ? '*' + f.path.slice(f.path.lastIndexOf('.')) : null
  menu(anchor, [
    !f.untracked && { label: t('Blame'), icon: 'user', onClick: () => blameSheet(f.path) },
    !f.untracked && { label: t('File history'), icon: 'history', onClick: () => fileHistory(f.path) },
    '-',
    { header: t('Add to .gitignore') },
    { label: f.path, icon: 'x', onClick: () => run('ignore', { pattern: '/' + f.path }, { success: t('Added to .gitignore') }) },
    ext && { label: ext, icon: 'x', onClick: () => run('ignore', { pattern: ext }, { success: t('Added to .gitignore') }) },
    dirname(f.path) && { label: dirname(f.path) + '/', icon: 'folder', onClick: () => run('ignore', { pattern: '/' + dirname(f.path) + '/' }, { success: t('Added to .gitignore') }) },
    '-',
    { label: t('Copy path'), icon: 'copy', onClick: () => copy(f.path) }
  ])
}

function commitList(commits, { graph = true } = {}) {
  const rows = graph ? layoutGraph(commits) : null
  const width = rows ? graphWidth(rows) + 4 : 8
  const list = h('div')
  commits.forEach((c, i) =>
    list.append(
      h(
        'div',
        { class: 'commit-row', onClick: () => openCommit(c.hash), onContextmenu: (e) => commitContextMenu(e, c) },
        rows ? graphSvg(rows[i], width, c.parents.length > 1, c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> '))) : h('span', { style: { width: '8px' } }),
        h(
          'div',
          { class: 'commit-text' },
          h('div', { class: 'commit-subject' }, refPills(c.refs, rows && rows[i] ? rows[i].color : null), h('span', { class: 's', title: c.subject }, c.subject)),
          h('div', { class: 'commit-meta' }, `${c.author} · ${ago(c.time)} · `, h('span', { class: 'mono' }, c.hash.slice(0, 7)))
        )
      )
    )
  )
  if (!commits.length) list.append(h('div', { class: 'empty' }, t('No commits')))
  return list
}

async function sheetWith(title, loader) {
  openSheet(title, h('div', { class: 'empty' }, t('Loading…')))
  const sheet = state.sheets[state.sheets.length - 1]
  try {
    const el = await loader()
    clear(sheet.el.querySelector('.sheet-body')).append(el)
  } catch (e) {
    if (state.sheets.includes(sheet)) closeSheet()
    toast(e.message, 'error')
  }
}

/* ---------- 1. a second look before committing ---------- */
/** true to go on with the commit; asks first when something staged looks risky. */
async function preCommitCheck() {
  let r
  try {
    r = await call('commitCheck')
  } catch {
    return true
  }
  const skipMain = store.get('noMainWarn', {})[state.repo]
  const ws = r.warnings.filter((w) => !(w.kind === 'branch' && skipMain))
  if (!ws.length) return true
  return new Promise((resolve) => {
    const quiet = h('input', { type: 'checkbox' })
    const done = (ok) => {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      if (ok && quiet.checked) store.set('noMainWarn', { ...store.get('noMainWarn', {}), [state.repo]: true })
      resolve(ok)
    }
    const onKey = (e) => isTopOverlay(overlay) && e.key === 'Escape' && done(false)
    const ic = { secret: 'alert', big: 'file', branch: 'branch' }
    const box = h(
      'div',
      { class: 'dialog choice-dialog precommit', role: 'dialog' },
      h('h3', null, t('Before you commit')),
      h('p', { class: 'dim' }, t('A few things are worth a second look. Nothing is committed until you choose.')),
      h('div', { class: 'pc-list' }, ws.map((w) => h('div', { class: `pc-item k-${w.kind}` }, icon(ic[w.kind] || 'alert', 13), h('span', null, w.text)))),
      ws.some((w) => w.kind === 'secret') && h('p', { class: 'pc-hint' }, t('Secrets in history are hard to remove and stay readable by everyone with the repository. Unstage the file, or move the value to an ignored .env file.')),
      ws.some((w) => w.kind === 'branch') && h('label', { class: 'check' }, quiet, t("Don't ask about {branch} again in this repository", { branch: r.branch })),
      h('div', { class: 'buttons' }, h('button', { class: 'btn', onClick: () => done(false) }, t('Go back')), h('span', { class: 'grow' }), h('button', { class: `btn ${ws.some((w) => w.kind === 'secret') ? 'danger' : 'primary'}`, onClick: () => done(true) }, t('Commit anyway')))
    )
    const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && done(false) }, box)
    mountOverlay(overlay, () => done(false))
    document.addEventListener('keydown', onKey)
  })
}

/* ---------- 2. AI explains a commit or a merge request ---------- */
async function explainSheet(target) {
  const what = target.item ? `${mrRef(target.item)} · ${target.item.title}` : `${target.hash.slice(0, 7)}${target.subject ? ` · ${target.subject}` : ''}`
  const body = h('div', { class: 'explain' })
  openSheet(t('Explain · {what}', { what }), body)
  const sheet = state.sheets[state.sheets.length - 1]
  sheet.el.classList.add('wide-sheet')
  placeSheet(sheet.el)
  const status = h('div', { class: 'ai-status' })
  const run1 = async () => {
    clear(body).append(h('div', { class: 'explain-wait' }, h('span', { class: 'ai-dots' }, h('i'), h('i'), h('i')), status))
    const stop = aiTicker(status, 'AI', target.item ? t('the merge request') : t('the commit'))
    try {
      const r = await request('ai.explain', target.item ? { item: { ...target.item, ci: undefined } } : { repo: state.repo, hash: target.hash }, 118000)
      stop()
      if (!sheet.el.isConnected) return
      clear(body).append(
        h('div', { class: 'explain-head' }, icon('wand', 13), h('span', null, t('Explained by {agent}. It reads the diff; check anything important.', { agent: r.agent })), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onClick: run1 }, icon('refresh', 12), t('Explain again')), h('button', { class: 'btn sm', onClick: () => copy(r.text) }, icon('copy', 12), t('Copy'))),
        mdRender(r.text)
      )
    } catch (e) {
      stop()
      if (sheet.el.isConnected) clear(body).append(h('div', { class: 'empty' }, icon('alert', 28), h('div', null, e.message), h('button', { class: 'btn sm', style: { marginTop: '10px' }, onClick: run1 }, icon('refresh', 12), t('Try again'))))
    }
  }
  run1()
}

/* ---------- 3. drag a branch onto another: merge, rebase or push ---------- */
let dragRef = null
document.addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('[data-drag-ref]')
  if (!el) return
  dragRef = { name: el.dataset.dragRef, kind: el.dataset.dragKind }
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', dragRef.name)
  document.body.classList.add('dragging-ref')
})
document.addEventListener('dragend', () => {
  dragRef = null
  document.body.classList.remove('dragging-ref')
  document.querySelectorAll('.drop-on').forEach((x) => x.classList.remove('drop-on'))
})
const dropTarget = (e) => {
  const el = e.target.closest?.('[data-drop-ref]')
  return el && dragRef && el.dataset.dropRef !== dragRef.name ? el : null
}
document.addEventListener('dragover', (e) => {
  const el = dropTarget(e)
  if (!el) return
  e.preventDefault()
  document.querySelectorAll('.drop-on').forEach((x) => x !== el && x.classList.remove('drop-on'))
  el.classList.add('drop-on')
})
document.addEventListener('drop', (e) => {
  const el = dropTarget(e)
  if (!el) return
  e.preventDefault()
  el.classList.remove('drop-on')
  const src = dragRef
  const dst = { name: el.dataset.dropRef, kind: el.dataset.dropKind }
  const cur = state.status?.branch
  const items = []
  if (dst.kind === 'remote-group') {
    if (src.kind === 'branch') items.push({ label: t('Push {branch} to {remote}', { branch: nm(src.name), remote: dst.name }), icon: 'push', onClick: () => run('push', src.name === cur ? { remote: dst.name } : { branch: src.name, remote: dst.name }, { success: t('Pushed {branch} to {remote}', { branch: src.name, remote: dst.name }) }) })
  } else if (dst.name === cur) {
    items.push({ label: mergeLabel(src.name, cur), full: t('Merge {src} → {dst}', { src: src.name, dst: cur }), icon: 'merge', onClick: () => mergeRef(src.name) })
  } else if (src.name === cur) {
    items.push({ label: t('Rebase {branch} onto {onto}…', { branch: nm(cur), onto: nm(dst.name) }), icon: 'merge', onClick: () => rebaseOnto(dst.name) })
    if (dst.kind !== 'tag') items.push(...withAiReview(mrBoth(dst.name.replace(/^[^/]+\//, ''), cur)))
  } else {
    items.push({ label: t('Switch to {dst}, then merge {src} in', { dst: nm(dst.name), src: nm(src.name) }), icon: 'merge', onClick: async () => (await checkout(dst.name), state.status?.branch === dst.name && mergeRef(src.name)) })
  }
  if (!items.filter(Boolean).length) return toast(t('Nothing to do with {src} on {dst}', { src: src.name, dst: dst.name }))
  menuPoint = { x: e.clientX, y: e.clientY }
  menu(menuPoint, [{ header: `${src.name} → ${dst.name}` }, ...items])
  menuPoint = null
})

/* ---------- 5. one page per file: its history with diffs, and who wrote each line ---------- */
async function fileExplorer(file, tab = 'history', rev) {
  const body = h('div', { class: 'fx' })
  openSheet(`${basename(file)}`, body)
  const sheet = state.sheets[state.sheets.length - 1]
  sheet.el.classList.add('wide-sheet')
  placeSheet(sheet.el)
  const tabs = h('div', { class: 'mrd-tabs fx-tabs' })
  const pane = h('div', { class: 'fx-pane' })
  body.append(h('div', { class: 'fx-path mono dim' }, file), tabs, pane)
  // tabId: the tab; r: a commit for "who wrote each line" as of that commit ("Lines at this point")
  const go = (tabId, r) => {
    tab = tabId
    rev = tabId === 'blame' ? r : rev
    clear(tabs).append(...[['history', t('History')], ['blame', t('Who wrote each line')]].map(([k, l]) => h('button', { class: `mrd-tab ${tab === k ? 'on' : ''}`, onClick: () => go(k) }, l)))
    clear(pane).append(h('div', { class: 'inline-skeleton', style: { margin: '12px' } }, h('span'), h('span'), h('span')))
    ;(tab === 'history' ? historyPane() : blamePane()).then((el) => sheet.el.isConnected && tab === tabId && clear(pane).append(el), (e) => clear(pane).append(h('div', { class: 'empty' }, e.message)))
  }
  async function historyPane() {
    const commits = await call('log', { file, limit: 300 })
    if (!commits.length) return h('div', { class: 'empty' }, t('No history for this file'))
    const list = h('div', { class: 'fx-list' })
    const diff = h('div', { class: 'fx-diff' })
    const pick = async (c, row) => {
      list.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'))
      row.classList.add('sel')
      clear(diff).append(h('div', { class: 'inline-skeleton', style: { margin: '12px' } }, h('span'), h('span')))
      try {
        const text = await call('commitFileDiff', { hash: c.hash, file })
        clear(diff).append(
          h('div', { class: 'fx-diff-head' }, h('b', null, c.subject), h('span', { class: 'dim' }, ` · ${c.author} · ${ago(c.time)}`), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onClick: () => openCommit(c.hash) }, icon('commit', 12), t('Open commit')), h('button', { class: 'btn sm', onClick: () => go('blame', c.hash) }, icon('user', 12), t('Lines at this point'))),
          renderDiff(text, null, { images: { old: c.parents?.[0] || null, new: c.hash } })
        )
      } catch (e) {
        clear(diff).append(h('div', { class: 'empty' }, e.message))
      }
    }
    commits.forEach((c, i) => {
      const row = h('button', { class: 'fx-row', onClick: () => pick(c, row) }, h('span', { class: 'mono dim' }, c.hash.slice(0, 7)), h('span', { class: 'grow ellipsis', title: c.subject }, c.subject), h('span', { class: 'dim fx-meta' }, `${c.author} · ${ago(c.time)}`))
      list.append(row)
      if (i === 0) setTimeout(() => pick(c, row), 0)
    })
    return h('div', { class: 'fx-split' }, list, diff)
  }
  async function blamePane() {
    const { commits, lines } = await call('blame', { file, rev })
    const times = Object.values(commits).map((c) => c.time || 0).filter(Boolean)
    const min = Math.min(...times)
    const max = Math.max(...times)
    const wrap = h('div', { class: 'blame fx-blame' })
    if (rev) wrap.append(h('div', { class: 'fx-note dim' }, t('As of {rev}', { rev: rev.slice(0, 7) })))
    let prev = null
    lines.forEach((l, i) => {
      const c = commits[l.h] || {}
      const first = l.h !== prev
      prev = l.h
      // newer lines are warmer: the age shows at a glance
      const heat = max > min && c.time ? (c.time - min) / (max - min) : 1
      wrap.append(
        h(
          'div',
          { class: `bl ${first ? 'first' : ''}`, style: { '--heat': heat.toFixed(2) } },
          h('span', { class: 'bl-age' }),
          h(
            'span',
            { class: 'bl-meta', title: first ? `${c.summary || ''}\n${c.author || ''} · ${c.time ? fullDate(c.time) : ''}` : '', onClick: () => !/^0+$/.test(l.h) && openCommit(l.h) },
            first ? [h('span', { class: 'mono' }, /^0+$/.test(l.h) ? t('not committed') : l.h.slice(0, 7)), ' ', h('span', { class: 'dim' }, `${c.author || ''} · ${c.time ? ago(c.time) : ''}`)] : ''
          ),
          h('span', { class: 'n' }, i + 1),
          h('span', { class: 'c' }, l.t)
        )
      )
    })
    return wrap
  }
  return go(tab)
}

function fileHistory(file) {
  return fileExplorer(file, 'history')
}
function blameSheet(file, rev) {
  return fileExplorer(file, 'blame', rev)
}

function compareSheet(a, b) {
  const short = (x) => (/^[0-9a-f]{40}$/.test(x) ? x.slice(0, 7) : x)
  return sheetWith(`${short(a)} ↔ ${short(b)}`, async () => {
    const r = await call('compare', { a, b })
    const wrap = h('div')
    wrap.append(
      h(
        'div',
        { class: 'detail' },
        h('div', null, h('strong', null, short(b)), r.ahead === 1 ? t(' is {ahead} commit ahead and {behind} behind ', { ahead: r.ahead, behind: r.behind }) : t(' is {ahead} commits ahead and {behind} behind ', { ahead: r.ahead, behind: r.behind }), h('strong', null, short(a))),
        h('div', { class: 'actions-wrap' }, h('button', { class: 'btn sm', onClick: () => compareSheet(b, a) }, icon('compare', 12), t('Swap')))
      ),
      h('div', { class: 'section-head' }, t('Files'), h('span', { class: 'count' }, r.files.length))
    )
    for (const f of r.files)
      wrap.append(
        h(
          'div',
          { class: 'item', title: f.orig ? `${f.orig} → ${f.path}` : f.path, onClick: () => showDiff(basename(f.path), () => call('compareFileDiff', { a, b, file: f.path }), [], undefined, { old: a, new: b }) },
          h('span', { class: `status-letter s-${f.status}` }, f.status),
          h('span', { class: 'file-name' }, basename(f.path)),
          h('span', { class: 'file-dir grow' }, dirname(f.path))
        )
      )
    if (!r.files.length) wrap.append(h('div', { class: 'empty' }, t('No differences')))
    return wrap
  })
}

function treeSheet(rev) {
  return sheetWith(t('Files @ {rev}', { rev: rev.slice(0, 7) }), async () => {
    const files = await call('treeFiles', { rev })
    const wrap = h('div')
    const filter = h('input', { type: 'text', placeholder: t('Filter {n} files…', { n: files.length }) })
    const list = h('div')
    const draw = () => {
      const q = filter.value.toLowerCase()
      clear(list)
      files
        .filter((f) => !q || f.toLowerCase().includes(q))
        .slice(0, 500)
        .forEach((f) =>
          list.append(
            h(
              'div',
              { class: 'item', title: f, onClick: () => fileAt(rev, f) },
              icon('file', 13),
              h('span', { class: 'file-name' }, basename(f)),
              h('span', { class: 'file-dir grow' }, dirname(f)),
              h(
                'div',
                { class: 'hover-actions', onClick: (e) => e.stopPropagation() },
                iconBtn('user', t('Blame'), () => blameSheet(f, rev)),
                iconBtn('history', t('File history'), () => fileHistory(f))
              )
            )
          )
        )
    }
    filter.addEventListener('input', draw)
    draw()
    wrap.append(h('div', { class: 'history-bar', style: { paddingTop: '8px' } }, filter), list)
    return wrap
  })
}
function fileAt(rev, file) {
  return sheetWith(`${basename(file)} @ ${rev.slice(0, 7)}`, async () => {
    const text = await call('showFile', { rev, file })
    const wrap = h('div', { class: 'diff' })
    text.split('\n').forEach((t, i) => wrap.append(h('div', { class: 'l ctx' }, h('span', { class: 'n' }, i + 1), h('span', { class: 'c' }, t))))
    return wrap
  })
}

/** "commit: msg" → a coloured label for the kind of step. */
function reflogKind(subject) {
  const k = (subject.match(/^([\w-]+)/)?.[1] || '').toLowerCase()
  const kind = ['commit', 'checkout', 'reset', 'merge', 'rebase', 'pull', 'cherry-pick', 'revert', 'branch', 'clone'].includes(k) ? k : 'other'
  return h('span', { class: `rk rk-${kind}` }, kind === 'other' ? k || 'step' : kind)
}
async function viewReflog() {
  const list = await call('reflog')
  const root = h('div', { class: 'view' })
  root.append(
    h('div', { class: 'section-head' }, t('Reflog'), h('span', { class: 'count' }, list.length)),
    h('div', { class: 'dim', style: { padding: '0 16px 8px', fontSize: '11.5px' } }, t('Everywhere HEAD has been. Use it to recover commits after a reset, rebase or deleted branch.'))
  )
  for (const e of list)
    root.append(
      h(
        'div',
        { class: 'item', title: e.subject, onClick: () => openCommit(e.hash) },
        h('span', { class: 'mono dim', style: { width: '56px', flex: 'none' } }, e.hash.slice(0, 7)),
        reflogKind(e.subject),
        h('span', { class: 'grow ellipsis' }, e.subject.replace(/^[\w -]+?(\(.*?\))?: /, '')),
        h('span', { class: 'meta-right dim', style: { fontSize: '11px' } }, ago(e.time)),
        h(
          'div',
          { class: 'hover-actions', onClick: (ev) => ev.stopPropagation() },
          h('button', { class: 'btn sm', title: t('Create a branch at this point (recovers lost commits)'), onClick: () => newBranch(e.hash) }, icon('plus', 12), t('Branch here')),
          h('button', { class: 'btn sm', title: t('Move the current branch back to this point'), onClick: () => resetTo(e.hash) }, icon('undo', 12), t('Reset here'))
        )
      )
    )
  return root
}

function bisectBanner(st) {
  return h(
    'div',
    { class: 'banner info' },
    h('div', { class: 'row' }, icon('search'), h('strong', null, t('Bisecting')), h('span', { class: 'dim mono' }, (st.oid || '').slice(0, 7))),
    h('div', { class: 'dim', style: { fontSize: '11.5px' } }, t('Test this commit, then mark it. Git checks out the next one to test.')),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn sm', onClick: () => run('bisect', { action: 'good' }, { success: t('Marked good') }).then(() => resetHistory()) }, icon('check', 12), t('Good')),
      h('button', { class: 'btn sm', onClick: () => run('bisect', { action: 'bad' }, { success: t('Marked bad') }).then(() => resetHistory()) }, icon('x', 12), t('Bad')),
      h('button', { class: 'btn sm', onClick: () => run('bisect', { action: 'skip' }, { success: t('Skipped') }) }, t('Skip')),
      h('button', { class: 'btn sm danger', onClick: () => run('bisect', { action: 'reset' }, { success: t('Bisect finished') }).then(() => resetHistory()) }, t('Stop'))
    )
  )
}
async function startBisect(goodHash) {
  if (!(await confirmBox(t('Start bisect?'), t('Git will search between {hash} (good) and HEAD (bad) for the commit that introduced a bug.', { hash: goodHash.slice(0, 7) }), t('Start')))) return
  closeSheet()
  try {
    await call('bisect', { action: 'start' })
    await call('bisect', { action: 'bad', rev: 'HEAD' })
    await call('bisect', { action: 'good', rev: goodHash })
  } catch (e) {
    toast(e.message, 'error')
  }
  resetHistory()
  refreshAll()
}

async function rewordLast(c) {
  const r = await dialog({ title: t('Reword last commit'), fields: [{ key: 'msg', label: t('Message'), type: 'textarea', value: c.message }], ok: t('Save') })
  if (!r?.msg.trim()) return
  closeSheet()
  resetHistory()
  run('rewordLast', { message: r.msg }, { success: t('Message updated') })
}

async function squashSince(base) {
  let todo
  try {
    todo = await call('rebaseTodo', { base })
  } catch (e) {
    return toast(e.message, 'error')
  }
  if (todo.length < 2) return toast(t('There is only one commit after this one'), 'error')
  const r = await dialog({
    title: t('Squash {n} commits', { n: todo.length }),
    message: t('Every commit after {base} on {branch} becomes one commit.', { base: base.slice(0, 7), branch: state.status?.branch || 'HEAD' }),
    fields: [{ key: 'msg', label: t('Message for the new commit'), type: 'textarea', value: todo.map((t) => t.subject).reverse().join('\n') }],
    ok: t('Squash')
  })
  if (!r?.msg.trim()) return
  closeSheet()
  resetHistory()
  run('squashSince', { base, message: r.msg }, { success: t('Squashed') })
}

/**
 * Edit the commits after `base`, oldest first: drag (or ↑ ↓) to reorder, and per commit pick, reword
 * (the new message is typed right there), squash / fixup into the one above, or drop. Keys on a row:
 * p r s f d. A line at the bottom says what the branch will look like.
 */
async function interactiveRebase(base) {
  let todo
  try {
    todo = (await call('rebaseTodo', { base })).map((t) => ({ ...t, action: 'pick', message: t.subject }))
  } catch (e) {
    return toast(e.message, 'error')
  }
  if (!todo.length) return toast(t('No commits after this one'), 'error')
  closeOverlays()
  const cur = state.status?.branch || 'HEAD'
  const ACTS = [
    ['pick', t('Keep'), 'p'],
    ['reword', t('Reword'), 'r'],
    ['squash', t('Squash ↑'), 's'],
    ['fixup', t('Fixup ↑'), 'f'],
    ['drop', t('Drop'), 'd']
  ]
  const HELP = { pick: t('kept as it is'), reword: t('kept, with the new message'), squash: t('joined into the commit above; both messages kept'), fixup: t('joined into the commit above; its message dropped'), drop: t('removed') }
  const list = h('div', { class: 'rb-list' })
  const summary = h('div', { class: 'rb-summary' })
  let dragFrom = null
  const fix = () => {
    const first = todo.findIndex((t) => t.action !== 'drop')
    if (first >= 0 && (todo[first].action === 'squash' || todo[first].action === 'fixup')) todo[first].action = 'pick'
  }
  const move = (i, j) => {
    if (j < 0 || j >= todo.length || i === j) return
    const [t] = todo.splice(i, 1)
    todo.splice(j, 0, t)
    fix()
    draw(j)
  }
  function draw(focus) {
    clear(list)
    todo.forEach((step, i) => {
      const firstKept = todo.findIndex((x) => x.action !== 'drop') === i
      const acts = h(
        'div',
        { class: 'rb-acts', role: 'radiogroup' },
        ACTS.map(([k, label, key]) =>
          h('button', { type: 'button', class: `rb-act a-${k} ${step.action === k ? 'on' : ''}`, title: `${label}: ${HELP[k]} (${key})`, disabled: firstKept && (k === 'squash' || k === 'fixup'), onClick: () => ((step.action = k), fix(), draw(i)) }, label)
        )
      )
      const msg =
        step.action === 'reword' &&
        h('input', {
          type: 'text',
          class: 'rb-msg',
          value: step.message,
          placeholder: t('New message'),
          onInput: (e) => ((step.message = e.target.value), drawSummary()),
          onKeydown: (e) => e.stopPropagation()
        })
      const row = h(
        'div',
        {
          class: `rb-row a-${step.action}`,
          tabindex: 0,
          draggable: 'true',
          onDragstart: (e) => ((dragFrom = i), row.classList.add('dragging'), e.dataTransfer.setData('text/plain', String(i))),
          onDragend: () => row.classList.remove('dragging'),
          onDragover: (e) => (e.preventDefault(), row.classList.add('drop-here')),
          onDragleave: () => row.classList.remove('drop-here'),
          onDrop: (e) => (e.preventDefault(), row.classList.remove('drop-here'), dragFrom != null && move(dragFrom, i), (dragFrom = null)),
          onKeydown: (e) => {
            const k = ACTS.find(([, , key]) => key === e.key.toLowerCase())
            if (k && !(firstKept && (k[0] === 'squash' || k[0] === 'fixup'))) (e.preventDefault(), (step.action = k[0]), fix(), draw(i))
            else if (e.key === 'ArrowUp' && e.altKey) (e.preventDefault(), move(i, i - 1))
            else if (e.key === 'ArrowDown' && e.altKey) (e.preventDefault(), move(i, i + 1))
            else if (e.key === 'ArrowUp') (e.preventDefault(), list.children[i - 1]?.focus())
            else if (e.key === 'ArrowDown') (e.preventDefault(), list.children[i + 1]?.focus())
          }
        },
        h('span', { class: 'rb-grip', title: t('Drag to reorder (or Alt+↑ ↓)') }, '⠿'),
        h('span', { class: 'mono dim rb-hash' }, step.hash.slice(0, 7)),
        h('div', { class: 'grow rb-main' }, h('span', { class: 'ellipsis rb-subject', title: step.subject }, step.subject), msg, (step.action === 'squash' || step.action === 'fixup') && h('span', { class: 'rb-hint' }, t('↳ joins the commit above'))),
        acts,
        h('div', { class: 'rb-move' }, iconBtn('up', t('Move up'), () => move(i, i - 1), { disabled: i === 0 }), iconBtn('down', t('Move down'), () => move(i, i + 1), { disabled: i === todo.length - 1 }))
      )
      list.append(row)
    })
    drawSummary()
    if (focus != null) list.children[focus]?.focus()
  }
  function drawSummary() {
    const kept = todo.filter((t) => t.action === 'pick' || t.action === 'reword').length
    const joined = todo.filter((t) => t.action === 'squash' || t.action === 'fixup').length
    const dropped = todo.filter((t) => t.action === 'drop').length
    const reworded = todo.filter((t) => t.action === 'reword' && t.message.trim() && t.message.trim() !== t.subject).length
    const moved = todo.some((t, i) => t.hash !== orig[i])
    const changes = [joined && t('{n} joined', { n: joined }), dropped && t('{n} dropped', { n: dropped }), reworded && t('{n} reworded', { n: reworded }), moved && t('reordered')].filter(Boolean)
    clear(summary).append(icon('history', 13), h('span', null, h('b', null, kept === 1 ? t('{from} → {n} commit on {branch}', { from: todo.length, n: kept, branch: cur }) : t('{from} → {n} commits on {branch}', { from: todo.length, n: kept, branch: cur })), changes.length ? ` · ${changes.join(', ')}` : t(' · nothing changed yet'), h('span', { class: 'dim' }, t(' · Undo takes it all back'))))
    start.disabled = !changes.length || kept === 0
  }
  const orig = todo.map((t) => t.hash)
  const start = h('button', { class: 'btn primary', onClick: () => go() }, icon('check', 12), t('Start'))
  async function go() {
    if (todo.some((t) => t.action === 'reword' && !t.message.trim())) return toast(t('Write the new message for each Reword'), 'error')
    close()
    if (state.sheets.length) closeSheet()
    resetHistory()
    const out = await run('rebaseInteractive', { base, todo: todo.map(({ hash, action, message }) => ({ hash, action, message: action === 'reword' ? message : undefined })) }, { success: t('Rewrote {branch}', { branch: cur }) })
    if (out === undefined && state.status?.files.some((f) => f.conflict)) openConflicts()
  }
  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && isTopOverlay(overlay) && close()
  const box = h(
    'div',
    { class: 'dialog wide-dialog rb-dialog', role: 'dialog' },
    h('h3', null, todo.length > 1 ? t('Edit {n} commits on {branch}', { n: todo.length, branch: cur }) : t('Edit {n} commit on {branch}', { n: todo.length, branch: cur })),
    h('p', { class: 'dim' }, t('After {base}, oldest first. Drag to reorder; choose what happens to each. Keys: p r s f d, Alt+↑ ↓ to move.', { base: base.slice(0, 7) })),
    list,
    summary,
    h('div', { class: 'buttons' }, h('button', { class: 'btn', onClick: close }, t('Cancel')), h('span', { class: 'grow' }), start)
  )
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && close() }, box)
  mountOverlay(overlay, close)
  document.addEventListener('keydown', onKey)
  draw(0)
}

async function savePatch(c) {
  try {
    const text = await call('formatPatch', { hash: c.hash })
    const name = `${c.hash.slice(0, 7)}-${(c.message.split('\n')[0] || 'patch').replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.patch`
    if (window.orca?.files?.saveAs) {
      const r = await window.orca.files.saveAs({ suggestedName: name, mimeType: 'text/x-diff', data: text })
      if (r.status === 'saved') toast(t('Patch saved'))
    } else {
      await copy(text)
      toast(t('Patch copied to the clipboard'))
    }
  } catch (e) {
    toast(e.message, 'error')
  }
}

async function cloneRepo() {
  const base = state.status?.toplevel ? state.status.toplevel.replace(/[\\/][^\\/]+[\\/]?$/, '') : ''
  const r = await dialog({
    title: t('Clone repository'),
    fields: [
      { key: 'url', label: t('Repository URL'), placeholder: 'https://github.com/owner/repo.git' },
      { key: 'path', label: t('Folder'), value: base, placeholder: 'C:\\code', hint: t('The repository folder is created inside it.') },
      { key: 'recursive', label: t('Include submodules'), type: 'check', value: true }
    ],
    ok: t('Clone')
  })
  if (!r?.url.trim()) return
  const name = r.url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop().replace(/\.git$/, '')
  const dir = r.path.trim() ? r.path.trim().replace(/[\\/]+$/, '') + (r.path.includes('\\') ? '\\' : '/') + name : name
  setBusy(1)
  try {
    const out = await request('git', { op: 'clone', args: { url: r.url.trim(), path: dir, recursive: r.recursive } }, 120000)
    toast(t('Cloned into {path}', { path: out }))
    pinRepo(out)
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    setBusy(-1)
  }
}

async function maintenanceSection() {
  const wrap = h('div')
  const subs = await call('submodules').catch(() => [])
  wrap.append(h('div', { class: 'section-head' }, t('Maintenance')))
  wrap.append(
    h(
      'div',
      { class: 'form' },
      h(
        'div',
        { class: 'actions-wrap' },
        h(
          'button',
          {
            class: 'btn sm',
            onClick: async () => {
              const list = await call('cleanPreview', {}).catch((e) => (toast(e.message, 'error'), null))
              if (!list) return
              if (!list.length) return toast(t('No untracked files to clean'))
              const r = await dialog({
                title: list.length > 1 ? t('Delete {n} untracked items?', { n: list.length }) : t('Delete {n} untracked item?', { n: list.length }),
                message: list.slice(0, 15).join('\n') + (list.length > 15 ? '\n' + t('… and {n} more', { n: list.length - 15 }) : ''),
                fields: [{ key: 'ignored', label: t('Also delete ignored files (build output, node_modules…)'), type: 'check', value: false }],
                ok: t('Delete'),
                danger: true
              })
              if (r) run('clean', { ignored: r.ignored }, { success: t('Cleaned') })
            }
          },
          icon('trash', 12),
          t('Clean untracked files…')
        ),
        h('button', { class: 'btn sm', onClick: () => run('gc', {}, { success: t('Repository compressed') }) }, icon('layers', 12), t('Garbage collect')),
        h('button', { class: 'btn sm', onClick: () => run('fetch', { prune: true }, { success: t('Fetched and pruned') }) }, icon('fetch', 12), t('Fetch & prune'))
      )
    )
  )
  if (subs.length) {
    wrap.append(
      h('div', { class: 'section-head' }, t('Submodules'), h('span', { class: 'count' }, subs.length), h('div', { class: 'actions' }, iconBtn('refresh', t('Update all (init, recursive)'), () => run('submoduleUpdate', {}, { success: t('Submodules updated') }))))
    )
    for (const m of subs)
      wrap.append(
        h(
          'div',
          { class: 'item', title: m.describe },
          icon('layers', 13),
          h('span', { class: 'grow ellipsis' }, m.path),
          h('span', { class: `pill ${m.state === 'ok' ? 'on' : ''}` }, m.state),
          h('div', { class: 'hover-actions', onClick: (e) => e.stopPropagation() }, iconBtn('right', t('View in panel'), () => pinRepo((state.status.toplevel + '/' + m.path).replace(/\\/g, '/'))))
        )
      )
  }
  return wrap
}

/* ---------- full-tab sidebar (branches, remotes, tags); the repository is chosen from the header ---------- */
const sideOpen = store.get('sideOpen', { local: true, remote: false, tags: false })
async function renderSide() {
  const side = $('#side')
  if (!side) return
  let refs = state.refs || { local: [], remote: [], tags: [] }
  if (!state.refs && state.repo && state.status) refs = state.refs = (await call('refs').catch(() => null)) || refs
  state.localNames = new Set(refs.local.map((b) => b.name))
  const scroll = side.scrollTop
  clear(side)
  const section = (key, title, count, items, extra) => {
    const open = sideOpen[key]
    side.append(
      h(
        'button',
        { class: 'side-head', onClick: () => ((sideOpen[key] = !open), store.set('sideOpen', sideOpen), renderSide()) },
        icon(open ? 'down' : 'right', 12),
        h('span', { class: 'grow' }, title),
        count != null && h('span', { class: 'count' }, count),
        extra
      )
    )
    if (open) side.append(items())
  }
  if (!state.status) return
  section('local', t('Branches'), refs.local.length, () => h('div', null, refs.local.map((b) => localBranchRow(b))), [
    iconBtn('trash', t('Clean up merged and gone branches'), (e) => (e.stopPropagation(), cleanupBranches())),
    iconBtn('plus', t('New branch'), (e) => (e.stopPropagation(), newBranch()))
  ])
  section('remote', t('Remotes'), refs.remote.length, () => h('div', null, refs.remote.map((b) => remoteBranchRow(b, refs.local))))
  // one remote: drop a branch on its heading to push it there
  const remoteNames = [...new Set(refs.remote.map((b) => b.name.split('/')[0]))]
  const rh = [...side.querySelectorAll('.side-head')].find((x) => x.textContent.startsWith(t('Remotes')))
  if (rh && remoteNames.length === 1) Object.assign(rh.dataset, { dropRef: remoteNames[0], dropKind: 'remote-group' }), (rh.title = t('Drop a branch here to push it to {remote}', { remote: remoteNames[0] }))
  section('tags', t('Tags'), refs.tags.length, () => h('div', null, refs.tags.map((t) => tagRow(t))))
  side.scrollTop = scroll
}


/* =========================================================================
   AI commit message modal (modeled on Orca's Source Control "Generate" dialog)
   ========================================================================= */
/**
 * While an AI agent works: a shimmering skeleton over the text box it will fill (via the
 * `generating` class), and a status line that names the agent, says what it is doing and counts
 * the seconds. Returns stop().
 */
function aiWrap(textarea) {
  return h('div', { class: 'ai-wrap' }, textarea, h('div', { class: 'ai-skel', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'), h('span')))
}
function aiTicker(statusEl, name, what = t('your changes')) {
  const started = Date.now()
  const phase = (sec) => (sec < 6 ? t('{name} is reading {what}', { name, what }) : sec < 20 ? t('{name} is thinking', { name }) : sec < 60 ? t('{name} is writing', { name }) : t('{name} is still working (large changes take longer)', { name }))
  const text = h('span', { class: 'ai-phase' })
  const secs = h('span', { class: 'ai-secs mono' })
  const draw = () => {
    const sec = Math.floor((Date.now() - started) / 1000)
    text.textContent = phase(sec) + '…'
    secs.textContent = t('{n}s', { n: sec })
  }
  draw()
  append(clear(statusEl), [h('span', { class: 'ai-dots' }, h('i'), h('i'), h('i')), text, secs])
  statusEl.classList.add('working')
  const id = setInterval(draw, 1000)
  return () => {
    clearInterval(id)
    statusEl.classList.remove('working')
  }
}

async function aiCommitModal({ staged, total, onUse, onCommit }) {
  closeOverlays()
  const prefs = store.get('aiPrefs', { instructions: '' })
  let agents = [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'codex', name: 'Codex', available: true }
  ]
  let agent = 'claude'
  let gen = 0 // bumps on each run so a cancelled run's answer is ignored
  let busy = false

  const agentSel = h('select', { onChange: () => request('ai.settings', { agent: agentSel.value }).catch(() => {}) })
  const fillAgents = () => {
    clear(agentSel)
    for (const a of agents) agentSel.append(h('option', { value: a.id, selected: a.id === agent, disabled: !a.available }, a.available ? a.name : t('{name} (not installed)', { name: a.name })))
  }
  fillAgents()
  request('ai.settings', {}, 20000)
    .then((r) => {
      agents = r.agents
      agent = r.agent
      fillAgents()
    })
    .catch(() => {})

  const scopeSel = h(
    'select',
    null,
    h('option', { value: 'auto', selected: true }, staged ? (staged > 1 ? t('Staged changes ({n} files)', { n: staged }) : t('Staged changes ({n} file)', { n: staged })) : total > 1 ? t('All changes ({n} files)', { n: total }) : t('All changes ({n} file)', { n: total })),
    staged && staged < total ? h('option', { value: 'all' }, t('All changes ({n} files)', { n: total })) : null
  )
  const instructions = h('textarea', { rows: 2, placeholder: t('Optional, e.g. "Use Conventional Commits", "Write in Thai", "Mention the ticket ID"') }, prefs.instructions || '')
  instructions.value = prefs.instructions || ''
  const result = h('textarea', { class: 'ai-result', rows: 6, placeholder: t('The generated message appears here. You can edit it before using it.') })
  const status = h('div', { class: 'ai-status' })
  const genBtn = h('button', { type: 'button', class: 'btn sm ai-gen', onClick: () => generate() }, icon('wand', 13), t('Generate'))
  const commitBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onClick: () => finish(onCommit) }, icon('check', 13), t('Commit'))

  let stopTick = () => {}
  const setBusy2 = (on, text) => {
    busy = on
    result.classList.toggle('generating', on)
    result.readOnly = on
    stopTick()
    if (on) stopTick = aiTicker(status, agents.find((a) => a.id === agentSel.value)?.name || 'AI', 'your changes')
    else append(clear(status), [text || ''])
    append(clear(genBtn), [on ? [icon('x', 13), t('Stop')] : [icon(result.value.trim() ? 'refresh' : 'wand', 13), result.value.trim() ? t('Regenerate') : t('Generate')]])
    genBtn.className = `btn sm ai-gen ${on ? 'stop' : ''}`
    const has = !on && !!result.value.trim()
    commitBtn.disabled = !has
  }
  result.addEventListener('input', () => setBusy2(false))

  async function generate() {
    if (busy) {
      gen++
      return setBusy2(false, t('Stopped.'))
    }
    const my = ++gen
    store.set('aiPrefs', { instructions: instructions.value })
    const name = agents.find((a) => a.id === agentSel.value)?.name || 'AI'
    setBusy2(true, t('{name} is reading your changes…', { name }))
    const started = Date.now()
    try {
      const msg = await request('ai.commitMessage', { repo: state.repo, agent: agentSel.value, instructions: instructions.value, scope: scopeSel.value }, 115000)
      if (my !== gen) return
      result.value = msg
      setBusy2(false, t('Generated by {name} in {secs}s. Review and edit before committing.', { name, secs: ((Date.now() - started) / 1000).toFixed(1) }))
      result.focus()
    } catch (e) {
      if (my !== gen) return
      setBusy2(false, '')
      clear(status).append(h('span', { class: 'ai-error' }, icon('alert', 12), e.message))
    }
  }
  function finish(cb) {
    const msg = result.value.trim()
    if (!msg) return
    close(false)
    cb(msg)
  }
  const close = (keep = true) => {
    gen++
    // a generated (or edited) message goes into the commit box instead of being thrown away
    const msg = keep && !busy ? result.value.trim() : ''
    if (msg && onUse) onUse(msg)
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => {
    if (!isTopOverlay(overlay)) return
    if (e.key === 'Escape' && !busy) close()
    // Ctrl+Enter commits a ready message, or starts a run; it never stops one in flight.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !busy) result.value.trim() ? finish(onCommit) : generate()
  }

  const box = h(
    'div',
    { class: 'dialog ai-dialog', role: 'dialog', 'aria-label': t('Generate commit message') },
    h('div', { class: 'ai-title' }, h('div', null, h('h3', null, t('Generate commit message')), h('p', null, t('An AI agent reads your diff and drafts a message. Nothing is committed until you choose.')))),
    h('div', { class: 'ai-row' }, h('div', { class: 'field grow' }, h('label', null, t('Agent')), agentSel), h('div', { class: 'field grow' }, h('label', null, t('Changes')), scopeSel)),
    h('div', { class: 'field' }, h('label', null, t('Instructions')), instructions),
    h('div', { class: 'field' }, h('div', { class: 'ai-msg-head' }, h('label', null, t('Message')), genBtn), aiWrap(result)),
    status,
    h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'btn', title: t('A generated message stays in the commit box'), onClick: () => close() }, t('Close')), h('span', { class: 'grow' }), commitBtn)
  )
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && !busy && close() }, box)
  mountOverlay(overlay, () => close())
  document.addEventListener('keydown', onKey)
  status.textContent = t('Choose the agent, add instructions if you like, then press Generate.')
  genBtn.focus() // pick the agent and instructions first; Generate (or Ctrl+Enter) starts it
}


/**
 * "Review with AI" beside every "Merge request" in a menu: the same directions, each reviewing that
 * branch against the one it would merge into, before anyone else sees it.
 */
function withAiReview(mr) {
  if (!mr) return [null]
  const ai = {
    label: t('Review with AI'),
    icon: 'sparkle',
    cls: 'ai-item',
    items: mr.items.map((x) => ({ label: x.label.replace(/…$/, ''), full: t('Review with AI: {source} → {target}', { source: x.dir[0], target: x.dir[1] }), icon: 'sparkle', cls: 'ai-item', onClick: () => localReviewModal({ source: x.dir[0], target: x.dir[1] }) }))
  }
  return [mr, ai]
}

/** Markdown of a review whose `path:line` references open that file (in Orca's editor). */
function reviewBody(md) {
  const el = mdRender(md)
  for (const code of el.querySelectorAll('code')) {
    const m = code.textContent.trim().match(/^([\w@./\\-]+\.[\w]+):(\d+)(?:-\d+)?$/)
    if (!m) continue
    const a = h('button', { class: 'linkish mono review-ref', title: t('Open {file} (line {line})', { file: m[1], line: m[2] }), onClick: () => request('file.open', { repo: state.repo, file: m[1], line: +m[2] }).catch((e) => toast(e.message, 'error')) }, code.textContent)
    code.replaceWith(a)
  }
  return el
}

/**
 * AI review on this machine: a branch before its merge request ({ source, target }), or the staged
 * changes before a commit ({ staged: true }). Ends with the next step: create the merge request, or
 * back to committing.
 */
async function localReviewModal({ source, target, staged = false, onNext } = {}) {
  closeOverlays('.menu')
  const prefs = store.get('aiReviewPrefs', { instructions: '' })
  let agents = [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'codex', name: 'Codex', available: true }
  ]
  let agent = 'claude'
  let gen = 0
  let busy = false
  const what = staged ? t('staged changes') : `${source || state.status?.branch || t('this branch')} → ${target}`
  const agentSel = h('select', { onChange: () => request('ai.settings', { agent: agentSel.value }).catch(() => {}) })
  const fillAgents = () => {
    clear(agentSel)
    for (const a of agents) agentSel.append(h('option', { value: a.id, selected: a.id === agent, disabled: !a.available }, a.available ? a.name : t('{name} (not installed)', { name: a.name })))
  }
  fillAgents()
  request('ai.settings', {}, 20000)
    .then((r) => ((agents = r.agents), (agent = r.agent), fillAgents()))
    .catch(() => {})
  const instructions = h('textarea', { rows: 2, placeholder: t('Optional, e.g. "Write in Thai", "Focus on security", "We use React Query"') })
  instructions.value = prefs.instructions || ''
  const out = h('div', { class: 'local-review-out' }, h('div', { class: 'dim local-review-empty' }, icon('sparkle', 14), t('The review of {what} appears here. Nothing is posted anywhere.', { what })))
  const status = h('div', { class: 'ai-status' })
  const verdictEl = h('span', { class: 'pill' })
  const genBtn = h('button', { type: 'button', class: 'btn sm ai-gen ai-review-btn', onClick: () => generate() })
  // the next step: from a menu, create the merge request; from the merge request (or Commit) window, back to it
  const nextBtn = h('button', { type: 'button', class: 'btn', disabled: true, onClick: () => (close(), onNext ? onNext() : mergeRequestDialog(target, source)) }, icon(staged ? 'commit' : 'pr', 13), staged ? t('Back to commit') : onNext ? t('Back to the merge request') : t('Create merge request'))
  let has = false
  let stopTick = () => {}
  const sync = (on, text, verdict) => {
    busy = on
    stopTick()
    if (on) stopTick = aiTicker(status, agents.find((a) => a.id === agentSel.value)?.name || 'AI', what)
    else append(clear(status), [text || ''])
    append(clear(genBtn), [on ? [icon('x', 13), t('Stop')] : [icon(has ? 'refresh' : 'sparkle', 13), has ? t('Review again') : t('Start review')]])
    genBtn.className = `btn sm ai-gen ${on ? 'stop' : 'ai-review-btn'}`
    nextBtn.disabled = on || !has
    nextBtn.classList.toggle('primary', !on && has && verdict !== 'fix')
    if (verdict) {
      verdictEl.className = `pill local-verdict v-${verdict}`
      verdictEl.textContent = { ready: t('Ready for review'), fix: t('Fix first'), notes: t('OK, with notes') }[verdict]
    }
  }
  async function generate() {
    if (busy) {
      gen++
      return sync(false, t('Stopped.'))
    }
    const my = ++gen
    store.set('aiReviewPrefs', { instructions: instructions.value })
    const name = agents.find((a) => a.id === agentSel.value)?.name || 'AI'
    sync(true, t('{name} is reading {what}…', { name, what }))
    out.classList.add('generating')
    const started = Date.now()
    try {
      const r = await request('ai.reviewLocal', { repo: state.repo, source, target, staged, agent: agentSel.value, instructions: instructions.value }, 178000)
      if (my !== gen) return
      has = true
      clear(out).append(reviewBody(r.review))
      const leftFiles = r.left?.length ? r.left.slice(0, 5).join(', ') + (r.left.length > 5 ? '…' : '') : ''
      const note = r.left?.length ? ' ' + (r.left.length > 1 ? t('{n} big files were left out: {files}.', { n: r.left.length, files: leftFiles }) : t('{n} big file was left out: {files}.', { n: r.left.length, files: leftFiles })) : ''
      const secs = ((Date.now() - started) / 1000).toFixed(1)
      sync(false, (r.files === 1 ? t('Reviewed {n} file with {name} in {secs}s.', { n: r.files, name, secs }) : t('Reviewed {n} files with {name} in {secs}s.', { n: r.files, name, secs })) + note + ' ' + t('Click a file:line to open it.'), r.verdict)
    } catch (e) {
      if (my !== gen) return
      sync(false, '')
      clear(status).append(h('span', { class: 'ai-error' }, icon('alert', 12), e.message))
    } finally {
      out.classList.remove('generating')
    }
  }
  const close = () => {
    gen++
    stopTick()
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && !busy && isTopOverlay(overlay) && close()
  const box = h(
    'div',
    { class: 'dialog ai-dialog local-review-dialog', role: 'dialog' },
    h('div', { class: 'ai-title' }, h('span', { class: 'ai-badge' }, icon('sparkle', 14)), h('div', null, h('h3', null, staged ? t('Review your changes with AI') : t('Review with AI before the merge request')), h('p', null, staged ? t('Before you commit: the staged changes, or every change when nothing is staged') : t('{source} → {target}: the changes the merge request will show', { source: source || state.status?.branch, target })))),
    h('div', { class: 'ai-row' }, h('div', { class: 'field grow' }, h('label', null, t('Agent')), agentSel)),
    h('div', { class: 'field' }, h('label', null, t('Instructions')), instructions),
    h('div', { class: 'field' }, h('div', { class: 'ai-msg-head' }, h('label', { class: 'row' }, t('Review'), verdictEl), genBtn), out),
    status,
    h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'btn', onClick: () => !busy && close() }, t('Close')), h('span', { class: 'grow dim local-review-note', title: t('Runs on this machine with your AI CLI. Nothing is posted to GitHub or GitLab.') }, t('Nothing is posted')), nextBtn)
  )
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && !busy && close() }, box)
  mountOverlay(overlay, close)
  document.addEventListener('keydown', onKey)
  sync(false, '')
  generate() // start at once: opening it is asking for it
}

/* =========================================================================
   Merge requests: one button pushes the branch and opens the MR/PR
   ========================================================================= */
/** A branch name short enough for a menu line: the middle gives way, both ends stay readable. */
const nm = (b, max = 30) => (b.length > max ? b.slice(0, Math.ceil(max / 2) - 1) + '…' + b.slice(-Math.floor(max / 2) + 1) : b)
/** Merge in menus, always written source → target, the way git and GitLab say it. */
const mergeLabel = (src, dst) => t('Merge {source} → {target}', { source: nm(src), target: nm(dst) })
/** Merge request with another branch, in either direction, each written source → target. */
function mrBoth(other, cur) {
  if (!cur || !other || other === cur) return null
  return {
    label: t('Merge request'),
    icon: 'pr',
    cls: 'mr-item',
    items: [
      { label: `${nm(cur)} → ${nm(other)}…`, full: t('Merge request: {source} → {target}', { source: cur, target: other }), icon: 'pr', cls: 'mr-item', dir: [cur, other], onClick: () => mergeRequestDialog(other) },
      { label: `${nm(other)} → ${nm(cur)}…`, full: t('Merge request: {source} → {target}', { source: other, target: cur }), icon: 'pr', cls: 'mr-item', dir: [other, cur], onClick: () => mergeRequestDialog(cur, other) }
    ]
  }
}
/** Top-level "Merge request" for a commit: between the current branch and the branches at it. */
function mrItem(local, remote, cur) {
  if (!cur) return null
  const targets = [...new Set([...local, ...remote.filter((r) => !r.endsWith('/HEAD')).map((r) => r.replace(/^[^/]+\//, ''))])].filter((b) => b !== cur)
  if (!targets.length) return null
  if (targets.length === 1) return mrBoth(targets[0], cur)
  return { label: t('Merge request'), icon: 'pr', cls: 'mr-item', items: targets.flatMap((b) => [{ label: `${nm(cur)} → ${nm(b)}…`, full: t('Merge request: {source} → {target}', { source: cur, target: b }), icon: 'pr', cls: 'mr-item', dir: [cur, b], onClick: () => mergeRequestDialog(b) }, { label: `${nm(b)} → ${nm(cur)}…`, full: t('Merge request: {source} → {target}', { source: b, target: cur }), icon: 'pr', cls: 'mr-item', dir: [b, cur], onClick: () => mergeRequestDialog(cur, b) }]) }
}
/**
 * Pick people (assignees, reviewers): chips plus a search box with a list of the project's members.
 * `value()` gives [{ id, username }].
 */
function peoplePicker(placeholder, { me, meLabel = t('Assign to me') } = {}) {
  let people = []
  let chosen = []
  let open = false
  let active = 0
  const chips = h('div', { class: 'pp-chips' })
  const input = h('input', { type: 'text', class: 'pp-input', placeholder, autocomplete: 'off', spellcheck: 'false' })
  const list = h('div', { class: 'pp-list hidden', role: 'listbox' })
  const meBtn = h('button', { type: 'button', class: 'link-btn pp-me hidden', onClick: () => me && add(me) }, meLabel)
  const el = h('div', { class: 'pp' }, h('div', { class: 'pp-box', onMousedown: (e) => e.target !== input && (e.preventDefault(), input.focus()) }, chips, input), list)
  const matches = () => {
    const q = input.value.trim().toLowerCase()
    return people.filter((p) => !chosen.some((c) => c.id === p.id) && (!q || p.username.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))).slice(0, 30)
  }
  // plugin pages have no network, so avatar images cannot load: initials instead
  const avatar = (p) => h('span', { class: 'pp-av pp-initial' }, (p.name || p.username || '?')[0].toUpperCase())
  function drawChips() {
    clear(chips)
    for (const c of chosen) chips.append(h('span', { class: 'pp-chip', title: `@${c.username}` }, avatar(c), h('span', null, c.name || c.username), h('button', { type: 'button', class: 'pp-x', title: t('Remove {name}', { name: c.username }), onClick: () => remove(c) }, '×')))
    meBtn.classList.toggle('hidden', !me || chosen.some((c) => c.id === me.id))
  }
  function drawList() {
    const m = matches()
    active = Math.min(active, Math.max(0, m.length - 1))
    clear(list)
    if (!people.length) list.append(h('div', { class: 'pp-empty dim' }, t('No members found')))
    else if (!m.length) list.append(h('div', { class: 'pp-empty dim' }, t('No match')))
    m.forEach((p, i) =>
      list.append(
        h('div', { class: `pp-item ${i === active ? 'on' : ''}`, role: 'option', onMousedown: (e) => (e.preventDefault(), add(p)) }, avatar(p), h('span', { class: 'pp-name' }, p.name), h('span', { class: 'dim mono' }, `@${p.username}`))
      )
    )
    list.classList.toggle('hidden', !open)
  }
  function add(p) {
    if (!chosen.some((c) => c.id === p.id)) chosen.push(p)
    input.value = ''
    drawChips()
    drawList()
  }
  function remove(p) {
    chosen = chosen.filter((c) => c.id !== p.id)
    drawChips()
    drawList()
  }
  input.addEventListener('focus', () => ((open = true), drawList()))
  input.addEventListener('blur', () => ((open = false), drawList()))
  input.addEventListener('input', () => ((active = 0), (open = true), drawList()))
  input.addEventListener('keydown', (e) => {
    const m = matches()
    if (e.key === 'ArrowDown') (e.preventDefault(), (active = Math.min(active + 1, m.length - 1)), drawList())
    else if (e.key === 'ArrowUp') (e.preventDefault(), (active = Math.max(active - 1, 0)), drawList())
    else if (e.key === 'Enter' && open && m[active]) (e.preventDefault(), add(m[active]))
    else if (e.key === 'Backspace' && !input.value && chosen.length) remove(chosen[chosen.length - 1])
    else if (e.key === 'Escape' && open) (e.stopPropagation(), (open = false), drawList())
  })
  drawChips()
  return {
    el,
    meBtn,
    setPeople(list2, me2) {
      people = list2 || []
      me = me2 || me
      chosen = chosen.map((c) => people.find((p) => p.id === c.id) || c)
      drawChips()
      drawList()
    },
    set(list2) {
      chosen = (list2 || []).slice()
      drawChips()
    },
    value: () => chosen.map((c) => ({ id: c.id, username: c.username, name: c.name, avatar: c.avatar })),
    focusInput: () => input.focus()
  }
}

async function mergeRequestDialog(target, source, swapped) {
  closeOverlays()
  let info
  setBusy(1)
  try {
    info = await request('mr.info', { repo: state.repo, target, source }, 30000)
  } catch (e) {
    return toast(e.message, 'error')
  } finally {
    setBusy(-1)
  }
  if (info.source === info.target) return toast(t('You are on {branch}. Check out the branch you want to merge, then try again.', { branch: info.target }), 'error')
  // Nothing to merge this way but commits the other way: the person meant the reverse (e.g. on main,
  // right-clicking a feature branch). Flip once, and say so.
  if (!info.commits.length && info.reverse > 0 && !swapped) {
    toast(t('{source} has nothing new for {target}, so this is {target} → {source} instead.', { source: info.source, target: info.target }), 'ok', 5000)
    return mergeRequestDialog(info.source, info.target, true)
  }
  if (!info.commits.length) return toast(t('{source} and {target} have the same commits: there is nothing to merge.', { source: info.source, target: info.target }), 'error')
  const isGh = info.kind === 'github'
  const noun = isGh ? t('pull request') : t('merge request')
  const service = isGh ? 'GitHub' : info.host
  const repo = state.repo
  const humanize = (b) => b.replace(/^[\w-]+\//, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase())

  const title = h('input', { type: 'text' })
  title.value = info.defaults?.title ?? (info.commits.length === 1 ? info.commits[0] : humanize(info.source))
  const body = h('textarea', { rows: 8, placeholder: t('What changed and why') })
  body.value = info.defaults?.body ?? info.commits.map((c) => `- ${c}`).join('\n')
  const draft = h('input', { type: 'checkbox' })
  draft.checked = !!info.defaults?.draft
  // People and merge options, as on the service's own form. Members load in the background.
  const peopleKey = `mrPeople:${info.host}/${info.path || ''}`
  const remembered = store.get(peopleKey, null)
  const assignees = peoplePicker(t('Search…'))
  const reviewers = peoplePicker(t('Search…'), { meLabel: t('Add me') })
  if (remembered?.reviewers) reviewers.set(remembered.reviewers)
  const removeSource = h('input', { type: 'checkbox' })
  removeSource.checked = true // GitLab's default for a new merge request
  const squash = h('input', { type: 'checkbox' })
  const peopleNote = h('div', { class: 'dim pp-note' }, h('span', { class: 'spinner' }), t('Loading members…'))
  const gitlabOpts = !isGh && h('div', { class: 'mr-opts' }, h('label', { class: 'check' }, removeSource, t('Delete source branch when merge request is accepted')), h('label', { class: 'check' }, squash, t('Squash commits when merge request is accepted')))
  request('mr.people', { repo, query: '' }, 30000).then(
    (r) => {
      peopleNote.remove()
      if (!r.via) {
        const msg = h('div', { class: 'dim pp-note' }, t('Sign in to {cli} or Git to pick people here, or choose them on the web page with Open link', { cli: info.tools.cli }))
        assignees.el.before(msg)
        return
      }
      assignees.setPeople(r.people, r.me)
      reviewers.setPeople(r.people, r.me)
      // nobody is picked for you: "Assign to me" stays one click away
      if (!isGh && r.defaults) {
        if (typeof r.defaults.removeSource === 'boolean') removeSource.checked = r.defaults.removeSource // the project's setting
        squash.checked = !!r.defaults.squash
        squash.disabled = !!r.defaults.squashLocked
      }
    },
    (e) => ((peopleNote.textContent = t('Could not load members: {error}', { error: e.message })), null)
  )
  const note = h('div', { class: 'mr-status' })
  const linkBtn = h('button', { type: 'button', class: 'btn' })
  const createBtn = h('button', { type: 'button', class: 'btn primary' })

  const drawButtons = () => {
    clear(linkBtn).append(icon('open', 13), t('Open link'))
    linkBtn.title = t('Push, then open {service} with this filled in; press Create there. Nothing to install.', { service })
    const can = !!info.tools.via
    clear(createBtn).append(icon('merge', 13), can ? t('Create now') : t('Set up & create'))
    createBtn.title = can ? t('Push and create the {noun} on {service} right here', { noun, service }) : t('Needs {cli}, set up once', { cli: info.tools.cli })
    clear(note)
    if (can)
      note.append(
        icon('check', 13),
        h('span', null, h('b', null, t('Create now')), ' ', info.tools.via === 'git' ? t('makes the {noun} on {service} directly, with the login Git already uses.', { noun, service }) : t('makes the {noun} on {service} directly with {cli}.', { noun, service, cli: info.tools.cli }), ' ', h('b', null, t('Open link')), ' ', t('opens it in your browser instead.'))
      )
    else
      note.append(
        icon('open', 13),
        h(
          'div',
          { class: 'grow' },
          h('div', null, h('b', null, t('Open link')), ' ', t('works right away: {service} opens with this filled in, press Create there.', { service })),
          h('div', { class: 'dim' }, h('b', null, t('Create now')), ' ', info.tools.installed ? t('needs {cli} signed in. Set it up once:', { cli: info.tools.cli }) : t('needs {cli}. Set it up once:', { cli: info.tools.cli })),
          h(
            'div',
            { class: 'mr-steps' },
            !info.tools.installed && info.tools.canInstall && h('button', { type: 'button', class: 'btn sm', onClick: () => setup(isGh ? 'gh-install' : 'glab-install') }, icon('download', 12), t('1. Install {cli}', { cli: info.tools.cli })),
            h('button', { type: 'button', class: 'btn sm', disabled: !info.tools.installed, onClick: () => setup(isGh ? 'gh-login' : 'glab-login') }, icon('user', 12), info.tools.installed ? t('Sign in to {service}', { service }) : t('2. Sign in to {service}', { service })),
            h('button', { type: 'button', class: 'btn sm', onClick: recheck }, icon('refresh', 12), t('Check again'))
          )
        )
      )
  }
  async function setup(step) {
    try {
      const r = await request('mr.setup', { repo, step }, 30000)
      toast(r.ran ? t('Running in a new terminal: {command}\nFollow it there, then press "Check again".', { command: r.command }) : t('Run this in a terminal, then press "Check again":\n{command}', { command: r.command }), 'ok', 10000)
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  async function recheck() {
    try {
      info = await request('mr.info', { repo, target, source: info.source }, 30000)
      drawButtons()
      if (info.tools.via) toast(info.tools.via === 'git' ? t('Your Git login is ready: Create now makes it in one click.') : t('{cli} is ready: Create now makes it in one click.', { cli: info.tools.cli }))
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  let busy = false // creating: Escape and the backdrop do nothing
  let sent = false // finished: nothing left to lose
  const original = { title: title.value, body: body.value }
  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  // Escape / backdrop: ignored while creating; asks first when the title or description were edited.
  const softClose = async () => {
    if (busy) return
    if (!sent && (title.value !== original.title || body.value !== original.body)) {
      if (!(await confirmBox(t('Discard this {noun}?', { noun }), t('The title and description you edited are lost.'), t('Discard'), true))) return
    }
    close()
  }
  const onKey = (e) => e.key === 'Escape' && isTopOverlay(overlay) && (e.preventDefault(), softClose())
  const finished = (headline, url, sub, openLabel) => {
    sent = true
    clear(form).append(
      h('div', { class: 'mr-done' }, icon('check', 22), h('div', null, h('div', { class: 'mr-done-title' }, headline), sub && h('div', { class: 'dim' }, sub))),
      h(
        'div',
        { class: 'buttons' },
        h('button', { type: 'button', class: 'btn', onClick: () => copy(url) }, icon('copy', 13), t('Copy link')),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'btn', onClick: close }, t('Close')),
        h('button', { type: 'button', class: 'btn primary', onClick: () => openLink(url) }, icon('open', 13), openLabel)
      )
    )
  }
  async function submit(web) {
    if (!web && !info.tools.via) {
      // first time: set the CLI up (or just sign in) in a terminal; "Check again" enables one click
      return setup(info.tools.installed ? (isGh ? 'gh-login' : 'glab-login') : isGh ? 'gh-install' : 'glab-install')
    }
    if (!web && !title.value.trim()) return title.focus()
    const btn = web ? linkBtn : createBtn
    busy = true
    linkBtn.disabled = createBtn.disabled = true
    clear(btn).append(h('span', { class: 'spinner' }), info.needsPush ? t('Pushing…') : web ? t('Opening…') : t('Creating…'))
    try {
      const who = { assignees: assignees.value(), reviewers: reviewers.value(), ...(!isGh ? { removeSource: removeSource.checked, squash: squash.checked } : {}) }
      store.set(peopleKey, { reviewers: who.reviewers, assignMe: who.assignees.length > 0 })
      const r = await request('mr.create', { repo, target: info.target, source: info.source, title: title.value, body: body.value, draft: draft.checked, web, ...who }, 120000)
      if (r.warning) toast(r.warning, 'error', 8000)
      const pushed = r.pushed ? t('{branch} pushed to {remote}.', { branch: info.source, remote: info.remote }) + ' ' : ''
      if (web && r.opened) {
        close()
        toast(pushed + t('{service} is open in your browser: check the {noun} and press Create.', { service, noun }), 'ok', 6000)
      } else if (web) finished(t('Ready on {service}', { service }), r.url, pushed + t('Open the page and press Create.'), t('Open {service}', { service }))
      else if (r.created) finished(isGh ? t('Pull request created') : t('Merge request created'), r.url, `${pushed}${info.source} → ${info.target}`, t('Open {noun}', { noun }))
      else finished(t('A {noun} for {branch} already exists', { noun, branch: info.source }), r.url, pushed, t('Open {noun}', { noun }))
      state.history.stale = true
      refreshAll()
    } catch (e) {
      linkBtn.disabled = createBtn.disabled = false
      drawButtons()
      if (!web && (e?.data?.kind === 'git-login-denied' || /git login/i.test(e.message))) {
        // the saved Git login may push but not create merge requests: fall back to the web page
        toast(e.message + ' ' + t('Opening {service} in your browser instead.', { service }), 'error', 7000)
        busy = false
        return submit(true)
      }
      toast(e.message, 'error')
    } finally {
      busy = false
    }
  }
  linkBtn.addEventListener('click', () => submit(true))
  createBtn.addEventListener('click', () => submit(false))

  const form = h(
    'div',
    { class: 'mr-form' },
    h('div', { class: 'mr-route' }, h('span', { class: 'ref' }, icon('branch', 10), h('span', { class: 'ref-t' }, info.source)), icon('right', 14), h('span', { class: 'ref' }, icon('branch', 10), h('span', { class: 'ref-t' }, info.target)), h('button', { type: 'button', class: 'icon-btn', disabled: !(info.reverse > 0), title: info.reverse > 0 ? (info.reverse > 1 ? t('Swap: {target} → {source} ({n} commits)', { target: info.target, source: info.source, n: info.reverse }) : t('Swap: {target} → {source} ({n} commit)', { target: info.target, source: info.source, n: info.reverse })) : t("Can't swap: {target} has nothing that {source} lacks", { target: info.target, source: info.source }), onClick: () => info.reverse > 0 && (close(), mergeRequestDialog(info.source, info.target, true)) }, icon('swap', 14))),
    info.needsPush && h('div', { class: 'dim mr-note' }, icon('push', 12), info.upstream ? t('{branch} has commits not on {remote} yet; it is pushed first.', { branch: info.source, remote: info.remote }) : t('{branch} is not on {remote} yet; it is pushed first.', { branch: info.source, remote: info.remote })),
    h(
      'div',
      { class: 'field' },
      h(
        'label',
        { class: 'row' },
        t('Title'),
        h('span', { class: 'grow' }),
        h(
          'button',
          {
            type: 'button',
            class: 'btn sm',
            title: t('Write the title and description from the whole branch with AI'),
            onClick: async (e) => {
              const b = e.currentTarget
              b.disabled = true
              const t0 = Date.now()
              const tick = () => append(clear(b), [h('span', { class: 'ai-dots' }, h('i'), h('i'), h('i')), t('AI is writing… {n}s', { n: Math.floor((Date.now() - t0) / 1000) })])
              tick()
              const timer = setInterval(tick, 1000)
              title.classList.add('generating')
              body.classList.add('generating')
              title.readOnly = body.readOnly = true
              try {
                const r = await request('ai.mrDescription', { repo, target: info.target, source: info.source, instructions: store.get('aiPrefs', {}).instructions || '' }, 118000)
                if (r.title) title.value = r.title
                if (r.body) body.value = r.body
              } catch (err) {
                toast(err.message, 'error')
              } finally {
                clearInterval(timer)
                title.classList.remove('generating')
                body.classList.remove('generating')
                title.readOnly = body.readOnly = false
                b.disabled = false
                append(clear(b), [icon('wand', 12), t('Write with AI')])
              }
            }
          },
          icon('wand', 12),
          t('Write with AI')
        )
      ),
      aiWrap(title)
    ),
    h('div', { class: 'field' }, h('label', null, t('Description')), aiWrap(body)),
    h('div', { class: 'mr-people' }, peopleNote, h('div', { class: 'field' }, h('label', { class: 'row' }, t('Assignees'), h('span', { class: 'grow' }), assignees.meBtn), assignees.el), h('div', { class: 'field' }, h('label', { class: 'row' }, isGh ? t('Reviewers (Create now only)') : t('Reviewers'), h('span', { class: 'grow' }), reviewers.meBtn), reviewers.el)),
    gitlabOpts,
    h('label', { class: 'check' }, draft, t('Draft (Create now only)')),
    note,
    h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'btn', onClick: close }, t('Cancel')), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn ai-review-btn', title: t('Let AI review these changes before anyone else sees them'), onClick: () => localReviewModal({ source: info.source, target: info.target, onNext: () => {} }) }, icon('sparkle', 13), t('Review with AI first')), linkBtn, createBtn)
  )
  drawButtons()
  const box = h('div', { class: 'dialog mr-dialog', role: 'dialog' }, h('h3', null, isGh ? t('New pull request') : t('New merge request')), form)
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && softClose() }, box)
  mountOverlay(overlay, close)
  document.addEventListener('keydown', onKey)
  title.focus()
  title.select()
}


/* =========================================================================
   Reviews: every open pull/merge request you are asked to review or assigned
   ========================================================================= */
let reviewsLoading = null
let rvSearchBox = null
/** Comment counts seen per merge request (this device): more than that is "new". */
const rvSeen = () => store.get('rvSeen', {})
function rvNewComments(it) {
  if (it.comments == null) return 0
  const seen = rvSeen()
  if (seen[it.url] == null) {
    store.set('rvSeen', { ...seen, [it.url]: it.comments })
    return 0
  }
  return Math.max(0, it.comments - seen[it.url])
}
const rvMarkSeen = (it) => it.comments != null && store.set('rvSeen', { ...rvSeen(), [it.url]: it.comments })
/** Does a review item belong to the open repository (same host and project path as its remote)? */
const inThisRepo = (it, data) => !!data.repoPath && it.repo?.toLowerCase() === data.repoPath.toLowerCase() && (!data.repoHost || !it.host || it.host.toLowerCase() === data.repoHost.toLowerCase())
/** The tab's badge: waiting for me, in this repository unless "All repos" is chosen. */
function reviewCount() {
  // every open one, as the Open tab and the status bar count them (MR / PR shows every repository)
  const d = state.reviews
  if (!d) return 0
  return d.items.filter((it) => isOpenMr(it)).length
}
/** How many of the open ones wait for my approval (the tab's badge stands out when some do). */
function reviewForMe() {
  return (state.reviews?.items || []).filter((it) => needsMe(it)).length
}
/** Waiting for me: I am asked to review it or it is assigned to me, it is not mine, and I have not approved it yet. */
const isMine = (it) => it.roles.includes('mine') || (!!it.me && it.author === it.me)
/** Still open (merged and closed ones are listed only under All). */
const isOpenMr = (it) => !it.state || it.state === 'open'
const needsMe = (it) => isOpenMr(it) && (it.roles.includes('review') || it.roles.includes('assigned')) && !isMine(it) && !it.myApproved
/** Mine to look at: asked to review or assigned, not my own (approved ones stay, marked Waiting merge). */
const forMe = (it) => isOpenMr(it) && (it.roles.includes('review') || it.roles.includes('assigned')) && !isMine(it)
/**
 * Two tabs. Review: everything still open that is mine to act on, asked to review, assigned or opened by
 * me (a tag says which), and it stays there until it is really merged (approved and waiting, pipeline
 * running, queued). All: every merge request of this repository, open and merged.
 */
const RV_TABS = [
  ['todo', t('Open'), (it) => (isOpenMr(it) && (forMe(it) || isMine(it) || it.roles.includes('repo'))) || mergedStillRunning(it)],
  ['all', t('All'), () => true]
]
const ciBusy = (it) => it.ci === 'running' || it.ci === 'pending'
/** Merged in the last hours but its pipeline still runs: it stays in Review until that is done. */
function mergedStillRunning(it) {
  return it.state === 'merged' && !!it.recent && ciBusy(it) && (it.watched || isMine(it) || it.roles.includes('review') || it.roles.includes('assigned') || it.roles.includes('repo'))
}
/**
 * The Review & MR count without opening the tab: the last list at once (from this device), then a
 * fresh one in the background, at most every two minutes per repository.
 */
function prefetchReviews() {
  if (!IN_TAB || !state.repo) return
  if (!state.reviews || state.reviews.repo !== state.repo) {
    const cached = store.get('reviewsCache', null)
    if (cached?.repo === state.repo) (state.reviews = cached), renderTabs()
  }
  const fresh = state.reviews?.repo === state.repo && Date.now() - state.reviews.at < 120000
  if (!fresh && !reviewsLoading) loadReviews(true).catch(() => {})
}
async function loadReviews(force, fresh = false) {
  if (!force && state.reviews && state.reviews.repo === state.repo && Date.now() - state.reviews.at < 120000) return state.reviews
  if (force && state.rvMore?.repo === state.repo && !mergedLoading) state.rvMore = null // a fresh list: merged ones again too
  const repo = state.repo
  reviewsLoading ||= request('reviews.list', { repo, fresh }, 90000) // fresh: the Refresh button, past the shared answer
    .then((r) => {
      // a host that did not answer this time keeps its last list (and its error shows above it)
      const failed = new Set((r.errors || []).map((e) => String(e).split(': ')[0]))
      const prev = state.reviews?.items || []
      const kept = prev.filter((it) => failed.has(it.host) && !r.items.some((x) => x.url === it.url))
      if (kept.length) r = { ...r, items: [...r.items, ...kept].sort((a, b) => b.updated - a.updated) }
      state.reviews = { ...r, repo, at: Date.now() }
      store.set('reviewsCache', state.reviews)
      renderTabs()
      return state.reviews
    })
    .finally(() => (reviewsLoading = null))
  return reviewsLoading
}

let queueChecked = false
async function viewReviews() {
  // merges queued earlier keep running in the worker: show them after a reload too
  if (!queueChecked) (queueChecked = true), watchQueue()
  state.rvSel ||= new Set()
  const root = h('div', { class: 'view reviews' })
  // Show at once: the last list (even from an earlier session) while a fresh one loads behind it.
  if (!state.reviews) state.reviews = store.get('reviewsCache', null)
  const stale = !state.reviews || state.reviews.repo !== state.repo || Date.now() - state.reviews.at >= 120000
  if (stale) {
    const p = loadReviews(true).then(() => state.tab === 'reviews' && renderView({ force: true }))
    if (!state.reviews) {
      p.catch((e) => state.tab === 'reviews' && clear(root).append(h('div', { class: 'empty' }, icon('alert', 28), h('div', null, e.message))))
      root.append(h('div', { class: 'skeleton-list' }, h('div', { class: 'skeleton-row' }, h('span', { class: 'bar' })), h('div', { class: 'skeleton-row' }, h('span', { class: 'bar' })), h('div', { class: 'skeleton-row' }, h('span', { class: 'bar' }))))
      return root
    }
    p.catch(() => {})
  }
  const data = state.reviews
  const filter = RV_TABS.some(([k]) => k === state.reviewFilter) ? state.reviewFilter : 'todo'
  // Open: everyone's by default; For me = asked of me or assigned, Mine = opened by me
  const who = filter === 'todo' ? store.get('rvWho', 'all') : 'all'
  // All is always this repository's; Review can show this repository or every one
  const allRepos = true // MR / PR always shows every repository; the project list narrows to one
  const q = (state.rvQ ||= { text: '', repo: '', label: '' })
  // older merged ones loaded with Show more stay through refreshes (until the project changes)
  const extra = state.rvMore?.repo === state.repo ? state.rvMore : null
  const seen = new Set(data.items.map((it) => it.url))
  const allItems = extra ? data.items.concat(extra.items.filter((it) => !seen.has(it.url))) : data.items
  const inScope = allItems.filter((it) => allRepos || inThisRepo(it, data))
  const words = q.text.toLowerCase().split(/\s+/).filter(Boolean)
  const scoped = inScope.filter(
    (it) =>
      (!q.repo || it.repo === q.repo) &&
      (!q.label || (it.labels || []).includes(q.label)) &&
      words.every((w) => `${it.title} ${it.repo} ${it.author} ${it.source || ''} ${it.number} ${(it.labels || []).join(' ')}`.toLowerCase().includes(w))
  )
  const where = null
  // GitLab-style tabs with counts: To review (waiting for me), Opened by me, All open
  const seg = h(
    'div',
    { class: 'segmented rv-filter rv-tabs' },
    RV_TABS.map(([k, l, fn]) => {
      // each tab counts in its own scope (All: this repository only)
      const pool = k === filter ? scoped : allItems
      let n = pool.filter(fn).length
      // All: every one this repository has, when GitLab told how many were merged (fetched when opened)

      const hot = k === 'todo' && pool.some(needsMe)
      return h('button', { class: filter === k ? 'on' : '', title: k === 'todo' ? t('Every open merge request of the repositories you work in, and the ones asked of you anywhere, until merged') : t('Every merge request of this repository, open and merged'), onClick: () => ((state.reviewFilter = k), state.rvSel.clear(), renderView({ force: true })) }, l, h('span', { class: `rv-n ${hot ? 'hot' : ''}` }, String(n)))
    })
  )
  root.append(
    h(
      'div',
      { class: 'history-bar' },
      where,
      seg,
      // whose: For me · Mine · Everyone (the Open tab)
      filter === 'todo' &&
        h(
          'div',
          { class: 'segmented rv-who' },
          [['all', t('Everyone'), t('Every open one')], ['me', t('For me'), t('Asked to review or assigned to me')], ['can', t('Can merge'), t('The ones you may merge, assigned to you or not')], ['mine', t('Mine'), t('Opened by me')]].map(([k, l, tip]) => h('button', { class: who === k ? 'on' : '', title: tip, onClick: () => (store.set('rvWho', k), state.rvSel.clear(), renderView({ force: true })) }, l, k === 'me' && scoped.some(needsMe) ? h('span', { class: 'rv-n hot' }, String(scoped.filter(needsMe).length)) : null))
        ),
      h('span', { class: 'grow' }),
      h('span', { class: 'dim rv-updated', style: { fontSize: '11.5px' } }, t('Updated {when}', { when: ago(data.at / 1000) })),
      h('button', { class: 'btn sm', onClick: async (e) => ((e.currentTarget.disabled = true), await loadReviews(true, true).catch((err) => toast(err.message, 'error')), renderView({ force: true })) }, icon('refresh', 12), t('Refresh'))
    )
  )

  // search, project and label
  const repos = [...new Set(inScope.map((it) => it.repo).filter(Boolean))].sort()
  const labels = [...new Set(inScope.flatMap((it) => it.labels || []))].sort()
  const rvSearch = (rvSearchBox ||= h('input', {
    type: 'text',
    class: 'rv-search',
    placeholder: t('Filter by title, author, branch, number…'),
    onInput: (e) => {
      // kept at once (a redraw in between must not drop what was typed); only the redraw waits
      state.rvQ.text = e.target.value
      clearTimeout(rvSearchBox._t)
      rvSearchBox._t = setTimeout(() => renderView({ force: true }), 200)
    },
    onKeydown: (e) => e.key === 'Escape' && e.target.value && (e.preventDefault(), (e.target.value = ''), (state.rvQ.text = ''), renderView({ force: true }))
  }))
  if (document.activeElement !== rvSearch) rvSearch.value = q.text
  const pickSel = (key, all, values) =>
    values.length > 1 &&
    h('select', { class: `rv-sel ${q[key] ? 'on' : ''}`, onChange: (e) => ((state.rvQ[key] = e.target.value), renderView({ force: true })) }, h('option', { value: '' }, all), values.map((v) => h('option', { value: v, selected: q[key] === v }, v)))
  const active = q.text || q.repo || q.label
  root.append(
    h(
      'div',
      { class: 'rv-filters' },
      h('div', { class: 'rv-search-wrap' }, icon('search', 12), liveSlot(rvSearch)),
      pickSel('repo', t('All projects'), allRepos ? repos : []),
      pickSel('label', t('All labels'), labels),
      active && h('button', { class: 'btn sm', onClick: () => ((state.rvQ = { text: '', repo: '', label: '' }), (rvSearch.value = ''), renderView({ force: true })) }, icon('x', 12), t('Clear filters'))
    )
  )

  // hosts that are not connected yet
  for (const p of data.providers.filter((x) => !x.signedIn)) {
    const step = (name) => () =>
      request('reviews.setup', { host: p.host, step: name }, 30000).then(
        (r) => toast(r.ran ? t('Running in a new terminal: {command}\nFollow it there, then press Refresh.', { command: r.command }) : t('Run this in a terminal, then press Refresh:\n{command}', { command: r.command }), 'ok', 10000),
        (e) => toast(e.message, 'error')
      )
    root.append(
      h(
        'div',
        { class: 'card setup-card' },
        h('div', { class: 'row' }, icon('globe', 14), h('strong', null, t('Connect {host}', { host: p.host }))),
        h('div', { class: 'dim' }, p.provider === 'github' ? t('See and approve its pull requests here. Needs {cli}, set up once.', { cli: p.cli }) : t('See and approve its merge requests here. Needs {cli}, set up once.', { cli: p.cli })),
        h(
          'div',
          { class: 'actions-wrap' },
          !p.installed && p.canInstall && h('button', { class: 'btn sm', onClick: step(`${p.cli}-install`) }, icon('download', 12), t('1. Install {cli}', { cli: p.cli })),
          h('button', { class: 'btn sm', disabled: !p.installed, onClick: step(`${p.cli}-login`) }, icon('user', 12), p.installed ? t('Sign in') : t('2. Sign in')),
          h('button', { class: 'btn sm', onClick: async () => (await loadReviews(true).catch((e) => toast(e.message, 'error')), renderView({ force: true })) }, icon('refresh', 12), t('Check again'))
        )
      )
    )
  }
  for (const e of data.errors || []) root.append(h('div', { class: 'banner' }, h('div', { class: 'row' }, icon('alert'), h('span', null, e))))

  const whoFn = { me: (it) => forMe(it) || mergedStillRunning(it), can: (it) => it.canMerge === true && isOpenMr(it), mine: (it) => isMine(it), all: () => true }[who] || (() => true)
  const fn0 = RV_TABS.find(([k]) => k === filter)[2]
  const fn = (it) => fn0(it) && whoFn(it)
  // waiting for my approval first, then others asked of me (approved, waiting merge), then my own
  const rank = (it) => (!isOpenMr(it) ? 0 : needsMe(it) ? 3 : forMe(it) ? 2 : 1)
  const items = scoped.filter(fn).sort((a, b) => rank(b) - rank(a))
  const openItems = items.filter(isOpenMr)
  for (const u of [...state.rvSel]) if (!openItems.some((it) => it.url === u)) state.rvSel.delete(u)
  const selAll = h('input', { type: 'checkbox', class: 'rv-check', title: t('Select all'), 'aria-label': t('Select all') })
  selAll.checked = openItems.length > 0 && openItems.every((it) => state.rvSel.has(it.url))
  selAll.indeterminate = !selAll.checked && openItems.some((it) => state.rvSel.has(it.url))
  selAll.addEventListener('change', () => {
    for (const it of openItems) selAll.checked ? state.rvSel.add(it.url) : state.rvSel.delete(it.url)
    root.querySelectorAll('.review-row').forEach((r) => r.classList.toggle('sel', state.rvSel.has(r.dataset.url)))
    root.querySelectorAll('.review-row .rv-check').forEach((c) => (c.checked = state.rvSel.has(c.closest('.review-row').dataset.url)))
    drawBulk()
  })
  root.append(
    h(
      'div',
      { class: 'section-head rv-head' },
      openItems.length > 0 && selAll,
      { todo: { me: t('Asked of you, until merged'), can: t('You may merge these'), mine: t('Opened by you, until merged'), all: t('Open, whoever opened them, until merged') }[who], all: t('Every merge request, open and merged') }[filter],
      h('span', { class: 'count' }, items.length)
    )
  )
  if (!items.length)
    root.append(
      h(
        'div',
        { class: 'empty' },
        icon('check', 28),
        h('div', null, filter === 'todo' ? (who === 'me' ? t('Nothing waits for you') : who === 'can' ? t('Nothing open that you may merge') : who === 'mine' ? t('Nothing of yours is open') : t('No open merge requests')) : t('No merge requests')),
        null
      )
    )
  const list = h('div', { class: 'rv-list' })
  const onSelect = () => ((selAll.checked = openItems.every((x) => state.rvSel.has(x.url))), (selAll.indeterminate = !selAll.checked && openItems.some((x) => state.rvSel.has(x.url))), drawBulk())
  const mergedItems = items.filter((it) => !isOpenMr(it)).sort((a, b) => (b.mergedAt || b.updated) - (a.mergedAt || a.updated))
  if (filter === 'all' && mergedItems.length) {
    // two groups: still open, then merged by day
    list.append(h('div', { class: 'rv-group' }, icon('merge', 12), t('Open'), h('span', { class: 'rv-group-n' }, String(openItems.length))))
    if (!openItems.length) list.append(h('div', { class: 'rv-group-empty dim' }, t('Nothing open')))
    for (const it of openItems) list.append(reviewRow(it, { onSelect, filter }))
    list.append(h('div', { class: 'rv-group rv-group-merged' }, icon('check', 12), t('Merged'), h('span', { class: 'rv-group-n' }, String(mergedItems.length)), h('span', { class: 'rv-group-hint' }, t('latest first'))))
    let day = ''
    for (const it of mergedItems) {
      const d = mergedDay(it.mergedAt || it.updated)
      if (d !== day) list.append(h('div', { class: 'rv-day' }, (day = d)))
      list.append(reviewRow(it, { onSelect, filter }))
    }
  } else if (filter === 'todo' && !words.length && items.length) {
    const groups = new Map()
    for (const it of items) {
      const k = `${it.host}|${it.repo}`
      if (!groups.has(k)) groups.set(k, { key: k, repo: it.repo, group: it.group, items: [] })
      groups.get(k).items.push(it)
    }
    const collapsed = new Set(store.get('rvCollapsed', []))
    const order = (g) => [g.group ? g.group.order : 1e6, g.group ? g.group.repoOrder ?? 1e6 : 0, g.repo.split('/').pop()]
    const sorted = [...groups.values()].sort((a, b) => {
      const [x, y] = [order(a), order(b)]
      return x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2]))
    })
    for (const g of sorted) {
      const shut = collapsed.has(g.key)
      const forYou = g.items.filter(needsMe).length
      list.append(
        h(
          'button',
          { class: `rv-repo-head ${shut ? 'shut' : ''}`, title: `${g.repo}${shut ? ' (show)' : ' (hide)'}`, onClick: () => (shut ? collapsed.delete(g.key) : collapsed.add(g.key), store.set('rvCollapsed', [...collapsed].slice(-200)), renderView({ force: true })) },
          icon(shut ? 'right' : 'down', 11),
          g.group?.name ? h('span', { class: 'rv-repo-grp' }, g.group.name, ' ›') : null,
          h('span', { class: 'rv-repo-name' }, g.repo.split('/').pop()),
          h('span', { class: 'rv-group-n' }, `${g.items.length} open`),
          forYou ? h('span', { class: 'rv-repo-you' }, `${forYou} for you`) : null
        )
      )
      if (!shut) for (const it of g.items) list.append(reviewRow(it, { onSelect, filter }))
    }
  } else for (const it of items) list.append(reviewRow(it, { onSelect, filter, showRepo: true }))
  root.append(list)
  if (filter === 'all') {
    // merged ones are fetched only here, when All is open (GitHub limits how often it is searched)
    if (!extra && !mergedLoading) loadMerged(1)
    root.append(moreMergedFooter(data, extra, words.length > 0 || !!q.repo || !!q.label))
  }

  // the bulk bar: shows when one or more are selected
  const bulk = h('div', { class: 'rv-bulk' })
  function drawBulk() {
    const sel = items.filter((it) => state.rvSel.has(it.url))
    clear(bulk)
    bulk.classList.toggle('on', sel.length > 0)
    if (!sel.length) return
    const approvable = sel.filter((it) => !isMine(it) && !it.myApproved)
    bulk.append(
      h('span', { class: 'rv-bulk-n' }, t('{n} selected', { n: sel.length })),
      h('button', { class: 'btn sm', onClick: () => (state.rvSel.clear(), renderView({ force: true })) }, t('Clear')),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', disabled: !approvable.length, title: approvable.length ? '' : t('Nothing selected that you can approve'), onClick: () => bulkAct('approve', approvable) }, icon('check', 12), approvable.length ? t('Approve {n}', { n: approvable.length }) : t('Approve')),
      h('button', { class: 'btn sm primary', onClick: () => bulkAct('merge', sel) }, icon('merge', 12), approvable.length ? t('Approve & merge {n}', { n: sel.length }) : t('Merge {n}', { n: sel.length }))
    )
  }
  async function bulkAct(action, list) {
    const one = list.length === 1
    if (action === 'merge') {
      const toApprove = list.filter((it) => !isMine(it) && !it.myApproved).length
      const projects = new Set(list.map((it) => it.repo)).size
      const o = await mergeOptionsDialog(list, {
        title: toApprove ? (one ? t('Approve and merge {n} merge request?', { n: list.length }) : t('Approve and merge {n} merge requests?', { n: list.length })) : one ? t('Merge {n} merge request?', { n: list.length }) : t('Merge {n} merge requests?', { n: list.length }),
        message: list.map((it) => `${it.repo} ${mrRef(it)} ${it.title}`).join('\n') + '\n\n' + (toApprove ? t('In the background, {n} approved first.', { n: toApprove }) : t('In the background.')) + ' ' + (projects > 1 ? t('In one project one at a time, rebasing when needed; different projects at the same time.') : t('In one project one at a time, rebasing when needed.')),
        ok: toApprove ? t('Approve & merge') : t('Merge')
      })
      if (!o) return
      state.rvSel.clear()
      return queueMerge(list, true, o)
    }
    if (action === 'approve' && !(await confirmBox(one ? t('Approve {n} merge request?', { n: list.length }) : t('Approve {n} merge requests?', { n: list.length }), list.map((it) => `${it.repo} ${mrRef(it)} ${it.title}`).join('\n'), t('Approve')))) return
    bulk.querySelectorAll('button').forEach((b) => (b.disabled = true))
    await runReviewActions(list, action, root)
  }
  root.append(bulk)
  drawBulk()
  return root
}

/** Approve or merge several, one after another, animating each row; then the list is read again. */
async function runReviewActions(list, action, root) {
  let done = 0
  const failed = []
  for (const it of list) {
    const row = root?.querySelector(`.review-row[data-url="${CSS.escape(it.url)}"]`)
    row?.classList.add('rv-busy')
    try {
      await doReviewAction(it, action)
      done++
      state.rvSel.delete(it.url)
      if (row) await rowDone(row, action, it)
    } catch (e) {
      failed.push(`${mrRef(it)}: ${e.message}`)
      row?.classList.remove('rv-busy')
      row?.classList.add('rv-shake')
      setTimeout(() => row?.classList.remove('rv-shake'), 600)
    }
  }
  if (done) toast(done === 1 ? { approve: t('Approved {n} {noun}', { n: done, noun: mrNounShort(list[0]) }), unapprove: t('Approval revoked for {n} {noun}', { n: done, noun: mrNounShort(list[0]) }), merge: t('Merged {n} {noun}', { n: done, noun: mrNounShort(list[0]) }) }[action] : { approve: t('Approved {n} merge requests', { n: done }), unapprove: t('Approval revoked for {n} merge requests', { n: done }), merge: t('Merged {n} merge requests', { n: done }) }[action])
  if (failed.length) toast(failed.join('\n'), 'error', 9000)
  await refreshReviewsAfterAction()
}
const mrNounShort = (it) => (it.provider === 'github' ? t('pull request') : t('merge request'))

/* ---- the merge queue: merges run in the worker, one at a time per project; rows show where each is ---- */
state.mergeQueue = new Map() // url -> { state, note, position, error }
const Q_DONE = new Set(['merged', 'failed', 'auto'])
let queueTimer = null
/**
 * Ask how to merge, the way the merge request page does: delete the source branch, squash. One
 * merge request: its own settings ticked. Several: keep each one's own, or the same for all.
 * Resolves the options (undefined = each one's own), or null when cancelled.
 */
async function mergeOptionsDialog(list, { title, message, ok }) {
  const gl = list.some((it) => it.provider !== 'github')
  let def = null
  if (list.length === 1) {
    setBusy(1)
    def = await request('reviews.detail', { ...list[0], ci: undefined }, 60000).then((d) => d.merge, () => null)
    setBusy(-1)
  }
  const fields =
    list.length === 1
      ? [
          { key: 'removeSource', label: t('Delete source branch'), type: 'check', value: def ? !!def.removeSource : true },
          ...(gl ? [{ key: 'squash', label: t('Squash commits'), type: 'check', value: def ? !!def.squash : false }] : [])
        ]
      : [
          { key: 'removeSource', label: t('Delete source branches'), type: 'select', value: 'own', options: [['own', t("Each one's own setting")], ['yes', t('Delete them')], ['no', t('Keep them')]] },
          ...(gl ? [{ key: 'squash', label: t('Squash commits'), type: 'select', value: 'own', options: [['own', t("Each one's own setting")], ['yes', t('Squash')], ['no', t("Don't squash")]] }] : [])
        ]
  const r = await dialog({ title, message, fields, ok })
  if (!r) return null
  const pick = (v) => (v === true || v === 'yes' ? true : v === false || v === 'no' ? false : undefined)
  return { removeSource: pick(r.removeSource), squash: gl ? pick(r.squash) : undefined }
}

async function queueMerge(list, approve, options) {
  let r
  try {
    r = await request('reviews.queue', { approve, items: list.map((it) => ({ ...it, ci: undefined, options, wantApprove: approve && !isMine(it) && !it.myApproved })) }, 30000)
  } catch (e) {
    return toast(e.message, 'error')
  }
  applyQueue(r)
  if (list.length > 1) toast(t('{n} merge requests queued: they merge in the background, one at a time in each project', { n: list.length }))
  if (state.tab === 'reviews') renderView({ force: true })
  watchQueue()
}
function applyQueue(r) {
  const prev = state.mergeQueue
  state.mergeQueue = new Map((r?.jobs || []).map((j) => [j.url, j]))
  for (const [url, j] of state.mergeQueue) {
    const p = prev.get(url)
    if (!p || p.state === j.state) continue
    const ref = `${j.repo} !${j.number}`
    if (j.state === 'merged') {
      toast(t('Merged {ref}', { ref }))
      // it stays where it is, now marked merged (a pipeline usually runs after the merge); the next
      // list says whether it still runs (it stays) or is done (it leaves then, once), never gone and back
      const items = state.reviews?.items
      const it = items?.find((x) => x.url === url)
      if (it) Object.assign(it, { state: 'merged', recent: true, watched: true, mergedAt: Date.now() / 1000, ci: ciBusy(it) ? it.ci : 'pending' })
      if (state.tab === 'reviews') renderView({ force: true })
    } else if (j.state === 'failed') toast(t('{ref} was not merged: {error}', { ref, error: j.error }), 'error', 9000)
    else if (j.state === 'auto') toast(t('{ref} merges by itself when its pipeline passes', { ref }))
  }
  paintQueueRows()
}
function paintQueueRow(row) {
  const j = state.mergeQueue.get(row.dataset.url)
  const badge = row.querySelector('.rv-result')
  if (!badge || row.classList.contains('rv-done') || (j && j.state === 'merged')) return
  const busy = !!j && !Q_DONE.has(j.state)
  row.classList.toggle('rv-queued', busy)
  row.querySelectorAll('.rv-merge, .rv-approve').forEach((b) => (b.disabled = busy))
  if (!j) {
    if (badge.dataset.q) delete badge.dataset.q, clear(badge)
    return
  }
  badge.dataset.q = '1'
  badge.title = j.error || j.note || ''
  const pill = (cls, ...kids) => h('span', { class: `rv-q ${cls}` }, ...kids)
  clear(badge).append(
    j.state === 'queued'
      ? pill('wait', icon('history', 11), j.position > 1 ? t('In line · {n}', { n: j.position }) : t('Next in line'))
      : j.state === 'failed'
        ? pill('bad', icon('alert', 11), t('Not merged'))
        : j.state === 'auto'
          ? pill('wait', icon('pipeline', 11), t('Merges when CI passes'))
          : pill('run', h('span', { class: 'spinner' }), j.note)
  )
}
const paintQueueRows = () => document.querySelectorAll('.review-row[data-url]').forEach(paintQueueRow)
/** While anything is queued or running, ask the worker how it goes; at the end, read the list again. */
function watchQueue() {
  if (queueTimer) return
  const tick = async () => {
    let r = null
    try {
      r = await request('reviews.queueState', {}, 15000)
    } catch {}
    if (r) applyQueue(r)
    const active = [...state.mergeQueue.values()].some((j) => !Q_DONE.has(j.state))
    queueTimer = active ? setTimeout(tick, 2500) : null
    if (!active && r?.jobs?.length) refreshReviewsAfterAction()
  }
  queueTimer = setTimeout(tick, 1200)
}

/** One action on one item. Merge reads the item first, so it is merged only when it can be, with its defaults. */
async function doReviewAction(it, action, options) {
  if (action === 'merge' && !options) {
    const d = await request('reviews.detail', { ...it, ci: undefined }, 90000)
    if (d.state !== 'open') throw new Error(t('it is already {state}', { state: d.state }))
    if (!d.merge?.ready && !d.merge?.canAuto) throw new Error(d.merge?.reason || t('it cannot be merged yet'))
    options = { squash: d.merge.squash, removeSource: d.merge.removeSource, auto: !d.merge.ready }
  }
  const r = await request('reviews.act', { ...it, ci: undefined, action, options }, 90000)
  // the list changes at once; the real data follows
  const items = state.reviews?.items
  if (items) {
    const i = items.findIndex((x) => x.url === it.url)
    if (i >= 0) {
      if (action === 'merge' && r?.state === 'merged') items.splice(i, 1)
      else if (action === 'approve') items[i] = { ...items[i], myApproved: true, approvedCount: (items[i].approvedCount || 0) + 1 }
      else if (action === 'unapprove') items[i] = { ...items[i], myApproved: false, approvedCount: Math.max(0, (items[i].approvedCount || 1) - 1) }
    }
  }
  return r
}

/** The row says what happened (a check, a colour), then leaves the list when it no longer belongs there. */
async function rowDone(row, action, it) {
  row.classList.remove('rv-busy')
  row.classList.add('rv-done', `rv-done-${action}`)
  const badge = row.querySelector('.rv-result')
  if (badge) append(clear(badge), [icon(action === 'merge' ? 'merge' : 'check', 12), { approve: t('Approved · waiting merge'), unapprove: t('Approval revoked'), merge: t('Merged') }[action]])
  await new Promise((r) => setTimeout(r, 650))
  const stays = action !== 'merge'
  if (stays) return
  row.style.height = row.offsetHeight + 'px'
  row.offsetHeight // start the collapse from the current height
  row.classList.add('rv-leave')
  await new Promise((r) => setTimeout(r, 320))
  row.remove()
}

/** After any action: read the list again from GitHub/GitLab (with a retry, as they take a moment). */
async function refreshReviewsAfterAction() {
  if (state.tab === 'reviews') renderView({ force: true })
  renderTabs()
  await new Promise((r) => setTimeout(r, 700))
  await loadReviews(true).catch(() => {})
  if (state.tab === 'reviews') renderView({ force: true })
}

/** Merged ones grouped by day: Today, Yesterday, This week, then the month. */
function mergedDay(ts) {
  const d = new Date(ts * 1000)
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const days = Math.floor((start - d) / 86400000) + 1
  if (d >= start) return t('Today')
  if (days <= 1) return t('Yesterday')
  if (days < 7) return t('Last 7 days')
  if (d.getMonth() === start.getMonth() && d.getFullYear() === start.getFullYear()) return t('Earlier this month')
  return d.toLocaleDateString(LANG, { month: 'long', year: d.getFullYear() === start.getFullYear() ? undefined : 'numeric' })
}

/** The foot of All: Show more merged (the next 20 of each list), or that there are no more. */
let mergedLoading = null
/** One page of merged ones into state.rvMore; the list redraws when it lands. */
function loadMerged(page) {
  const repo = state.repo
  mergedLoading = request('reviews.moreMerged', { repo, page }, 60000)
    .then((r) => {
      const prev = page > 1 && state.rvMore?.repo === repo ? state.rvMore.items : []
      const got = r.items || []
      state.rvMore = { repo, page, more: !!r.moreMerged && got.length > 0, items: prev.concat(got) }
      if (page > 1 && !got.length) toast(t('No older merged merge requests'))
    })
    .catch((e) => {
      if (page === 1) state.rvMore = { repo, page: 1, more: false, items: [], error: e.message }
      else toast(e.message, 'error')
    })
    .finally(() => {
      mergedLoading = null
      if (state.tab === 'reviews' && state.repo === repo) renderView({ force: true })
    })
  return mergedLoading
}
function moreMergedFooter(data, extra, filtering) {
  const foot = h('div', { class: 'rv-more' })
  if (!extra || (mergedLoading && extra.page === 1 && !extra.items.length)) {
    foot.append(h('span', { class: 'dim' }, h('span', { class: 'spinner sm' }), t('Loading merged merge requests…')))
    return foot
  }
  if (extra.error) {
    foot.append(h('span', { class: 'dim' }, icon('alert', 12), extra.error), h('button', { class: 'btn sm', onClick: () => ((state.rvMore = null), loadMerged(1), renderView({ force: true })) }, t('Try again')))
    return foot
  }
  const more = extra.more
  if (!more) {
    if (extra || data.items.some((it) => !isOpenMr(it))) foot.append(h('span', { class: 'dim' }, icon('check', 12), t('No older merged merge requests')))
    return foot
  }
  const btn = h('button', { class: 'btn rv-more-btn', title: t('Load the next older merged merge requests') }, icon('down', 12), t('Show more merged'))
  btn.addEventListener('click', async () => {
    btn.disabled = true
    clear(btn).append(h('span', { class: 'spinner sm' }), t('Loading older merged…'))
    const page = (extra?.page || 1) + 1
    try {
      const r = await request('reviews.moreMerged', { repo: state.repo, page }, 60000)
      const prev = state.rvMore?.repo === state.repo ? state.rvMore.items : []
      const got = r.items || []
      state.rvMore = { repo: state.repo, page, more: !!r.moreMerged && got.length > 0, items: prev.concat(got) }
      renderView({ force: true })
      if (!got.length) toast(t('No older merged merge requests'))
    } catch (e) {
      toast(e.message, 'error')
      btn.disabled = false
      clear(btn).append(icon('down', 12), t('Show more merged'))
    }
  })
  foot.append(btn)
  if (filtering) foot.append(h('span', { class: 'dim rv-more-hint' }, t('Search and filters look only at what is loaded: show more to search older ones')))
  return foot
}

function reviewRow(it, { onSelect, filter, showRepo = filter === 'all' } = {}) {
  const open = () => openLink(it.url)
  const noun = it.provider === 'github' ? t('pull request') : t('merge request')
  const show = () => reviewDetailSheet(it)
  const check = h('input', { type: 'checkbox', class: 'rv-check', 'aria-label': t('Select {ref}', { ref: mrRef(it) }), onClick: (e) => e.stopPropagation() })
  check.checked = state.rvSel.has(it.url)
  check.addEventListener('change', () => {
    check.checked ? state.rvSel.add(it.url) : state.rvSel.delete(it.url)
    row.classList.toggle('sel', check.checked)
    onSelect?.()
  })
  const act = (action) => async (e) => {
    e.stopPropagation()
    const b = e.currentTarget
    if (action === 'merge') {
      // the same choices as the merge request page: delete the source branch, squash
      const o = await mergeOptionsDialog([it], { title: t('Merge {ref}?', { ref: mrRef(it) }), message: `${it.repo} ${mrRef(it)}\n${it.title}\n\n` + (ciBusy(it) ? t('It merges in the background, as soon as the pipeline passes; another merge in this project goes first.') : t('It merges in the background; another merge in this project goes first.')), ok: ciBusy(it) ? t('Merge when CI passes') : t('Merge') })
      if (!o) return
      return queueMerge([it], false, o)
    }
    b.disabled = true
    clear(b).append(h('span', { class: 'spinner' }))
    await runReviewActions([it], action, row.closest('.view'))
  }
  const approvals = it.approvedCount != null && h('span', { class: `rv-appr ${it.approvalsRequired && it.approvedCount >= it.approvalsRequired ? 'ok' : ''}`, title: t('Approvals') }, icon('check', 10), it.approvalsRequired ? `${it.approvedCount}/${it.approvalsRequired}` : String(it.approvedCount))
  const done = !isOpenMr(it)
  const row = h(
    'div',
    { class: `review-row ${state.rvSel.has(it.url) ? 'sel' : ''} ${done ? 'rv-done' : ''}`, 'data-url': it.url, role: 'button', tabindex: 0, title: t('Open {ref}', { ref: mrRef(it) }), onClick: show, onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), show()) },
    done ? h('span', { class: 'rv-check-gap' }) : check,
    h('span', { class: 'review-icon', title: it.state === 'merged' ? t('Merged') : it.state === 'closed' ? t('Closed') : t('Open') }, icon('merge', done ? 13 : 15)),
    h(
      'div',
      { class: 'grow', style: { minWidth: 0 } },
      h(
        'div',
        { class: 'review-title' },
        showRepo ? h('span', { class: 'pill rv-repo-chip', title: it.repo }, it.repo.split('/').pop()) : null,
        h('span', { class: 'ellipsis', title: it.title }, it.title),
        it.state === 'closed' && h('span', { class: 'pill rv-closed' }, t('Closed')),
        mergedStillRunning(it) && h('span', { class: 'pill rv-merged-run', title: t('Merged; its pipeline is still running') }, icon('merge', 10), t('Merged · pipeline running')),
        !done && it.draft && h('span', { class: 'pill' }, t('Draft')),
        it.roles.includes('review') && h('span', { class: 'pill role' }, t('Review requested')),
        it.roles.includes('assigned') && h('span', { class: 'pill role' }, t('Assigned')),
        isMine(it) && isOpenMr(it) && h('span', { class: 'pill role rv-mine', title: t('You opened it') }, t('Opened by me')),
        isOpenMr(it) && it.noAssignee && (it.noReviewer || it.provider === 'github') && !isMine(it) && !it.roles.includes('review') && h('span', { class: 'pill rv-noreviewer', title: it.provider === 'github' ? t('Nobody is assigned') : t('Nobody is assigned and nobody was asked to review it') }, t('Unassigned')),
        isOpenMr(it) && it.noReviewer && !it.noAssignee && !isMine(it) && !it.roles.includes('review') && h('span', { class: 'pill rv-noreviewer', title: t('Nobody was asked to review it') }, t('No reviewer')),
        isOpenMr(it) && it.canMerge === true && !forMe(it) && !isMine(it) && h('span', { class: 'pill rv-canmerge', title: t('You may merge it (your role in the project allows it)') }, icon('merge', 10), t('You can merge')),
        it.ci && !ciBusy(it) && h('span', { class: `ci ci-${it.ci}`, title: t('CI: {state}', { state: it.ci }) }, ciIcon(it.ci), it.ci), // a running one: the pill below says it
        approvals,
        it.myApproved && h('span', { class: 'pill rv-waiting', title: t('You approved it; it is not merged yet') }, icon('check', 10), t('Approved · waiting merge')),
        it.conflicts && h('span', { class: 'pill rv-conflict', title: t('Merge conflicts: resolve them before merging') }, icon('alert', 10), t('Conflicts')),
        isOpenMr(it) && ciBusy(it) && h('span', { class: 'pill rv-running', title: t('The pipeline is still running') }, h('span', { class: 'spinner sm' }), t('Pipeline running')),
        (() => {
          const n = rvNewComments(it)
          return n > 0 && h('span', { class: 'pill rv-new', title: t('New since you last opened it') }, n > 1 ? t('{n} new comments', { n }) : t('{n} new comment', { n }))
        })(),
        ...(it.labels || []).slice(0, 3).map((l) => h('span', { class: 'pill rv-label' }, l))
      ),
      h(
        'div',
        { class: 'review-meta' },
        h('span', { class: 'mono' }, `${it.repo} ${it.provider === 'github' ? '#' : '!'}${it.number}`),
        ` · ${it.author} · ${it.state === 'merged' && it.mergedAt ? t('merged {ago}', { ago: ago(it.mergedAt) }) : ago(it.updated)}`,
        it.source && [' · ', h('span', { class: 'mono' }, `${it.source} → ${it.target}`)]
      )
    ),
    h(
      'div',
      { class: 'review-actions' },
      h('span', { class: 'rv-result' }),
      !done && !isMine(it) && !it.myApproved && h('button', { class: 'btn sm rv-approve', title: t('Approve {ref}', { ref: mrRef(it) }), onClick: act('approve') }, icon('check', 12), t('Approve')),
      !done && h('button', { class: `btn sm rv-merge ${it.myApproved || isMine(it) ? 'primary' : ''}`, title: ciBusy(it) ? t('GitLab merges {ref} as soon as its pipeline passes', { ref: mrRef(it) }) : t('Merge {ref} now (if it can be merged)', { ref: mrRef(it) }), onClick: act('merge') }, icon('merge', 12), ciBusy(it) ? t('Merge when CI passes') : t('Merge now')),
      h('button', { class: 'icon-btn', title: t('Open the {noun} in the browser', { noun }), onClick: (e) => (e.stopPropagation(), open()) }, icon('open', 14)),
      h('span', { class: 'review-chev', 'aria-hidden': 'true' }, icon('right', 14))
    )
  )
  if (state.mergeQueue.size) paintQueueRow(row)
  return row
}

async function actOnReview(it, action, body, btn) {
  const label = btn ? [...btn.childNodes] : null
  if (btn) {
    btn.disabled = true
    clear(btn).append(h('span', { class: 'spinner' }), t('Sending…'))
  }
  try {
    await request('reviews.act', { ...it, ci: undefined, action, body }, 90000)
    toast({ approve: t('Approved: {title}', { title: it.title }), changes: t('Changes requested: {title}', { title: it.title }), comment: t('Comment posted: {title}', { title: it.title }) }[action])
    if (action === 'approve' || action === 'changes') {
      const its = state.reviews?.items
      const i = its ? its.findIndex((x) => x.url === it.url) : -1
      if (i >= 0 && action === 'approve') its[i] = { ...its[i], myApproved: true, approvedCount: (its[i].approvedCount || 0) + 1 }
      refreshReviewsAfterAction()
    }
    return true
  } catch (e) {
    toast(e.message, 'error')
    if (btn) {
      btn.disabled = false
      clear(btn).append(...label)
    }
    return false
  }
}


/** AI review of a pull/merge request: generate, edit, then post as comment, request changes or approve. */
async function aiReviewModal(it) {
  closeOverlays()
  const noun = it.provider === 'github' ? t('pull request') : t('merge request')
  const prefs = store.get('aiReviewPrefs', { instructions: '' })
  let agents = [
    { id: 'claude', name: 'Claude Code', available: true },
    { id: 'codex', name: 'Codex', available: true }
  ]
  let agent = 'claude'
  let gen = 0
  let busy = false
  let verdict = 'comment'

  const agentSel = h('select', { onChange: () => request('ai.settings', { agent: agentSel.value }).catch(() => {}) })
  const fillAgents = () => {
    clear(agentSel)
    for (const a of agents) agentSel.append(h('option', { value: a.id, selected: a.id === agent, disabled: !a.available }, a.available ? a.name : t('{name} (not installed)', { name: a.name })))
  }
  fillAgents()
  request('ai.settings', {}, 20000)
    .then((r) => ((agents = r.agents), (agent = r.agent), fillAgents()))
    .catch(() => {})
  const instructions = h('textarea', { rows: 2, placeholder: t('Optional, e.g. "Write in Thai", "Focus on security", "We use React Query"') })
  instructions.value = prefs.instructions || ''
  const result = h('textarea', { class: 'ai-result', rows: 12, placeholder: t('The review appears here. Edit it before posting.') })
  const status = h('div', { class: 'ai-status' })
  const verdictEl = h('span', { class: 'pill' })
  const genBtn = h('button', { type: 'button', class: 'btn sm ai-gen', onClick: () => generate() })
  const postBtns = {
    comment: h('button', { type: 'button', class: 'btn', onClick: () => post('comment') }, icon('edit', 13), t('Comment')),
    changes: h('button', { type: 'button', class: 'btn danger', onClick: () => post('changes') }, icon('x', 13), t('Request changes')),
    approve: h('button', { type: 'button', class: 'btn', onClick: () => post('approve') }, icon('check', 13), t('Approve'))
  }
  let stopTick = () => {}
  const sync = (on, text) => {
    busy = on
    result.classList.toggle('generating', on)
    result.readOnly = on
    stopTick()
    if (on) stopTick = aiTicker(status, agents.find((a) => a.id === agentSel.value)?.name || 'AI', t('the {noun}', { noun }))
    else append(clear(status), [text || ''])
    append(clear(genBtn), [on ? [icon('x', 13), t('Stop')] : [icon(result.value.trim() ? 'refresh' : 'wand', 13), result.value.trim() ? t('Review again') : t('Start review')]])
    genBtn.className = `btn sm ai-gen ${on ? 'stop' : ''}`
    const has = !on && !!result.value.trim()
    for (const [k, b] of Object.entries(postBtns)) {
      b.disabled = !has
      b.classList.toggle('primary', has && k === verdict)
    }
    verdictEl.className = `pill verdict-${verdict}`
    verdictEl.textContent = has ? { approve: t('AI suggests: Approve'), changes: t('AI suggests: Request changes'), comment: t('AI suggests: Comment') }[verdict] : ''
  }
  result.addEventListener('input', () => sync(false, status.textContent))

  async function generate() {
    if (busy) {
      gen++
      return sync(false, t('Stopped.'))
    }
    const my = ++gen
    store.set('aiReviewPrefs', { instructions: instructions.value })
    const name = agents.find((a) => a.id === agentSel.value)?.name || 'AI'
    sync(true, t('{name} is reading the {noun}…', { name, noun }))
    const started = Date.now()
    try {
      const r = await request('ai.review', { ...it, ci: undefined, agent: agentSel.value, instructions: instructions.value }, 118000)
      if (my !== gen) return
      result.value = r.review
      verdict = r.verdict
      sync(false, t('Reviewed by {name} in {secs}s. Check it before posting: it is posted under your name.', { name, secs: ((Date.now() - started) / 1000).toFixed(1) }))
    } catch (e) {
      if (my !== gen) return
      sync(false, '')
      clear(status).append(h('span', { class: 'ai-error' }, icon('alert', 12), e.message))
    }
  }
  async function post(action) {
    const text = result.value.trim()
    if (!text) return
    const label = { approve: t('Approve'), changes: t('Request changes'), comment: t('Comment') }[action]
    if (!(await confirmBox({ approve: t('Approve with this review?'), changes: t('Request changes with this review?'), comment: t('Comment with this review?') }[action], `${it.repo} ${it.provider === 'github' ? '#' : '!'}${it.number}\n` + t('The review is posted on {host} under your name.', { host: it.host }), label, action === 'changes'))) return
    const b = postBtns[action]
    b.disabled = true
    if (await actOnReview(it, action, text)) close()
    else b.disabled = false
  }
  const close = () => {
    gen++
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && !busy && isTopOverlay(overlay) && close()

  const box = h(
    'div',
    { class: 'dialog ai-dialog ai-review-dialog', role: 'dialog' },
    h('div', { class: 'ai-title' }, h('div', null, h('h3', null, t('AI review')), h('p', null, `${it.repo} ${it.provider === 'github' ? '#' : '!'}${it.number} · ${it.title}`))),
    h('div', { class: 'ai-row' }, h('div', { class: 'field grow' }, h('label', null, t('Agent')), agentSel)),
    h('div', { class: 'field' }, h('label', null, t('Instructions')), instructions),
    h('div', { class: 'field' }, h('div', { class: 'ai-msg-head' }, h('label', { class: 'row' }, t('Review'), verdictEl), genBtn), aiWrap(result)),
    status,
    h('div', { class: 'buttons' }, h('button', { type: 'button', class: 'btn', onClick: close }, t('Close')), h('span', { class: 'grow' }), postBtns.comment, postBtns.changes, postBtns.approve)
  )
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && !busy && close() }, box)
  mountOverlay(overlay, close)
  document.addEventListener('keydown', onKey)
  sync(false, t('Choose the agent, add instructions if you like, then press Start review.'))
  genBtn.focus() // choose the agent and add instructions first, then Start review
}

async function reviewDialog(it, preset = 'approve') {
  const noun = it.provider === 'github' ? t('pull request') : t('merge request')
  const r = await dialog({
    title: t('Review: {title}', { title: it.title }),
    message: t('{ref} by {author}', { ref: `${it.repo} ${it.provider === 'github' ? '#' : '!'}${it.number}`, author: it.author }),
    fields: [
      {
        key: 'action',
        label: t('Your review'),
        type: 'select',
        value: preset,
        options: [
          ['approve', t('Approve')],
          ['changes', t('Request changes')],
          ['comment', t('Comment only')]
        ]
      },
      { key: 'body', label: t('Comment (needed for Request changes and Comment)'), type: 'textarea', placeholder: t('Feedback on this {noun}', { noun }) }
    ],
    ok: t('Submit review')
  })
  if (!r) return
  if (r.action !== 'approve' && !r.body.trim()) return toast(t('Write a comment for this kind of review'), 'error')
  await actOnReview(it, r.action, r.body)
}


/* =========================================================================
   Merge request detail: read it first, decide inside (like GitHub / GitLab)
   ========================================================================= */
/** Small, safe Markdown: everything is escaped first, then a few marks become tags. Links open outside. */
function mdRender(src) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\s][^_]*)_(?=$|[\s).,:;!?])/g, '$1<em>$2</em>')
      // One pass for both link forms: a second pass matched the URL inside the href written by the first
      // and broke out of its quotes, so a PR description could add an event handler to the link.
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, text, url, pre, bare) =>
        url ? `<a href="${url}" data-ext="1">${text}</a>` : `${pre}<a href="${bare}" data-ext="1">${bare}</a>`)
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let list = null
  let code = null
  const closeList = () => list && ((html += `</${list}>`), (list = null))
  for (const ln of lines) {
    if (code !== null) {
      if (/^```/.test(ln)) (html += `<pre><code>${esc(code)}</code></pre>`), (code = null)
      else code += (code ? '\n' : '') + ln
      continue
    }
    if (/^```/.test(ln)) {
      closeList()
      code = ''
      continue
    }
    let m
    if ((m = ln.match(/^(#{1,6})\s+(.*)/))) {
      closeList()
      const lvl = Math.min(6, m[1].length + 2)
      html += `<h${lvl}>${inline(m[2])}</h${lvl}>`
    } else if ((m = ln.match(/^\s*[-*+]\s+(\[[ xX]\]\s+)?(.*)/))) {
      if (list !== 'ul') closeList(), (html += '<ul>'), (list = 'ul')
      const box = m[1] ? `<input type="checkbox" disabled ${/x/i.test(m[1]) ? 'checked' : ''}> ` : ''
      html += `<li>${box}${inline(m[2])}</li>`
    } else if ((m = ln.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') closeList(), (html += '<ol>'), (list = 'ol')
      html += `<li>${inline(m[1])}</li>`
    } else if ((m = ln.match(/^>\s?(.*)/))) {
      closeList()
      html += `<blockquote>${inline(m[1])}</blockquote>`
    } else if (!ln.trim()) closeList()
    else {
      closeList()
      html += `<p>${inline(ln)}</p>`
    }
  }
  if (code !== null) html += `<pre><code>${esc(code)}</code></pre>`
  closeList()
  const el = h('div', { class: 'md' })
  el.innerHTML = html
  el.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-ext]')
    if (!a) return
    e.preventDefault()
    openLink(a.getAttribute('href'))
  })
  return el
}

const mrNoun = (it) => (it.provider === 'github' ? t('pull request') : t('merge request'))
const mrRef = (it) => `${it.provider === 'github' ? '#' : '!'}${it.number}`
const isOwnMr = (it) => it.roles?.length > 0 && it.roles.every((r) => r === 'mine' || r === 'repo') && it.roles.includes('mine')
const initials = (n) => (String(n || '?').replace(/[^A-Za-z0-9]/g, '')[0] || '?').toUpperCase()

/** The detail page of one pull/merge request: header, Overview / Commits / Changes / Pipeline, and the decision bar. */
async function reviewDetailSheet(it, tab = 'overview') {
  rvMarkSeen(it)
  const body = h('div', { class: 'mrd' }, h('div', { class: 'inline-skeleton', style: { margin: '16px' } }, h('span'), h('span'), h('span')))
  openSheet(`${mrRef(it)} · ${it.title}`, body, [h('button', { class: 'btn sm', title: t('Open the {noun} in the browser', { noun: mrNoun(it) }), onClick: () => openLink(it.url) }, icon('open', 12), t('Open'))])
  const sheet = state.sheets[state.sheets.length - 1]
  sheet.el.classList.add('wide-sheet', 'mr-detail')
  placeSheet(sheet.el)
  let d
  try {
    d = await request('reviews.detail', { ...it, ci: undefined }, 90000)
  } catch (e) {
    if (!sheet.el.isConnected) return
    return append(clear(body), [h('div', { class: 'empty' }, icon('alert', 28), h('div', null, e.message), h('div', { class: 'empty-actions' }, h('button', { class: 'btn sm', onClick: () => openLink(it.url) }, icon('open', 12), t('Open in the browser'))))])
  }
  if (!sheet.el.isConnected) return
  const own = isOwnMr(it)
  const localRepo = !!(state.status && state.reviews?.repo === state.repo && inThisRepo(it, state.reviews))
  const stateLabel = d.state === 'merged' ? t('Merged') : d.state === 'closed' ? t('Closed') : d.draft ? t('Draft') : t('Open')

  const head = h(
    'div',
    { class: 'mrd-head' },
    h('h2', { class: 'mrd-title' }, d.title, h('span', { class: 'mrd-ref mono' }, ` ${mrRef(it)}`)),
    h(
      'div',
      { class: 'mrd-meta' },
      h('span', { class: `mrd-state s-${d.draft && d.state === 'open' ? 'draft' : d.state}` }, stateLabel),
      d.source && h('span', { class: 'mrd-route' }, h('span', { class: 'ref' }, icon('branch', 10), h('span', { class: 'ref-t' }, d.source)), icon('right', 12), h('span', { class: 'ref' }, icon('branch', 10), h('span', { class: 'ref-t' }, d.target))),
      h('span', { class: 'dim' }, t('{author} · opened {ago} · {repo}', { author: d.author, ago: ago(d.created), repo: it.repo })),
      it.ci && h('button', { class: `ci ci-${it.ci}`, title: t('See the pipeline'), onClick: () => go('pipeline') }, ciBusy(it) ? h('span', { class: 'spinner sm' }) : ciIcon(it.ci), `CI ${it.ci}`),
      d.state === 'open' && d.myApproved && h('span', { class: 'pill rv-waiting' }, icon('check', 10), t('Approved · waiting merge'))
    )
  )
  const counts = { commits: d.commits.length, changes: d.stats.files }
  const tabs = h('div', { class: 'mrd-tabs', role: 'tablist' })
  const pane = h('div', { class: 'mrd-pane' })
  const TABS_MR = [
    ['overview', t('Overview')],
    ['commits', t('Commits'), counts.commits],
    ['changes', t('Changes'), counts.changes],
    ['pipeline', t('Pipeline')]
  ]
  function drawTabs(cur) {
    clear(tabs)
    for (const [id, label, n] of TABS_MR) tabs.append(h('button', { class: `mrd-tab ${cur === id ? 'on' : ''}`, role: 'tab', 'aria-selected': cur === id, onClick: () => go(id) }, label, n != null && h('span', { class: 'mrd-count mono' }, String(n))))
  }
  function go(id) {
    // Changes and Pipeline open their own page over this one (Back returns here)
    if (id === 'changes') return reviewDiffSheet(it)
    if (id === 'pipeline') {
      if (localRepo && d.headSha) return openPipelines({ sha: d.headSha, branch: d.source })
      return openLink(it.provider === 'github' ? `${d.url}/checks` : `${d.url}/pipelines`)
    }
    drawTabs(id)
    clear(pane).append(id === 'commits' ? commitsPane() : overviewPane())
  }

  function person(name, extra) {
    return h('div', { class: 'mrd-person' }, h('span', { class: 'mrd-avatar' }, initials(name)), h('span', { class: 'grow ellipsis' }, name), extra)
  }
  function overviewPane() {
    const left = h(
      'div',
      { class: 'mrd-main' },
      h('div', { class: 'mrd-desc' }, h('div', { class: 'mrd-label' }, t('Description')), d.body.trim() ? mdRender(d.body) : h('div', { class: 'dim' }, t('No description'))),
      mergeWidget()
    )
    const activity = h(
      'div',
      { class: 'mrd-activity' },
      h('div', { class: 'section-head mrd-sec' }, t('Activity'), h('span', { class: 'count' }, d.comments.length)),
      d.comments.length
        ? h(
            'div',
            { class: 'mrd-thread' },
            d.comments.map((c) =>
              h(
                'div',
                { class: `mrd-comment ${c.kind ? 'k-' + c.kind : ''}` },
                h('span', { class: 'mrd-avatar' }, initials(c.author)),
                h(
                  'div',
                  { class: 'grow', style: { minWidth: 0 } },
                  h(
                    'div',
                    { class: 'mrd-c-head' },
                    h('b', null, c.author),
                    c.kind === 'approved' && h('span', { class: 'mrd-tag ok' }, icon('check', 11), t('approved')),
                    c.kind === 'changes' && h('span', { class: 'mrd-tag bad' }, t('requested changes')),
                    c.file && h('span', { class: 'mono dim mrd-c-file' }, `${c.file}${c.line ? ':' + c.line : ''}`),
                    h('span', { class: 'dim' }, ago(c.at))
                  ),
                  mdRender(c.body)
                )
              )
            )
          )
        : h('div', { class: 'dim mrd-none' }, t('No comments yet'))
    )
    const stateIcon = (s) => (s === 'approved' ? h('span', { class: 'mrd-rs ok', title: t('Approved') }, icon('check', 12)) : s === 'changes' ? h('span', { class: 'mrd-rs bad', title: t('Requested changes') }, icon('x', 12)) : h('span', { class: 'mrd-rs', title: t('Waiting') }, icon('minus', 12)))
    const side = h(
      'aside',
      { class: 'mrd-side' },
      h('div', { class: 'mrd-box' }, h('div', { class: 'mrd-label' }, t('Opened by')), person(d.author || it.author || '?', h('span', { class: 'dim mrd-when-small' }, ago(d.created)))),
      h('div', { class: 'mrd-box' }, h('div', { class: 'mrd-label' }, t('Approvals')), h('div', { class: 'mrd-big' }, d.approvals.required ? t('{given} of {required}', { given: d.approvals.given, required: d.approvals.required }) : String(d.approvals.given), h('span', { class: 'dim' }, d.approvals.required ? ' ' + t('approved') : d.approvals.given === 1 ? ' ' + t('approval') : ' ' + t('approvals')))),
      h('div', { class: 'mrd-box' }, h('div', { class: 'mrd-label' }, t('Reviewers')), d.reviewers.length ? d.reviewers.map((r) => person(r.name, stateIcon(r.state))) : h('div', { class: 'dim' }, t('None'))),
      h('div', { class: 'mrd-box' }, h('div', { class: 'mrd-label' }, t('Assignees')), d.assignees.length ? d.assignees.map((a) => person(a)) : h('div', { class: 'dim' }, t('None'))),
      d.labels.length > 0 && h('div', { class: 'mrd-box' }, h('div', { class: 'mrd-label' }, t('Labels')), h('div', { class: 'mrd-labels' }, d.labels.map((l) => h('span', { class: 'pill role' }, l)))),
      (d.stats.add != null || d.stats.files != null) &&
        h('div', { class: 'mrd-box' }, h('div', { class: 'mrd-label' }, t('Changes')), h('div', { class: 'mono' }, d.stats.files != null && (d.stats.files === 1 ? t('{n} file', { n: d.stats.files }) : t('{n} files', { n: d.stats.files })) + ' ', d.stats.add != null && [h('span', { class: 'a' }, `+${d.stats.add}`), ' ', h('span', { class: 'd' }, `−${d.stats.del}`)]))
    )
    return h('div', { class: 'mrd-overview' }, left, side, activity)
  }
  // Like GitLab's merge widget: pipeline, then approvals (Approve / Revoke), then Merge with its options.
  function mergeWidget() {
    const m = d.merge || {}
    const ci = m.ci || it.ci
    const open = d.state === 'open'
    const rowEl = (cls, ic, ...kids) => h('div', { class: `mrw-row ${cls}` }, h('span', { class: 'mrw-ic' }, ic), ...kids)
    const busy = (b, text) => ((b.disabled = true), clear(b).append(h('span', { class: 'spinner' }), text))
    async function act(b, action, options, text) {
      const keep = [...b.childNodes]
      busy(b, text)
      try {
        const r = await doReviewAction(it, action, options)
        widget.classList.add(`mrw-done-${action}`)
        toast({ approve: t('Approved: {title}', { title: it.title }), unapprove: t('Approval revoked: {title}', { title: it.title }), merge: r?.state === 'auto' ? t('Set to merge when the pipeline passes: {title}', { title: it.title }) : t('Merged: {title}', { title: it.title }) }[action])
        await new Promise((res) => setTimeout(res, 600))
        refreshReviewsAfterAction()
        if (state.sheets.includes(sheet)) (closeSheet(), reviewDetailSheet(it))
      } catch (e) {
        toast(e.message, 'error')
        b.disabled = false
        clear(b).append(...keep)
        widget.classList.add('rv-shake')
        setTimeout(() => widget.classList.remove('rv-shake'), 600)
      }
    }
    const rows = []
    if (ci)
      rows.push(
        rowEl(`ci-${ci}`, ci === 'running' || ci === 'pending' ? h('span', { class: 'spinner sm' }) : ciIcon(ci), h('span', { class: 'grow' }, h('b', null, t('Pipeline {state}', { state: PIPE_LABEL[ci]?.toLowerCase() || ci })), d.headSha && h('span', { class: 'dim mono' }, ' ' + t('for {sha}', { sha: d.headSha.slice(0, 8) }))), h('button', { class: 'btn sm', onClick: () => go('pipeline') }, icon('pipeline', 12), t('View pipeline')))
      )
    const approvedBy = d.reviewers.filter((r) => r.state === 'approved').map((r) => r.name)
    const need = d.approvals.required
    const apText = approvedBy.length
      ? [h('b', null, t('Approved by {names}', { names: approvedBy.join(', ') })), need ? h('span', { class: 'dim' }, ' · ' + t('{given} of {need} required', { given: d.approvals.given, need })) : null]
      : need
        ? [h('b', null, need > 1 ? t('Requires {n} approvals', { n: need }) : t('Requires {n} approval', { n: need })), h('span', { class: 'dim' }, ' · ' + t('none yet'))]
        : [h('b', null, t('Approval is optional'))]
    const apOk = need ? d.approvals.given >= need : approvedBy.length > 0
    rows.push(
      rowEl(
        apOk ? 'ok' : '',
        icon(apOk ? 'check' : 'user', 13),
        h('span', { class: 'grow' }, ...apText, d.myApproved && h('span', { class: 'mrw-you' }, ' · ' + t('you approved'))),
        open && d.canApprove && !d.myApproved && h('button', { class: 'btn sm primary mrw-approve', onClick: (e) => act(e.currentTarget, 'approve', null, t('Approving…')) }, icon('check', 12), t('Approve')),
        open && d.myApproved && h('span', { class: 'pill rv-waiting' }, icon('check', 10), t('Approved')),
        open && d.myApproved && d.canUnapprove && h('button', { class: 'btn sm mrw-revoke', title: t('Take back your approval'), onClick: (e) => act(e.currentTarget, 'unapprove', null, t('Revoking…')) }, t('Revoke'))
      )
    )
    if (!open) rows.push(rowEl(d.state === 'merged' ? 'merged' : '', icon(d.state === 'merged' ? 'merge' : 'x', 13), h('span', { class: 'grow' }, h('b', null, d.state === 'merged' ? t('Merged') : t('Closed')))))
    else {
      const squash = h('input', { type: 'checkbox' })
      squash.checked = !!m.squash
      const remove = h('input', { type: 'checkbox' })
      remove.checked = !!m.removeSource
      const opts = () => ({ squash: squash.checked, removeSource: remove.checked })
      const target = d.target ? ' ' + t('into {branch}', { branch: d.target }) : ''
      const can = m.ready || m.canAuto
      rows.push(
        rowEl(
          `mrw-merge ${m.ready ? 'ok' : m.autoSet ? 'auto' : 'blocked'}`,
          icon('merge', 13),
          h(
            'div',
            { class: 'grow mrw-merge-body' },
            h('div', null, m.autoSet ? h('b', null, t('Set to merge when the pipeline passes')) : m.ready ? h('b', null, t('Ready to merge{target}', { target })) : h('b', null, t('Merge blocked')), !m.ready && !m.autoSet && m.reason && h('span', { class: 'dim' }, ` · ${m.reason}`)),
            (can || ci === 'running' || ci === 'pending') && h('div', { class: 'mrw-opts' }, h('label', { class: 'check' }, remove, t('Delete source branch')), h('label', { class: 'check' }, squash, t('Squash commits')))
          ),
          m.ready
            ? h('button', { class: 'btn primary mrw-merge-btn', onClick: async (e) => (await confirmBox(t('Merge {ref}{target} now?', { ref: mrRef(it), target }), `${it.title}${squash.checked ? '\n' + t('Commits are squashed into one.') : ''}${remove.checked ? '\n' + t('The branch {branch} is deleted afterwards.', { branch: d.source }) : ''}`, t('Merge'))) && act(e.currentTarget, 'merge', opts(), t('Merging…')) }, icon('merge', 12), t('Merge now'))
            : m.canAuto && !m.autoSet
              ? h('button', { class: 'btn primary mrw-merge-btn', title: t('GitLab merges it as soon as the pipeline passes'), onClick: (e) => act(e.currentTarget, 'merge', { ...opts(), auto: true }, t('Setting…')) }, h('span', { class: 'spinner sm' }), t('Merge when pipeline passes'))
              : !m.autoSet && (ci === 'running' || ci === 'pending')
                ? h('button', { class: 'btn primary mrw-merge-btn', title: t('Merges in the background as soon as the pipeline passes (and whatever else it waits for)'), onClick: async (e) => ((e.currentTarget.disabled = true), await queueMerge([it], false, opts()), toast(t('{ref} merges when the pipeline passes', { ref: mrRef(it) }))) }, h('span', { class: 'spinner sm' }), t('Merge when pipeline passes'))
                : !m.autoSet && h('button', { class: 'btn mrw-merge-btn', disabled: true, title: m.reason || '' }, icon('merge', 12), t('Merge'))
        )
      )
    }
    const widget = h('div', { class: 'mrw' }, ...rows)
    return widget
  }

  function commitsPane() {
    if (!d.commits.length) return h('div', { class: 'empty' }, t('No commits'))
    return h(
      'div',
      { class: 'mrd-commits' },
      d.commits.map((c) =>
        h(
          'button',
          {
            class: 'mrd-commit',
            title: localRepo ? t('Show this commit') : t('Open this commit in the browser'),
            onClick: async () => {
              if (localRepo && (await call('commitShow', { hash: c.sha }).then(() => true, () => false))) return openCommit(c.sha)
              openLink(it.provider === 'github' ? `${d.url}/commits/${c.sha}` : `${d.url}/diffs?commit_id=${c.sha}`)
            }
          },
          h('span', { class: 'mono dim' }, c.sha.slice(0, 7)),
          h('span', { class: 'grow ellipsis' }, c.subject),
          h('span', { class: 'dim' }, c.author),
          h('span', { class: 'dim mrd-when' }, ago(c.at))
        )
      )
    )
  }

  // the decision bar: one primary action (Approve), the rest secondary
  const bar = h(
    'div',
    { class: 'mrd-bar' },
    h('span', { class: 'dim grow' }, own ? t('Your own {noun}', { noun: mrNoun(it) }) : d.state !== 'open' ? (d.state === 'merged' ? t('This {noun} is merged', { noun: mrNoun(it) }) : d.state === 'closed' ? t('This {noun} is closed', { noun: mrNoun(it) }) : t('This {noun} is {state}', { noun: mrNoun(it), state: d.state })) : t('Approve and merge are in the box under the description')),
    h('button', { class: 'btn', title: t('AI explains what this changes and why, in plain words'), onClick: () => explainSheet({ item: it }) }, icon('wand', 12), t('Explain')),
    h('button', { class: 'btn', onClick: () => aiReviewModal(it) }, icon('wand', 12), t('AI review')),
    d.state === 'open' && h('button', { class: 'btn', onClick: () => reviewDialog(it, 'comment') }, icon('edit', 12), t('Comment')),
    d.state === 'open' && !own && h('button', { class: 'btn', onClick: () => reviewDialog(it, 'changes') }, icon('x', 12), t('Request changes'))
  )
  append(clear(body), [head, tabs, pane, bar])
  go(tab === 'commits' ? 'commits' : 'overview')
}

/* =========================================================================
   CI status, undo, branch clean-up, conflict resolver, review diffs
   ========================================================================= */
const ciIcon = (st) => icon(st === 'passed' ? 'check' : st === 'failed' ? 'x' : st === 'running' || st === 'pending' ? 'refresh' : 'minus', 11)
/* =========================================================================
   Pipelines: GitHub Actions runs / GitLab pipelines, their jobs and logs
   ========================================================================= */

const PIPE_LABEL = { passed: t('Passed'), failed: t('Failed'), running: t('Running'), pending: t('Pending'), canceled: t('Canceled'), manual: t('Manual') }
const dur = (s) => (s == null ? '' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`)
const pipeBadge = (st) => h('span', { class: `ci ci-${st} pipe-state` }, ciIcon(st), PIPE_LABEL[st] || st)

/* =========================================================================
   Pipelines tab: the latest runs of every branch in one place
   ========================================================================= */
let pipesTimer = null
const PIPE_SRC = { push: t('push'), merge_request_event: t('merge request'), pull_request: t('pull request'), schedule: t('schedule'), web: t('run by hand'), api: 'API', trigger: t('trigger'), pipeline: t('downstream'), parent_pipeline: t('child'), workflow_dispatch: t('run by hand'), chat: t('chat'), external: t('external') }
/** A pipeline's ref the way GitLab shows it: a merge request as !N, a tag with its icon, else the branch. */
function refChip(p) {
  const mr = String(p.branch || '').match(/^refs\/merge-requests\/(\d+)\/(head|merge)$/)
  if (mr) return h('span', { class: 'ref pc-mr', title: p.branch }, icon('pr', 10), h('span', { class: 'ref-t' }, `!${mr[1]}`))
  if (p.tag) return h('span', { class: 'ref tag', title: t('Tag {name}', { name: p.branch }) }, icon('tag', 10), h('span', { class: 'ref-t' }, p.branch))
  return h('span', { class: 'ref', title: p.branch }, icon('branch', 10), h('span', { class: 'ref-t' }, p.branch || '?'))
}
// The last list per repository: the tab shows it at once, then refreshes in the background.
const pipesCache = new Map() // repo → { at, data, full }
let pipesLoading = null
function refreshPipes(repo) {
  if (pipesLoading?.repo === repo) return pipesLoading.p
  const had = pipesCache.get(repo)
  // first time: the bare list first (one request), so rows show while the details load
  const steps = had?.full ? [{ all: true }] : [{ all: true, light: true }, { all: true }]
  const redraw = () => state.repo === repo && state.tab === 'pipelines' && !document.querySelector('.overlay, .sheet') && renderView({ force: true })
  const p = (async () => {
    try {
      for (const args of steps) {
        const data = await call('pipelines', args)
        pipesCache.set(repo, { at: Date.now(), data, full: !args.light })
        if (args.light) redraw() // the rows now; the details follow
      }
    } catch (e) {
      // no list yet: the tab says why; a list already shown stays, with a toast
      if (!pipesCache.get(repo)?.data) pipesCache.set(repo, { at: Date.now(), error: e.message })
      else if (state.tab === 'pipelines' && state.repo === repo) toast(e.message, 'error') // not for a repo left behind
    } finally {
      pipesLoading = null
      redraw()
    }
  })()
  pipesLoading = { repo, p }
  return p
}
async function viewPipelinesTab() {
  clearTimeout(pipesTimer)
  const root = h('div', { class: 'view pipes-tab' })
  const repo = state.repo
  const c = pipesCache.get(repo)
  // stale (or details missing): refresh in the background; a failure waits for Try again
  if (!pipesLoading && !c?.error && (!c || !c.full || Date.now() - c.at > 4000)) refreshPipes(repo)
  if (!c?.data) {
    if (c?.error && !pipesLoading) {
      root.append(h('div', { class: 'empty' }, icon('pipeline', 28), h('div', null, c.error), h('div', { class: 'dim' }, t('Pipelines show for repositories on GitHub or GitLab that your Git login can reach.')), h('button', { class: 'btn sm', style: { marginTop: '10px' }, onClick: () => (pipesCache.delete(repo), renderView({ force: true })) }, icon('refresh', 12), t('Try again'))))
      return root
    }
    root.append(h('div', { class: 'skeleton-list' }, ...Array.from({ length: 6 }, () => h('div', { class: 'skeleton-row' }, h('span', { class: 'bar' })))))
    return root
  }
  const data = c.data
  const updating = !!pipesLoading && pipesLoading.repo === repo
  const f = (state.pipeFilter ||= { state: 'all', text: '' })
  const counts = { all: data.items.length, running: 0, failed: 0, passed: 0 }
  for (const p of data.items) {
    if (p.state === 'running' || p.state === 'pending') counts.running++
    else if (p.state === 'failed') counts.failed++
    else if (p.state === 'passed') counts.passed++
  }
  const chips = h(
    'div',
    { class: 'segmented rv-filter' },
    [
      ['all', t('All')],
      ['running', t('Running')],
      ['failed', t('Failed')],
      ['passed', t('Passed')]
    ].map(([k, l]) => h('button', { class: f.state === k ? 'on' : '', onClick: () => ((f.state = k), renderView({ force: true })) }, l, h('span', { class: `rv-n ${k === 'failed' && counts.failed ? 'hot-bad' : k === 'running' && counts.running ? 'hot' : ''}` }, String(counts[k]))))
  )
  const search = h('input', { type: 'text', class: 'rv-search', placeholder: t('Filter by branch, title or who started it…'), value: f.text, onInput: (e) => ((f.text = e.target.value), draw()) })
  root.append(
    h('div', { class: 'history-bar' }, chips, h('span', { class: 'grow' }), h('span', { class: 'dim', style: { fontSize: '11.5px' } }, `${data.kind === 'github' ? 'GitHub Actions' : 'GitLab CI'} · ${data.host}`), h('button', { class: 'btn sm', onClick: () => openLink(data.web) }, icon('open', 12), t('Open in browser')), h('button', { class: 'btn sm pipes-refresh', disabled: updating, title: updating ? t('Updating…') : t('Refresh'), onClick: () => refreshPipes(repo).then(() => {}) }, updating ? h('span', { class: 'spinner sm' }) : icon('refresh', 12), updating ? t('Updating') : t('Refresh'))),
    h('div', { class: 'rv-filters' }, h('div', { class: 'rv-search-wrap' }, icon('search', 12), search))
  )
  const list = h('div', { class: 'pipe-list' })
  root.append(list)
  function draw() {
    const words = f.text.toLowerCase().split(/\s+/).filter(Boolean)
    const items = data.items.filter((p) => (f.state === 'all' || (f.state === 'running' ? p.state === 'running' || p.state === 'pending' : p.state === f.state)) && words.every((w) => `${p.branch} ${p.title} ${p.name} ${p.by} ${p.sha}`.toLowerCase().includes(w)))
    clear(list)
    if (!items.length) return list.append(h('div', { class: 'empty' }, icon('check', 28), h('div', null, data.items.length ? t('Nothing matches') : t('No pipelines yet'))))
    list.append(h('div', { class: 'pc-head' }, h('span', null, t('Status')), h('span', null, t('Pipeline')), h('span', null, t('Branch / commit')), h('span', null, t('Stages')), h('span', null, t('Started by')), h('span')))
    for (const p of items)
      list.append(
        h(
          'button',
          { class: `pipe-row pr-${p.state}`, onClick: () => openPipelines({ branch: p.branch, openId: p.id }) },
          // status, with how long it took and when
          h('div', { class: 'pc-status' }, pipeBadge(p.state), h('div', { class: 'dim pc-time' }, p.duration != null && [icon('history', 10), dur(p.duration)]), h('div', { class: 'dim pc-time', title: new Date(p.at * 1000).toLocaleString(LANG) }, ago(p.finished || p.at))),
          // what it ran on: the commit's message, the pipeline number, what started it
          h('div', { class: 'pc-main' }, h('div', { class: 'ellipsis pc-title', title: p.commitTitle || p.title || '' }, p.commitTitle || p.title || p.name), h('div', { class: 'pc-sub' }, h('span', { class: 'pc-id' }, p.name), p.event && h('span', { class: 'pill pc-src' }, PIPE_SRC[p.event] || String(p.event).replace(/_/g, ' ')))),
          // branch, tag or merge request, and the commit
          h('div', { class: 'pc-ref' }, refChip(p), h('span', { class: 'mono dim pc-sha' }, icon('commit', 10), (p.sha || '').slice(0, 8))),
          // the stages, like GitLab's dots
          h('div', { class: 'pc-stages' }, (p.stages || []).map((s) => h('span', { class: `pc-dot st-${s.state}`, title: s.jobs > 1 ? t('{name}: {state} ({n} jobs)', { name: s.name, state: PIPE_LABEL[s.state] || s.state, n: s.jobs }) : t('{name}: {state} ({n} job)', { name: s.name, state: PIPE_LABEL[s.state] || s.state, n: s.jobs }) }, s.state === 'passed' ? icon('check', 9) : s.state === 'failed' ? icon('x', 9) : s.state === 'running' ? h('span', { class: 'spinner sm' }) : null))),
          // who started it
          h('div', { class: 'pc-by', title: p.byName || p.by || '' }, (p.by || p.byName) ? [h('span', { class: 'mrd-avatar' }, initials(p.byName || p.by)), h('span', { class: 'ellipsis' }, p.by || p.byName)] : null),
          icon('right', 14)
        )
      )
  }
  draw()
  // runs still going: look again shortly while the tab is open
  if (counts.running) pipesTimer = setTimeout(() => state.tab === 'pipelines' && !document.querySelector('.overlay, .sheet') && renderView({ force: true }), 15000)
  return root
}

/** Open the pipeline sheet: the list for the branch, or straight into one pipeline. */
async function openPipelines({ branch, sha, openId } = {}) {
  const body = h('div', { class: 'pipes' }, h('div', { class: 'inline-skeleton' }, h('span'), h('span'), h('span')))
  openSheet(t('Pipelines · {branch}', { branch: branch || state.status?.branch || 'HEAD' }), body)
  const sheet = state.sheets[state.sheets.length - 1]
  sheet.el.classList.add('wide-sheet')
  placeSheet(sheet.el)
  let timer = null
  const alive = () => state.sheets.includes(sheet) && document.body.contains(sheet.el)
  const later = (fn, ms) => {
    clearTimeout(timer)
    timer = setTimeout(() => alive() && fn(), ms)
  }

  async function showList() {
    let data
    try {
      data = await call('pipelines', { branch, sha })
    } catch (e) {
      return append(clear(body), [h('div', { class: 'empty' }, icon('alert', 28), h('div', null, e.message))])
    }
    if (!alive()) return
    if (openId) {
      const it = data.items.find((x) => String(x.id) === String(openId))
      openId = null
      if (it) return showPipeline(it, data)
    }
    append(clear(body), [
      h('div', { class: 'history-bar' }, h('span', { class: 'dim' }, data.branch ? t('{n} recent on {branch}', { n: data.items.length, branch: data.branch }) : t('{n} recent on all branches', { n: data.items.length })), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onClick: () => openLink(data.web) }, icon('open', 12), t('Open in browser')), h('button', { class: 'btn sm', onClick: showList }, icon('refresh', 12), t('Refresh'))),
      data.items.length
        ? h(
            'div',
            { class: 'pipe-list' },
            data.items.map((p) =>
              h(
                'button',
                { class: `pipe-row s-${p.state}`, onClick: () => showPipeline(p, data) },
                pipeBadge(p.state),
                h('div', { class: 'pipe-main' }, h('div', { class: 'pipe-title' }, h('b', null, p.name), p.title && h('span', { class: 'dim' }, p.title)), h('div', { class: 'dim pipe-meta' }, [p.branch, p.sha?.slice(0, 7), p.by && `@${p.by}`, p.event, ago(p.at)].filter(Boolean).join(' · '))),
                h('span', { class: 'dim mono' }, dur(p.duration)),
                icon('right', 13)
              )
            )
          )
        : h('div', { class: 'empty' }, icon('commit', 28), h('div', null, t('No pipelines for this branch yet')))
    ])
    if (data.items.some((p) => p.state === 'running' || p.state === 'pending')) later(showList, 10000)
  }

  async function showPipeline(p, data) {
    append(clear(body), [h('div', { class: 'inline-skeleton' }, h('span'), h('span'), h('span'))])
    let jobs
    try {
      jobs = await call('pipelineJobs', { id: p.id })
    } catch (e) {
      return append(clear(body), [h('div', { class: 'empty' }, icon('alert', 28), h('div', null, e.message))])
    }
    if (!alive()) return
    // every action shows it is working on its own button, then reloads the pipeline
    const act = async (action, label, extra = {}, btn) => {
      const was = btn ? [...btn.childNodes] : null
      if (btn) {
        btn.disabled = true
        append(clear(btn), [h('span', { class: 'spinner' }), t('Sending…')])
      }
      try {
        await call('pipelineAct', { id: p.id, action, ...extra })
        toast(t('{action}. The pipeline updates here as it runs.', { action: label }))
        p = { ...p, state: action === 'cancel' ? 'canceled' : 'pending' }
        later(() => showPipeline(p, data), 1200)
      } catch (e) {
        toast(e.message, 'error')
        if (btn) {
          btn.disabled = false
          append(clear(btn), was)
        }
      }
    }
    const running = p.state === 'running' || p.state === 'pending'
    const failed = jobs.filter((j) => j.state === 'failed')
    const stages = [...new Set(jobs.map((j) => j.stage))]
    append(clear(body), [
      h(
        'div',
        { class: 'history-bar' },
        h('button', { class: 'crumb', onClick: showList }, t('Pipelines')),
        icon('right', 12),
        pipeBadge(p.state),
        h('b', null, p.name),
        h('span', { class: 'dim' }, [p.sha?.slice(0, 7), dur(p.duration)].filter(Boolean).join(' · ')),
        h('span', { class: 'grow' }),
        failed.length > 0 && h('button', { class: 'btn sm', onClick: (e) => act('retryFailed', t('Retrying the failed jobs'), {}, e.currentTarget) }, icon('refresh', 12), t('Retry failed')),
        !running && h('button', { class: 'btn sm', onClick: (e) => act('retry', t('Pipeline restarted'), {}, e.currentTarget) }, icon('refresh', 12), t('Retry all')),
        running && h('button', { class: 'btn sm danger', onClick: async (e) => (await confirmBox(t('Cancel pipeline {name}?', { name: p.name }), t('Running jobs are stopped.'), t('Cancel pipeline'), true)) && act('cancel', t('Pipeline canceled'), {}, e.currentTarget) }, icon('x', 12), t('Cancel')),
        h('button', { class: 'btn sm', onClick: () => openLink(p.url) }, icon('open', 12), t('Open'))
      ),
      failed.length > 0 &&
        h(
          'div',
          { class: 'pipe-failed' },
          icon('alert', 15),
          h('div', { class: 'grow' }, h('b', null, failed.length === 1 ? t('{n} job failed', { n: failed.length }) : t('{n} jobs failed', { n: failed.length })), h('div', { class: 'dim' }, failed.map((j) => j.name).join(', '))),
          h('button', { class: 'btn sm primary', onClick: () => showLog(p, failed[0], data) }, icon('alert', 12), t('Show the error'))
        ),
      h(
        'div',
        { class: 'pipe-stages' },
        stages.map((st) =>
          h(
            'div',
            { class: 'pipe-stage' },
            h('div', { class: 'section-head' }, st),
            jobs
              .filter((j) => j.stage === st)
              .map((j) =>
                h(
                  'div',
                  { class: `pipe-job s-${j.state}`, role: 'button', tabindex: 0, onClick: () => showLog(p, j, data), onKeydown: (e) => e.key === 'Enter' && showLog(p, j, data) },
                  h('span', { class: `ci ci-${j.state} pipe-dot`, title: PIPE_LABEL[j.state] || j.state }, ciIcon(j.state)),
                  h('span', { class: 'pipe-job-name' }, j.name, j.allowFailure && h('span', { class: 'dim' }, ' ' + t('(allowed to fail)'))),
                  h('span', { class: 'dim mono' }, dur(j.duration)),
                  j.state === 'failed' && h('button', { class: 'icon-btn', title: t('Retry this job'), onClick: (e) => (e.stopPropagation(), act('retryJob', t('Retrying {name}', { name: j.name }), { job: j.id }, e.currentTarget)) }, icon('refresh', 12))
                )
              )
          )
        )
      ),
      !jobs.length && h('div', { class: 'empty' }, t('No jobs'))
    ])
    if (running) later(() => showPipeline(p, data), 10000)
  }

  async function showLog(p, j, data) {
    append(clear(body), [h('div', { class: 'inline-skeleton' }, h('span'), h('span'), h('span'))])
    let r
    try {
      r = await call('jobLog', { id: j.id })
    } catch (e) {
      return append(clear(body), [h('div', { class: 'history-bar' }, h('button', { class: 'btn sm', onClick: () => showPipeline(p, data) }, icon('left', 12), p.name)), h('div', { class: 'empty' }, icon('alert', 28), h('div', null, e.message))])
    }
    if (!alive()) return
    const BAD = /(##\[error\]|\berror\b|\bfailed\b|\bfailure\b|exception|✗|✖|ERR!|FATAL|exit code [1-9])/i
    const lines = r.log.split('\n')
    let firstBad = -1
    const pre = h('div', { class: 'pipe-log' })
    const frag = document.createDocumentFragment()
    lines.forEach((ln, i) => {
      const bad = BAD.test(ln)
      if (bad && firstBad < 0) firstBad = i
      frag.append(h('div', { class: `pl ${bad ? 'bad' : ''}` }, h('span', { class: 'pl-n' }, String(i + 1)), h('span', { class: 'pl-t' }, ln.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, ''))))
    })
    pre.append(frag)
    const errors = lines.filter((l) => BAD.test(l)).length
    // step through the error lines (n / total), or show only them; find any text; wrap long lines
    const bads = () => [...pre.querySelectorAll('.pl.bad:not(.hide)')]
    let at = -1
    const counter = h('span', { class: 'dim mono pl-counter' }, errors ? `${errors}` : '')
    const goErr = (d) => {
      const list = bads()
      if (!list.length) return
      at = (at + d + list.length) % list.length
      pre.querySelector('.pl.cur')?.classList.remove('cur')
      list[at].classList.add('cur')
      list[at].scrollIntoView({ block: 'center' })
      counter.textContent = `${at + 1} / ${list.length}`
    }
    const onlyErr = h('input', { type: 'checkbox' })
    onlyErr.addEventListener('change', () => {
      pre.classList.toggle('only-bad', onlyErr.checked)
      store.set('pipeOnlyErrors', onlyErr.checked)
    })
    const wrap = h('input', { type: 'checkbox', checked: store.get('pipeWrap', true) })
    pre.classList.toggle('wrap', wrap.checked)
    wrap.addEventListener('change', () => (pre.classList.toggle('wrap', wrap.checked), store.set('pipeWrap', wrap.checked)))
    let findT = null
    const find = h('input', { type: 'text', class: 'pl-find', placeholder: t('Find in log…'), spellcheck: 'false' })
    const found = h('span', { class: 'dim mono' })
    find.addEventListener('input', () => {
      clearTimeout(findT)
      findT = setTimeout(() => {
        const q = find.value.trim().toLowerCase()
        let n = 0
        let first = null
        for (const row of pre.children) {
          const hit = q && row.lastChild.textContent.toLowerCase().includes(q)
          row.classList.toggle('hit', !!hit)
          if (hit && !n++) first = row
        }
        found.textContent = q ? (n ? (n === 1 ? t('{n} line', { n }) : t('{n} lines', { n })) : t('no match')) : ''
        first?.scrollIntoView({ block: 'center' })
      }, 200)
    })
    find.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return
      const hits = [...pre.querySelectorAll('.pl.hit')]
      if (!hits.length) return
      const cur = hits.findIndex((x) => x.classList.contains('cur'))
      pre.querySelector('.pl.cur')?.classList.remove('cur')
      const next = hits[(cur + (e.shiftKey ? -1 : 1) + hits.length) % hits.length]
      next.classList.add('cur')
      next.scrollIntoView({ block: 'center' })
    })
    const live = j.state === 'running' || j.state === 'pending'
    append(clear(body), [
      h(
        'div',
        { class: 'history-bar pipe-crumbs' },
        h('button', { class: 'crumb', onClick: showList }, t('Pipelines')),
        icon('right', 12),
        h('button', { class: 'crumb', onClick: () => showPipeline(p, data) }, p.name),
        icon('right', 12),
        pipeBadge(j.state),
        h('b', null, j.name),
        live && h('span', { class: 'pl-live' }, h('i'), t('live')),
        h('span', { class: 'grow' }),
        j.state === 'failed' && h('button', { class: 'btn sm', onClick: async (e) => { const b = e.currentTarget; b.disabled = true; append(clear(b), [h('span', { class: 'spinner' }), t('Sending…')]); try { await call('pipelineAct', { id: p.id, action: 'retryJob', job: j.id }); toast(t('Retrying {name}', { name: j.name })); later(() => showPipeline({ ...p, state: 'pending' }, data), 1200) } catch (err) { toast(err.message, 'error'); b.disabled = false; append(clear(b), [icon('refresh', 12), t('Retry job')]) } } }, icon('refresh', 12), t('Retry job')),
        false && h('button', { class: 'btn sm', title: t('Jump to the first error line'), onClick: () => pre.querySelector('.pl.bad')?.scrollIntoView({ block: 'center' }) }, icon('alert', 12), errors > 1 ? t('{n} error lines', { n: errors }) : t('{n} error line', { n: errors })),
        h('button', { class: 'btn sm', onClick: () => copy(r.log).then(() => toast(t('Log copied'))) }, icon('copy', 12), t('Copy log')),
        h('button', { class: 'btn sm', onClick: () => openLink(j.url) }, icon('open', 12), t('Open'))
      ),
      h(
        'div',
        { class: 'pipe-logbar' },
        errors > 0
          ? h('div', { class: 'pl-errnav' }, icon('alert', 13), h('b', null, errors === 1 ? t('{n} error line', { n: errors }) : t('{n} error lines', { n: errors })), h('button', { class: 'icon-btn', title: t('Previous error'), onClick: () => goErr(-1) }, icon('left', 13)), counter, h('button', { class: 'icon-btn', title: t('Next error'), onClick: () => goErr(1) }, icon('right', 13)), h('label', { class: 'check' }, onlyErr, t('Errors only')))
          : h('div', { class: 'pl-errnav ok' }, icon('check', 13), live ? t('No errors so far') : t('No error lines found')),
        h('span', { class: 'grow' }),
        find,
        found,
        h('label', { class: 'check' }, wrap, t('Wrap'))
      ),
      r.truncated && h('div', { class: 'dim pipe-note' }, t('Showing the last part of a long log.')),
      pre
    ])
    if (store.get('pipeOnlyErrors', false) && errors) (onlyErr.checked = true), pre.classList.add('only-bad')
    // a running job: follow its log (stays at the bottom unless scrolled up)
    if (live) {
      const stick = () => pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40
      later(async () => {
        const wasBottom = stick()
        const keep = pre.scrollTop
        await showLog(p, { ...j }, data)
        const np = body.querySelector('.pipe-log')
        if (np && !wasBottom) np.scrollTop = keep
      }, 5000)
    }
    // show where it went wrong: the first error line, else the end
    requestAnimationFrame(() => (firstBad >= 0 && !live ? goErr(1) : (pre.scrollTop = pre.scrollHeight)))
  }

  showList()
}

function ciBadge() {
  const ci = state.ci
  if (!ci || !ci.state || ci.sha !== state.status?.oid) return null
  const label = { passed: t('CI passed'), failed: t('CI failed'), running: t('CI running'), canceled: t('CI canceled') }[ci.state]
  return h('button', { class: `ci ci-${ci.state}`, title: t('{status} for {sha}. Click to see the pipeline.', { status: label, sha: ci.sha.slice(0, 7) }), onClick: () => openPipelines({ sha: ci.sha }) }, ciIcon(ci.state), label)
}
let ciLoading = false
async function loadCi() {
  if (ciLoading || !state.repo || !state.status?.oid || !isShown()) return
  if (state.ci?.sha === state.status.oid && Date.now() - state.ci.at < (state.ci.state === 'running' ? 30000 : 120000)) return
  ciLoading = true
  const repo = state.repo
  try {
    const r = await request('git', { op: 'ciStatus', repo, args: {} }, 40000)
    if (repo !== state.repo) return
    state.ci = { ...r, at: Date.now() }
    renderHeader()
  } catch {
  } finally {
    ciLoading = false
  }
}
setInterval(loadCi, 15000)
// The Review & MR count: fetched in the background (soon after opening, on a repo switch, then every
// 3 minutes) so the tab shows how many wait for you without opening it.
let reviewsPolledFor = null
function pollReviews() {
  if (!state.repo || !isShown() || reviewsLoading) return
  const fresh = state.reviews && state.reviews.repo === state.repo && Date.now() - state.reviews.at < 170000
  if (fresh && reviewsPolledFor === state.repo) return
  reviewsPolledFor = state.repo
  loadReviews(true)
    .then(() => state.tab === 'reviews' && renderView({ force: true }))
    .catch(() => {})
}
setTimeout(pollReviews, 4000)
setInterval(() => ((reviewsPolledFor = state.reviews?.repo === state.repo && Date.now() - (state.reviews?.at || 0) < 170000 ? state.repo : null), pollReviews()), 15000)

async function undoLast() {
  let u
  try {
    u = await call('undoInfo')
  } catch (e) {
    return toast(e.message, 'error')
  }
  if (u.blocked) return toast(u.blocked, 'error')
  const keep = u.mode === 'soft' ? t('Its changes stay staged, ready to commit again.') : u.mode === 'switch' ? '' : t('Uncommitted changes are kept.')
  const what = u.description || t('The branch goes back to {sha}.', { sha: u.to.slice(0, 7) }) + ' ' + keep
  if (!(await confirmBox(t('Undo the last action?'), `${u.what}\n${ago(u.at)}\n\n${what}\n` + t('The Reflog tab can take you forward again.'), t('Undo')))) return
  state.history.stale = true
  run('undoLast', {}, { success: t('Undone: {what}', { what: u.what.split(':')[0] }) })
}

async function cleanupBranches() {
  let c
  try {
    c = await call('branchCleanup')
  } catch (e) {
    return toast(e.message, 'error')
  }
  const rows = [...c.gone.map((n) => ({ name: n, why: t('deleted on the server'), force: true })), ...c.merged.filter((n) => !c.gone.includes(n)).map((n) => ({ name: n, why: t('merged into {branch}', { branch: c.base }) }))]
  if (!rows.length) return toast(t('No merged or gone branches (compared with {branch}).', { branch: c.base }))
  closeOverlays()
  const checks = rows.map((r) => ({ ...r, box: h('input', { type: 'checkbox', checked: true }) }))
  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => e.key === 'Escape' && isTopOverlay(overlay) && close()
  const box = h(
    'div',
    { class: 'dialog', role: 'dialog' },
    h('h3', null, t('Clean up branches')),
    h('p', null, t('Local branches already merged into {branch}, or whose remote branch was deleted. Their commits stay reachable in the Reflog for a while.', { branch: c.base })),
    h('div', { class: 'cleanup-list' }, checks.map((r) => h('label', { class: 'check cleanup-row' }, r.box, h('span', { class: 'mono grow ellipsis' }, r.name), h('span', { class: `pill ${r.force ? 'role-review' : ''}` }, r.why)))),
    h(
      'div',
      { class: 'buttons' },
      h('button', { type: 'button', class: 'btn', onClick: close }, t('Cancel')),
      h(
        'button',
        {
          type: 'button',
          class: 'btn danger solid',
          onClick: async () => {
            const pick = checks.filter((r) => r.box.checked)
            if (!pick.length) return close()
            close()
            const res = await run('branchDeleteMany', { names: pick.map((r) => r.name), force: pick.filter((r) => r.force).map((r) => r.name) }, { quiet: true })
            if (res) {
              const bad = res.filter((x) => !x.ok)
              toast(bad.length ? t('Deleted {n}; kept {names}:', { n: res.length - bad.length, names: bad.map((b) => b.name).join(', ') }) + `\n${bad[0].error}` : res.length > 1 ? t('Deleted {n} branches', { n: res.length }) : t('Deleted {n} branch', { n: res.length }), bad.length ? 'error' : 'ok')
            }
          }
        },
        icon('trash', 13),
        t('Delete selected')
      )
    )
  )
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && close() }, box)
  mountOverlay(overlay, close)
  document.addEventListener('keydown', onKey)
}

/** The two sides of the operation in progress, by name: Current is HEAD (git's "ours"), Incoming is what comes in. */
function conflictSides(block) {
  const st = state.status || {}
  const s = st.sides || {}
  const cur = s.current || (block?.oursLabel && block.oursLabel !== 'HEAD' ? block.oursLabel : st.branch) || 'HEAD'
  const inc = s.incoming || block?.theirsLabel || 'incoming'
  return { current: cur, incoming: inc, op: { merge: t('Merging'), rebase: t('Rebasing'), 'cherry-pick': t('Cherry-picking'), revert: t('Reverting') }[st.state] || t('Merging') }
}
const sideChip = (kind, name) => h('span', { class: `side-chip ${kind}` }, h('span', { class: 'side-k' }, kind === 'current' ? t('Current') : t('Incoming')), h('span', { class: 'side-n mono', title: name }, name))

/* ---------- conflicts: the parts that need no choice ---------- */
/** A file with conflict markers → plain text runs and blocks { ours, base, theirs, labels }. */
function parseConflictText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const parts = []
  let buf = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('<<<<<<<')) {
      if (buf.length) parts.push(buf.join(eol))
      buf = []
      const block = { ours: [], base: [], theirs: [], oursLabel: lines[i].slice(8).trim(), theirsLabel: '', choice: null, result: null }
      let where = 'ours'
      for (i++; i < lines.length; i++) {
        const l = lines[i]
        if (l.startsWith('|||||||')) where = 'base'
        else if (l.startsWith('=======')) where = 'theirs'
        else if (l.startsWith('>>>>>>>')) {
          block.theirsLabel = l.slice(8).trim()
          break
        } else block[where].push(l)
      }
      parts.push(block)
    } else buf.push(lines[i])
  }
  if (buf.length) parts.push(buf.join(eol))
  return { parts, eol }
}
/**
 * A block that needs no choice, and its result: both sides made the same change; only one side
 * changed it (compared with the base); after their shared first and last lines, one side is the base;
 * or they differ only in spaces. null when it is a real conflict.
 */
function autoBlock(b, hasBase) {
  const same = (x, y) => x.length === y.length && x.every((l, i) => l === y[i])
  const { ours, theirs, base } = b
  if (same(ours, theirs)) return ours
  if (hasBase) {
    if (same(ours, base)) return theirs
    if (same(theirs, base)) return ours
    let p = 0
    while (p < ours.length && p < theirs.length && p < base.length && ours[p] === theirs[p] && base[p] === ours[p]) p++
    let s = 0
    while (s < ours.length - p && s < theirs.length - p && s < base.length - p && ours[ours.length - 1 - s] === theirs[theirs.length - 1 - s] && base[base.length - 1 - s] === ours[ours.length - 1 - s]) s++
    const o = ours.slice(p, ours.length - s)
    const t = theirs.slice(p, theirs.length - s)
    const bm = base.slice(p, base.length - s)
    if (p + s > 0 && same(o, bm)) return [...ours.slice(0, p), ...t, ...ours.slice(ours.length - s)]
    if (p + s > 0 && same(t, bm)) return [...ours.slice(0, p), ...o, ...ours.slice(ours.length - s)]
    // same number of lines on all three: line by line, each changed by one side only
    if (ours.length === base.length && theirs.length === base.length) {
      const out = []
      for (let i = 0; i < base.length; i++) {
        if (ours[i] === theirs[i] || theirs[i] === base[i]) out.push(ours[i])
        else if (ours[i] === base[i]) out.push(theirs[i])
        else return null
      }
      return out
    }
  }
  const squash = (x) => x.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
  if (squash(ours) === squash(theirs)) return ours
  return null
}
/** What git can tell about a conflicted file's blocks: with the base, how many need no choice. */
async function conflictAnalysis(file) {
  const { text, hasBase } = await call('conflictText', { file })
  const { parts } = parseConflictText(text)
  const blocks = parts.filter((x) => typeof x === 'object')
  return { parts, blocks, hasBase, auto: blocks.filter((b) => autoBlock(b, hasBase)).length }
}
/** Give the blocks of the file on disk their base, from git's stages, when the file has none. */
async function withBase(file, blocks) {
  if (blocks.some((b) => b.base.length)) return true
  try {
    const a = await conflictAnalysis(file)
    if (a.blocks.length !== blocks.length) return false
    blocks.forEach((b, i) => (b.base = a.blocks[i].base))
    return a.hasBase
  } catch {
    return false
  }
}
/** Resolve the blocks that need no choice in one file; the rest stay marked. Staged when nothing is left. */
async function applyNonConflicting(file, sides) {
  const text = await call('readWorkFile', { file })
  const { parts, eol } = parseConflictText(text)
  const blocks = parts.filter((x) => typeof x === 'object')
  const hasBase = await withBase(file, blocks)
  let applied = 0
  let left = 0
  const out = parts.map((x) => {
    if (typeof x === 'string') return x
    const r = autoBlock(x, hasBase)
    if (r) return applied++, r.join(eol)
    left++
    return [`<<<<<<< ${x.oursLabel || sides.current}`, ...x.ours, '=======', ...x.theirs, `>>>>>>> ${x.theirsLabel || sides.incoming}`].join(eol)
  })
  if (applied) await call('writeWorkFile', { file, text: out.join(eol), stage: left === 0 })
  return { applied, left }
}

/* ---------- reset: say what each kind does, and how to get it back ---------- */
async function resetTo(hash, mode = 'mixed') {
  const cur = state.status?.branch || 'HEAD'
  const short = hash.slice(0, 7)
  const leaving = await call('rebaseTodo', { base: hash }).then((t) => t.length, () => null)
  const files = state.status?.files?.length || 0
  return new Promise((resolve) => {
    let pick = mode
    const opts = [
      ['soft', t('Keep the changes, staged'), t('The commits are undone; their changes wait in Staged, ready to commit again.')],
      ['mixed', t('Keep the changes, not staged'), t('The commits are undone; their changes stay in your files. Recommended.')],
      ['keep', t('Keep only my uncommitted work'), t('The commits and their changes go; files you are editing now stay (stops if they would be overwritten).')],
      ['hard', t('Throw the changes away'), files ? (files > 1 ? t('The commits and your {n} uncommitted files are gone from your files.', { n: files }) : t('The commits and your {n} uncommitted file are gone from your files.', { n: files })) : t('The commits and any uncommitted change are gone from your files.')]
    ]
    const list = h('div', { class: 'choice-list' })
    const draw = () => {
      clear(list)
      for (const [k, title, text] of opts)
        list.append(
          h(
            'label',
            { class: `choice ${pick === k ? 'on' : ''} ${k === 'hard' ? 'danger' : ''}` },
            h('input', { type: 'radio', name: 'reset-mode', checked: pick === k, onChange: () => ((pick = k), draw(), sync()) }),
            h('div', null, h('b', null, title, h('span', { class: 'dim mono' }, `  ${k}`)), h('div', { class: 'dim' }, text))
          )
        )
    }
    const what = h('div', { class: 'choice-what' })
    const go = h('button', { class: 'btn primary', onClick: () => finish(true) }, t('Reset'))
    const sync = () => {
      go.className = `btn ${pick === 'hard' ? 'danger' : 'primary'}`
      clear(what).append(
        icon(pick === 'hard' ? 'alert' : 'undo', 13),
        h('span', null, leaving != null ? (leaving === 1 ? t('{n} commit leaves {branch}.', { n: leaving, branch: cur }) : t('{n} commits leave {branch}.', { n: leaving, branch: cur })) : t('{branch} moves to {ref}.', { branch: cur, ref: short }), ' ', pick === 'hard' ? t('Uncommitted changes cannot be recovered; the commits can, from Reflog.') : t('You can get the commits back with Undo or from Reflog.'))
      )
    }
    draw()
    sync()
    const close = () => finish(false)
    function finish(ok) {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      resolve(ok)
      if (!ok) return
      if (state.sheets.length) closeSheet()
      resetHistory()
      run('reset', { hash, mode: pick }, { success: t('Reset {branch} to {ref} ({mode})', { branch: cur, ref: short, mode: pick }) })
    }
    const onKey = (e) => isTopOverlay(overlay) && (e.key === 'Escape' ? close() : e.key === 'Enter' && pick !== 'hard' && finish(true))
    const box = h('div', { class: 'dialog choice-dialog', role: 'dialog' }, h('h3', null, t('Reset {branch} to {ref}?', { branch: cur, ref: short })), list, what, h('div', { class: 'buttons' }, h('button', { class: 'btn', onClick: close }, t('Cancel')), h('span', { class: 'grow' }), go))
    const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && close() }, box)
    mountOverlay(overlay, close)
    document.addEventListener('keydown', onKey)
  })
}

/* ---------- the git commands that ran ---------- */
async function openCmdLog() {
  const body = h('div', { class: 'cmd-log' }, h('div', { class: 'inline-skeleton', style: { margin: '12px' } }, h('span'), h('span')))
  openSheet(t('Git commands'), body, [
    h('label', { class: 'check sm' }, (() => {
      const c = h('input', { type: 'checkbox', checked: !!store.get('showCmds', false), onChange: (e) => (store.set('showCmds', e.target.checked), toast(e.target.checked ? t('Each action now shows its git command') : t('Commands hidden'))) })
      return c
    })(), t('Show with each action'))
  ])
  let list
  try {
    list = await call('gitLog')
  } catch (e) {
    return append(clear(body), [h('div', { class: 'empty' }, e.message)])
  }
  if (!list.length) return append(clear(body), [h('div', { class: 'empty' }, icon('history', 28), h('div', null, t('No git commands yet')), h('div', { class: 'dim' }, t('Fetch, commit, merge… each shows up here with the exact command.')))])
  clear(body).append(
    h('p', { class: 'dim cmd-lead' }, t('The commands Git Control ran for you, newest first. Reading commands (status, log…) are left out.')),
    ...list
      .slice()
      .reverse()
      .map((c) =>
        h(
          'div',
          { class: `cmd-row ${c.code === 0 ? '' : 'bad'}` },
          h('span', { class: 'cmd-t dim' }, new Date(c.at).toLocaleTimeString(LANG)),
          h('code', { class: 'grow cmd-c', title: c.cmd }, c.cmd),
          h('span', { class: 'dim cmd-ms' }, c.code === 0 ? t('{n} ms', { n: c.ms }) : t('exit {code}', { code: c.code })),
          iconBtn('copy', t('Copy the command'), () => copy(c.cmd))
        )
      )
  )
}
/** After an action, when "show git commands" is on: the commands it ran, under its message. */
async function cmdNote(since) {
  if (!store.get('showCmds', false)) return
  const list = await call('gitLog').catch(() => [])
  const mine = list.filter((c) => c.at >= since).map((c) => c.cmd)
  if (mine.length) toast(h('div', { class: 'cmd-toast' }, ...mine.slice(-4).map((c) => h('code', null, c))), 'ok', 6000)
}

/** How each file of the operation in progress was resolved (current, incoming, AI, by hand), for the conflicts page. */
const cfLog = new Map()
/** The conflicts of the operation in progress, in one place: every file, all at once or one by one, then Commit. */
function openConflicts() {
  const st = state.status
  if (!st?.state) return toast(t('Nothing is being merged right now'))
  const files = st.files.filter((f) => f.conflict)
  const sides = conflictSides()
  const opKey = `${st.state}:${sides.incoming}>${sides.current}`
  if (cfLog.key !== opKey) (cfLog.clear(), (cfLog.key = opKey)) // a new merge starts clean
  const body = h('div', { class: 'cf-hub' })
  const finishLabel = st.state === 'merge' ? t('Commit merge') : t('Continue')
  let busy = false
  // while an action runs, every button on the page shows it cannot be pressed
  const setBusyPage = (on) => body.querySelectorAll('button').forEach((b) => (b.disabled = on))
  const reopen = () => {
    if (state.sheets.includes(sheet)) closeSheet()
    if (state.status?.state) openConflicts()
  }
  /** Keep one side of whole files (several at once): one refresh at the end. */
  // act only on files that still conflict (the page may be a moment behind what was just done)
  const stillConflicted = (paths) => {
    const now = new Set((state.status?.files || []).filter((f) => f.conflict).map((f) => f.path))
    return paths.filter((x) => now.has(x))
  }
  async function takeWhole(paths, side) {
    if (busy) return
    paths = stillConflicted(paths)
    if (!paths.length) return reopen()
    busy = true
    setBusyPage(true)
    setBusy(1)
    const name = side === 'ours' ? sides.current : sides.incoming
    let n = 0
    try {
      for (const p of paths) {
        await call('useSide', { file: p, side })
        cfLog.set(p, side === 'ours' ? 'current' : 'incoming')
        n++
      }
      toast(n > 1 ? t('Kept {name} in {n} files', { name, n }) : t('Kept {name} in {n} file', { name, n }))
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(-1)
      await refreshAll() // the page stays busy until it shows the new state
      busy = false
      reopen()
    }
  }
  /** AI resolves the files one by one; each is saved and staged, then shown as "AI · Review". */
  async function aiFiles(paths) {
    if (busy) return
    paths = stillConflicted(paths)
    if (!paths.length) return reopen()
    busy = true
    setBusyPage(true)
    let done = 0
    const fails = []
    for (const p of paths) {
      const row = body.querySelector(`.cf-file[data-path="${CSS.escape(p)}"]`)
      row?.classList.add('cf-working')
      const tag = row?.querySelector('.cf-state')
      if (tag) append(clear(tag), [h('span', { class: 'ai-dots' }, h('i'), h('i'), h('i')), t('AI is resolving…')])
      try {
        const r = await request('ai.resolveFile', { repo: state.repo, file: p }, 118000)
        await call('writeWorkFile', { file: p, text: r.text, stage: true })
        cfLog.set(p, 'ai')
        done++
        row?.classList.replace('cf-working', 'cf-ok')
        if (tag) append(clear(tag), [icon('check', 11), t('Resolved by {agent}', { agent: r.agent })])
      } catch (e) {
        fails.push(`${basename(p)}: ${e.message}`)
        row?.classList.remove('cf-working')
        if (tag) append(clear(tag), [icon('alert', 11), t('AI could not resolve it')])
      }
    }
    if (done) toast(done > 1 ? t('AI resolved {n} files. Review them before you commit.', { n: done }) : t('AI resolved {n} file. Review them before you commit.', { n: done }), 'ok', 7000)
    if (fails.length) toast(fails.join('\n'), 'error', 9000)
    await refreshAll()
    busy = false
    reopen()
  }
  const left = files.map((f) => f.path)
  const done = [...cfLog.entries()].filter(([p]) => !left.includes(p))

  body.append(
    h('div', { class: 'cf-route' }, sideChip('incoming', sides.incoming), icon('right', 14), sideChip('current', sides.current)),
    h(
      'p',
      { class: 'cf-lead' },
      files.length
        ? files.length > 1
          ? t('{op} {incoming} into {current}. {n} files changed on both sides. Keep one side for all of them, let AI do it, or go file by file.', { op: sides.op, incoming: sides.incoming, current: sides.current, n: files.length })
          : t('{op} {incoming} into {current}. {n} file changed on both sides. Keep one side for all of them, let AI do it, or go file by file.', { op: sides.op, incoming: sides.incoming, current: sides.current, n: files.length })
        : st.state === 'merge'
          ? t('Every conflict is resolved. Check the result, then commit the merge.')
          : t('Every conflict is resolved. Check the result, then continue.')
    )
  )
  // one step for everything
  if (files.length)
    body.append(
      h(
        'div',
        { class: 'cf-all' },
        h('span', { class: 'cf-all-k' }, files.length > 1 ? t('All {n} files', { n: files.length }) : t('This file')),
        h('span', { class: 'cf-auto-slot' }),
        h('button', { class: 'btn sm cf-cur', title: t("Keep {branch}'s version wherever they conflict", { branch: sides.current }), onClick: () => takeWhole(left, 'ours') }, icon('left', 12), t('Accept all current')),
        h('button', { class: 'btn sm cf-inc', title: t("Keep {branch}'s version wherever they conflict", { branch: sides.incoming }), onClick: () => takeWhole(left, 'theirs') }, t('Accept all incoming'), icon('right', 12)),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm ai-gen', title: t('AI merges both sides of every file; you review before committing'), onClick: () => aiFiles(left) }, icon('wand', 13), files.length > 1 ? t('AI resolve all {n}', { n: files.length }) : t('AI resolve'))
      )
    )
  // which parts need no choice: counted in the background, then one button applies them all
  async function analyze(paths) {
    const info = {}
    await Promise.all(paths.map((p) => conflictAnalysis(p).then((a) => (info[p] = a), () => null)))
    if (!sheet.el.isConnected) return
    let total = 0
    for (const p of paths) {
      const a = info[p]
      if (!a) continue
      total += a.auto
      const tag = body.querySelector(`.cf-file[data-path="${CSS.escape(p)}"] .cf-state`)
      if (tag && !tag.textContent) tag.textContent = (a.blocks.length === 1 ? t('{n} conflict', { n: a.blocks.length }) : t('{n} conflicts', { n: a.blocks.length })) + (a.auto ? ` · ${t('{n} automatic', { n: a.auto })}` : '')
    }
    const slot = body.querySelector('.cf-auto-slot')
    if (slot && total)
      slot.replaceWith(
        h('button', { class: 'btn sm primary cf-auto', title: t('Parts where both sides made the same change, only one side really changed, or only spaces differ'), onClick: () => applyAuto(paths.filter((p) => info[p]?.auto)) }, icon('check', 12), t('Apply {n} non-conflicting', { n: total }))
      )
  }
  async function applyAuto(paths) {
    if (busy) return
    paths = stillConflicted(paths)
    if (!paths.length) return reopen()
    busy = true
    setBusyPage(true)
    setBusy(1)
    let n = 0
    let whole = 0
    try {
      for (const p of paths) {
        const r = await applyNonConflicting(p, sides)
        n += r.applied
        if (r.applied && !r.left) (cfLog.set(p, 'auto'), whole++)
      }
      toast((n === 1 ? t('Merged {n} part automatically', { n }) : t('Merged {n} parts automatically', { n })) + (whole ? ` · ${whole === 1 ? t('{n} file done', { n: whole }) : t('{n} files done', { n: whole })}` : '') + '. ' + t('The rest need your choice.'))
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setBusy(-1)
      await refreshAll()
      busy = false
      reopen()
    }
  }
  if (files.length) setTimeout(() => analyze(left), 0)
  // file by file
  if (files.length) {
    body.append(h('div', { class: 'section-head' }, t('To resolve'), h('span', { class: 'count' }, files.length)))
    const list = h('div', { class: 'cf-files' })
    for (const f of files)
      list.append(
        h(
          'div',
          { class: 'cf-file', 'data-path': f.path },
          icon('alert', 13),
          h('button', { class: 'link-btn grow ellipsis cf-name', title: t('Resolve {file} conflict by conflict', { file: f.path }), onClick: () => resolveConflict(f.path) }, f.path),
          h('span', { class: 'cf-state dim' }),
          h('button', { class: 'btn sm', title: t("Keep {branch}'s version of this file", { branch: sides.current }), onClick: () => takeWhole([f.path], 'ours') }, t('Current')),
          h('button', { class: 'btn sm', title: t("Keep {branch}'s version of this file", { branch: sides.incoming }), onClick: () => takeWhole([f.path], 'theirs') }, t('Incoming')),
          h('button', { class: 'btn sm', title: t('Let AI merge this file; you review it'), onClick: () => aiFiles([f.path]) }, icon('wand', 12), 'AI'),
          h('button', { class: 'btn sm primary', onClick: () => resolveConflict(f.path) }, icon('edit', 12), t('Resolve'))
        )
      )
    body.append(list)
  }
  // what is done: how, with a look at the result
  if (done.length) {
    const how = { current: t('Kept current ({branch})', { branch: sides.current }), incoming: t('Kept incoming ({branch})', { branch: sides.incoming }), ai: t('Resolved by AI'), manual: t('Resolved by you'), auto: t('Merged automatically') }
    body.append(h('div', { class: 'section-head' }, t('Resolved'), h('span', { class: 'count' }, done.length)))
    const list = h('div', { class: 'cf-files' })
    for (const [p, kind] of done)
      list.append(
        h(
          'div',
          { class: `cf-file cf-ok ${kind === 'ai' ? 'cf-ai' : ''}` },
          icon('check', 13),
          h('span', { class: 'grow ellipsis mono cf-name' }, p),
          h('span', { class: 'cf-state' }, how[kind] || t('Resolved')),
          h('button', { class: 'btn sm', title: t('See the result against your branch'), onClick: () => showDiff(t('{file} · result', { file: basename(p) }), () => call('diff', { file: p, staged: true })) }, t('Review'))
        )
      )
    body.append(list)
  }
  if (!files.length && !done.length) body.append(h('div', { class: 'empty cf-done' }, icon('check', 28), h('div', null, t('All conflicts resolved'))))
  else if (!files.length) body.append(h('div', { class: 'cf-ready' }, icon('check', 16), h('span', null, t('All conflicts resolved')), h('span', { class: 'grow' }), h('button', { class: 'btn primary', onClick: () => finish() }, icon('check', 12), finishLabel)))
  function finish() {
    closeSheet()
    cfLog.clear()
    run('continue', {}, { success: st.state === 'merge' ? t('Merge committed') : t('Continued') })
  }
  openSheet(t('Conflicts · {incoming} → {current}', { incoming: sides.incoming, current: sides.current }), body, [
    h('button', { class: 'btn sm danger', onClick: async () => (await confirmBox(t('Abort {op}?', { op: st.state }), t('{branch} goes back to how it was before.', { branch: sides.current }), t('Abort'), true)) && (closeSheet(), cfLog.clear(), run('abort', {}, { success: t('Aborted') })) }, t('Abort')),
    h('button', { class: 'btn sm primary', disabled: files.length > 0, title: files.length ? t('Resolve every file first') : '', onClick: finish }, icon('check', 12), finishLabel)
  ])
  const sheet = state.sheets[state.sheets.length - 1]
  sheet.el.classList.add('wide-sheet')
  placeSheet(sheet.el)
}

/**
 * Resolve one file, conflict by conflict: Current (left) or Incoming (right), each with its branch's
 * name, or both; the result is shown and can be edited. Saving opens the next conflicted file.
 */
async function resolveConflict(file) {
  let text
  try {
    text = await call('readWorkFile', { file })
  } catch (e) {
    return toast(e.message, 'error')
  }
  const eolStr = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const parts = [] // strings and conflict blocks
  let buf = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('<<<<<<<')) {
      if (buf.length) parts.push(buf.join(eolStr))
      buf = []
      const block = { ours: [], base: [], theirs: [], oursLabel: lines[i].slice(8).trim(), theirsLabel: '', choice: null, result: null }
      let where = 'ours'
      for (i++; i < lines.length; i++) {
        const l = lines[i]
        if (l.startsWith('|||||||')) where = 'base'
        else if (l.startsWith('=======')) where = 'theirs'
        else if (l.startsWith('>>>>>>>')) {
          block.theirsLabel = l.slice(8).trim()
          break
        } else block[where].push(l)
      }
      parts.push(block)
    } else buf.push(lines[i])
  }
  if (buf.length) parts.push(buf.join(eolStr))
  const blocks = parts.filter((x) => typeof x === 'object')
  if (!blocks.length) {
    if (await confirmBox(t('No conflict markers left'), t('{file} has no conflict markers. Mark it as resolved?', { file }), t('Mark resolved'))) {
      await run('stage', { files: [file] }, { success: t('Marked resolved') })
      nextConflict(file)
    }
    return
  }
  const sides = conflictSides(blocks[0])
  const hasBase = await withBase(file, blocks)
  const all = (state.status?.files || []).filter((f) => f.conflict).map((f) => f.path)
  const pos = all.indexOf(file)
  const body = h('div', { class: 'resolver' })
  const saveBtn = h('button', { class: 'btn sm primary', disabled: true, onClick: save }, icon('check', 12), all.length > 1 ? t('Save & next file') : t('Save & mark resolved'))
  const progress = h('span', { class: 'res-progress' })
  const update = () => {
    const done = blocks.filter((b) => b.choice).length
    progress.textContent = t('{done} of {total} resolved', { done, total: blocks.length })
    progress.classList.toggle('ok', done === blocks.length)
    saveBtn.disabled = done !== blocks.length
  }
  body.append(
    h(
      'div',
      { class: 'res-top' },
      h('div', { class: 'cf-route' }, sideChip('incoming', sides.incoming), icon('right', 14), sideChip('current', sides.current)),
      h('span', { class: 'grow' }),
      pos >= 0 && all.length > 1 && h('span', { class: 'dim' }, t('File {n} of {total}', { n: pos + 1, total: all.length })),
      h('button', { class: 'btn sm', title: t("Keep {branch}'s side in every conflict below", { branch: sides.current }), onClick: () => blocks.forEach((b) => b.pick('ours')) }, t('Accept all current')),
      h('button', { class: 'btn sm', title: t("Keep {branch}'s side in every conflict below", { branch: sides.incoming }), onClick: () => blocks.forEach((b) => b.pick('theirs')) }, t('Accept all incoming')),
      hasBase && h('button', { class: 'btn sm', title: t('Show what the file looked like before either side changed it'), onClick: (e) => (body.classList.toggle('show-base'), e.currentTarget.classList.toggle('on')) }, icon('history', 12), t('Show base')),
      h('button', { class: 'btn sm ai-gen', title: t('AI merges both sides of this file; you check and edit before saving'), onClick: (e) => aiSuggest(e.currentTarget) }, icon('wand', 13), t('AI resolve'))
    )
  )
  blocks.forEach((b, n) => {
    const card = h('div', { class: 'res-block' })
    const result = h('textarea', { class: 'res-result mono', spellcheck: 'false', rows: 3 })
    const resultBox = h('div', { class: 'res-result-box hidden' }, h('div', { class: 'res-label' }, t('Result'), h('span', { class: 'dim' }, ` · ${t('you can edit it')}`)), result)
    result.addEventListener('input', () => {
      b.result = result.value.split('\n')
      b.choice ||= 'edit'
      update()
    })
    const side = (which, name, ls) =>
      h(
        'div',
        { class: `res-side ${which === 'ours' ? 'current' : 'incoming'}`, role: 'button', tabindex: 0, title: t('Use this ({name})', { name }), onClick: () => b.pick(which), onKeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), b.pick(which)) },
        h('div', { class: 'res-side-head' }, h('span', { class: 'side-k' }, which === 'ours' ? t('Current') : t('Incoming')), h('span', { class: 'mono side-n', title: name }, `(${name})`), h('span', { class: 'grow' }), h('span', { class: 'res-pick' }, icon('check', 11), t('Use this'))),
        h('pre', { class: 'res-code' }, ls.join('\n') || ' ')
      )
    b.pick = (choice) => {
      b.choice = choice
      b.result = choice === 'auto' ? b.autoRes : choice === 'ours' ? b.ours : choice === 'theirs' ? b.theirs : [...b.ours, ...b.theirs]
      result.value = b.result.join('\n')
      result.rows = Math.min(14, Math.max(2, b.result.length))
      resultBox.classList.remove('hidden')
      card.dataset.c = choice
      card.querySelectorAll('.res-actions .btn').forEach((x) => x.classList.toggle('primary', x.dataset.c === choice))
      card.classList.add('done')
      update()
    }
    card.append(
      h(
        'div',
        { class: 'res-head' },
        h('strong', null, t('Conflict {n} of {total}', { n: n + 1, total: blocks.length })),
        h('span', { class: 'pill res-auto', title: t('Only one side really changed this part (or both made the same change); it was merged for you. Pick a side to change it.') }, icon('check', 10), t('Merged automatically')),
        h('span', { class: 'grow' }),
        h('div', { class: 'res-actions' }, ...[['ours', t('Accept current')], ['theirs', t('Accept incoming')], ['both', t('Accept both')]].map(([c, l]) => h('button', { class: 'btn sm', 'data-c': c, onClick: () => b.pick(c) }, l)))
      ),
      h('div', { class: 'res-sides' }, side('ours', sides.current, b.ours), hasBase && h('div', { class: 'res-side base' }, h('div', { class: 'res-side-head' }, h('span', { class: 'side-k' }, t('Base')), h('span', { class: 'side-n' }, t('(before both)'))), h('pre', { class: 'res-code' }, b.base.join('\n') || ' ')), side('theirs', sides.incoming, b.theirs)),
      resultBox
    )
    body.append(card)
    b.autoRes = autoBlock(b, hasBase)
    if (b.autoRes) b.pick('auto')
  })
  update()
  // AI: the whole file merged by AI, shown for checking and editing; Save writes it
  let aiText = null
  const aiArea = h('textarea', { class: 'res-result mono res-ai', spellcheck: 'false' })
  async function aiSuggest(btn) {
    btn.disabled = true
    const t0 = Date.now()
    const tick = () => append(clear(btn), [h('span', { class: 'ai-dots' }, h('i'), h('i'), h('i')), t('AI is resolving… {n}s', { n: Math.floor((Date.now() - t0) / 1000) })])
    tick()
    const timer = setInterval(tick, 1000)
    try {
      const r = await request('ai.resolveFile', { repo: state.repo, file }, 118000)
      aiText = r.text
      aiArea.value = r.text
      aiArea.rows = Math.min(30, Math.max(8, r.text.split('\n').length))
      body.querySelectorAll('.res-block').forEach((x) => x.remove())
      body.append(h('div', { class: 'res-block done' }, h('div', { class: 'res-head' }, h('strong', null, t('Resolved by {agent}', { agent: r.agent })), h('span', { class: 'dim' }, ` · ${t('check it, edit if needed, then save')}`)), h('div', { class: 'res-result-box' }, aiArea)))
      progress.textContent = t('AI result ready')
      progress.classList.add('ok')
      saveBtn.disabled = false
      btn.remove()
    } catch (e) {
      toast(e.message, 'error')
      btn.disabled = false
      append(clear(btn), [icon('wand', 13), t('AI resolve')])
    } finally {
      clearInterval(timer)
    }
  }
  async function save() {
    const out = aiText != null ? aiArea.value : parts.map((x) => (typeof x === 'string' ? x : x.result.join(eolStr))).join(eolStr)
    try {
      await call('writeWorkFile', { file, text: out, stage: true })
      cfLog.set(file, aiText != null ? 'ai' : 'manual')
      toast(t('{file} resolved', { file: basename(file) }))
      closeSheet()
      await refreshAll()
      nextConflict(file)
    } catch (e) {
      toast(e.message, 'error')
    }
  }
  openSheet(t('Resolve {file}', { file: basename(file) }), body, [progress, saveBtn])
  const sheet = state.sheets[state.sheets.length - 1]
  sheet.el.classList.add('wide-sheet')
  placeSheet(sheet.el)
}
/** After a file is resolved: the next conflicted one, or the conflicts page to commit. */
function nextConflict(done) {
  const left = (state.status?.files || []).filter((f) => f.conflict && f.path !== done)
  if (left.length) return resolveConflict(left[0].path)
  if (state.status?.state) openConflicts()
}

/** A pull/merge request's diff; click a line to comment on it. */
async function reviewDiffSheet(it) {
  openSheet(`${it.repo} ${it.provider === 'github' ? '#' : '!'}${it.number} · ${it.title}`, h('div', { class: 'inline-skeleton', style: { margin: '12px' } }, h('span'), h('span'), h('span')), [
    h('button', { class: 'btn sm', onClick: () => aiReviewModal(it) }, icon('wand', 12), t('AI review')),
    h('button', { class: 'btn sm primary', onClick: () => reviewDialog(it) }, icon('edit', 12), t('Review'))
  ])
  const sheet = state.sheets[state.sheets.length - 1]
  sheet.el.classList.add('wide-sheet')
  placeSheet(sheet.el)
  let diff
  try {
    diff = (await request('reviews.diff', { ...it, ci: undefined }, 90000)).diff
  } catch (e) {
    closeSheet()
    return toast(e.message, 'error')
  }
  const wrap = renderDiff(diff, null, {
    onLine: async ({ path: file, side, line, text }) => {
      const r = await dialog({ title: t('Comment on {file}:{line}', { file: basename(file), line }), message: text.slice(0, 200), fields: [{ key: 'body', label: t('Comment'), type: 'textarea' }], ok: t('Comment') })
      if (!r?.body.trim()) return
      try {
        await request('reviews.lineComment', { item: it, path: file, line, side, body: r.body }, 90000)
        toast(t('Comment posted'))
      } catch (e) {
        toast(e.message, 'error')
      }
    }
  })
  if (sheet.el.isConnected) clear(sheet.el.querySelector('.sheet-body')).append(wrap)
}

let queuedUi = null
/** The status bar asked for a tab (MR/PR) or Repo Overview. */
function applyUi({ tab, overview } = {}) {
  if (overview) return reposOverview()
  if (tab && TABS.some(([id]) => id === tab) && state.tab !== tab) setTab(tab)
}
// the status bar "reviews" item opens this tab on Reviews
if (hasOrca) {
  try {
    // shown now: at once; hidden (another tab in front, Orca brings this one up next): when it shows
    window.orca.plugin?.on?.('ui.show', (ui = {}) => (isShown() ? applyUi(ui) : (queuedUi = ui)))
    // the status bar's ↻ checked MR / PR now: an open MR / PR tab reads the new list
    window.orca.plugin?.on?.('reviews.changed', () => state.tab === 'reviews' && loadReviews(true, true).then(() => renderView({ force: true }), () => {}))
  } catch {}
  setTimeout(() => request('ui.pending', {}).then((p) => p && applyUi(p), () => {}), 800)
}


/* =========================================================================
   Phones and tablets (Orca's web client in a mobile browser)
   ========================================================================= */
// The branch sidebar becomes a drawer behind the ☰ button on narrow screens.
const setSide = (open) => document.body.classList.toggle('side-open', open)
$('#sideToggle')?.addEventListener('click', () => setSide(!document.body.classList.contains('side-open')))
$('#sideBackdrop')?.addEventListener('click', () => setSide(false))
document.addEventListener('click', (e) => {
  // picking something in the drawer closes it (but not opening its menus)
  if (e.target.closest?.('#side .side-item, #side .item') && !e.target.closest('.hover-actions, .icon-btn')) setSide(false)
})
// Long-press = right-click, so the commit, branch and file menus work by touch.
{
  let timer = null
  let start = null
  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      start = { x: t.clientX, y: t.clientY, target: e.target }
      clearTimeout(timer)
      timer = setTimeout(() => {
        start.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }))
        start.fired = true
      }, 520)
    },
    { passive: true }
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0]
      if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 10) clearTimeout(timer)
    },
    { passive: true }
  )
  document.addEventListener('touchend', (e) => {
    clearTimeout(timer)
    if (start?.fired) e.preventDefault() // the long-press opened a menu: no click as well
    start = null
  })
}

/* =========================================================================
   boot
   ========================================================================= */
$('#repoBtn').addEventListener('click', (e) => repoMenu(e.currentTarget))

// Right-click a branch, remote, tag, file, stash or worktree row: the same menu as its More button,
// opened at the pointer. Commit rows have their own handler; text fields keep the browser menu.
document.addEventListener('contextmenu', (e) => {
  if (e.defaultPrevented || e.target.closest('input, textarea, [contenteditable]')) return
  const row = e.target.closest('.item, .file-row, .side-item, .wt-row, .stash-row')
  const more = row?.querySelector(`button[aria-label=${JSON.stringify(t('More'))}], button[aria-label=${JSON.stringify(t('Resolve'))}]`)
  if (!more) return
  e.preventDefault()
  menuPoint = { x: e.clientX, y: e.clientY }
  more.click()
  menuPoint = null
})

if (hasOrca) {
  try {
    window.orca.on('workspace.changed', () => followFocus())
  } catch {}
}
let following = false
async function followFocus() {
  // A confirm or menu is about this repository, and so is a running operation: switching now
  // would send the action to another one.
  if (state.pinned || (IN_TAB && docRepo) || !isShown() || following || state.busy || document.querySelector('.overlay, .menu')) return
  following = true
  try {
    await followFocusOnce()
  } finally {
    following = false
  }
}
async function followFocusOnce() {
  const before = state.repo
  await resolveRepo()
  if (state.repo !== before) refreshAll()
}
// The Git Control tab tells the worker when it is shown or hidden, so switching to another workspace
// while on Git Control brings that workspace's Git Control to the front. A hidden tab may only shrink
// to nothing rather than become "hidden", so its size counts too.
if (IN_TAB) {
  let shown = null
  const report = () => {
    const now = document.visibilityState === 'visible' && window.innerWidth > 0 && window.innerHeight > 0
    if (now === shown) return
    const wasHidden = shown === false
    shown = now
    request('graph.visible', { visible: now }).catch(() => {})
    // back on screen after another project: one quiet check instead of polling while hidden
    if (now && wasHidden) pollStatus(true)
    if (now && queuedUi) (applyUi(queuedUi), (queuedUi = null)) // asked for while it was hidden
  }
  document.addEventListener('visibilitychange', report)
  new ResizeObserver(report).observe(document.documentElement)
  window.addEventListener('pagehide', () => request('graph.visible', { visible: false }).catch(() => {}))
  report()
}
window.addEventListener('focus', () => (state.pinned ? pollStatus() : followFocus().then(pollStatus)))
// workspace.changed may not fire for every switch, so also re-check the focused worktree now and then.
setInterval(() => followFocus(), 5000)
setInterval(pollStatus, 4000)
// back from another panel (e.g. a push in Orca's own Git view): look for changes at once
window.addEventListener('focus', () => pollStatus())
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && pollStatus())
/**
 * Light theme: Orca passes its colors as --orca-* variables, not a class. Read the background's
 * luminance and set html.light, again whenever Orca rewrites the variables (theme switch).
 */
function syncTheme() {
  const probe = h('div', { style: { position: 'absolute', visibility: 'hidden', background: 'var(--orca-background, var(--bg))' } })
  document.body.append(probe)
  const m = getComputedStyle(probe).backgroundColor.match(/[\d.]+/g)
  probe.remove()
  if (!m || (m.length > 3 && +m[3] === 0)) return
  const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const lum = 0.2126 * lin(+m[0]) + 0.7152 * lin(+m[1]) + 0.0722 * lin(+m[2])
  document.documentElement.classList.toggle('light', lum > 0.4)
}
syncTheme()
new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] })
new MutationObserver(syncTheme).observe(document.head, { childList: true, subtree: true, characterData: true })
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', syncTheme)

/* =========================================================================
   tooltips: every title="" shows in our own tooltip instead of the browser's
   ========================================================================= */
// Elements keep their title (code, tests and screen readers use it); while one is hovered its title
// moves to data-tip so the browser's own tooltip stays away, and comes back when the pointer leaves.
const tip = { el: null, target: null, timer: 0, warmUntil: 0 }
function tipEl() {
  if (!tip.el) {
    tip.el = h('div', { class: 'tip', role: 'tooltip' })
    document.body.append(tip.el)
  }
  return tip.el
}
const sameText = (a, b) => String(a || '').replace(/\s+/g, ' ').trim() === String(b || '').replace(/\s+/g, ' ').trim()
/** Is this element's text (or a child's) cut short on screen: an ellipsis, or a name shortened with "…"? */
function isCut(el) {
  const cut = (x) => x.scrollWidth > x.clientWidth + 1 && getComputedStyle(x).textOverflow === 'ellipsis'
  if (cut(el)) return true
  const kids = el.querySelectorAll('*')
  for (let i = 0; i < kids.length && i < 30; i++) if (cut(kids[i])) return true
  return false
}
function showTip(target) {
  const text = target.dataset.tip
  if (!text || !target.isConnected) return
  const el = tipEl()
  el.textContent = text
  el.classList.remove('on')
  el.style.left = '0px'
  el.style.top = '0px'
  const r = target.getBoundingClientRect()
  const t = el.getBoundingClientRect()
  const gap = 6
  const below = r.bottom + gap + t.height <= innerHeight - 4
  const top = below ? r.bottom + gap : r.top - gap - t.height
  const left = Math.max(6, Math.min(innerWidth - t.width - 6, r.left + r.width / 2 - t.width / 2))
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(Math.max(4, top))}px`
  el.dataset.side = below ? 'below' : 'above'
  el.classList.add('on')
}
function hideTip(restore = true) {
  clearTimeout(tip.timer)
  if (tip.el?.classList.contains('on')) tip.warmUntil = Date.now() + 400
  tip.el?.classList.remove('on')
  const t = tip.target
  tip.target = null
  if (restore && t && t.dataset.tip != null) {
    if (!t.dataset.tipAuto && !t.hasAttribute('title')) t.setAttribute('title', t.dataset.tip)
    delete t.dataset.tip
    delete t.dataset.tipAuto
  }
}
document.addEventListener(
  'mouseover',
  (e) => {
    let t = e.target.closest?.('[title], [data-tip]')
    let auto = false
    if (!t) {
      // no title: text the layout cut with "…" shows whole
      for (let el = e.target, i = 0; el && el !== document.body && i < 4; el = el.parentElement, i++) {
        if (el.nodeType === 1 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === 'ellipsis' && el.textContent.trim()) {
          t = el
          auto = true
          break
        }
      }
    }
    if (t === tip.target) return
    hideTip()
    if (!t || matchMedia('(hover: none)').matches) return
    const text = auto ? t.textContent.trim() : t.getAttribute('title') ?? t.dataset.tip
    if (!text || !text.trim()) return
    t.dataset.tip = text
    if (auto) t.dataset.tipAuto = '1'
    t.removeAttribute('title')
    // the title says nothing the screen does not already show in full: no tooltip (and no browser one)
    if (!auto && sameText(t.textContent, text) && !isCut(t)) {
      tip.target = t
      return
    }
    tip.target = t
    tip.timer = setTimeout(() => tip.target === t && showTip(t), Date.now() < tip.warmUntil ? 0 : 450)
  },
  true
)
document.addEventListener('mouseout', (e) => tip.target && !tip.target.contains(e.relatedTarget) && hideTip(), true)
// a press, a key, a scroll or the window losing focus: the tooltip gets out of the way
for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) window.addEventListener(ev, () => hideTip(), true)
document.addEventListener('scroll', () => tip.el?.classList.contains('on') && hideTip(), true)

/* =========================================================================
   graph: row quick actions, date chip, keyboard, command palette
   ========================================================================= */
/** Buttons that appear on the hovered (or keyboard-selected) row; the full menu stays on right-click. */
function rowActions(c) {
  const act = (name, title, fn) => iconBtn(name, title, (e) => (e.stopPropagation(), fn(e)), { class: 'icon-btn ra-btn' })
  return h(
    'div',
    { class: 'row-actions', onClick: (e) => e.stopPropagation(), onContextmenu: (e) => e.stopPropagation() },
    act('commit', t('Checkout this commit'), () => checkoutCommit(c.hash)),
    act('branch', t('New branch here'), () => newBranch(c.hash)),
    act('copy', t('Copy hash'), () => copy(c.hash)),
    act('more', t('More…'), async (e) => {
      const anchor = e.currentTarget
      const full = { ...c, ...(await call('commitShow', { hash: c.hash }).catch(() => ({ message: c.subject || '' }))), refs: c.refs, parents: c.parents }
      commitMenu(anchor, full)
    })
  )
}

/** The day of the first visible row, pinned over the list while it scrolls ("Today", "Yesterday", "Nov 5"). */
function dayLabel(ts) {
  const d = new Date(ts * 1000)
  const today = new Date()
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000)
  if (days === 0) return t('Today')
  if (days === 1) return t('Yesterday')
  return d.toLocaleDateString(LANG, { weekday: days < 7 ? 'short' : undefined, month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}
let dateTick = 0
function updateDateFloat() {
  const chip = document.getElementById('dateFloat')
  if (!chip || state.tab !== 'history') return
  const main = $('#main')
  const bar = main.querySelector('.history-bar')
  const topY = Math.max(bar ? bar.getBoundingClientRect().bottom : 0, main.getBoundingClientRect().top) + 2
  let first = null
  for (const r of main.querySelectorAll('.commit-row[data-time]')) {
    if (r.getBoundingClientRect().bottom > topY) {
      first = r
      break
    }
  }
  const show = first && main.scrollTop > ROW_H * 3
  chip.classList.toggle('on', !!show)
  if (show) chip.textContent = dayLabel(+first.dataset.time)
}
$('#main')?.addEventListener(
  'scroll',
  () => {
    if (dateTick) return
    dateTick = requestAnimationFrame(() => ((dateTick = 0), updateDateFloat()))
  },
  { passive: true }
)

/** ↑/↓ (or j/k) move through the graph; Enter opens; / searches; Esc closes. Ctrl+.: commands (Ctrl+K belongs to Orca). */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && !e.target.closest?.('input, textarea, [contenteditable]') && !document.querySelector('.overlay, .menu') && state.repo) {
    e.preventDefault()
    return undoLast()
  }
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.code === 'Period' || e.key === '.')) {
    if (!state.repo || document.querySelector('.overlay')) return
    e.preventDefault()
    return commandPalette()
  }
  if (!IN_TAB || state.tab !== 'history' || e.ctrlKey || e.metaKey || e.altKey) return
  if (e.target.closest?.('input, textarea, select, [contenteditable], .overlay, .menu') || document.querySelector('.overlay, .menu')) return
  const H = state.history
  if (e.key === '/') {
    e.preventDefault()
    searchBox?.focus()
    return searchBox?.select()
  }
  const down = e.key === 'ArrowDown' || e.key === 'j'
  const up = e.key === 'ArrowUp' || e.key === 'k'
  if (down || up) {
    const rows = [...document.querySelectorAll('#main .commit-row[data-hash]')]
    if (!rows.length) return
    e.preventDefault()
    let cur = rows.findIndex((r) => r.classList.contains('kbd'))
    if (cur < 0) cur = rows.findIndex((r) => r.classList.contains('selected'))
    const next = rows[cur < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, cur + (down ? 1 : -1)))]
    rows.forEach((r) => r.classList.remove('kbd'))
    next.classList.add('kbd')
    next.scrollIntoView({ block: 'nearest' })
    // docked: the details follow the selection; inline: Enter opens it
    if (dockMode() && state.sheets.some((s) => s.dock)) {
      const c = H.commits.find((x) => x.hash === next.dataset.hash)
      if (c) openDock(c)
    }
    return
  }
  if (e.key === 'Enter') {
    const row = document.querySelector('#main .commit-row.kbd') || document.querySelector('#main .commit-row.selected')
    if (!row) return
    e.preventDefault()
    row.click()
    return
  }
  if (e.key === 'Escape' && !state.sheets.length && H.open) {
    document.querySelector('#main .commit-inline')?.remove()
    document.querySelector('#main .commit-row.selected')?.classList.remove('selected')
    H.open = null
  }
})
// the mouse takes over from the keyboard selection
document.addEventListener('mousemove', () => document.querySelector('#main .commit-row.kbd')?.classList.remove('kbd'), { passive: true })

/** Ctrl+.: type what to do (push, new branch, stash, a tab…) and press Enter. */
function commandPalette() {
  closeOverlays()
  const st = state.status || {}
  const cmds = [
    [t('Fetch all'), 'fetch', () => run('fetch', {}, { success: t('Fetched') })],
    [t('Repo Overview'), 'grid', () => reposOverview()],
    ...(state.folder ? state.folder.children.filter((c) => !sameRepoPath(c.path, state.repo || '')).map((c) => [t('Switch to repo {name}', { name: c.name }), 'folder', () => pickFolderRepo(c.path)]) : []),
    [st.behind ? t('Pull ({n} waiting)', { n: st.behind }) : t('Pull'), 'pull', () => run('pull', {}, { success: t('Pulled') })],
    [t('Pull with rebase'), 'pull', () => run('pull', { rebase: true }, { success: t('Pulled with rebase') })],
    [st.ahead ? t('Push ({n} waiting)', { n: st.ahead }) : t('Push'), 'push', () => run('push', {}, { success: t('Pushed') })],
    [t('Stash changes'), 'stash', () => run('stashSave', { untracked: true }, { success: t('Stashed') }), !st.files?.length],
    [t('Switch branch…'), 'branch', () => quickSwitch($('.branch-chip') || $('#toolbar'))],
    [t('New branch…'), 'plus', () => newBranch(st.oid || 'HEAD')],
    [t('Merge request…'), 'pr', () => mergeRequestDialog()],
    [t('Go to the checked-out commit'), 'current', () => goToHead()],
    [t('Search commits'), 'search', () => (setTab('history'), setTimeout(() => searchBox?.focus(), 50))],
    [t('Undo the last action ({key})', { key: MOD + 'Z' }), 'undo', () => undoLast()],
    [t('Undo history: go back to any earlier point'), 'history', () => setTab('reflog')],
    [t('Refresh'), 'refresh', () => manualRefresh()],
    [ROW_H > 28 ? t('Compact rows') : t('Comfortable rows'), 'rows', () => setDensity(ROW_H > 28 ? 'compact' : 'comfortable')],
    [t('Keyboard shortcuts'), 'keyboard', () => shortcutsHelp()],
    [t('Show git commands'), 'history', () => openCmdLog()],
    ...TABS.map(([id, label, ic]) => [t('Go to {tab}', { tab: label }), ic, () => setTab(id)])
  ].filter((c) => !c[3])
  const input = h('input', { type: 'text', class: 'pal-input', placeholder: t('Type a command…'), spellcheck: 'false' })
  const list = h('div', { class: 'pal-list', role: 'listbox' })
  let sel = 0
  let shown = cmds
  const done = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const runCmd = (c) => {
    done()
    c?.[2]()
  }
  const draw = () => {
    const q = input.value.trim().toLowerCase()
    shown = q ? cmds.filter((c) => q.split(/\s+/).every((w) => c[0].toLowerCase().includes(w))) : cmds
    sel = Math.min(sel, Math.max(0, shown.length - 1))
    clear(list)
    shown.forEach((c, i) =>
      list.append(h('button', { type: 'button', class: `pal-item ${i === sel ? 'on' : ''}`, role: 'option', onMousemove: () => sel !== i && ((sel = i), draw()), onClick: () => runCmd(c) }, icon(c[1], 14), h('span', null, c[0])))
    )
    if (!shown.length) list.append(h('div', { class: 'pal-none' }, t('No matching command')))
    list.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
  }
  const onKey = (e) => {
    if (!overlay.isConnected) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      done()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length)
      draw()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runCmd(shown[sel])
    }
  }
  input.addEventListener('input', () => ((sel = 0), draw()))
  const overlay = h('div', { class: 'overlay pal-overlay', onMousedown: (e) => e.target === overlay && done() }, h('div', { class: 'palette' }, input, list, h('div', { class: 'pal-foot' }, t('↑↓ choose · Enter run · Esc close'))))
  mountOverlay(overlay, done)
  document.addEventListener('keydown', onKey, true)
  draw()
  input.focus()
}

function shortcutsHelp() {
  const rows = [
    [`${MOD}.`, t('Commands')],
    ['/', t('Search commits')],
    ['↑ ↓ or j k', t('Move through the graph')],
    ['Enter', t('Open the commit')],
    ['Esc', t('Close')],
    [IS_MAC ? '⌘R' : 'F5 / Ctrl+R', t('Refresh')]
  ]
  const box = h('div', { class: 'dialog kbd-dialog' }, h('h3', null, t('Keyboard shortcuts')), h('div', { class: 'kbd-help' }, rows.map(([k, v]) => [h('kbd', null, k), h('span', null, v)])), h('div', { class: 'buttons' }, h('button', { class: 'btn primary', onClick: () => done() }, t('Close'))))
  const done = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (e) => e.key === 'Escape' && overlay.isConnected && (e.preventDefault(), e.stopPropagation(), done())
  const overlay = h('div', { class: 'overlay', onMousedown: (e) => e.target === overlay && done() }, box)
  mountOverlay(overlay, done)
  document.addEventListener('keydown', onKey, true)
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.sheets.length && !document.querySelector('.overlay, .menu')) closeSheet()
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r')) {
    e.preventDefault()
    manualRefresh()
  }
})

// Pick up the language setting; a change since the last start reloads once in the new language.
if (hasOrca) request('ui.language', {}, 10000).then((r) => r?.lang && applyLang(r.lang)).catch(() => {})

;(async () => {
  // opened from the status bar (MR/PR, Overview): asked before anything is drawn, so the tab opens
  // straight on it instead of showing the tab used last first
  let pending = null
  if (IN_TAB) {
    const [doc, ui] = await Promise.all([window.orca.document.get().catch(() => null), hasOrca ? request('ui.pending', {}, 3000).catch(() => null) : null])
    try {
      docRepo = JSON.parse(doc?.content?.text || '{}').repo || null
    } catch {}
    pending = ui
  }
  const start = state.pinned || (IN_TAB ? docRepo : store.get('lastRepo', null))
  if (start) {
    setRepo(start)
    if (pending?.tab && TABS.some(([id]) => id === pending.tab)) state.tab = pending.tab
    if (pending?.overview) state.tab = 'repos'
    // kept as this repository's tab, so restoring it later does not go back to the one before
    if (pending?.tab || pending?.overview) viewMem.set({ tab: state.tab, scroll: 0, scrollTab: state.tab, open: null })
    if (state.status) renderAll()
  }
  refreshAll(true)
})()
