import { createClient, statusReporter } from './client.ts'
import { installCommands } from './commands/index.ts'
import { loadConfig, type Config } from './config.ts'
import { log, setSink } from './log.ts'

/**
 * The entrypoint, and the only file that owns the process.
 *
 * FIVE THINGS HAPPEN HERE AND NOTHING ELSE DOES: read the config, build the
 * client, wire the slash commands onto it, arrange to die cleanly, log in.
 * Everything about what the bot actually does lives in client.ts and
 * commands/, which is why those can be tested and this one cannot — this is
 * where the token, the signals and `process.exit` are, and each of those is a
 * thing a test would have to fake in order to observe nothing interesting.
 *
 * THIS RUNS UNDER systemd IN PRODUCTION, and most of what follows is decided by
 * that: it is stopped with SIGTERM, its stdout and stderr are the journal, and
 * a non-zero exit is a restart. See docs/deploy.md.
 *
 * IT IS ALSO STARTED BY HAND, and the environment is where that distinction
 * used to bite. This comment claimed the environment always arrived
 * pre-populated from an `EnvironmentFile`, and the start script was written to
 * match it — no env-file flag, no dotenv dependency — so a foreground `npm
 * start` exited on `DISCORD_BOT_TOKEN: not set` with a correctly filled-in
 * `.env` sitting on disk beside it. Half true is the accurate version: under
 * systemd the unit's `EnvironmentFile=` populates it, and otherwise `npm
 * start` does, from `.env`, via Node's `--env-file-if-exists`. `loadConfig()`
 * neither knows nor cares which of the two got there first (src/config.ts).
 */

let config: Config

try {
  config = loadConfig()
} catch (error) {
  /**
   * WRITTEN STRAIGHT TO STDERR, NOT THROUGH `log()`, and that is the only place
   * in the process where that is true.
   *
   * `loadConfig` produces a deliberately multi-line message — one line per
   * variable that is missing or malformed — because it is read by a person
   * looking at `systemctl status blitz-bot` after a deploy went wrong. `log()`
   * is deliberately one line per event and escapes newlines to `\n` to keep it
   * that way, which is right for every other line this process emits and would
   * turn this one into a wall of backslashes.
   *
   * AN UNCAUGHT THROW WAS THE OTHER OPTION and prints the same message. It also
   * prints a stack trace through zod, which puts twenty lines of this bot's
   * internals between the operator and the name of the variable they have to go
   * and set.
   */
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const client = createClient(config)

/**
 * THE SLASH COMMANDS ARE WIRED HERE AND NOT INSIDE `createClient`, which is the
 * one structural decision in this file worth defending.
 *
 * client.ts is the moderation bot: the message listeners, the halt latch, the
 * removals channel. Slash commands are a separate feature that happens to need
 * the same gateway connection, and mixing them would mean a fault in one
 * sitting in the same function as the other's listeners — the halt path in
 * `createClient` already calls `removeAllListeners`, and it must go on meaning
 * exactly "stop moderating" rather than "stop moderating and also stop
 * answering the owner". Keeping them apart is also why gaining slash commands
 * needed no edit to client.ts at all.
 *
 * IT REGISTERS NOTHING NOW. `installCommands` adds one `clientReady` listener
 * and one `interactionCreate` listener; the registration request goes out when
 * the gateway is up and the guild cache is populated, which is after the login
 * below.
 */
installCommands(client, config)

/**
 * WARNINGS AND ERRORS GET A SECOND COPY IN DISCORD, if a channel was configured
 * for them. This is the one wiring decision that belongs in this file: `log()`
 * is where every fault in the bot already passes, and installing the sink is
 * how those reach somebody who does not read journalctl.
 *
 * INSTALLED BEFORE THE LOGIN, AND IT STILL POSTS NOTHING AT STARTUP. Waiting
 * for `clientReady` here would be listener ordering — this one would run after
 * the one createClient registers, which is the listener that emits the halt
 * line when DISCORD_GUILD_ID names the wrong guild, so the single most
 * important thing the bot can say would be the one thing that never posted.
 * `statusReporter` gates on `client.isReady()` instead, which is already true
 * by the time that event is emitted and is false for everything before it.
 *
 * NO SINK AT ALL WHEN THE VARIABLE IS UNSET, rather than one that quietly
 * discards: the bot is live today with nothing configured, and it has to keep
 * running exactly as it does now until somebody sets the id.
 */
if (config.statusChannelId !== null) {
  setSink(statusReporter(client, config.statusChannelId))
}

/**
 * A REJECTED PROMISE IS LOGGED AND THE PROCESS KEEPS RUNNING, which REPLACES
 * Node's default rather than adding to it — since Node 15 an unhandled
 * rejection terminates the process, so installing this handler is a decision
 * and not a safety net.
 *
 * IT IS THE RIGHT ONE HERE because the rejections this will actually catch come
 * from one message's handling: a `fetchInvite` that lost its race with a
 * shutdown, a REST call that rejected somewhere client.ts did not think to
 * look. Killing a bot that is moderating a live guild over one such message —
 * and dropping the gateway session to reconnect from scratch — costs more than
 * the message did. The line in the journal is what keeps that from being a
 * silent swallow, and if it appears repeatedly, something is broken and the
 * evidence is already written down.
 *
 * `uncaughtException` IS DELIBERATELY NOT HANDLED. A thrown exception that
 * nothing caught means the process is in a state nobody reasoned about, and the
 * correct response to that is to let it die and let systemd start a clean one.
 */
process.on('unhandledRejection', (reason: unknown) => {
  log('error', 'unhandled rejection', { error: reason instanceof Error ? reason : String(reason) })
})

/**
 * Shut the gateway down before exiting.
 *
 * SIGTERM IS WHAT `systemctl restart` SENDS and SIGINT is Ctrl-C in a terminal;
 * both mean the same thing here. Closing the websocket deliberately tells
 * Discord the session is over, rather than leaving it to notice the missed
 * heartbeats — which is the difference between a restart that is invisible and
 * one that leaves the bot appearing online for a minute after it stopped
 * reading anything.
 *
 * A SECOND SIGNAL EXITS IMMEDIATELY. If the close is stuck on a network that is
 * already gone, an operator pressing Ctrl-C twice means it, and the alternative
 * is waiting out systemd's stop timeout for a SIGKILL that does the same thing
 * less politely.
 */
let stopping = false

function stop(signal: NodeJS.Signals): void {
  if (stopping) {
    log('warn', 'second signal while shutting down, exiting now', { signal })
    process.exit(1)
  }

  stopping = true
  log('info', 'shutting down', { signal })

  void client
    .destroy()
    .catch((error: unknown) => {
      log('error', 'gateway did not close cleanly', { error })
    })
    .finally(() => {
      // Exiting explicitly rather than letting the event loop drain, because a
      // pending REST request or a reconnect timer would hold the process open
      // for as long as it felt like and turn a restart into a stop timeout.
      process.exit(0)
    })
}

// Installed before the login rather than after it, so a SIGTERM that arrives
// during a slow or failing connect is handled instead of killing the process
// with the gateway half open.
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

try {
  await client.login(config.discordToken)
} catch (error) {
  // A rejected login is a bad or revoked token, or a Discord that cannot be
  // reached at all. Neither is recoverable by trying harder in-process: exit
  // non-zero and let systemd's restart policy decide how often to retry.
  log('error', 'login failed', { error })
  process.exit(1)
}
