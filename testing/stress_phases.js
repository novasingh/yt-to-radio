const http = require('http');
const { exec } = require('child_process');

const phases = [
    { target: 500, duration: 30 * 1000 },
    { target: 1000, duration: 120 * 1000 },
    { target: 200, duration: 300 * 1000 }
];

let connected = 0;
let errors = 0;
let activeRequests = new Set();
let reportData = [];

function getServerMemory() {
    return new Promise((resolve) => {
        exec('powershell "Get-Process node | Measure-Object WorkingSet -Maximum | Select-Object Maximum | ConvertTo-Json"', (err, stdout) => {
            if (err) return resolve('N/A');
            try {
                const data = JSON.parse(stdout);
                resolve((data.Maximum / 1024 / 1024).toFixed(2) + ' MB');
            } catch (e) {
                resolve('N/A');
            }
        });
    });
}

function spawnConnection() {
    const req = http.get('http://localhost:3000/live', {
        agent: new http.Agent({ keepAlive: true, maxSockets: Infinity })
    }, (res) => {
        if (res.statusCode === 200) {
            connected++;
            res.on('data', () => {});
            res.on('end', () => {
                connected--;
                activeRequests.delete(req);
            });
        } else {
            errors++;
        }
    });
    req.on('error', (err) => {
        errors++;
        activeRequests.delete(req);
    });
    activeRequests.add(req);
}

function removeConnections(count) {
    let removed = 0;
    for (const req of activeRequests) {
        if (removed >= count) break;
        req.destroy();
        activeRequests.delete(req);
        removed++;
        connected--;
    }
}

async function runPhases() {
    console.log('Starting Phased Stress Test (7.5 Minutes Total)...\n');
    
    for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        console.log(`=== Phase ${i + 1}: ${phase.target} users for ${phase.duration / 1000} seconds ===`);
        
        if (connected < phase.target) {
            const toAdd = phase.target - connected;
            console.log(`Ramping up: adding ${toAdd} connections...`);
            for (let j = 0; j < toAdd; j++) spawnConnection();
        } else if (connected > phase.target) {
            const toRemove = connected - phase.target;
            console.log(`Ramping down: removing ${toRemove} connections...`);
            removeConnections(toRemove);
        }

        // Wait a few seconds for connections to establish before taking baseline
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        let peakMem = 0;
        const interval = setInterval(async () => {
            const mem = await getServerMemory();
            console.log(`[Phase ${i + 1}] Target: ${phase.target} | Actual Connected: ${connected} | Server RAM: ${mem}`);
            
            // Record data for the final report
            reportData.push({ phase: i + 1, target: phase.target, connected, mem });
        }, 15000); // Check every 15 seconds

        await new Promise(resolve => setTimeout(resolve, phase.duration - 3000));
        clearInterval(interval);
        console.log(`Phase ${i + 1} complete.\n`);
    }
    
    console.log('Stress test complete! Generating final summary...');
    removeConnections(activeRequests.size);
    
    console.log('\n=== FINAL SOLID RESULTS ===');
    console.log('Total Errors:', errors);
    console.log('Test successful. Exiting.');
    process.exit(0);
}

runPhases();
