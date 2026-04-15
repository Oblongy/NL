# Parts Per Car - How It Works

## Overview

In Nitto 1320 Legends, parts are managed in two places:
1. **Installed on cars** - stored in `game_cars.parts_xml` field
2. **In player inventory** - stored in `game_parts_inventory` table

## Database Schema

### game_cars table
```sql
game_cars {
  game_car_id: bigint (primary key)
  player_id: bigint (foreign key)
  catalog_car_id: integer
  parts_xml: text  -- XML string containing all installed parts
  wheel_xml: text  -- XML string for wheels
  ...
}
```

### game_parts_inventory table
```sql
game_parts_inventory {
  id: bigint (primary key)
  player_id: bigint (foreign key)
  part_catalog_id: integer  -- References the parts catalog
  quantity: integer (default 1)
  acquired_at: timestamptz
  
  UNIQUE(player_id, part_catalog_id)  -- One row per part type per player
}
```

## How Parts Work

### 1. Parts Catalog
- Parts are defined in a catalog (loaded from XML files)
- Each part has:
  - `i` - Part ID
  - `pi` - Part slot ID (where it goes on the car)
  - `n` - Part name
  - `p` - Price in money
  - `pp` - Price in points
  - `hp`, `tq`, `wt`, `mo` - Performance stats
  - `t` - Part type (e=engine, c=cosmetic, etc.)

### 2. Buying Parts
When a player buys a part:
```javascript
// Option A: Install directly on car (current implementation)
// - Deduct money/points from player
// - Add part XML to car.parts_xml
// - Part is immediately installed

// Option B: Add to inventory (for parts bin system)
// - Deduct money/points from player
// - Add/increment row in game_parts_inventory
// - Player can install later from inventory
```

### 3. Parts XML Format
Parts are stored as XML in the `parts_xml` field:
```xml
<p ai='12345678' i='1001' ci='1' n='Turbo' in='1' cc='0' pt='e' hp='50' tq='40' wt='10' mo='0' ps=''/>
```

