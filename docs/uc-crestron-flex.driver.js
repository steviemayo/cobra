/**
 * REFERENCE ONLY: not loaded or run by Kestrel. Kept to document the Crestron Flex
 * UC-Engine protocol and joins; the shipped driver is in packages/drivers.
 *
 * Crestron Flex UC-Engine (Microsoft Teams Rooms)
 *
 * Protocol: Crestron Secure Console (SCTP) over TLS, default port 41797.
 * Auth: send \r\n to trigger Login: prompt, then username + password.
 *
 * Data is read from Crestron Reserved Joins via showdigital / showserial / showanalog.
 * Reserved join reference: https://sdkcon78221.crestron.com/downloads/rjviewapp/index.html
 *
 * Key joins:
 *   D27767  Csig.MTR_APP_in_meeting          - in a meeting
 *   D27766  Csig.MTR_APP_Teams_signed_in     - Teams app signed in
 *   D27764  Csig.MTR_APP_Exchange_signed_in  - Exchange signed in
 *   D27774  Csig.Camera_connected            - camera present
 *   D27729  Csig.Huddly_Camera_Connected     - Huddly camera present
 *   D27727  Csig.Image_Mode_Teams            - Teams mode active
 *   D27797  Csig.Occupancy_Status_Occupied   - room occupied
 *   S27702  Csig.MTR_Conf_Mic_Status         - mic health string
 *   S27703  Csig.MTR_Conf_Spk_Status         - speaker health string
 *   S27705  Csig.MTR_Camera_Status           - camera health string
 *   S27706  Csig.MTR_On_Front_Room_Display_Status - display health string
 *   S27710  Csig.Software_build              - Teams Rooms software version
 *   S27712  Csig.Windows_build               - Windows OS build
 *   S27722  Csig.UCEngine_camera_name        - connected camera name
 *   S33049  Csig.MTR_APP_state               - app state string (Idle / In Meeting / etc.)
 *   S33050  Csig.MTR_APP_version_state       - app version support state
 *   A27702  Csig.Huddly_Room_Occupant_Count  - people count from Huddly camera
 *   A17347  Csig.Conf_Mic_Vol                - microphone volume (0-100)
 *   A17348  Csig.Conf_Spkr_Vol               - conference speaker volume (0-100)
 */

'use strict';

const tls = require('tls');

const DEFAULT_PORT  = 41797;
const LOGIN_PROMPT  = 'Login:';
const PASS_PROMPT   = 'Password:';
const CMD_PROMPT    = 'UC-ENGINE>';

// â”€â”€ TLS session helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _connect(host, port) {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host, port, rejectUnauthorized: false }, () => resolve(sock));
    sock.setTimeout(8000);
    sock.on('error', reject);
    sock.on('timeout', () => { sock.destroy(); reject(new Error(`Connection timed out to ${host}:${port}`)); });
  });
}

function _readUntil(sock, needle, ms = 6000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => { cleanup(); resolve(buf); }, ms);

    function onData(chunk) {
      buf += chunk.toString('utf8');
      if (buf.includes(needle)) { cleanup(); resolve(buf); }
    }
    function onError(e) { cleanup(); reject(e); }
    function onEnd()    { cleanup(); resolve(buf); }
    function cleanup()  {
      clearTimeout(timer);
      sock.off('data', onData); sock.off('error', onError); sock.off('end', onEnd);
    }

    sock.on('data', onData); sock.on('error', onError); sock.on('end', onEnd);
  });
}

async function _openSession(host, port, username, password) {
  const sock = await _connect(host, port);

  sock.write('\r\n');
  const loginBuf = await _readUntil(sock, LOGIN_PROMPT, 5000);
  if (!loginBuf.includes(LOGIN_PROMPT)) {
    sock.destroy();
    throw new Error('No Login: prompt - verify host and port');
  }

  sock.write(username + '\r\n');
  const passBuf = await _readUntil(sock, PASS_PROMPT, 5000);
  if (!passBuf.includes(PASS_PROMPT)) {
    sock.destroy();
    throw new Error('No Password: prompt after username');
  }

  sock.write(password + '\r\n');
  const welcome = await _readUntil(sock, CMD_PROMPT, 6000);
  if (!welcome.includes(CMD_PROMPT)) {
    sock.destroy();
    if (welcome.includes(LOGIN_PROMPT)) throw new Error('Authentication failed - check username / password');
    throw new Error('No UC-ENGINE> prompt after login');
  }

  return sock;
}

