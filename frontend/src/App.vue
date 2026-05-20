<script setup>
import { computed, onMounted, ref, watch } from "vue";

const API = `${window.location.protocol}//${window.location.hostname}:3000/api`;
const SERVER_HOST = window.location.hostname;
const page = ref("library");
const health = ref(null);
const files = ref([]);
const speakers = ref([]);
const playlists = ref([]);
const schedule = ref([]);
const selectedSpeakerId = ref(null);
const selectedPlaylistId = ref(null);
const selectedStatusSpeakerId = ref(null);
const sampleRate = ref(22050);
const channels = ref(1);
const mode = ref("rtp");
const uploadFile = ref(null);
const loading = ref(false);
const waitingWake = ref(false);
const message = ref("");
const status = ref(null);
const debug = ref({ enabled: true, logs: [] });
const debugFilter = ref("all");
const debugAutoRefresh = ref(false);
const settings = ref({ powerPollPort: 8080, activePowerPollPort: 8080, powerPollUrl: "", mqttUrl: "mqtt://localhost:1883", zigbeeBaseTopic: "zigbee2mqtt" });
const zigbeeStatus = ref({ connected: false });
const zigbeeDevices = ref([]);
const zigbeeRules = ref([]);
const newZigbeeRule = ref({ deviceId: null, speakerId: null, playlistId: null, cooldownMs: 30000, sampleRate: 22050, channels: 1, mode: "rtp", enabled: true });
let debugInterval = null;
const volumeTimers = {};

const filteredDebugLogs = computed(() => {
  const logs = debug.value.logs || [];

  if (debugFilter.value === "all") return logs;

  if (debugFilter.value === "front-back") {
    return logs.filter(log =>
      log.direction === "Vue/Client → Node" ||
      log.direction === "Node → Vue/Client"
    );
  }

  if (debugFilter.value === "back-esp32") {
    return logs.filter(log =>
      log.direction === "Node → ESP32" ||
      log.direction === "ESP32 → Node"
    );
  }

  if (debugFilter.value === "ffmpeg") {
    return logs.filter(log =>
      String(log.type || "").startsWith("ffmpeg")
    );
  }

  if (debugFilter.value === "power-poll") { return logs.filter(log => log.type === "esp32_power_poll_request" || log.type === "esp32_power_poll_response"); }

  if (debugFilter.value === "wakeup") { return logs.filter(log => String(log.type || "").startsWith("wakeup") || log.type === "power_consigne" || log.type === "energy_sequence_scheduled"); }

  if (debugFilter.value === "zigbee") { return logs.filter(log => String(log.type || "").includes("zigbee") || String(log.type || "").includes("mqtt")); }

  if (debugFilter.value === "errors") {
    return logs.filter(log =>
      log.error ||
      String(log.type || "").includes("error") ||
      String(log.type || "").includes("stderr")
    );
  }

  return logs;
});


const newSpeaker = ref({
  name: "",
  ip: "",
  port: 80,
  stream_port: 5000,
  volume: 80,
  relay_pre_delay_ms: 500,
  relay_off_delay_ms: 10000,
  energy_after_play_delay_ms: 15000,
  modem_sleep_after_relay_delay_ms: 5000,
  light_sleep_after_modem_delay_ms: 5400000,
  default_idle_power_mode: "light-sleep",
  desired_power_mode: "normal",
  default_idle_power_mode: "light-sleep",
  wait_normal_timeout_ms: 45000,
  insidePowerMode: "modem-sleep",
  outsidePowerMode: "light-sleep",
  enabled: true
});

const newSchedule = ref({
  speakerId: null,
  playlistId: null,
  days: [1,2,3,4,5,6,0],
  startTime: "09:00",
  endTime: "19:00",
  enabled: true
});

const selectedPlaylist = computed(() => playlists.value.find(p => p.id === selectedPlaylistId.value));

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Erreur API");
  return data;
}

function msToHours(ms) { return Math.floor(Number(ms || 0) / 3600000); }
function msToMinutesRemainder(ms) { return Math.floor((Number(ms || 0) % 3600000) / 60000); }
function hoursMinutesToMs(hours, minutes) { return Number(hours || 0) * 3600000 + Number(minutes || 0) * 60000; }
function toggleDay(obj, day) { const set = new Set(obj.days || []); if (set.has(day)) set.delete(day); else set.add(day); obj.days = Array.from(set).sort((a,b)=>(a||7)-(b||7)); }

