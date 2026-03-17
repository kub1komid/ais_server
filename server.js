const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');

let SerialPort;
try {
    SerialPort = require('serialport');
} catch (e) {
    console.log('Serialport not available - running in simulation mode');
}

const net = require('net');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const ships = new Map();

const aisConfig = {
    serial: { enabled: false, path: 'COM1', baudRate: 38400 },
    tcp: { enabled: true, host: '103.118.175.60', port: 9000 },
    // tcp: { enabled: true, host: '41.216.190.168', port: 8202 },
    simulation: { enabled: false }
};

const aisStatus = {
    serial: { connected: false, error: null },
    tcp: { connected: false, error: null },
    simulation: { enabled: false },
    messagesReceived: 0,
    lastMessage: null
};

let simulationInterval = null;

// Fragment buffer for multi-part AIS messages
const fragmentBuffer = new Map();

// Simple in-memory user storage (in production, use database)
const users = [
    { username: 'admin', password: 'admin123', role: 'admin', name: 'Administrator' },
    { username: 'operator', password: 'operator123', role: 'operator', name: 'Operator' }
];

// Login endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.json({ success: false, message: 'Username dan password diperlukan' });
    }
    
    const user = users.find(u => u.username === username && u.password === password);
    
    if (user) {
        const { password: _, ...userWithoutPassword } = user;
        return res.json({ success: true, user: userWithoutPassword });
    } else {
        return res.json({ success: false, message: 'Username atau password salah' });
    }
});

// Logout endpoint
app.post('/api/logout', (req, res) => {
    res.json({ success: true });
});

// Check auth status
app.get('/api/auth', (req, res) => {
    res.json({ success: true, authenticated: true });
});

class AISParser {
    static charToBinary(char) {
        const code = char.charCodeAt(0);
        // Standard AIS 6-bit ASCII decoding:
        // Step 1: subtract 48
        // Step 2: if result > 39, subtract 8 more
        // Valid range: 0-63
        let value = code - 48;
        if (value > 39) value -= 8;
        if (value < 0 || value > 63) return '000000';
        return value.toString(2).padStart(6, '0');
    }

    static toBinary(aisString) {
        let binary = '';
        for (const char of aisString) {
            binary += this.charToBinary(char);
        }
        return binary;
    }

    static parseNMEA(nmea) {
        const parts = nmea.trim().split(',');
        if (parts.length < 6) return null;
        if (!parts[0].startsWith('!AIVDM') && !parts[0].startsWith('!AIVDO')) return null;

        const totalFragments = parseInt(parts[1]);
        const fragmentNumber = parseInt(parts[2]);
        const channel = parts[4];
        const payload = parts[5];
        const fillBits = parseInt(parts[6]);

        if (totalFragments > 1) {
            // Multi-part message: buffer fragments until all arrive
            const bufferKey = `${parts[3]}_${channel}`; // sequential ID + channel
            if (!fragmentBuffer.has(bufferKey)) {
                fragmentBuffer.set(bufferKey, {
                    total: totalFragments,
                    fragments: new Array(totalFragments).fill(null),
                    fillBits: 0
                });
            }
            const buf = fragmentBuffer.get(bufferKey);
            buf.fragments[fragmentNumber - 1] = payload;
            if (fragmentNumber === totalFragments) buf.fillBits = fillBits;

            // Check if all fragments received
            if (buf.fragments.every(f => f !== null)) {
                const assembledPayload = buf.fragments.join('');
                fragmentBuffer.delete(bufferKey);
                const binary = this.toBinary(assembledPayload);
                const messageType = parseInt(binary.substring(0, 6), 2);
                switch (messageType) {
                    case 5:  return this.parseStaticVoyage(binary);
                    default: return { type: 'unknown', messageType };
                }
            }
            return null; // waiting for remaining fragments
        }

        const binary = this.toBinary(payload);
        const messageType = parseInt(binary.substring(0, 6), 2);

        switch (messageType) {
            case 1: case 2: case 3:
                return this.parsePositionReport(binary, payload);
            case 4: return this.parseBaseStationReport(binary);
            case 5: return this.parseStaticVoyage(binary);
            case 18: return this.parsePositionReportClassB(binary);
            case 24: return this.parseStaticDataReport(binary);
            default: return { type: 'unknown', messageType };
        }
    }

