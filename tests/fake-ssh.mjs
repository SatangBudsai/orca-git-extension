// A stand-in for ssh in tests, on Windows, macOS and Linux (the worker runs a .mjs stand-in with Node):
//   ssh -G <name>                  where a name goes (office-alias is the ~/.ssh/config alias of 127.0.0.9)
//   ssh [options] <dest> <command> runs <command> with a POSIX shell, as if logged in on <dest>
// It logs each destination to FAKE_SSH_LOG, uses FAKE_SSH_HOME as the server's home, and refuses
// "down-host". The shell is FAKE_LOGIN_SHELL, else sh (on Windows the one that comes with Git).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
if (argv[0] === '-G') {
  const name = argv[1]
  const custom = process.env.FAKE_SSH_G ? JSON.parse(process.env.FAKE_SSH_G)[name] : null // per-test answers
  const out = custom || { 'office-alias': 'hostname 127.0.0.9\nport 22\nuser frank\n', 'wrong-port': 'hostname 127.0.0.9\nport 2222\nuser frank\n' }[name] || `hostname ${name}\nport 22\nuser me\n`
  process.stdout.write(out)
  process.exit(0)
}
let i = 0
while (i < argv.length) {
  if (argv[i] === '-o') i += 2
  else if (argv[i] === '--') i += 1
  else if (argv[i].startsWith('-')) i += 1
  else break
}
const dest = argv[i]
const command = argv.slice(i + 1).join(' ')
if (process.env.FAKE_SSH_LOG) fs.appendFileSync(process.env.FAKE_SSH_LOG, dest + '\n')
if (dest === 'down-host') {
  process.stderr.write('ssh: connect to host down-host port 22: Connection refused\n')
  process.exit(255)
}
// FAKE_SSH_HOMES ({ dest: home }): each server its own home; any other one refuses the key
const homes = process.env.FAKE_SSH_HOMES ? JSON.parse(process.env.FAKE_SSH_HOMES) : null
if (homes && !homes[dest]) {
  process.stderr.write(`${dest}: Permission denied (publickey).\n`)
  process.exit(255)
}
function posixShell() {
  if (process.env.FAKE_LOGIN_SHELL) return process.env.FAKE_LOGIN_SHELL
  if (process.platform !== 'win32') return 'sh'
  // Git for Windows: <git>\mingw64\libexec\git-core → <git>\bin\sh.exe (or usr\bin\sh.exe)
  const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  const root = path.resolve(exec, '..', '..', '..')
  for (const p of [path.join(root, 'bin', 'sh.exe'), path.join(root, 'usr', 'bin', 'sh.exe')]) if (fs.existsSync(p)) return p
  return 'sh'
}
const env = { ...process.env, HOME: (homes && homes[dest]) || process.env.FAKE_SSH_HOME || process.env.HOME }
if (process.platform !== 'win32') {
  const r = spawnSync(posixShell(), ['-c', command], { stdio: 'inherit', env })
  process.exit(r.status ?? 1)
}
// Windows: the commands run on this machine, whose git prints C:/… paths; a POSIX server prints
// /c/… (what Git's sh and the test use), so the drive letters in its output are turned into that
const r = spawnSync(posixShell(), ['-c', command], { stdio: ['inherit', 'pipe', 'inherit'], env, maxBuffer: 256 * 1024 * 1024 })
const out = r.stdout || Buffer.alloc(0)
const text = out.toString('latin1')
const drive = /(^|[^\w])([A-Za-z]):[\\/]/g
process.stdout.write(drive.test(text) ? Buffer.from(text.replace(drive, (m, pre, d) => `${pre}/${d.toLowerCase()}/`).replace(/\\/g, '/'), 'latin1') : out)
process.exitCode = r.status ?? 1
