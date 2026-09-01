# AWS notes

**What `src/ddb.ts` talks to, what it is allowed to do, and the two things that
have to exist on the AWS side before any of it works.** This is a reference for
whoever wires the module up or debugs it from a journal; it is not a runbook and
nothing here is a step to perform in order.

Everything below was written against `fivem-ringmaster` as of 2026-08-30 —
`src/lib/dynamo.ts`, `bans.ts`, `players.ts`, `audit.ts`, `gameProfile.ts`,
`maintenance.ts` and `docs/aws-setup.md`. Where a fact comes from that repo, the
file is named, because the fact can change over there without anything failing
over here.

## The rule this module keeps

**The bot reads the console's DATA and never the console's SERVICE.** No call in
`src/ddb.ts` reaches the Ringmaster HTTP API, and the module imports the AWS SDK
and `node:crypto` and nothing else — pinned by a test that reads its own import
list. That keeps §"the rule that matters" of `docs/deploy.md` true in the one
place it would otherwise quietly stop being true: a console that is down,
redeploying or mid-migration costs the bot nothing, and the bot cannot take the
console down by asking it questions.

## Credentials: there are none, and that is the design

The SDK's default provider chain finds the EC2 instance role from instance
metadata. Nothing in this repo holds a key, and `src/config.ts` has no
AWS-credential-shaped variable to set. If you find yourself adding one, the
deployment is wrong.

**The role that chain finds today is the CONSOLE's.** `docs/deploy.md` §15 says
it plainly: the bot runs on the console's box, so the first AWS call it ever
makes arrives with `RingmasterTableAccess` — `ringmaster-*`, every action
including `DeleteItem` and `Scan`. **blitz-bot#4** is scoping the bot to an
identity of its own, and §15's instruction is to do that *before* the first AWS
call rather than after.

**That gate has been spent.** `createDdb()` is called from the client and from
the command wiring, so the bot makes AWS calls today, with the console's role,
and `RingmasterTableAccess` is the only thing standing between it and every
`ringmaster-*` table. Nothing about that is new to the ban write — it was true
of the first `GetItem` — but the ban write is the first thing the bot does that
a wrong grant could not have made harmless.

### What the bot's own policy needs, when #4 writes one

Eight tables are read; three of those are also written. There is no `DeleteItem`
and no `Scan` anywhere in this list, and the module has no code path that could
use either — its document-client interface exposes `get`, `put`, `update` and
`query` and nothing else.

| Action | Resource |
|---|---|
| `dynamodb:GetItem` | `ringmaster-bans`, `ringmaster-players`, `ringmaster-player-ids`, `ringmaster-maintenance`, `ringmaster-bot-state`, **`ringmaster-incidents`**, `br-players` |
| `dynamodb:Query` | `ringmaster-audit`, **`ringmaster-incidents` — the table AND `…/index/kind-openedAt-index`** |
| `dynamodb:PutItem` | `ringmaster-audit`, `ringmaster-bot-state`, **`ringmaster-bans`** |
| `dynamodb:UpdateItem` | `ringmaster-audit`, **`ringmaster-bans`** |

All in `us-east-2`. See the region section below before writing an ARN.

**`dynamodb:GetItem` on `ringmaster-incidents` is new in blitz-bot#19, and
nothing is missing at runtime today.** The bot shares the console's instance
role, which grants `ringmaster-*` — so this read works right now and always has.
What this row is, is a line the policy in **blitz-bot#4** will need when the bot
is scoped to an identity of its own; without it, the moderation record for a
closed incident stops posting and every pass says `denied` in the journal.

**`dynamodb:Query` on `ringmaster-incidents` is newer still, and the index ARN is
a separate resource.** The openings half of blitz-bot#19 reads
`kind-openedAt-index`, and IAM treats a table and its indexes as different
resources: a policy naming only
`arn:aws:dynamodb:us-east-2:…:table/ringmaster-incidents` allows the `GetItem`
and refuses the `Query`, and a moderation channel never mentions a filed case
again. The index ARN is that same string with `/index/kind-openedAt-index` on the
end, and **blitz-bot#4**'s policy needs both.

