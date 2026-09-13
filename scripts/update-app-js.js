const fs = require('fs');
let code = fs.readFileSync('app.js', 'utf8');

// 1. Add initPwaInstallManager() in DOMContentLoaded
const domTarget = '    // Fetch public HTTPS & QR code for smartphone\n    loadPublicUrlInfo();';
const domWithPwa = '    // Fetch public HTTPS & QR code for smartphone\n    loadPublicUrlInfo();\n\n    // Initialize PWA installation listeners and buttons\n    initPwaInstallManager();';

if (code.includes(domTarget) && !code.includes('initPwaInstallManager()')) {
    code = code.replace(domTarget, domWithPwa);
    console.log('1. DOMContentLoaded updated with initPwaInstallManager()');
}

// 2. Append PWA logic at the end of app.js
const pwaLogic = `

// =============================================================================
// PWA INSTALLATION & STANDALONE MANAGEMENT
// =============================================================================
let deferredInstallPrompt = null;

function isPwaStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || 
           window.navigator.standalone === true ||
           document.referrer.includes('android-app://');
}

function initPwaInstallManager() {
    const installBtn = document.getElementById('pwaInstallHeaderBtn');
    const isStandalone = isPwaStandalone();

    if (isStandalone) {
        console.log('[PWA] Store Control laeuft im Standalone-App-Modus');
        if (installBtn) installBtn.classList.add('hidden');
        return;
    }

    // If on mobile browser (iPhone, Android, tablet) and not standalone, show install button in header
    const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth <= 768;
    if (installBtn && isMobileDevice) {
        installBtn.classList.remove('hidden');
    }
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    console.log('[PWA] beforeinstallprompt registriert (Android 1-Klick Installation bereit)');

    const installBtn = document.getElementById('pwaInstallHeaderBtn');
    if (installBtn && !isPwaStandalone()) {
        installBtn.classList.remove('hidden');
    }
    const androidBox = document.getElementById('androidPromptActionBox');
    if (androidBox) {
        androidBox.classList.remove('hidden');
    }
});

window.addEventListener('appinstalled', () => {
    console.log('[PWA] Store Control wurde erfolgreich als App installiert!');
    deferredInstallPrompt = null;
    const installBtn = document.getElementById('pwaInstallHeaderBtn');
    if (installBtn) installBtn.classList.add('hidden');
    const androidBox = document.getElementById('androidPromptActionBox');
    if (androidBox) androidBox.classList.add('hidden');
    showToast('Store Control wurde erfolgreich auf Ihrem Startbildschirm installiert!', 'success');
});

function handlePwaInstallClick() {
    if (deferredInstallPrompt) {
        executeAndroidPwaPrompt();
    } else {
        openModal('pwaInstallModal');
    }
}

async function executeAndroidPwaPrompt() {
    if (!deferredInstallPrompt) {
        openModal('pwaInstallModal');
        return;
    }
    try {
        deferredInstallPrompt.prompt();
        const choiceResult = await deferredInstallPrompt.userChoice;
        console.log('[PWA] User Choice:', choiceResult.outcome);
        if (choiceResult.outcome === 'accepted') {
            showToast('Store Control wird installiert...', 'info');
        }
        deferredInstallPrompt = null;
        closeModal('pwaInstallModal');
    } catch (err) {
        console.error('[PWA] Prompt error:', err);
        openModal('pwaInstallModal');
    }
}
`;

if (!code.includes('PWA INSTALLATION & STANDALONE MANAGEMENT')) {
    code += pwaLogic;
    fs.writeFileSync('app.js', code, 'utf8');
    console.log('2. app.js updated with PWA logic');
} else {
    console.log('2. PWA logic already in app.js');
}