    static parsePositionReport(binary, payload) {
        if (binary.length < 143) return null;

        const mmsi = parseInt(binary.substring(8, 38), 2);
        const navigationStatus = parseInt(binary.substring(38, 42), 2);
        const rateOfTurn = parseInt(binary.substring(42, 50), 2);
        const speedOverGround = parseInt(binary.substring(50, 60), 2);
        const positionAccuracy = binary[60] === '1';

        // AIS standard bit positions for message type 1/2/3:
        // Longitude: bits 61-88 (28 bits, signed, 1/10000 min)
        // Latitude:  bits 89-115 (27 bits, signed, 1/10000 min)
        const longitudeRaw = parseInt(binary.substring(61, 89), 2);
        const latitudeRaw = parseInt(binary.substring(89, 116), 2);

        const courseOverGround = parseInt(binary.substring(116, 128), 2);
        const trueHeading = parseInt(binary.substring(128, 137), 2);
        const timestamp = parseInt(binary.substring(137, 143), 2);

        const longitude = this.convertCoordinate28(longitudeRaw, true);
        const latitude = this.convertCoordinate28(latitudeRaw, false);

        return {
            type: 'position', messageType: 1, mmsi: mmsi,
            status: this.getNavigationStatus(navigationStatus),
            rot: rateOfTurn === 127 ? 'N/A' : (rateOfTurn - 126) * 4.733,
            sog: speedOverGround / 10, accuracy: positionAccuracy,
            longitude: longitude, latitude: latitude,
            cog: courseOverGround / 10, heading: trueHeading,
            timestamp: timestamp, raw: payload
        };
    }

    static parsePositionReportClassB(binary) {
        const mmsi = parseInt(binary.substring(8, 38), 2);
        const speedOverGround = parseInt(binary.substring(46, 56), 2);
        const positionAccuracy = binary[56] === '1';
        // AIS standard bit positions for message type 18 (Class B):
        // Longitude: bits 57-84 (28 bits, signed, 1/10000 min)
        // Latitude:  bits 85-111 (27 bits, signed, 1/10000 min)
        const longitudeRaw = parseInt(binary.substring(57, 85), 2);
        const latitudeRaw = parseInt(binary.substring(85, 112), 2);
        const courseOverGround = parseInt(binary.substring(112, 124), 2);
        const trueHeading = parseInt(binary.substring(124, 133), 2);

        // Use convertCoordinate28 (1/10000 min format), same as Class A
        const longitude = this.convertCoordinate28(longitudeRaw, true);
        const latitude = this.convertCoordinate28(latitudeRaw, false);

        return {
            type: 'position', messageType: 18, mmsi: mmsi,
            sog: speedOverGround / 10, accuracy: positionAccuracy,
            longitude: longitude, latitude: latitude,
            cog: courseOverGround / 10, heading: trueHeading,
            raw: binary.substring(0, 168)
        };
    }

    static parseStaticVoyage(binary) {
        const mmsi = parseInt(binary.substring(8, 38), 2);
        const aisVersion = parseInt(binary.substring(38, 40), 2);
        const imo = parseInt(binary.substring(40, 70), 2);
        const callSign = this.decodeString(binary.substring(70, 112));
        const vesselName = this.decodeString(binary.substring(112, 232));
        const shipType = parseInt(binary.substring(232, 240), 2);
        const dimension = {
            toBow: parseInt(binary.substring(240, 249), 2),
            toStern: parseInt(binary.substring(249, 258), 2),
            toPort: parseInt(binary.substring(258, 264), 2),
            toStarboard: parseInt(binary.substring(264, 270), 2)
        };
        const destination = this.decodeString(binary.substring(294, 372));

        return { type: 'static', messageType: 5, mmsi: mmsi, aisVersion, imo, callSign, vesselName, shipType: this.getShipType(shipType), dimension, destination };
    }

    static parseStaticDataReport(binary) {
        const mmsi = parseInt(binary.substring(8, 38), 2);
        const partNumber = parseInt(binary.substring(38, 40), 2);
        if (partNumber === 0) {
            return { type: 'static', messageType: 24, part: 'A', mmsi, vesselName: this.decodeString(binary.substring(40, 160)) };
        } else {
            return {
                type: 'static', messageType: 24, part: 'B', mmsi,
                shipType: this.getShipType(parseInt(binary.substring(40, 48), 2)),
                vendorId: this.decodeString(binary.substring(48, 66)),
                callSign: this.decodeString(binary.substring(66, 102)),
                dimension: {
                    toBow: parseInt(binary.substring(102, 111), 2),
                    toStern: parseInt(binary.substring(111, 120), 2),
                    toPort: parseInt(binary.substring(120, 126), 2),
                    toStarboard: parseInt(binary.substring(126, 132), 2)
                }
            };
        }
    }

