const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
require('dotenv').config();

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '../database.sqlite');
const dbExists = fs.existsSync(dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        logger.error(`Database connection error: ${err.message}`);
    } else {
        logger.info('Connected to the SQLite database.');
        
        // If the database was created just now, explicitly set full read & write permissions (0666)
        if (!dbExists) {
            try {
                fs.chmodSync(dbPath, 0o666);
                logger.info('Database file permissions set to 0666 (Read/Write for all processes).');
            } catch (chmodErr) {
                logger.warn(`Failed to set database file permissions: ${chmodErr.message}`);
            }
        }
        
        initDb();
    }
});

function initDb() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT DEFAULT 'user'
        )`, (err) => {
            if (err) {
                logger.error(`Error creating users table: ${err.message}`);
            } else {
                ensureSuperAdmin();
            }
        });
    });
}

function ensureSuperAdmin() {
    const superUser = process.env.SUPER_ADMIN_USER || 'admin';
    const superPass = process.env.SUPER_ADMIN_PASS || 'admin123';

    db.get(`SELECT * FROM users WHERE username = ?`, [superUser], (err, row) => {
        if (err) {
            logger.error(`Error checking superadmin: ${err.message}`);
            return;
        }
        if (!row) {
            const salt = bcrypt.genSaltSync(10);
            const hash = bcrypt.hashSync(superPass, salt);
            db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [superUser, hash, 'superadmin'], (err) => {
                if (err) {
                    logger.error(`Error creating superadmin: ${err.message}`);
                } else {
                    logger.info(`Superadmin user '${superUser}' created successfully.`);
                }
            });
        }
    });
}

module.exports = db;
