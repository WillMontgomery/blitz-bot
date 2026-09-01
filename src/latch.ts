import { allClear, log, type Fault } from './log.ts'

/**
 * A fault that only a person can clear, said ONCE and said again when it goes.
 *
 * ═══ THE PROBLEM THIS IS FOR, IN THE OWNER'S WORDS ═══
 *
 * #bot-status was a wall of one sentence, every half minute, for forty minutes,
 * because the openings poller reads a hand-created index that did not exist yet
 * and said so on every pass. `statusReporter`'s folding was working perfectly —
 * one message, "seen 10 times, last …" — and a five-minute window means a
 * repeating fault still produces a FRESH message twelve times an hour, forever,
 * which is what that window is deliberately for. The message was right. The
 * delivery was wrong.
 *
 * ═══ THE DISTINCTION THIS WHOLE FILE RESTS ON: PERMANENT AGAINST TRANSIENT ═══
 *
 * FOR A TRANSIENT FAULT, REPETITION IS THE INFORMATION. A read that failed twice
 * is worse than a read that failed once, and a run of them is a different fact
 * from one of them — that is why `blind` in src/maintenance.ts counts to four
 * before it says anything, and why the generic "could not read the incident
 * index" line is per-pass. Silencing those would throw away the only signal they
 * carry. Nothing transient may be latched.
 *
 * FOR A PERMANENT ONE, REPETITION IS NOISE AND WORSE THAN NOISE. A missing
 * index, a denied IAM policy, a channel this bot cannot post in: none of them
 * change until somebody changes them, so the second line says exactly what the
 * first said and the four hundredth buries every other fault in the one channel
 * where faults are visible. The owner has no CLI path by design — a status
 * channel nobody can read IS the outage.
 *
 * ═══ THE TEST FOR "PERMANENT", WHICH IS NARROWER THAN IT SOUNDS ═══
 *
 * TWO CONDITIONS, BOTH REQUIRED. First: nothing but a person acting outside this
 * process can end it — creating an index, editing a policy, fixing an id, moving
 * a role. Second, and the one that is easy to miss: EVERY REPEAT CARRIES THE
 * SAME FIELDS. A line whose repeat carries a new value — which ban went
 * unmarked, which row held the unplaceable stamp — is not a repeat of one
 * condition; it is a new occurrence, and its fields are evidence the journal has
 * to keep. src/auditpoll.ts says this about its own bad-sort-key line in as many
 * words: "`ts` IS ON THE LINE BECAUSE THE VALUE IS THE WHOLE DIAGNOSIS". Latch
 * the first kind. Never the second.
 *
 * ═══ WHAT IS SUPPRESSED IS THE WHOLE LINE, JOURNAL INCLUDED ═══
 *
 * THE ALTERNATIVE WAS TO DEMOTE THE REPEAT TO `info` — journal keeps everything,
 * channel gets one — AND IT IS THE WRONG TRADE. A real error would then sit at
 * `info` on the box, so `journalctl -u blitz-bot -p err` would show one line for
 * a fault that has been true for a week, and the level of a line would stop
 * meaning what src/log.ts says it means. An error that is real stays an error;
 * it just stops repeating. What is lost is a per-pass tick that says nothing the
 * first line did not, and the pair of lines this leaves in the journal — the
 * fault and its all-clear — brackets the outage more exactly than the ticks did.
 *
 * ═══ ONE INSTANCE PER CONDITION, HELD BY THE CODE THAT OBSERVES IT ═══
 *
 * A LATCH IS A SLOT, NOT A REGISTRY. The thing that can say "this is happening"
 * is the same thing that can say "it is not", and that is always one function
 * with the answer in its hand — the poll that just read the index, the announcer
 * that just fetched the channel. So the caller builds a latch per condition and
 * both halves are two lines apart, rather than a global keyed map where nothing
 * says which key is ever cleared. Faults in different slots are independent by
 * construction: a channel that cannot be posted to has nothing to do with an
 * index that does not exist, and one being latched must never silence the other.
 */

/** What a latched condition says, in both directions. */
export interface Held {
  /**
   * `Fault` AND NOT `Level`. A latched condition is by definition one that needs
   * a person, so `info` is not a thing to latch — it would be a line nobody sees
   * being suppressed to save a channel it never reaches.
   */
  readonly level: Fault

  /**
   * The fault sentence. THIS IS ALSO THE CONDITION'S IDENTITY inside the slot;
   * see `fault`.
   */
  readonly msg: string

  /**
   * What is said, once, when the condition stops. `allClear`, so `info` in the
   * journal and still delivered to the channel — see src/log.ts.
   *
   * REQUIRED, RATHER THAN DERIVED FROM `msg` OR OPTIONAL. A generic "no longer
   * true: <the fault sentence>" reads as a riddle in a channel, and an optional
   * one would make the silent-forever latch the easy thing to write — which is
   * the failure this file exists to prevent, not one to leave a door open for.
   * Declaring a fault permanent means writing the sentence that says it ended.
   */
  readonly cleared: string

  readonly fields?: Record<string, unknown>
}

export interface Latch {
  /** The condition is happening right now. */
  fault(held: Held): void

  /** It is not. Says so exactly once, and only if it was. */
  clear(): void
}