That refusal is an `error` in the status channel and not a `warn`, because
nothing about it gets better on the next pass — it is the bot having stopped
doing a thing it is for until a person edits a policy, which is the rule in
`src/log.ts`. The line names the resource to grant rather than only saying
`denied`, so it does not send you to a policy that already names this table:

> the bot is not allowed to Query the kind-openedAt-index index on
> ringmaster-incidents, so no record is posted when a case is filed —
> dynamodb:Query has to be granted on the table arn AND on that arn with
> /index/kind-openedAt-index on the end, which IAM treats as a separate resource
Nothing is missing at runtime today, for the reason above: the shared instance
role grants `ringmaster-*`.

**They are reads and they must stay reads.** The bot learns an incident id from an
`incident.resolve` audit row or from that index, and asks for that one case; the
console's own module scans this table for its queue and says in its comment what
that costs. There is no `PutItem` and no `UpdateItem` here and there should never
be: closing a case is the console's decision, and a bot that could write this
table could close one nobody closed.

**The two bold entries are new in blitz-bot#16 and they widen the bot's AWS
grant.** Not the grant it *runs* with — that has been `ringmaster-*` with every
action on it since the first call, and this changes nothing about what the bot
is technically able to do today. What widens is the grant it will need when
**blitz-bot#4** scopes the bot to an IAM user of its own: that policy now has to
allow writing to the moderation table, which is the most consequential table in
the stack, and it will not be possible to give the bot a read-only posture on
`ringmaster-bans` and keep `/ban` working. Anyone reviewing #4 should treat
these two rows as the decision, not as a detail of it.

**`dynamodb:DeleteItem` on `ringmaster-bans` is not on this list and must never
be added.** A ban is a record; lifting one stamps fields onto the row and keeps
it. See below.

### `br-players` is denied by the role the bot has today

`fivem-ringmaster/docs/aws-setup.md` §2 flags this against the console and it
applies unchanged to the bot: `RingmasterTableAccess` grants `ringmaster-*`,
`br-players` does not match it, and the console's doc **deliberately does not
paste the fix into its JSON** — "IAM here is administered by hand, and a
document that silently widens a policy to match today's code is a document that
widens it again next time without anyone deciding to."

So unless somebody has added that statement by hand since, `gamePlayers.profile`
returns `{ kind: 'denied' }` and every other read works. That is the correct
failure and it is worth recognising on sight rather than debugging: it is one
table, not the region and not the credentials.

## The region

**The tables are in `us-east-2`.** `fivem-ringmaster/docs/aws-setup.md` says so
in its own header table, co-located with the game server as the higher-volume
writer.

**The box's region is a separate fact and the two repos disagree about it.**
That console doc calls the Ringmaster instance `us-west-2`; this repo's
`docs/deploy.md` calls the box `us-east-2`. One of them is stale — this note
does not try to settle which, because the module is written so that it does not
matter.

`src/ddb.ts` passes a region to the client explicitly, defaults it to
`us-east-2`, and never reads `AWS_REGION` from the environment itself. Left
implicit, the SDK resolves a region from the environment and then from instance
metadata — **the box's** — and a mismatch fails every call with
`ResourceNotFoundException` against tables that plainly exist. That error reads
as a missing table and sends you to check spelling, then IAM, then the table
list, long before it occurs to you to check the region. `no-such-table` is a
failure kind of its own for exactly this reason.

## Tables

Names are derived from a prefix and never written as literals, the way
`fivem-ringmaster/src/lib/dynamo.ts` derives its ten: one variable stands up a
second environment, and a literal left behind is a staging bot writing into
production. Console tables come from `DDB_TABLE_PREFIX` (`ringmaster-`), the
game's from `DDB_GAME_TABLE_PREFIX` (`br-`).

