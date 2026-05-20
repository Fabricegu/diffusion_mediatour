import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import Database from "better-sqlite3";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import mqtt from "mqtt";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
let POWER_POLL_PORT = Number(process.env.POWER_POLL_PORT || 8080);
const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const CONVERTED_DIR = path.join(DATA_DIR, "converted");
const DB_PATH = path.join(DATA_DIR, "audio.db");
for (const d of [DATA_DIR, UPLOAD_DIR, CONVERTED_DIR]) fs.mkdirSync(d, { recursive: true });

const app = express();
const powerApp = express();
const db = new Database(DB_PATH);
const runningStreams = new Map();
const relayTimers = new Map();
const energyTimers = new Map();
const modemTimers = new Map();
const lightTimers = new Map();

let debugEnabled = true;
const debugLogs = [];
let mqttClient = null;
let mqttConnected = false;
let mqttLastError = null;
let mqttSubscribed = false;


function addDebugLog(entry) {
  if (!debugEnabled) return;

  debugLogs.unshift({
    time: new Date().toISOString(),
    ...entry
  });

  if (debugLogs.length > 1000) debugLogs.pop();
}

function sanitizeDebugBody(body) {
  if (!body) return body;
  if (Buffer.isBuffer(body)) return `<Buffer ${body.length} bytes>`;
  if (typeof body !== "object") return body;

  try {
    return JSON.parse(JSON.stringify(body));
  } catch {
    return String(body);
  }
}

async function espGet(speaker, apiPath, timeout = 1500) {
  const url = `http://${speaker.ip}:${speaker.port}${apiPath}`;

  addDebugLog({
    type: "esp32_request",
    direction: "Node → ESP32",
    speakerId: speaker.id,
    speaker: speaker.name,
    method: "GET",
    url
  });

  try {
    const response = await axios.get(url, { timeout });

    addDebugLog({
      type: "esp32_response",
      direction: "ESP32 → Node",
      speakerId: speaker.id,
      speaker: speaker.name,
      method: "GET",
      url,
      status: response.status,
      data: response.data
    });

    return response;
  } catch (error) {
    addDebugLog({
      type: "esp32_error",
      direction: "ESP32 → Node",
      speakerId: speaker.id,
      speaker: speaker.name,
      method: "GET",
      url,
      error: error.message,
      code: error.code || null
    });

    throw error;
  }
}

async function espPost(speaker, apiPath, body = {}, timeout = 1500) {
  const url = `http://${speaker.ip}:${speaker.port}${apiPath}`;

  addDebugLog({
    type: "esp32_request",
    direction: "Node → ESP32",
    speakerId: speaker.id,
    speaker: speaker.name,
    method: "POST",
    url,
    body: sanitizeDebugBody(body)
  });

  try {
    const response = await axios.post(url, body, {
      timeout,
      headers: { "Content-Type": "application/json" }
    });

    addDebugLog({
      type: "esp32_response",
      direction: "ESP32 → Node",
      speakerId: speaker.id,
      speaker: speaker.name,
      method: "POST",
      url,
      status: response.status,
      data: response.data
    });

    return response;
  } catch (error) {
    addDebugLog({
      type: "esp32_error",
      direction: "ESP32 → Node",
      speakerId: speaker.id,
      speaker: speaker.name,
      method: "POST",
      url,
      body: sanitizeDebugBody(body),
      error: error.message,
      code: error.code || null
    });

    throw error;
  }
}

