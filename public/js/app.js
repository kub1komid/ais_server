// ==================== GLOBAL VARIABLES ====================
let map;
let ships = new Map();
let ws;
let messageCount = 0;
let startTime = Date.now();
let autoRefresh = true;
let shipMarkers = new Map();
let portMarkers = new Map();
let currentTab = 'map';
let cctvList = [];
let currentUser = null;
let ports = [];
let showIndonesiaOnly = false;
let showActiveShipsOnly = true;

// Indonesia Geographic Bounds (approximate)
const INDONESIA_BOUNDS = {
    minLat: -11.0,
    maxLat: 6.0,
    minLon: 95.0,
    maxLon: 141.0
};

// Dynamic AIS Center - computed from recent ships or default
let AIS_CENTER = {
    lat: -5.5369,
    lon: 105.3587
};

let recentShips = []; // Track last 20 ships for center calculation
const MAX_RECENT_SHIPS = 20;

function updateAISCenter() {
    if (recentShips.length < 3) return; // Need min 3 ships
    
    const lats = recentShips.map(s => s.latitude || s.lat).filter(Boolean);
    const lons = recentShips.map(s => s.longitude || s.lon).filter(Boolean);
    
    if (lats.length < 3) return;
    
    const avgLat = lats.reduce((a, b) => a + b, 0) / lats.length;
    const avgLon = lons.reduce((a, b) => a + b, 0) / lons.length;
    
    AIS_CENTER = { lat: avgLat, lon: avgLon };
    console.log(`AIS Center updated: ${AIS_CENTER.lat.toFixed(4)}, ${AIS_CENTER.lon.toFixed(4)}`);
    
    // Reapply filters with new center
    reapplyAllFilters();
}

// Update recentShips in WS update handler

// Haversine distance function (nautical miles)
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distanceKm = R * c;
    return distanceKm / 1.852; // Convert km to nautical miles
}

// Check if ship is within 40 NM of AIS receiver
function isWithin40NM(ship) {
    const lat = ship.latitude || ship.lat;
    const lon = ship.longitude || ship.lon;
    if (!lat || !lon) return false;
    const distance = haversineDistance(AIS_CENTER.lat, AIS_CENTER.lon, lat, lon);
    return distance <= 40;
}

// Check if ship is within Indonesia bounds
function isShipInIndonesia(ship) {
    const lat = ship.latitude || ship.lat;
    const lon = ship.longitude || ship.lon;
    if (!lat || !lon) return false;
    return lat >= INDONESIA_BOUNDS.minLat && 
           lat <= INDONESIA_BOUNDS.maxLat && 
           lon >= INDONESIA_BOUNDS.minLon && 
           lon <= INDONESIA_BOUNDS.maxLon;
}

// Check if ship is active (updated in last 5 minutes)
function isShipActive(ship) {
    if (!ship.lastUpdate) return false;
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    return ship.lastUpdate > fiveMinutesAgo;
}

let showDistanceFilter = false; // Default OFF to ensure ships show

// ==================== AUTH CHECK ====================
function checkAuth() {
    const auth = localStorage.getItem('ais_auth');
    if (!auth) {
        window.location.href = 'login.html';
        return null;
    }
    return JSON.parse(auth);
}

function logout() {
    localStorage.removeItem('ais_auth');
    window.location.href = 'login.html';
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    currentUser = checkAuth();
    if (!currentUser) return;
    
    const userEl = document.getElementById('userName');
    if (userEl) userEl.textContent = currentUser.name || currentUser.username;
    
    initMap();
    connectWebSocket();
    startUptimeTimer();
    initTabSystem();
    loadPorts();
    
    // Start cleanup interval for inactive ships (every 30 seconds)
    setInterval(cleanupInactiveShips, 30000);
});

// ==================== TAB SYSTEM ====================
function initTabSystem() {}

function switchTab(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
    const panel = document.getElementById(`tab-${tabName}`);
    if (panel) panel.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const navItem = document.getElementById(`nav-${tabName}`);
    if (navItem) navItem.classList.add('active');

    if (tabName === 'map' && map) setTimeout(() => map.invalidateSize(), 50);
    
    // Load CCTV data when switching to CCTV tab
    if (tabName === 'cctv') loadCCTV();
}

