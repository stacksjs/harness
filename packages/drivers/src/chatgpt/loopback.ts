import type { ChatGptAuthorization, ChatGptRegistration, ChatGptSession, ChatGptTransport } from './authorization'
import { exchangeChatGptCode, parseChatGptCallback, prepareChatGptAuthorization } from './authorization'
import { codexCallbackUrl } from './codex-auth-callback'

interface PendingChatGptAuthorization {
  url: string
  result: Promise<ChatGptSession>
  cancel: () => void
}

function callbackReply(message: string, status = 200): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}

/** Owns the temporary 127.0.0.1 listener and consumes each valid callback once. */
export function startChatGptAuthorization(
  hostId: string,
  registration?: ChatGptRegistration,
  options: { timeoutMs?: number, transport?: ChatGptTransport } = {},
): PendingChatGptAuthorization {
  const controller = new AbortController()
  const completion = Promise.withResolvers<ChatGptSession>()
  let pending = true
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method !== 'GET' || new URL(request.url).pathname !== '/auth/callback')
        return callbackReply('This address is for the ChatGPT sign-in callback.', 404)
      if (!pending) return callbackReply('This ChatGPT sign-in has already been received.', 409)

      try {
        codexCallbackUrl(request.url, attempt.redirectUri, attempt.state)
      }
      catch {
        return callbackReply('This callback does not match the current ChatGPT sign-in.', 400)
      }

      pending = false
      try {
        const callback = parseChatGptCallback(attempt, request.url)
        const session = await exchangeChatGptCode(attempt, callback, controller.signal, options.transport)
        if (controller.signal.aborted) return callbackReply('This ChatGPT sign-in has ended.', 410)
        completion.resolve(session)
        return callbackReply('ChatGPT sign-in was received. Return to Harness to finish.')
      }
      catch (error) {
        completion.reject(error)
        return callbackReply('ChatGPT sign-in could not finish. Return to Harness for details.', 400)
      }
      finally {
        clearTimeout(timer)
        void server.stop()
      }
    },
  })

  let attempt: ChatGptAuthorization
  try {
    attempt = prepareChatGptAuthorization(`http://127.0.0.1:${server.port}/auth/callback`, hostId, registration)
  }
  catch (error) {
    void server.stop()
    throw error
  }

  function stop(message: string): void {
    pending = false
    clearTimeout(timer)
    controller.abort()
    completion.reject(new Error(message))
    void server.stop()
  }

  const timer = setTimeout(() => stop('ChatGPT sign-in timed out. Start a new sign-in.'), options.timeoutMs ?? 300_000)
  return {
    url: attempt.url,
    result: completion.promise,
    cancel: () => stop('ChatGPT sign-in was canceled.'),
  }
}
