import { describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { claudeEnvironment, codexEnvironment, nativeProviderAuth } from '../src/account-environment'

const workspacePath = resolve('fixture-project')

describe('provider account environments', () => {
  it('keeps the host home and leaves Claude’s default and inherited config alone', () => {
    const config = { workspacePath }
    const host = { HOME: '/host-home', CLAUDE_CODE_SESSION_ID: 'parent-session', ELECTRON_RUN_AS_NODE: '1' }
    expect(claudeEnvironment(config, host)).toEqual({ HOME: '/host-home', CLAUDE_CODE_ENTRYPOINT: 'harness' })
    expect(claudeEnvironment(config, { ...host, CLAUDE_CONFIG_DIR: '~/literal-inherited' }).CLAUDE_CONFIG_DIR).toBe('~/literal-inherited')
    expect(host.CLAUDE_CODE_SESSION_ID).toBe('parent-session')
  })

  it('isolates configured Claude and Codex account homes', () => {
    const host = { HOME: '/host-home', CLAUDE_CONFIG_DIR: '/inherited-claude', CODEX_HOME: '/inherited-codex' }
    expect(claudeEnvironment({ workspacePath, home: ' ~/claude-one ' }, host)).toMatchObject({
      HOME: '/host-home',
      CLAUDE_CONFIG_DIR: resolve(homedir(), 'claude-one'),
    })
    expect(claudeEnvironment({ workspacePath, home: './claude-two' }, host).CLAUDE_CONFIG_DIR).toBe(resolve(workspacePath, 'claude-two'))
    expect(codexEnvironment({ workspacePath }, host).CODEX_HOME).toBe('/inherited-codex')
    expect(codexEnvironment({ workspacePath, home: './codex-two' }, host)).toMatchObject({
      HOME: '/host-home',
      CODEX_HOME: resolve(workspacePath, 'codex-two'),
    })
  })

  it('uses each provider’s native login and logout with the configured executable', () => {
    const config = { workspacePath, binaryPath: resolve(workspacePath, 'agent with spaces'), home: './named-account' }
    expect(nativeProviderAuth('claude', config, 'login')).toMatchObject({
      argv: [config.binaryPath, 'auth', 'login'],
      env: { CLAUDE_CONFIG_DIR: resolve(workspacePath, 'named-account') },
    })
    expect(nativeProviderAuth('claude', config, 'logout').argv).toEqual([config.binaryPath, 'auth', 'logout'])
    expect(nativeProviderAuth('codex', config, 'login')).toMatchObject({
      argv: [config.binaryPath, 'login'],
      env: { CODEX_HOME: resolve(workspacePath, 'named-account') },
    })
    expect(nativeProviderAuth('codex', config, 'logout').argv).toEqual([config.binaryPath, 'logout'])
  })
})
