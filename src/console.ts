/* ------------------------------------------------------------------ *
 * WHERE THE RINGMASTER CONSOLE LIVES, FOR A HUMAN.
 * ------------------------------------------------------------------ */

/**
 * The console's public origin, so a licence or a case can be a button.
 *
 * A MODULE CONSTANT AND DELIBERATELY NOT IN `Config`, WHICH IS THE CALL
 * `REPO_URL` IN src/client.ts ALREADY MADE and this follows without argument.
 * Everything in config.ts is a thing that DIFFERS between deployments and that
 * an operator has to supply — a token, a guild, four channel ids — and every one
 * of them is a thing they can get wrong. This is not one of those: there is one
 * Ringmaster console, it is the console that owns the very rows these links are
 * built from, and there is no deployment for which a different value would be
 * right. Making it an environment variable would buy nothing and would
 * introduce a failure the feature cannot otherwise have — a button on a
 * moderation post that opens somebody else's console, which reads as
 * authoritative and is not.
 *
 * IT IS EVEN MORE CLEARLY NOT CONFIG THAN THE REPO URL WAS. A wrong repo link
 * shows an operator the wrong commit; a wrong console link invites an admin to
 * act on a player record that is not this server's.
 *
 * IT IS IN ITS OWN MODULE BECAUSE THERE ARE TWO CALLERS. `/profile` builds
 * `…/players/<licence>` (src/commands/profile.ts) and the incident record builds
 * `…/incidents/<id>` (src/incidents.ts). It lived in the first of those, where
 * it shipped; the second was drafted against a `BLITZ_RINGMASTER_PUBLIC_URL` of
 * its own before that draft was dropped for this module — a second answer to a
 * settled question, and one an owner would have had to set correctly or lose the
 * button. One console, one literal, one place; a second spelling of this string
 * is how a bot starts linking to two consoles.
 *
 * IT IS NOT AND MUST NEVER BE `Config.ringmasterUrl`. That one is
 * `http://127.0.0.1:3000` — the server-to-server address the kick relay
 * concatenates onto, on a port closed to the internet — and a button built from
 * it opens the CLICKER's own machine. It fails in the worst available way: it
 * looks like a working link, it can sit in a permanent moderation record, and
 * what it looks like when pressed is a console that is down.
 *
 * NO TRAILING SLASH, and each caller adds its own. Both of the console's routes
 * are Next.js dynamic segments — src/app/players/[license]/page.tsx and
 * src/app/incidents/[id]/page.tsx over there — which arrive percent-DECODED, so
 * `encodeURIComponent` at each call site and nothing at the other end is the
 * whole contract.
 */
export const CONSOLE_URL = 'https://ringmaster.blitz-royale.com'