    static parseBaseStationReport(binary) {
        const mmsi = parseInt(binary.substring(8, 38), 2);
        const longitudeRaw = parseInt(binary.substring(61, 89), 2);
        const latitudeRaw = parseInt(binary.substring(89, 116), 2);
        return {
            type: 'base', messageType: 4, mmsi: mmsi,
            longitude: this.convertCoordinate28(longitudeRaw, true),
            latitude: this.convertCoordinate28(latitudeRaw, false)
        };
    }

    static convertCoordinate(raw, max, isLongitude) {
        if (raw === (isLongitude ? 181 * 8388608 : 91 * 8388608)) return null;
        let value = raw;
        if (value > max) value = value - 2 * max - 2;
        return value / 8388608 * 180 / Math.PI;
    }

    static convertCoordinate28(raw, isLongitude) {
        // "Not available" sentinel values per AIS standard (1/10000 min format)
        // Longitude: 181 * 600000 = 108600000
        // Latitude:  91  * 600000 = 54600000
        const NOT_AVAILABLE = isLongitude ? 108600000 : 54600000;
        if (raw === NOT_AVAILABLE) return null;
        let value = raw;
        const MAX_BITS = isLongitude ? 28 : 27;
        const MAX_VAL = 1 << MAX_BITS;
        // Two's complement: if MSB is set, value is negative
        if (value >= MAX_VAL / 2) value = value - MAX_VAL;
        return value / 600000.0;
    }

    static decodeString(binary) {
        // AIS 6-bit ASCII character set:
        // value 0     = '@' (padding/null, stripped at end)
        // value 1-26  = 'A'-'Z'
        // value 27-31 = special chars '[', '\', ']', '^', '_'
        // value 32    = ' ' (space)
        // value 33-63 = '!'-'?'
        let str = '';
        for (let i = 0; i < binary.length; i += 6) {
            const chunk = binary.substring(i, Math.min(i + 6, binary.length));
            if (chunk.length < 6) break;
            const value = parseInt(chunk, 2);
            // value 0-31: add 64 to get ASCII (0→'@', 1→'A', ..., 26→'Z')
            // value 32-63: use directly as ASCII (32→' ', 33→'!', ..., 63→'?')
            const ascii = value < 32 ? value + 64 : value;
            if (ascii >= 32 && ascii <= 95) str += String.fromCharCode(ascii);
        }
        // Remove trailing '@' padding and trim whitespace
        return str.replace(/@+$/, '').trim();
    }

    static getNavigationStatus(code) {
        const statuses = ['Under way using engine', 'At anchor', 'Not under command', 'Restricted maneuverability', 'Constrained by draught', 'Moored', 'Aground', 'Engaged in fishing', 'Under way sailing', 'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Reserved', 'Not defined'];
        return statuses[code] || 'Unknown';
    }

    static getShipType(code) {
        const types = { 0: 'Not available', 20: 'WIG', 30: 'Fishing', 40: 'Towing', 50: 'Dredging/Underwater ops', 60: 'Diving ops', 70: 'Military', 80: 'Sailing', 90: 'Pleasure' };
        return types[code] || `Type ${code}`;
    }
}

function processAISData(nmea) {
    aisStatus.messagesReceived++;
    aisStatus.lastMessage = new Date().toISOString();
    console.log(`[NMEA] ${nmea}`);
    const decoded = AISParser.parseNMEA(nmea);
    if (decoded) {
        if (decoded.type === 'position') {
            console.log(`[AIS] MMSI: ${decoded.mmsi}, Lat: ${decoded.latitude}, Lon: ${decoded.longitude}, SOG: ${decoded.sog}, COG: ${decoded.cog}`);
        }
        handleDecodedAIS(decoded);
    }
}

