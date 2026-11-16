/**
 * Test-only approval answerer for the real-DSH approval e2e. It claims only
 * requests that carry a plugin-supplied `displayReason` (review-gate asks),
 * rejects the first and allows the second.
 * @module dsh-fake-approval
 */

export const name = 'fake-approval'

/** @param {any} ctx */
export function apply(ctx) {
  let claimed = 0
  ctx.effect(() => ctx.on('approval/request', (request, next) => {
    if (request?.displayReason === undefined) return next()
    claimed += 1
    return claimed === 1 ? 'rejected' : 'allowed-once'
  }), 'fake-approval: approval/request')
}
