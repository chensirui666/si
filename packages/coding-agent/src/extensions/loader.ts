import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import ignore from 'ignore'
import { createJiti } from 'jiti'
import type { ExtensionEntry } from './runtime.js'

const sourceFile = (file: string) => ['.ts', '.js'].includes(extname(file))
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function readOptional(file: string) {
  try { return await readFile(file, 'utf8') }
  catch (error) { if (!missing(error)) throw error }
}

async function packageEntries(dir: string, report: (path: string, error: unknown) => void): Promise<string[]> {
  const packageFile = join(dir, 'package.json')
  try {
    const manifest = await readOptional(packageFile)
    const declared: unknown = manifest && JSON.parse(manifest)?.pi?.extensions
    if (Array.isArray(declared)) {
      const entries: string[] = []
      for (const entry of declared) {
        if (typeof entry !== 'string' || !sourceFile(entry)) continue
        const file = resolve(dir, entry)
        try {
          if (!(await stat(file)).isFile()) throw new Error('扩展入口必须是文件')
          entries.push(file)
        } catch (error) { report(file, error) }
      }
      if (entries.length) return entries
    }
  } catch (error) { report(packageFile, error) }
  for (const name of ['index.ts', 'index.js']) {
    const file = join(dir, name)
    if (await stat(file).then(item => item.isFile(), error => { if (!missing(error)) throw error; return false })) return [file]
  }
  return []
}

export async function loadExtensions(directory: string, report: (path: string, error: unknown) => void = console.error): Promise<ExtensionEntry[]> {
  const load = createJiti(import.meta.url, { fsCache: false })
  const loaded: ExtensionEntry[] = []
  const seen = new Set<string>()
  const importEntry = async (file: string) => {
    try {
      const path = await realpath(file)
      if (seen.has(path)) return
      seen.add(path)
      const entry: unknown = await load.import(path, { default: true })
      if (typeof entry !== 'function') throw new Error('扩展需默认导出入口函数')
      loaded.push({ path, entry: entry as ExtensionEntry['entry'] })
    } catch (error) { report(file, error) }
  }
  const getPackage = async (dir: string) => {
    try { return await packageEntries(dir, report) }
    catch (error) { report(join(dir, 'package.json'), error); return [] }
  }
  try {
    const children = await readdir(directory, { withFileTypes: true })
    const root = await getPackage(directory)
    if (root.length) {
      for (const file of root) await importEntry(file)
      return loaded
    }
    const ignored = ignore()
    for (const name of ['.gitignore', '.ignore', '.fdignore']) {
      const rules = await readOptional(join(directory, name))
      if (rules) ignored.add(rules)
    }
    for (const child of children) {
      if (child.name.startsWith('.') || child.name === 'node_modules') continue
      const path = join(directory, child.name)
      try {
        const entry = child.isSymbolicLink() ? await stat(path) : child
        if (ignored.ignores(child.name + (entry.isDirectory() ? '/' : ''))) continue
        if (entry.isFile() && sourceFile(child.name)) await importEntry(path)
        if (entry.isDirectory()) for (const file of await getPackage(path)) await importEntry(file)
      } catch (error) { report(path, error) }
    }
  } catch (error) { if (!missing(error)) report(directory, error) }
  return loaded
}
