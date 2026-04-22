Original prompt: cant see the drop down menu items, make it easier to read, and change the car thumbnail for all cars to the actual picture of said car, or get a jpg from the game
i also should be able to tune every aspect of each parts, and be able to press an apply all button that send that build into the game

- Replaced the tuning-studio native slot selects with a custom dark picker so option text is readable on Windows/browser dropdown surfaces.
- Added per-slot advanced XML override editing to the studio payload. Current UI exposes common part attrs directly plus an extra-attrs textarea for arbitrary non-reserved XML keys.
- Added `/api/tuning-studio/session` and `/api/tuning-studio/apply` in the backend. Apply resolves the active session, verifies the target car belongs to the player, enforces catalog-car match, then writes the generated `parts_xml` to the chosen garage car and selects it.
- Local cache inspection found game brand/logo SWFs and decal JPGs, but not a clean per-car JPG thumbnail set. The current UI now has richer branded car cards; true car-photo/game-render thumbnails still need either SWF extraction or another asset source.
- Need smoke-test on a running local server, then redeploy `src/http-server.js`, `src/tuning-studio.js`, and `src/tuning-studio.html`.
