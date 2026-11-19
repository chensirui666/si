import type { ImageContent, ModelContext, TextContent } from './types.js'

export const IMAGE_BUDGET_BYTES = 24_000_000
const MAX_OMISSION_BATCH = 8
const RECENT_IMAGE_RESERVE = 3

function imagePayloadBytes(blocks: readonly (TextContent | ImageContent)[]): number {
  return blocks.reduce((sum, block) => sum + (block.type === 'image' ? block.data.length : 0), 0)
}

export function omittedRequestImages({ messages, omittedToolImageResults, currentUserMessageId }: ModelContext) {
  const uploads: { index: number; bytes: number }[] = []
  let currentUser = -1
  let uploadBytes = 0
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'user') continue
    if (currentUserMessageId === undefined || message.uploadMessageId === currentUserMessageId) currentUser = index
    if (typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type !== 'image') continue
      uploads.push({ index, bytes: block.data.length })
      uploadBytes += block.data.length
    }
  }
  const toolBudget = Math.max(0, IMAGE_BUDGET_BYTES - uploadBytes)
  const results: { index: number; bytes: number }[] = []
  let firstFitting = 0
  let fittingBytes = 0
  let omitted = 0
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'toolResult') continue
    const bytes = imagePayloadBytes(message.content)
    if (!bytes) continue
    results.push({ index, bytes })
    fittingBytes += bytes
    while (fittingBytes > toolBudget) fittingBytes -= results[firstFitting++].bytes
    // Evaluate each prefix so a larger new batch does not move an earlier omission boundary backward.
    const batch = Math.max(1, Math.min(MAX_OMISSION_BATCH, results.length - firstFitting - RECENT_IMAGE_RESERVE))
    omitted = Math.max(omitted, Math.min(results.length, Math.ceil(firstFitting / batch) * batch))
    if (message.imageResultId !== undefined && omittedToolImageResults?.has(message.imageResultId)) omitted = results.length
  }
  const userMessages = new Map<number, number>()
  for (const { index, bytes } of uploads) {
    if (uploadBytes <= IMAGE_BUDGET_BYTES) break
    if (index === currentUser) continue
    userMessages.set(index, (userMessages.get(index) ?? 0) + 1)
    uploadBytes -= bytes
  }
  return { toolResults: new Set(results.slice(0, omitted).map(result => result.index)), userMessages }
}

export function omittedToolImageIndexes(context: ModelContext): Set<number> {
  return omittedRequestImages(context).toolResults
}