let serialPort = null;
function initSerialAIS() {
    if (!SerialPort || !aisConfig.serial.enabled) return;
    try {
        serialPort = new SerialPort(aisConfig.serial.path, { baudRate: aisConfig.serial.baudRate || 38400, parser: SerialPort.parsers.readline('\n') });
        serialPort.on('open', () => { console.log(`Serial AIS connected on ${aisConfig.serial.path}`); aisStatus.serial.connected = true; });
        serialPort.on('data', (data) => { const line = data.toString().trim(); if (line.startsWith('!AIVDM') || line.startsWith('!AIVDO')) processAISData(line); });
        serialPort.on('error', (err) => { console.error('Serial error:', err.message); aisStatus.serial.error = err.message; aisStatus.serial.connected = false; });
    } catch (err) { console.error('Failed to init serial:', err.message); aisStatus.serial.error = err.message; }
}

let tcpClient = null;
function initTCPAIS() {
    if (!aisConfig.tcp.enabled) return;
    function connectTCP() {
        console.log(`Connecting to TCP AIS at ${aisConfig.tcp.host}:${aisConfig.tcp.port}`);
        tcpClient = new net.Socket();
        tcpClient.connect(aisConfig.tcp.port, aisConfig.tcp.host, () => { console.log('TCP AIS connected'); aisStatus.tcp.connected = true; });
        let buffer = '';
        tcpClient.on('data', (data) => {
            buffer += data.toString();
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                const line = buffer.substring(0, newlineIndex).trim();
                buffer = buffer.substring(newlineIndex + 1);
                if (line.startsWith('!AIVDM') || line.startsWith('!AIVDO')) processAISData(line);
            }
        });
        tcpClient.on('error', (err) => { console.error('TCP error:', err.message); aisStatus.tcp.error = err.message; aisStatus.tcp.connected = false; });
        tcpClient.on('close', () => { console.log('TCP disconnected'); aisStatus.tcp.connected = false; setTimeout(connectTCP, 5000); });
    }
    connectTCP();
}

wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.send(JSON.stringify({ type: 'init', ships: Array.from(ships.values()) }));
    ws.send(JSON.stringify({ type: 'aisStatus', status: aisStatus }));
    ws.on('message', (message) => { try { const data = JSON.parse(message); if (data.type === 'nmea') processAISData(data.payload); } catch (e) { console.error('Error:', e); } });
    ws.on('close', () => console.log('Client disconnected'));
});

function handleDecodedAIS(data) {
    const now = Date.now();
    if (data.type === 'position') {
        const ship = ships.get(data.mmsi) || {};
        const updatedShip = { ...ship, mmsi: data.mmsi, latitude: data.latitude, longitude: data.longitude, sog: data.sog, cog: data.cog, heading: data.heading, status: data.status, rot: data.rot, messageType: data.messageType, lastUpdate: now, source: aisStatus.serial.connected ? 'serial' : (aisStatus.tcp.connected ? 'tcp' : 'simulation') };
        ships.set(data.mmsi, updatedShip);
        broadcast({ type: 'update', ship: updatedShip });
    } else if (data.type === 'static') {
        const ship = ships.get(data.mmsi) || {};
        const updatedShip = { ...ship, ...data, lastUpdate: now };
        ships.set(data.mmsi, updatedShip);
        broadcast({ type: 'static', ship: updatedShip });
    }
}

function broadcast(data) { wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data)); }); }

function simulateAIS() {
    const sampleShips = [
        { mmsi: 123456789, name: 'MV SEA STAR', lat: -6.2, lon: 106.8, sog: 12.5, cog: 45, heading: 45, vesselName: 'MV SEA STAR' },
        { mmsi: 987654321, name: 'MV OCEAN PRIDE', lat: -6.1, lon: 106.9, sog: 8.2, cog: 180, heading: 178, vesselName: 'MV OCEAN PRIDE' },
        { mmsi: 456789123, name: 'KM BAHAGIA', lat: -6.15, lon: 106.85, sog: 10.0, cog: 270, heading: 268, vesselName: 'KM BAHAGIA' },
        { mmsi: 321654987, name: 'MV NUSantara', lat: -6.08, lon: 106.75, sog: 15.5, cog: 90, heading: 88, vesselName: 'MV NUSantara' },
        { mmsi: 789123456, name: 'KM MAJU', lat: -6.25, lon: 106.95, sog: 6.0, cog: 315, heading: 312, vesselName: 'KM MAJU' },
    ];
    const ship = sampleShips[Math.floor(Math.random() * sampleShips.length)];
    const updatedShip = { ...ship, lat: ship.lat + (Math.random() - 0.5) * 0.01, lon: ship.lon + (Math.random() - 0.5) * 0.01, sog: Math.max(0, ship.sog + (Math.random() - 0.5) * 1), cog: (ship.cog + (Math.random() - 0.5) * 10 + 360) % 360, heading: (ship.heading + Math.floor((Math.random() - 0.5) * 10) + 360) % 360, mmsi: ship.mmsi, latitude: ship.lat, longitude: ship.lon, speed: ship.sog, course: ship.cog, lastUpdate: Date.now(), source: 'simulation' };
    ships.set(ship.mmsi, updatedShip);
    broadcast({ type: 'update', ship: updatedShip });
}