// ==================== MAP INITIALIZATION ====================
function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true, tap: true }).setView([-6.2, 106.8], 10);
    
    // Base layer - OpenStreetMap
    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { 
        attribution: '© OpenStreetMap', 
        maxZoom: 18 
    });
    
    // OpenSeaMap layer - nautical marks
    const openSeaMapLayer = L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', { 
        attribution: '© OpenSeaMap',
        maxZoom: 18 
    });
    
    // Add OSM as default
    osmLayer.addTo(map);
    
    // Add OpenSeaMap overlay (nautical marks)
    openSeaMapLayer.addTo(map);
    
    // Layer control
    L.control.layers({
        'Peta': osmLayer,
        'OpenSeaMap': openSeaMapLayer
    }, {
        'Marka Laut': openSeaMapLayer
    }, { collapsed: true, position: 'topright' }).addTo(map);
    
    L.control.scale({ imperial: false }).addTo(map);
}

// ==================== WEBSOCKET ====================
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => { console.log('WebSocket connected'); updateConnectionStatus(true); };
    ws.onmessage = (event) => { try { handleWebSocketMessage(JSON.parse(event.data)); } catch (e) { console.error(e); } };
    ws.onerror = (error) => { console.error('WebSocket error:', error); updateConnectionStatus(false); };
    ws.onclose = () => { console.log('WebSocket disconnected'); updateConnectionStatus(false); setTimeout(connectWebSocket, 3000); };
}

function handleWebSocketMessage(data) {
    messageCount++;
    setEl('messagesReceived', messageCount);

    if (data.type === 'init') {
        // Initialize recent ships
        recentShips = data.ships.slice(-MAX_RECENT_SHIPS);
        updateAISCenter();
        
        data.ships.forEach(ship => { 
            ships.set(ship.mmsi, ship); 
            const passesFilters = passesAllFilters(ship);
            if (passesFilters) {
                addShipMarker(ship);
            }
        });
        updateShipList(); updateStats();
    } else if (data.type === 'update') {
        ships.set(data.ship.mmsi, data.ship);
        
        // Update recent ships for dynamic center
        recentShips = [data.ship, ...recentShips.filter(s => s.mmsi !== data.ship.mmsi)].slice(0, MAX_RECENT_SHIPS);
        updateAISCenter();
        
        const passesFilters = passesAllFilters(data.ship);
        const marker = shipMarkers.get(data.ship.mmsi);
        if (!passesFilters && marker) {
            marker.remove();
            shipMarkers.delete(data.ship.mmsi);
        } else if (passesFilters) {
            updateShipMarker(data.ship);
        }
        updateShipList(); updateStats();
    } else if (data.type === 'static') {
        const existing = ships.get(data.ship.mmsi);
        if (existing) ships.set(data.ship.mmsi, { ...existing, ...data.ship });
        else { 
            ships.set(data.ship.mmsi, data.ship); 
            const passesFilters = passesAllFilters(data.ship);
            if (passesFilters) {
                addShipMarker(data.ship);
            }
        }
        updateShipList(); updateStats();
    } else if (data.type === 'aisStatus') {
        // Update AIS source display
        updateAISSourceDisplay(data.status);
    }

    const now = new Date();
    setEl('lastUpdate', now.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
}

function passesAllFilters(ship) {
    const inIndonesia = !showIndonesiaOnly || isShipInIndonesia(ship);
    const isActive = !showActiveShipsOnly || isShipActive(ship);
    const withinRange = !showDistanceFilter || isWithin40NM(ship);
    return inIndonesia && isActive && withinRange;
}

function updateAISSourceDisplay(status) {
    let sourceText = '-';
    if (status.serial && status.serial.connected) {
        sourceText = 'Serial USB';
    } else if (status.tcp && status.tcp.connected) {
        sourceText = 'TCP';
    } else if (status.simulation && status.simulation.enabled) {
        sourceText = 'Simulasi';
    }
    setEl('aisSourceStatus', sourceText);
}

function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('wsStatus');
    if (!statusEl) return;
    statusEl.className = `status-indicator ${connected ? 'connected' : 'disconnected'}`;
    statusEl.innerHTML = `<span class="status-dot"></span><span class="status-text">${connected ? 'Online' : 'Offline'}</span>`;
}

