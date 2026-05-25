-- Author the city map topography for the visible Grinhaven playable set.
--
-- Until now CityMapModal placed exits radially around the current location:
-- it conveyed "here is the local cluster" but not where these places sit on
-- the city. The grinhaven cartridge already encodes district relationships
-- via topology_parent_id; this migration adds the missing piece — a 2D
-- compass position per visible location, plus a district colour for
-- grouping — so the rail map can render the actual city geography.
--
-- Coordinate system: x and y are 0-100 normalized. Compass mapping:
--   x =  0 → west,  x = 100 → east
--   y =  0 → north, y = 100 → south
-- These are intentionally coarse; the city map renderer maps them onto
-- whatever pixel canvas it draws on. 20 visible locations + the new market
-- square fit cleanly without overlap when rendered at >=720x420.
--
-- Topography is derived from the cartridge prose:
--   - Steelgate Ward sits north-east of centre and hosts the
--     adventurers'/civil cluster: Guildhall of Belmorah, the Laughing
--     Mare, Ale & Eats, the Sunfields Dawn-Gate shed.
--   - The Velvet Quarter is the western brothel quarter, with Meow Meow
--     Paradise / Nectar / The Velvet Tally / Slime Sauna / Tentacle Grotto.
--   - Hearthreach sits south of centre and is the bank-and-canal district;
--     Mercantile Compact Hall and Silver Cellar live here.
--   - Holyhigh is the temple district due north.
--   - Coin Tier is the commercial corridor due east.
--   - Sunfields is south-southwest (farm/granary).
--   - Silver Below is south-east (subterranean).
--   - Grinhaven Full Travel Hub is the off-map gate to the east.
--   - The new Grinhaven Main Market Square is dead centre.
--
-- District colours are inline (no separate table) so the renderer can
-- consume them straight from profile.map_district_color.

UPDATE entities
   SET profile = profile
              || jsonb_build_object(
                   'map_position', jsonb_build_object('x', m.x, 'y', m.y),
                   'map_district_color', m.color
                 )
  FROM (VALUES
    -- id,    x,   y,    color (hex)
    (201236,  50,  50, '#d4a868'),  -- Grinhaven Main Market Square (centre, gold)

    -- Districts (large coloured zones)
    (201001,  68,  28, '#a8743a'),  -- Steelgate Ward (NE bronze)
    (201002,  22,  48, '#7d3a8c'),  -- Velvet Quarter (W purple)
    (201003,  82,  50, '#c8a23c'),  -- Coin Tier (E gold)
    (201004,  50,  14, '#d4c87a'),  -- Holyhigh (N pale gold)
    (201005,  50,  74, '#b8674a'),  -- Hearthreach (S terracotta)
    (201006,  78,  82, '#8da0b0'),  -- Silver Below (SE silver-grey)
    (201007,  26,  82, '#7aa468'),  -- Sunfields (SW green)

    -- Velvet Quarter venues (cluster around 22,48)
    (201008,  28,  56, '#7d3a8c'),  -- The Velvet Tally
    (201012,  18,  44, '#7d3a8c'),  -- Meow Meow Paradise
    (201015,  20,  50, '#7d3a8c'),  -- Nectar
    (201017,  14,  56, '#7d3a8c'),  -- Slime Sauna
    (201018,  10,  62, '#7d3a8c'),  -- Tentacle Grotto

    -- Steelgate Ward venues (cluster around 68,28)
    (201009,  72,  24, '#a8743a'),  -- Guildhall of Belmorah
    (201010,  76,  30, '#a8743a'),  -- The Laughing Mare
    (201016,  64,  18, '#a8743a'),  -- Sunfields Dawn-Gate Shed
    (201019,  68,  38, '#a8743a'),  -- Ale & Eats

    -- Hearthreach venues
    (201011,  44,  78, '#b8674a'),  -- The Silver Cellar
    (201014,  56,  72, '#b8674a'),  -- Mercantile Compact Hall

    -- Holyhigh venue
    (201013,  50,   8, '#d4c87a'),  -- Great Temple of Freyla

    -- Off-map gate
    (201000,  94,  50, '#9aa0a8')   -- Grinhaven Full Travel Hub
  ) AS m(id, x, y, color)
 WHERE entities.id = m.id
   AND entities.kind IN ('location', 'district');