| Table | Key | Bot | Shape from |
|---|---|---|---|
| `ringmaster-bans` | `license` (S) | read **and write** | `lib/bans.ts` |
| `ringmaster-players` | `license` (S) | read | `lib/players.ts` |
| `ringmaster-player-ids` | `id` (S) | read | `lib/players.ts` |
| `ringmaster-maintenance` | `id` (S), one row, `id = "current"` | read | `lib/maintenance.ts` |
| `ringmaster-audit` | `pk` (S) + `ts` (N) | read **and write** | `lib/audit.ts` |
| `ringmaster-bot-state` | `id` (S) | read **and write** | this repo |
| `ringmaster-incidents` | `incidentId` (S), GSI `kind-openedAt-index` | read | `lib/incidents.ts` |
| `br-players` | `pk` (S) + `sk` (S), `sk = "profile"` | read | `lib/gameProfile.ts` |

Three of those are worth reading twice.

**`br-players` is composite-keyed and the console's tables are not.** The game
hangs several rows off one partition — `profile`, `purchases`, one `match#…` per
match. A `GetItem` with the wrong key shape returns no row rather than an error,
which reads as "this player has never played".

**`ringmaster-incidents` is keyed on `incidentId` and on nothing else**, which is
what makes the bot's point read of it a `GetItem` rather than a Scan. Every other
question about that table — the queue, the count, a player's cases — is a Scan on
the console's side, and this repo asks none of them: for a closure, the audit log
hands it the id of the one case it wants.

**And for an opening there is no audit row to hand it anything**, which is the
whole reason the index below exists. The game writes incidents straight into this
table through `br_ddb`, the game box has no access to `ringmaster-audit` at all,
and the console's `/api/ingest` doorbell persists nothing — so nothing anywhere
records that a case was *opened*. See `createIncidentOpenLog` in
`src/incidents.ts`.

### `kind-openedAt-index`, and it is created by hand

| | |
|---|---|
| Table | `ringmaster-incidents` |
| Partition key | `kind` (S) |
| Sort key | `openedAt` (N) |
| Projection | `KEYS_ONLY` |

```bash
aws dynamodb update-table \
  --region us-east-2 \
  --table-name ringmaster-incidents \
  --attribute-definitions \
      AttributeName=kind,AttributeType=S \
      AttributeName=openedAt,AttributeType=N \
  --global-secondary-index-updates '[{"Create":{
      "IndexName":"kind-openedAt-index",
      "KeySchema":[
        {"AttributeName":"kind","KeyType":"HASH"},
        {"AttributeName":"openedAt","KeyType":"RANGE"}],
      "Projection":{"ProjectionType":"KEYS_ONLY"}}}]'
```

**The symptom of its absence is one line, and the line names it.** A `Query`
against an index a table does not carry fails with a `ValidationException`, which
without help lands in the same bucket as a timeout — so the bot classifies it as
`no-such-index` and says, at `error` in the status channel:

> the kind-openedAt-index index on ringmaster-incidents does not exist, so no
> record is posted when a case is filed

Nothing else about the bot changes while it is missing: closures are still posted,
because that half reads the audit log. Nothing is skipped either — the poller
never moves its cursor over a failed or an empty read, so every case filed between
this shipping and the index going live is posted once the index is there.

**And for the first minutes after you run that command it says something else,
which is the point.** AWS refuses reads of a global secondary index while it
backfills, with the *same* `ValidationException` — the message is `Cannot read
from backfilling global secondary index: kind-openedAt-index`. That is not the
index missing, so it does not get the sentence above; it is an `info` line in the
journal only, and nothing reaches the status channel:

> the kind-openedAt-index index on ringmaster-incidents is still filling, so
> records for filed cases start once it is ready

Nobody needs to do anything about it. Wait, and records start appearing; nothing
filed in the meantime is lost, for the cursor reason above. `OnlineIndexPercentage
Progress` in CloudWatch is where the backfill's progress actually is, if you want
a number.

**`KEYS_ONLY` is deliberate and costs a `GetItem` per case.** The index cannot
carry `subjectName`, `category`, `state` or `verdict`, so nothing on it is
renderable and the case is read through the same ten-attribute projection either
way. `ALL` would put the evidence, the match timeline and the reporter's name in a
second copy of every row, in an index a bot reads on a timer.

