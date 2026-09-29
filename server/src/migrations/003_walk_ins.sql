-- Walk-ins join level with the fewest games played, so they don't jump the queue.
ALTER TABLE attendance ADD COLUMN games_credit TINYINT UNSIGNED NOT NULL DEFAULT 0;
