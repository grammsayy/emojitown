# emojitown seasonal bot

A Discord bot for the emojitown server with four seasonal activities:

- **❄️ Snowball Fights**: `/collect` snowballs and `/throw` them at friends.
- **🎃 Trick or Treat**: Halloween visitors appear in chat; answer with Trick or Treat to collect 120 emojitown items and compete for the Champion role.
- **🎄 Advent Calendar**: a door to open every day from December 1 to 24.
- **🍬 Candy Counter**: a persistent balance of participation rewards.

This implements the *emojitown seasonal Discord bot, product specification v1*. The snowball rules match
[aka-pal/snowsgiving-bot](https://github.com/aka-pal/snowsgiving-bot) (30-second collect cooldown, 120-second
warm-up after a hit, one snowball per throw, 50% hit chance), with the defects listed in the spec corrected.
No source code was copied from that project; its gameplay rules were re-implemented from scratch, so its GPL-3.0
license does not apply here. Credit for the original mechanics goes to its authors.

## Running it

Requirements: Node.js 22.13 or newer (Node 24 LTS recommended). Data is stored in a single SQLite file using Node's
built-in `node:sqlite`, so nothing needs compiling and no C++ build tools are required. Node prints a one-line
`ExperimentalWarning` about SQLite at startup; it is harmless.

1. **Create the application** at <https://discord.com/developers/applications>.
   - Under **Bot**, copy the token and enable the **Server Members Intent** (privileged). It is used to notice members
     leaving or rejoining, and to manage the Champion role. The **Message Content Intent** is *not* needed.
2. **Invite the bot** with the `bot` and `applications.commands` scopes and these permissions:
   View Channel, Send Messages, Embed Links, Attach Files, Read Message History and Manage Roles (only needed for the
   Champion role). Permissions integer: `268553216`.
   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=268553216
   ```
   The bot does **not** need Administrator. In Server Settings → Roles, place the bot's role **above** the Champion role.
3. **Configure** the environment (see `.env.example`): `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DATABASE_PATH`
   (on persistent storage).
4. **Install, register commands, start:**
   ```sh
   npm ci
   npm run build
   node --env-file=.env dist/scripts/deploy-commands.js   # once, and after command changes
   node --env-file=.env dist/src/index.js
   ```
   With `DEV_GUILD_ID` set, commands register to that one server instantly; otherwise globally (up to an hour).

Docker: `docker build -t emojitown-bot .` then run with the env vars and a volume mounted at `/data`.
Register commands with `docker run --rm --env-file .env emojitown-bot node dist/scripts/deploy-commands.js`.

Development: `npm test` (Vitest), `npm run typecheck`, `npm run dev` (runs from source with tsx).

## Command access

| Command | Who sees it on Discord | Who the bot lets through |
| --- | --- | --- |
| Member commands (`/collect`, `/halloween inventory`, `/advent open`, `/candy balance`, …) | Everyone | Everyone |
| `/admin …` (setup, events, corrections, candy adjustments, content import/export) | Members with **Manage Server** | Server owner and **Manage Server** only |
| `/staff …` (pause/resume, exclusions, previews, cancel visitor, reconcile, Advent post, candy inspect) | Members with **Manage Server** by default | Administrators and the configured **Event Manager** role(s) |

Discord can only restrict whole top-level commands, not individual subcommands, so all staff actions live under
`/admin` and `/staff`. Both are hidden from regular members by default. The bot also checks permissions on every
command, button and form itself, so overriding Discord's command settings never grants more access than this table.

**One manual step:** so Event Managers can see `/staff`, open **Server Settings → Integrations → emojitown → /staff**
and add the Event Manager role. (Bots cannot change these command settings themselves.)

Role safety: the Halloween Champion role must be a dedicated role with no moderation permissions, held by at most one
member, and must not be `@everyone` or an Event Manager role, because the bot removes it from everyone except the winner.
`@everyone` cannot be made an Event Manager role.

## First-time setup in Discord

Follow section 11 of the spec. In short:

1. `/admin season setup timezone:Europe/Copenhagen support:#help log_channel:#staff-log event_manager_role:@Event Manager`
2. `/admin season channel feature:snowball action:add channel:#snowball-fight` (also `halloween` and `advent`)
3. `/admin event create feature:halloween name:Halloween 2026` (also snowball and advent). Default dates are filled in;
   adjust them with `/admin event schedule`, which opens a form and can turn on automatic start.
4. Import content: `/admin season content feature:halloween action:import file:<pack.json>` (and `snowball`). Start from
   `/admin season content … action:export` to get the current pack as a template.
