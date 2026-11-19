/*
 * BM25 ranking adapted from Pi, packages/coding-agent/src/extensions/tool-search/tool.ts
 * at 9b88b94e2c48086f38002d551dc8e0343923505e.
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { Type } from 'typebox'
import type { CodingTool } from '../tools.js'
import type { McpToolBinding } from './manager.js'

export const MCP_TOOL_SEARCH_NAME = 'tool_search'
const defaultLimit = 8

export type McpToolSearchCandidate = {
  binding: McpToolBinding
  namespace?: { name: string; description?: string; instructions?: string }
}

export type McpToolSearchDetails = {
  kind: 'mcp-tools-loaded'
  bindings: McpToolBinding[]
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' })
const stopWords = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'with'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isMcpToolSearchDetails(value: unknown): value is McpToolSearchDetails {
  return isRecord(value) && value.kind === 'mcp-tools-loaded' && Array.isArray(value.bindings)
    && value.bindings.every(binding => isRecord(binding) && typeof binding.name === 'string'
      && typeof binding.serverId === 'string' && typeof binding.credentialRef === 'string'
      && typeof binding.revision === 'number' && isRecord(binding.tool) && typeof binding.tool.name === 'string'
      && isRecord(binding.tool.inputSchema))
}

function stem(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return term.slice(0, -3) + 'y'
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2)
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1)
  return term
}

function tokenize(text: string): string[] {
  const normalized = text.normalize('NFC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
  const words = /^[a-z0-9 ]*$/.test(normalized)
    ? normalized.split(' ')
    : Array.from(wordSegmenter.segment(normalized), word => word.isWordLike ? word.segment : '')
  return words.filter(word => word && !stopWords.has(word))
    .map(word => /^[a-z0-9]+$/.test(word) ? stem(word) : word)
}

function resolveLocalReference(reference: string, root: unknown): unknown {
  if (reference === '#') return root
  if (!reference.startsWith('#/')) return
  let target: unknown = root
  for (const segment of reference.slice(2).split('/')) {
    let key: string
    try { key = decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~') }
    catch { return }
    if (!isRecord(target) || !Object.hasOwn(target, key)) return
    target = target[key]
  }
  return target
}

function addSchemaText(schema: unknown, root: unknown, parts: string[], seen: Set<unknown>): void {
  if (!isRecord(schema)) return
  if (typeof schema.$ref === 'string') {
    const referenced = resolveLocalReference(schema.$ref, root)
    if (isRecord(referenced) && !seen.has(referenced)) {
      seen.add(referenced)
      addSchemaText(referenced, root, parts, seen)
    }
  }
  if (typeof schema.description === 'string') parts.push(schema.description)
  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      parts.push(name)
      addSchemaText(property, root, parts, seen)
    }
  }
  addSchemaText(schema.items, root, parts, seen)
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    const variants = schema[keyword]
    if (Array.isArray(variants)) {
      for (const variant of variants) addSchemaText(variant, root, parts, seen)
    }
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_$]/g, '_')
}

function indexCandidate({ binding, namespace }: McpToolSearchCandidate) {
  const { name, tool } = binding
  const annotationTitle = tool.annotations?.title
  const description = tool.description?.trim() || tool.title || (typeof annotationTitle === 'string' ? annotationTitle : '')
  const parts = [description]
  addSchemaText(tool.inputSchema, tool.inputSchema, parts, new Set([tool.inputSchema]))
  const text = tokenize(parts.join(' '))
  const textCounts = new Map<string, number>()
  for (const term of text) textCounts.set(term, (textCounts.get(term) ?? 0) + 1)
  return {
    binding, description, nameTerms: new Set(tokenize(name)),
    localNameTerms: new Set(tokenize(name.split('__').at(-1) ?? '')),
    namespaceTerms: new Set(tokenize([namespace?.name, namespace?.description, namespace?.instructions].join(' '))),
    textCounts, textLength: text.length,
  }
}

function rankCandidates(query: string, candidates: readonly McpToolSearchCandidate[], limit: number) {
  const queryTerms = new Set(tokenize(query))
  if (!queryTerms.size || !candidates.length) return []
  const indexed = candidates.map(indexCandidate)
  const averageLength = indexed.reduce((sum, document) => sum + document.textLength, 0) / indexed.length || 1
  const idf = [...queryTerms].map(term => {
    const frequency = indexed.filter(document =>
      document.nameTerms.has(term) || document.textCounts.has(term) || document.namespaceTerms.has(term)).length
    return [term, Math.log(1 + (indexed.length - frequency + 0.5) / (frequency + 0.5))] as const
  })
  const fullNameBonus = idf.reduce((sum, [, value]) => sum + value, 0)
  const exactQuery = normalizeName(query)
  const matches = []
  for (const document of indexed) {
    const norm = 1.2 * (0.25 + 0.75 * document.textLength / averageLength)
    let score = 0
    let covered = 0
    for (const [term, weight] of idf) {
      const count = document.textCounts.get(term) ?? 0
      const termWeight = (document.nameTerms.has(term) ? 3 : 0) + (document.namespaceTerms.has(term) ? 0.5 : 0)
        + count * 2.2 / (count + norm)
      if (termWeight > 0) covered++
      score += weight * termWeight
    }
    if (!score) continue
    const local = document.localNameTerms
    if (local.size && [...local].every(term => queryTerms.has(term))) score += fullNameBonus
    const name = normalizeName(document.binding.name)
    matches.push({ document, score, covered, exact: name === exactQuery || name.endsWith('__' + exactQuery) })
  }
  // Match Pi's priority: exact name, term coverage, then BM25 relevance.
  return matches.sort((a, b) => Number(b.exact) - Number(a.exact) || b.covered - a.covered || b.score - a.score)
    .slice(0, limit).map(match => match.document)
}

export function createMcpToolSearch(
  resolveCandidates: (signal: AbortSignal) => Promise<readonly McpToolSearchCandidate[]>,
): CodingTool {
  return {
    name: MCP_TOOL_SEARCH_NAME,
    description: 'Search for MCP tools that have not been loaded yet. The matching tools become available to call on the next model request.',
    promptSnippet: '搜索并加载当前未声明的 MCP 工具。',
    preserveFailure: true,
    parameters: Type.Object({
      query: Type.String({ description: 'Search query for MCP tools.' }),
      limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum number of tools to return. Defaults to 8.' })),
    }),
    async execute({ query, limit }, { signal, recordDetails }) {
      if (typeof query !== 'string' || !query.trim()) throw new Error('query must not be empty')
      const max = limit === undefined ? defaultLimit : limit
      if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
        throw new Error('limit must be a positive integer')
      }
      signal.throwIfAborted()
      const candidates = await resolveCandidates(signal)
      signal.throwIfAborted()
      const matches = rankCandidates(query, candidates, max)
      if (!matches.length) return 'No matching tools found.'
      recordDetails({
        kind: 'mcp-tools-loaded',
        bindings: matches.map(({ binding }) => binding),
      } satisfies McpToolSearchDetails)
      const lines = matches.map(({ binding, description }) => `- ${binding.name}: ${description.split(/\r\n?|\n/, 1)[0]}`)
      return `Loaded ${matches.length} tool${matches.length === 1 ? '' : 's'}. They are available from your next call:\n${lines.join('\n')}`
    },
  }
}