function toast(text) {
  message.value = text;
  setTimeout(() => { if (message.value === text) message.value = ""; }, 5000);
}

async function action(fn) {
  loading.value = true;
  try { await fn(); } catch (error) { toast(error.message); }
  finally { loading.value = false; }
}

async function refresh() {
  await Promise.all([loadHealth(), loadSettings(), loadFiles(), loadSpeakers(), loadSchedule()]);
  await loadPlaylists();
}
async function loadHealth() { health.value = await api("/health"); }
async function loadFiles() { files.value = await api("/files"); }
async function loadSpeakers() {
  speakers.value = await api("/speakers");
  if (!selectedSpeakerId.value && speakers.value.length) selectedSpeakerId.value = speakers.value[0].id;
  if (!selectedStatusSpeakerId.value && speakers.value.length) selectedStatusSpeakerId.value = speakers.value[0].id;
  if (!newSchedule.value.speakerId && speakers.value.length) newSchedule.value.speakerId = speakers.value[0].id;
}
async function loadPlaylists() {
  if (!selectedSpeakerId.value) { playlists.value = []; selectedPlaylistId.value = null; return; }
  playlists.value = await api(`/speakers/${selectedSpeakerId.value}/playlists`);
  if (!playlists.value.some(p => p.id === selectedPlaylistId.value)) selectedPlaylistId.value = playlists.value[0]?.id || null;
  if (!newSchedule.value.playlistId && playlists.value.length) newSchedule.value.playlistId = playlists.value[0].id;
}
async function loadSchedule() { schedule.value = await api("/schedule"); }
watch(selectedSpeakerId, loadPlaylists);
function fileSelected(e) { uploadFile.value = e.target.files?.[0] || null; }

