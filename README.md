# Audio Local Site v8 — light-sleep aware

Version complète avec :

- bibliothèque audio commune ;
- playlists séparées par enceinte ;
- lecture manuelle fichier courant / précédent / suivant ;
- retour automatique au début de playlist ;
- pas d'enchaînement automatique ;
- streaming RTP/UDP par ffmpeg côté Node.js ;
- relais ON avant lecture, OFF après temporisation ;
- volume temps réel via `POST /api/config {"audioVolume":0.5}` ;
- gestion hybride light-sleep :
  - les actions immédiates volume/relais/stop/power direct sont refusées avec avertissement si l'ESP32 ne répond pas ;
  - la lecture est acceptée même si l'ESP32 dort : consigne serveur `normal`, puis attente jusqu'au retour `/api/power = normal` ou timeout ;
- consigne serveur compatible polling ESP32 : `/api/esp32/mode` ;
- page programmation hebdomadaire.

## Installation

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

```bash
cd frontend
npm install
npm run dev
```

Ouvrir :

```text
http://IP_DU_SERVEUR:5173
```

## API ESP32 attendue

```http
GET  /api/power
POST /api/power/normal
POST /api/power/modem-sleep
POST /api/power/light-sleep
POST /api/relay/on
POST /api/relay/off
POST /api/config
GET  /api/status
POST /api/stop
```

## API serveur consultée par l'ESP32 en réveil périodique

```http
GET http://IP_SERVEUR:3000/api/esp32/mode
GET http://IP_SERVEUR:3000/api/esp32/mode?ip=192.168.2.40
GET http://IP_SERVEUR:3000/api/esp32/mode?speakerId=1
```


## Mode debug API

La version v9 ajoute un onglet **Debug** dans le frontend.

Il trace :
- requêtes Vue/Client → Node ;
- réponses Node → Vue/Client ;
- appels Node → ESP32 ;
- réponses/erreurs ESP32 → Node ;
- lancement et erreurs ffmpeg ;
- timeouts et erreurs backend.

API debug :

```http
GET    /api/debug
POST   /api/debug/enabled
DELETE /api/debug
```


## Filtres Debug v10

L'onglet Debug permet maintenant de filtrer :

- tous les échanges ;
- Front ↔ Backend ;
- Backend ↔ Enceinte ESP32 ;
- ffmpeg ;
- erreurs uniquement.

## v11 — énergie avancée, polling ESP32 et debug JSON

Ajouts :
- `POWER_POLL_PORT` configurable dans `backend/.env` pour l'API consultée par l'ESP32 : `/api/esp32/mode` ;
- debug complet des requêtes `ESP32 → serveur réveil` et réponses JSON `serveur → ESP32` ;
- filtres Debug `ESP32 ↔ serveur réveil` et `Wakeup / consigne énergie` ;
- énergie par enceinte : relais OFF → modem-sleep → light-sleep ;
- délai light-sleep saisissable en heures/minutes ;
- planning hebdomadaire multi-jours avec mode pendant/hors créneau.


## v12 — port de réveil configurable depuis le frontend

Un onglet **Paramètres** permet de modifier le port du serveur de réveil ESP32.

Le port est sauvegardé en SQLite dans `app_settings`. Un redémarrage du backend est nécessaire pour que `powerApp.listen(...)` écoute sur le nouveau port.

API :

```http
GET  /api/settings
POST /api/settings
```


## v13 — validation du port serveur réveil

Le port de polling réveil configurable depuis le frontend ne peut plus être :
- le port du backend principal, par exemple `3000` ;
- `22`, `80`, `443` ;
- hors plage `1024..65535`.

La validation est faite côté frontend et côté backend.
Un redémarrage backend reste nécessaire après modification du port.


## v14 — Zigbee PIR via Zigbee2MQTT

Ajouts :
- dépendance backend `mqtt` ;
- page Zigbee dans le frontend ;
- configuration broker MQTT et base topic Zigbee2MQTT ;
- appairage Zigbee depuis le frontend via `permit_join` ;
- détection automatique des capteurs publiant sur `zigbee2mqtt/#` ;
- règles PIR : capteur → enceinte → playlist ;
- cooldown anti-redéclenchement ;
- si une lecture est déjà en cours, la détection est ignorée ;
- chaque nouvelle détection valide lance le fichier courant puis avance l’index de playlist ;
- logs Debug MQTT/Zigbee.

Prérequis côté machine serveur :
```bash
# Exemple, si mosquitto n'est pas installé
sudo apt install mosquitto mosquitto-clients
```

Le projet suppose Zigbee2MQTT configuré avec :
```yaml
mqtt:
  base_topic: zigbee2mqtt
  server: mqtt://localhost:1883
```