Attributes:
- `ai` - Installed part ID (unique per installation)
- `i` - Catalog part ID
- `ci` - Slot ID (where it's installed)
- `n` - Part name
- `in` - Installed flag (1=installed, 0=in inventory)
- `cc` - Custom color
- `pt` - Part type
- `hp`, `tq`, `wt`, `mo` - Performance stats
- `ps` - Paint state

### 4. Installing Parts
```javascript
// From inventory to car:
1. Find part in game_parts_inventory
2. Decrement quantity (or delete if quantity=1)
3. Generate new installed part XML
4. Upsert into car.parts_xml (replace if slot exists, append if new)
5. Update game_cars.parts_xml
```

### 5. Uninstalling Parts
```javascript
// From car to inventory:
1. Find part in car.parts_xml by slot ID
2. Remove from parts_xml
3. Add/increment in game_parts_inventory
4. Update game_cars.parts_xml
```

## Current Implementation

### Direct Install (buypart action)
```javascript
// backend-fresh/src/game-actions/parts.js
handleBuyPart() {
  // 1. Validate player has money/points
  // 2. Deduct cost
  // 3. Generate installed part XML
  // 4. Upsert into car.parts_xml
  // 5. Return success with new balance
}
```

**Pros:**
- Simple, immediate installation
- No inventory management needed
- Works for basic gameplay

**Cons:**
- Can't buy parts for later use
- Can't transfer parts between cars
- No "parts bin" feature

### Inventory System (getcarpartsbin action)
```javascript
handleGetCarPartsBin() {
  // 1. Query game_parts_inventory for player
  // 2. For each part, create XML entries
  // 3. If quantity > 1, create multiple entries
  // 4. Return parts bin XML
}

handleInstallPart() {
  // 1. Validate player owns the part
  // 2. Consume from inventory (decrement quantity)
  // 3. Install on car (add to parts_xml)
  // 4. Return success
}
```

**Pros:**
- Players can stockpile parts
- Can buy parts before deciding which car to install on
- Supports trading/gifting (future feature)

**Cons:**
- More complex database queries
- Need to manage inventory separately

## Parts Per Car Scenarios

### Scenario 1: Player has 3 cars, wants different parts on each
```javascript
// Car 1: Race build (all performance parts)
car1.parts_xml = "<p ai='1' i='1001' ci='1' .../><p ai='2' i='1002' ci='2' .../>"

// Car 2: Show build (all cosmetic parts)
car2.parts_xml = "<p ai='3' i='2001' ci='1' .../><p ai='4' i='2002' ci='2' .../>"

// Car 3: Stock (no parts)
car3.parts_xml = ""
```

Each car has its own `parts_xml` field, so parts are independent.

### Scenario 2: Player wants to swap parts between cars
```javascript
// Current implementation: Can't do this easily
// Would need to:
// 1. Remove part from car1.parts_xml
// 2. Add to game_parts_inventory
// 3. Remove from game_parts_inventory
// 4. Add to car2.parts_xml

// Better implementation: Add "uninstallpart" action
handleUninstallPart() {
  // 1. Find part in car.parts_xml
  // 2. Remove from parts_xml
  // 3. Add to game_parts_inventory
  // 4. Return success
}
```

### Scenario 3: Player buys 5 turbos, installs on different cars
```javascript
// With inventory system:
// 1. Buy 5 turbos -> game_parts_inventory: {part_catalog_id: 1001, quantity: 5}
// 2. Install on car1 -> quantity: 4, car1.parts_xml updated
// 3. Install on car2 -> quantity: 3, car2.parts_xml updated
// etc.

// Without inventory system:
// 1. Buy turbo for car1 -> car1.parts_xml updated
// 2. Buy turbo for car2 -> car2.parts_xml updated
// (Must buy separately for each car)
```

## Recommendations

### For Basic Gameplay
Keep the current direct install system:
- Simple and works well
- Players buy and install in one action
- No inventory management complexity

### For Advanced Features
Add inventory system:
- Implement `uninstallpart` action
- Allow parts to be moved between cars
- Support bulk buying (buy 10 turbos at once)
- Enable trading/gifting between players

### Hybrid Approach (Recommended)
```javascript
// Add a "install_immediately" flag to buypart
handleBuyPart({ install_immediately = true }) {
  if (install_immediately) {
    // Current behavior: install directly on car
  } else {
    // New behavior: add to inventory
  }
}
```

This gives players the choice:
- Quick install for immediate use
- Inventory for planning/stockpiling

## Code Examples

### Check what parts are on a car
```javascript
const car = await getCarById(supabase, carId);
const partsXml = car.parts_xml || "";

// Parse parts
const parts = [];
const regex = /<p\b[^>]*\/>/g;
let match;
while ((match = regex.exec(partsXml)) !== null) {
  const part = {};
  const attrRegex = /(\w+)='([^']*)'/g;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(match[0])) !== null) {
    part[attrMatch[1]] = attrMatch[2];
  }
  parts.push(part);
}

console.log(`Car has ${parts.length} parts installed`);
```

### Add a part to inventory
```javascript
await addPartInventoryItem(supabase, playerId, partCatalogId, 1);
```

### Install a part from inventory
```javascript
const item = await consumePartInventoryItem(supabase, inventoryId, playerId);
const catalogPart = getCatalogPartById(item.part_catalog_id);
const installId = createInstalledPartId();
const installedPartXml = buildOwnedInstalledCatalogPartXml(catalogPart, installId);
const partsXml = upsertInstalledPartXml(car.parts_xml || "", catalogPart.pi, installedPartXml);
await supabase.from("game_cars").update({ parts_xml: partsXml }).eq("game_car_id", carId);
```

## Summary

**Parts per car** means each car has its own `parts_xml` field that stores all installed parts as XML. Parts are independent between cars - installing a turbo on car1 doesn't affect car2.

The system supports two modes:
1. **Direct install** - Buy and install in one action (current default)
2. **Inventory system** - Buy to inventory, install later (partially implemented)

For most use cases, the direct install system is sufficient. The inventory system adds complexity but enables advanced features like part swapping and bulk buying.
