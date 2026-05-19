const express = require('express');
const streamService = require('../services/streamService');
const { authMiddleware } = require('../services/authService');

const router = express.Router();

// Get stream status (public)
router.get('/status', (req, res) => {
    res.json(streamService.getStatus());
});

// Start stream (admin only)
router.post('/start', authMiddleware, (req, res) => {
    const { url, title } = req.body;
    if (!url) {
        return res.status(400).json({ success: false, message: 'URL is required' });
    }
    
    streamService.startStream(url, title);
    res.json({ success: true, message: 'Stream started' });
});

// Stop stream (admin only)
router.post('/stop', authMiddleware, (req, res) => {
    streamService.stopStream(true);
    res.json({ success: true, message: 'Stream stopped' });
});

module.exports = router;
