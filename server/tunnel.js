const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { setAppSetting, getAppSetting } = require('./db');

let activeTunnelUrl = null;
let tunnelProcess = null;
let isStopping = false;
const listeners = [];

const TUNNEL_STATE_FILE = path.join(__dirname, '../data/tunnel.json');

function onTunnelUrlChange(cb) {
    listeners.push(cb);
}

function notifyTunnelUrlChange(url) {
    for (const cb of listeners) {
        try { cb(url); } catch (e) { console.error('Tunnel listener error:', e); }
    }
}

function getPublicTunnelUrl() {
    return activeTunnelUrl;
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

function checkTunnelHealth(url, timeoutMs = 3000) {
    return new Promise((resolve) => {
        try {
            const req = https.get(url + '/api/network-info', { timeout: timeoutMs }, (res) => {
                resolve(res.statusCode >= 200 && res.statusCode < 500);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
        } catch (e) {
            resolve(false);
        }
    });
}


function updateDesktopShortcut(url) {
    return; // Do not overwrite desktop shortcut with temporary preview url
    try {
        const desktopPath = path.join(os.homedir(), 'Desktop');
        const shortcutFile = path.join(desktopPath, 'Store Control.url');
        const iconFile = path.join(__dirname, '../icons/icon.ico');
        const content = '[InternetShortcut]\r\nURL=' + url + '\r\nIconIndex=0\r\nIconFile=' + iconFile + '\r\n';
        fs.writeFileSync(shortcutFile, content, 'utf8');

        // Also clean up any old 'StoreControl Pro.url' if present
        const oldShortcut = path.join(desktopPath, 'StoreControl Pro.url');
        if (fs.existsSync(oldShortcut)) {
            try { fs.unlinkSync(oldShortcut); } catch(e) {}
        }
        console.log('[Desktop] Verknüpfung \'Store Control\' auf Desktop erfolgreich aktualisiert -> ' + url);
    } catch(err) {
        console.warn('Fehler beim Aktualisieren der Desktop-Verknüpfung:', err.message);
    }
}

function saveTunnelState(pid, url) {
    try {
        updateDesktopShortcut(url);
        fs.writeFileSync(TUNNEL_STATE_FILE, JSON.stringify({
            pid,
            url,
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf8');
    } catch (e) {
        console.warn('Failed to save tunnel state file:', e.message);
    }
}

function loadTunnelState() {
    try {
        if (fs.existsSync(TUNNEL_STATE_FILE)) {
            return JSON.parse(fs.readFileSync(TUNNEL_STATE_FILE, 'utf8'));
        }
    } catch (e) {}
    return null;
}

async function startTunnel(port = 3000) {
    if (tunnelProcess && activeTunnelUrl) return activeTunnelUrl;
    isStopping = false;

    // Check if a previously started tunnel process is already running and healthy
    const savedState = loadTunnelState();
    if (savedState && savedState.pid && savedState.url && isProcessAlive(savedState.pid)) {
        console.log('[Tunnel] Prüfe bestehenden Cloudflare-Tunnel (PID ' + savedState.pid + ')...');
        const healthy = await checkTunnelHealth(savedState.url, 2500);
        if (healthy) {
            activeTunnelUrl = savedState.url;
            updateDesktopShortcut(activeTunnelUrl);
            try { setAppSetting('app_public_url', activeTunnelUrl); } catch (e) {}
            console.log('================================================================');
            console.log(`  🌐 Bestehender Cloudflare-Tunnel aktiv: ${activeTunnelUrl}`);
            console.log('================================================================');
            notifyTunnelUrlChange(activeTunnelUrl);
            return activeTunnelUrl;
        } else {
            console.log('[Tunnel] Bestehender Prozess antwortet nicht mehr. Starte neuen Tunnel...');
            try { process.kill(savedState.pid); } catch (e) {}
        }
    }

    return new Promise((resolve) => {
        const binPath = path.join(__dirname, '../bin/cloudflared.exe');
        if (!fs.existsSync(binPath)) {
            console.log('[Tunnel] Kein lokaler Cloudflare-Binary (Cloud-Betrieb). Tunnel wird uebersprungen.');
            return resolve(activeTunnelUrl);
        }
        const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN || getAppSetting('cloudflare_tunnel_token');

        function launch() {
            if (isStopping) return;
            console.log('[Tunnel] Initialisiere Cloudflare HTTPS-Tunnel...');

            const spawnArgs = tunnelToken 
                ? ['tunnel', 'run', '--token', tunnelToken]
                : ['tunnel', '--url', `http://127.0.0.1:${port}`];

            const proc = spawn(binPath, spawnArgs, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            });

            tunnelProcess = proc;
            let resolved = false;

            const handleData = (chunk) => {
                const str = chunk.toString();
                const match = str.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                if (match) {
                    const newUrl = match[0];
                    if (newUrl !== activeTunnelUrl) {
                        activeTunnelUrl = newUrl;
                        try {
                            setAppSetting('app_public_url', activeTunnelUrl);
                            saveTunnelState(proc.pid, activeTunnelUrl);
                        } catch (e) {}
                        console.log('================================================================');
                        console.log(`  🌐 Cloudflare HTTPS-Tunnel aktiv: ${activeTunnelUrl}`);
                        console.log('================================================================');
                        notifyTunnelUrlChange(activeTunnelUrl);
                    }
                    if (!resolved) {
                        resolved = true;
                        resolve(activeTunnelUrl);
                    }
                }
            };

            proc.stdout.on('data', handleData);
            proc.stderr.on('data', handleData);

            proc.on('close', (code) => {
                console.log(`[Tunnel] Cloudflare-Prozess beendet (Code: ${code})`);
                tunnelProcess = null;
                if (!isStopping) {
                    console.log('[Tunnel] Starte Tunnel in 5 Sekunden neu...');
                    setTimeout(launch, 5000);
                }
            });

            // Fallback timeout after 15 seconds
            setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    resolve(activeTunnelUrl);
                }
            }, 15000);
        }

        launch();
    });
}

function stopTunnel(force = false) {
    // Only kill tunnel if explicitly requested via force or STOP_TUNNEL_ON_EXIT
    if (force || process.env.STOP_TUNNEL_ON_EXIT === 'true') {
        isStopping = true;
        if (tunnelProcess) {
            try {
                tunnelProcess.kill();
            } catch (e) {}
            tunnelProcess = null;
        }
        try {
            if (fs.existsSync(TUNNEL_STATE_FILE)) fs.unlinkSync(TUNNEL_STATE_FILE);
        } catch (e) {}
    }
}

module.exports = {
    startTunnel,
    stopTunnel,
    getPublicTunnelUrl,
    onTunnelUrlChange
};
