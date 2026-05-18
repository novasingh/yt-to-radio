const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const logger = require('./utils/logger');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const streamService = require('./services/streamService');
// Initialize DB
require('./services/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use('/api', apiRoutes);
app.use('/auth', authRoutes);

// The continuous audio stream endpoint
app.get('/live', (req, res) => {
    // Explicitly allow Cross-Origin Resource Sharing (CORS) for high compatibility across clients and audio players
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    if (!streamService.isOnline) {
        logger.info('Listener rejected, stream is currently offline.');
        return res.status(503).send('Stream Offline');
    }

    // Add listener to the stream service
    streamService.addListener(res);

    // If stream is offline, write empty chunk or just wait
    // Writing a small ID3 tag or silence might help some players, 
    // but just waiting is fine for most HTML5 players.
});

// Default catch-all route to serve index.html for any unmatched direct URL requests
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

const server = app.listen(PORT, () => {
    logger.info(`Server listening on port ${PORT}`);
});

// Graceful shutdown handling
function shutdown() {
    logger.info('Shutting down server...');
    streamService.stopStream(true);
    server.close(() => {
        logger.info('HTTP server closed.');
        process.exit(0);
    });
    
    // Force close after 5 seconds
    setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
    }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
