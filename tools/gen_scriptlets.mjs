// Exports uBlock Origin's built-in scriptlets as adblock-rust `Resource` objects.
// Run from the uBlock repo root: node gen_scriptlets.mjs > scriptlets.json
import { builtinScriptlets } from './src/js/resources/scriptlets.js'

const out = []
for (const s of builtinScriptlets) {
  const src = s.fn.toString()
  const isFn = s.name.endsWith('.fn')
  const r = {
    name: s.name,
    aliases: s.aliases ?? [],
    kind: { mime: isFn ? 'fn/javascript' : 'application/javascript' },
    content: Buffer.from(src, 'utf8').toString('base64'),
  }
  const deps = (s.dependencies ?? []).filter(d => typeof d === 'string')
  if (deps.length) r.dependencies = deps
  if (s.requiresTrust) r.permission = 1
  out.push(r)
}
process.stdout.write(JSON.stringify(out))
