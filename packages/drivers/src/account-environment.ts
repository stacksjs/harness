import type { DriverConfig } from './types'
import process from 'node:process'
import { providerConfigPath } from './cli-driver'

// Ported from apps/server/src/provider/Drivers/ClaudeHome.ts in T3 Code at
// 431da7f4e55b82b386e68a9f32c543fac2efedf5. See T3CODE-LICENSE.md.
const CLAUDE_HOST_SESSION_VARIABLES = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
]

export function claudeEnvironment(config: DriverConfig, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...host, CLAUDE_CODE_ENTRYPOINT: 'harness' }
  for (const name of CLAUDE_HOST_SESSION_VARIABLES) delete env[name]
  delete env.ELECTRON_RUN_AS_NODE
  const home = config.home?.trim()
  if (home) env.CLAUDE_CONFIG_DIR = providerConfigPath(config.workspacePath, home)
  return env
}

export function codexEnvironment(config: DriverConfig, host: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = config.home?.trim()
  return home ? { ...host, CODEX_HOME: providerConfigPath(config.workspacePath, home) } : host
}

export function nativeProviderAuth(kind: 'claude' | 'codex', config: DriverConfig, action: 'login' | 'logout') {
  if (kind === 'claude') {
    return { argv: [config.binaryPath ?? 'claude', 'auth', action], env: claudeEnvironment(config) }
  }
  return { argv: [config.binaryPath ?? 'codex', action], env: codexEnvironment(config) }
}
