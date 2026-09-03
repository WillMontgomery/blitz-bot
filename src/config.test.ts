import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { channelCollisions, type Config, loadConfig } from './config.ts'
import { CONSOLE_URL } from './console.ts'

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
  'BLITZ_STATUS_CHANNEL_ID',
  'BLITZ_DOCS_CHANNEL_ID',
  'BLITZ_MAINTENANCE_CHANNEL_ID',
  'BLITZ_EXEMPT_CHANNEL_IDS',
  'BLITZ_SERVER_IPS',
  'BLITZ_EXEMPT_ADMINS',
  'BLITZ_DRY_RUN',
  'COMMAND_SECRET',
  'BLITZ_RINGMASTER_URL',
  'BLITZ_GAME_BAN_ROLE_ID',
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

/**
 * The channel the bot reports its OWN faults to.
 *
 * OPTIONAL, AND THAT IS THE POINT OF THESE TWO CASES. The bot is live on the
 * server right now with no `BLITZ_STATUS_CHANNEL_ID` anywhere near it, so a
 * variable that was required — or one that made the schema reject an
 * environment without it — would mean the next deploy refuses to boot until
 * somebody logs into the box, which is the interaction this feature exists to
 * remove.
 */
describe('BLITZ_STATUS_CHANNEL_ID', () => {
  it('is null when it is not set, so the bot still boots on journal only', () => {
    const config = loadConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'guild' })

    expect(config.statusChannelId).toBeNull()
  })

  it('is carried through, and is not the same field as the removal log channel', () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: 'guild',
      BLITZ_LOG_CHANNEL_ID: '111',
      BLITZ_STATUS_CHANNEL_ID: '222',
    })

    expect(config.logChannelId).toBe('111')
    expect(config.statusChannelId).toBe('222')
  })
})

/**
 * The channel the bot keeps its own manual posted in.
 *
 * OPTIONAL FOR THE SAME REASON THE STATUS CHANNEL IS, and one more: unset does
 * not mean "publish nowhere", it means the feature does not exist. Nothing is
 * read off disk and nothing is posted. The bot is live today with no such
 * channel and has to keep booting exactly as it does now.
 */
describe('BLITZ_DOCS_CHANNEL_ID', () => {
  it('is null when it is not set, so the bot boots with no manual at all', () => {
    const config = loadConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'guild' })

    expect(config.docsChannelId).toBeNull()
  })

  /**
   * THE THREE OPTIONAL CHANNEL IDS ARE THREE DIFFERENT FIELDS. This one names a
   * channel the bot EDITS AND DELETES MESSAGES IN; the other two hold records of
   * things that happened. Crossing them would put the bot's own edits into a
   * channel of evidence, so a test that could not tell them apart is not enough.
   */
  it('is carried through, and is neither of the other two channels', () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: 'guild',
      BLITZ_LOG_CHANNEL_ID: '111',
      BLITZ_STATUS_CHANNEL_ID: '222',
      BLITZ_DOCS_CHANNEL_ID: '333',
    })

    expect(config.logChannelId).toBe('111')
    expect(config.statusChannelId).toBe('222')
    expect(config.docsChannelId).toBe('333')
  })

  /** Blank is absent, like every other optional id: a copied-but-unedited
   * `.env` must turn the feature off rather than name a channel called "". */
  it('reads a blank line as unset', () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: 'guild',
      BLITZ_DOCS_CHANNEL_ID: '   ',
    })

    expect(config.docsChannelId).toBeNull()
  })

  /**
   * `.env.example` IS THE DOCUMENT OPERATORS ACTUALLY COPY, and a variable the
   * code reads but the template does not mention is a feature nobody can find.
   */
  it('is in the template operators copy', () => {
    expect(repoFile('.env.example')).toContain('BLITZ_DOCS_CHANNEL_ID=')
  })
})

/**
 * The channel the outage is announced in.
 *
 * OPTIONAL, AND UNSET DOES MORE HERE THAN IN THE OTHER THREE. With no channel
 * there is nowhere to announce anything, so the watcher is not installed at all
 * and `ringmaster-maintenance` is never read — the bot makes no AWS call it
 * would otherwise make four times a minute for the life of the process. That is
 * why the null case is worth its own assertion rather than being read off the
 * shape of the other ids.
 */
