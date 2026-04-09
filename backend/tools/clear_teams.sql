-- Clear all team assignments from players
-- Run this in your Supabase SQL editor

UPDATE game_players 
SET 
  team_id = NULL,
  team_name = ''
WHERE id > 0;

-- Show count of affected players
SELECT COUNT(*) as players_updated FROM game_players WHERE team_id IS NULL AND team_name = '';
