import { build } from 'esbuild'
import fs from 'node:fs'
const r = await build({
  entryPoints: ['content_cosmetic.ts'], bundle: true, format: 'iife',
  target: 'es2020', minify: true, write: false,
})
let bundle = r.outputFiles[0].text.trim()
if (bundle.endsWith(';')) bundle = bundle.slice(0, -1)
const tpl = fs.readFileSync('loader.template.js', 'utf8')
// function replacer: avoids "$&"-style substitutions inside the minified bundle
const assist = fs.readFileSync('assist.js', 'utf8')
const out = tpl.replace('/*__BUNDLE__*/', () => bundle + ';').replace('/*__ASSIST__*/', () => assist)
fs.writeFileSync('build/cosmetic.js', out)
console.log('cosmetic.js bytes:', out.length)
