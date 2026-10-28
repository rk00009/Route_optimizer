# Route Optimizer — VS Code Setup

This version serves the frontend and provides a small Node.js backend. The browser calls the local backend; the backend contacts public geocoding/routing services and tries a backup routing provider if the primary provider fails.

## Requirements
- Node.js 18 or newer (Node 20 LTS recommended)
- VS Code
- Internet connection for map tiles, address lookup, and routing

## Run it
1. Extract this folder somewhere easy to find.
2. Open the `route-optimizer-vscode` folder in VS Code (`File > Open Folder`).
3. In VS Code, open `Terminal > New Terminal`.
4. Check Node is installed:
   ```bash
   node -v
   npm -v
   ```
5. Start the project:
   ```bash
   npm start
   ```
6. Open **http://localhost:3000** in Chrome. Do not open `public/index.html` directly and do not use Live Server for this setup.
7. Enter a warehouse and PO delivery locations. Each PO needs a positive volume, and can optionally have an ID, category, weight, and geographic group. Select and confirm a geocoding candidate for every address, or enter valid latitude/longitude pairs manually.
8. Add trucks and enter each nominal volume capacity. The default 10% safety buffer can be changed; payload limits are optional.
9. Click **Allocate trucks & optimize routes**.

The application starts with sample data loaded from the supplied Lily Factory warehouse and three delivery locations. Use **Load sample PO data** any time to restore that dataset. The sample uses PO volumes of 12, 10, and 8 m³, two trucks of 30 and 20 m³, and a 0% buffer so the complete 30 m³ example is visible immediately. **Reset all inputs** returns to blank entry cards.

## Stop / restart
- Stop: press `Ctrl+C` in the VS Code terminal.
- Start again: `npm start`.
- If port 3000 is busy, on PowerShell run:
  ```powershell
  $env:PORT=3001; npm start
  ```
  Then open `http://localhost:3001`.

## Troubleshooting
- `node is not recognized`: install Node.js LTS from https://nodejs.org, then fully close and reopen VS Code.
- `EADDRINUSE`: port 3000 is already being used; use the alternate-port command above.
- `Road-distance service is unavailable`: the public routing providers are unreachable from the computer/network at that moment. Try again later or connect a dedicated routing API/provider. This local backend avoids browser CORS restrictions but cannot make a public provider available if it is down or blocked.
- Address search tries Photon, Nominatim, and ArcGIS World Geocoder. It starts with the exact address and may make a small number of controlled broader locality searches when the exact query has no result. Broader candidates are labeled and all candidates are shown for explicit confirmation; the first result is never silently accepted. Public map data may still miss informal/local landmark names. You can also paste a Google Maps link: the application extracts its embedded latitude/longitude locally and does not call Google APIs. Avoid repeated bulk geocoding requests because public services have usage limits and no uptime guarantee.

## Priority rules
- Each numbered priority can be assigned to only one delivery stop.
- Smaller number = higher priority (1 before 2 before 3...).
- Priority is optional. Leave a stop set to **Auto optimize** when it has no required priority.
- If all stops are set to Auto optimize, the application optimizes their order together by road distance.
- When only some stops are unassigned, assigned priorities are visited first and Auto optimize stops are handled as the final group.
- Within each priority group, the app uses road-distance nearest-neighbour followed by a 2-opt improvement. This is a practical heuristic, not a proof of globally shortest route.
- The route returns to the warehouse by default.

## PO allocation
- Geographic grouping happens before allocation. An explicit group (for example `Uttarakhand`) is never merged with another explicit group; POs without a group can share a corridor when coordinates are within the configured proximity threshold in `allocation.js`.
- The solver first attempts to place a complete group on one available truck. If that is not feasible, it uses exact subset selection for small groups to maximize assigned volume without splitting a PO, with a bounded heuristic for larger groups.
- Usable volume is `nominal capacity × (1 - safety buffer / 100)`. The UI shows nominal utilization, usable-capacity utilization, and remaining usable volume.
- Payload is checked only when enabled and both a truck limit and the relevant PO weights are available. Missing weights do not create false payload failures.
- Every allocated truck gets an independent road route starting and ending at the warehouse. Routing failures remain visible as errors; the application does not fabricate road distances or costs.

## Test and example
Run the allocator tests with:
```bash
npm test
```
For the example from the requirements, add POs A=12 m³, B=10 m³, and C=8 m³ in one geographic group, set Truck 1 to 30 m³ and Truck 2 to 20 m³, and set the safety buffer to 0%. The first truck receives all three POs (30 m³, 100% usable utilization). If Truck 1 is removed or unavailable, Truck 2 receives A+C (20 m³) and B is reported unassigned until another suitable truck is added.

## Project files
- `server.js`: local web server, geocoding and routing proxy endpoints.
- `public/index.html`: frontend UI and route optimizer.
- `allocation.js`: validated geographic grouping, whole-PO bin packing, utilization calculations, and unassigned-PO reasons.
- `allocation.test.js`: allocator regression tests.
- `package.json`: start scripts.

## Service limitations
Photon, Nominatim, OSRM, and the OpenStreetMap tile service are public services. They may rate-limit requests, reject automated traffic, change availability, or contain incomplete map data. The backend reports provider failures instead of drawing a straight line and labeling it as a road route. No Google Maps key or paid service is required.

## Validation and route behavior
- Coordinates are validated against latitude (-90 to 90) and longitude (-180 to 180).
- Address text is preserved separately from the selected geocoded result.
- The route always follows the displayed priority order and uses the returned OSRM road geometry, distance, and duration.
- If the routing provider cannot calculate the route, the application displays an error and does not present a misleading fallback route.
