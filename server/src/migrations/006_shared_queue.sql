-- One queue for all courts: a queued game has no court until it's started on one.
ALTER TABLE matches MODIFY court_id INT NULL, ADD COLUMN plan_no SMALLINT UNSIGNED NULL;
UPDATE matches SET court_id = NULL WHERE status = 'queued';

-- The game plan pencils players into the session's Nth game, played on whichever court is free.
-- Court-based slots (e.g. "3A") don't translate, so they're cleared.
DELETE FROM planned_slots;
ALTER TABLE planned_slots DROP FOREIGN KEY fk_plan_court;
ALTER TABLE planned_slots DROP PRIMARY KEY, DROP COLUMN court_id, ADD PRIMARY KEY (session_id, game_no, member_id);
