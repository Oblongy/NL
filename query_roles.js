import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function test() {
  const { data } = await supabase.from('game_players').select('id, username, client_role, role').ilike('username', '%obl%').limit(5);
  console.log('Player roles:', data);
  const { data: cols } = await supabase.rpc('get_columns_for_game_players').catch(() => ({data: 'no rpc'}));
  console.log('Columns (if any):', cols);
}
test();
