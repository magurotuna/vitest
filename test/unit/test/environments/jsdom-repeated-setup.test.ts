import { expect, test } from 'vitest'
import { builtinEnvironments } from 'vitest/runtime'
import { getWorkerState } from '../../../../packages/vitest/src/runtime/utils'

const { jsdom } = builtinEnvironments
const isThreads = getWorkerState().config.pool === 'threads'

test.runIf(isThreads)('teardown restores Request and URL', async () => {
  const NodeRequest = globalThis.Request
  const NodeURL = globalThis.URL

  const environment = await jsdom.setup(globalThis, {})
  await environment.teardown(globalThis)

  expect(globalThis.Request).toBe(NodeRequest)
  expect(globalThis.URL).toBe(NodeURL)
})

test.runIf(isThreads)('nested setup keeps instanceof Request working', async () => {
  const NodeRequest = globalThis.Request

  const outer = await jsdom.setup(globalThis, {})
  const inner = await jsdom.setup(globalThis, {})
  try {
    expect(new NodeRequest('http://localhost/') instanceof Request).toBe(true)
  } finally {
    await inner.teardown(globalThis)
    await outer.teardown(globalThis)
  }
})
