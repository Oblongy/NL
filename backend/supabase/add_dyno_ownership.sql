-- Add dyno ownership field to game_players table
-- This tracks whether a player has purchased the dyno tuning tool

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'game_players' 
    AND column_name = 'has_dyno'
  ) THEN
    ALTER TABLE public.game_players 
      ADD COLUMN has_dyno integer NOT NULL DEFAULT 0;
    
    RAISE NOTICE 'Added has_dyno column to game_players table';
  ELSE
    RAISE NOTICE 'has_dyno column already exists';
  END IF;
END $$;