const cctvCameras = [
    { id: 'CAM-01', name: 'Camera 1 - Pelabuhan', location: 'Pelautan Utama', status: 'online', streamUrl: 'https://cctv.kubikomid.web.id/cam1/' },
    { id: 'CAM-02', name: 'Camera 2 - Entertainment', location: 'Area Hiburan', status: 'offline', streamUrl: null },
    { id: 'CAM-03', name: 'Camera 3 - Dermaga', location: 'Dermaga Utara', status: 'offline', streamUrl: null },
    { id: 'CAM-04', name: 'Camera 4 - Masuk', location: 'Pintu Masuk', status: 'offline', streamUrl: null }
];

// Port/Harbor locations
const ports = [
    { id: 'tanjungpriok', name: 'Pelabuhan Tanjung Priok', location: 'Jakarta', latitude: -6.1052, longitude: 106.8804, type: 'primary' },
    { id: 'sundaKelapa', name: 'Pelabuhan Sunda Kelapa', location: 'Jakarta', latitude: -6.1077, longitude: 106.8817, type: 'harbor' },
    { id: 'cikarang', name: 'Pel Cikarang', location: 'Bekasi', latitude: -6.2333, longitude: 107.0833, type: 'industrial' },
    { id: 'balikpapan', name: 'Pelabuhan Balikpapan', location: 'Kalimantan Timur', latitude: -1.2764, longitude: 116.8315, type: 'primary' },
    { id: 'surabaya', name: 'Pelayaran Tanjung Perak', location: 'Surabaya', latitude: -7.2128, longitude: 112.7390, type: 'primary' },
    { id: 'makassar', name: 'Pelayaran Makassar', location: 'Sulawesi Selatan', latitude: -5.1467, longitude: 119.4117, type: 'primary' },
    { id: 'belawan', name: 'Pelautan Belawan', location: 'Medan', latitude: 3.7833, longitude: 98.6833, type: 'primary' },
    { id: 'pontianak', name: 'Pelautan Pontianak', location: 'Kalimantan Barat', latitude: -0.0222, longitude: 109.3350, type: 'harbor' },
    { id: 'semarang', name: 'Pelayaran Tanjung Emas', location: 'Semarang', latitude: -6.9533, longitude: 110.4167, type: 'harbor' },
    { id: 'pantaitimur', name: 'Pantai Timur Lampung', location: 'Lampung', latitude: -5.4667, longitude: 105.2667, type: 'harbor' }
];

// Port API endpoints
app.get('/api/ports', (req, res) => res.json({ success: true, ports: ports }));
app.get('/api/ports/:id', (req, res) => {
    const port = ports.find(p => p.id === req.params.id);
    if (!port) return res.status(404).json({ success: false, message: 'Port not found' });
    res.json({ success: true, port });
});

app.get('/api/cctv', (req, res) => res.json({ success: true, cameras: cctvCameras }));
app.get('/api/cctv/:id', (req, res) => { const camera = cctvCameras.find(c => c.id === req.params.id); if (!camera) return res.status(404).json({ success: false, message: 'Camera not found' }); res.json({ success: true, camera }); });
app.post('/api/cctv', (req, res) => {
    const { id, name, location, status, streamUrl } = req.body;
    if (!id || !name) return res.status(400).json({ success: false, message: 'id and name are required' });
    if (cctvCameras.find(c => c.id === id)) return res.status(409).json({ success: false, message: 'Camera ID already exists' });
    const camera = { id, name, location: location || '', status: status || 'online', streamUrl: streamUrl || null };
    cctvCameras.push(camera);
    res.json({ success: true, camera });
});
app.put('/api/cctv/:id', (req, res) => {
    const idx = cctvCameras.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Camera not found' });
    const { name, location, status, streamUrl } = req.body;
    if (name !== undefined) cctvCameras[idx].name = name;
    if (location !== undefined) cctvCameras[idx].location = location;
    if (status !== undefined) cctvCameras[idx].status = status;
    if (streamUrl !== undefined) cctvCameras[idx].streamUrl = streamUrl || null;
    res.json({ success: true, camera: cctvCameras[idx] });
});
app.delete('/api/cctv/:id', (req, res) => {
    const idx = cctvCameras.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Camera not found' });
    const removed = cctvCameras.splice(idx, 1)[0];
    res.json({ success: true, camera: removed });
});

