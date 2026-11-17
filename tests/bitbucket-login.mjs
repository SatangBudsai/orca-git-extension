// The "Save it in Git" and "Replace the saved login" commands for Bitbucket, run for real in the
// shells Orca's terminal may use, against a stand-in credential helper: what does Git store and erase?
// node tests/bitbucket-login.mjs
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..')
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-bblogin-'))
const ops = path.join(W, 'ops.txt').replace(/\\/g, '/')
const cfg = path.join(W, 'global.gitconfig')
// The helper answers "get" like a person typing at the prompt and records what Git asks of it.
// Its text says "manager", as Git Credential Manager's does, so the replace step switches it to plain prompts.
fs.writeFileSync(cfg, `[credential]\n\thelper = "!f() { : manager; if [ \\"$1\\" = get ]; then echo username=u; echo password=TESTTOKEN; else { echo \\"== $1\\"; cat; } >> '${ops}'; fi; }; f"\n`)
process.env.GIT_CONFIG_GLOBAL = cfg
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'

let fails = 0
const ok = (cond, name, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra && !cond ? ' :: ' + extra : ''}`)
}

const handlers = {}
const mod = await import(pathToFileURL(path.join(ROOT, 'worker/main.mjs')).href)
mod.default({ panels: { handle: (n, f) => (handlers[n] = f), post() {} }, host: { has: () => false, call: async () => ({}) }, commands: { register() {} }, events: { on() {} }, log() {} })
const shells = process.platform === 'win32' ? ['powershell.exe', 'cmd.exe'] : ['/bin/sh']
const want = 'protocol=https\nhost=bitbucket.org\nusername=u\npassword=TESTTOKEN\n'
try {
  for (const step of ['bb-login', 'bb-relogin']) {
    const r = await handlers['reviews.setup']({ host: 'bitbucket.org', step })
    ok(typeof r.command === 'string' && r.command.length > 0 && r.ran === false, `${step}: a command to run`, JSON.stringify(r))
    for (const via of shells) {
      fs.rmSync(ops, { force: true })
      try { execSync("git config --global --unset-all credential.https://bitbucket.org.provider", { stdio: "ignore" }) } catch {}
      const out = execSync(r.command, { shell: via, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const got = fs.existsSync(ops) ? fs.readFileSync(ops, 'utf8').replace(/\r/g, '') : ''
      const store = got.split('== ').find((x) => x.startsWith('store'))?.slice('store\n'.length) || ''
      ok(store === want, `${step} from ${path.basename(via)}: Git stores exactly the host, user name and token`, JSON.stringify(got))
      ok(/Saved\./.test(out), `${step} from ${path.basename(via)}: says Saved`, out)
      const erased = got.includes('== erase\nprotocol=https\nhost=bitbucket.org\n')
      const provider = execSync('git config --global --get credential.https://bitbucket.org.provider || echo none', { encoding: 'utf8', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' }).trim()
      if (step === 'bb-relogin') {
        ok(erased && got.indexOf('== erase') < got.indexOf('== store'), `${step} from ${path.basename(via)}: the old login is erased first`, JSON.stringify(got))
        ok(provider === 'generic', `${step} from ${path.basename(via)}: Git Credential Manager set to ask for a user name and token`, provider)
      } else {
        ok(!erased && provider === 'none', `${step} from ${path.basename(via)}: nothing erased or changed`, JSON.stringify([got, provider]))
      }
    }
  }
  const bad = await handlers['reviews.setup']({ host: 'bitbucket.org; rm -rf /', step: 'bb-login' }).then(() => null, (e) => e)
  ok(bad && /unexpected host/.test(bad.message), 'a strange host name is refused', bad?.message)
} catch (e) {
  fails++
  console.log('FAIL crashed:', e.stack)
} finally {
  fs.rmSync(W, { recursive: true, force: true })
}
console.log(fails ? `${fails} failed` : 'all passed')
process.exit(fails ? 1 : 0)
