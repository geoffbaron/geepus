# Terrain Flight

A little native macOS flight simulator inspired by
[xandergos/terrain-diffusion](https://github.com/xandergos/terrain-diffusion) —
"a learned successor to Perlin noise for infinite, deterministic, and
randomly-accessible real-time terrain generation."

This game borrows that pitch wholesale: the world is **infinite, deterministic,
and randomly accessible**. Terrain streams in as 64×64-quad chunks at **30 m
per vertex** (a nod to the `terrain-diffusion-30m` model), generated on the fly
from a seed — domain-warped continents, ridged mountain ranges, coastal
shelves, wandering snowlines, and a moisture field that decides between steppe,
grassland, and forest. Same seed, same planet, every time. It doesn't run the
diffusion model itself (CPU-only Macs and diffusion sampling don't make for a
60 fps game loop), but the terrain design mimics the DEM-style output the model
produces.

Rendered with SceneKit. No dependencies, no asset files — everything is
generated at runtime:

- **Aircraft**: a high-wing Cessna-style model skinned from fuselage
  cross-sections and real airfoil profiles (tapered wings with dihedral,
  struts, gear, spinning prop), built as custom meshes in code.
- **Sky & weather**: each seed gets deterministic weather — wind direction and
  speed (shown in the HUD, felt in flight as drift, gusts, and light
  turbulence), cloud coverage, haze. The sky is a per-pixel generated cubemap
  (gradient + sun disc) that also drives image-based lighting; clouds are
  streamed billboard cumulus clusters.
- **Terrain look**: satellite-style palette (steppe → olive → lush grass by a
  moisture field, forest patches, rock strata, wandering snowlines), cavity
  shading in valleys, and a tiled detail texture over the vertex colors.
- **Lakes & rivers**: carved below a wandering water table — winding channels
  and lake systems with depth-tinted freshwater, all visible on the radar.
- **Forests & towns**: low-poly conifer forests (snow-dusted near the
  snowline) and box-building settlements on flat lowlands, merged into one
  mesh per chunk so they render in a single draw call each.
- **Living sky**: layered drifting cumulus with darker bases, a high cirrus
  veil, and weather that evolves — wind veers and gusts over minutes while
  the haze thickens and clears. Some seeds are deep winter (low snowlines).
- **Animated ocean**: a vertex shader rolls gentle waves through the water so
  sun glints move; shallows fade turquoise over sand.

## Run

```bash
cd TerrainFlight
swift run -c release              # default world (seed 30)
swift run -c release TerrainFlight 1234   # any seed = a different planet
```

## Fly

| Key | Action |
| --- | --- |
| ↑ / ↓ | Pitch (↓ pulls the nose up, flight-stick style) |
| ← / → | Roll — bank to turn |
| A / D | Rudder |
| W / S | Throttle up / down |
| Space | Fire guns (dogfight mode) |
| G | Toggle game mode: Free Flight ↔ WW2 Dogfight |
| V | Cycle plane: Cessna → Spitfire → Jet |
| C | Toggle cockpit / chase view |
| R | Respawn (random coastal location) |

On-screen buttons (top-right) mirror the mode/view/respawn actions, and a
heading-up radar minimap (bottom-right) shows the terrain and bandit contacts
within 4 km — bandits that fall far behind rejoin the fight in front of you.
| H | Toggle help text |
| ⌘Q | Quit |

## Dogfight mode

Press **G** (or launch with `--dogfight`) to swap the Cessna for a
Spitfire-style fighter and put four Bf 109-style bandits in the air. Your
controls and flight model stay identical in both modes; only the airplane
model and the company you keep change. They pursue with lead, break off when they
overshoot, evade when you're on their six, avoid terrain, and shoot back in
bursts. Wing guns converge 350 m ahead of the crosshair; four hits sets a bandit
smoking, six sends it spiraling in. Kills, HP, and bandit count are on the HUD; downed
bandits are replaced after a few seconds so the fight never ends. Press G again
to go back to sightseeing.

Arcade flight model: banking turns you, diving builds speed, and below
~42 m/s the plane stalls and mushes toward the ground. Hitting terrain or
water respawns you at the coastal spawn point.

## How it relates to terrain-diffusion

- **Infinite + deterministic + randomly accessible**: any chunk's heights are a
  pure function of `(seed, x, z)` — chunks generate independently in any order,
  exactly the property the diffusion model is built around.
- **30 m/pixel**: vertex spacing matches the 30 m model's resolution.
- **Elevation in meters, sea level at 0**: matches its GeoTIFF output
  convention, with the ocean as an infinite reflective plane.
- **Climate-ish coloring**: a low-frequency moisture field picks biome colors,
  echoing the model's temperature/precipitation outputs.
