import type { TurnState } from '@harness/engine'
import { expect, it } from 'bun:test'
import { handoffPrompt } from '../src/handoff'

it('keeps intact original and recent history under the UTF-8 budget', () => {
  const turn = (id: number, prompt: string, response: string, status: TurnState['status'] = 'complete'): TurnState => ({
    id, prompt, response, status, role: 'user', toolCalls: [], tokensIn: 0, tokensOut: 0, cost: 0,
  })
  const freshRequest = 'Keep the new request exactly as supplied.\n"Next step"'
  const prompt = handoffPrompt([
    turn(1, 'Preserve the first requirement.', 'Understood.'),
    turn(2, 'Do not clip this response.', '🧪'.repeat(5_000)),
    turn(3, 'Follow up on the latest task.', 'Partial work from the interrupted turn.', 'interrupted'),
    turn(4, 'New request outside the saved boundary.', ''),
  ], 3, freshRequest)

  const [history, request] = prompt.split('\n\nNew user request:\n')
  expect(Buffer.byteLength(history)).toBeLessThan(16_000)
  expect(history).toContain('1 historical items omitted.')
  expect(history).toContain('Preserve the first requirement.')
  expect(history).toContain('Partial work from the interrupted turn.')
  expect(history).toContain('"status":"interrupted"')
  expect(history).not.toContain('🧪')
  expect(history).not.toContain('New request outside the saved boundary.')
  expect(request).toBe(freshRequest)
})
