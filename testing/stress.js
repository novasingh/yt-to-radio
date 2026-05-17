const http = require('http');

const MAX_CONNECTIONS = 2000;
const BATCH_SIZE = 100;
const BATCH_DELAY_MS = 500;

let connected = 0;
let errors = 0;
let bytesReceived = 0;

console.log(`Starting Stress Test: Aiming for ${MAX_CONNECTIONS} concurrent listeners...`);

function spawnBatch(batchSize) {
    for (let i = 0; i < batchSize; i++) {
        const req = http.get('http://localhost:3000/live', {
            // Keep alive agent helps bypass ephemeral port exhaustion to some extent
            agent: new http.Agent({ keepAlive: true, maxSockets: Infinity }) 
        }, (res) => {
            if (res.statusCode === 200) {
                connected++;
                res.on('data', (chunk) => {
                    bytesReceived += chunk.length;
                });
                res.on('end', () => {
                    connected--;
                });
            } else {
                errors++;
            }
        });
        
        req.on('error', (err) => {
            errors++;
        });
    }
}

let spawned = 0;
const interval = setInterval(() => {
    if (spawned < MAX_CONNECTIONS) {
        const toSpawn = Math.min(BATCH_SIZE, MAX_CONNECTIONS - spawned);
        spawnBatch(toSpawn);
        spawned += toSpawn;
    } else {
        clearInterval(interval);
    }
}, BATCH_DELAY_MS);

// Monitor stats
const statsInterval = setInterval(() => {
    console.log(`[Stats] Target: ${MAX_CONNECTIONS} | Connected: ${connected} | Errors: ${errors} | Data Received: ${(bytesReceived / 1024 / 1024).toFixed(2)} MB`);
    if (spawned >= MAX_CONNECTIONS && connected + errors >= MAX_CONNECTIONS) {
        console.log('Stress test stabilized. Gathering final metrics for 10 seconds...');
        setTimeout(() => {
            console.log('Stress test complete.');
            process.exit(0);
        }, 10000);
        clearInterval(statsInterval);
    }
}, 2000);
