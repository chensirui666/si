import type { ModelContext } from './types.js'

const IMAGE_BUDGET_BYTES = 24_000_000
const MAX_OMISSION_BATCH = 8
const RECENT_IMAGE_RESERVE = 3

export function omittedToolImageIndexes({ messages, omittedToolImageResults }: ModelContext): Set<number> {
  const results: { index: number; bytes: number }[] = []
  let firstFitting = 0
  let fittingBytes = 0
  let omitted = 0
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'toolResult') continue
    const bytes = message.content.reduce((sum, block) => sum + (block.type === 'image' ? block.data.length : 0), 0)
    if (!bytes) continue
    results.push({ index, bytes })
    fittingBytes += bytes
    while (fittingBytes > IMAGE_BUDGET_BYTES) fittingBytes -= results[firstFitting++].bytes
    // Evaluate each prefix so a larger new batch does not move an earlier omission boundary backward.
    const batch = Math.max(1, Math.min(MAX_OMISSION_BATCH, results.length - firstFitting - RECENT_IMAGE_RESERVE))
    omitted = Math.max(omitted, Math.min(results.length, Math.ceil(firstFitting / batch) * batch))
    if (message.imageResultId !== undefined && omittedToolImageResults?.has(message.imageResultId)) omitted = results.length
  }
  return new Set(results.slice(0, omitted).map(result => result.index))
}