async function uploadAudio() { await action(async () => {
  if (!uploadFile.value) return;
  const form = new FormData();
  form.append("file", uploadFile.value); form.append("sampleRate", sampleRate.value); form.append("channels", channels.value);
  await api("/files/upload", { method: "POST", body: form });
  uploadFile.value = null; await loadFiles(); toast("Fichier déposé.");
}); }
async function convertFile(id) { await action(async () => {
  await api(`/files/${id}/convert`, { method: "POST", body: JSON.stringify({ sampleRate: sampleRate.value, channels: channels.value }) });
  await loadFiles(); toast("Conversion créée.");
}); }
async function deleteFile(id) { if (!confirm("Supprimer ce fichier ?")) return; await action(async () => { await api(`/files/${id}`, { method: "DELETE" }); await loadFiles(); await loadPlaylists(); }); }
async function createSpeaker() { await action(async () => { await api("/speakers", { method: "POST", body: JSON.stringify(newSpeaker.value) }); newSpeaker.value.name = ""; newSpeaker.value.ip = ""; await loadSpeakers(); toast("Enceinte ajoutée."); }); }
async function updateSpeaker(s) { await action(async () => { await api(`/speakers/${s.id}`, { method: "PUT", body: JSON.stringify(s) }); await loadSpeakers(); toast("Enceinte sauvegardée."); }); }
async function deleteSpeaker(id) { if (!confirm("Supprimer cette enceinte ?")) return; await action(async () => { await api(`/speakers/${id}`, { method: "DELETE" }); await refresh(); }); }
async function sendVolume(s) { await action(async () => { await api(`/speakers/${s.id}/volume`, { method: "POST", body: JSON.stringify({ volume: s.volume }) }); toast("Volume envoyé."); }); }
function sendVolumeRealtime(s) {
  clearTimeout(volumeTimers[s.id]);
  volumeTimers[s.id] = setTimeout(async () => {
    try { await api(`/speakers/${s.id}/volume`, { method: "POST", body: JSON.stringify({ volume: Number(s.volume) }) }); }
    catch (e) { toast(e.message); }
  }, 100);
}
async function setPower(s, powerMode) { await action(async () => { const r = await api(`/speakers/${s.id}/power`, { method: "POST", body: JSON.stringify({ mode: powerMode }) }); await loadSpeakers(); toast(r.warning || `Consigne ${powerMode} envoyée.`); }); }
async function setRelay(s, state) { await action(async () => { await api(`/speakers/${s.id}/relay`, { method: "POST", body: JSON.stringify({ state }) }); toast(`Relais ${state}.`); }); }
async function loadStatus() { if (!selectedStatusSpeakerId.value) return; try { status.value = await api(`/speakers/${selectedStatusSpeakerId.value}/status`); } catch(e) { status.value = { error: e.message }; } }
async function createPlaylist() { await action(async () => { const name = prompt("Nom de la playlist ?"); if (!name) return; await api(`/speakers/${selectedSpeakerId.value}/playlists`, { method: "POST", body: JSON.stringify({ name }) }); await loadPlaylists(); }); }
async function deletePlaylist(id) { if (!confirm("Supprimer cette playlist ?")) return; await action(async () => { await api(`/speakers/${selectedSpeakerId.value}/playlists/${id}`, { method: "DELETE" }); await loadPlaylists(); }); }
async function addToPlaylist(audioFileId) { await action(async () => { if (!selectedSpeakerId.value || !selectedPlaylistId.value) { toast("Sélectionne une enceinte et une playlist."); return; } await api(`/speakers/${selectedSpeakerId.value}/playlists/${selectedPlaylistId.value}/items`, { method: "POST", body: JSON.stringify({ audioFileId }) }); await loadPlaylists(); }); }
async function removeItem(itemId) { await action(async () => { await api(`/speakers/${selectedSpeakerId.value}/playlists/${selectedPlaylistId.value}/items/${itemId}`, { method: "DELETE" }); await loadPlaylists(); }); }
async function moveItem(item, direction) { await action(async () => { const list = [...selectedPlaylist.value.items]; const i = list.findIndex(x => x.id === item.id); const j = i + direction; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; await api(`/speakers/${selectedSpeakerId.value}/playlists/${selectedPlaylistId.value}/reorder`, { method: "PUT", body: JSON.stringify({ items: list.map((x, idx) => ({ id: x.id, position: idx + 1 })) }) }); await loadPlaylists(); }); }
async function playEndpoint(endpoint, label) { await action(async () => { waitingWake.value = true; toast("Lecture demandée : attente du réveil ESP32 si nécessaire..."); await api(endpoint, { method: "POST", body: JSON.stringify({ speakerId: selectedSpeakerId.value, playlistId: selectedPlaylistId.value, mode: mode.value, sampleRate: sampleRate.value, channels: channels.value }) }); await loadPlaylists(); toast(label); waitingWake.value = false; }); waitingWake.value = false; }
const playCurrent = () => playEndpoint("/play", "Lecture fichier courant.");
const playNext = () => playEndpoint("/play-next", "Lecture fichier suivant.");
const playPrevious = () => playEndpoint("/play-previous", "Lecture fichier précédent.");
async function stop() { await action(async () => { await api("/stop", { method: "POST", body: JSON.stringify({ speakerId: selectedSpeakerId.value }) }); toast("Stop envoyé."); }); }
async function addSchedule() { await action(async () => { await api("/schedule", { method: "POST", body: JSON.stringify(newSchedule.value) }); await loadSchedule(); toast("Programmation ajoutée."); }); }
async function deleteSchedule(id) { await action(async () => { await api(`/schedule/${id}`, { method: "DELETE" }); await loadSchedule(); }); }

async function loadDebug() {
  debug.value = await api("/debug");
}

async function toggleDebug() {
  await api("/debug/enabled", {
    method: "POST",
    body: JSON.stringify({ enabled: debug.value.enabled })
  });
  await loadDebug();
}

async function clearDebug() {
  await api("/debug", { method: "DELETE" });
  await loadDebug();
}

function toggleDebugAutoRefresh() {
  if (debugInterval) {
    clearInterval(debugInterval);
    debugInterval = null;
  }

  if (debugAutoRefresh.value) {
    debugInterval = setInterval(loadDebug, 1500);
  }
}