// ==================== SHIP STATUS DETECTION ====================
function getShipStatusInfo(ship) {
    const status = ship.status || '';
    const sog = ship.sog || ship.speed || 0;
    
    const isAtAnchor = status.toLowerCase().includes('anchor') || 
                      status.toLowerCase().includes('moored') ||
                      status.toLowerCase().includes('berlabuh') ||
                      status.toLowerCase().includes('sandar') ||
                      sog < 0.5;
    
    const isUnderway = !isAtAnchor && sog >= 0.5;
    
    if (isAtAnchor) {
        return { type: 'anchored', label: 'Berlabuh', color: '#e53935', iconColor: '#e53935' };
    } else if (isUnderway) {
        return { type: 'underway', label: 'Berlayar', color: '#4caf50', iconColor: '#4caf50' };
    }
    return { type: 'unknown', label: 'Bergerak', color: '#4caf50', iconColor: '#4caf50' };
}

// ==================== STANDARD AIS MARITIME ICONS ====================
// Standard AIS Maritime Traffic Icons - IMO compliant symbols

function createShipIconSVG(color, heading = 0, blinking = false) {
    // Standard AIS symbol: isosceles triangle pointing in direction of heading
    // Rotated based on ship's heading (0 = North = pointing up)
    const rotation = (heading - 90) || 0; // Adjust so 0 heading = pointing up
    const blinkStyle = blinking ? 'animation: blink 1s infinite;' : '';
    return `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" style="transform: rotate(${rotation}deg); ${blinkStyle}">
        <defs>
            <filter id="ship-glow${color.replace('#','')}" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
            <style>
                @keyframes blink {
                    0%, 50% { opacity: 1; }
                    51%, 100% { opacity: 0.4; }
                }
            </style>
        </defs>
        <!-- AIS Triangle Symbol - points to top (north) before rotation -->
        <polygon points="16,2 26,28 16,22 6,28" fill="${color}" stroke="white" stroke-width="1.5" filter="url(#ship-glow${color.replace('#','')})"/>
        <!-- Center dot -->
        <circle cx="16" cy="16" r="2" fill="white"/>
    </svg>`;
}

function createAnchorIconSVG(color) {
    // Standard AIS anchored symbol: diamond/rhombus shape
    return `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <filter id="anchor-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
                <feMerge>
                    <feMergeNode in="coloredBlur"/>
                    <feMergeNode in="SourceGraphic"/>
                </feMerge>
            </filter>
        </defs>
        <!-- AIS Diamond Symbol for anchored/moored vessels -->
        <polygon points="16,4 26,16 16,28 6,16" fill="${color}" stroke="white" stroke-width="1.5" filter="url(#anchor-glow)"/>
        <!-- Inner diamond -->
        <polygon points="16,8 22,16 16,24 10,16" fill="white" opacity="0.3"/>
        <!-- Center dot -->
        <circle cx="16" cy="16" r="2" fill="white"/>
    </svg>`;
}