// CCTV Stream Proxy - serves HTML with HLS.js player for HLS streams
app.get('/api/cctv/:id/stream', (req, res) => {
    const camera = cctvCameras.find(c => c.id === req.params.id);
    if (!camera) return res.status(404).json({ success: false, message: 'Camera not found' });
    if (!camera.streamUrl) return res.status(404).json({ success: false, message: 'No stream URL configured' });
    
    console.log(`[CCTV Proxy] Streaming camera ${camera.id} from ${camera.streamUrl}`);
    
    const streamUrl = camera.streamUrl.replace(/\/$/, '');
    const hlsUrl = `${streamUrl}/index.m3u8`;
    
    const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CCTV - ${camera.name}</title>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
        #video { width: 100%; height: 100%; object-fit: contain; }
    </style>
</head>
<body>
    <video id="video" controls autoplay muted playsinline></video>
    <script>
        const video = document.getElementById('video');
        const hlsUrl = '${hlsUrl}';
        
        if (Hls.isSupported()) {
            const hls = new Hls({ maxLoadingDelay: 4, maxBufferLength: 30, liveSyncDurationCount: 3 });
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, function() { video.play().catch(e => {}); });
            hls.on(Hls.Events.ERROR, function(event, data) {
                if (data.fatal) {
                    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                    else hls.destroy();
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = hlsUrl;
            video.addEventListener('loadedmetadata', function() { video.play().catch(e => {}); });
        } else {
            document.body.innerHTML = '<div style="color:#fff;display:flex;align-items:center;justify-content:center;height:100%;">HLS not supported</div>';
        }
    <\/script>
</body>
</html>`;
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
});

app.get('/api/ais/config', (req, res) => res.json({ success: true, config: aisConfig, status: aisStatus }));
app.post('/api/ais/config', (req, res) => { const { serial, tcp, simulation } = req.body; if (serial) aisConfig.serial = { ...aisConfig.serial, ...serial }; if (tcp) aisConfig.tcp = { ...aisConfig.tcp, ...tcp }; if (simulation !== undefined) aisConfig.simulation.enabled = simulation; res.json({ success: true, config: aisConfig }); });
app.get('/api/ais/status', (req, res) => res.json({ success: true, status: aisStatus }));
app.get('/api/stats', (req, res) => { const shipArray = Array.from(ships.values()); const fiveMinutesAgo = Date.now() - (5 * 60 * 1000); const activeShips = shipArray.filter(ship => ship.lastUpdate && ship.lastUpdate > fiveMinutesAgo).length; res.json({ success: true, stats: { totalShips: shipArray.length, activeShips, connectedClients: wss.clients.size, messagesReceived: aisStatus.messagesReceived, aisSource: aisStatus.serial.connected ? 'serial' : (aisStatus.tcp.connected ? 'tcp' : 'simulation'), timestamp: Date.now() } }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('AIS Traffic Monitor initialized');
    console.log('=== AIS Data Sources ===');
    if (aisConfig.simulation.enabled && !aisConfig.serial.enabled && !aisConfig.tcp.enabled) { console.log('Simulation mode: ENABLED'); aisStatus.simulation.enabled = true; simulationInterval = setInterval(simulateAIS, 3000); }
    else { console.log('Simulation mode: DISABLED'); aisStatus.simulation.enabled = false; }
    if (aisConfig.serial.enabled) { console.log('Serial AIS: connecting...'); initSerialAIS(); }
    else { console.log('Serial AIS: DISABLED'); }
    if (aisConfig.tcp.enabled) { console.log(`TCP AIS: ${aisConfig.tcp.host}:${aisConfig.tcp.port}`); initTCPAIS(); }
    else { console.log('TCP AIS: DISABLED'); }
    console.log('');
});
