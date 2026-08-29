import { createClient } from './client.ts'
import { loadConfig, type Config } from './config.ts'
import { log } from './log.ts'

/**
 * The entrypoint, and the only file that owns the process.
 *
 * FOUR THINGS HAPPEN HERE AND NOTHING ELSE DOES: read the config, build the
 * client, arrange to die cleanly, log in. Everything about what the bot
 * actually does lives in client.ts, which is why that file can be tested and
 * this one cannot — this is where the token, the signals and `process.exit`
 * are, and each of those is a thing a test would have to fake in order to
 * observe nothing interesting.
 *
 * THIS RUNS UNDER systemd, and every decision below follows from that. It is
 * started with the environment already populated from an `EnvironmentFile`, it
 * is stopped with SIGTERM, its stdout and stderr are the journal, and a
 * non-zero exit is a restart. See docs/deploy.md.
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