async function loadZigbee() {
  zigbeeStatus.value = await api('/zigbee/status');
  zigbeeDevices.value = await api('/zigbee/devices');
  zigbeeRules.value = await api('/zigbee/rules');
  if (!newZigbeeRule.value.deviceId && zigbeeDevices.value.length) newZigbeeRule.value.deviceId = zigbeeDevices.value[0].id;
  if (!newZigbeeRule.value.speakerId && speakers.value.length) newZigbeeRule.value.speakerId = speakers.value[0].id;
  if (!newZigbeeRule.value.playlistId && playlists.value.length) newZigbeeRule.value.playlistId = playlists.value[0].id;
}

async function reconnectZigbee() {
  await action(async () => {
    await api('/zigbee/reconnect', { method: 'POST', body: JSON.stringify({ mqttUrl: settings.value.mqttUrl, zigbeeBaseTopic: settings.value.zigbeeBaseTopic }) });
    await loadZigbee();
    toast('MQTT/Zigbee reconnecté.');
  });
}

async function permitJoin() {
  await action(async () => {
    await api('/zigbee/permit-join', { method: 'POST', body: JSON.stringify({ time: 120 }) });
    toast('Appairage Zigbee activé pendant 120 secondes.');
  });
}

async function stopPermitJoin() {
  await action(async () => {
    await api('/zigbee/permit-join/stop', { method: 'POST' });
    toast('Appairage Zigbee arrêté.');
  });
}

async function updateZigbeeDevice(device) {
  await action(async () => {
    await api(`/zigbee/devices/${device.id}`, { method: 'PUT', body: JSON.stringify(device) });
    await loadZigbee();
    toast('Capteur sauvegardé.');
  });
}

async function createZigbeeRule() {
  await action(async () => {
    await api('/zigbee/rules', { method: 'POST', body: JSON.stringify(newZigbeeRule.value) });
    await loadZigbee();
    toast('Règle PIR ajoutée.');
  });
}

async function updateZigbeeRule(rule) {
  await action(async () => {
    await api(`/zigbee/rules/${rule.id}`, { method: 'PUT', body: JSON.stringify({
      deviceId: rule.device_id,
      speakerId: rule.speaker_id,
      playlistId: rule.playlist_id,
      cooldownMs: rule.cooldown_ms,
      sampleRate: rule.sample_rate,
      channels: rule.channels,
      mode: rule.mode,
      enabled: Boolean(rule.enabled)
    }) });
    await loadZigbee();
    toast('Règle sauvegardée.');
  });
}

async function deleteZigbeeRule(id) {
  if (!confirm('Supprimer cette règle Zigbee ?')) return;
  await action(async () => {
    await api(`/zigbee/rules/${id}`, { method: 'DELETE' });
    await loadZigbee();
  });
}

async function loadSettings() {
  settings.value = await api('/settings');
}


function validatePowerPollPort(port) {
  const p = Number(port);
  const backendPort = Number(settings.value.backendPort || 3000);
  const forbiddenPorts = new Set([backendPort, 22, 80, 443]);

  if (!Number.isInteger(p)) {
    throw new Error("Port réveil invalide");
  }

  if (p < 1024 || p > 65535) {
    throw new Error("Le port réveil doit être compris entre 1024 et 65535");
  }

  if (forbiddenPorts.has(p)) {
    throw new Error(`Le port ${p} est réservé ou déjà utilisé par le système/backend`);
  }

  return p;
}

async function saveSettings() {
  await action(async () => {
    validatePowerPollPort(settings.value.powerPollPort);
    const result = await api('/settings', {
      method: 'POST',
      body: JSON.stringify({ powerPollPort: Number(settings.value.powerPollPort) })
    });
    settings.value = { ...settings.value, ...result };
    toast(result.message || 'Paramètres sauvegardés.');
  });
}

onMounted(refresh);
</script>

