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

**Updating on Windows:** stop the bot (Ctrl+C in its window), then run `.\update.cmd` in the project folder. It pulls
the latest version, reinstalls packages, rebuilds and starts the bot. Your `.env` and `data` folder are kept.

Docker: `docker build -t emojitown-bot .` then run with the env vars and a volume mounted at `/data`.

Development: `npm test` (Vitest), `npm run typecheck`, `npm run dev` (runs from source with tsx).

## Commands

Staff commands are **menus**: one command per topic. Run it, pick what you want to do, and a form pops up with only
the fields that action needs, already filled in with the current values. Each menu only lists what you're allowed to
do. `/help` lists the staff commands to the people who can use them.

### Members

Game commands only appear while that game is live.

```
🎃 Halloween          /trick · /treat · /inventory [member] [rarity] [season]
❄️ Snowball Fights    /collect · /throw <target> · /stats [member] [season] · /snowball join | leave
🎄 Advent Calendar    /advent [day]
Always                /candy [member] · /leaderboard [game] [season] [page] · /events · /help [game]
```

### Staff

```
/settings   (admins)              Shows the setup checklist
  Change settings                 Timezone, staff roles, log channel, support link

/season     (event staff; admins see everything)
  Set up Halloween                Channels, dates, Champion role                              admins
  Halloween visitor timing        Waits between visitors, visit length, auto-delete           admins
  Halloween candy                 Candy per win, daily limit                                  admins
  Set up Snowball Fights          Channels, dates                                             admins
  Set up the Advent Calendar      Channel, start day, doors, opening time, catch-up           admins
  Write an Advent door            Door number, candy → Continue → the door form               admins
  Content file                    Download or upload a game's texts and artwork (JSON)        admins
  Start a game now                                                                            admins
  Pause a game / Resume a paused game
  End a game                      Posts the results (asks to confirm)                         admins
  Announce a game                 Posts how-to-play instructions (shows a preview first)      admins
  Preview Halloween / Snowball Fights / Advent Calendar messages
  Send the visitor away
  Fix the Champion role
  Repost an Advent door
  Wipe ALL Halloween items        Every member's items this season (asks to confirm)          admins
  Export data                     All data for one season as a file                           admins

/visitor    (admins)              Shows how many visitors each class has
  Add a visitor                   Class, picture, win text → Continue → name and texts
  Edit a visitor                  Visitor, class, picture, win text → Continue → name and texts
  Remove a visitor                One visitor, or all placeholder visitors
  List visitors
  Visitor classes                 Chance, bonus candy and rarity text of a class
  Export items (spreadsheet)      Download items as a CSV to mass-edit
  Import items (spreadsheet)      Upload the edited CSV (you confirm the changes first)

/player     (event staff; admins see everything)
  History                         A member's candy and staff actions, or the whole staff log
  Give an item / Remove an item   One Halloween item (candy is kept)
  Wipe a member's items           All their Halloween items this season (asks to confirm)
  Clear a snowball warm-up
  Exclude a member / Include a member
  Give or take candy              (asks to confirm)                                           admins
  Undo a candy transaction                                                                    admins
  Correct snowball stats          (asks to confirm)                                           admins
```

Every action that changes something replies with **what changed** (`**Collection:** 2 → 1`), or says **Nothing
changed**. Changes made by staff need a reason, which is saved in the staff log. Wipes and item removals keep the
candy already earned and recalculate the Champion. Discord can't open a form directly from another form, so actions
with two forms (adding a visitor, writing a door) show a **Continue** button between them.

### Halloween visitors in detail

| Field | What it does |
| --- | --- |
| **Picture** / **link** | Pictures are stored by the bot (Discord attachment links expire). Type `none` in the link field when editing to remove the picture. |
| **Win text** | The text on the win card, e.g. `As a thank you, they give {winner} one **{item}**`. Placeholders: `{winner}`, `{item}`, `{name}`, `{request}`. |
| **Remove a visitor** | Visitors someone already collected from are retired instead, so nobody loses items. |
| **Export** / **Import items** | One row per item: all, Common, Uncommon + Rare, or one rarity. Every row is checked (errors list the row number), then a summary is shown and applied only on **Confirm**. Rows with an empty `item_id` add new items/visitors. Don't change `item_id`/`visitor_id`. Excel: save as **CSV UTF-8**. |

How a visit is chosen: first a class, weighted by its chance (only classes that currently have visitors count), then
one of that class's visitors at random. The winner gets the normal candy plus the class bonus (default +0 / +2 / +5 / +10),
within the daily Halloween candy limit. Changes apply to the live season immediately.

