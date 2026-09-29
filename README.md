# Courtside (Badminton Tracker)

Runs a badminton group's play sessions: a roster with levels, a schedule, attendance on the day, and a fair, balanced play order across courts.

- `server/`: Express + MySQL API. Contains the play-order engine (`src/engine/queue.ts`, pure and unit-tested).
- `web/`: React + Vite PWA, mobile-first (with a tablet layout at ≥ 900px), usable offline. Styled with the "Industry" design system from the Courtside prototype: Barlow Condensed over Barlow, steel-blue wireframe, light and dark themes.

## Setup

Requires Node 20+ and a MySQL 8 you already run locally.

```bash
npm install
cp server/.env.example server/.env        # set DB credentials + JWT_SECRET
# create the databases once (as a MySQL admin user):
#   CREATE DATABASE badminton_tracker; CREATE DATABASE badminton_tracker_test;
#   CREATE USER 'badminton'@'%' IDENTIFIED BY 'badminton';
#   GRANT ALL ON badminton_tracker.* TO 'badminton'@'%';
#   GRANT ALL ON badminton_tracker_test.* TO 'badminton'@'%';
npm run migrate
npm run seed        # optional demo data
npm run create-user -- you@club.com "Your Name" 'a-long-password'   # first organiser login
npm run dev         # API :4000, web :5173 (proxies /api)
```

Sign-up is invite-only. The first organiser's login comes from `npm run create-user`. They sign in, create a group, and share its invite code or link (Manage → Invite members). Players create their own login at `/join/<code>`. If an admin already added them to the roster under the same name, joining claims that entry, so levels and history carry over. Resetting the code retires the old one.

Demo logins (after `npm run seed`): `admin@demo.dev` / `password123` (admin) and `member@demo.dev` / `password123` (read-only member).

`npm test` runs the engine unit tests plus API integration tests against `TEST_DB_NAME`. The test schema is dropped and recreated each run.

Production: `npm run build && npm start -w server` serves the API and the built web app from one port.

## Docker

One image runs everything: the API serves the built web app and runs migrations on startup.

```sh
cp .env.example .env          # set JWT_SECRET (openssl rand -hex 32); adjust DB_* if needed
docker compose up -d --build  # http://localhost:8080
```

By default it uses a MySQL you already run on this machine (reached as `host.docker.internal:3306`). To run MySQL alongside it instead, e.g. on a server, set `DB_HOST=db` (and a real `DB_PASSWORD`) in `.env` and start with `docker compose --profile db up -d --build`; the data lives in the `db-data` volume.

## Decisions taken from the open items

| Item | Decision |
|---|---|
| Balance thresholds | Singles gap ≤ 10, doubles team-average gap ≤ 8, partner gap ≤ 25. **Soft**: relaxed in steps of 5 rather than leave a court idle; relaxed matches are flagged "uneven" (admin-only). Admins can change all of these per group in Settings. |
| Win/loss visibility | Admin-only. Members see attendance and games played. |
| Guests | Supported. Admin adds a walk-in (name + level) from the session; they're marked present and kept off the main roster. |
| Singles + doubles at once | Yes. Each court can override the session's match type. |
| Minimum rest | Anyone who finished in the last 2 minutes sits out if enough others are waiting. With 12 players on 2 courts some go straight back on, but nobody plays a 3rd game in a row if someone else can: it costs more than being a game ahead. |
| Cost splitting | Not built. |
| Level game every | Set per session (2 / 3 / 4 games, or Off; default 3). Every Nth game of a player's is a *level game*: everyone within 15 levels. The rest are *mixed*: the strongest partners the weakest against the middle two, with team averages kept even, so weaker players learn and strong players still get proper games. Singles are never mixed. Off: teams are just kept even. |
| Mixed format | "Mixed" in New session means singles and doubles courts in one session: each court is set to D or S. |

## How it behaves

