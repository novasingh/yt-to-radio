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
let db;
let streamService;
let apiRoutes;
let authRoutes;

// Safe asynchronous service bootstrap
// Safe asynchronous service bootstrap
setImmediate(() => {
    try {
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
