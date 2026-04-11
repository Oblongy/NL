-- ============================================================================
-- CLEANUP SCRIPT - Run this BEFORE perfect-schema.sql if you get conflicts
-- ============================================================================
-- This removes policies and other objects that might conflict
-- Your data (tables, rows) will NOT be deleted
-- ============================================================================

-- Drop all RLS policies
drop policy if exists "Service role has full access to players" on public.game_players;
drop policy if exists "Service role has full access to sessions" on public.game_sessions;
drop policy if exists "Service role has full access to cars" on public.game_cars;
drop policy if exists "Service role has full access to teams" on public.game_teams;
drop policy if exists "Service role has full access to team members" on public.game_team_members;
drop policy if exists "Service role has full access to mail" on public.game_mail;

-- Drop triggers (will be recreated)
drop trigger if exists game_players_touch_updated_at on public.game_players;
drop trigger if exists game_cars_touch_updated_at on public.game_cars;
drop trigger if exists game_teams_touch_updated_at on public.game_teams;
drop trigger if exists game_team_members_touch_updated_at on public.game_team_members;
drop trigger if exists game_team_members_update_count on public.game_team_members;

-- Drop functions (will be recreated)
drop function if exists public.touch_updated_at() cascade;
drop function if exists public.cleanup_expired_sessions() cascade;
drop function if exists public.update_team_member_count() cascade;

-- Note: Tables and data are preserved
-- Now run perfect-schema.sql
