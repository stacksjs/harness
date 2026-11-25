import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_QUESTION_IMAGE_BYTES } from '@harness/contract'
import { QuestionAttachments } from '../src/question-attachments'

let root: string
let store: QuestionAttachments

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-question-files-'))
  store = new QuestionAttachments(root)
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function file(text = 'fixture'): Request {
  return new Request('http://127.0.0.1/upload', { method: 'POST', body: text })
}

it('scopes uploaded files to the originating session, request, question, and device', async () => {
  const stored = await store.upload(file(), 1, 'request-a', 'question-a', 'device-a', '../notes.txt')
  const answer = { questionId: 'question-a', values: [], attachmentIds: [stored.id] }
  expect(stored.name).toBe('.._notes.txt')
  expect(await Bun.file(store.path(1, 'request-a', stored)).text()).toBe('fixture')
  expect(await store.resolve(1, 'request-a', [answer], 'device-a')).toEqual([stored])
  expect(await store.drafts(1, 'request-a', 'device-a')).toEqual([stored])
  expect(await store.drafts(1, 'request-a', 'device-b')).toEqual([])
  await expect(store.resolve(2, 'request-a', [answer], 'device-a')).rejects.toThrow('unavailable')
  await expect(store.resolve(1, 'request-b', [answer], 'device-a')).rejects.toThrow('unavailable')
  await expect(store.resolve(1, 'request-a', [{ ...answer, questionId: 'question-b' }], 'device-a')).rejects.toThrow('unavailable')
  await expect(store.resolve(1, 'request-a', [answer], 'device-b')).rejects.toThrow('unavailable')
})

it('removes a streamed file that exceeds the image limit even without a content length', async () => {
  const request = new Request('http://127.0.0.1/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_QUESTION_IMAGE_BYTES))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    }),
  })
  await expect(store.upload(request, 1, 'request-a', 'question-a', 'local', 'oversize.png')).rejects.toThrow('size limit')
  expect(await store.drafts(1, 'request-a', 'local')).toEqual([])
})

it('keeps submitted files across reopening and removes drafts and deleted session files', async () => {
  const kept = await store.upload(file('submitted'), 1, 'request-a', 'question-a', 'local', 'submit.txt')
  const draft = await store.upload(file('draft'), 1, 'request-a', 'question-a', 'local', 'draft.txt')
  const restartedStore = new QuestionAttachments(root)
  await restartedStore.prune(1, () => new Map([['request-a', new Set([kept.id])]]))
  expect(await Bun.file(restartedStore.path(1, 'request-a', kept)).text()).toBe('submitted')
  expect(await Bun.file(restartedStore.path(1, 'request-a', draft)).exists()).toBe(false)
  await restartedStore.prune(1, () => new Map())
  expect(await Bun.file(restartedStore.path(1, 'request-a', kept)).exists()).toBe(false)
})