describe('BLITZ_MAINTENANCE_CHANNEL_ID', () => {
  it('is null when it is not set, so the bot boots announcing nothing', () => {
    const config = loadConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'guild' })

    expect(config.maintenanceChannelId).toBeNull()
  })

  /**
   * THE FOUR OPTIONAL CHANNEL IDS ARE FOUR DIFFERENT FIELDS, and this is the
   * only one an ordinary member reads. The other three carry the moderation
   * record, the bot's own faults and a document the bot edits; an outage notice
   * landing in any of them is an announcement posted where nobody is looking and
   * a channel of evidence with a player-facing message in it.
   */
  it('is carried through, and is none of the other three channels', () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: 'guild',
      BLITZ_LOG_CHANNEL_ID: '111',
      BLITZ_STATUS_CHANNEL_ID: '222',
      BLITZ_DOCS_CHANNEL_ID: '333',
      BLITZ_MAINTENANCE_CHANNEL_ID: '444',
    })

    expect(config.logChannelId).toBe('111')
    expect(config.statusChannelId).toBe('222')
    expect(config.docsChannelId).toBe('333')
    expect(config.maintenanceChannelId).toBe('444')
  })

  /** Blank is absent, like every other optional id: a copied-but-unedited
   * `.env` must turn the watcher off rather than name a channel called "". */
  it('reads a blank line as unset', () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: 'guild',
      BLITZ_MAINTENANCE_CHANNEL_ID: '   ',
    })

    expect(config.maintenanceChannelId).toBeNull()
  })

  it('is in the template operators copy', () => {
    expect(repoFile('.env.example')).toContain('BLITZ_MAINTENANCE_CHANNEL_ID=')
  })
})

/**
 * The role that decides who is an admin.
 *
 * IT NOW ANSWERS TWO QUESTIONS AND UNSET MEANS THE OPPOSITE IN EACH, which is
 * why it is worth its own cases rather than being left to whoever reads it. On
 * the moderation path unset turns the admin EXEMPTION off, so every message is
 * scanned. On the slash-command path it is the gate, so an admin-only command
 * refuses everybody. Both are the closed direction for what they guard, and
 * `loadConfig` has to keep saying "null" rather than inventing a default,
 * because either half given a made-up role id would be guarding nothing.
 */
describe('DISCORD_ADMIN_ROLE_ID', () => {
  it('is null when it is not set, and is never given a default', () => {
    const config = loadConfig({ DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'guild' })

    expect(config.adminRoleId).toBeNull()
  })

  /** Blank is absent, like every other optional id: a copied-but-unedited
   * `.env` must leave the bot with no admin role rather than one called "". */
  it('reads a blank line as unset', () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: 'guild',
      DISCORD_ADMIN_ROLE_ID: '   ',
    })

    expect(config.adminRoleId).toBeNull()
  })

  it('is carried through when it is set', () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: 'guild',
      DISCORD_ADMIN_ROLE_ID: '444',
    })

    expect(config.adminRoleId).toBe('444')
  })

  /**
   * `.env.example` IS THE DOCUMENT OPERATORS ACTUALLY COPY, and this variable
   * gained a second meaning without gaining a line there — which is how an
   * operator ends up unsetting it to turn the moderation exemption off and
   * silently switching off every admin-only command at the same time.
   */
  it('tells operators in the template that it gates the commands too', () => {
    expect(repoFile('.env.example')).toContain('DISCORD_ADMIN_ROLE_ID=')
    expect(repoFile('.env.example')).toContain('slash commands')
  })
})

/**
 * The addresses the link policy treats as this community's own.
 *
 * OPTIONAL, BUT UNSET MEANS SOMETHING DIFFERENT HERE FROM EVERY OTHER OPTIONAL
 * VARIABLE IN THIS FILE, which is why it is worth its own cases. Everywhere else
 * unset turns a feature off. Here an empty list would leave the feature fully on
 * and pointed at the wrong target: every IPv4-shaped string is removed, so an
 * allowlist of nothing deletes the message that names this server. The default
 * is what stops an unset variable being that.
 */
