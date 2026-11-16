/**
 * Offline scripted LLM adapter for the end-to-end verification.
 *
 * The script exercises one real headless turn without a model account:
 *   1. write outside the declared scope (must be denied)
 *   2. write inside the declared scope (must succeed)
 *   3. read the in-scope file
 *   4. edit away a sensitive auth check (must be denied)
 *   5. call an unmapped fs tool outside the scope (must be denied by the fs gate)
 *   6. final text answer
 *
 * Test only; this package is excluded from the published files.
 * @module dsh-fake-llm-review-gate
 */

export const name = 'fake-llm-review-gate'
export const inject = ['llm']

const IN_SCOPE = 'src/auth/login.ts'
const OUT_OF_SCOPE = 'src/utils/helper.ts'
const AUTH_LINE = 'if (!user.hasPermission("admin")) return deny()'
const AUTH_FILE = `${AUTH_LINE}\n`

/** @param {number} attempt */
function usage(attempt) {
  return {
    type: 'usage',
    usage: {
      inputTokens: 900 + attempt * 80,
      outputTokens: 32,
      cacheReadTokens: attempt > 1 ? 300 : 0,
      cacheWriteTokens: 10,
    },
  }
}

/** @param {number} index @param {string} name @param {Record<string, unknown>} args */
function toolCall(index, name, args) {
  const id = `call_${index}`
  const argumentsText = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } },
  ]
}

/** @param {string} provider @param {string} model */
function createAdapter(provider, model) {
  const approvalMode = process.env.RG_FAKE_MODE === 'approval'
  let agentCalls = 0
  return {
    providerInfo() {
      return { id: provider, name: 'Fake scripted provider' }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    imageRequestTarget(_provider, _model, image) {
      return { width: image.width, height: image.height, maxBytes: image.bytes }
    },
    async listModels() {
      return [{ provider, id: model, name: 'Fake scripted model' }]
    },
    async resolveModel() {
      return {
        provider,
        id: model,
        name: 'Fake scripted model',
        context: { contextWindow: 128_000 },
        defaultMaxTokens: 1024,
      }
    },
    async prepareCall() {
      return { model: await this.resolveModel(), stream: options => this.stream(options) }
    },
    async *stream(options) {
      const agentLoop = Array.isArray(options?.tools) && options.tools.length > 0
      if (!agentLoop) {
        yield usage(0)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      agentCalls += 1
      if (approvalMode) {
        if (agentCalls === 1) {
          yield* toolCall(1, 'write', {
            file_path: OUT_OF_SCOPE,
            content: '// rejected by the fake approval answerer\n',
          })
        } else if (agentCalls === 2) {
          yield* toolCall(2, 'write', { file_path: IN_SCOPE, content: AUTH_FILE })
        } else if (agentCalls === 3) {
          yield* toolCall(3, 'read', { file_path: IN_SCOPE })
        } else if (agentCalls === 4) {
          yield* toolCall(4, 'edit', {
            file_path: IN_SCOPE,
            old_string: AUTH_LINE,
            new_string: '',
          })
        } else {
          const text = 'Approval e2e finished after four tool calls.'
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'block-end', index: 0, block: { type: 'text', text } }
          yield usage(agentCalls)
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        yield usage(agentCalls)
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (agentCalls === 1) {
        yield* toolCall(1, 'write', {
          file_path: OUT_OF_SCOPE,
          content: '// out-of-scope write from fake-llm\n',
        })
      } else if (agentCalls === 2) {
        yield* toolCall(2, 'write', { file_path: IN_SCOPE, content: AUTH_FILE })
      } else if (agentCalls === 3) {
        yield* toolCall(3, 'read', { file_path: IN_SCOPE })
      } else if (agentCalls === 4) {
        yield* toolCall(4, 'edit', {
          file_path: IN_SCOPE,
          old_string: AUTH_LINE,
          new_string: '',
        })
      } else if (agentCalls === 5) {
        yield* toolCall(5, 'fake_fs_write', { path: 'src/utils/mcp.ts' })
      } else {
        const text = 'E2E script finished after five tool calls.'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield usage(agentCalls)
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield usage(agentCalls)
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    },
  }
}

/** @param {any} ctx */
export function apply(ctx) {
  const adapter = createAdapter('fake', 'fake-1')
  ctx.effect(() => ctx.llm.registerAdapter(['fake'], adapter))
  ctx.logger?.info?.('[fake-llm-review-gate] scripted adapter registered for provider "fake"')
}
