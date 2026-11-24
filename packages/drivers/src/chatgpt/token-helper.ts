import process from 'node:process'

if (import.meta.main) {
  const [, , socket, capability] = process.argv
  try {
    if (!socket || !capability) throw new Error('Missing private token channel.')
    const response = await fetch('http://localhost/token', {
      unix: socket,
      method: 'POST',
      headers: { authorization: `Bearer ${capability}` },
      signal: AbortSignal.timeout(13000),
    })
    if (!response.ok) throw new Error('ChatGPT token unavailable.')
    const token = await response.text()
    if (!token || /\s/u.test(token)) throw new Error('Invalid ChatGPT token.')
    process.stdout.write(`${token}\n`)
  }
  catch {
    console.error('Could not obtain a ChatGPT plan token. Reconnect the account in Harness.')
    process.exitCode = 1
  }
}
