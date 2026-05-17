const express = require('express');
const { login, getAllUsers, createUser, deleteUser, authMiddleware, changePassword } = require('../services/authService');

const router = express.Router();

// Login
router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    
    try {
        const result = await login(username, password);
        if (result.success) {
            res.json(result);
        } else {
            res.status(401).json(result);
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Get all users (admin only)
router.get('/users', authMiddleware, async (req, res) => {
    try {
        const users = await getAllUsers();
        res.json({ success: true, users });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch users' });
    }
});

// Create user (admin only)
router.post('/users', authMiddleware, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    
    try {
        const result = await createUser(username, password);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Delete user (admin only)
router.delete('/users/:id', authMiddleware, async (req, res) => {
    try {
        const result = await deleteUser(req.params.id);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Change password (logged in users only, not superadmin)
router.put('/password', authMiddleware, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword) {
        return res.status(400).json({ success: false, message: 'New password required' });
    }
    
    if (req.user.role === 'superadmin') {
        return res.status(403).json({ success: false, message: 'Superadmin password cannot be changed via UI' });
    }
    
    try {
        const result = await changePassword(req.user.id, newPassword);
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

module.exports = router;
