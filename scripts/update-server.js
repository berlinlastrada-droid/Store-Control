const fs = require('fs');
let code = fs.readFileSync('server/index.js', 'utf8');
const target = `app.use(express.static(path.join(__dirname, '..'), {
    index: 'index.html',
    extensions: ['html']
}));`;
const replacement = `app.use(express.static(path.join(__dirname, '..'), {
    index: 'index.html',
    extensions: ['html'],
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('manifest.json') || filePath.endsWith('manifest.webmanifest')) {
            res.setHeader('Content-Type', 'application/manifest+json');
        }
    }
}));`;

if (code.includes(target)) {
    code = code.replace(target, replacement);
    fs.writeFileSync('server/index.js', code, 'utf8');
    console.log('server/index.js updated successfully!');
} else {
    console.log('Target not found or already updated');
}
