const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

function login(username, password) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
            if (err) return reject(err);
            if (!user) return resolve({ success: false, message: 'Invalid credentials' });

            const isValid = bcrypt.compareSync(password, user.password);
            if (!isValid) return resolve({ success: false, message: 'Invalid credentials' });

            const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
            resolve({ success: true, token, role: user.role });
        });
    });
}

function getAllUsers() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT id, username, role FROM users`, [], (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

function createUser(username, password) {
    return new Promise((resolve, reject) => {
        const salt = bcrypt.genSaltSync(10);
        const hash = bcrypt.hashSync(password, salt);
        db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, 'user')`, [username, hash], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return resolve({ success: false, message: 'Username already exists' });
                }
                return reject(err);
            }
            resolve({ success: true, id: this.lastID });
        });
    });
}

function deleteUser(id) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, user) => {
            if (err) return reject(err);
            if (!user) return resolve({ success: false, message: 'User not found' });
            if (user.role === 'superadmin') {
                return resolve({ success: false, message: 'Cannot delete superadmin user' });
            }
            
            db.run(`DELETE FROM users WHERE id = ?`, [id], function(err) {
                if (err) return reject(err);
                resolve({ success: true });
            });
        });
    });
}

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Invalid token' });
    }
}

module.exports = {
    login,
    getAllUsers,
    createUser,
    deleteUser,
    authMiddleware
};
