import { expect, it } from 'vitest'
import type { McpToolBinding } from '../src/mcp/manager.js'
import { createMcpToolSearch, isMcpToolSearchDetails, type McpToolSearchCandidate } from '../src/mcp/tool-search.js'

function candidate(name: string, description = '', properties: Record<string, unknown> = {}): McpToolSearchCandidate {
  const binding: McpToolBinding = {
    name: 'mcp__github__' + name, serverId: 'server', credentialRef: 'credential', revision: 1,
    tool: { name, description, inputSchema: { type: 'object', properties } },
  }
  return { binding, namespace: { name: 'github' } }
}

async function search(candidates: McpToolSearchCandidate[], query: string, limit?: number) {
  const details: unknown[] = []
  const result = await createMcpToolSearch(async () => candidates).execute(
    { query, ...(limit === undefined ? {} : { limit }) },
    { signal: new AbortController().signal, recordDetails: detail => details.push(detail) },
  )
  return { result, details }
}

it('ranks an exact name first and exposes only its first description line', async () => {
  const { result, details } = await search([
    candidate('search', 'Find an issue in a repository by ID.'),
    candidate('issue', 'Read a GitHub issue.\nDetailed hidden instructions.', { id: { type: 'string' } }),
  ], 'issue', 1)
  expect(result).toContain('mcp__github__issue: Read a GitHub issue.')
  expect(result).not.toContain('Detailed hidden instructions')
  expect(details).toMatchObject([{ kind: 'mcp-tools-loaded', bindings: [
    { serverId: 'server', credentialRef: 'credential', tool: { name: 'issue' } },
  ] }])
  expect(isMcpToolSearchDetails(details[0])).toBe(true)
})

it('ranks term coverage before the individual word score', async () => {
  const { details } = await search([
    candidate('window', 'Move, resize, or close a window.'),
    candidate('image', 'Take a screenshot of a window.'),
  ], 'screenshot window', 1)
  expect(details).toMatchObject([{ bindings: [{ tool: { name: 'image' } }] }])
})

it('normalizes Unicode and searches parameter descriptions behind local references', async () => {
  const referenced = candidate('inspect', 'Inspect records', { filter: { $ref: '#/$defs/Mode' } })
  referenced.binding.tool.inputSchema.$defs = { Mode: { description: '查询仓库问题', $ref: '#/$defs/Mode' } }
  const { details } = await search([candidate('unrelated', 'Open reports'), referenced], '问题')
  expect(details).toMatchObject([{ bindings: [{ tool: { name: 'inspect' } }] }])
})

it('matches namespace instructions and weighs a name above repeated description keywords', async () => {
  const run = { ...candidate('run'), namespace: { name: 'ops', instructions: 'Kubernetes cluster tools' } }
  const namespace = await search([run, candidate('status', 'Check its status')], 'kubernetes')
  expect(namespace.details).toMatchObject([{ bindings: [{ tool: { name: 'run' } }] }])

  const named = await search([
    candidate('status', 'Deploy status: last deploy, deploy log, deploy errors.'),
    candidate('deployRelease', 'Start a release.'),
  ], 'deploy', 1)
  expect(named.details).toMatchObject([{ bindings: [{ tool: { name: 'deployRelease' } }] }])
})

it('ignores a non-string annotation title from the remote tool catalog', async () => {
  const invalid = candidate('issue')
  Object.assign(invalid.binding.tool, { annotations: { title: 123 } })
  const { result, details } = await search([invalid], 'issue')
  expect(result).toContain('mcp__github__issue:')
  expect(result).not.toContain('123')
  expect(details).toMatchObject([{ bindings: [{ tool: { name: 'issue' } }] }])
})

it('defaults to eight matches and accepts an explicit limit above eight', async () => {
  const candidates = Array.from({ length: 11 }, (_, index) => candidate('issue' + index, 'Read an issue'))
  const defaults = await search(candidates, 'issue')
  const explicit = await search(candidates, 'issue', 10)
  if (!isMcpToolSearchDetails(defaults.details[0]) || !isMcpToolSearchDetails(explicit.details[0])) {
    throw new Error('Missing search metadata')
  }
  expect(defaults.details[0].bindings).toHaveLength(8)
  expect(explicit.details[0].bindings).toHaveLength(10)
})

it.each([{ query: ' ' }, { query: 'issue', limit: -1 }, { query: 'issue', limit: 1.2 }])(
  'rejects invalid search input before fetching candidates: %j', async args => {
    const tool = createMcpToolSearch(async () => {
      throw new Error('Fetched candidates')
    })
    await expect(tool.execute(args, {
      signal: new AbortController().signal, recordDetails: () => undefined,
    })).rejects.toThrow(/query|limit/)
  },
)

it('returns a plain no-match response without recording a tool selection', async () => {
  const { result, details } = await search([candidate('issue', 'Read a GitHub issue.')], 'spaceship')
  expect(result).toBe('No matching tools found.')
  expect(details).toEqual([])
})

it('does not record a selection if the session stops while getting candidates', async () => {
  const controller = new AbortController()
  const cancel = new Error('Stopped')
  const details: unknown[] = []
  const tool = createMcpToolSearch(async signal => {
    expect(signal).toBe(controller.signal)
    controller.abort(cancel)
    return [candidate('issue', 'Read a GitHub issue.')]
  })
  await expect(tool.execute({ query: 'issue' }, {
    signal: controller.signal, recordDetails: detail => details.push(detail),
  })).rejects.toBe(cancel)
  expect(details).toEqual([])
})
