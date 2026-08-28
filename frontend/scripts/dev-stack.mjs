// dev-stack.mjs — one-command dev stack: FastAPI backend + Vite frontend.
// Spawns the backend (demo dataset by default) and Vite, forwarding any
// CLI args (e.g. --port/--host from `npm run dev -- --port 7100`) to Vite.
// Both children are torn down when this process exits.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(frontendDir, '..')
const isWin = process.platform === 'win32'
const venvLayouts = [
  ['.venv-viz', isWin ? 'Scripts/python.exe' : 'bin/python'],
  ['.venv', isWin ? 'Scripts/python.exe' : 'bin/python'],
]
const venvPython = venvLayouts
  .map(([dir, exe]) => path.join(repoRoot, dir, exe))
  .find(existsSync)
const python = process.env.PFLOW_VIZ_PYTHON ?? venvPython ?? (isWin ? 'python' : 'python3')

// Demo defaults — only applied when the caller hasn't pointed the backend
// at real data via the environment.
const userSetDb = Boolean(process.env.PFLOW_VIZ_DB)
const env = { ...process.env }
env.PFLOW_VIZ_DB ??= path.join(repoRoot, 'demo', 'demo.duckdb')
env.PFLOW_VIZ_SOURCES ??= path.join(repoRoot, 'demo', 'sources.demo.yaml')
env.PFLOW_VIZ_OUTPUT_ROOT ??= path.join(repoRoot, 'demo')

// First run: ingest the demo dataset if the DB doesn't exist yet — but only
// in demo mode. When the caller pointed at their own (missing) DB, demo
// ingest would write the wrong file; print the right command instead.
if (!existsSync(env.PFLOW_VIZ_DB)) {
  if (userSetDb) {
    console.warn(`[dev-stack] database not found: ${env.PFLOW_VIZ_DB}`)
    console.warn('[dev-stack] run "trajectory-viz-ingest --reset" (with your PFLOW_VIZ_* env) first; starting with an empty DB')
  } else {
    console.log('[dev-stack] no database found — ingesting demo dataset…')
    const r = spawnSync(python, ['-m', 'backend.demo'], { cwd: repoRoot, env, stdio: 'inherit' })
    if (r.status !== 0) {
      console.error('[dev-stack] demo ingest failed')
      process.exit(r.status ?? 1)
    }
  }
}

const children = []
function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[${name}] ${d}`))
  child.on('exit', (code) => {
    console.log(`[dev-stack] ${name} exited (${code}) — shutting down`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

function shutdown(code = 0) {
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// Backend: FastAPI on 127.0.0.1:9999 (Vite proxies /api + /randomsample there).
start('api', python, ['-c', 'from backend.app import serve; serve()'], repoRoot)

// Frontend: Vite via its JS entry (avoids .bin shims); forward all CLI args.
start('vite', process.execPath, [path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js'),
  ...process.argv.slice(2)], frontendDir)
