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
4. **Install and start:**
   ```sh
   npm ci
   npm run build
   node --env-file=.env dist/src/index.js
   ```
   The bot registers its own commands in each server at startup, so there is no separate register step. After
   pulling an update, rebuild and restart. `dist/scripts/deploy-commands.js` only cleans up command registrations
   left over from older versions.

Docker: `docker build -t emojitown-bot .` then run with the env vars and a volume mounted at `/data`.

Development: `npm test` (Vitest), `npm run typecheck`, `npm run dev` (runs from source with tsx).

## Commands

### Setup (admins, Manage Server): about 3 commands to go live

| Command | What it does |
| --- | --- |
| `/setup server` | Timezone, staff role, log channel, support link. |
| `/setup halloween channel:#spooky` | Creates this year's Halloween season (Oct 1–31 by default), turns on automatic start, and starts it right away if today is within the dates. Optional: `champion_role`, `start`/`end`, `wait_min`/`wait_max`/`visit_length` (durations like `30s`, `10m`, `2h`, `1d`; `m` = minutes), `candy_per_win`, `daily_candy_limit`, `remove_channel`. |
| `/setup snowball channel:#snow` | Same for Snowball Fights (Dec 1–31 by default). |
| `/setup advent channel:#advent` | Same for the Advent Calendar (Dec 1–24). Optional: `start`, `doors`, `unlock_time`, `catch_up`. |
| `/setup door day:1` | Write one Advent door in a form. The calendar starts on its own once every door is written. |
| `/setup content game:halloween` | Without a file: download the current names/messages/artwork JSON. With `file:`: upload your edited version (applies to the live season too). |
| `/setup class class:rare chance:12 bonus_candy:5` | Halloween visitor classes (Common, Uncommon, Rare, Legendary): how often each appears and the extra candy it pays. |
| `/setup status` | Checklist of what is set up, live, or still missing. |

### Halloween visitors

| Command | What it does |
| --- | --- |
| `/visitor add class:rare picture:<file>` | Create a visitor. A form asks for its name, greeting, trick text, treat text and the collectible it gives. Pictures are stored by the bot (Discord attachment links expire); `picture_url:` works too. |
| `/visitor edit visitor:<name>` | Change class, picture (`picture`, `picture_url`, `remove_picture`) or texts. |
| `/visitor remove visitor:<name>` | Remove one visitor, or pick **All placeholder visitors**. Visitors someone already collected from are retired instead, so nobody loses items. |
| `/visitor list` | Every visitor with its class, plus each class's share of visits and bonus candy. |

How a visit is chosen: first a class, weighted by its chance (only classes that currently have visitors count), then
one of that class's visitors at random. The winner gets the normal candy plus the class bonus (default +0 / +2 / +5 / +10),
within the daily Halloween candy limit. Changes apply to the live season immediately.

Every setup command replies with **what changed** (`**Timezone:** UTC → Europe/Copenhagen`), or says
**Nothing changed** when it didn't, followed by the current settings and anything still needed.

### Running the games

| `/admin …` (Manage Server) | `/mod …` (staff role) |
| --- | --- |
| `start`, `end` (with keep/remove Champion role), `give-candy`, `undo-candy`, `fix-stats`, `fix-item`, `clear-warmup`, `announce`, `export`, `audit` | `pause`, `resume`, `exclude`, `include`, `cancel-visitor`, `preview`, `candy-history`, `repost-door`, `fix-role` |

### Members

`/collect` `/throw` `/stats` `/snowball join|leave` · `/trick` `/treat` `/inventory` · `/advent` · `/candy` ·
`/leaderboard` `/events` `/help`

### Who can see what

**Game commands only appear while that game is live.** In October members see `/trick`, `/treat` and `/inventory`
but not `/collect` or `/advent`; in December the snowball and Advent commands appear instead. `/candy`,
`/leaderboard`, `/events` and `/help` are always there. The bot updates the list itself within about 15 seconds of a
game starting or ending (immediately when started or ended with a command), and the setup reply tells you which
commands appeared or disappeared. A paused game keeps its commands so they can explain the pause.

`/setup`, `/admin` and `/mod` are hidden from regular members (they require **Manage Server** by default). The bot
also checks permissions on every command, button and form itself, so changing Discord's command settings never
grants more access. **One manual step:** so your staff role can see `/mod`, open
**Server Settings → Integrations → emojitown → /mod** and add the role.

Role safety: the Halloween Champion role must be a dedicated role with no moderation permissions, held by at most one
member, and must not be `@everyone` or a staff role, because the bot removes it from everyone except the winner.
`@everyone` cannot be made a staff role.

### Troubleshooting

- **Every command says the bot "isn't a member of this server":** it was added as commands only. Use the invite link
  in that message (it also prints in the console at startup) and choose your server.
- **Startup says the token was rejected:** reset the token on the Bot tab and update `.env`.
- **Startup says "Server Members Intent":** turn it on under Bot → Privileged Gateway Intents.

## First-time setup in Discord

1. `/setup server timezone:Europe/Copenhagen staff_role:@Event Staff log_channel:#staff-log support:#help`
2. `/setup halloween channel:#spooky champion_role:@Halloween Champion`
3. `/setup content game:halloween` to download the template, fill in the real visitors, then upload it with `file:`.
4. Before December: `/setup snowball channel:#snow`, `/setup advent channel:#advent`, then `/setup door day:1` … `day:24`.
5. `/setup status` any time to see what's left.

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

Snowball pack (`/setup content game:snowball`):

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
current pack, so uploading a new version is safe even while Halloween is live (the live season switches to it).

The built-in content is placeholder text so the bot works out of the box. Replace it with the final emojitown
names, artwork and wording before launch (spec section 13).

## Decisions where the spec left room

- **Simplified commands.** One `/setup <game>` command creates the season with default dates, turns on automatic
  start and starts it if it's due, instead of separate create/schedule/check/start steps. Advent calendars publish
  themselves when they start. The spec's separate `/halloween missing`, `/halloween visitors`, `/advent calendar`,
  `/advent progress` and `/candy history` views are buttons on `/inventory`, `/advent` and `/candy`; `/support` is part
  of `/help`; `/season status` is `/events`. Rarity weights stay at the spec's 70/25/5 and are not exposed as options.
- **Forms.** `/setup door` opens a Discord form (5 fields: title, message, image, link, trivia answer); `candy` and
  `reason` are command options.
- **Confirmations.** `/admin end`, `/admin give-candy`, `/admin undo-candy`, `/admin fix-stats` and `/admin announce`
  show a preview with Confirm/Cancel. Only the requester can confirm or cancel, once, and permissions are checked again.
- **Timezone.** Event dates are stored as local dates, so changing the timezone keeps the same local times in the new
  zone; `/setup server` lists each season's moved start time.
- **Advent settings** (door count, unlock time, catch-up) are server-wide; with catch-up on, missed doors can be
  claimed until the calendar ends.
- **Exclusions.** Excluded members can still read Advent doors but receive no reward. Members who `/snowball leave`
  keep their place on the leaderboard (their progress is preserved), while excluded or departed members leave the
  standings. The candy leaderboard hides departed members and members excluded from every game.
- **Snowball corrections** keep `available = collected − hits − misses`, so totals stay consistent and nonnegative.
- **Missing channels** pause the affected game and alert staff in the log channel; resume with `/mod resume` after
  fixing it.
