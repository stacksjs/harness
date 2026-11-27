import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { resolveWorkspaceEntry } from './workspace-files'

type LaunchStyle = 'goto' | 'direct' | 'line-column'
type Editor = { id: string, label: string, commands: string[], style: LaunchStyle, base?: string[], bundles?: string[] }

// Editor IDs and argument conventions follow T3 Code at
// 431da7f4e55b82b386e68a9f32c543fac2efedf5, packages/contracts/src/editor.ts.
// See ../../drivers/T3CODE-LICENSE.md for the upstream notice.
const editors: Editor[] = [
  { id: 'cursor', label: 'Cursor', commands: ['cursor'], style: 'goto', base: ['--classic'] },
  { id: 'trae', label: 'Trae', commands: ['trae'], style: 'goto' },
  { id: 'kiro', label: 'Kiro', commands: ['kiro'], style: 'goto', base: ['ide'] },
  { id: 'vscode', label: 'VS Code', commands: ['code'], style: 'goto', bundles: ['Visual Studio Code'] },
  { id: 'vscode-insiders', label: 'VS Code Insiders', commands: ['code-insiders'], style: 'goto', bundles: ['Visual Studio Code - Insiders'] },
  { id: 'vscodium', label: 'VSCodium', commands: ['codium'], style: 'goto' },
  { id: 'zed', label: 'Zed', commands: ['zed', 'zeditor'], style: 'direct' },
  { id: 'antigravity', label: 'Antigravity', commands: ['antigravity-ide', 'agy-ide'], style: 'goto', bundles: ['Antigravity IDE'] },
  { id: 'idea', label: 'IntelliJ IDEA', commands: ['idea'], style: 'line-column', bundles: ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'] },
  { id: 'aqua', label: 'Aqua', commands: ['aqua'], style: 'line-column' },
  { id: 'clion', label: 'CLion', commands: ['clion'], style: 'line-column' },
  { id: 'datagrip', label: 'DataGrip', commands: ['datagrip'], style: 'line-column' },
  { id: 'dataspell', label: 'DataSpell', commands: ['dataspell'], style: 'line-column' },
  { id: 'goland', label: 'GoLand', commands: ['goland'], style: 'line-column' },
  { id: 'phpstorm', label: 'PhpStorm', commands: ['phpstorm'], style: 'line-column' },
  { id: 'pycharm', label: 'PyCharm', commands: ['pycharm'], style: 'line-column', bundles: ['PyCharm', 'PyCharm CE'] },
  { id: 'rider', label: 'Rider', commands: ['rider'], style: 'line-column', bundles: ['Rider', 'JetBrains Rider'] },
  { id: 'rubymine', label: 'RubyMine', commands: ['rubymine'], style: 'line-column' },
  { id: 'rustrover', label: 'RustRover', commands: ['rustrover'], style: 'line-column' },
  { id: 'webstorm', label: 'WebStorm', commands: ['webstorm'], style: 'line-column' },
]

interface Launcher {
  id: string
  label: string
  command: string
  editor?: Editor
}

function findExecutable(candidates: string[], searchPath: string): string | null {
  for (const candidate of candidates) {
    const found = Bun.which(candidate, { PATH: searchPath })
    // Windows command shims reparse arguments through a shell. Use the app's
    // executable directly so file names remain a single argument.
    if (found && isAbsolute(found) && (process.platform !== 'win32' || /\.exe$/iu.test(found))) return found
  }
  return null
}

function installedEditors(): Launcher[] {
  const home = homedir()
  const mac = process.platform === 'darwin'
  const searchPath = [process.env.PATH, join(home, '.local', 'bin'), ...(mac ? ['/opt/homebrew/bin', '/usr/local/bin', join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts')] : [])]
    .filter(Boolean).join(delimiter)
  const installed: Launcher[] = []
  for (const editor of editors) {
    const bundlePaths = mac ? [join(home, 'Applications'), '/Applications'].flatMap(root => (editor.bundles ?? [editor.label]).flatMap((name) => {
      const contents = join(root, `${name}.app`, 'Contents')
      return editor.style === 'goto'
        ? [join(contents, 'Resources', 'app', 'bin', editor.commands[0]!), join(contents, 'Resources', 'app', 'bin', 'code')]
        : [join(contents, 'MacOS', editor.id === 'zed' ? 'cli' : editor.commands[0]!)]
    })) : []
    const candidates = editor.id === 'zed' && mac ? [...bundlePaths, ...editor.commands]
      : editor.id === 'zed' && process.platform === 'linux' ? ['zeditor', 'zed'] : [...editor.commands, ...bundlePaths]
    const command = findExecutable(candidates, searchPath)
    if (command) installed.push({ id: editor.id, label: editor.label, command, editor })
  }
  const system = mac ? ['Finder', '/usr/bin/open']
    : process.platform === 'win32' ? ['File Explorer', 'explorer.exe'] : ['Files', 'xdg-open']
  const fileManager = findExecutable([system[1]!], searchPath)
  if (fileManager) installed.push({ id: 'file-manager', label: system[0]!, command: fileManager })
  return installed
}

function launchArgs(launcher: Launcher, root: string, target: string, folder: boolean, line: number, column: number): string[] {
  const editor = launcher.editor
  if (!editor) {
    if (process.platform === 'darwin') return folder ? [target] : ['-R', target]
    if (process.platform === 'win32') return folder ? [target] : [`/select,${target}`]
    return [folder ? target : dirname(target)]
  }
  const base = editor.base ?? []
  if (editor.style === 'line-column') {
    // JetBrains counts CLI columns from zero.
    return line ? [...base, root, '--line', String(line), ...(column ? ['--column', String(column - 1)] : []), target] : [...base, target]
  }
  // Numeric colon components in an exact filename can be misread by CLIs
  // that accept path:line syntax. Preserve the file with an unpositioned open.
  const positioned = line > 0 && !target.split(':').slice(1).some(segment => /^\d+$/u.test(segment))
  const destination = positioned ? `${target}:${line}${column ? `:${column}` : ''}` : target
  if (editor.style === 'direct') return [...base, destination]
  if (folder) return [...base, '--new-window', target]
  return positioned ? [...base, '--goto', destination] : [...base, target]
}

const headers = { 'cache-control': 'private, no-store' }

export async function respondWorkspaceEditor(workspace: string, url: URL, method: string): Promise<Response> {
  const failure = (error: string, status: number) => Response.json({ error }, { status, headers })
  const root = await realpath(workspace).catch(() => null)
  if (!root || !await stat(root).then(info => info.isDirectory(), () => false)) return failure('The workspace folder is unavailable.', 404)
  const installed = installedEditors()
  if (method === 'GET') return Response.json({ choices: installed.map(({ id, label }) => ({ id, label })) }, { headers })

  const path = url.searchParams.get('path') ?? ''
  const requestedLine = url.searchParams.get('line') ?? '0'
  const requestedColumn = url.searchParams.get('column') ?? '0'
  const line = Number(requestedLine)
  const column = Number(requestedColumn)
  const validPosition = (value: string, n: number) => /^\d{1,10}$/u.test(value) && n <= 2147483647
  if (path.length > 4096 || !validPosition(requestedLine, line) || !validPosition(requestedColumn, column) || (!path && line) || (!line && column))
    return failure('Choose a valid workspace file and position.', 400)
  const target = path ? await resolveWorkspaceEntry(root, path) : root
  const info = target && await stat(target).catch(() => null)
  if (!target || !info || (path ? !info.isFile() : !info.isDirectory())) return failure('The workspace file is unavailable.', 404)
  const launcher = installed.find(item => item.id === url.searchParams.get('editor'))
  if (!launcher) return failure('This editor is unavailable on the Harness host.', 404)
  try {
    const child = Bun.spawn([launcher.command, ...launchArgs(launcher, root, target, info.isDirectory(), line, column)], {
      cwd: root, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true,
    })
    child.unref()
    const exit = await Promise.race([child.exited, Bun.sleep(250).then(() => null)])
    if (exit && !(process.platform === 'win32' && launcher.id === 'file-manager' && exit === 1))
      return failure(`Could not open ${launcher.label}. Check that it is installed and accepting requests.`, 503)
    return new Response(null, { status: 204, headers })
  }
  catch { return failure(`Could not start ${launcher.label}.`, 503) }
}
