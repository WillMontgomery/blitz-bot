import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from './config.ts'

/**
 * Where the environment comes from, and what happens when it does not come.
 *
 * THE BUG THIS FILE EXISTS FOR: nothing loaded `.env`. The start script was
 * `node --disable-warning=ExperimentalWarning src/index.ts` with no env-file
 * flag, there was no dotenv dependency, and src/index.ts asserted in its header
 * that the environment arrived pre-populated from a systemd `EnvironmentFile=`.
 * That assumption held under systemd and nowhere else, so the foreground first
 * run the runbook asks for — `.env` written correctly, `npm start` — exited on
 * `DISCORD_BOT_TOKEN: not set`. The fix is one flag in package.json, and a flag
 * in a JSON file has nothing to hold a comment and nothing to stop a tidy-up
 * from deleting it. That is what the first test is: read the script, look for
 * the flag.
 *
 * THE PRECEDENCE TESTS SPAWN A REAL NODE, which is unusual for a unit test and
 * is the only honest way to check this. `--env-file-if-exists` is Node's
 * behaviour, not ours; whether the file or the surrounding environment wins is
 * a fact about the runtime that this repo's comments now promise operators, and
 * the only test that can catch a Node release changing it is one that actually
 * runs Node. Offline, no network, no credentials: a temp directory, a `.env`
 * with made-up values, and the same flags package.json really uses.
 *
 * NOTHING HERE TOUCHES THE REAL `process.env`. The in-process tests hand
 * `loadConfig` an object, which is what the parameter is for, and the spawned
 * ones get an environment built for them with every variable in the schema
 * stripped out first — otherwise a developer with `DISCORD_BOT_TOKEN` exported
 * in their shell would get different results from CI.
 */

const repoFile = (path: string): string =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** Every variable src/config.ts reads, so a test can guarantee their absence. */
const schemaVariables = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_GUILD_ID',
  'DISCORD_ADMIN_ROLE_ID',
  'BLITZ_LOG_CHANNEL_ID',
  'BLITZ_EXEMPT_CHANNEL_IDS',
  'BLITZ_EXEMPT_ADMINS',
  'BLITZ_DRY_RUN',
]

/**
 * `scripts.start` out of package.json, or a loud failure.
 *
 * Typed rather than left as `any` so that a rename of `scripts` fails here,
 * with the key named, instead of somewhere further down as a comparison
 * between two undefineds that quietly passes.
 */
function startScript(): string {
  const manifest = JSON.parse(repoFile('package.json')) as {
    scripts?: Record<string, string>
  }

  const start = manifest.scripts?.start
  if (start === undefined) throw new Error('package.json has no scripts.start')
  return start
}

describe('the start script', () => {
  /**
   * THE REGRESSION TEST FOR THE ACTUAL BUG. Everything else in this file
   * describes how the loading behaves; this is the one that notices it is not
   * happening at all.
   */
  it('hands node an env-file flag, so a hand-started bot reads .env', () => {
    expect(startScript()).toContain('--env-file-if-exists=.env')
  })

  /**
   * `--env-file` and `--env-file-if-exists` are one word apart and the wrong
   * one exits non-zero when the file is absent — which is fine on the box,
   * where `.env` is always there, and takes down any deployment that supplies
   * the environment some other way and ships no file. The failure would be a
   * bot that stops booting on a machine nobody tests on.
   */
  it('uses the tolerant flag, not the one that exits on a missing file', () => {
    expect(startScript()).not.toMatch(/--env-file=/)
  })

  it('still runs the entrypoint from source', () => {
    expect(startScript()).toContain('src/index.ts')
  })
})

/**
 * The node arguments package.json really passes, minus the entrypoint.
 *
 * TAKEN FROM THE SCRIPT RATHER THAN RESTATED, so the spawned tests below
 * exercise the flags the operator gets. A copy of the flag list in this file
 * would keep testing the old flag for as long as it took someone to notice.
 */
function startFlags(): string[] {
  return startScript()
    .split(/\s+/)
    .filter((word) => word.startsWith('--'))
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true })
  temporaryDirectories.length = 0
})

/**
 * Run `loadConfig` in a real node process started the way `npm start` starts
 * it, and return the config it built.
 *
 * `envFile` IS THE LITERAL CONTENT OF A `.env` NEXT TO THE PROCESS, or nothing
 * at all, because "there is no file" is one of the two cases the flag was
 * chosen for. `environment` is the surrounding environment: the variables
 * systemd's `EnvironmentFile=` or an `export` in a shell would have set before
 * node ever started.
 *
 * The child's cwd is the temp directory, which is what makes the relative
 * `.env` in the flag point at the fixture — and is the same relationship
 * `npm start` creates by running from the directory holding package.json.
 */
