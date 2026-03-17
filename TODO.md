# TODO - Indonesia AIS Filter

## Task: Show only ships located in Indonesia

### Steps:
- [x] Analyze codebase and create plan
- [x] Add Indonesia filter function in app.js
- [x] Add UI filter button in index.html
- [x] Test the implementation

### Indonesia Geographic Bounds:
- Latitude: -11° to 6° (approximately)
- Longitude: 95° to 141° (approximately)

### Implementation Complete:
- Added `showIndonesiaOnly` global variable
- Added `INDONESIA_BOUNDS` constant with Indonesia's approximate boundaries
- Added `isShipInIndonesia()` function to check if ship coordinates are within Indonesia
- Added `toggleIndonesiaFilter()` function to toggle filter on/off
- Added `centerMapToIndonesia()` function to center map on Indonesia when filter is enabled
- Modified WebSocket message handlers to filter ships based on Indonesia bounds
- Added filter button in the map panel header with toggle functionality
- Added `cleanupInactiveShips()` function to remove ships that haven't been updated in 5 minutes from the map (runs every 30 seconds)
- Added `updateAISSourceDisplay()` function to show AIS source (TCP/Serial USB/Simulasi) in stats bar

