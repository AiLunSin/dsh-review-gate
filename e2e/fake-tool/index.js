/**
 * A test-only unmapped file tool. It follows the documented `fs/*-intent` seam
 * so dsh-review-gate's safety net can see its resolved target, then writes
 * through `ctx.fs`. This is deliberately not named `write`/`edit`; the
 * pre-execute gate must leave it alone and the fs gate must deny it.
 * @module dsh-fake-fs-tool
 */

export const name = 'fake-fs-tool'
export const inject = ['tools', 'fs']

/** @param {any} ctx */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'fake_fs_write',
    description: 'Test-only unmapped file writer (e2e fixture).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Target path relative to the session cwd.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: () => [{ type: 'text', text: 'fake fs write completed' }],
    },
    async execute(args, exec) {
      const cwd = process.cwd()
      const target = await ctx.fs.resolve(args.path, { cwd, signal: exec.signal })
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      await ctx.fs.writeText(target, 'fake fs write\n', intent, exec.signal)
      return 'ok'
    },
  }), 'fake-fs-tool: register')
}
