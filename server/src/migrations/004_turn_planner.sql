-- The planner orders games by turn, not estimated clock time, so these are no longer stored.
ALTER TABLE matches DROP COLUMN fits_window, DROP COLUMN est_start;