5. `/admin halloween champion role:@Halloween Champion end_policy:keep`, and optionally `/admin candy setup`, `/admin halloween setup`, `/admin advent setup`.
6. Fill the 24 doors with `/admin advent edit day:<n> event:advent-2026` (form), then `/staff advent validate` and `/admin advent publish`.
7. Give the Event Manager role access to `/staff` (see **Command access** above).
8. `/admin season check`, preview with `/staff snowball preview`, `/staff halloween preview` and `/staff advent preview`, then `/admin season announce`
   and `/admin event start` (or let scheduled events start themselves).

## How it works

```
src/
  domain/      Game rules. No Discord imports; uses an injected clock and random source.
    events.ts, lifecycle.ts   Event records; draft → scheduled → active ⇄ paused → ended
    snowball.ts               Collect/throw/stats/leaderboard/corrections
    halloween.ts, champion.ts Spawning, claims, collections, Champion calculation
    advent.ts                 Door times, claims, validation, announcements
    candy.ts                  Ledger with idempotency keys; balances never go negative
    members.ts, audit.ts, content.ts, confirmations.ts, config.ts
  discord/     Commands, the interaction router, handlers, role sync, scheduler
  content/     Built-in placeholder content (4+4 snowball messages; 40 visitors × 3 items)
  db/          SQLite schema and migrations
test/          Domain tests for the acceptance criteria, plus end-to-end flows through a fake Discord
```

Reliability notes:

- **Exactly-once rewards.** Every throw, visitor claim and Advent claim runs in one SQLite transaction together with
  its candy. Candy transactions carry a unique idempotency key, so reprocessing never credits twice.
- **One winner per visitor.** The winning claim is a conditional update (`status = 'open' AND expires_at > now`).
  Simultaneous answers cannot both succeed.
- **Restarts.** Cooldowns, warm-ups, spawn timers, claims and event state are all in the database. A scheduler tick
  (every 15 s) expires stale visitors without rewards, skips missed spawns, posts **one** Advent recovery message
  for missed announcements, finalizes events that ended during downtime (once), and retries failed role changes and
  visitor-message updates.
- **Servers are isolated.** Every record is keyed by server, event and member.
- **Message text is never stored.** Only the time of the last human message per Halloween channel is kept, to decide
  where visitors appear.

## Content packs

Snowball pack (`/admin season content feature:snowball`):

```json
{
  "images": { "collect": "https://…/collect.png", "hit": "https://…/hit.png", "miss": "https://…/miss.png" },
  "hit": ["{thrower} hit {target}!", "…at least four…"],
  "miss": ["{thrower} missed {target}!", "…at least four…"],
  "collect": "You now have **{count}** snowball{s}.",
  "cooldown": "You can collect again {when}.",
  "warmup": "You're warming up. Collect again {when}; you can still throw.",
  "noSnowballs": "Use /collect first."
}
```

Halloween pack: `visitors` is a list of `{ id, name, image?, trickRequest?, treatRequest?, items: [3 items] }`, where each
item is `{ id, name, rarity: "common" | "uncommon" | "rare", description, image? }` with exactly one of each rarity, and
`messages` holds `trickRequest, treatRequest, win, duplicate, wrong, expired, cancelled` (placeholders `{name}`,
`{winner}`, `{item}`, `{rarity}`). IDs are stable: an import may rename things but may not remove an ID used by the
current pack. Running events keep the pack version they started with.

The built-in content is placeholder text so the bot works out of the box. Replace it with the final emojitown
names, artwork and wording before launch (spec section 13).

## Decisions where the spec left room

- **Forms.** `/admin event schedule` and `/admin advent edit` open Discord forms. Discord forms hold at most five fields,
  so `/admin advent edit` takes `candy` and `reason` as command options. The other setup commands (`/admin season setup`,
  `/admin halloween setup`, `/admin advent setup`, `/admin snowball setup`, `/admin candy setup`) use command options as their guided
  interface and show the saved result and remaining tasks.
- **Confirmations.** `/admin snowball correct`, `/admin candy adjust`, `/admin candy reverse`, `/admin event end`, `/admin season timezone`
  and `/admin season announce` show a preview with Confirm/Cancel. Only the requester can confirm, once, and permissions are
  checked again at that moment.
- **Timezone.** Event dates are stored as local dates, so changing the timezone moves them to the same local times in
  the new zone. The confirmation shows the before/after.
- **Advent settings** (door count, unlock/announcement time, catch-up policy) are server-wide. The claim deadline is
  per event, set in the schedule form or `/admin advent setup event:… claim_deadline:…`.
- **Exclusions.** Excluded members can still read Advent doors but receive no reward. Snowball opt-outs keep their
  place on the leaderboard (their progress is preserved), while excluded or departed members leave the standings.
  The candy leaderboard hides departed members and members excluded from every feature.
- **Snowball corrections** keep `available = collected − hits − misses`, so totals stay consistent and nonnegative.
- **Missing channels** pause the affected running event and alert staff in the log channel; resume with
  `/staff event resume` after fixing it.
