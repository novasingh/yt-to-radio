// Programmatically suppress Node's SQLite ExperimentalWarning to keep Hostinger logs pristine and clean
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
    if (typeof warning === 'string' && warning.includes('SQLite is an experimental feature')) {
        return;
    }
    return originalEmitWarning(warning, ...args);
};

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const https = require('https');
require('dotenv').config();

const logger = require('./utils/logger');

// Express App Initialization
const app = express();
const PORT = process.env.PORT || 3000;

// Enable 'trust proxy' to allow express-rate-limit to read the actual client IP behind Hostinger/Apache reverse proxies
app.set('trust proxy', 1);

// ==========================================
// 1. ROBUST UNCAUGHT EXCEPTION & REJECTION HANDLERS
// Prevent Hostinger OOM/Engine issues from bringing down the entire Node.js server
// ==========================================
process.on('uncaughtException', (err) => {
    logger.error(`CRITICAL: Uncaught Exception caught safely: ${err.message}`);
    if (err.stack) logger.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error(`CRITICAL: Unhandled Promise Rejection: ${reason}`);
    if (reason && reason.stack) logger.error(reason.stack);
});

// ==========================================
// 2. INSTANT BIND & PORT HANDSHAKE (VITAL FOR HOSTINGER)
// Calling app.listen() instantly prevents the Hostinger Node supervisor from timing out and throwing 503 errors.
// ==========================================
const server = app.listen(PORT, () => {
    logger.info(`=== STARTUP DIAGNOSTICS ===`);
    logger.info(`Hostinger Environment: Node.js ${process.version} (${process.platform})`);
    logger.info(`Server successfully bound to dynamic port: ${PORT} (Active & Online)`);
    logger.info(`===========================`);
});

// ==========================================
// 3. MIDDLEWARES & CORS STABILITY
// ==========================================
app.use(cors());
app.use(express.json());

// Serve static frontend files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 4. ASYNCHRONOUS INITIALIZATION
// Load routes and initialize database/streams non-blockingly using lazy-loading
// ==========================================
// Robust self-contained standalone Python 3 runner installer & verifier
async function ensurePython3() {
    if (process.platform === 'win32') {
        logger.info('Hostinger Environment: Running on Windows. Skipping Linux Python 3 check.');
        return;
    }

    return new Promise((resolve) => {
        exec('python3 --version', async (err, stdout, stderr) => {
            if (!err) {
                const version = (stdout || stderr).trim();
                logger.info(`System Python 3 is already installed: ${version}`);
                resolve();
                return;
            }

            const localBinDir = path.join(__dirname, 'bin');
            const localPythonDir = path.join(localBinDir, 'python');
            const localPythonExe = path.join(localPythonDir, 'bin/python3');

            if (fs.existsSync(localPythonExe)) {
                const localPythonBinPath = path.join(localPythonDir, 'bin');
                process.env.PATH = `${localPythonBinPath}:${process.env.PATH}`;
                logger.info(`Portable Python 3 runtime verified at: ${localPythonExe}`);
                resolve();
                return;
            }

            logger.info('Hostinger Environment: System Python 3 is missing. Automating installation of self-contained standalone Python 3 runtime...');

            if (!fs.existsSync(localBinDir)) {
                fs.mkdirSync(localBinDir, { recursive: true });
            }

            const archivePath = path.join(localBinDir, 'python.tar.gz');

            try {
                await new Promise((dlResolve, dlReject) => {
                    const file = fs.createWriteStream(archivePath);
                    function download(url) {
                        https.get(url, (response) => {
                            if (response.statusCode === 302 || response.statusCode === 301) {
                                download(response.headers.location);
                                return;
                            }
                            if (response.statusCode !== 200) {
                                dlReject(new Error(`Failed to download python runtime: HTTP ${response.statusCode}`));
                                return;
                            }
                            response.pipe(file);
                            file.on('finish', () => {
                                file.close();
                                dlResolve();
                            });
                        }).on('error', (dlErr) => {
                            fs.unlink(archivePath, () => {});
                            dlReject(dlErr);
                        });
                    }
                    download('https://github.com/indygreg/python-build-standalone/releases/download/20240107/cpython-3.10.13+20240107-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz');
                });

                logger.info('Standalone Python 3 archive downloaded successfully. Extracting tarball...');

                await new Promise((extResolve, extReject) => {
                    exec(`tar -xzf "${archivePath}" -C "${localBinDir}"`, (extErr, extStdout, extStderr) => {
                        if (extErr) {
                            extReject(new Error(extStderr || extErr.message));
                            return;
                        }
                        extResolve();
                    });
                });

                try { fs.unlinkSync(archivePath); } catch (e) {}

                const localPythonBinPath = path.join(localPythonDir, 'bin');
                try {
                    fs.chmodSync(localPythonExe, 0o755);
                    fs.chmodSync(path.join(localPythonBinPath, 'python'), 0o755);
                } catch (chmodErr) {
                    logger.warn(`Could not set permissions: ${chmodErr.message}`);
                }

                process.env.PATH = `${localPythonBinPath}:${process.env.PATH}`;

                logger.info(`Standalone portable Python 3 runtime installed successfully at: ${localPythonExe}`);
                
                exec('python3 --version', (checkErr, checkStdout, checkStderr) => {
                    if (checkErr) {
                        logger.error(`Failed to verify installed Python 3: ${checkStderr || checkErr.message}`);
                    } else {
                        logger.info(`Verified local Python 3 installation successfully: ${(checkStdout || checkStderr).trim()}`);
                    }
                    resolve();
                });

            } catch (installErr) {
                logger.error(`Failed to install standalone Python 3 runtime: ${installErr.message}`);
                resolve();
            }
        });
    });
}

