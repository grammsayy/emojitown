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

Requirements: Node.js 20 or newer. Data is stored in a single SQLite file.

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

## First-time setup in Discord

Follow section 11 of the spec. In short:

1. `/season setup timezone:Europe/Copenhagen support:#help log_channel:#staff-log event_manager_role:@Event Manager`
2. `/season channel feature:snowball action:add channel:#snowball-fight` (also `halloween` and `advent`)
3. `/season event create feature:halloween name:Halloween 2026` (also snowball and advent). Default dates are filled in;
   adjust them with `/season event schedule`, which opens a form and can turn on automatic start.
4. Import content: `/season content feature:halloween action:import file:<pack.json>` (and `snowball`). Start from
   `/season content … action:export` to get the current pack as a template.
5. `/halloween champion role:@Halloween Champion end_policy:keep`, and optionally `/candy setup`, `/halloween setup`, `/advent setup`.
6. Fill the 24 doors with `/advent edit day:<n> event:advent-2026` (form), then `/advent validate` and `/advent publish`.
7. `/season check`, preview with `/snowball preview`, `/halloween preview` and `/advent preview`, then `/season announce`
   and `/season event start` (or let scheduled events start themselves).

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

Snowball pack (`/season content feature:snowball`):

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

- **Forms.** `/season event schedule` and `/advent edit` open Discord forms. Discord forms hold at most five fields,
  so `/advent edit` takes `candy` and `reason` as command options. The other setup commands (`/season setup`,
  `/halloween setup`, `/advent setup`, `/snowball setup`, `/candy setup`) use command options as their guided
  interface and show the saved result and remaining tasks.
- **Confirmations.** `/snowball correct`, `/candy adjust`, `/candy reverse`, `/season event end`, `/season timezone`
  and `/season announce` show a preview with Confirm/Cancel. Only the requester can confirm, once, and permissions are
  checked again at that moment.
- **Timezone.** Event dates are stored as local dates, so changing the timezone moves them to the same local times in
  the new zone. The confirmation shows the before/after.
- **Advent settings** (door count, unlock/announcement time, catch-up policy) are server-wide. The claim deadline is
  per event, set in the schedule form or `/advent setup event:… claim_deadline:…`.
- **Exclusions.** Excluded members can still read Advent doors but receive no reward. Snowball opt-outs keep their
  place on the leaderboard (their progress is preserved), while excluded or departed members leave the standings.
  The candy leaderboard hides departed members and members excluded from every feature.
- **Snowball corrections** keep `available = collected − hits − misses`, so totals stay consistent and nonnegative.
- **Missing channels** pause the affected running event and alert staff in the log channel; resume with
  `/season event resume` after fixing it.
