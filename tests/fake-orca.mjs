// A stand-in for Orca's CLI in tests (any OS): `orca host list` answers with Orca's SSH hosts, one of
// them Orca's own VM, which is not a server of the person's. Anything else fails.
const [a, b] = process.argv.slice(2)
if (`${a} ${b}` !== 'host list') process.exit(1)
// FAKE_ORCA_HOSTS (a JSON list) replaces the default hosts
if (process.env.FAKE_ORCA_HOSTS) {
  process.stdout.write(JSON.stringify({ ok: true, result: { hosts: JSON.parse(process.env.FAKE_ORCA_HOSTS) } }) + '\n')
  process.exit(0)
}
process.stdout.write(
  JSON.stringify({
    ok: true,
    result: {
      hosts: [
        { kind: 'local', name: 'this machine', id: 'local' },
        { kind: 'ssh', name: 'office-orca', id: 'tgt-9' },
        { kind: 'ssh', name: '127.0.0.9', id: 'tgt-ip' },
        { kind: 'ssh', name: 'vm', id: 'runtime-ssh-1' }
      ]
    }
  }) + '\n'
)