app.use((req, res, next) => {
  const startedAt = Date.now();

  addDebugLog({
    type: "api_request",
    direction: "Vue/Client → Node",
    method: req.method,
    path: req.originalUrl,
    body: req.is("multipart/form-data") ? "<multipart/form-data>" : sanitizeDebugBody(req.body)
  });

  res.on("finish", () => {
    addDebugLog({
      type: "api_response",
      direction: "Node → Vue/Client",
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  next();
});

app.use(cors());
app.use(express.json({ limit: "20mb" }));
powerApp.use(cors());
powerApp.use(express.json({ limit: "1mb" }));
app.use("/media/original", express.static(UPLOAD_DIR));
app.use("/media/converted", express.static(CONVERTED_DIR));

db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS audio_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  original_path TEXT NOT NULL,
  mime_type TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audio_conversions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audio_file_id INTEGER NOT NULL,
  converted_name TEXT NOT NULL,
  converted_path TEXT NOT NULL,
  sample_rate INTEGER NOT NULL,
  channels INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(audio_file_id, sample_rate, channels),
  FOREIGN KEY(audio_file_id) REFERENCES audio_files(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS speakers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  port INTEGER DEFAULT 80,
  stream_port INTEGER DEFAULT 5000,
  volume INTEGER DEFAULT 80,
  relay_pre_delay_ms INTEGER DEFAULT 500,
  relay_off_delay_ms INTEGER DEFAULT 10000,
  energy_after_play_delay_ms INTEGER DEFAULT 15000,
  modem_sleep_after_relay_delay_ms INTEGER DEFAULT 5000,
  light_sleep_after_modem_delay_ms INTEGER DEFAULT 5400000,
  default_idle_power_mode TEXT DEFAULT 'light-sleep',
  desired_power_mode TEXT DEFAULT 'normal',
  after_play_power_mode TEXT DEFAULT 'light-sleep',
  wait_normal_timeout_ms INTEGER DEFAULT 45000,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS speaker_playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  speaker_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  current_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(speaker_id) REFERENCES speakers(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS speaker_playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  audio_file_id INTEGER NOT NULL,
  position INTEGER NOT NULL,
  FOREIGN KEY(playlist_id) REFERENCES speaker_playlists(id) ON DELETE CASCADE,
  FOREIGN KEY(audio_file_id) REFERENCES audio_files(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS weekly_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  speaker_id INTEGER NOT NULL,
  playlist_id INTEGER,
  day_of_week INTEGER DEFAULT 1,
  days TEXT DEFAULT '[1]',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  inside_power_mode TEXT DEFAULT 'modem-sleep',
  outside_power_mode TEXT DEFAULT 'light-sleep',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(speaker_id) REFERENCES speakers(id) ON DELETE CASCADE,
  FOREIGN KEY(playlist_id) REFERENCES speaker_playlists(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS zigbee_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  friendly_name TEXT NOT NULL UNIQUE,
  ieee_address TEXT,
  topic TEXT,
  type TEXT DEFAULT 'pir',
  last_seen TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trigger_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  speaker_id INTEGER NOT NULL,
  playlist_id INTEGER NOT NULL,
  cooldown_ms INTEGER DEFAULT 30000,
  enabled INTEGER DEFAULT 1,
  last_trigger_at INTEGER DEFAULT 0,
  trigger_count INTEGER DEFAULT 0,
  sample_rate INTEGER DEFAULT 22050,
  channels INTEGER DEFAULT 1,
  mode TEXT DEFAULT 'rtp',
  FOREIGN KEY(device_id) REFERENCES zigbee_devices(id) ON DELETE CASCADE,
  FOREIGN KEY(speaker_id) REFERENCES speakers(id) ON DELETE CASCADE,
  FOREIGN KEY(playlist_id) REFERENCES speaker_playlists(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

function migrateV11(){
  const sc=db.prepare('PRAGMA table_info(speakers)').all().map(c=>c.name);
  const addS=(n,def)=>{ if(!sc.includes(n)) db.exec(`ALTER TABLE speakers ADD COLUMN ${n} ${def}`); };
  addS('modem_sleep_after_relay_delay_ms','INTEGER DEFAULT 5000');
  addS('light_sleep_after_modem_delay_ms','INTEGER DEFAULT 5400000');
  addS('default_idle_power_mode',"TEXT DEFAULT 'light-sleep'");
  const wc=db.prepare('PRAGMA table_info(weekly_schedule)').all().map(c=>c.name);
  const addW=(n,def)=>{ if(!wc.includes(n)) db.exec(`ALTER TABLE weekly_schedule ADD COLUMN ${n} ${def}`); };
  addW('days',"TEXT DEFAULT '[1]'");
  addW('inside_power_mode',"TEXT DEFAULT 'modem-sleep'");
  addW('outside_power_mode',"TEXT DEFAULT 'light-sleep'");
}
migrateV11();


function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO app_settings(key, value)
    VALUES (?, ?)
    ON CONFLICT(key)
    DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

const storedPowerPollPort = Number(getSetting('power_poll_port', POWER_POLL_PORT));
if (Number.isInteger(storedPowerPollPort) && storedPowerPollPort > 0 && storedPowerPollPort <= 65535) {
  POWER_POLL_PORT = storedPowerPollPort;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
function getLocalIps(){ const nets=os.networkInterfaces(), ips=[]; for(const n of Object.keys(nets)) for(const net of nets[n]||[]) if(net.family==='IPv4'&&!net.internal) ips.push(net.address); return ips; }
function normalizePowerMode(mode){ if(mode==='sleep'||mode==='light_sleep') return 'light-sleep'; if(mode==='modem_sleep') return 'modem-sleep'; if(mode==='none') return 'normal'; return mode || 'normal'; }

function validatePowerPollPort(port) {
  const p = Number(port);
  const forbiddenPorts = new Set([PORT, 22, 80, 443]);

  if (!Number.isInteger(p)) {
    const err = new Error("Port réveil invalide");
    err.statusCode = 400;
    throw err;
  }

  if (p < 1024 || p > 65535) {
    const err = new Error("Le port réveil doit être compris entre 1024 et 65535");
    err.statusCode = 400;
    throw err;
  }

  if (forbiddenPorts.has(p)) {
    const err = new Error(`Le port ${p} est réservé ou déjà utilisé par le système/backend`);
    err.statusCode = 400;
    throw err;
  }

  return p;
}

function powerRouteForMode(mode){ const m=normalizePowerMode(mode); return m==='modem-sleep'?'/api/power/modem-sleep':m==='light-sleep'?'/api/power/light-sleep':'/api/power/normal'; }
function setDesiredPowerMode(speakerId, mode, reason='manual'){ const m=normalizePowerMode(mode); db.prepare('UPDATE speakers SET desired_power_mode=? WHERE id=?').run(m, speakerId); addDebugLog({type:'power_consigne', direction:'Node → Consigne serveur', speakerId, mode:m, reason, json:{mode:m}}); }
async function sendDirectPowerCommand(speaker, mode, timeout=1500){ return espPost(speaker, powerRouteForMode(mode), {}, timeout); }
async function getEspPowerMode(speaker, timeout=1500){ const res=await espGet(speaker, '/api/power', timeout); const raw=res.data?.mode || res.data?.power || res.data?.state || res.data; return normalizePowerMode(typeof raw==='string'?raw:res.data?.mode); }
async function requireEspAwake(speaker){ try { const mode=await getEspPowerMode(speaker); if(mode==='light-sleep') throw new Error('ESP32 en light-sleep'); return mode; } catch(e){ const err=new Error("ESP32 probablement en light-sleep : action impossible immédiatement. Lance une lecture pour demander le réveil ou attends son réveil périodique."); err.statusCode=409; throw err; } }
async function requestPowerMode(speaker, mode){ const m=normalizePowerMode(mode); setDesiredPowerMode(speaker.id, m); try { await sendDirectPowerCommand(speaker, m); return {direct:true, mode:m}; } catch(e){ console.warn(`[power ${speaker.name}] commande directe impossible (${m}) : ${e.message}`); return {direct:false, mode:m, warning:'ESP32 non joignable, consigne enregistrée pour prochain polling', error:e.message}; } }
async function requestNormalAndWait(speaker){ setDesiredPowerMode(speaker.id, 'normal'); try { await sendDirectPowerCommand(speaker, 'normal'); } catch(e){ console.warn(`[power ${speaker.name}] normal direct impossible, attente réveil périodique : ${e.message}`); }
  const timeoutMs=Number(speaker.wait_normal_timeout_ms||45000), start=Date.now();
  while(Date.now()-start<timeoutMs){ try{ const mode=await getEspPowerMode(speaker); if(mode==='normal') return true; } catch{} await sleep(1000); }
  throw new Error(`Timeout : ESP32 ${speaker.name} non réveillé en mode normal dans le délai paramétré`);
}
async function setRelay(speaker,state){ await espPost(speaker, `/api/relay/${state}`, {}, 2500); }
function clearTimer(map,id){ const t=map.get(id); if(t) clearTimeout(t); map.delete(id); }
function clearSpeakerTimers(id){ clearTimer(relayTimers,id); clearTimer(energyTimers,id); clearTimer(modemTimers,id); clearTimer(lightTimers,id); }
function stopStream(id){ const p=runningStreams.get(id); if(p) p.kill('SIGTERM'); runningStreams.delete(id); }
function convertToWav(inputPath, outputPath, sampleRate, channels){ return new Promise((resolve,reject)=>{ ffmpeg(inputPath).audioCodec('pcm_s16le').audioFrequency(sampleRate).audioChannels(channels).format('wav').on('end', resolve).on('error', reject).save(outputPath); }); }
async function ensureConversion(audioFile, sampleRate, channels){ const ex=db.prepare('SELECT * FROM audio_conversions WHERE audio_file_id=? AND sample_rate=? AND channels=?').get(audioFile.id,sampleRate,channels); if(ex&&fs.existsSync(ex.converted_path)) return ex; const base=path.parse(audioFile.stored_name).name, name=`${base}-${sampleRate}hz-${channels}ch.wav`, out=path.join(CONVERTED_DIR,name); await convertToWav(audioFile.original_path,out,sampleRate,channels); db.prepare(`INSERT INTO audio_conversions(audio_file_id,converted_name,converted_path,sample_rate,channels) VALUES(?,?,?,?,?) ON CONFLICT(audio_file_id,sample_rate,channels) DO UPDATE SET converted_name=excluded.converted_name, converted_path=excluded.converted_path, created_at=CURRENT_TIMESTAMP`).run(audioFile.id,name,out,sampleRate,channels); return db.prepare('SELECT * FROM audio_conversions WHERE audio_file_id=? AND sample_rate=? AND channels=?').get(audioFile.id,sampleRate,channels); }
function buildFfmpegArgs({inputPath,mode,sampleRate,channels,ip,port}){ if(mode==='rtp') return ['-re','-i',inputPath,'-acodec','pcm_s16be','-f','rtp','-ac',String(channels),'-ar',String(sampleRate),`rtp://${ip}:${port}`]; return ['-re','-i',inputPath,'-acodec','pcm_s16be','-f','s16be','-ac',String(channels),'-ar',String(sampleRate),`udp://${ip}:${port}`]; }
async function sendAudioVolumeConfig(speaker, volumePercent, timeout=1500){ const vol=Math.max(0,Math.min(100,Number(volumePercent??speaker.volume??80))); const audioVolume=vol/100.0; const response=await espPost(speaker, '/api/config', {audioVolume}, timeout); return {volume:vol,audioVolume,response:response.data}; }
async function streamOneFile({speaker,conversion,mode,sampleRate,channels}){ stopStream(speaker.id); clearSpeakerTimers(speaker.id); await requestNormalAndWait(speaker); try{ await sendAudioVolumeConfig(speaker,speaker.volume); } catch(e){ console.warn(`[volume ${speaker.name}] config volume impossible : ${e.message}`); } try{ await setRelay(speaker,'on'); } catch(e){ console.warn(`[relay ${speaker.name}] ON impossible : ${e.message}`); } await sleep(Number(speaker.relay_pre_delay_ms||500)); const args=buildFfmpegArgs({inputPath:conversion.converted_path,mode,sampleRate,channels,ip:speaker.ip,port:speaker.stream_port||5000}); console.log(`[stream ${speaker.name}] ffmpeg ${args.join(' ')}`); addDebugLog({type:'ffmpeg_start', direction:'Node → ffmpeg', speakerId:speaker.id, speaker:speaker.name, args}); const proc=spawn('ffmpeg', args, {stdio:['ignore','ignore','pipe']}); runningStreams.set(speaker.id, proc); proc.stderr.on('data', d=>{ const t=String(d); if(t.includes('Error')||t.includes('Invalid')||t.includes('Connection')) { console.warn(`[ffmpeg ${speaker.name}] ${t}`); addDebugLog({type:'ffmpeg_stderr', speakerId:speaker.id, speaker:speaker.name, text:t.slice(0,1000)}); } }); proc.on('close',(code)=>{ addDebugLog({type:'ffmpeg_close', speakerId:speaker.id, speaker:speaker.name, code}); if(runningStreams.get(speaker.id)===proc) runningStreams.delete(speaker.id); const relayDelay=Number(speaker.relay_off_delay_ms||10000); const modemDelay=Number(speaker.modem_sleep_after_relay_delay_ms||5000); const lightDelay=Number(speaker.light_sleep_after_modem_delay_ms||5400000); addDebugLog({type:'energy_sequence_scheduled', direction:'Node', speakerId:speaker.id, speaker:speaker.name, json:{relayOffAfterMs:relayDelay, modemSleepAfterRelayMs:modemDelay, lightSleepAfterModemMs:lightDelay}}); const rt=setTimeout(async()=>{ try{ await setRelay(speaker,'off'); }catch(e){ console.warn(`[relay ${speaker.name}] OFF impossible : ${e.message}`); } relayTimers.delete(speaker.id); const mt=setTimeout(async()=>{ await requestPowerMode(speaker,'modem-sleep'); modemTimers.delete(speaker.id); const lt=setTimeout(async()=>{ await requestPowerMode(speaker,'light-sleep'); lightTimers.delete(speaker.id); }, lightDelay); lightTimers.set(speaker.id,lt); }, modemDelay); modemTimers.set(speaker.id,mt); }, relayDelay); relayTimers.set(speaker.id,rt); }); proc.on('error', e=>{ runningStreams.delete(speaker.id); addDebugLog({type:'ffmpeg_error', speakerId:speaker.id, speaker:speaker.name, error:e.message}); console.error(`[stream ${speaker.name}] ${e.message}`); }); }

const storage=multer.diskStorage({destination:UPLOAD_DIR, filename:(req,file,cb)=>{ const safe=file.originalname.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]/g,'_'); cb(null,`${Date.now()}-${safe}`); }});
const upload=multer({storage, limits:{fileSize:200*1024*1024}, fileFilter:(req,file,cb)=>{ if(String(file.mimetype).startsWith('audio/')||/\.(mp3|wav|flac|ogg)$/i.test(file.originalname)) cb(null,true); else cb(new Error('Format audio non supporté')); }});



function getZigbeeSettings() {
  return {
    mqttUrl: getSetting('mqtt_url', 'mqtt://localhost:1883'),
    zigbeeBaseTopic: getSetting('zigbee_base_topic', 'zigbee2mqtt')
  };
}

function upsertZigbeeDevice({ friendlyName, topic, ieeeAddress = null, type = 'pir' }) {
  if (!friendlyName || friendlyName === 'bridge') return null;
  const existing = db.prepare('SELECT * FROM zigbee_devices WHERE friendly_name = ?').get(friendlyName);
  if (existing) {
    db.prepare(`UPDATE zigbee_devices SET topic = ?, ieee_address = COALESCE(?, ieee_address), type = COALESCE(?, type), last_seen = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(topic, ieeeAddress, type, existing.id);
    return db.prepare('SELECT * FROM zigbee_devices WHERE id = ?').get(existing.id);
  }
  const result = db.prepare(`INSERT INTO zigbee_devices(friendly_name, ieee_address, topic, type, last_seen) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`)
    .run(friendlyName, ieeeAddress, topic, type);
  return db.prepare('SELECT * FROM zigbee_devices WHERE id = ?').get(result.lastInsertRowid);
}

function parseZigbeeFriendlyName(topic) {
  const { zigbeeBaseTopic } = getZigbeeSettings();
  const prefix = `${zigbeeBaseTopic}/`;
  if (!topic.startsWith(prefix)) return null;
  const rest = topic.slice(prefix.length);
  const first = rest.split('/')[0];
  if (!first || first === 'bridge') return null;
  return first;
}

function isPirMotionPayload(payload) {
  return payload && (payload.occupancy === true || payload.motion === true || payload.presence === true);
}

async function handlePirTrigger(topic, payload) {
  const friendlyName = parseZigbeeFriendlyName(topic);
  if (!friendlyName) return;
  const device = upsertZigbeeDevice({ friendlyName, topic, type: 'pir' });
  if (!device || !device.enabled) return;
  if (!isPirMotionPayload(payload)) return;

  const rules = db.prepare(`
    SELECT tr.*, zd.friendly_name, s.name AS speaker_name, sp.name AS playlist_name
    FROM trigger_rules tr
    JOIN zigbee_devices zd ON zd.id = tr.device_id
    JOIN speakers s ON s.id = tr.speaker_id
    JOIN speaker_playlists sp ON sp.id = tr.playlist_id
    WHERE tr.device_id = ? AND tr.enabled = 1
  `).all(device.id);

  for (const rule of rules) {
    const now = Date.now();
    const cooldown = Number(rule.cooldown_ms || 30000);
    if (now - Number(rule.last_trigger_at || 0) < cooldown) {
      addDebugLog({ type: 'zigbee_cooldown', direction: 'Zigbee → Node', device: friendlyName, ruleId: rule.id, remainingMs: cooldown - (now - Number(rule.last_trigger_at || 0)) });
      continue;
    }
    if (runningStreams.has(rule.speaker_id)) {
      addDebugLog({ type: 'zigbee_ignored', direction: 'Zigbee → Node', reason: 'already_playing', device: friendlyName, ruleId: rule.id, speakerId: rule.speaker_id });
      continue;
    }

    db.prepare('UPDATE trigger_rules SET last_trigger_at = ?, trigger_count = trigger_count + 1 WHERE id = ?').run(now, rule.id);
    addDebugLog({ type: 'zigbee_trigger_play', direction: 'Zigbee → Node', device: friendlyName, ruleId: rule.id, speakerId: rule.speaker_id, playlistId: rule.playlist_id, json: payload });

    try {
      const playlist = db.prepare('SELECT * FROM speaker_playlists WHERE id = ?').get(rule.playlist_id);
      const currentIndex = Number(playlist?.current_index || 0);
      await playIndex({
        speakerId: rule.speaker_id,
        playlistId: rule.playlist_id,
        index: currentIndex,
        mode: rule.mode || 'rtp',
        sampleRate: Number(rule.sample_rate || 22050),
        channels: Number(rule.channels || 1)
      });
      const items = getPlaylistItems(rule.playlist_id);
      if (items.length) {
        const nextIndex = (currentIndex + 1) % items.length;
        db.prepare('UPDATE speaker_playlists SET current_index = ? WHERE id = ?').run(nextIndex, rule.playlist_id);
        addDebugLog({ type: 'zigbee_playlist_advance', device: friendlyName, playlistId: rule.playlist_id, previousIndex: currentIndex, nextIndex });
      }
    } catch (error) {
      addDebugLog({ type: 'zigbee_trigger_error', device: friendlyName, ruleId: rule.id, error: error.message });
    }
  }
}

function startMqttClient() {
  const { mqttUrl, zigbeeBaseTopic } = getZigbeeSettings();
  if (mqttClient) {
    try { mqttClient.end(true); } catch {}
  }
  mqttConnected = false;
  mqttLastError = null;
  mqttSubscribed = false;

  mqttClient = mqtt.connect(mqttUrl, { reconnectPeriod: 5000, connectTimeout: 5000 });

  mqttClient.on('connect', () => {
    mqttConnected = true;
    mqttLastError = null;
    const topic = `${zigbeeBaseTopic}/#`;
    mqttClient.subscribe(topic, err => {
      mqttSubscribed = !err;
      addDebugLog({ type: 'mqtt_connect', direction: 'MQTT → Node', mqttUrl, topic, error: err ? err.message : null });
    });
  });

  mqttClient.on('reconnect', () => addDebugLog({ type: 'mqtt_reconnect', mqttUrl }));
  mqttClient.on('close', () => { mqttConnected = false; addDebugLog({ type: 'mqtt_close' }); });
  mqttClient.on('error', err => { mqttLastError = err.message; addDebugLog({ type: 'mqtt_error', error: err.message }); });

  mqttClient.on('message', async (topic, payloadBuffer) => {
    let payload = null;
    const text = payloadBuffer.toString();
    try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    addDebugLog({ type: 'zigbee_message', direction: 'Zigbee/MQTT → Node', topic, json: payload });
    const friendlyName = parseZigbeeFriendlyName(topic);
    if (friendlyName) upsertZigbeeDevice({ friendlyName, topic, type: payload.occupancy !== undefined ? 'pir' : 'zigbee' });
    try { await handlePirTrigger(topic, payload); } catch (error) { addDebugLog({ type: 'zigbee_handle_error', topic, error: error.message }); }
  });
}

function mqttPublish(topic, body) {
  if (!mqttClient || !mqttConnected) throw new Error('MQTT non connecté');
  mqttClient.publish(topic, JSON.stringify(body));
  addDebugLog({ type: 'mqtt_publish', direction: 'Node → MQTT', topic, json: body });
}

app.get('/api/settings', (req, res) => {
  res.json({
    powerPollPort: Number(getSetting('power_poll_port', POWER_POLL_PORT)),
    activePowerPollPort: POWER_POLL_PORT,
    powerPollUrl: `http://${getLocalIps()[0] || 'IP_DU_SERVEUR'}:${POWER_POLL_PORT}/api/esp32/mode`,
    mqttUrl: getSetting('mqtt_url', 'mqtt://localhost:1883'),
    zigbeeBaseTopic: getSetting('zigbee_base_topic', 'zigbee2mqtt'),
    restartRequired: false
  });
});

app.post("/api/settings", (req, res) => {
  const requestedPort = validatePowerPollPort(req.body.powerPollPort);
  setSetting("power_poll_port", requestedPort);
  if (req.body.mqttUrl) setSetting('mqtt_url', req.body.mqttUrl);
  if (req.body.zigbeeBaseTopic) setSetting('zigbee_base_topic', req.body.zigbeeBaseTopic);
  startMqttClient();

  res.json({
    ok: true,
    powerPollPort: requestedPort,
    restartRequired: true,
    message: "Port sauvegardé. Redémarre le backend pour appliquer le nouveau port de réveil."
  });
});

app.get('/api/debug', (req, res) => {
  res.json({
    enabled: debugEnabled,
    count: debugLogs.length,
    logs: debugLogs
  });
});

app.post('/api/debug/enabled', (req, res) => {
  debugEnabled = Boolean(req.body.enabled);
  addDebugLog({ type: 'debug', message: `Debug ${debugEnabled ? 'activé' : 'désactivé'}` });
  res.json({ ok: true, enabled: debugEnabled });
});

app.delete('/api/debug', (req, res) => {
  debugLogs.length = 0;
  res.json({ ok: true });
});

app.get('/api/health',(req,res)=>res.json({ok:true,localIps:getLocalIps(),runningStreams:Array.from(runningStreams.keys()),debugEnabled,powerPollPort:POWER_POLL_PORT,configuredPowerPollPort:Number(getSetting('power_poll_port', POWER_POLL_PORT))}));

function handlePowerPoll(req,res){ let speaker=null; const remoteIp=String(req.ip||req.socket?.remoteAddress||'').replace('::ffff:',''); addDebugLog({type:'esp32_power_poll_request', direction:'ESP32 → Node', method:req.method, path:req.originalUrl, remoteIp, query:sanitizeDebugBody(req.query)}); if(req.query.speakerId) speaker=db.prepare('SELECT * FROM speakers WHERE id=?').get(req.query.speakerId); else if(req.query.ip) speaker=db.prepare('SELECT * FROM speakers WHERE ip=?').get(req.query.ip); else if(remoteIp) speaker=db.prepare('SELECT * FROM speakers WHERE ip=?').get(remoteIp); else speaker=db.prepare('SELECT * FROM speakers ORDER BY id LIMIT 1').get(); if(!speaker){ const json={error:'speaker_not_found',mode:'light-sleep'}; addDebugLog({type:'esp32_power_poll_response', direction:'Node → ESP32', status:404, json}); return res.status(404).json(json); } const json={mode:normalizePowerMode(speaker.desired_power_mode||'light-sleep'), speakerId:speaker.id, name:speaker.name}; addDebugLog({type:'esp32_power_poll_response', direction:'Node → ESP32', speakerId:speaker.id, speaker:speaker.name, status:200, json}); res.json(json);}
app.get('/api/esp32/mode',handlePowerPoll);
app.post('/api/esp32/mode',(req,res)=>{ const speaker=req.body.speakerId?db.prepare('SELECT * FROM speakers WHERE id=?').get(req.body.speakerId):db.prepare('SELECT * FROM speakers ORDER BY id LIMIT 1').get(); if(!speaker) return res.status(404).json({error:'speaker_not_found'}); const mode=normalizePowerMode(req.body.mode); setDesiredPowerMode(speaker.id, mode); res.json({ok:true,speakerId:speaker.id,mode}); });

app.post('/api/files/upload', upload.single('file'), asyncRoute(async(req,res)=>{ const sr=Number(req.body.sampleRate||22050), ch=Number(req.body.channels||1); if(!req.file) return res.status(400).json({error:'Aucun fichier reçu'}); const r=db.prepare('INSERT INTO audio_files(original_name,stored_name,original_path,mime_type) VALUES(?,?,?,?)').run(req.file.originalname,req.file.filename,req.file.path,req.file.mimetype); const f=db.prepare('SELECT * FROM audio_files WHERE id=?').get(r.lastInsertRowid); const conversion=await ensureConversion(f,sr,ch); res.json({id:f.id,originalName:f.original_name,conversion}); }));
app.get('/api/files',(req,res)=>{ const files=db.prepare('SELECT * FROM audio_files ORDER BY created_at DESC').all(); const cs=db.prepare('SELECT id,converted_name,sample_rate,channels FROM audio_conversions WHERE audio_file_id=? ORDER BY sample_rate,channels'); res.json(files.map(f=>({...f,conversions:cs.all(f.id)}))); });
app.post('/api/files/:id/convert', asyncRoute(async(req,res)=>{ const f=db.prepare('SELECT * FROM audio_files WHERE id=?').get(req.params.id); if(!f) return res.status(404).json({error:'Fichier introuvable'}); const conversion=await ensureConversion(f,Number(req.body.sampleRate||22050),Number(req.body.channels||1)); res.json({ok:true,conversion}); }));
app.delete('/api/files/:id',(req,res)=>{ const f=db.prepare('SELECT * FROM audio_files WHERE id=?').get(req.params.id); if(!f) return res.status(404).json({error:'Fichier introuvable'}); for(const c of db.prepare('SELECT * FROM audio_conversions WHERE audio_file_id=?').all(req.params.id)) if(fs.existsSync(c.converted_path)) fs.unlinkSync(c.converted_path); if(fs.existsSync(f.original_path)) fs.unlinkSync(f.original_path); db.prepare('DELETE FROM audio_files WHERE id=?').run(req.params.id); res.json({ok:true}); });

app.get('/api/speakers',(req,res)=>res.json(db.prepare('SELECT * FROM speakers ORDER BY name').all()));
app.post('/api/speakers',(req,res)=>{ const b=req.body; if(!b.name||!b.ip) return res.status(400).json({error:'Nom et IP obligatoires'}); const r=db.prepare(`INSERT INTO speakers(name,ip,port,stream_port,volume,relay_pre_delay_ms,relay_off_delay_ms,energy_after_play_delay_ms,modem_sleep_after_relay_delay_ms,light_sleep_after_modem_delay_ms,desired_power_mode,after_play_power_mode,default_idle_power_mode,wait_normal_timeout_ms,enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(String(b.name).trim(),String(b.ip).trim(),Number(b.port||80),Number(b.stream_port||5000),Number(b.volume??80),Number(b.relay_pre_delay_ms??500),Number(b.relay_off_delay_ms??10000),Number(b.energy_after_play_delay_ms??15000),Number(b.modem_sleep_after_relay_delay_ms??5000),Number(b.light_sleep_after_modem_delay_ms??5400000),normalizePowerMode(b.desired_power_mode||'light-sleep'),normalizePowerMode(b.after_play_power_mode||'light-sleep'),normalizePowerMode(b.default_idle_power_mode||'light-sleep'),Number(b.wait_normal_timeout_ms??45000),b.enabled===false?0:1); res.json({id:r.lastInsertRowid}); });
app.put('/api/speakers/:id',(req,res)=>{ const b=req.body; db.prepare(`UPDATE speakers SET name=?,ip=?,port=?,stream_port=?,volume=?,relay_pre_delay_ms=?,relay_off_delay_ms=?,energy_after_play_delay_ms=?,modem_sleep_after_relay_delay_ms=?,light_sleep_after_modem_delay_ms=?,desired_power_mode=?,after_play_power_mode=?,default_idle_power_mode=?,wait_normal_timeout_ms=?,enabled=? WHERE id=?`).run(String(b.name||'').trim(),String(b.ip||'').trim(),Number(b.port||80),Number(b.stream_port||5000),Number(b.volume??80),Number(b.relay_pre_delay_ms??500),Number(b.relay_off_delay_ms??10000),Number(b.energy_after_play_delay_ms??15000),Number(b.modem_sleep_after_relay_delay_ms??5000),Number(b.light_sleep_after_modem_delay_ms??5400000),normalizePowerMode(b.desired_power_mode||'light-sleep'),normalizePowerMode(b.after_play_power_mode||'light-sleep'),normalizePowerMode(b.default_idle_power_mode||'light-sleep'),Number(b.wait_normal_timeout_ms??45000),b.enabled?1:0,req.params.id); res.json({ok:true}); });
app.delete('/api/speakers/:id',(req,res)=>{ stopStream(Number(req.params.id)); clearSpeakerTimers(Number(req.params.id)); db.prepare('DELETE FROM speakers WHERE id=?').run(req.params.id); res.json({ok:true}); });
app.get('/api/speakers/:id/status', asyncRoute(async(req,res)=>{ const s=db.prepare('SELECT * FROM speakers WHERE id=?').get(req.params.id); if(!s) return res.status(404).json({error:'Enceinte introuvable'}); let power,status; try{power=await getEspPowerMode(s);}catch(e){power={error:e.message};} try{status=(await espGet(s, '/api/status', 1500)).data;}catch(e){status={error:e.message};} res.json({speaker:s,desiredPowerMode:s.desired_power_mode,actualPowerMode:power,streaming:runningStreams.has(s.id),status}); }));
app.post('/api/speakers/:id/volume', asyncRoute(async(req,res)=>{ const s=db.prepare('SELECT * FROM speakers WHERE id=?').get(req.params.id); if(!s) return res.status(404).json({error:'Enceinte introuvable'}); await requireEspAwake(s); const volume=Math.max(0,Math.min(100,Number(req.body.volume??s.volume))); db.prepare('UPDATE speakers SET volume=? WHERE id=?').run(volume,s.id); const result=await sendAudioVolumeConfig(s, volume); res.json({ok:true,volume:result.volume,audioVolume:result.audioVolume,response:result.response}); }));
app.post('/api/speakers/:id/power', asyncRoute(async(req,res)=>{ const s=db.prepare('SELECT * FROM speakers WHERE id=?').get(req.params.id); if(!s) return res.status(404).json({error:'Enceinte introuvable'}); const mode=normalizePowerMode(req.body.mode||'normal'); if(mode!=='normal') await requireEspAwake(s); const result=await requestPowerMode(s,mode); res.json({ok:true,...result}); }));
app.post('/api/speakers/:id/relay', asyncRoute(async(req,res)=>{ const s=db.prepare('SELECT * FROM speakers WHERE id=?').get(req.params.id); if(!s) return res.status(404).json({error:'Enceinte introuvable'}); await requireEspAwake(s); const state=req.body.state==='off'?'off':'on'; await setRelay(s,state); res.json({ok:true,state}); }));

function getPlaylistItems(playlistId){ return db.prepare(`SELECT spi.id AS item_id, spi.position, af.* FROM speaker_playlist_items spi JOIN audio_files af ON af.id=spi.audio_file_id WHERE spi.playlist_id=? ORDER BY spi.position ASC`).all(playlistId); }
app.get('/api/speakers/:speakerId/playlists',(req,res)=>{ const ps=db.prepare('SELECT * FROM speaker_playlists WHERE speaker_id=? ORDER BY created_at DESC').all(req.params.speakerId); res.json(ps.map(p=>({...p,items:getPlaylistItems(p.id).map(i=>({id:i.item_id,audio_file_id:i.id,original_name:i.original_name,position:i.position}))}))); });
app.post('/api/speakers/:speakerId/playlists',(req,res)=>{ const r=db.prepare('INSERT INTO speaker_playlists(speaker_id,name) VALUES(?,?)').run(req.params.speakerId,req.body.name||'Nouvelle playlist'); res.json({id:r.lastInsertRowid}); });
app.delete('/api/speakers/:speakerId/playlists/:playlistId',(req,res)=>{ db.prepare('DELETE FROM speaker_playlists WHERE id=? AND speaker_id=?').run(req.params.playlistId,req.params.speakerId); res.json({ok:true}); });
app.post('/api/speakers/:speakerId/playlists/:playlistId/items',(req,res)=>{ const max=db.prepare('SELECT COALESCE(MAX(position),0) AS p FROM speaker_playlist_items WHERE playlist_id=?').get(req.params.playlistId).p; const r=db.prepare('INSERT INTO speaker_playlist_items(playlist_id,audio_file_id,position) VALUES(?,?,?)').run(req.params.playlistId,req.body.audioFileId,max+1); res.json({id:r.lastInsertRowid}); });
app.delete('/api/speakers/:speakerId/playlists/:playlistId/items/:itemId',(req,res)=>{ db.prepare('DELETE FROM speaker_playlist_items WHERE id=? AND playlist_id=?').run(req.params.itemId,req.params.playlistId); res.json({ok:true}); });
app.put('/api/speakers/:speakerId/playlists/:playlistId/reorder',(req,res)=>{ const tx=db.transaction(items=>{ for(const item of items) db.prepare('UPDATE speaker_playlist_items SET position=? WHERE id=? AND playlist_id=?').run(item.position,item.id,req.params.playlistId); }); tx(req.body.items||[]); res.json({ok:true}); });
async function playIndex({speakerId,playlistId,index,mode,sampleRate,channels}){ const s=db.prepare('SELECT * FROM speakers WHERE id=? AND enabled=1').get(speakerId); if(!s) throw new Error('Enceinte introuvable ou désactivée'); const p=db.prepare('SELECT * FROM speaker_playlists WHERE id=? AND speaker_id=?').get(playlistId,speakerId); if(!p) throw new Error('Playlist introuvable'); const items=getPlaylistItems(playlistId); if(!items.length) throw new Error('Playlist vide'); const ni=((Number(index)%items.length)+items.length)%items.length; const item=items[ni]; db.prepare('UPDATE speaker_playlists SET current_index=? WHERE id=?').run(ni,playlistId); const conversion=await ensureConversion(item,Number(sampleRate),Number(channels)); await streamOneFile({speaker:s,conversion,mode,sampleRate:Number(sampleRate),channels:Number(channels)}); return {speakerId:s.id,playlistId:p.id,currentIndex:ni,total:items.length,file:item.original_name}; }
app.post('/api/play', asyncRoute(async(req,res)=>{ const p=db.prepare('SELECT * FROM speaker_playlists WHERE id=?').get(req.body.playlistId); const r=await playIndex({speakerId:req.body.speakerId,playlistId:req.body.playlistId,index:p?.current_index||0,mode:req.body.mode||'rtp',sampleRate:req.body.sampleRate||22050,channels:req.body.channels||1}); res.json({ok:true,...r}); }));
app.post('/api/play-next', asyncRoute(async(req,res)=>{ const p=db.prepare('SELECT * FROM speaker_playlists WHERE id=?').get(req.body.playlistId); const r=await playIndex({speakerId:req.body.speakerId,playlistId:req.body.playlistId,index:Number(p?.current_index||0)+1,mode:req.body.mode||'rtp',sampleRate:req.body.sampleRate||22050,channels:req.body.channels||1}); res.json({ok:true,...r}); }));
app.post('/api/play-previous', asyncRoute(async(req,res)=>{ const p=db.prepare('SELECT * FROM speaker_playlists WHERE id=?').get(req.body.playlistId); const r=await playIndex({speakerId:req.body.speakerId,playlistId:req.body.playlistId,index:Number(p?.current_index||0)-1,mode:req.body.mode||'rtp',sampleRate:req.body.sampleRate||22050,channels:req.body.channels||1}); res.json({ok:true,...r}); }));
app.post('/api/stop', asyncRoute(async(req,res)=>{ const s=db.prepare('SELECT * FROM speakers WHERE id=?').get(req.body.speakerId); if(!s) return res.status(404).json({error:'Enceinte introuvable'}); await requireEspAwake(s); stopStream(s.id); clearSpeakerTimers(s.id); try{ await espPost(s, '/api/stop', {}, 1500); }catch{} try{ await setRelay(s,'off'); }catch{} await requestPowerMode(s,s.after_play_power_mode||'light-sleep'); res.json({ok:true}); }));


app.get('/api/zigbee/status', (req, res) => {
  const settings = getZigbeeSettings();
  res.json({ connected: mqttConnected, subscribed: mqttSubscribed, lastError: mqttLastError, ...settings });
});

app.post('/api/zigbee/reconnect', (req, res) => {
  if (req.body.mqttUrl) setSetting('mqtt_url', req.body.mqttUrl);
  if (req.body.zigbeeBaseTopic) setSetting('zigbee_base_topic', req.body.zigbeeBaseTopic);
  startMqttClient();
  res.json({ ok: true, ...getZigbeeSettings() });
});

app.post('/api/zigbee/permit-join', (req, res) => {
  const { zigbeeBaseTopic } = getZigbeeSettings();
  const time = Number(req.body.time || 120);
  mqttPublish(`${zigbeeBaseTopic}/bridge/request/permit_join`, { value: true, time });
  res.json({ ok: true, time });
});

app.post('/api/zigbee/permit-join/stop', (req, res) => {
  const { zigbeeBaseTopic } = getZigbeeSettings();
  mqttPublish(`${zigbeeBaseTopic}/bridge/request/permit_join`, { value: false });
  res.json({ ok: true });
});

app.get('/api/zigbee/devices', (req, res) => {
  res.json(db.prepare('SELECT * FROM zigbee_devices ORDER BY last_seen DESC, friendly_name').all());
});

app.put('/api/zigbee/devices/:id', (req, res) => {
  const b = req.body;
  db.prepare('UPDATE zigbee_devices SET friendly_name = ?, topic = ?, type = ?, enabled = ? WHERE id = ?')
    .run(String(b.friendly_name || '').trim(), String(b.topic || '').trim(), String(b.type || 'pir'), b.enabled ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.get('/api/zigbee/rules', (req, res) => {
  const rows = db.prepare(`
    SELECT tr.*, zd.friendly_name AS device_name, s.name AS speaker_name, sp.name AS playlist_name
    FROM trigger_rules tr
    JOIN zigbee_devices zd ON zd.id = tr.device_id
    JOIN speakers s ON s.id = tr.speaker_id
    JOIN speaker_playlists sp ON sp.id = tr.playlist_id
    ORDER BY tr.id DESC
  `).all();
  res.json(rows);
});

app.post('/api/zigbee/rules', (req, res) => {
  const b = req.body;
  const result = db.prepare(`
    INSERT INTO trigger_rules(device_id, speaker_id, playlist_id, cooldown_ms, enabled, sample_rate, channels, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.deviceId, b.speakerId, b.playlistId, Number(b.cooldownMs || 30000), b.enabled === false ? 0 : 1, Number(b.sampleRate || 22050), Number(b.channels || 1), b.mode || 'rtp');
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/zigbee/rules/:id', (req, res) => {
  const b = req.body;
  db.prepare(`
    UPDATE trigger_rules SET device_id = ?, speaker_id = ?, playlist_id = ?, cooldown_ms = ?, enabled = ?, sample_rate = ?, channels = ?, mode = ?
    WHERE id = ?
  `).run(b.deviceId, b.speakerId, b.playlistId, Number(b.cooldownMs || 30000), b.enabled ? 1 : 0, Number(b.sampleRate || 22050), Number(b.channels || 1), b.mode || 'rtp', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/zigbee/rules/:id', (req, res) => {
  db.prepare('DELETE FROM trigger_rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/schedule',(req,res)=>{ const rows=db.prepare(`SELECT ws.*,s.name AS speaker_name,sp.name AS playlist_name FROM weekly_schedule ws JOIN speakers s ON s.id=ws.speaker_id LEFT JOIN speaker_playlists sp ON sp.id=ws.playlist_id ORDER BY ws.start_time`).all(); res.json(rows.map(r=>({...r,days:JSON.parse(r.days||'[]')}))); });
app.post('/api/schedule',(req,res)=>{ const b=req.body; const days=JSON.stringify(Array.isArray(b.days)?b.days.map(Number):[Number(b.dayOfWeek??1)]); const r=db.prepare('INSERT INTO weekly_schedule(speaker_id,playlist_id,day_of_week,days,start_time,end_time,inside_power_mode,outside_power_mode,enabled) VALUES(?,?,?,?,?,?,?,?,?)').run(b.speakerId,b.playlistId||null,Number((b.days&&b.days[0])??b.dayOfWeek??1),days,b.startTime,b.endTime,normalizePowerMode(b.insidePowerMode||'modem-sleep'),normalizePowerMode(b.outsidePowerMode||'light-sleep'),b.enabled?1:0); res.json({id:r.lastInsertRowid}); });
app.delete('/api/schedule/:id',(req,res)=>{ db.prepare('DELETE FROM weekly_schedule WHERE id=?').run(req.params.id); res.json({ok:true}); });
startMqttClient();

app.use((err,req,res,next)=>{ console.error(err); addDebugLog({type:'api_error', direction:'Node', method:req.method, path:req.originalUrl, status:err.statusCode||500, error:err.message||'Erreur serveur'}); res.status(err.statusCode||500).json({error:err.message||'Erreur serveur'}); });
powerApp.get('/api/esp32/mode', handlePowerPoll);
powerApp.get('/', (req,res)=>res.send('<h1>ESP32 Power Poll Server</h1><p>/api/esp32/mode</p>'));
app.listen(PORT,'0.0.0.0',()=>{ console.log(`Backend lancé : http://0.0.0.0:${PORT}`); console.log(`IPs locales : ${getLocalIps().join(', ')}`); });
powerApp.listen(POWER_POLL_PORT,'0.0.0.0',()=>{ console.log(`Serveur réveil ESP32 : http://0.0.0.0:${POWER_POLL_PORT}/api/esp32/mode`); });
