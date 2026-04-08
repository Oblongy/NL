-- Nitto Legends Community Server - Database Schema
-- Run this in your Supabase SQL Editor

-- ============================================================================
-- GAME PLAYERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_players (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  
  -- Currency and progression
  money BIGINT DEFAULT 50000,
  points BIGINT DEFAULT 0,
  score BIGINT DEFAULT 0,
  
  -- Player identity
  image_id INTEGER DEFAULT 0,
  gender TEXT DEFAULT 'm',
  driver_text TEXT DEFAULT '',
  team_name TEXT DEFAULT '',
  
  -- Status flags
  active INTEGER DEFAULT 1,
  vip INTEGER DEFAULT 0,
  facebook_connected INTEGER DEFAULT 0,
  alert_flag INTEGER DEFAULT 0,
  blackcard_progress INTEGER DEFAULT 0,
  sponsor_rating INTEGER DEFAULT 0,
  respect_level INTEGER DEFAULT 1,
  message_badge INTEGER DEFAULT 0,
  client_role INTEGER DEFAULT 5,

  -- Profile badges (manual override)
  -- JSONB shape examples:
  --   [1,2,3]
  --   [{"i":1,"n":2},{"id":2,"count":1}]
  --   {"1":2,"2":1}
  badges_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  
  -- Location and display
  location_id INTEGER DEFAULT 100,
  background_id INTEGER DEFAULT 1,
  title_id INTEGER DEFAULT 0,
  track_rank INTEGER DEFAULT 0,
  
  -- Current car
  default_car_game_id INTEGER DEFAULT NULL,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast username lookups
CREATE INDEX IF NOT EXISTS idx_game_players_username ON game_players(username);

-- ============================================================================
-- GAME CARS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_cars (
  game_car_id BIGSERIAL PRIMARY KEY,
  account_car_id BIGINT DEFAULT NULL,
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  
  -- Car identity
  catalog_car_id INTEGER NOT NULL,
  selected BOOLEAN DEFAULT FALSE,
  
  -- Visual customization
  paint_index INTEGER DEFAULT 4,
  plate_name TEXT DEFAULT '',
  color_code TEXT DEFAULT 'C0C0C0',
  image_index INTEGER DEFAULT 0,
  
  -- Configuration
  locked INTEGER DEFAULT 0,
  aero INTEGER DEFAULT 0,
  
  -- Parts and wheels (XML format)
  wheel_xml TEXT DEFAULT '',
  parts_xml TEXT DEFAULT '',

  -- Test-drive state
  test_drive_invitation_id BIGINT DEFAULT NULL,
  test_drive_name TEXT DEFAULT NULL,
  test_drive_money_price BIGINT DEFAULT NULL,
  test_drive_point_price BIGINT DEFAULT NULL,
  test_drive_expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE game_cars ADD COLUMN IF NOT EXISTS test_drive_invitation_id BIGINT DEFAULT NULL;
ALTER TABLE game_cars ADD COLUMN IF NOT EXISTS test_drive_name TEXT DEFAULT NULL;
ALTER TABLE game_cars ADD COLUMN IF NOT EXISTS test_drive_money_price BIGINT DEFAULT NULL;
ALTER TABLE game_cars ADD COLUMN IF NOT EXISTS test_drive_point_price BIGINT DEFAULT NULL;
ALTER TABLE game_cars ADD COLUMN IF NOT EXISTS test_drive_expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL;

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_game_cars_player ON game_cars(player_id);
CREATE INDEX IF NOT EXISTS idx_game_cars_selected ON game_cars(player_id, selected);

-- Ensure only one selected car per player
CREATE UNIQUE INDEX IF NOT EXISTS idx_game_cars_one_selected 
  ON game_cars(player_id) 
  WHERE selected = TRUE;

-- ============================================================================
-- GAME SESSIONS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_sessions (
  session_key TEXT PRIMARY KEY,
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for fast player lookups
CREATE INDEX IF NOT EXISTS idx_game_sessions_player ON game_sessions(player_id);

-- Auto-cleanup old sessions (older than 7 days)
CREATE INDEX IF NOT EXISTS idx_game_sessions_cleanup ON game_sessions(last_seen_at);

-- ============================================================================
-- GAME TEAMS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_teams (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  
  -- Team stats
  score BIGINT DEFAULT 0,
  team_fund BIGINT DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  
  -- Team identity
  background_color TEXT DEFAULT '7D7D7D',
  location_code TEXT DEFAULT '',
  recruitment_type TEXT DEFAULT 'open',
  vip INTEGER DEFAULT 0,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for team name searches
CREATE INDEX IF NOT EXISTS idx_game_teams_name ON game_teams(name);

-- ============================================================================
-- GAME TEAM MEMBERS TABLE
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_team_members (
  id BIGSERIAL PRIMARY KEY,
  team_id BIGINT NOT NULL REFERENCES game_teams(id) ON DELETE CASCADE,
  player_id BIGINT NOT NULL REFERENCES game_players(id) ON DELETE CASCADE,
  
  -- Member stats
  contribution_score BIGINT DEFAULT 0,
  
  -- Timestamps
  joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- One player per team
  UNIQUE(team_id, player_id)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_game_team_members_team ON game_team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_game_team_members_player ON game_team_members(player_id);
CREATE INDEX IF NOT EXISTS idx_game_team_members_contribution ON game_team_members(team_id, contribution_score DESC);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for auto-updating timestamps
DROP TRIGGER IF EXISTS update_game_players_updated_at ON game_players;
CREATE TRIGGER update_game_players_updated_at
  BEFORE UPDATE ON game_players
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_game_cars_updated_at ON game_cars;
CREATE TRIGGER update_game_cars_updated_at
  BEFORE UPDATE ON game_cars
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_game_teams_updated_at ON game_teams;
CREATE TRIGGER update_game_teams_updated_at
  BEFORE UPDATE ON game_teams
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_game_team_members_updated_at ON game_team_members;
CREATE TRIGGER update_game_team_members_updated_at
  BEFORE UPDATE ON game_team_members
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ATOMIC CAR SELECTION
-- Unselect all cars, mark one as selected, and update the player's default
-- in a single transaction so a mid-flight crash can never leave orphan state.
-- ============================================================================
CREATE OR REPLACE FUNCTION select_player_car(
  p_player_id BIGINT,
  p_game_car_id BIGINT
) RETURNS BOOLEAN AS $$
BEGIN
  -- Unselect every car for this player
  UPDATE game_cars SET selected = FALSE
  WHERE player_id = p_player_id;

  -- Select the requested car (must belong to this player)
  UPDATE game_cars SET selected = TRUE
  WHERE game_car_id = p_game_car_id
    AND player_id = p_player_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'car_not_found: % does not own car %', p_player_id, p_game_car_id;
  END IF;

  -- Sync the player's default pointer
  UPDATE game_players SET default_car_game_id = p_game_car_id
  WHERE id = p_player_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SAMPLE DATA (OPTIONAL - FOR TESTING)
-- ============================================================================

-- Create test player (password: "test123" hashed with SHA256)
INSERT INTO game_players (username, password_hash, money, points, score)
VALUES (
  'Tester1',
  'ecd71870d1963316a97e3ac3408c9835ad8cf0f3c1bc703527c30265534f75ae',
  50000,
  0,
  1000
) ON CONFLICT (username) DO NOTHING;

-- Get the player ID for the test player
DO $$
DECLARE
  test_player_id BIGINT;
  test_car_id BIGINT;
BEGIN
  -- Get player ID
  SELECT id INTO test_player_id FROM game_players WHERE username = 'Tester1';
  
  IF test_player_id IS NOT NULL THEN
    -- Create a test car
    INSERT INTO game_cars (
      player_id,
      catalog_car_id,
      selected,
      paint_index,
      plate_name,
      color_code,
      parts_xml,
      wheel_xml
    ) VALUES (
      test_player_id,
      101, -- Nissan Skyline GT-R R34 (common catalog ID)
      TRUE,
      4,
      'TEST',
      'FF0000',
      '<ps><p cd=''FF0000''/></ps>',
      '<w wid=''1000'' id=''1'' ws=''17''/>'
    ) RETURNING game_car_id INTO test_car_id;
    
    -- Update player's default car
    UPDATE game_players 
    SET default_car_game_id = test_car_id
    WHERE id = test_player_id;
  END IF;
END $$;

-- ============================================================================
-- MAINTENANCE QUERIES
-- ============================================================================

-- View all players with their car counts
-- SELECT 
--   p.id,
--   p.username,
--   p.money,
--   p.score,
--   COUNT(c.game_car_id) as car_count
-- FROM game_players p
-- LEFT JOIN game_cars c ON c.player_id = p.id
-- GROUP BY p.id;

-- View all sessions (for debugging)
-- SELECT 
--   s.session_key,
--   p.username,
--   s.created_at,
--   s.last_seen_at
-- FROM game_sessions s
-- JOIN game_players p ON p.id = s.player_id
-- ORDER BY s.last_seen_at DESC;

-- Clean up old sessions (run periodically)
-- DELETE FROM game_sessions 
-- WHERE last_seen_at < NOW() - INTERVAL '7 days';

-- View team rosters
-- SELECT 
--   t.name as team_name,
--   p.username,
--   tm.contribution_score
-- FROM game_teams t
-- JOIN game_team_members tm ON tm.team_id = t.id
-- JOIN game_players p ON p.id = tm.player_id
-- ORDER BY t.name, tm.contribution_score DESC;
