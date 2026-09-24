# Walks of Sennaar

An endless, procedurally generated walk through the sunlit terraces of the Devotees, in the style of *Chants of Sennaar*. There is no dialogue, notebook, inventory or puzzle, only the megastructure. It keeps going in every direction for as long as you want to walk.

![A sunken court of the Devotees' terraces](docs/screenshot.jpg)

## Running it

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # static site in dist/
npm test          # connectivity + walking checks (headless, Node 22)
```

`dist/` is a plain static site (relative paths). You can host it anywhere. `.github/workflows/pages.yml` publishes it to GitHub Pages on every push to `main`. For that to work, set the repository's **Settings → Pages → Source** to **GitHub Actions**.

Add `?seed=<number>` to the URL to walk a different world. The help panel (the **?** button) also has a link to a random one.

## Controls

| | |
|---|---|
| Walk | **WASD** / arrow keys, or **click** a spot (the traveller finds the way, stairs included) |
| Run | hold **Shift**, or **double-click** |
| Wander | hold the mouse button: the traveller walks towards the pointer |
| Turn the view | **Q** / **E** (45° steps) or right-drag |
| Zoom | mouse wheel, **+** / **−** |
| Touch | tap to walk, double-tap to run, hold to wander, two fingers to turn and zoom |
| Gamepad | left stick walks, right stick turns, bumpers rotate in steps, triggers zoom, **A** runs |
| Other | **M** toggles sound, **H** hides the interface |

## How it works

### The world

The world is an infinite grid of 64 m **blocks**. Each block has 32 × 32 cells of 2 m, and is generated on its own from `(seed, bx, bz)` inside Web Workers (`src/world/`):

1. **Plots.** A BSP cut splits the block into rectangular plots. Each plot is a solid mass. Its top is either a walkable terrace, or a building with a hip, pyramid or flat roof. Terrace heights come in 3 m levels.
2. **Guaranteed connectivity.** Every block edge has a *gate* cell. Its level depends only on that edge, so the blocks on both sides agree on it. The gate levels around a block span at most two levels. This holds because the underlying height field is Lipschitz-bounded (see `anchorField`). A spine of plots links the four gates, and its levels stay within that span, so every step on the spine can be climbed. All other terraces branch off the spine as a tree. Together, these rules make the walkable world one infinite connected region: you can never walk into a dead pocket. Stair placement also refuses any position that would cut a plot in two.
3. **Stairs.** Every level change on the tree gets a stair. It is either a straight flight into the lower terrace, a flight cut into the upper terrace, a split between the two, or a flight running along the retaining wall with a landing at the top. Flights that stand proud get cheek walls and sloped balustrades.
4. **Furnishing.** Cloisters with arcades around lawns and quatrefoil pools. Hexagonal fountains, the golden sun-idol on its inscribed plinth, great pointed gateways, horseshoe arches with red and cream voussoirs, arcades along the drops, planters of agave and broad leaves, palms, urns, benches, and a few silent devotees. Terraces that no path reaches sink into deep courts.
5. **Walls.** Every retaining wall is a facade. It gets rows of pointed, twin, tall or blind-arched windows, cornices, string courses and doors (teal leaves with red diamonds). The pattern is chosen per wall and per storey, so each facade stays consistent.

Each block becomes a single merged mesh, with a compact vertex format (float positions, byte normals and a per-vertex material id). Blocks stream in and out around the traveller.

### The look

`src/render/` renders everything with one custom shader and a post pass:

- two-tone cel lighting from a fixed low sun, with cached static shadows plus a small dynamic shadow map for the traveller
- a palette per material: lemon floors, ochre walls, crimson roofs, teal plants and water
- fine etched hatching in world space, heavier in shade
- the game's signature gradient: surfaces turn from yellow through orange to magenta the further they lie below the traveller
- ink outlines from depth, normal and material discontinuities, plus paper grain and a warm vignette
- a see-through window cut into anything that hides the traveller

### Walking

Collision uses the block data directly. It combines floor heights and stair ramps, blocked edges (balustrades and stair cheeks), and circles and boxes for props. Click-to-walk runs A* on a 0.5 m lattice with a little clearance, smooths the result with line-of-sight checks, and re-plans if the traveller gets blocked.

### Checks

- `tools/connectivity.mjs [seed] [radius] [bx] [bz]` flood-fills the real collision model over a square of blocks. It verifies that every gate is reached, and reports any standable cell left unreached.
- `tools/walksim.mjs [seed] [trips]` plans random click-to-walk trips and simulates the traveller following them with the real movement code.

## Credits

A fan homage to *Chants of Sennaar* (Rundisc, 2023). No assets from the game are used: all geometry is procedural and every colour is picked by hand. Built with [three.js](https://threejs.org) and [Vite](https://vite.dev). MIT licensed.
