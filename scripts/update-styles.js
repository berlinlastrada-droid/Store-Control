const fs = require('fs');
let css = fs.readFileSync('styles.css', 'utf8');

const pwaCss = `
/* PWA Standalone & iOS Safe Areas */
@supports (padding-top: env(safe-area-inset-top)) {
    @media all and (display-mode: standalone) {
        header {
            padding-top: max(0.5rem, env(safe-area-inset-top));
        }
    }
}

.pwa-standalone-only {
    display: none;
}

@media all and (display-mode: standalone) {
    .pwa-standalone-only {
        display: block;
    }
    .pwa-browser-only {
        display: none !important;
    }
}
`;

if (!css.includes('PWA Standalone & iOS Safe Areas')) {
    css += pwaCss;
    fs.writeFileSync('styles.css', css, 'utf8');
    console.log('styles.css updated with PWA styles');
} else {
    console.log('styles.css already contains PWA styles');
}