**`kind` is the partition key, and that is the sharp edge.** A `Query` addresses
one partition, so the bot makes one call per kind it knows about and learns
nothing at all about a kind it does not name — no error, not even an empty page.
`INCIDENT_KINDS` in `src/incidents.ts` is that list, typed so a fourth kind is a
compile error, and the resolved poller (which finds cases by id and therefore sees
every kind) raises an `error` if it ever meets one the index list does not cover.

The two GSIs the console's own comment names — `state` for the queue,
`subjectLicense` for the profile — are still not created and this repo still needs
neither.

**`ringmaster-bot-state` exists on the live box** and was created by hand. The
bot will not create it for you, so a second environment needs this. The symptom
of its absence is `no-such-table` on every state read and write.

**THE PARTITION KEY IS `id`, AND THAT IS NOT A DETAIL.** This document said
`key` until the code and the table disagreed in production: every read and
write answered "The provided key element does not match the schema", which
silently disabled the deploy notice's memory, the audit cursor and the ban-role
tag book at once. The code was corrected and this document was not, so anybody
standing a second environment up from it would have rebuilt the same outage at
the create-table step below.

```bash
aws dynamodb create-table \
  --region us-east-2 \
  --table-name ringmaster-bot-state \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

It carries `{ id, value, updatedAt }` — the handful of things the bot has to
remember across a restart and currently keeps in files under
`/var/lib/blitz-bot`, which survive a restart and do not survive the box.

**Why it is under the console's prefix rather than a third one of its own.** A
prefix marks a stack, and this table belongs to the same stack as everything
above it, so one variable still stands up a whole second environment. The
argument for splitting — that a prefix is also an IAM boundary — does not bite
while the bot shares the console's role and therefore has exactly the console's
access anyway; and when #4 writes the bot a policy, that policy names tables one
at a time (see the table above) and does not need a prefix to express "this one
is the bot's". The cost, stated so it is a decision and not an accident: the
console's `ringmaster-*` grant covers this table, so the console *can* write the
bot's state. It has no reason to and no code that does.

## The bot writes bans now

**A ban is a record, not a deletion.** That is `fivem-ringmaster/src/lib/bans.ts`'s
own rule and it is why this document lists `PutItem` and `UpdateItem` on
`ringmaster-bans` and no `DeleteItem`. Lifting a ban stamps `liftedAt`,
`liftedBy`, `liftedByName` and `liftReason` onto the row and leaves it exactly
where it was, because the question an admin asks six months later is "has this
person been banned before, and who let them back in", which a table that deletes
on lift cannot answer at all.

**The bot's write is not the console's, and the difference is the reason it was
written by hand rather than copied.** The console's `bans.issue` is an
unconditional `PutItem` of a complete row, including `liftedAt: null` — correct
for a web app, where a human clicked once and re-banning somebody previously
lifted *should* replace the record. The bot writes from Discord events, and a
gateway reconnect can redeliver one. The same unconditional put, on the second
delivery, would replace a row an admin had **deliberately lifted** in between:
somebody back under a ban nobody re-issued, the record of who let them back in
gone, and no way to tell from the write that anything happened, because a
`PutItem` that overwrites reports exactly what one that creates reports.

**So the bot reads first and its write is conditional.** In order:

1. **The Discord audit log entry id on the row.** If it matches the event being
   processed, this event has already been acted on and nothing is written —
   *whatever state the row is in now*. That ordering is the whole protection: a
   replay arriving after an admin lifted the ban finds a lifted row, and a check
   asking "is this person banned" would answer no and re-ban them.
2. **`isBanActive`** — the rule copied verbatim from the console, so the bot,
   the console and the connect gate cannot disagree about what banned means. An
   active ban already standing means nothing is written, and the ban that stands
   is reported instead.
3. **A condition on the row that was read** (`at = :seenAt`, or
   `attribute_not_exists(license)` when there was no row). Anything landing in
   the gap between the read and the write — a console re-ban, a second bot
   process — fails the condition, and the caller gets a `conflict` with nothing
   written rather than an overwrite of somebody else's decision.

**What the entry id costs, so it is not described as more than it is.** It lives
on the ban row, so the memory lasts exactly as long as that row does: a full-row
overwrite — the console re-banning, or the bot issuing a later ban — replaces the
attribute, and a replay arriving after that looks like a new event. Replays
arrive seconds after the original and overwrites are human-paced, so in practice
it is there when it matters. It is a bounded memory, not a ledger. Making it a
ledger means either a GSI on the entry id (an index on a table another repo owns,
that the bot's role cannot create, for a lookup the bot does not need — the row
it is about to write is the only one it ever asks about) or a claim row per entry
id in `ringmaster-bot-state` (a real ledger, but a second write that fails on its
own and leaves a claim with no ban or a ban with no claim, and it needs an expiry
story). Neither is worth it yet; both are written down so the next person does
not have to rediscover the choice.

**Lift has no entry id, and the one replay it cannot catch is named in the
code**: an unban redelivered *after* somebody re-banned the same person. It needs
a re-ban inside the seconds-wide redelivery window to happen at all. Every
ordinary replay is caught by the row already being lifted, which the bot leaves
completely alone — writing the lift again would replace the first lifter's name
with the second's.

**A `discord:`-keyed ban is a record and not a door.** The table is keyed on a
qualified identifier, so banning a Discord account with no player record writes a
row keyed `discord:280…` in the same place a `license:…` goes; it is listed by
the console's moderation page and kept like any other. But
`fivem-ringmaster/docs/aws-setup.md` is explicit that `br_ddb`'s connect gate is
one `GetItem` on the connecting player's **license**, so that row does not stop
anybody joining. Two reasons not to "fix" that by widening the gate: FiveM only
reports a `discord:` identifier when the player has Discord's activity
integration switched on, which is opt-in and therefore evadable by switching it
off (the same doc says so about the grants table); and the console's ban list
links each row to `/players/<key>`, which for one of these resolves to nothing.
Pass a `playerName` so the list reads as a person rather than as a snowflake.

## The audit log has two writers now

**This and the section above it are the two things in this document that are
hazards rather than settings.**

Every row in `ringmaster-audit` is `pk = 'AUDIT'` with a millisecond `ts` as its
sort key. Those two together are the whole primary key, so a `PutItem` at a key
that already exists **replaces** the row that was there — silently, on a log
whose entire job is that a record cannot go missing.

`fivem-ringmaster/src/lib/audit.ts` handles this with a per-process counter that
pushes a same-millisecond write forward by one, and its own comment is explicit
about the limit: *"THIS IS PER PROCESS AND CANNOT BE ANYTHING ELSE. Two consoles
writing in the same millisecond still collide."* The bot is not a second console,
but it is a second process, writing to that partition from the same box.

**What the bot does about it.** Its audit put is conditional —
`attribute_not_exists(pk)`, "create, do not replace". A taken millisecond is
refused by DynamoDB rather than overwritten; the bot's counter steps forward and
retries, up to four times, and then gives up with a `conflict` failure. Since an
audit failure means the action must not proceed, that is where it ends. **The bot
therefore cannot destroy an audit row — not the console's, and not its own.**

Its `resolve` is conditional too, on the `commandId` it minted rather than on the
row merely existing. That stops two different things: stamping an outcome onto a
row that replaced ours, and `UpdateItem`'s upsert quietly creating a half-row
that holds an outcome and no action.

**What is still open, because it cannot be closed from this repo.** The console's
put is unconditional, so a console write landing on a millisecond the bot has
already taken still overwrites the bot's row. The fix is one line in
`fivem-ringmaster/src/lib/audit.ts` — the same `attribute_not_exists(pk)`
condition on its put, with the forward retry its counter already implies. Until
somebody makes that change, the remaining exposure is one direction only, needs
both processes writing inside the same millisecond, and shows up afterwards as a
`conflict` from the bot's `resolve` — an intent row that went missing, with the
command id it belonged to.

## The SDK version

`@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` are declared at
`^3.700.0`, which is the range `fivem-ringmaster/package.json` declares. Matching
it is deliberate: the two processes run on one box against one set of tables, and
a marshalling question ought to have one answer rather than two. `package-lock.
json` is what actually pins the version installed, as it does for the console.
