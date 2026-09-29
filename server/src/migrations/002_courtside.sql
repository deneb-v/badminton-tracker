-- Courtside redesign: group details + invites, per-session pairing range, and the admin game plan.

ALTER TABLE `groups`
  ADD COLUMN venue VARCHAR(150) NOT NULL DEFAULT '',
  -- Comma-separated weekday codes in week order, e.g. 'Thu,Sat'.
  ADD COLUMN usual_days VARCHAR(40) NOT NULL DEFAULT '',
  ADD COLUMN invite_code CHAR(6) NULL,
  ADD COLUMN owner_user_id INT NULL,
  ADD UNIQUE KEY uq_groups_invite (invite_code),
  ADD CONSTRAINT fk_groups_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;

-- Existing groups: the earliest admin with a login owns it.
UPDATE `groups` g SET owner_user_id = (
  SELECT m.user_id FROM members m
  WHERE m.group_id = g.id AND m.role = 'admin' AND m.user_id IS NOT NULL
  ORDER BY m.id LIMIT 1
);

-- "Pair within N levels": every player in a match starts within N of the seed player. NULL = no limit.
ALTER TABLE sessions ADD COLUMN pair_within TINYINT UNSIGNED NULL;

ALTER TABLE matches ADD COLUMN planned BOOLEAN NOT NULL DEFAULT FALSE;

-- Admin game plan: a player pencilled into a court's Nth game (e.g. 3A). Open spots are auto-filled.
CREATE TABLE planned_slots (
  session_id INT NOT NULL,
  court_id INT NOT NULL,
  game_no SMALLINT UNSIGNED NOT NULL,
  member_id INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (session_id, court_id, game_no, member_id),
  CONSTRAINT fk_plan_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_plan_court FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE,
  CONSTRAINT fk_plan_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);