function bootWith(options: { envFile?: string; environment: Record<string, string> }): {
  config: Record<string, unknown>
  status: number | null
  stderr: string
} {
  const directory = mkdtempSync(join(tmpdir(), 'blitz-env-'))
  temporaryDirectories.push(directory)

  if (options.envFile !== undefined) writeFileSync(join(directory, '.env'), options.envFile)

  // The probe is the smallest thing that proves the whole chain: node applied
  // the flag, `process.env` came out of it, and zod accepted the result. It
  // imports src/config.ts by absolute URL through argv, so that nothing about
  // this test depends on a variable — the very thing under test.
  const probe = join(directory, 'probe.mjs')
  writeFileSync(
    probe,
    [
      'const { loadConfig } = await import(process.argv[2])',
      'process.stdout.write(JSON.stringify(loadConfig()))',
      '',
    ].join('\n'),
  )

  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const name of schemaVariables) delete environment[name]
  Object.assign(environment, options.environment)

  const result = spawnSync(
    process.execPath,
    [...startFlags(), probe, new URL('./config.ts', import.meta.url).href],
    { cwd: directory, env: environment, encoding: 'utf8' },
  )

  if (result.status !== 0) {
    throw new Error(`probe exited ${String(result.status)}\n${result.stderr}`)
  }

  return {
    config: JSON.parse(result.stdout) as Record<string, unknown>,
    status: result.status,
    stderr: result.stderr,
  }
}

describe('.env, as node loads it', () => {
  it('supplies variables the environment does not have', () => {
    const { config } = bootWith({
      envFile: 'DISCORD_BOT_TOKEN=token-from-file\nDISCORD_GUILD_ID=guild-from-file\n',
      environment: {},
    })

    expect(config.discordToken).toBe('token-from-file')
    expect(config.guildId).toBe('guild-from-file')
  })

  /**
   * PRECEDENCE, PINNED. An already-set variable wins; `.env` fills in gaps and
   * overwrites nothing.
   *
   * This is the direction that makes systemd's `EnvironmentFile=` values
   * survive a stale `.env` sitting beside them, and it is also the direction
   * that produces the confusing follow-up bug — an operator edits `.env`,
   * restarts, and nothing changes, because a leftover `export` in their shell
   * is still winning. Both `.env.example` and src/config.ts now tell people
   * which way round it is, so it has to stay this way round or those documents
   * start lying.
   */
  it('loses to a variable that is already set in the environment', () => {
    const { config } = bootWith({
      envFile: 'DISCORD_BOT_TOKEN=token-from-file\nDISCORD_GUILD_ID=guild-from-file\n',
      environment: { DISCORD_BOT_TOKEN: 'token-from-environment' },
    })

    expect(config.discordToken).toBe('token-from-environment')
    // The other key was not in the environment, so the file still filled it —
    // the file is not ignored wholesale, only overridden key by key.
    expect(config.guildId).toBe('guild-from-file')
  })

  /**
   * The second reason for `--env-file-if-exists`: a deployment that hands the
   * process its environment some other way and puts no `.env` on disk still
   * has to boot. `--env-file` would exit here without ever reaching
   * `loadConfig`.
   */
  it('being absent is not an error when the environment is complete', () => {
    const { config } = bootWith({
      environment: {
        DISCORD_BOT_TOKEN: 'token-from-environment',
        DISCORD_GUILD_ID: 'guild-from-environment',
      },
    })

    expect(config.discordToken).toBe('token-from-environment')
    expect(config.guildId).toBe('guild-from-environment')
  })
})

describe('loadConfig, when neither source supplies the required variables', () => {
  /**
   * THIS BEHAVIOUR IS WHAT MADE THE BUG DIAGNOSABLE and must not regress. The
   * owner's report was a verbatim copy of this message; a bot that instead
   * started and failed later inside discord.js would have sent him looking at
   * his token in the developer portal.
   */
  it('names every missing variable in one message', () => {
    let message = ''
    try {
      loadConfig({})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('Invalid configuration:')
    expect(message).toContain('DISCORD_BOT_TOKEN: not set')
    expect(message).toContain('DISCORD_GUILD_ID: not set')
    // One restart, one complete list. Reporting the first fault only is how a
    // five-minute setup becomes an hour.
    expect(message).toContain('See .env.example')
  })

  /**
   * The copied-but-unedited `.env`: the file loads, both required keys are
   * present, and both are blank. `.env.example` ships them blank deliberately,
   * so this is a path an operator takes on purpose and has to be told about
   * distinctly from "not set" — the file was read, the value was not filled in.
   */
  it('distinguishes a variable that is set but empty', () => {
    let message = ''
    try {
      loadConfig({ DISCORD_BOT_TOKEN: '', DISCORD_GUILD_ID: '   ' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('DISCORD_BOT_TOKEN: set but empty')
    expect(message).toContain('DISCORD_GUILD_ID: set but empty')
  })
})
