const fs = require('fs');
const path = require('path');
const os = require('os');

const dir = path.join(os.homedir(), 'Library', 'Application Support', 'geepus-desktop', 'agent-runs');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

const stats = files.map(f => {
    const p = path.join(dir, f);
    return { file: p, mtime: fs.statSync(p).mtimeMs };
});

stats.sort((a, b) => b.mtime - a.mtime);

console.log(stats.slice(0, 3).map(s => s.file).join('\n'));