/**
 * How long a still-unfixed condition stays silent before it says itself again.
 *
 * ═══ IT RE-SAYS ITSELF, AND THE ARGUMENT FOR THAT IS THE ARGUMENT AGAINST A
 * PURE LATCH ═══
 *
 * A LINE SAID ONCE AND NEVER AGAIN SCROLLS AWAY. #bot-status also carries deploy
 * notices, gateway warnings and every other fault; a single error from three
 * weeks ago is not in the channel any more in any sense that matters, and the
 * feature it was about has been dead the whole time with nothing saying so. That
 * is a worse failure than the wall of text, because it is silent.
 *
 * TWENTY-FOUR HOURS, AND THE UNIT IS DELIBERATELY A DAY OF THE OWNER'S ATTENTION
 * RATHER THAN A MULTIPLE OF `POLL_MS`. The poll interval is what made this a
 * problem and has nothing to do with what fixes it: the number that matters is
 * how long a broken feature may go unmentioned, and the honest answer is "not
 * more than a day". An hour would be twenty-four lines a day about something he
 * already knows and may be deliberately waiting on — an index backfilling across
 * a large table, an IAM change he has to schedule — which is the original disease
 * at a slower rate. A week would let "the bot has been broken for six days and
 * said nothing" be true.
 *
 * A RESTATEMENT IS THE SAME SENTENCE AT THE SAME LEVEL. It is the same fault and
 * it is still true, so a second wording would be a second thing to keep correct
 * and a reader would have to work out whether it was a new problem. What it adds
 * is one field, `since`, which is the whole difference between "this just broke"
 * and "this broke last Tuesday" — and a field is where this repo puts a value
 * the sentence cannot carry.
 */
export const RESTATE_MS = 24 * 60 * 60 * 1000

/**
 * One condition's latch.
 *
 * `now` IS INJECTED FOR THE SAME REASON EVERY CLOCK IN THIS REPO IS: `RESTATE_MS`
 * is a day, and a test that could only prove the restatement by waiting one is a
 * test nobody would write.
 */
export function latch(now: () => number = Date.now): Latch {
  /**
   * IN MEMORY, AND DELIBERATELY NOT IN `ringmaster-bot-state`.
   *
   * ═══ THE DURABLE STORE IS THE THING THAT IS BROKEN ═══
   *
   * The first two conditions wired to this are "DynamoDB does not have this
   * index" and "IAM refuses this Query", and the only durable store this bot has
   * is DynamoDB. A latch that has to write to the failing service in order to
   * remember that the service is failing does not work in the one case it was
   * built for — and a failed latch write is itself a fault, so the mechanism for
   * quieting the channel would be a new way to fill it.
   *
   * ═══ A RESTART IS NOT A REPEAT, IT IS NEW INFORMATION ═══
   *
   * This process restarts on every deploy and, under `Restart=always`, five
   * seconds after every crash. In memory, that means one line per restart for a
   * long-standing condition, and that line is an answer to the question the owner
   * is actually asking at that moment: he has just pushed, and "still no index"
   * is what he needs to know. The rate is bounded by how often HE deploys, which
   * is his own action — not by a thirty-second clock, which is nobody's.
   *
   * ═══ AND THE DURABLE VERSION FAILS WORSE THAN THE IN-MEMORY ONE ═══
   *
   * A latch row that survives a restart also survives a FIX made while the bot
   * was down. The condition is gone, the row still says it is held, and the
   * all-clear — the half of this that tells him his fix worked — never fires. The
   * in-memory version's worst case is one extra line per deploy; the durable
   * version's worst case is the silence this feature exists to remove, plus a
   * schema, an eviction rule and a migration. src/auditpoll.ts's `firstStart` is
   * per-process and not durable for the same shape of reason, and
   * `announceDeployedCommit` is durable for the opposite one — a restart on the
   * same commit must say nothing, and there the state is the commit itself.
   */
  let held: { msg: string; cleared: string; since: number; said: number } | null = null

  return {
    fault(next) {
      const at = now()

      /**
       * THE IDENTITY IS THE SENTENCE, NOT THE SENTENCE AND THE LEVEL. Within one
       * slot the message IS the condition — "the index does not exist" and "the
       * Query is denied" are two different states of one read — and the level is
       * the call site's judgement about urgency, which can honestly differ
       * between two places that observe the same condition. Keying on both would
       * make one condition reported at `warn` in one place and `error` in another
       * post twice for one fault.
       */
      if (held !== null && held.msg === next.msg) {
        if (at - held.said < RESTATE_MS) return

        held.said = at
        log(next.level, next.msg, { ...next.fields, since: new Date(held.since).toISOString() })
        return
      }

      /**
       * A DIFFERENT SENTENCE REPLACES THE HELD ONE AND THE OLD ONE GETS NO
       * ALL-CLEAR, WHICH IS THE ONE PLACE THIS COULD EASILY LIE. Going from "the
       * index does not exist" to "the Query is denied" means the index now
       * exists — but the read still does not work, and posting "the index answers
       * now, so a record is posted when a case is filed" beside a fresh error
       * saying nothing is posted would be false and would be the more reassuring
       * of the two. An all-clear is said only when the condition was OBSERVED to
       * stop, which is `clear` and nothing else.
       */
      held = { msg: next.msg, cleared: next.cleared, since: at, said: at }
      log(next.level, next.msg, next.fields)
    },

    clear() {
      /**
       * SILENT WHEN NOTHING WAS HELD, WHICH IS THE COMMON CASE AND HAS TO BE FREE.
       * A healthy bot calls this on every successful pass — twice a minute,
       * forever — and an all-clear for a fault that never happened would be the
       * original problem rebuilt out of good news.
       */
      if (held === null) return

      const was = held

      // Cleared BEFORE the line is written, not after. `allClear` reaches the
      // sink, the sink is `statusReporter`, and a fault raised on that path
      // arriving back here must find a latch that is already open rather than
      // one still holding a condition that has ended.
      held = null

      allClear(was.cleared, { since: new Date(was.since).toISOString() })
    },
  }
}
