const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const apiRoutes = require('./routes/api');
const { startTunnel, stopTunnel } = require('./tunnel');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logger for debugging
app.use((req, res, next) => {
    if (req.path.startsWith('/api') && req.path !== '/api/events') {
        const start = Date.now();
        res.on('finish', () => {
            const duration = Date.now() - start;
            console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} -> ${res.statusCode} (${duration}ms)`);
        });
    }
    next();
});

// Mount API routes
app.use('/api', apiRoutes);

// Serve static frontend files from project root
app.use(express.static(path.join(__dirname, '..'), {
    index: 'index.html',
    extensions: ['html'],
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('manifest.json') || filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json');
        }
    }
}));

// Fallback to index.html for single-page application navigation
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Interner Serverfehler', details: err.message });
});

// Start Server on 0.0.0.0 if run directly
let server;
if (require.main === module) {
    server = app.listen(PORT, '0.0.0.0', () => {
        // Find local network IP
        const interfaces = os.networkInterfaces();
        let localIp = '127.0.0.1';
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    localIp = iface.address;
                    break;
                }
            }
            if (localIp !== '127.0.0.1') break;
        }

        console.log('================================================================');
        console.log('  🏪 StoreControl Pro - Zentraler Server gestartet');
        console.log('================================================================');
        console.log(`  💻 PC-Zugriff:         http://localhost:${PORT}`);
        console.log(`  📱 Smartphone-Zugriff: http://${localIp}:${PORT}`);
        console.log('----------------------------------------------------------------');
        console.log('  🔑 Standard-Login:');
        console.log('     Benutzer: admin');
        console.log('     Passwort: admin123');
        console.log('----------------------------------------------------------------');
        console.log('  📡 Echtzeit-Synchronisation (SSE) aktiv');
        // Starte Cloudflare Tunnel für weltweiten Smartphone-Zugriff
        startTunnel(PORT).catch(err => console.warn('[Tunnel] Hinweis:', err.message));
        console.log('  💾 SQLite-Datenbank (WAL-Modus, Cent-Genauigkeit) bereit');
        console.log('================================================================');
    });

    process.on('SIGINT', () => {
        stopTunnel();
        console.log('\nServer wird beendet...');
        server.close(() => {
            process.exit(0);
        });
    });
}

module.exports = app;

