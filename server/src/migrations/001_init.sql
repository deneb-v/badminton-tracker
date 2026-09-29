CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE `groups` (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  singles_max_gap TINYINT UNSIGNED NOT NULL DEFAULT 10,
  doubles_max_gap TINYINT UNSIGNED NOT NULL DEFAULT 8,
  intra_team_max_spread TINYINT UNSIGNED NOT NULL DEFAULT 25,
  default_match_minutes TINYINT UNSIGNED NOT NULL DEFAULT 15,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE members (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  user_id INT NULL,
  name VARCHAR(100) NOT NULL,
  role ENUM('admin','member') NOT NULL DEFAULT 'member',
  level TINYINT UNSIGNED NOT NULL,
  is_guest BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_group_user (group_id, user_id),
  CONSTRAINT fk_members_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  CONSTRAINT fk_members_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_level CHECK (level BETWEEN 1 AND 100)
);

CREATE TABLE sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_id INT NOT NULL,
  venue VARCHAR(150) NOT NULL,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  match_type ENUM('singles','doubles') NOT NULL DEFAULT 'doubles',
  status ENUM('scheduled','live','closed') NOT NULL DEFAULT 'scheduled',
  version INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sessions_group_date (group_id, date),
  CONSTRAINT fk_sessions_group FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE
);

CREATE TABLE courts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  label VARCHAR(4) NOT NULL,
  available_from TIME NOT NULL,
  available_until TIME NOT NULL,
  match_type ENUM('singles','doubles') NULL,
  UNIQUE KEY uq_court_label (session_id, label),
  CONSTRAINT fk_courts_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE attendance (
  session_id INT NOT NULL,
  member_id INT NOT NULL,
  status ENUM('invited','present','late','absent','departed') NOT NULL DEFAULT 'invited',
  checked_in_at DATETIME(3) NULL,
  departed_at DATETIME(3) NULL,
  PRIMARY KEY (session_id, member_id),
  CONSTRAINT fk_att_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_att_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);

CREATE TABLE matches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  session_id INT NOT NULL,
  court_id INT NOT NULL,
  type ENUM('singles','doubles') NOT NULL,
  status ENUM('queued','playing','done','cancelled') NOT NULL DEFAULT 'queued',
  position INT NOT NULL DEFAULT 0,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  unbalanced BOOLEAN NOT NULL DEFAULT FALSE,
  level_gap DECIMAL(5,2) NOT NULL DEFAULT 0,
  fits_window BOOLEAN NOT NULL DEFAULT TRUE,
  est_start DATETIME(3) NULL,
  started_at DATETIME(3) NULL,
  ended_at DATETIME(3) NULL,
  winner_side ENUM('A','B') NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_matches_session_status (session_id, status),
  CONSTRAINT fk_matches_session FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_matches_court FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE
);

CREATE TABLE match_players (
  match_id INT NOT NULL,
  member_id INT NOT NULL,
  side ENUM('A','B') NOT NULL,
  PRIMARY KEY (match_id, member_id),
  KEY idx_mp_member (member_id),
  CONSTRAINT fk_mp_match FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
  CONSTRAINT fk_mp_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
);
