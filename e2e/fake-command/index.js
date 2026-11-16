/**
 * Test-only fixture: when a new Agent is created, execute `/review-scope`
 * through the real command registry. This exercises the durable `command/run`
 * event, the scope session projection, and command registration without a UI.
 * @module dsh-fake-scope-command
 */

export const name = 'fake-scope-command'
export const inject = ['commands']

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  ctx.effect(() => ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    void ctx.commands.execute(agent, '/review-scope src/auth/**', [], new AbortController().signal)
      .then((execution) => {
        ctx.logger?.info?.('[fake-scope-command] /review-scope:', execution?.result?.kind, execution?.result?.text)
      })
      .catch((error) => {
        ctx.logger?.warn?.('[fake-scope-command] /review-scope failed:', error)
      })
  }), 'fake-scope-command: agent/created')
}