async function _cmd(sock, command) {
  sock.write(command + '\r\n');
  const raw = await _readUntil(sock, CMD_PROMPT, 5000);
  return raw
    .replace(command + '\r\n', '')
    .replace(command + '\n', '')
    .replace(/\r?\nUC-ENGINE>\s*$/, '')
    .replace(/UC-ENGINE>\s*$/, '')
    .trim();
}

// â”€â”€ Join parsers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _parseDigital(s) { const m = s.match(/Value\s+(\d)/i); return m ? m[1] === '1' : null; }
function _parseAnalog(s)  { const m = s.match(/Value\s+(\d+)/i); return m ? parseInt(m[1], 10) : null; }
function _parseSerial(s)  { const m = s.match(/Value\s+(.+)/i); return m ? m[1].trim() : null; }

// D27797 (room occupied) and A27702 (camera head-count) are independent joins on this
// hardware — D27797 has been observed staying false while the camera counts several
// people. Treat the room as occupied if either signal says so.
function _deriveOccupied(roomOccupied, occupantCount) {
  if (roomOccupied === true || (occupantCount != null && occupantCount > 0)) return true;
  if (roomOccupied === false && occupantCount === 0) return false;
  return roomOccupied ?? null;
}

// â”€â”€ Reserved join tables â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const DIGITAL_JOINS = [
  { key: 'inMeeting',        id: 27767 },
  { key: 'teamsSignedIn',    id: 27766 },
  { key: 'exchangeSignedIn', id: 27764 },
  { key: 'cameraConnected',  id: 27774 },
  { key: 'huddlyConnected',  id: 27729 },
  { key: 'imageModeTeams',   id: 27727 },
  { key: 'roomOccupied',     id: 27797 },
];

const SERIAL_JOINS = [
  { key: 'micStatus',     id: 27702 },
  { key: 'speakerStatus', id: 27703 },
  { key: 'cameraStatus',  id: 27705 },
  { key: 'displayStatus', id: 27706 },
  { key: 'appState',      id: 33049 },
  { key: 'appVersion',    id: 27710 },
  { key: 'windowsBuild',  id: 27712 },
  { key: 'cameraName',    id: 27722 },
  { key: 'versionState',  id: 33050 },
];

const ANALOG_JOINS = [
  { key: 'occupantCount', id: 27702 },
  { key: 'micVolume',     id: 17347 },
  { key: 'speakerVolume', id: 17348 },
];

