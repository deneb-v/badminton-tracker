-- "Pair within" becomes a level rotation: every Nth game of a player's is a level game, the rest are mixed.
ALTER TABLE sessions ADD COLUMN level_every TINYINT UNSIGNED NULL DEFAULT 3, DROP COLUMN pair_within;
