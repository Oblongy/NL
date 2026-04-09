#!/usr/bin/env node

/**
 * Clear all team assignments from players
 * This removes team_id and team_name from all players in the database
 */

import { createGameSupabase } from '../src/supabase-client.js';
import { config } from '../src/config.js';

const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error
};

async function clearAllTeams() {
  console.log('Clearing all team assignments...');
  
  const supabase = await createGameSupabase(config, logger);
  
  if (!supabase) {
    console.error('Error: Could not connect to Supabase. Check your .env configuration.');
    process.exit(1);
  }
  
  try {
    // Update all players to remove team_id and set team_name to empty string
    const { error } = await supabase
      .from('game_players')
      .update({ 
        team_id: null,
        team_name: ''
      })
      .neq('id', 0); // Update all players (id != 0 is always true)
    
    if (error) {
      console.error('Error clearing teams:', error);
      process.exit(1);
    }
    
    // Get count of updated players
    const { count, error: countError } = await supabase
      .from('game_players')
      .select('*', { count: 'exact', head: true });
    
    if (countError) {
      console.error('Error getting player count:', countError);
    } else {
      console.log(`Successfully cleared team assignments for ${count} players`);
    }
    
    console.log('Done!');
  } catch (err) {
    console.error('Unexpected error:', err);
    process.exit(1);
  }
}

clearAllTeams();
