// Translation keys: every t('English text') in panel/app.js is a key; panel/locales/<lang>.json maps it to
// that language. An empty value means "not translated yet" and shows the English.
//   node tools/i18n.mjs          report what each language is missing
//   node tools/i18n.mjs --sync   add new keys (empty) and drop keys the code no longer uses, in code order
//   node tools/i18n.mjs --check  exit 1 if a key is missing, untranslated, or a {placeholder} does not match
//   node tools/i18n.mjs --keys   print the English keys as JSON (for translators)
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const locDir = path.join(root, 'panel', 'locales')
const src = readFileSync(path.join(root, 'panel', 'app.js'), 'utf8')

// t('...'), t("...") and t(`...`) with a plain literal as the first argument
const keys = []
const seen = new Set()
const bad = []
const re = /\bt\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g
for (const m of src.matchAll(re)) {
  const raw = m[1] ?? m[2] ?? m[3]
  if (m[3] != null && raw.includes('${')) {
    bad.push(`line ${src.slice(0, m.index).split('\n').length}: t(\`...\${}\`) — use t('... {name}', { name }) instead`)
    continue
  }
  const key = m[3] != null ? raw.replace(/\\`/g, '`').replace(/\\\\/g, '\\') : JSON.parse('"' + raw.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"')
  if (!seen.has(key)) seen.add(key), keys.push(key)
}

const holders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
const mode = process.argv[2] || ''
if (mode === '--keys') {
  console.log(JSON.stringify(keys, null, 2))
  process.exit(0)
}
let failed = bad.length > 0
for (const b of bad) console.log('✗ ' + b)
console.log(`${keys.length} keys in panel/app.js`)
for (const f of readdirSync(locDir).filter((f) => f.endsWith('.json')).sort()) {
  const file = path.join(locDir, f)
  const dict = JSON.parse(readFileSync(file, 'utf8'))
  const missing = keys.filter((k) => !(k in dict))
  const empty = keys.filter((k) => k in dict && !dict[k])
  const unused = Object.keys(dict).filter((k) => !seen.has(k))
  const wrong = keys.filter((k) => dict[k] && holders(dict[k]) !== holders(k))
  console.log(`${f}: ${keys.length - missing.length - empty.length} translated, ${missing.length} missing, ${empty.length} empty, ${unused.length} unused, ${wrong.length} with wrong {placeholders}`)
  for (const k of wrong) console.log(`  ✗ {placeholders} differ: ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}`)
  if (mode === '--check' && (missing.length || empty.length || wrong.length)) failed = true
  if (mode === '--sync') {
    const out = Object.fromEntries(keys.map((k) => [k, dict[k] ?? '']))
    writeFileSync(file, JSON.stringify(out, null, 2) + '\n')
  }
}
process.exit(failed ? 1 : 0)
