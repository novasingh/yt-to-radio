// High-concurrency optimizations for maximum scale (5k+ concurrent users)
process.env.UV_THREADPOOL_SIZE = '128';
process.setMaxListeners(0);
require('events').EventEmitter.defaultMaxListeners = 0;

// Programmatically suppress Node's SQLite ExperimentalWarning to keep Hostinger logs pristine and clean
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) {
        return;
    }
    return originalEmitWarning(warning, ...args);
};

const cluster = require('cluster');
const os = require('os');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');
require('dotenv').config();

const logger = require('./utils/logger');

// Concurrency auto-scaling constants
const MIN_WORKERS = parseInt(process.env.WEB_MIN_WORKERS || '1', 10); // Always keep minimum workers for high availability and failover
const MAX_WORKERS = parseInt(process.env.WEB_MAX_WORKERS || '', 10) || Math.max(os.cpus().length || 4, 4); // Scale up to configured limit or CPU core count
const SCALE_UP_THRESHOLD = 1500; // Spawn a new worker if average listeners per worker exceed 1500
const SCALE_DOWN_THRESHOLD = 500; // Drains a worker if average listeners per worker drop below 500

if (cluster.isMaster) {
    logger.info(`=== MASTER PROCESS ${process.pid} STARTING UP ===`);
    logger.info(`System CPUs: ${os.cpus().length}. Dynamic Auto-scaling bounds: ${MIN_WORKERS} to ${MAX_WORKERS} workers.`);

    // Master process lazy-loads the streaming service singleton
    const streamService = require('./services/streamService');

    // Uncaught exception safety inside master process
    process.on('uncaughtException', (err) => {
        logger.error(`[MASTER ${process.pid}] Uncaught Exception: ${err.message}`);
        if (err.stack) logger.error(err.stack);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error(`[MASTER ${process.pid}] Unhandled Rejection: ${reason}`);
    });

    // Auto-resume saved stream from database on boot, or fall back to default YouTube live stream
    const db = require('./services/db');
    db.get(`SELECT * FROM active_stream WHERE id = 1`, [], (err, row) => {
        if (err) {
            logger.error(`[STARTUP] Failed to query active stream database: ${err.message}`);
        }

        if (row && row.active === 1 && row.url) {
            logger.info(`[STARTUP] Auto-resuming saved active stream from database: ${row.url}`);
            streamService.startStream(row.url);
        } else {
            const defaultUrl = 'https://www.youtube.com/watch?v=8gBkM8-bRz8';
            logger.info(`[STARTUP] No saved active stream found. Auto-starting default live stream: ${defaultUrl}`);
            streamService.startStream(defaultUrl);
        }
    });

    const updateGlobalStatus = () => {
        let totalListeners = 0;
        const activeWorkers = Object.values(cluster.workers).filter(w => !w.isShuttingDown);

        activeWorkers.forEach(w => {
            totalListeners += w.localListenerCount || 0;
        });

        const status = {
            online: streamService.isOnline,
            url: streamService.currentUrl,
            listenerCount: totalListeners
        };

        // Broadcast status updates to all active workers
        activeWorkers.forEach(w => {
            try {
                w.send({ type: 'status-change', status });
            } catch (e) { }
        });
    };

    // Initially fork MIN_WORKERS workers to save memory; auto-scaler will handle the rest
    logger.info(`Forking initial base of ${MIN_WORKERS} cluster worker processes for high availability...`);
    for (let i = 0; i < MIN_WORKERS; i++) {
        cluster.fork();
    }

    cluster.on('fork', (worker) => {
        worker.localListenerCount = 0;
        worker.isShuttingDown = false;

        worker.on('message', (msg) => {
            if (msg.type === 'start-stream') {
                streamService.startStream(msg.url);
            } else if (msg.type === 'stop-stream') {
                streamService.stopStream(true);
            } else if (msg.type === 'listener-update') {
                worker.localListenerCount = msg.count;
                updateGlobalStatus();

                // If this worker is currently in soft-drain, and its socket count has hit 0, terminate it!
                if (worker.isDraining && msg.count === 0) {
                    logger.info(`[AUTO-SCALE] Soft-draining Worker ${worker.process.pid} has reached 0 active sockets. Terminating process cleanly.`);
                    worker.isShuttingDown = true;
                    try {
                        worker.send({ type: 'graceful-shutdown' });
                    } catch (err) {
                        logger.error(`Failed to send shutdown signal: ${err.message}`);
                    }
                }
            } else if (msg.type === 'diagnostics-report') {
                logger.info(`[DIAGNOSTICS] Worker ${msg.pid} | Sockets: ${msg.listeners} | Heap RAM: ${msg.heapUsed}MB | RSS RAM: ${msg.rss}MB`);
            }
        });
    });

    cluster.on('exit', (worker, code, signal) => {
        if (worker.isShuttingDown) {
            logger.info(`Worker process ${worker.process.pid} drained and exited cleanly according to auto-scale directives.`);
        } else {
            logger.warn(`Worker process ${worker.process.pid} exited unexpectedly. Spawning replacement worker process...`);
            cluster.fork();
        }
    });

    // Forward raw audio-chunk events to workers via fast process IPC messaging
    streamService.on('audio-chunk', (chunk) => {
        for (const id in cluster.workers) {
            try {
                const w = cluster.workers[id];
                if (w && !w.isShuttingDown) {
                    w.send({ type: 'audio-chunk', data: chunk });
                }
            } catch (e) { }
        }
    });

    // Handle status change transitions
    streamService.on('status-change', () => {
        updateGlobalStatus();
    });

    let lastScaleTime = Date.now();
    const SCALE_COOLDOWN_MS = 60000; // 1-minute scale cooldown

    // ==========================================
    // HIGH-PERFORMANCE DYNAMIC AUTO-SCALER & HEALTH DIAGNOSTICIAN
    // Runs every 15 seconds to log heap usages and scale up/down worker threads
    // ==========================================
    setInterval(() => {
        const activeWorkers = Object.values(cluster.workers).filter(w => !w.isShuttingDown);
        const totalWorkersCount = activeWorkers.length;
        let totalListeners = 0;

        activeWorkers.forEach(w => {
            totalListeners += w.localListenerCount || 0;
        });

        const avgListeners = totalWorkersCount > 0 ? (totalListeners / totalWorkersCount) : 0;

        // Log System Health Diagnostics
        const systemLoad = os.loadavg();
        const freeMem = (os.freemem() / (1024 * 1024)).toFixed(0);
        const totalMem = (os.totalmem() / (1024 * 1024)).toFixed(0);
        const masterHeapUsed = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1);

        logger.info(`[HEALTH MONITOR] Master Heap RAM: ${masterHeapUsed}MB | System Free RAM: ${freeMem}MB/${totalMem}MB | CPU Load (5m): ${systemLoad[1].toFixed(2)} | Active Workers: ${totalWorkersCount} | Global Listeners: ${totalListeners}`);

        // Query workers for internal memory diagnostics
        activeWorkers.forEach(w => {
            try { w.send({ type: 'query-diagnostics' }); } catch (e) { }
        });

        const now = Date.now();
        const timeSinceLastScale = now - lastScaleTime;

        // 1. AUTO-SCALE UP: If avg connections per worker exceed 1500, spawn a new worker
        if (avgListeners > SCALE_UP_THRESHOLD && totalWorkersCount < MAX_WORKERS) {
            if (timeSinceLastScale > SCALE_COOLDOWN_MS) {
                logger.info(`[AUTO-SCALE] Load is high (${avgListeners.toFixed(1)} listeners/worker). Spawning a new worker process to distribute stress...`);
                cluster.fork();
                lastScaleTime = now;
            } else {
                logger.info(`[AUTO-SCALE] Load is high but scaling up is cooling down (${(timeSinceLastScale / 1000).toFixed(0)}s elapsed of ${SCALE_COOLDOWN_MS / 1000}s).`);
            }
        }
        // 2. AUTO-SCALE DOWN: If avg connections per worker drop below threshold (500), terminate one worker gracefully
        else if (avgListeners < SCALE_DOWN_THRESHOLD && totalWorkersCount > MIN_WORKERS) {
            if (timeSinceLastScale > SCALE_COOLDOWN_MS) {
                // To avoid breaking streams, we strictly select and terminate a worker with 0 active listeners first
                const zeroLoadWorker = activeWorkers.find(w => (w.localListenerCount || 0) === 0);
                if (zeroLoadWorker) {
                    logger.info(`[AUTO-SCALE] Found idle Worker ${zeroLoadWorker.process.pid} with 0 sockets. Initiating clean shutdown...`);
                    zeroLoadWorker.isShuttingDown = true;
                    try {
                        zeroLoadWorker.send({ type: 'graceful-shutdown' });
                    } catch (err) {
                        logger.error(`Failed to send shutdown signal: ${err.message}`);
                    }
                    lastScaleTime = now;
                } else {
                    // If no worker has 0 listeners, we initiate a "soft-drain" on the first non-draining worker.
                    // This stops it from accepting new connections, but keeps it alive to stream to existing sockets until they disconnect!
                    const drainTarget = activeWorkers.find(w => !w.isDraining);
                    if (drainTarget) {
                        logger.info(`[AUTO-SCALE] Load is low. Initiating soft connection drain on Worker ${drainTarget.process.pid} (active sockets: ${drainTarget.localListenerCount})...`);
                        drainTarget.isDraining = true;
                        try {
                            drainTarget.send({ type: 'soft-drain' });
                        } catch (err) {
                            logger.error(`Failed to send soft-drain signal: ${err.message}`);
                        }
                        lastScaleTime = now;
                    }
                }
            } else {
                logger.info(`[AUTO-SCALE] Load is low but scaling down is cooling down (${(timeSinceLastScale / 1000).toFixed(0)}s elapsed of ${SCALE_COOLDOWN_MS / 1000}s).`);
            }
        }
    }, 15000);

} else {
    // ==========================================
    // WORKER PROCESS CODE (Runs Express Web App)
    // ==========================================
    const app = express();
    const PORT = process.env.PORT || 3000;
    app.set('trust proxy', 1);

    // Uncaught exception safety inside worker processes
    process.on('uncaughtException', (err) => {
        logger.error(`[WORKER ${process.pid}] Uncaught Exception: ${err.message}`);
        if (err.stack) logger.error(err.stack);
    });

    process.on('unhandledRejection', (reason, promise) => {
        logger.error(`[WORKER ${process.pid}] Unhandled Rejection: ${reason}`);
    });

    // Binds the Express app to the shared dynamic port immediately
    const server = app.listen(PORT, () => {
        logger.info(`[WORKER ${process.pid}] Serverbound to port: ${PORT} (Active & Load-Balanced)`);
    });

    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    let db;
    let streamService;
    let apiRoutes;
    let authRoutes;
    const sseClients = new Set();

    // IPC message listener for worker diagnostics and graceful drain handling
    process.on('message', (msg) => {
        if (msg.type === 'query-diagnostics') {
            const heapUsed = (process.memoryUsage().heapUsed / (1024 * 1024)).toFixed(1);
            const rss = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
            try {
                process.send({
                    type: 'diagnostics-report',
                    pid: process.pid,
                    heapUsed,
                    rss,
                    listeners: streamService ? streamService.listeners.size : 0
                });
            } catch (e) { }
        } else if (msg.type === 'graceful-shutdown') {
            logger.info(`[WORKER ${process.pid}] Graceful shutdown signal received from Master. Draining connections...`);

            // Close all active SSE clients immediately so they reconnect to healthy active workers
            for (const client of sseClients) {
                try {
                    client.end();
                } catch (e) { }
            }
            sseClients.clear();

            // Close the shared server port to stop accepting new TCP connection requests
            server.close(() => {
                logger.info(`[WORKER ${process.pid}] All server connections drained. Exiting worker cleanly.`);
                process.exit(0);
            });

            // Fallback forced drain timeout of 15 seconds to safely disconnect residual streams
            setTimeout(() => {
                logger.info(`[WORKER ${process.pid}] Forced drain timeout reached. Terminating remaining streaming sockets.`);
                if (streamService) {
                    for (const res of streamService.listeners) {
                        try { res.end(); } catch (e) { }
                    }
                }
                process.exit(0);
            }, 15000);
        } else if (msg.type === 'soft-drain') {
            logger.info(`[WORKER ${process.pid}] Soft-drain received. Closing HTTP server port to reject new incoming connections while preserving existing ones.`);

            // Close the shared server port to stop accepting new TCP connection requests
            server.close(() => {
                logger.info(`[WORKER ${process.pid}] HTTP server closed. Exiting worker cleanly.`);
                process.exit(0);
            });

            // If there are already no active stream sockets, exit immediately!
            if (streamService && streamService.listeners.size === 0) {
                logger.info(`[WORKER ${process.pid}] No active listeners on soft-drain. Exiting immediately.`);
                process.exit(0);
            }
        }
    });

    // Lazy load modules inside worker threads
    setImmediate(() => {
        try {
            logger.info(`[WORKER ${process.pid}] Loading database modules...`);
            db = require('./services/db');

            logger.info(`[WORKER ${process.pid}] Connecting transparent streaming bridge...`);
            streamService = require('./services/streamService');

            let lastState = { online: false, url: null, listenerCount: 0 };
            streamService.on('status-change', () => {
                const status = streamService.getStatus();
                const currentState = {
                    online: status.online,
                    url: status.url,
                    listenerCount: status.listenerCount
                };
                if (
                    currentState.online !== lastState.online ||
                    currentState.url !== lastState.url ||
                    currentState.listenerCount !== lastState.listenerCount
                ) {
                    lastState = currentState;
                    const data = JSON.stringify(currentState);
                    for (const client of sseClients) {
                        try {
                            client.write(`data: ${data}\n\n`);
                        } catch (err) { }
                    }
                }
            });

            logger.info(`[WORKER ${process.pid}] Loading route registry...`);
            apiRoutes = require('./routes/api');
            authRoutes = require('./routes/auth');

            app.use('/api', apiRoutes);
            app.use('/auth', authRoutes);

            // ==========================================
            // 5. RESILIENT `/live` STREAMING ROUTE
            // ==========================================
            app.get('/live', (req, res) => {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
                res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx/Apache buffering for instant playbacks

                if (!streamService) {
                    return res.status(503).json({ error: 'Streaming service starting up. Please try again shortly.' });
                }

                if (!streamService.isOnline) {
                    return res.status(503).send('Stream Offline');
                }

                res.setHeader('Content-Type', 'audio/mpeg');
                res.setHeader('Transfer-Encoding', 'chunked');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

                try {
                    streamService.addListener(res);
                } catch (streamErr) {
                    res.status(500).send('Streaming Connection Failure');
                }
            });

            // ==========================================
            // 6. HEALTH & STATUS ENDPOINT (PRODUCTION SAFE)
            // ==========================================
            app.get('/api/status', (req, res) => {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Content-Type', 'application/json');

                const statusData = {
                    online: false,
                    url: null,
                    listenerCount: 0,
                    diagnostics: {
                        nodeVersion: process.version,
                        platform: process.platform,
                        serverBound: true,
                        databaseHealthy: false,
                        streamingHealthy: false
                    }
                };

                try {
                    if (db) {
                        statusData.diagnostics.databaseHealthy = true;
                    }
                    if (streamService) {
                        const status = streamService.getStatus();
                        statusData.online = status.online;
                        statusData.url = status.url;
                        statusData.listenerCount = status.listenerCount;
                        statusData.diagnostics.streamingHealthy = true;
                    }
                } catch (e) {
                    statusData.diagnostics.error = e.message;
                }

                res.status(200).json(statusData);
            });

            // ==========================================
            // 6.1 SERVER-SENT EVENTS (SSE) ENDPOINT
            // ==========================================
            app.get('/api/status/events', (req, res) => {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('X-Accel-Buffering', 'no');

                res.flushHeaders();

                let initialData = { online: false, url: null, listenerCount: 0 };
                if (streamService) {
                    const status = streamService.getStatus();
                    initialData = {
                        online: status.online,
                        url: status.url,
                        listenerCount: status.listenerCount
                    };
                }
                res.write(`data: ${JSON.stringify(initialData)}\n\n`);

                sseClients.add(res);

                req.on('close', () => {
                    sseClients.delete(res);
                });
            });

            // ==========================================
            // 7. DEFAULT CATCH-ALL ROUTE (INDEX FALLBACK)
            // ==========================================
            app.get('*', (req, res) => {
                const indexPath = path.join(__dirname, 'public/index.html');
                if (fs.existsSync(indexPath)) {
                    res.sendFile(indexPath);
                } else {
                    res.status(404).send('Web Frontend under construction. Please check back later.');
                }
            });

            // ==========================================
            // 8. GLOBAL FALLBACK ERROR MIDDLEWARE
            // ==========================================
            app.use((err, req, res, next) => {
                logger.error(`Unhandled request error: ${err.message}`);
                res.status(500).json({
                    error: 'Internal Server Error',
                    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred.'
                });
            });

            logger.info(`[WORKER ${process.pid}] Bootstrap finished successfully.`);
        } catch (bootstrapErr) {
            logger.error(`[WORKER ${process.pid}] Failed async bootstrap: ${bootstrapErr.message}`);
        }
    });
}
