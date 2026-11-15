const path = require('path');
const { spawnSync } = require('child_process');
const which = require('which');

const rootDir = path.resolve(__dirname, '..');
const hasCa65 = Boolean(which.sync('ca65', { nothrow: true }));

const testSuites = [
    { file: 'verify_scanner.js', requiresCa65: false },
    { file: 'verify_macros.js', requiresCa65: false },
    { file: 'verify_equivalence.js', requiresCa65: false },
    { file: 'verify_edge_cases.js', requiresCa65: false },
    { file: 'verify_ux.js', requiresCa65: false },
    { file: 'verify_cpu.js', requiresCa65: false },
    { file: 'verify_features.js', requiresCa65: true },
    { file: 'verify_overlay.js', requiresCa65: true },
    { file: 'verify_args.js', requiresCa65: true },
];

for (const suite of testSuites) {
    if (suite.requiresCa65 && !hasCa65) {
        console.log(`SKIP ${suite.file} (ca65 executable not found in PATH)`);
        continue;
    }

    console.log(`=== ${suite.file} ===`);
    const result = spawnSync(process.execPath, [path.join(__dirname, suite.file)], {
        cwd: rootDir,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

console.log('ALL TEST SUITES COMPLETED SUCCESSFULLY!');