let db;
let streamService;
let apiRoutes;
let authRoutes;

// Safe asynchronous service bootstrap
setImmediate(async () => {
    try {
        await ensurePython3();
        logger.info('[STARTUP] Initializing database layer non-blockingly...');
        db = require('./services/db');
        
        logger.info('[STARTUP] Initializing streaming services...');
        streamService = require('./services/streamService');
        
        logger.info('[STARTUP] Registering backend application routes...');
        apiRoutes = require('./routes/api');
        authRoutes = require('./routes/auth');
        
        app.use('/api', apiRoutes);
        app.use('/auth', authRoutes);
        
        // ==========================================
        // 5. RESILIENT `/live` STREAMING ROUTE
        // ==========================================
        app.get('/live', (req, res) => {
            // Explicitly allow Cross-Origin Resource Sharing (CORS) for high compatibility across clients and audio players
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');

            // Safe protection against uninitialized streamService during async boot
            if (!streamService) {
                logger.warn('Streaming service is not yet initialized.');
                return res.status(503).json({ error: 'Streaming service starting up. Please try again shortly.' });
            }

            if (!streamService.isOnline) {
                logger.info('Listener rejected, stream is currently offline.');
                return res.status(503).send('Stream Offline');
            }

            // Set streaming headers ONLY when the stream is verified to be online
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Transfer-Encoding', 'chunked');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');

            // Add listener to the stream service
            try {
                streamService.addListener(res);
            } catch (streamErr) {
                logger.error(`Failed to bind listener response: ${streamErr.message}`);
                res.status(500).send('Streaming Connection Failure');
            }
        });

        // ==========================================
        // 6. HEALTH & STATUS ENDPOINT (PRODUCTION SAFE)
        // Always responds immediately, providing debug metrics even if background services are failing
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
                    const streamStatus = streamService.getStatus();
                    statusData.online = streamStatus.online;
                    statusData.url = streamStatus.url;
                    statusData.listenerCount = streamStatus.listenerCount;
                    statusData.diagnostics.streamingHealthy = true;
                }
            } catch (e) {
                statusData.diagnostics.error = e.message;
            }

            res.status(200).json(statusData);
        });

        // ==========================================
        // 7. DEFAULT CATCH-ALL ROUTE (INDEX FALLBACK)
        // Must be registered after all routers to prevent premature HTML fallback matching
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
        
        logger.info('[STARTUP] All background modules loaded successfully.');
    } catch (bootstrapErr) {
        logger.error(`[STARTUP] Degraded Startup: Modules failed to load asynchronously: ${bootstrapErr.message}`);
    }
});

// ==========================================
// 9. GRACEFUL SHUTDOWN HANDLING
// ==========================================
function shutdown() {
    logger.info('Shutting down server...');
    if (streamService) {
        try {
            streamService.stopStream(true);
        } catch (e) {}
    }
    server.close(() => {
        logger.info('HTTP server closed.');
        process.exit(0);
    });
    
    // Force close after 3 seconds
    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