describe('BLITZ_SERVER_IPS', () => {
  const base = { DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'guild' }

  it('falls back to this deployment s own two addresses when it is not set', () => {
    expect(loadConfig(base).serverIps).toEqual(['3.130.92.28', '18.222.244.205'])
  })

  /**
   * A copied-but-unedited `.env` and a systemd unit with `BLITZ_SERVER_IPS=` in
   * it look identical from here, and neither is a request for an empty
   * allowlist — there is deliberately no way to spell that.
   */
  it('reads a blank line as unset rather than as an empty allowlist', () => {
    expect(loadConfig({ ...base, BLITZ_SERVER_IPS: '' }).serverIps).toHaveLength(2)
    expect(loadConfig({ ...base, BLITZ_SERVER_IPS: '   ' }).serverIps).toHaveLength(2)
    expect(loadConfig({ ...base, BLITZ_SERVER_IPS: ' , ,, ' }).serverIps).toHaveLength(2)
  })

  it('takes a comma-separated list, so a third server needs no deploy', () => {
    const config = loadConfig({
      ...base,
      BLITZ_SERVER_IPS: '3.130.92.28, 18.222.244.205 ,10.0.0.7',
    })

    expect(config.serverIps).toEqual(['3.130.92.28', '18.222.244.205', '10.0.0.7'])
  })

  it('drops the formatting accidents the channel id list drops', () => {
    const config = loadConfig({ ...base, BLITZ_SERVER_IPS: '10.0.0.7,,\n10.0.0.8,' })

    expect(config.serverIps).toEqual(['10.0.0.7', '10.0.0.8'])
  })

  /**
   * A MALFORMED ENTRY STOPS THE PROCESS, WITH THE VARIABLE NAMED. Dropping it
   * silently is the expensive direction twice over: the entry that was meant to
   * exempt this server does not, so the bot boots, looks healthy, and deletes
   * the one link the channel is for — and links.ts uses this list to exempt a
   * `fivem://connect/` target, so a hostname smuggled in here would be an
   * allowlisted destination rather than a dead line.
   */
  /**
   * THE SPELLINGS links.ts CAN NEVER PRODUCE, WHICH USED TO BOOT. The shape
   * check here was its own regex — one to three digits per octet, no range and
   * no leading-zero rule — while the matcher has rejected an octet over 255 and
   * a padded octet since the ShadowPlay clips forced that question. Each of
   * these therefore parsed, sat in `serverIps`, and exempted nothing: an
   * allowlist line that looks like protection and is not one. The two are now
   * one imported regex, so this class cannot come back without deleting the
   * import.
   */
  it.each(['999.1.1.1', '256.1.1.1', '014.22.5.3', '3.130.092.28', '0300.0400.0500.0600'])(
    'refuses to boot on %s, which no matched address could ever equal',
    (entry: string) => {
      let message = ''
      try {
        loadConfig({ ...base, BLITZ_SERVER_IPS: entry })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      expect(message).toContain('BLITZ_SERVER_IPS')
      expect(message).toContain(entry)
    },
  )

  /**
   * A SINGLE `0` IS STILL AN OCTET, which is the other half of the leading-zero
   * rule and is easy to lose while adding the first half. The matcher removes
   * `0.0.0.0` and `127.0.0.1`, so an operator has to be able to allowlist them.
   */
  it.each(['0.0.0.0', '127.0.0.1', '255.255.255.255', '10.0.0.7'])(
    'still accepts %s, because the matcher can produce it',
    (entry: string) => {
      expect(loadConfig({ ...base, BLITZ_SERVER_IPS: entry }).serverIps).toEqual([entry])
    },
  )

  it.each(['evil.com', '3.130.92', '3.130.92.28.1', '3.130.92.2 8', 'fivem://connect/evil.com'])(
    'refuses to boot on the entry %s',
    (entry: string) => {
      let message = ''
      try {
        loadConfig({ ...base, BLITZ_SERVER_IPS: entry })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      expect(message).toContain('BLITZ_SERVER_IPS')
      expect(message).toContain(entry)
    },
  )

  it('names every bad entry at once, like every other variable here', () => {
    let message = ''
    try {
      loadConfig({ ...base, BLITZ_SERVER_IPS: 'evil.com,3.130.92.28,also-bad' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('evil.com')
    expect(message).toContain('also-bad')
  })

  /**
   * THE TEMPLATE AND THE SOURCE DEFAULT HAVE TO SAY THE SAME THING. They are two
   * copies of one fact, and the one that ships to a box running systemd's
   * `EnvironmentFile=` — which never reads `.env.example` — is the source one.
   * A template that drifted would send an operator looking for the wrong list.
   */
  it('is in the template operators copy, with the same two addresses', () => {
    expect(repoFile('.env.example')).toContain('BLITZ_SERVER_IPS=3.130.92.28,18.222.244.205')
  })
})

/**
 * THE THREE SETTINGS THE MODERATION MIRROR ADDED — blitz-bot#16.
 *
 * `COMMAND_SECRET` opens the console's command routes, `BLITZ_RINGMASTER_URL`
 * says where they are, and `BLITZ_GAME_BAN_ROLE_ID` is the role a game ban
 * assigns. What is decided here is which of them may be absent and what absence
 * means, because the three answers are deliberately not the same one.
 */
describe('loadConfig, on the console relay', () => {
  const base = { DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'guild' }

  /**
   * UNSET MEANS THE LIVE KICK IS OFF AND NOTHING ELSE IS. The ban row is written
   * straight to DynamoDB and needs no console at all; the standing rule is that
   * this bot must never depend on the console being up, and a required secret
   * here would be that dependency written into the boot path.
   */
  it('treats an absent command secret as null rather than refusing to boot', () => {
    expect(loadConfig(base).commandSecret).toBeNull()
    expect(loadConfig({ ...base, COMMAND_SECRET: '   ' }).commandSecret).toBeNull()
  })

  it('carries the secret through untouched when there is one', () => {
    expect(loadConfig({ ...base, COMMAND_SECRET: 's3cret' }).commandSecret).toBe('s3cret')
  })

  /**
   * THE SECRET MUST NEVER REACH THE FAILURE MESSAGE, which is written to stderr
   * and read out of `systemctl status`. Nothing shape-checks it, so there is
   * nothing that could quote it — and this is the test that stops somebody
   * adding a `.min(32)` with a helpful message attached.
   */
  it('never echoes the secret in an error, even when everything else is wrong', () => {
    let message = ''
    try {
      loadConfig({ COMMAND_SECRET: 'do-not-print-me', BLITZ_RINGMASTER_URL: 'not a url' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('BLITZ_RINGMASTER_URL')
    expect(message).not.toContain('do-not-print-me')
  })

  /**
   * THE BOT IS THE SECOND SERVICE ON THE CONSOLE'S OWN BOX and the console
   * listens on 127.0.0.1:3000 there, so the address is a fact about this
   * deployment rather than something an operator should have to restate. Unlike
   * every optional channel id, unset does not mean "off" — `COMMAND_SECRET` is
   * the switch, and it is one switch rather than two.
   */
  it('defaults to the loopback the console listens on', () => {
    expect(loadConfig(base).ringmasterUrl).toBe('http://127.0.0.1:3000')
    expect(loadConfig({ ...base, BLITZ_RINGMASTER_URL: '' }).ringmasterUrl).toBe(
      'http://127.0.0.1:3000',
    )
  })

  it('normalises an origin so nothing downstream has two spellings of it', () => {
    expect(loadConfig({ ...base, BLITZ_RINGMASTER_URL: 'http://localhost:3000/' }).ringmasterUrl).toBe(
      'http://localhost:3000',
    )
    expect(loadConfig({ ...base, BLITZ_RINGMASTER_URL: ' https://console.example ' }).ringmasterUrl).toBe(
      'https://console.example',
    )
  })

  /**
   * A BASE URL WITH A PATH ON IT IS A 404, AND A 404 OUT OF THE CONSOLE LOOKS
   * EXACTLY LIKE A CONSOLE THAT IS DOWN — an evening spent on the wrong service.
   * Refusing at boot names the variable instead.
   */
  it('refuses a url carrying a path, a query or a fragment', () => {
    for (const bad of [
      'http://127.0.0.1:3000/console',
      'http://127.0.0.1:3000/?x=1',
      'http://127.0.0.1:3000/#top',
    ]) {
      let message = ''
      try {
        loadConfig({ ...base, BLITZ_RINGMASTER_URL: bad })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      expect(message).toContain('BLITZ_RINGMASTER_URL')
      expect(message).toContain('no path, query or fragment')
    }
  })

  /** `file:` and `data:` parse perfectly well and would send the credential
   * somewhere no console is listening. */
  it('refuses a scheme that is not http or https', () => {
    let message = ''
    try {
      loadConfig({ ...base, BLITZ_RINGMASTER_URL: 'file:///etc/passwd' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('BLITZ_RINGMASTER_URL: must be an http or https URL')
  })

  it('refuses something that is not a url at all', () => {
    let message = ''
    try {
      loadConfig({ ...base, BLITZ_RINGMASTER_URL: '127.0.0.1:3000' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('BLITZ_RINGMASTER_URL: must be')
  })

  /**
   * ═══ WHERE A PERSON REACHES THE CONSOLE IS NOT CONFIGURATION ═══
   *
   * IT IS `CONSOLE_URL` IN src/console.ts, and this case is here so that the
   * removal of `BLITZ_RINGMASTER_PUBLIC_URL` cannot be quietly undone. There is
   * one Ringmaster console and no deployment for which a different value would be
   * right, so a variable bought nothing, added a boot failure, and gave the owner
   * something to set correctly or lose a button.
   *
   * WHAT DOES MATTER IS THAT NEITHER VALUE BECOMES THE OTHER. `ringmasterUrl` is
   * the loopback the kick relay calls; a link built from it opens `127.0.0.1` on
   * the clicker's own machine. The two are different facts and the config carries
   * only the one that varies.
   */
  it('carries the loopback the relay calls and no public origin at all', () => {
    const config = loadConfig({ ...base, BLITZ_RINGMASTER_URL: 'http://127.0.0.1:3000' })

    expect(config.ringmasterUrl).toBe('http://127.0.0.1:3000')
    expect(Object.keys(config)).not.toContain('ringmasterPublicUrl')
    expect(CONSOLE_URL).not.toBe(config.ringmasterUrl)
    expect(CONSOLE_URL.startsWith('https://')).toBe(true)
  })

  /**
   * A VARIABLE THAT NO LONGER EXISTS IS IGNORED RATHER THAN REFUSED. An operator
   * upgrading past this change has `BLITZ_RINGMASTER_PUBLIC_URL=` left in a
   * `.env` or an `EnvironmentFile`, and a bot that refused to boot over a stale
   * line would turn a tidy-up into an outage.
   */
  it('boots with the removed variable still set in the environment', () => {
    expect(() =>
      loadConfig({ ...base, BLITZ_RINGMASTER_PUBLIC_URL: 'https://ringmaster.example/console' }),
    ).not.toThrow()
  })

  /**
   * THE ROLE ID HAS A DEFAULT IN THE SOURCE, for `DEFAULT_SERVER_IPS`'s reason:
   * a value that lived only in `.env.example` is a value systemd's
   * `EnvironmentFile=` never reads, and the failure would be silent — the ban is
   * mirrored, the role is never touched, and a policy the owner settled is half
   * implemented in a way nothing in the guild shows.
   */
  it('defaults the game-ban role to the id the owner settled on', () => {
    expect(loadConfig(base).gameBanRoleId).toBe('1542596612306505808')
    expect(loadConfig({ ...base, BLITZ_GAME_BAN_ROLE_ID: '  ' }).gameBanRoleId).toBe(
      '1542596612306505808',
    )
  })

  it('takes an override for a second guild', () => {
    expect(loadConfig({ ...base, BLITZ_GAME_BAN_ROLE_ID: '999' }).gameBanRoleId).toBe('999')
  })

  /**
   * A SET-BUT-WRONG ROLE ID STOPS THE PROCESS. It was once the only id here that
   * was shape-checked — because it has a default an operator may not know is
   * there, so "I set it and nothing happened" had to be a boot failure naming the
   * variable rather than a silent fallback. Every other id now gets the same
   * check for a related reason; see `the shape of an id` below.
   */
  it('refuses a role id that is not a Discord id', () => {
    let message = ''
    try {
      loadConfig({ ...base, BLITZ_GAME_BAN_ROLE_ID: 'the-banned-role' })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('BLITZ_GAME_BAN_ROLE_ID: must be a Discord id')
  })

  /**
   * THE TEMPLATE AND THE SOURCE DEFAULTS HAVE TO SAY THE SAME THING, the same
   * argument `BLITZ_SERVER_IPS` makes above. `COMMAND_SECRET` is deliberately
   * blank in the template — it is a secret — but it has to be NAMED there, or an
   * operator copying the file has no way to learn the bot wants it.
   */
  it('is in the template operators copy, defaults and all', () => {
    const template = repoFile('.env.example')

    expect(template).toContain('COMMAND_SECRET=')
    expect(template).toContain('BLITZ_RINGMASTER_URL=')
    expect(template).toContain('BLITZ_GAME_BAN_ROLE_ID=')
    expect(template).toContain('1542596612306505808')
    expect(template).toContain('http://127.0.0.1:3000')
  })

  /**
   * BLITZ-BOT#2'S TWO PRECONDITIONS ARE NOT VARIABLES, WHICH IS EXACTLY WHY THEY
   * HAVE TO BE IN THIS FILE. Neither is settable and both are silent when wrong:
   *
   *   THE ROLE HAS TO SIT BELOW THE BOT'S OWN. Discord refuses a role edit unless
   *   the acting member's highest role is above it, and a new role lands wherever
   *   it lands. There is no environment variable that can fix this — it is a drag
   *   in a settings page — so the only place an operator can be told is here.
   *
   *   THE SERVER MEMBERS INTENT HAS TO BE TICKED IN THE DEVELOPER PORTAL. Getting
   *   that wrong does not break the feature, it takes the WHOLE BOT down in a
   *   restart loop on close code 4014, which looks like a bad token to anybody who
   *   has not been told otherwise.
   *
   * ASSERTED RATHER THAN DESCRIBED because this file is a template people copy
   * once and never read again, and a paragraph that quietly disappears in an edit
   * is a deploy that fails at 3am with the answer nowhere.
   */
  it('tells operators the two things about the game-ban role that are not variables', () => {
    const template = repoFile('.env.example')

    expect(template).toContain('BELOW THE BOT')
    expect(template).toContain('Manage Roles')
    expect(template).toContain('Server Members Intent')
    expect(template).toContain('4014')
  })
})

/**
 * ═══ AN ID THAT IS SET AND MISSHAPEN, WHICH USED TO BOOT ═══
 *
 * `optionalId` TOOK ANY NON-EMPTY STRING WHILE ITS NEIGHBOUR RAN A REGEX. The
 * shape check on `BLITZ_GAME_BAN_ROLE_ID` above is the same one, and every other
 * optional id in the schema had none — so a `BLITZ_DOCS_CHANNEL_ID` of `#bot-docs`
 * loaded as a perfectly good non-null value, the feature switched itself on, and
 * the fault surfaced much later at `channels.fetch` as an error about a channel
 * that cannot be read. That phrasing sends an operator into Discord's permission
 * settings for a fault that is in his own `.env`.
 *
 * `DISCORD_GUILD_ID` IS LEFT OUT OF THIS AND IS NOT AN OVERSIGHT. It is required
 * rather than optional, and a wrong one already halts moderation with the
 * variable's own name in the message — `haltModeration` in src/client.ts — which
 * is the outcome every case below is asking for.
 *
 * THE VALUES BELOW ARE HOW A HAND-FILLED `.env` ACTUALLY GOES WRONG, which is the
 * only kind this box has: docs/deploy.md ships a heredoc that a person copies and
 * then completes by reading ids off a Discord client, and it leaves most of these
 * lines blank for him to do exactly that. A mention instead of an id, a smart
 * quote carried in by a copy-paste, a whole channel URL — none of those need an
 * unlucky operator.
 *
 * `BLITZ_EXEMPT_CHANNEL_IDS` IS THE QUIETEST ONE AND IS CHECKED HERE TOO. Nothing
 * ever fetches an exempt channel, so a misshapen entry there produces no later
 * error at all — it is compared against a real `channelId`, never matches, and
 * the channel the operator believed he had exempted goes on being moderated.
 */
describe('the shape of an id', () => {
  const base = { DISCORD_BOT_TOKEN: 'token', DISCORD_GUILD_ID: 'guild' }

  /**
   * Every optional id in the schema, with the field it becomes.
   *
   * READ BACK OUT OF THE SOURCE BY THE LAST CASE IN THIS BLOCK, so that a sixth
   * optional id added to the schema fails here rather than joining quietly as the
   * one variable nothing checks.
   */
  const idVariables: [variable: string, read: (config: Config) => string | null][] = [
    ['DISCORD_ADMIN_ROLE_ID', (config) => config.adminRoleId],
    ['BLITZ_LOG_CHANNEL_ID', (config) => config.logChannelId],
    ['BLITZ_STATUS_CHANNEL_ID', (config) => config.statusChannelId],
    ['BLITZ_DOCS_CHANNEL_ID', (config) => config.docsChannelId],
    ['BLITZ_MAINTENANCE_CHANNEL_ID', (config) => config.maintenanceChannelId],
  ]

  /** The ways a value gets into `.env` looking like an id and not being one. */
  const handFilled: [what: string, value: string][] = [
    ['a channel mention', '#bot-docs'],
    ['a channel link', '<#1542603116258525185>'],
    ['a space inside the digits', '1542603 116258525185'],
    ['a smart-quoted id', '“1542603116258525185”'],
    ['a trailing smart apostrophe', '1542603116258525185’'],
    ['a URL pasted instead of an id', 'https://discord.com/channels/1/1542603116258525185'],
  ]

  const failureFor = (env: Record<string, string>): string => {
    try {
      loadConfig({ ...base, ...env })
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }

    return ''
  }

  /**
   * THE VARIABLE'S NAME IS THE WHOLE POINT. A config fault that stops the process
   * naming the line to edit beats a runtime error that blames Discord, and the
   * value is quoted back so that an invisible difference — the smart quote, the
   * space — is visible in `systemctl status` rather than needing a hex dump.
   */
  it.each(idVariables)('%s refuses a value that is not an id, and names itself', (variable) => {
    for (const [what, value] of handFilled) {
      const message = failureFor({ [variable]: value })

      expect(message, what).toContain(`${variable}: must be a Discord id`)
      expect(message, what).toContain(value)
    }
  })

  /**
   * SURROUNDING WHITESPACE IS STILL FORGIVEN RATHER THAN REFUSED, which is the
   * one hand-filling accident that is not ambiguous. A systemd `Environment=`
   * line with a trailing space, or an operator who typed one after the `=`, meant
   * the id — every other variable in this file has trimmed since it was written,
   * and a boot failure over an invisible character at the end of a correct value
   * would be the fault this check exists to prevent, wearing the other hat.
   */
  it.each(idVariables)('%s still trims the space around a good id', (variable, read) => {
    expect(read(loadConfig({ ...base, [variable]: '  1542603116258525185  ' }))).toBe(
      '1542603116258525185',
    )
  })

  /**
   * BLANK IS STILL UNSET, AND THAT IS THE HIGH-STAKES HALF OF THIS CHANGE. The
   * bot is live, and the `.env` on the box came from docs/deploy.md's heredoc,
   * which ships three of these five blank and the exempt list with them. A shape
   * check that treated an empty value as a malformed one would not be a stricter
   * config — it would be the next deploy refusing to boot.
   */
  it('leaves every optional id null when it is blank, so the live box still boots', () => {
    const blanked = Object.fromEntries(idVariables.map(([variable]) => [variable, '']))
    const config = loadConfig({ ...base, ...blanked, BLITZ_EXEMPT_CHANNEL_IDS: '' })

    for (const [variable, read] of idVariables) expect(read(config), variable).toBeNull()
    expect(config.exemptChannelIds).toEqual([])
  })

  /**
   * A MISSHAPEN ENTRY IN THE LIST STOPS THE PROCESS, naming every bad one at once
   * the way `BLITZ_SERVER_IPS` does. This is the variable with no later error to
   * fall back on: an exempt id is never fetched, only compared.
   */
  it('refuses a malformed entry in the exempt-channel list, and names them all', () => {
    const message = failureFor({ BLITZ_EXEMPT_CHANNEL_IDS: '#general,111,<#222>' })

    expect(message).toContain('BLITZ_EXEMPT_CHANNEL_IDS: must be comma-separated Discord ids')
    expect(message).toContain('#general')
    expect(message).toContain('<#222>')
  })

  /** The formatting accidents it has always dropped are still not malformed. */
  it('still reads a trailing comma and a wrapped line as formatting, not as a fault', () => {
    expect(loadConfig({ ...base, BLITZ_EXEMPT_CHANNEL_IDS: '111,,\n222,' }).exemptChannelIds).toEqual([
      '111',
      '222',
    ])
  })

  /**
   * THE LIST ABOVE IS EVERY OPTIONAL ID IN THE SCHEMA, READ OUT OF THE SCHEMA.
   * The bug being fixed here was one variable quietly missing a check its
   * neighbour had; a hand-maintained list of which variables to test would let
   * the sixth one arrive the same way.
   */
  it('covers every variable in the schema that is parsed as an optional id', () => {
    const declared = [...repoFile('src/config.ts').matchAll(/^ {2}(\w+): optionalId,$/gmu)].map(
      (match) => match[1] ?? '',
    )

    expect(declared).toEqual(idVariables.map(([variable]) => variable))
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

/**
 * Two channel variables set to one channel.
 *
 * THE BUG HAD NO SYMPTOM, WHICH IS WHY IT NEEDED A TEST RATHER THAN A FIX.
 * docs/deploy.md put the status channel's snowflake in `BLITZ_LOG_CHANNEL_ID`
 * and called it the moderation log. Both ids were real channels the bot could
 * post in, so nothing threw, nothing was refused, and no line anywhere said so —
 * the moderation record simply appeared in the wrong room, mixed in with the
 * bot's own faults. A human found it by reading a guide against a manual.
 *
 * THE FOUR ARE LISTED AGAIN HERE, ON PURPOSE. This is a second, independent
 * statement of which ids are meant to be four different rooms: drop one from
 * `CHANNEL_VARIABLES` in src/config.ts and the pair tests below stop finding the
 * collision they assert, rather than quietly checking three ids forever.
 */
const CHANNEL_FIELDS = [
  'logChannelId',
  'statusChannelId',
  'docsChannelId',
  'maintenanceChannelId',
] as const

type ChannelField = (typeof CHANNEL_FIELDS)[number]

const VARIABLE: Record<ChannelField, string> = {
  logChannelId: 'BLITZ_LOG_CHANNEL_ID',
  statusChannelId: 'BLITZ_STATUS_CHANNEL_ID',
  docsChannelId: 'BLITZ_DOCS_CHANNEL_ID',
  maintenanceChannelId: 'BLITZ_MAINTENANCE_CHANNEL_ID',
}

/** The live configuration's starting point: every optional channel unset. */
const noChannels = (): Pick<Config, ChannelField> => ({
  logChannelId: null,
  statusChannelId: null,
  docsChannelId: null,
  maintenanceChannelId: null,
})

describe('two channel variables naming one channel', () => {
  const pairs: [ChannelField, ChannelField][] = []
  CHANNEL_FIELDS.forEach((first, index) => {
    for (const second of CHANNEL_FIELDS.slice(index + 1)) pairs.push([first, second])
  })

  for (const [first, second] of pairs) {
    it(`reports ${VARIABLE[first]} and ${VARIABLE[second]} sharing an id`, () => {
      const config = noChannels()
      config[first] = '999'
      config[second] = '999'

      const found = channelCollisions(config)

      expect(found).toHaveLength(1)
      expect(found[0]?.channelId).toBe('999')

      // Named in the order src/config.ts declares them, not in the order this
      // test happened to set them.
      expect(found[0]?.variables).toEqual([VARIABLE[first], VARIABLE[second]])
      expect(found[0]?.warning).toContain(VARIABLE[first])
      expect(found[0]?.warning).toContain(VARIABLE[second])
    })
  }

  /**
   * THE SENTENCE IS THE FEATURE, so it is pinned rather than pattern-matched.
   * It is read once, in Discord, by somebody who has to know what to go and edit
   * without opening a checkout — and this is the exact pair the deploy guide got
   * wrong. `channel` carries the id alongside it; see src/index.ts.
   */
  it('names both variables in a sentence an operator can act on', () => {
    const config = noChannels()
    config.logChannelId = '777'
    config.statusChannelId = '777'

    expect(channelCollisions(config)[0]?.warning).toBe(
      'BLITZ_LOG_CHANNEL_ID and BLITZ_STATUS_CHANNEL_ID are set to the same channel, ' +
        'and each is meant to be a separate one',
    )
  })

  /** One mistake is one line, however many variables it swept up. */
  it('says it once when three variables share an id, naming all three', () => {
    const config = noChannels()
    config.logChannelId = '555'
    config.docsChannelId = '555'
    config.maintenanceChannelId = '555'

    const found = channelCollisions(config)

    expect(found).toHaveLength(1)
    expect(found[0]?.variables).toEqual([
      'BLITZ_LOG_CHANNEL_ID',
      'BLITZ_DOCS_CHANNEL_ID',
      'BLITZ_MAINTENANCE_CHANNEL_ID',
    ])
    expect(found[0]?.warning).toBe(
      'BLITZ_LOG_CHANNEL_ID, BLITZ_DOCS_CHANNEL_ID and BLITZ_MAINTENANCE_CHANNEL_ID ' +
        'are set to the same channel, and each is meant to be a separate one',
    )
  })

  it('reports two separate collisions separately', () => {
    const config = noChannels()
    config.logChannelId = '111'
    config.statusChannelId = '111'
    config.docsChannelId = '222'
    config.maintenanceChannelId = '222'

    const found = channelCollisions(config)

    expect(found).toHaveLength(2)
    expect(found.map((collision) => collision.channelId)).toEqual(['111', '222'])
  })

  /**
   * THE CORRECT `.env` HAS TO BE SILENT. A check that warns about a working
   * configuration is a check the owner learns to scroll past, and then it is
   * worth less than nothing on the day it is right.
   */
  it('says nothing when all four are different channels', () => {
    const config = noChannels()
    config.logChannelId = '111'
    config.statusChannelId = '222'
    config.docsChannelId = '333'
    config.maintenanceChannelId = '444'

    expect(channelCollisions(config)).toEqual([])
  })

  /**
   * UNSET IS NOT A VALUE AND THREE BLANKS ARE NOT THREE COLLISIONS. This is the
   * bot's live configuration today — one channel set, the rest never filled in —
   * and it is the case a naive equality check gets loudly and permanently wrong.
   */
  it('does not count unset ids as colliding with each other', () => {
    expect(channelCollisions(noChannels())).toEqual([])

    const one = noChannels()
    one.logChannelId = '111'
    expect(channelCollisions(one)).toEqual([])
  })

  /** Straight out of `loadConfig`, so nothing between the two shapes drifts. */
  it('finds the collision in a config the schema actually produced', () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_GUILD_ID: 'guild',
      BLITZ_LOG_CHANNEL_ID: '888',
      BLITZ_STATUS_CHANNEL_ID: '888',
    })

    expect(channelCollisions(config)).toHaveLength(1)
  })

  /**
   * WHERE THE LINE IS LOGGED IS WHAT DECIDES WHETHER IT IS EVER READ, and that
   * is a property of src/index.ts's ORDER that no other test in this repo can
   * see. `report()` in src/log.ts returns immediately when the sink is null and
   * buffers nothing, so a warning raised before `setSink` reaches the journal and
   * nothing else — which for a bot the owner operates from Discord is the same
   * as not raising it. Read as source for the reason the `--env-file-if-exists`
   * test above reads package.json: there is nothing at the call site that a
   * comment alone can stop a tidy-up from reordering.
   */
  it('is logged after the status sink is installed, in src/index.ts', () => {
    const source = repoFile('src/index.ts')
    const sink = source.indexOf('setSink(')
    const check = source.indexOf('channelCollisions(config)')

    expect(sink).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(sink)
  })
})
