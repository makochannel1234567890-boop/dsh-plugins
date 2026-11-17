/**
 * {{TITLE}} — {{DESCRIPTION}}
 *
 * Replace the ping tool with the real capability. Keep every registration
 * inside `apply` so the plugin can be unloaded cleanly.
 */

export const name = '{{ID}}'

/** Required services. Optional ones are resolved with `ctx.get(name)`. */
export const inject = ['tools']

const SECTION_NAME = 'tool:{{ID}}'
const SECTION_ORDER = 2500
const PROMPT_SECTION = `## {{TITLE}}

When the user asks for ..., call \`{{TOOL}}_ping\`. Keep the reply short.`

export function apply(ctx, config = {}) {
  const settings = {
    enabled: config?.enabled !== false,
  }

  const log = (message) => {
    try {
      ctx.logger?.warn?.(`{{ID}}: ${message}`)
    } catch {
      // Logging must never break the host.
    }
  }

  if (!settings.enabled) return

  ctx.tools.register({
    name: '{{TOOL}}_ping',
    description: 'Template tool: confirm that {{TITLE}} is installed and running.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        note: { type: 'string', description: 'Optional note echoed back.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'plugin', 'at', 'note'],
        properties: {
          ok: { type: 'boolean' },
          plugin: { type: 'string' },
          at: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args) {
      return {
        ok: true,
        plugin: '{{ID}}',
        at: new Date().toISOString(),
        note: typeof args?.note === 'string' ? args.note : '',
      }
    },
    presentCall: () => ({ card: 'generic', title: '{{TITLE}} ping', kind: 'other' }),
  })

  const systemPrompt = ctx.get('systemPrompt')
  systemPrompt?.section({ name: SECTION_NAME, order: SECTION_ORDER, text: PROMPT_SECTION })

  ctx.effect(() => () => {
    log('unloaded')
  })
}