The win card follows the classic layout: title ("Happy Halloween!"), the win text naming the winner and item, the item's
picture large (the visitor's picture if the item has none), then the class's rarity line and the candy earned. The
side colour matches the rarity. Finished visitor messages are deleted after a delay you set in **Halloween visitor timing** (default 5 seconds).

`/season` → **Preview Halloween messages** shows any message members can see (visitor arrival, win card,
duplicate, winner's private reply, candy-limit reply, wrong answer, visitor leaving, results, announcement; the
snowball and Advent messages too) with your real visitors, pictures and texts. Pick **All** to see every message.
Optional **Visitor** / **Door** choose what to show, and **Who sees it** can post it in the channel. Nothing is saved.

### Who can see what

**Game commands only appear while that game is live.** In October members see `/trick`, `/treat` and `/inventory`
but not `/collect` or `/advent`; in December the snowball and Advent commands appear instead. `/candy`,
`/leaderboard`, `/events` and `/help` are always there. The bot updates the list itself within about 15 seconds of a
game starting or ending (immediately when started or ended with a command), and the setup reply tells you which
commands appeared or disappeared. A paused game keeps its commands so they can explain the pause.

Staff commands are hidden from regular members (they require **Manage Server** by default). The bot also checks
permissions on every command, button and form itself, so changing Discord's command settings never grants more
access. **One manual step:** so your staff role can see `/season` and `/player`, open
**Server Settings → Integrations → emojitown**, click `/season` and `/player`, and add the role to each. Staff then
see only the staff actions in those menus.

Role safety: the Halloween Champion role must be a dedicated role with no moderation permissions, held by at most one
member, and must not be `@everyone` or a staff role, because the bot removes it from everyone except the winner.
`@everyone` cannot be made a staff role.

### Troubleshooting

- **Every command says the bot "isn't a member of this server":** it was added as commands only. Use the invite link
  in that message (it also prints in the console at startup) and choose your server.
- **Startup says the token was rejected:** reset the token on the Bot tab and update `.env`.
- **Startup says "Server Members Intent":** turn it on under Bot → Privileged Gateway Intents.

## First-time setup in Discord

1. `/settings` → **Change settings**: timezone, staff role, log channel, support link.
2. Let the staff role see `/season` and `/player` (Server Settings → Integrations → emojitown).
3. `/season` → **Set up Halloween**: pick the channel and the Champion role.
4. `/visitor` → **Add a visitor**, or mass-edit with **Export items** and **Import items**.
5. Before December: `/season` → **Set up Snowball Fights**, **Set up the Advent Calendar**, then **Write an Advent door** for each day.
6. `/settings` any time to see what's left.

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

Snowball pack (`/season` → **Content file**):

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

- **Simplified commands.** One **Set up** action per game creates the season with default dates, turns on automatic
  start and starts it if it's due, instead of separate create/schedule/check/start steps. Advent calendars publish
  themselves when they start. The spec's separate `/halloween missing`, `/halloween visitors`, `/advent calendar`,
  `/advent progress` and `/candy history` views are buttons on `/inventory`, `/advent` and `/candy`; `/support` is part
  of `/help`; the spec's season status view is `/events`. Visitor classes (chance, bonus candy, rarity text) are set with `/visitor` → **Visitor classes**.
- **Forms.** **Write an Advent door** asks for the door number, candy and reason, then opens the door form (title,
  message, image, link, trivia answer).
- **Confirmations.** Ending or announcing a game, wiping items, giving or taking candy, undoing candy and correcting snowball stats
  show a preview with Confirm/Cancel. Only the requester can confirm or cancel, once, and permissions are checked again.
- **Timezone.** Event dates are stored as local dates, so changing the timezone keeps the same local times in the new
  zone; **Change settings** lists each season's moved start time.
- **Advent settings** (door count, unlock time, catch-up) are server-wide; with catch-up on, missed doors can be
  claimed until the calendar ends.
- **Exclusions.** Excluded members can still read Advent doors but receive no reward. Members who `/snowball leave`
  keep their place on the leaderboard (their progress is preserved), while excluded or departed members leave the
  standings. The candy leaderboard hides departed members and members excluded from every game.
- **Snowball corrections** keep `available = collected − hits − misses`, so totals stay consistent and nonnegative.
- **Missing channels** pause the affected game and alert staff in the log channel; resume with `/season` → **Resume a paused game** after
  fixing it.
