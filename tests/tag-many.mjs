// Tag several repositories at once (Repo Overview): node tests/tag-many.mjs
// api has dev_v1.0.0 and dev_v1.0.9 (newest by version, not by name: 1.0.9 < 1.0.10 is checked too),
// web's main is already tagged dev_v2.3, docs has no dev_v* tag yet. The plan must show the newest
// tag, the next version, that web needs nothing, where the tag goes (a branch as origin has it, or the
// newest tag of another pattern); applying creates and pushes the tags and never overwrites one.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')))
const W = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'gitx-tags-'))
process.env.GIT_CONFIG_GLOBAL = path.join(W, 'global.gitconfig')
fs.writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = T\n\temail = t@e\n[init]\n\tdefaultBranch = main\n')
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GITX_NO_BROWSER = '1'
const run = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim()
const mk = (name) => {
  const d = path.join(W, name)
  const bare = path.join(W, name + '.git')
  run(W, 'init', '-q', '--bare', bare)
  run(W, 'init', '-q', d)
  fs.writeFileSync(path.join(d, 'a.txt'), name + '\n')
  run(d, 'add', '.')
  run(d, 'commit', '-qm', 'one')
  run(d, 'remote', 'add', 'origin', bare)
  run(d, 'push', '-qu', 'origin', 'main')
  return { d, bare }
}
const api = mk('api')
run(api.d, 'tag', 'dev_v1.0.0')
fs.writeFileSync(path.join(api.d, 'b.txt'), 'b\n')
run(api.d, 'add', '.')
run(api.d, 'commit', '-qm', 'two')
run(api.d, 'tag', 'dev_v1.0.9')
run(api.d, 'tag', 'uat_v1.0.9') // the tag to start from, in the second plan
fs.writeFileSync(path.join(api.d, 'c.txt'), 'c\n')
run(api.d, 'add', '.')
run(api.d, 'commit', '-qm', 'three')
run(api.d, 'push', '-q', 'origin', 'main')
const web = mk('web')
run(web.d, 'tag', 'dev_v2.3')
const docs = mk('docs')

const handlers = {}
const orca = { panels: { handle: (n, f) => (handlers[n] = f), post() {} }, host: { has: () => false, call: async () => ({}) }, commands: { register() {} }, events: { on() {} }, log() {} }
const mod = await import(pathToFileURL(path.resolve(ROOT, '../worker/main.mjs')).href)
mod.default(orca)
let fails = 0
const ok = (c, n, x = '') => {
  if (!c) fails++
  console.log(`${c ? 'PASS' : 'FAIL'} tags ${n}${!c && x ? ' :: ' + x : ''}`)
}
try {
  const pats = await handlers['repos.tagPatterns']({ repos: [api.d, web.d, docs.d] })
  ok(pats[0]?.pattern === 'dev_v*' && pats.some((p) => p.pattern === 'uat_v*'), 'patterns found from the tags', JSON.stringify(pats))
  const plan = await handlers['repos.tagPlan']({ repos: [api.d, web.d, docs.d], pattern: 'dev_v*', base: { kind: 'branch', name: 'main' } })
  const by = Object.fromEntries(plan.rows.map((r) => [r.name, r]))
  ok(by.api.latest === 'dev_v1.0.9' && by.api.next === 'dev_v1.0.10', 'api: newest by version, next one up', JSON.stringify(by.api))
  ok(by.api.at === 'origin/main' && by.api.hash === run(api.d, 'rev-parse', 'origin/main'), 'api: on main as origin has it')
  ok(by.web.already.includes('dev_v2.3') && !by.web.next, 'web: already tagged there, nothing to do', JSON.stringify(by.web))
  ok(by.docs.latest === null && by.docs.next === 'dev_v1.0.0', 'docs: no tag yet, starts at 1.0.0', JSON.stringify(by.docs))
  // from another tag: the new dev tag goes on the commit of the newest uat tag
  const fromTag = await handlers['repos.tagPlan']({ repos: [api.d], pattern: 'dev_v*', base: { kind: 'tag', pattern: 'uat_v*' } })
  ok(fromTag.rows[0].at === 'uat_v1.0.9' && fromTag.rows[0].already.includes('dev_v1.0.9'), 'from the newest uat tag: that commit already has dev_v1.0.9', JSON.stringify(fromTag.rows[0]))
  const missing = await handlers['repos.tagPlan']({ repos: [docs.d], pattern: 'dev_v*', base: { kind: 'branch', name: 'release' } })
  ok(/no branch release/.test(missing.rows[0].error || ''), 'a missing branch is said per repo', JSON.stringify(missing.rows[0]))
  // apply: api and docs; pushed to origin
  const res = await handlers['repos.tagApply']({ items: [{ repo: api.d, name: by.api.next, hash: by.api.hash }, { repo: docs.d, name: by.docs.next, hash: by.docs.hash }], push: true })
  ok(res.every((r) => r.ok && r.pushed), 'both created and pushed', JSON.stringify(res))
  ok(run(api.bare, 'tag', '--list', 'dev_v1.0.10') === 'dev_v1.0.10' && run(docs.bare, 'tag', '--list', 'dev_v1.0.0') === 'dev_v1.0.0', 'the tags are on the remotes')
  const again = await handlers['repos.tagApply']({ items: [{ repo: api.d, name: 'dev_v1.0.10', hash: by.api.hash }], push: true })
  ok(!again[0].ok && /already exists/.test(again[0].error), 'an existing tag is never overwritten', JSON.stringify(again))
  // someone pushes to main after we last fetched: with fetch, the tag goes on what origin has now
  const other = path.join(W, 'api-other')
  run(W, 'clone', '-q', api.bare, other)
  fs.writeFileSync(path.join(other, 'd.txt'), 'd\n')
  run(other, 'add', '.')
  run(other, 'commit', '-qm', 'four, pushed by someone else')
  run(other, 'tag', 'dev_v1.0.11')
  run(other, 'push', '-q', 'origin', 'main', '--tags')
  const stale = await handlers['repos.tagPlan']({ repos: [api.d], pattern: 'dev_v*', base: { kind: 'branch', name: 'main' } })
  const fresh = await handlers['repos.tagPlan']({ repos: [api.d], pattern: 'dev_v*', base: { kind: 'branch', name: 'main' }, fetch: true })
  const head = run(other, 'rev-parse', 'HEAD')
  ok(stale.rows[0].hash !== head && fresh.rows[0].hash === head, 'fetched first: the tag goes on the commit origin has now', JSON.stringify([stale.rows[0].hash, fresh.rows[0].hash, head]))
  ok(fresh.rows[0].latest === 'dev_v1.0.11' && fresh.rows[0].already.includes('dev_v1.0.11'), "origin's new tag is seen too (already tagged there)", JSON.stringify(fresh.rows[0]))
  const bad = await handlers['repos.tagApply']({ items: [{ repo: api.d, name: 'x;rm -rf', hash: by.api.hash }] })
  ok(!bad[0].ok, 'a bad name is refused', JSON.stringify(bad))
} catch (e) {
  fails++
  console.log('CRASH', e.stack)
}
console.log(`tags: ${fails ? fails + ' failed' : 'all passed'}`)
try {
  fs.rmSync(W, { recursive: true, force: true })
} catch {}
process.exit(fails ? 1 : 0)