// ==================== MAP MARKERS ====================
function addShipMarker(ship) {
    if (!ship.latitude || !ship.longitude) return;
    const statusInfo = getShipStatusInfo(ship);
    const sog = ship.sog || ship.speed || 0;
    const isMoving = sog >= 0.5 && statusInfo.type !== 'anchored';
    const iconHtml = statusInfo.type === 'anchored' ? createAnchorIconSVG(statusInfo.iconColor) : createShipIconSVG(statusInfo.iconColor, ship.heading || 0, isMoving);
    const icon = L.divIcon({ className: 'ship-marker', html: `<div class="ship-icon">${iconHtml}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] });
    const marker = L.marker([ship.latitude, ship.longitude], { icon });
    marker.bindPopup(createShipPopup(ship, statusInfo));
    marker.on('click', () => showShipDetails(ship));
    marker.addTo(map);
    shipMarkers.set(ship.mmsi, marker);
}

function updateShipMarker(ship) {
    if (!ship.latitude || !ship.longitude) return;
    const statusInfo = getShipStatusInfo(ship);
    const sog = ship.sog || ship.speed || 0;
    const isMoving = sog >= 0.5 && statusInfo.type !== 'anchored';
    const marker = shipMarkers.get(ship.mmsi);
    if (marker) {
        marker.setLatLng([ship.latitude, ship.longitude]);
        marker.setPopupContent(createShipPopup(ship, statusInfo));
        if (statusInfo.type !== 'anchored') {
            const iconHtml = createShipIconSVG(statusInfo.iconColor, ship.heading || 0, isMoving);
            marker.setIcon(L.divIcon({ className: 'ship-marker', html: `<div class="ship-icon">${iconHtml}</div>`, iconSize: [32, 32], iconAnchor: [16, 16] }));
        }
    } else {
        addShipMarker(ship);
    }
}

function createShipPopup(ship, statusInfo) {
    const name = ship.vesselName || ship.name || `Kapal ${ship.mmsi}`;
    const sog = (ship.sog || ship.speed || 0).toFixed(1);
    const cog = (ship.cog || ship.course || 0).toFixed(1);
    return `<div class="ship-popup"><h4 style="color:${statusInfo.color}">${name}</h4><p><strong>MMSI:</strong> ${ship.mmsi}</p><p><strong>Status:</strong> <span style="color:${statusInfo.color}">${statusInfo.label}</span></p><p><strong>Kecepatan:</strong> ${sog} kn</p><p><strong>Jurusan:</strong> ${cog}°</p></div>`;
}

// ==================== SHIP LIST ====================
function updateShipList() {
    const shipArray = Array.from(ships.values());
    const count = shipArray.length;
    setEl('shipCount', `${count} kapal`);
    setEl('shipCountDesktop', `${count} kapal`);
    const navBadge = document.getElementById('navShipBadge');
    if (navBadge) { navBadge.textContent = count; navBadge.style.display = count > 0 ? 'flex' : 'none'; }

    if (count === 0) {
        const emptyHTML = `<div class="empty-state"><div class="empty-icon">🚢</div><p>Menunggu data kapal...</p></div>`;
        setElHTML('shipList', emptyHTML); setElHTML('shipListDesktop', emptyHTML);
        return;
    }

    shipArray.sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));
    const html = shipArray.map(ship => buildShipItemHTML(ship)).join('');
    setElHTML('shipList', html); setElHTML('shipListDesktop', html);
}

function buildShipItemHTML(ship) {
    const statusInfo = getShipStatusInfo(ship);
    const name = ship.vesselName || ship.name || `Kapal ${ship.mmsi}`;
    const sog = (ship.sog || ship.speed || 0).toFixed(1);
    const cog = (ship.cog || ship.course || 0).toFixed(1);
    const lastUpdate = ship.lastUpdate ? Math.floor((Date.now() - ship.lastUpdate) / 1000) + 's' : '-';
    return `<div class="ship-item" onclick='showShipDetails(${JSON.stringify(ship)})'><div class="ship-item-header"><span class="ship-name">${escapeHtml(name)}</span><span class="ship-mmsi">${ship.mmsi}</span></div><div class="ship-item-details"><div class="ship-detail"><span class="detail-label">Status</span><span class="detail-value" style="color:${statusInfo.color}">${statusInfo.label}</span></div><div class="ship-detail"><span class="detail-label">Speed</span><span class="detail-value">${sog} kn</span></div><div class="ship-detail"><span class="detail-label">Course</span><span class="detail-value">${cog}°</span></div></div><div class="ship-item-footer"><span class="ship-update">${lastUpdate}</span></div></div>`;
}

// ==================== STATISTICS ====================
function updateStats() {
    const shipArray = Array.from(ships.values());
    setEl('totalShips', shipArray.length);
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    setEl('activeShips', shipArray.filter(s => s.lastUpdate && s.lastUpdate > fiveMinutesAgo).length);
}

function startUptimeTimer() {
    setInterval(() => {
        const elapsed = Date.now() - startTime;
        const h = Math.floor(elapsed / 3600000), m = Math.floor((elapsed % 3600000) / 60000), s = Math.floor((elapsed % 60000) / 1000);
        setEl('uptime', `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
    }, 1000);
}

