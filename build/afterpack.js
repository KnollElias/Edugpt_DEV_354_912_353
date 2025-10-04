// build/afterPack.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = async (context) => {
    const resourcesDir = path.join(context.appOutDir, 'resources');
    const pyExe = path.join(resourcesDir, 'python', 'python.exe');
    const wheelhouse = path.join(resourcesDir, 'wheelhouse');

    if (!fs.existsSync(pyExe)) {
        console.warn('[afterPack] python.exe nicht gefunden – überspringe Wheel-Download.');
        return;
    }

    fs.mkdirSync(wheelhouse, { recursive: true });

    const args = [
        '-m', 'pip',
        'download',
        '--only-binary=:all:',
        '-d', wheelhouse,
        'itsdangerous==2.2.0'
        // Optional: 'huggingface_hub[hf_xet]'
    ];
    const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const res = spawnSync(pyExe, args, { stdio: 'inherit', env });

    if (res.status !== 0) {
        throw new Error('[afterPack] pip download itsdangerous==2.2.0 fehlgeschlagen');
    }

    console.log('[afterPack] itsdangerous Wheel erfolgreich in resources\\wheelhouse abgelegt.');
};