// â”€â”€ Driver â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CrestronFlexDriver = {
  id:        'crestron-flex',
  name:      'Crestron Flex UC-Engine (Teams Rooms)',
  framework: 'uc',

  configSchema: {
    host:     { label: 'IP Address', type: 'text',     required: true,  placeholder: '192.168.1.6' },
    username: { label: 'Username',   type: 'text',     required: false, placeholder: 'admin',
                description: 'Admin username (default: admin)' },
    password: { label: 'Password',   type: 'password', required: true,  placeholder: '' },
    port:     { label: 'SCTP Port',  type: 'text',     required: false, placeholder: '41797',
                description: 'Crestron Secure Console port (default: 41797)' },
  },

  async connect(config) {
    const host     = config.host;
    const port     = parseInt(config.port, 10) || DEFAULT_PORT;
    const username = config.username || 'admin';
    const password = config.password;

    if (!host)     throw new Error('IP address is required');
    if (!password) throw new Error('Password is required');

    const sock = await _openSession(host, port, username, password);
    sock.destroy();
    return { host, port, username, password };
  },

  disconnect() { return Promise.resolve(); },

  async fetch(conn) {
    const { host, port, username, password } = conn;
    const sock = await _openSession(host, port, username, password);

    try {
      const result = { digital: {}, serial: {}, analog: {}, version: null, uptime: null };

      result.version = await _cmd(sock, 'version');
      result.uptime  = await _cmd(sock, 'uptime');

      for (const { key, id } of DIGITAL_JOINS) {
        result.digital[key] = _parseDigital(await _cmd(sock, `showdigital ${id}`));
      }
      for (const { key, id } of SERIAL_JOINS) {
        result.serial[key] = _parseSerial(await _cmd(sock, `showserial ${id}`));
      }
      for (const { key, id } of ANALOG_JOINS) {
        result.analog[key] = _parseAnalog(await _cmd(sock, `showanalog ${id}`));
      }

      return result;
    } finally {
      sock.destroy();
    }
  },

  parsePlatform(raw) {
    const fw = raw.version?.match(/\[v([\d.]+)/)?.[1];
    return fw ? `UC-Engine v${fw}` : 'Crestron Flex UC-Engine';
  },

  parseStatus(raw) {
    const appState = (raw.serial?.appState || '').toLowerCase();
    if (appState.includes('meeting') || raw.digital?.inMeeting === true) return 'in_meeting';
    if (appState === 'idle' || raw.digital?.teamsSignedIn === true) return 'active';
    return 'standby';
  },

  parseComponents(raw) {
    const d = raw.digital || {};
    const s = raw.serial  || {};
    const a = raw.analog  || {};

    const fwMatch = raw.version?.match(/\[v([\d.]+)/);
    const uptimeMatch = raw.uptime?.match(/running for (.+?)\./);

    return {
      people_count: {
        label:    'People Count',
        value:    a.occupantCount ?? null,
        valueStr: a.occupantCount != null ? `${a.occupantCount} ${a.occupantCount === 1 ? 'person' : 'people'}` : 'Unknown',
      },
      occupancy: {
        peopleCount: a.occupantCount ?? null,
        isOccupied:  _deriveOccupied(d.roomOccupied, a.occupantCount),
        source:      'uc_engine',
      },
      connectivity: {
        teamsSignedIn:    d.teamsSignedIn    ?? null,
        exchangeSignedIn: d.exchangeSignedIn ?? null,
        inMeeting:        d.inMeeting        ?? null,
        appState:         s.appState         ?? null,
        imageModeTeams:   d.imageModeTeams   ?? null,
        roomOccupied:     d.roomOccupied     ?? null,
        occupantCount:    a.occupantCount    ?? null,
      },
      system: {
        firmware:     fwMatch ? fwMatch[1] : null,
        uptime:       uptimeMatch ? uptimeMatch[1].trim() : null,
        appVersion:   s.appVersion   ?? null,
        windowsBuild: s.windowsBuild ?? null,
        versionState: s.versionState ?? null,
      },
      peripherals: {
        microphone: {
          label:  'Microphone',
          status: s.micStatus     ?? null,
          volume: a.micVolume     ?? null,
        },
        speaker: {
          label:  'Speaker',
          status: s.speakerStatus ?? null,
          volume: a.speakerVolume ?? null,
        },
        camera: {
          label:     s.cameraName ?? 'Camera',
          status:    s.cameraStatus ?? null,
          connected: d.cameraConnected === true || d.huddlyConnected === true,
        },
        display: {
          label:  'Display',
          status: s.displayStatus ?? null,
        },
      },
    };
  },

  scoreHealth(state) {
    const conn = state.components?.connectivity;
    const per  = state.components?.peripherals;

    if (conn?.teamsSignedIn === false && conn?.imageModeTeams === false) {
      return { health: 'degraded', faultReason: 'Teams app not signed in to device' };
    }

    const faulted = [];
    if (per) {
      for (const p of Object.values(per)) {
        if (p?.status?.toLowerCase() === 'unhealthy') faulted.push(p.label);
      }
      if (per.camera?.connected === false) faulted.push(`${per.camera.label} (disconnected)`);
    }

    if (faulted.length > 0) {
      return { health: 'degraded', faultReason: `Peripheral issue: ${faulted.join(', ')}` };
    }

    return { health: 'healthy', faultReason: null };
  },

  isTransientError(err) {
    const msg = err.message || '';
    if (msg.includes('Authentication failed'))     return false;
    if (msg.includes('check username / password')) return false;
    return true;
  },

};

CrestronFlexDriver.wiringMeta = {
    ports: [
      { id: 'hdmi-out', label: 'HDMI Out (Display)',     direction: 'out', signalType: 'hdmi' },
      { id: 'hdmi-in',  label: 'HDMI In (Presentation)',  direction: 'in',  signalType: 'hdmi' },
      { id: 'usb-pc',   label: 'USB (PC)',                direction: 'in',  signalType: 'usb'  },
    ],
  };

const DRIVER_VERSION = '1.2';
module.exports = CrestronFlexDriver;
module.exports.driverVersion = DRIVER_VERSION;
