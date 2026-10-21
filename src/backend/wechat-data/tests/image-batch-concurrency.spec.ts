// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { IMAGE_BATCH_CONCURRENCY, mapWithConcurrency } from '../src/remotes/media.ts'

describe('image batch bounded concurrency', () => {
  it('keeps at most the configured in-flight ceiling and preserves input order', async () => {
    let active = 0
    let peak = 0
    const input = Array.from({ length: 40 }, (_, i) => i)

    const output = await mapWithConcurrency(input, IMAGE_BATCH_CONCURRENCY, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 2))
      active -= 1
      return value * 2
    })

    expect(peak).toBeLessThanOrEqual(IMAGE_BATCH_CONCURRENCY)
    expect(peak).toBe(IMAGE_BATCH_CONCURRENCY)
    expect(output).toEqual(input.map(value => value * 2))
  })
})