<template>
  <main class="layout">
    <aside class="sidebar">
      <h1>Audio Local</h1>
      <button :class="{active: page==='library'}" @click="page='library'">Bibliothèque</button>
      <button :class="{active: page==='playlists'}" @click="page='playlists'">Playlists</button>
      <button :class="{active: page==='speakers'}" @click="page='speakers'">Enceintes</button>
      <button :class="{active: page==='power'}" @click="page='power'">Énergie</button>
      <button :class="{active: page==='schedule'}" @click="page='schedule'">Hebdomadaire</button>
      <button :class="{active: page==='status'}" @click="page='status'; loadStatus()">État</button>
      <button :class="{active: page==='settings'}" @click="page='settings'; loadSettings()">Paramètres</button>
      <button :class="{active: page==='zigbee'}" @click="page='zigbee'; loadZigbee()">Zigbee</button>
      <button :class="{active: page==='debug'}" @click="page='debug'; loadDebug()">Debug</button>
    </aside>
    <section class="content">
      <div v-if="message" class="toast">{{ message }}</div>
      <div v-if="waitingWake" class="waiting">En attente du réveil ESP32 et du mode normal...</div>
      <div class="server-bar"><strong>Backend :</strong> {{ API }} · réveil ESP32 : port {{ settings.activePowerPollPort || health?.powerPollPort }}<span v-if="health?.runningStreams?.length"> · flux actifs : {{ health.runningStreams.join(', ') }}</span></div>
      <section v-if="page==='library'" class="grid">
        <div class="card"><h2>Dépôt audio commun</h2><input type="file" accept="audio/*" @change="fileSelected" />
          <div class="row"><label>Fréquence<select v-model="sampleRate"><option :value="22050">22050 Hz</option><option :value="32000">32000 Hz</option><option :value="44100">44100 Hz</option><option :value="48000">48000 Hz</option></select></label><label>Canaux<select v-model="channels"><option :value="1">Mono</option><option :value="2">Stéréo</option></select></label></div>
          <button class="primary" :disabled="!uploadFile || loading" @click="uploadAudio">Envoyer et convertir</button></div>
        <div class="card wide"><h2>Bibliothèque</h2><div v-if="!files.length" class="empty">Aucun fichier déposé.</div><div v-for="f in files" :key="f.id" class="file-row"><div><strong>{{ f.original_name }}</strong><small>Conversions : <span v-for="c in f.conversions" :key="c.id">{{ c.sample_rate }}Hz/{{ c.channels }}ch&nbsp;</span></small></div><div class="actions"><button @click="convertFile(f.id)">Convertir format choisi</button><button class="danger" @click="deleteFile(f.id)">Supprimer</button></div></div></div>
      </section>
      <section v-if="page==='playlists'" class="grid">
        <div class="card"><h2>Lecture manuelle</h2><label>Enceinte<select v-model="selectedSpeakerId"><option v-for="s in speakers" :key="s.id" :value="s.id">{{ s.name }} — {{ s.ip }}:{{ s.stream_port }}</option></select></label><label>Mode audio<select v-model="mode"><option value="rtp">RTP</option><option value="udp">UDP brut</option></select></label><div class="row"><button @click="playPrevious">◀ Précédent</button><button class="primary" @click="playCurrent">Lecture courant</button><button @click="playNext">Suivant ▶</button><button class="danger" @click="stop">Stop</button></div><p class="hint">La lecture attend le réveil si l’ESP32 est en light-sleep. Les autres actions sont refusées si l’ESP32 dort.</p></div>
        <div class="card"><div class="toolbar"><h2>Playlist</h2><button @click="createPlaylist">+</button></div><select v-model="selectedPlaylistId"><option v-for="p in playlists" :key="p.id" :value="p.id">{{ p.name }} — index {{ p.current_index }}</option></select><div v-if="selectedPlaylist"><div v-for="(item, idx) in selectedPlaylist.items" :key="item.id" class="item" :class="{current: idx === selectedPlaylist.current_index}"><span>{{ idx + 1 }}. {{ item.original_name }}</span><div class="actions"><button @click="moveItem(item, -1)">↑</button><button @click="moveItem(item, 1)">↓</button><button @click="removeItem(item.id)">×</button></div></div></div><button class="danger" v-if="selectedPlaylistId" @click="deletePlaylist(selectedPlaylistId)">Supprimer playlist</button></div>
        <div class="card wide"><h2>Ajouter depuis la bibliothèque commune</h2><div v-for="f in files" :key="f.id" class="file-row"><strong>{{ f.original_name }}</strong><button @click="addToPlaylist(f.id)">Ajouter</button></div></div>
      </section>
      <section v-if="page==='speakers'" class="grid"><div class="card"><h2>Ajouter enceinte</h2><input v-model="newSpeaker.name" placeholder="Nom" /><input v-model="newSpeaker.ip" placeholder="IP ESP32" /><input type="number" v-model="newSpeaker.port" placeholder="Port API" /><input type="number" v-model="newSpeaker.stream_port" placeholder="Port RTP/UDP" /><label>Volume {{ newSpeaker.volume }} %<input type="range" min="0" max="100" v-model="newSpeaker.volume" /></label><button class="primary" @click="createSpeaker">Ajouter</button></div><div class="card wide"><h2>Enceintes</h2><div v-for="s in speakers" :key="s.id" class="speaker-edit"><input v-model="s.name" /><input v-model="s.ip" /><input type="number" v-model="s.port" /><input type="number" v-model="s.stream_port" /><label>Vol {{ s.volume }}<input type="range" min="0" max="100" v-model="s.volume" @input="sendVolumeRealtime(s)" /></label><label><input type="checkbox" v-model="s.enabled" /> active</label><button @click="updateSpeaker(s)">Sauver</button><button @click="sendVolume(s)">Volume</button><button class="danger" @click="deleteSpeaker(s.id)">Supprimer</button></div></div></section>
      <section v-if="page==='power'" class="card"><h2>Gestion énergie</h2><p class="hint">En light-sleep, les actions immédiates sont refusées si l’API ESP32 ne répond pas. La lecture met la consigne à normal et attend le réveil jusqu’au timeout.</p><div v-for="s in speakers" :key="s.id" class="energy-row"><h3>{{ s.name }}</h3><label>Consigne<select v-model="s.desired_power_mode"><option value="normal">normal</option><option value="modem-sleep">modem-sleep</option><option value="light-sleep">light-sleep</option></select></label><label>Mode au repos<select v-model="s.default_idle_power_mode"><option value="light-sleep">light-sleep</option><option value="modem-sleep">modem-sleep</option><option value="normal">normal</option></select></label><label>Relais ON avant lecture (ms)<input type="number" v-model="s.relay_pre_delay_ms" /></label><label>Relais OFF après lecture (ms)<input type="number" v-model="s.relay_off_delay_ms" /></label><label>Modem-sleep après relais OFF (ms)<input type="number" v-model="s.modem_sleep_after_relay_delay_ms" /></label>
          <label>Light-sleep après modem-sleep
            <div class="row">
              <input type="number" :value="msToHours(s.light_sleep_after_modem_delay_ms)" @input="s.light_sleep_after_modem_delay_ms = hoursMinutesToMs($event.target.value, msToMinutesRemainder(s.light_sleep_after_modem_delay_ms))" placeholder="heures" />
              <input type="number" :value="msToMinutesRemainder(s.light_sleep_after_modem_delay_ms)" @input="s.light_sleep_after_modem_delay_ms = hoursMinutesToMs(msToHours(s.light_sleep_after_modem_delay_ms), $event.target.value)" placeholder="minutes" />
            </div>
          </label><label>Timeout attente normal (ms)<input type="number" v-model="s.wait_normal_timeout_ms" /></label><div class="actions"><button @click="updateSpeaker(s)">Sauver</button><button @click="setPower(s, 'normal')">Normal</button><button @click="setPower(s, 'modem-sleep')">Modem-sleep</button><button @click="setPower(s, 'light-sleep')">Light-sleep</button><button @click="setRelay(s, 'on')">Relais ON</button><button @click="setRelay(s, 'off')">Relais OFF</button></div></div></section>
      <section v-if="page==='schedule'" class="grid"><div class="card"><h2>Nouvelle programmation</h2><label>Enceinte<select v-model="newSchedule.speakerId"><option v-for="s in speakers" :key="s.id" :value="s.id">{{ s.name }}</option></select></label><label>Playlist<select v-model="newSchedule.playlistId"><option v-for="p in playlists" :key="p.id" :value="p.id">{{ p.name }}</option></select></label><label>Jour<select v-model="newSchedule.dayOfWeek"><option :value="1">Lundi</option><option :value="2">Mardi</option><option :value="3">Mercredi</option><option :value="4">Jeudi</option><option :value="5">Vendredi</option><option :value="6">Samedi</option><option :value="0">Dimanche</option></select></label><input type="time" v-model="newSchedule.startTime" /><input type="time" v-model="newSchedule.endTime" /><label><input type="checkbox" v-model="newSchedule.enabled" /> actif</label><button class="primary" @click="addSchedule">Ajouter</button></div><div class="card wide"><h2>Programmations</h2><div v-for="s in schedule" :key="s.id" class="file-row"><div><strong>{{ s.speaker_name }}</strong><small>Jours {{ s.days?.join(",") }} · {{ s.start_time }} → {{ s.end_time }} · {{ s.playlist_name || 'sans playlist' }} · {{ s.inside_power_mode }} / {{ s.outside_power_mode }}</small></div><button class="danger" @click="deleteSchedule(s.id)">Supprimer</button></div></div></section>

      <section v-if="page==='settings'" class="grid">
        <div class="card">
          <h2>Paramètres serveur</h2>
          <label>Port du serveur de réveil ESP32
            <input type="number" min="1" max="65535" v-model="settings.powerPollPort" />
          </label>
          <p class="hint">
            Le port {{ settings.backendPort || 3000 }} est réservé au backend principal.
            Ports interdits : {{ (settings.forbiddenPorts || [3000,22,80,443]).join(", ") }}.
          </p>
          <button class="primary" @click="saveSettings">Sauvegarder</button>
          <p class="hint" v-if="settings.restartRequired">
            Redémarre le backend pour appliquer le nouveau port.
          </p>
          <p class="hint">
            Port actif actuellement : <strong>{{ settings.activePowerPollPort }}</strong>
          </p>
        </div>

        <div class="card">
          <h2>Adresse à configurer dans l’ESP32</h2>
          <p class="hint">L’ESP32 doit interroger cette URL pendant ses réveils périodiques :</p>
          <pre>{{ settings.powerPollUrl || ('http://' + SERVER_HOST + ':' + settings.powerPollPort + '/api/esp32/mode') }}</pre>
          <p class="hint">Pour une enceinte précise :</p>
          <pre>{{ 'http://' + SERVER_HOST + ':' + settings.powerPollPort + '/api/esp32/mode?ip=192.168.2.40' }}</pre>
        </div>
      </section>


      <section v-if="page==='zigbee'" class="grid">
        <div class="card">
          <h2>Zigbee / MQTT</h2>
          <p class="hint">Utilise Zigbee2MQTT. Broker : {{ zigbeeStatus.mqttUrl || settings.mqttUrl }} · base topic : {{ zigbeeStatus.zigbeeBaseTopic || settings.zigbeeBaseTopic }}</p>
          <p><strong>État MQTT :</strong> {{ zigbeeStatus.connected ? 'connecté' : 'déconnecté' }} <span v-if="zigbeeStatus.lastError">· {{ zigbeeStatus.lastError }}</span></p>
          <label>Broker MQTT<input v-model="settings.mqttUrl" placeholder="mqtt://localhost:1883" /></label>
          <label>Base topic Zigbee2MQTT<input v-model="settings.zigbeeBaseTopic" placeholder="zigbee2mqtt" /></label>
          <div class="actions">
            <button @click="reconnectZigbee">Reconnecter MQTT</button>
            <button class="primary" @click="permitJoin">Appairage 120 s</button>
            <button @click="stopPermitJoin">Stop appairage</button>
            <button @click="loadZigbee">Rafraîchir</button>
          </div>
        </div>

        <div class="card">
          <h2>Nouvelle règle PIR</h2>
          <label>Capteur
            <select v-model="newZigbeeRule.deviceId"><option v-for="d in zigbeeDevices" :key="d.id" :value="d.id">{{ d.friendly_name }}</option></select>
          </label>
          <label>Enceinte
            <select v-model="newZigbeeRule.speakerId"><option v-for="s in speakers" :key="s.id" :value="s.id">{{ s.name }}</option></select>
          </label>
          <label>Playlist
            <select v-model="newZigbeeRule.playlistId"><option v-for="p in playlists" :key="p.id" :value="p.id">{{ p.name }}</option></select>
          </label>
          <label>Pause après déclenchement (ms)<input type="number" v-model="newZigbeeRule.cooldownMs" /></label>
          <div class="row"><label>Fréquence<select v-model="newZigbeeRule.sampleRate"><option :value="22050">22050</option><option :value="44100">44100</option><option :value="48000">48000</option></select></label><label>Canaux<select v-model="newZigbeeRule.channels"><option :value="1">Mono</option><option :value="2">Stéréo</option></select></label><label>Mode<select v-model="newZigbeeRule.mode"><option value="rtp">RTP</option><option value="udp">UDP</option></select></label></div>
          <button class="primary" @click="createZigbeeRule">Ajouter règle</button>
        </div>

        <div class="card wide">
          <h2>Capteurs détectés</h2>
          <div v-if="!zigbeeDevices.length" class="empty">Aucun capteur détecté. Active l'appairage puis déclenche le capteur.</div>
          <div v-for="d in zigbeeDevices" :key="d.id" class="file-row">
            <div><strong>{{ d.friendly_name }}</strong><small>{{ d.topic }} · {{ d.type }} · dernier : {{ d.last_seen }}</small></div>
            <label><input type="checkbox" v-model="d.enabled" /> actif</label>
            <button @click="updateZigbeeDevice(d)">Sauver</button>
          </div>
        </div>

        <div class="card wide">
          <h2>Règles de déclenchement</h2>
          <div v-if="!zigbeeRules.length" class="empty">Aucune règle.</div>
          <div v-for="r in zigbeeRules" :key="r.id" class="rule-row">
            <div><strong>{{ r.device_name }}</strong><small>→ {{ r.speaker_name }} / {{ r.playlist_name }} · déclenchements : {{ r.trigger_count }} · dernier : {{ r.last_trigger_at }}</small></div>
            <label>Pause ms<input type="number" v-model="r.cooldown_ms" /></label>
            <label><input type="checkbox" v-model="r.enabled" /> actif</label>
            <button @click="updateZigbeeRule(r)">Sauver</button>
            <button class="danger" @click="deleteZigbeeRule(r.id)">Supprimer</button>
          </div>
        </div>
      </section>

      <section v-if="page==='status'" class="card"><h2>État ESP32</h2><select v-model="selectedStatusSpeakerId"><option v-for="s in speakers" :key="s.id" :value="s.id">{{ s.name }}</option></select><button @click="loadStatus">Actualiser</button><pre>{{ status }}</pre></section>

      <section v-if="page==='debug'" class="card">
        <div class="toolbar">
          <h2>Debug API</h2>
          <div class="actions">
            <label class="inline-check">
              <input type="checkbox" v-model="debug.enabled" @change="toggleDebug" />
              debug actif
            </label>
            <label class="inline-check">
              <input type="checkbox" v-model="debugAutoRefresh" @change="toggleDebugAutoRefresh" />
              auto
            </label>
            <button @click="loadDebug">Rafraîchir</button>
            <button class="danger" @click="clearDebug">Vider</button>
          </div>
        </div>

        <p class="hint">
          Journalise les requêtes Vue → Node, Node → ESP32, les réponses ESP32, les erreurs et ffmpeg.
        </p>

        <div class="debug-filter">
          <label>Filtre debug
            <select v-model="debugFilter">
              <option value="all">Tous les échanges</option>
              <option value="front-back">Front ↔ Backend</option>
              <option value="back-esp32">Backend ↔ Enceinte ESP32</option>
              <option value="ffmpeg">ffmpeg</option>
              <option value="errors">Erreurs uniquement</option>
              <option value="zigbee">Zigbee / MQTT</option>
              <option value="power-poll">ESP32 ↔ serveur réveil</option>
              <option value="wakeup">Wakeup / consigne énergie</option>
            </select>
          </label>

          <span class="hint">
            {{ filteredDebugLogs.length }} / {{ debug.logs.length }} entrée(s)
          </span>
        </div>

        <div class="debug-list">
          <div v-for="(log, index) in filteredDebugLogs" :key="index" class="debug-entry">
            <div class="debug-head">
              <strong>{{ log.time }}</strong>
              <span>{{ log.type }}</span>
              <span v-if="log.direction">{{ log.direction }}</span>
              <span v-if="log.speaker">· {{ log.speaker }}</span>
              <span v-if="log.status">· HTTP {{ log.status }}</span>
            </div>
            <pre>{{ log }}</pre>
          </div>
        </div>
      </section>
    </section>
  </main>
</template>
