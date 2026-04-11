import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://ciodeetppyjdmcxrixmg.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpb2RlZXRwcHlqZG1jeHJpeG1nIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTI3NjY0NSwiZXhwIjoyMDkwODUyNjQ1fQ._S1QWHyYC_JKBXEAsn65TR-r85XoiNSx1XdRBuaRcIY"
);

async function fixHoodDesignId() {
  // Try design ID 1 (most likely to be the default/stock hood)
  const newXml = `<p ai='1775592968463660' i='7112' pi='71' t='c' n='Hood-(3)' p='1500' pp='15' g='C' di='1' pdi='1' b='exterior' bn='Exterior' mn='Hood-(3)' l='100' in='1' mo='0' hp='0' tq='0' wt='0' cc='0'/>`;
  
  const { error } = await supabase
    .from("game_cars")
    .update({ parts_xml: newXml })
    .eq("catalog_car_id", 106);
  
  if (error) {
    console.error("Error:", error);
  } else {
    console.log("✓ Updated hood to use design ID 1 (was 4)");
    console.log("✓ Please relog in the game to test");
  }
}

fixHoodDesignId().catch(console.error);
