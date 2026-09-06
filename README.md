# Icarus Server Manager (Web)

A local web control panel for managing **Icarus** dedicated servers on Windows.

It follows the same pattern as the Minecraft and ARK managers: start/stop servers, SteamCMD install/update, schedules, prospect backups, Windows Firewall helpers, and a live console.

Drop your existing Icarus dedicated-server folder into a profile’s **Install** path when you have it. The manager does not need the game files in this git repo.

---

## Requirements

- **Windows** (process control, SteamCMD, firewall, and path handling are Windows-oriented)
- **[Node.js 20+](https://nodejs.org/)** on your PATH
- Optional: SteamCMD (can be downloaded from the UI into `Documents\SteamCMD`)

No `npm install` is required — the app uses only Node built-ins.

Dedicated server Steam App ID: **2089300**.

---

## Quick start

1. Clone this repo:

```bash
git clone https://github.com/Genis221/Icarus-Server-Manager.git
cd Icarus-Server-Manager
```

2. Start the manager:

- Double-click **`Start Icarus Manager.cmd`**, or
- Run `npm start`

3. Open the UI (it may open automatically):

- Local: `http://127.0.0.1:3230`
- LAN: `http://YOUR-PC-IP:3230`

The start script checks GitHub for manager updates, binds to `0.0.0.0`, opens Windows Firewall for the dashboard port, and stops any previous manager already using port **3230**.

---

## What you get

- Multi-server profiles (tabs)
- Start / stop `IcarusServer-Win64-Shipping.exe`
- SteamCMD update / verify / repair (keeps `Icarus\Saved`)
- Automatic start, shutdown, restart, and update schedules
- Zip backups of `Icarus\Saved` (prospects + `ServerSettings.ini`)
- Firewall rules for game **Port** (default 17777) and **QueryPort** (default 27015), UDP + TCP
- Live log console
- Edit `ServerSettings.ini`

Default launch arguments:

```text
-SteamServerName="New Server" -Port=17777 -QueryPort=27015 -Log
```

The profile name is written into `-SteamServerName` on start (`SessionName` in the ini does not currently show in the server browser).

On first start, if `ServerSettings.ini` is missing, the manager writes a dedicated-hosting default with `ResumeProspect=True` and `ShutdownIfNotJoinedFor` / `ShutdownIfEmptyFor` set to `-1` so the process does not quit after 5 minutes empty.

Admin commands are in-game (`/AdminLogin`, `/AdminSay`, `/KickPlayer`, `/ReturnToLobby`), not Source RCON.

---

## Layout

```text
Icarus Server Manager/
├── server.mjs
├── package.json
├── Start Icarus Manager.cmd
├── Start-IcarusManager.ps1
├── public/
└── data/                   # Runtime (gitignored)
```

Env overrides: `ICARUS_HOST`, `ICARUS_PORT`, `ICARUS_DATA_DIR`, `ICARUS_ALLOW_REMOTE`, `ICARUS_ALLOW_PUBLIC`

`data/` is gitignored so local paths and secrets stay on your machine.
