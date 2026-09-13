const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// 1. Update viewport & title
html = html.replace(
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">'
);
html = html.replace(
    '<title>StoreControl Pro – Zentraler Umsatz- & Kostenmanager</title>',
    '<title>Store Control – Zentraler Umsatz- & Kostenmanager</title>'
);

// 2. Update PWA Manifest & App Icons
const oldHeadPwa = `    <!-- PWA Manifest & App Icons -->
    <link rel="manifest" href="manifest.webmanifest">
    <link rel="icon" type="image/svg+xml" href="icons/icon.svg">
    <link rel="apple-touch-icon" href="icons/icon-192.png">
    <meta name="theme-color" content="#0f172a">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="StoreControl">`;

const newHeadPwa = `    <!-- PWA Manifest & App Icons -->
    <link rel="manifest" href="/manifest.json">
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="icon" type="image/svg+xml" href="/icons/icon.svg">
    <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
    <link rel="apple-touch-icon" sizes="192x192" href="/icons/icon-192.png">
    <meta name="theme-color" content="#0f172a">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="Store Control">
    <meta name="application-name" content="Store Control">`;

if (html.includes(oldHeadPwa)) {
    html = html.replace(oldHeadPwa, newHeadPwa);
    console.log('1. Head PWA tags updated');
} else {
    console.log('1. Head PWA tags already updated or target mismatch');
}

// 3. Add pwaInstallHeaderBtn next to qrModal button in header
const headerTarget = `                    <!-- Smartphone Connect QR Button -->
                    <button onclick="openModal('qrModal')" title="Smartphone per QR-Code verbinden" class="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-slate-700 transition">
                        <i data-lucide="smartphone" class="w-4 h-4 text-emerald-400"></i>
                        <span class="hidden md:inline">Smartphone</span>
                    </button>`;

const headerWithInstall = `                    <!-- PWA Mobile Install Button -->
                    <button id="pwaInstallHeaderBtn" onclick="handlePwaInstallClick()" title="Store Control als App auf Smartphone installieren" class="hidden flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white px-2.5 py-1.5 rounded-lg text-xs font-bold shadow-md transition">
                        <i data-lucide="download" class="w-4 h-4"></i>
                        <span class="text-[11px] sm:text-xs">App installieren</span>
                    </button>

                    <!-- Smartphone Connect QR Button -->
                    <button onclick="openModal('qrModal')" title="Smartphone per QR-Code verbinden" class="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-slate-700 transition">
                        <i data-lucide="smartphone" class="w-4 h-4 text-emerald-400"></i>
                        <span class="hidden md:inline">Smartphone</span>
                    </button>`;

if (html.includes(headerTarget) && !html.includes('id="pwaInstallHeaderBtn"')) {
    html = html.replace(headerTarget, headerWithInstall);
    console.log('2. Header install button added');
}

// 4. Add PWA installation instructions in qrModal
const qrGuideTarget = `                <div class="pt-1 flex items-center justify-between text-[11px] text-slate-500 border-t border-slate-100">
                    <span class="flex items-center gap-1 text-slate-400">
                        <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-500"></i>
                        Sichere HTTPS-Verbindung
                    </span>
                    <button type="button" onclick="showQrConfigForm()" class="text-slate-500 hover:text-slate-800 font-semibold underline decoration-slate-300">
                        URL bearbeiten
                    </button>
                </div>`;

const qrGuideWithPwa = `                <!-- PWA Installation Guide (Android & iOS) -->
                <div class="mt-3 pt-3 border-t border-slate-100 text-left space-y-2">
                    <div class="flex items-center justify-between">
                        <h4 class="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                            <i data-lucide="download" class="w-3.5 h-3.5 text-emerald-600"></i>
                            Als App auf dem Smartphone installieren
                        </h4>
                        <span class="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded-md font-semibold">PWA</span>
                    </div>
                    
                    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                        <!-- Android Guide -->
                        <div class="bg-slate-50 border border-slate-200/80 p-2.5 rounded-xl space-y-1">
                            <div class="font-bold text-slate-900 flex items-center gap-1">
                                <span class="text-emerald-600">🤖 Android (Chrome)</span>
                            </div>
                            <ol class="text-slate-600 space-y-1 pl-3.5 list-decimal text-[10.5px]">
                                <li>QR-Code scannen &amp; in Chrome öffnen</li>
                                <li>Menü (<strong>⋮</strong>) antippen</li>
                                <li><strong>„App installieren“</strong> wählen</li>
                                <li>Über das neue App-Symbol starten</li>
                            </ol>
                        </div>
                        <!-- iPhone Guide -->
                        <div class="bg-slate-50 border border-slate-200/80 p-2.5 rounded-xl space-y-1">
                            <div class="font-bold text-slate-900 flex items-center gap-1">
                                <span class="text-blue-600">🍏 iPhone (Safari)</span>
                            </div>
                            <ol class="text-slate-600 space-y-1 pl-3.5 list-decimal text-[10.5px]">
                                <li>In Safari öffnen</li>
                                <li>Unten auf <strong>Teilen</strong> tippen</li>
                                <li><strong>„Zum Home-Bildschirm“</strong> wählen</li>
                                <li>Oben rechts auf <strong>„Hinzufügen“</strong></li>
                            </ol>
                        </div>
                    </div>
                    <p class="text-[10px] text-slate-500">
                        * Startet nach Installation ohne Browserleisten direkt als vollwertige App mit Zugriff auf denselben Datenbestand.
                    </p>
                </div>

                <div class="pt-1 flex items-center justify-between text-[11px] text-slate-500 border-t border-slate-100">
                    <span class="flex items-center gap-1 text-slate-400">
                        <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-500"></i>
                        Sichere HTTPS-Verbindung
                    </span>
                    <button type="button" onclick="showQrConfigForm()" class="text-slate-500 hover:text-slate-800 font-semibold underline decoration-slate-300">
                        URL bearbeiten
                    </button>
                </div>`;