// ==================== MODAL ====================
function showShipDetails(ship) {
    const modal = document.getElementById('shipModal'), modalBody = document.getElementById('modalBody'), modalTitle = document.getElementById('modalShipName');
    const statusInfo = getShipStatusInfo(ship);
    const name = ship.vesselName || ship.name || `Kapal ${ship.mmsi}`;
    modalTitle.textContent = name;
    const lat = ship.latitude || ship.lat || '-', lon = ship.longitude || ship.lon || '-';
    const sog = (ship.sog || ship.speed || 0).toFixed(1), cog = (ship.cog || ship.course || 0).toFixed(1);
    modalBody.innerHTML = `<div class="ship-details-grid"><div class="detail-item"><label>MMSI</label><span>${ship.mmsi}</span></div><div class="detail-item"><label>Nama Kapal</label><span>${escapeHtml(name)}</span></div><div class="detail-item"><label>Call Sign</label><span>${ship.callSign || '-'}</span></div><div class="detail-item"><label>Status</label><span style="color:${statusInfo.color}">${statusInfo.label}</span></div><div class="detail-item"><label>Kecepatan (SOG)</label><span>${sog} kn</span></div><div class="detail-item"><label>Jurusan (COG)</label><span>${cog}°</span></div><div class="detail-item"><label>Heading</label><span>${ship.heading || 0}°</span></div><div class="detail-item"><label>Latitude</label><span>${typeof lat === 'number' ? lat.toFixed(5) : lat}</span></div><div class="detail-item"><label>Longitude</label><span>${typeof lon === 'number' ? lon.toFixed(5) : lon}</span></div></div><div class="modal-actions"><button class="btn" onclick="focusShipOnMap(${ship.mmsi})">📍 Lihat di Peta</button><button class="btn btn-secondary" onclick="closeModal()">Tutup</button></div>`;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeModal() {
    document.getElementById('shipModal').style.display = 'none';
    document.body.style.overflow = '';
}
window.addEventListener('click', (e) => { if (e.target.id === 'shipModal') closeModal(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function focusShipOnMap(mmsi) {
    const ship = ships.get(mmsi);
    if (ship && ship.latitude && ship.longitude) {
        switchTab('map');
        setTimeout(() => { map.setView([ship.latitude, ship.longitude], 15); const marker = shipMarkers.get(mmsi); if (marker) marker.openPopup(); }, 100);
    }
    closeModal();
}

function centerMap() {
    const shipArray = Array.from(ships.values()).filter(s => s.latitude && s.longitude);
    if (shipArray.length === 0) map.setView([-6.2, 106.8], 10);
    else if (shipArray.length === 1) map.setView([shipArray[0].latitude, shipArray[0].longitude], 13);
    else map.fitBounds(L.latLngBounds(shipArray.map(s => [s.latitude, s.longitude])), { padding: [40, 40] });
}

function toggleAutoRefresh() {
    autoRefresh = !autoRefresh;
    const btn = document.getElementById('autoRefreshBtn');
    if (btn) { btn.textContent = autoRefresh ? '🔄 Auto' : '⏸ Paused'; btn.classList.toggle('active', autoRefresh); }
}

function toggleFullscreen() {
    const mapContainer = document.querySelector('#tab-map');
    const btn = document.getElementById('fullscreenBtn');
    
    if (!document.fullscreenElement) {
        if (mapContainer.requestFullscreen) {
            mapContainer.requestFullscreen();
        } else if (mapContainer.webkitRequestFullscreen) {
            mapContainer.webkitRequestFullscreen();
        } else if (mapContainer.msRequestFullscreen) {
            mapContainer.msRequestFullscreen();
        }
        btn.textContent = '❎ Exit';
        btn.classList.add('active');
        if (map) map.invalidateSize();
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
        btn.textContent = '⛶ Full';
        btn.classList.remove('active');
        if (map) setTimeout(() => map.invalidateSize(), 100);
    }
}

// Fullscreen API events
document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('fullscreenBtn');
    if (btn && !document.fullscreenElement) {
        btn.textContent = '⛶ Full';
        btn.classList.remove('active');
    }
});
document.addEventListener('webkitfullscreenchange', () => {
    const btn = document.getElementById('fullscreenBtn');
    if (btn && !document.webkitFullscreenElement) {
        btn.textContent = '⛶ Full';
        btn.classList.remove('active');
    }
});

// ==================== INDONESIA FILTER ====================
function toggleIndonesiaFilter() {
    showIndonesiaOnly = !showIndonesiaOnly;
    const btn = document.getElementById('indonesiaFilterBtn');
    if (btn) {
        btn.classList.toggle('active', showIndonesiaOnly);
        btn.innerHTML = showIndonesiaOnly ? '🇮🇩 Indonesia' : '🌍 Semua';
    }
    
    reapplyAllFilters();
}

function toggleActiveShipsFilter() {
    showActiveShipsOnly = !showActiveShipsOnly;
    const btn = document.getElementById('activeFilterBtn');
    if (btn) {
        btn.classList.toggle('active', showActiveShipsOnly);
        btn.innerHTML = showActiveShipsOnly ? '⚡ Aktif' : '🚢 Semua';
    }
    
    reapplyAllFilters();
}

function toggleDistanceFilter() {
    showDistanceFilter = !showDistanceFilter;
    const btn = document.getElementById('distanceFilterBtn');
    if (btn) {
        btn.classList.toggle('active', showDistanceFilter);
        btn.innerHTML = showDistanceFilter ? '📡 40NM' : '📡 Semua';
        btn.title = showDistanceFilter ? 'Kapal dalam 40 mil laut dari AIS receiver' : 'Semua kapal';
    }
    
    reapplyAllFilters();
}

function reapplyAllFilters() {
    // Remove all non-passing markers
    ships.forEach((ship, mmsi) => {
        if (!passesAllFilters(ship)) {
            const marker = shipMarkers.get(mmsi);
            if (marker) {
                marker.remove();
                shipMarkers.delete(mmsi);
            }
        } else if (!shipMarkers.has(mmsi) && ship.latitude && ship.longitude) {
            addShipMarker(ship);
        }
    });
    
    updateShipList();
    updateStats();
}

function centerMapToIndonesia() {
    // Center on Indonesia
    map.setView([-2.5, 118], 5);
}

// ==================== CLEANUP INACTIVE SHIPS ====================
function cleanupInactiveShips() {
    // Only remove inactive ships if the filter is enabled
    if (!showActiveShipsOnly) return;
    
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    
    // Get ships that haven't been updated in 5 minutes
    ships.forEach((ship, mmsi) => {
        if (ship.lastUpdate && ship.lastUpdate < fiveMinutesAgo) {
            // Remove marker from map
            const marker = shipMarkers.get(mmsi);
            if (marker) {
                marker.remove();
                shipMarkers.delete(mmsi);
            }
        }
    });
    
    // Update the ship list and stats
    updateShipList();
    updateStats();
}

function toggleActiveShipsFilter() {
    showActiveShipsOnly = !showActiveShipsOnly;
    const btn = document.getElementById('activeFilterBtn');
    if (btn) {
        btn.classList.toggle('active', showActiveShipsOnly);
        btn.innerHTML = showActiveShipsOnly ? '⚡ Aktif' : '🚢 Semua';
    }
    
    if (showActiveShipsOnly) {
        // Remove inactive ships from map
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
        ships.forEach((ship, mmsi) => {
            if (!ship.lastUpdate || ship.lastUpdate < fiveMinutesAgo) {
                const marker = shipMarkers.get(mmsi);
                if (marker) {
                    marker.remove();
                    shipMarkers.delete(mmsi);
                }
            }
        });
    } else {
        // Add all ships back to map
        ships.forEach((ship) => {
            if (ship.latitude && ship.longitude && !shipMarkers.has(ship.mmsi)) {
                addShipMarker(ship);
            }
        });
    }
    
    updateShipList();
    updateStats();
}

// ==================== CCTV ====================
async function loadCCTV() {
    try {
        const res = await fetch('/api/cctv');
        const data = await res.json();
        if (data.success) { cctvList = data.cameras; renderCCTV(); }
    } catch (e) { console.error('[CCTV] Failed:', e); }
}

function renderCCTV() {
    const online = cctvList.filter(c => c.status === 'online').length;
    setEl('cctvOnlineBadge', `${online} Online`);
    const html = cctvList.length === 0 ? `<div class="empty-state"><div class="empty-icon">📹</div><p>Belum ada kamera</p></div>` : cctvList.map(cam => buildCCTVCardHTML(cam, false)).join('');
    const htmlSm = cctvList.length === 0 ? `<div class="empty-state" style="height:80px;font-size:0.75rem;"><p>Belum ada kamera</p></div>` : cctvList.map(cam => buildCCTVCardHTML(cam, true)).join('');
    document.getElementById('cctvGrid').innerHTML = html;
    document.getElementById('cctvGridDesktop').innerHTML = htmlSm;
}

function buildCCTVCardHTML(cam, small) {
    const isOnline = cam.status === 'online';
    const placeholderStyle = cam.streamUrl ? 'display:none' : '';
    const offlineClass = isOnline ? '' : ' offline';
    const camId = encodeURIComponent(cam.id);
    return `<div class="cctv-card" data-cctv-id="${escapeHtml(cam.id)}" onclick="showCCTVDetailFromElement(this)"><div class="cctv-feed">${cam.streamUrl ? `<iframe src="/api/cctv/${camId}/stream" style="width:100%;height:100%;border:none;display:none;" allowfullscreen onload="this.style.display='block';this.nextElementSibling.style.display='none';"></iframe>` : ''}<div class="cctv-placeholder${offlineClass}" style="${placeholderStyle}"><span class="cctv-icon">${isOnline ? '📹' : '📷'}</span><p class="cctv-cam-name">${escapeHtml(small ? cam.id : cam.name)}</p>${!small ? `<small>${escapeHtml(cam.location || '')}</small>` : ''}</div></div><div class="cctv-footer"><span class="cctv-id">${escapeHtml(cam.id)}</span><span class="cctv-badge ${cam.status}">● ${isOnline ? 'Online' : 'Offline'}</span></div></div>`;
}

function showCCTVDetailFromElement(element) { showCCTVDetail(element.getAttribute('data-cctv-id')); }

function showCCTVDetail(camId) {
    const cam = cctvList.find(c => c.id === camId);
    if (!cam) return;
    const modal = document.getElementById('shipModal'), modalBody = document.getElementById('modalBody');
    document.getElementById('modalShipName').textContent = cam.name;
    const isOnline = cam.status === 'online';
    const camIdEncoded = encodeURIComponent(cam.id);
    const streamHtml = cam.streamUrl ? `<div style="margin-bottom:1rem;border-radius:8px;overflow:hidden;aspect-ratio:16/9;background:#000;"><iframe src="/api/cctv/${camIdEncoded}/stream" style="width:100%;height:100%;border:none;"></iframe></div>` : `<div style="aspect-ratio:16/9;background:linear-gradient(135deg,#1a1a2e,#0f0f1a);display:flex;align-items:center;justify-content:center;border-radius:8px;margin-bottom:1rem;color:#b0bec5;"><span style="font-size:2.5rem;">${isOnline ? '📹' : '📷'}</span></div>`;
    modalBody.innerHTML = `${streamHtml}<div class="ship-details-grid"><div class="detail-item"><label>ID Kamera</label><span>${escapeHtml(cam.id)}</span></div><div class="detail-item"><label>Status</label><span class="cctv-badge ${cam.status}">● ${isOnline ? 'Online' : 'Offline'}</span></div><div class="detail-item"><label>Nama</label><span>${escapeHtml(cam.name)}</span></div><div class="detail-item"><label>Lokasi</label><span>${escapeHtml(cam.location || '-')}</span></div></div><div class="modal-actions"><button class="btn" onclick="showEditCCTV('${escapeHtml(cam.id)}')">✏️ Edit</button><button class="btn btn-danger" onclick="deleteCCTV('${escapeHtml(cam.id)}')">🗑️ Hapus</button><button class="btn btn-secondary" onclick="closeModal()">Tutup</button></div>`;
    modal.style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function showAddCCTV() {
    document.getElementById('cctvModalTitle').textContent = 'Tambah Kamera CCTV';
    document.getElementById('cctvEditId').value = '';
    document.getElementById('cctvId').value = '';
    document.getElementById('cctvId').disabled = false;
    document.getElementById('cctvName').value = '';
    document.getElementById('cctvLocation').value = '';
    document.getElementById('cctvStreamUrl').value = '';
    document.getElementById('cctvStatus').value = 'online';
    document.getElementById('cctvModal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function showEditCCTV(camId) {
    const cam = cctvList.find(c => c.id === camId);
    if (!cam) return;
    closeModal();
    document.getElementById('cctvModalTitle').textContent = 'Edit Kamera CCTV';
    document.getElementById('cctvEditId').value = cam.id;
    document.getElementById('cctvId').value = cam.id;
    document.getElementById('cctvId').disabled = true;
    document.getElementById('cctvName').value = cam.name;
    document.getElementById('cctvLocation').value = cam.location || '';
    document.getElementById('cctvStreamUrl').value = cam.streamUrl || '';
    document.getElementById('cctvStatus').value = cam.status;
    document.getElementById('cctvModal').style.display = 'flex';
    document.body.style.overflow = 'hidden';
}

function closeCCTVModal() { document.getElementById('cctvModal').style.display = 'none'; document.body.style.overflow = ''; }

async function saveCCTV(event) {
    event.preventDefault();
    const editId = document.getElementById('cctvEditId').value;
    const body = { name: document.getElementById('cctvName').value.trim(), location: document.getElementById('cctvLocation').value.trim(), status: document.getElementById('cctvStatus').value, streamUrl: document.getElementById('cctvStreamUrl').value.trim() || null };
    try {
        const res = await fetch(editId ? `/api/cctv/${encodeURIComponent(editId)}` : '/api/cctv', { method: editId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(editId ? body : { id: document.getElementById('cctvId').value.trim(), ...body }) });
        const data = await res.json();
        if (data.success) { closeCCTVModal(); await loadCCTV(); } else alert('Error: ' + data.message);
    } catch (e) { alert('Gagal menyimpan: ' + e.message); }
}

async function deleteCCTV(camId) {
    if (!confirm(`Hapus kamera ${camId}?`)) return;
    try {
        const res = await fetch(`/api/cctv/${encodeURIComponent(camId)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) { closeModal(); await loadCCTV(); } else alert('Error: ' + data.message);
    } catch (e) { alert('Gagal menghapus: ' + e.message); }
}

// ==================== PORTS/HARBORS ====================
function createPortIconSVG(type) {
    // Port/Harbor marker icon - square with anchor symbol
    const color = type === 'primary' ? '#e53935' : (type === 'industrial' ? '#7cb342' : '#43a047');
    return `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <rect x="2" y="2" width="20" height="20" rx="3" fill="${color}" stroke="white" stroke-width="1.5"/>
        <text x="12" y="16" text-anchor="middle" fill="white" font-size="12" font-weight="bold">⚓</text>
    </svg>`;
}

async function loadPorts() {
    try {
        const res = await fetch('/api/ports');
        const data = await res.json();
        if (data.success) {
            ports = data.ports;
            renderPortMarkers();
        }
    } catch (e) { console.error('[Ports] Failed:', e); }
}

function renderPortMarkers() {
    ports.forEach(port => {
        const iconHtml = createPortIconSVG(port.type);
        const icon = L.divIcon({ 
            className: 'port-marker', 
            html: `<div class="port-icon">${iconHtml}</div>`, 
            iconSize: [24, 24], 
            iconAnchor: [12, 12] 
        });
        
        const marker = L.marker([port.latitude, port.longitude], { icon });
        marker.bindPopup(createPortPopup(port));
        marker.addTo(map);
        portMarkers.set(port.id, marker);
    });
}

function createPortPopup(port) {
    const typeLabel = port.type === 'primary' ? 'Pelabuhan Utama' : (port.type === 'industrial' ? 'Pel INDUSTRI' : 'Pelabuhan');
    return `<div class="port-popup"><h4 style="color:#e53935">${port.name}</h4><p><strong>Lokasi:</strong> ${port.location}</p><p><strong>Tipe:</strong> ${typeLabel}</p><p><strong>Koordinat:</strong> ${port.latitude.toFixed(5)}, ${port.longitude.toFixed(5)}</p></div>`;
}

// ==================== HELPERS ====================
function setEl(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; }
function setElHTML(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }
function escapeHtml(str) { if (!str) return ''; return String(str).replace(/&/g, '&amp;').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, '&#39;'); }