- **Starting a session**: *Start session* opens *Who's playing?*, a checklist of the group (with search, select all, and "Someone new?" to add a member on the spot). Ticked players are marked *In*, everyone else *Away*, and the play order is built. At least 4 players are needed.
- **Walk-ins**: in *Attend*, "Add a walk-in" marks a group member as arrived, or adds a new name to the group, and they join the queue straight away. They start level with the fewest games played among those present, so they don't jump ahead. Players who weren't ticked are hidden from the list until they're added this way.
- **Attendance**: *In* means here now and in the play order. *Late* means on the way; they aren't in the order until marked In. *Left* means they departed early, and they're dropped from future matches.
- **Queue**: one queue for all courts. Queued games aren't tied to a court: a free court's *Start* calls the first game of its type (singles/doubles) where nobody is still on another court (preferring one where nobody would be on their 3rd game in a row), and the game gets its court then. The queue holds about 3 games per court. After a change (a game starting or finishing, attendance), the next games (one per court) stay exactly as they are and only the rest is planned again, so "up next" doesn't change under people. *Regenerate* and game-plan edits plan everything again, keeping manual edits. The engine plans in turns, not clock times: a free court takes a game at turn 0, a court with a game on it at turn 1, and players on court sit out turn 0. Courts whose hours are over are skipped. Starting a match before a court opens, or too close to its closing time, asks for confirmation. That check uses the estimated match length: the group default (15 min), or the average of real match times once the group has 5 or more.
- **Done**: the admin taps *Done*, then the winner, or *Skip*. This records the result and frees the court. Nothing starts by itself: the court shows the game it would call next, and the admin taps *Start*.
- **Game plan** (admin *Plan* tab): a grid of players × their 1st, 2nd, 3rd… game, where a cell like *7A* means the session's 7th game, played on court A. Tapping *+* pencils a player into an upcoming game number. When that game comes up (or at the next chance, if the queue has already passed it), the planned players go ahead of the auto queue on whichever court is free (waiting for anyone still on another court), and the open spots are auto-filled with the highest-priority players closest in level. Starting the game uses up the plan. Editing a planned match by hand replaces its plan.
- **Level rotation**: the player first in line decides the game type. If they're due a level game but their level-mates are still on court, the level game is queued anyway and waits for them (a free court calls a later game meanwhile); level-mates at most a game ahead, and not straight out of a level game, are pulled in. If anyone among the next four is due a level game and there are enough free players near their level, they go first and it's a level game. Otherwise it's mixed, and wider level ranges (up to 40) are preferred. A level game with nobody near enough (e.g. a much weaker player) is played mixed instead. With the rotation on, strong-with-weak partnerships aren't flagged; only the team-average gap is.
- **Variety**: among lineups that fit the balance limits, the engine prefers new partners, new opponents and people who haven't shared a court yet, and it avoids exact rematches. When a group keeps landing together (for example 8 players on 1 court, which otherwise splits into two fixed foursomes), it may:
  - send up to 2 players straight back on court: only if they aren't ahead on games, and at most once every 3 of their games;
  - widen a level game's 15-level range by up to 3 steps, as long as team gap and partner spread still fit.

  When the players left over must play each other next, that match is scored too, so mixing never forces a lopsided game. Games played stays even. The weights are in `WEIGHTS` in `server/src/engine/queue.ts`.
- **Queue edits**: tap a queued match to swap a player (anyone marked in; if they're in another queued match, the two trade places), move it up or down the queue, or *Re-draw* it (the next-best lineup the engine can find). *Regenerate* drops manual edits but keeps the game plan.
- **Overrides**: swapping a player, moving a match to another court, reordering, or adding a match marks it *manual*. Manual matches survive rebuilds, running first on their court in order. *Clear manual changes* discards them.
- **Multi-admin**: every write locks the session row, rebuilds the queue, and bumps a version number. Other open screens update via server-sent events.
- **Offline**: the app shell is cached by a service worker, and the last session data is kept on the phone. Attendance, start, and done taps made offline go into an outbox with their real timestamps and replay in order when the phone reconnects. A replayed *Done* doesn't auto-start the next match, so the admin starts it.
- **Level privacy**: the server strips level, the uneven flag, level gap, wins and losses, and thresholds from every response sent to members, so the UI can't leak them. Integration tests cover this.
- **Time zone**: session dates and times are wall-clock times in the server's time zone.

## Not in v1

Payments, court booking, public rankings, tournaments, self check-in/RSVP, automatic level adjustment (win/loss is recorded per match, so an Elo-style v2 can use the existing data), and point scoring.