if (html.includes(qrGuideTarget) && !html.includes('Als App auf dem Smartphone installieren')) {
    html = html.replace(qrGuideTarget, qrGuideWithPwa);
    console.log('3. QR-Modal PWA installation guide added');
}

// 5. Add pwaInstallModal before </body>
const modalTarget = `</body>`;
const pwaModalHtml = `    <!-- ========================================================================= -->
    <!-- MODAL: SMARTPHONE PWA INSTALLATION ANLEITUNG (ANDROID & IPHONE)            -->
    <!-- ========================================================================= -->
    <div id="pwaInstallModal" class="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm hidden flex items-center justify-center p-4">
        <div class="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 relative animate-scaleIn text-left space-y-4">
            <div class="flex items-center justify-between pb-3 border-b border-slate-100">
                <div class="flex items-center gap-2.5">
                    <div class="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold">
                        <i data-lucide="download" class="w-5 h-5"></i>
                    </div>
                    <div>
                        <h3 class="font-bold text-slate-900 text-base">Store Control als App</h3>
                        <p class="text-xs text-slate-500">Direkt auf Ihrem Smartphone-Startbildschirm</p>
                    </div>
                </div>
                <button onclick="closeModal('pwaInstallModal')" class="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition">
                    <i data-lucide="x" class="w-5 h-5"></i>
                </button>
            </div>

            <!-- Direct 1-Click Install Button for Android if prompt is ready -->
            <div id="androidPromptActionBox" class="hidden bg-emerald-50 border border-emerald-200 rounded-2xl p-4 text-center space-y-2">
                <p class="text-xs text-emerald-900 font-medium">Ihr Browser unterstützt die direkte 1-Klick-Installation:</p>
                <button onclick="executeAndroidPwaPrompt()" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-sm shadow-md transition flex items-center justify-center gap-2">
                    <i data-lucide="download" class="w-4 h-4"></i>
                    Jetzt Store Control installieren
                </button>
            </div>

            <!-- Android Guide -->
            <div class="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 space-y-2">
                <div class="flex items-center justify-between">
                    <h4 class="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
                        Android (Google Chrome)
                    </h4>
                    <span class="text-[10px] text-slate-500 font-medium">Chrome / Edge</span>
                </div>
                <ol class="text-xs text-slate-600 space-y-1.5 pl-4 list-decimal">
                    <li>Öffnen Sie Store Control in Chrome.</li>
                    <li>Tippen Sie oben rechts auf das <strong>Drei-Punkte-Menü (⋮)</strong>.</li>
                    <li>Wählen Sie <strong>„App installieren“</strong> oder <strong>„Zum Startbildschirm hinzufügen“</strong>.</li>
                    <li>Tippen Sie auf <strong>„Installieren“</strong>.</li>
                    <li>Store Control startet nun über das Symbol auf Ihrem Startbildschirm als echte Vollbild-App.</li>
                </ol>
            </div>

            <!-- iPhone Guide -->
            <div class="bg-slate-50 border border-slate-200/80 rounded-2xl p-3.5 space-y-2">
                <div class="flex items-center justify-between">
                    <h4 class="font-bold text-xs text-slate-900 flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full bg-blue-500"></span>
                        iPhone / iPad (Apple Safari)
                    </h4>
                    <span class="text-[10px] text-slate-500 font-medium">Safari</span>
                </div>
                <ol class="text-xs text-slate-600 space-y-1.5 pl-4 list-decimal">
                    <li>Öffnen Sie Store Control in Safari.</li>
                    <li>Tippen Sie unten in der Leiste auf den <strong>Teilen-Button</strong> (Viereck mit Pfeil nach oben).</li>
                    <li>Scrollen Sie im Menü etwas nach unten und wählen Sie <strong>„Zum Home-Bildschirm“</strong> (+ Symbol).</li>
                    <li>Tippen Sie oben rechts auf <strong>„Hinzufügen“</strong>.</li>
                    <li>Store Control erscheint mit eigenem App-Icon auf Ihrem iPhone und öffnet sich ohne Browser-Rahmen.</li>
                </ol>
            </div>

            <div class="text-center pt-1">
                <button onclick="closeModal('pwaInstallModal')" class="px-5 py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition">
                    Verstanden
                </button>
            </div>
        </div>
    </div>
</body>`;

if (!html.includes('id="pwaInstallModal"')) {
    html = html.replace(modalTarget, pwaModalHtml);
    console.log('4. pwaInstallModal added');
}

fs.writeFileSync('index.html', html, 'utf8');
console.log('index.html updated successfully!');
