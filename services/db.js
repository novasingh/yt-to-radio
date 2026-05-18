const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');
require('dotenv').config();

let db;
let dbExists = false;

// Compatibility Adapter to map sqlite3 API  node:sqlite DatabaseSync
class NodeSqliteAdapter {
    constructor(dbPath) {
        this.nativeDb = new (require('node:sqlite').DatabaseSync)(dbPath);
    }

    serialize(cb) {
        if (typeof cb === 'function') cb();
    }

    run(query, params, cb) {
        const callback = typeof params === 'function' ? params : cb;
        const actualParams = Array.isArray(params) ? params : [];
        try {
            if (actualParams.length > 0) {
                const stmt = this.nativeDb.prepare(query);
                stmt.run(...actualParams);
            } else {
                this.nativeDb.exec(query);
            }
            if (typeof callback === 'function') callback(null);
        } catch (err) {
            logger.error(`Database error on run(): ${err.message}`);
            if (typeof callback === 'function') callback(err);
        }
    }

    get(query, params, cb) {
        const callback = typeof params === 'function' ? params : cb;
        const actualParams = Array.isArray(params) ? params : [];
        try {
            const stmt = this.nativeDb.prepare(query);
            const row = stmt.get(...actualParams);
            if (typeof callback === 'function') callback(null, row);
        } catch (err) {
            logger.error(`Database error on get(): ${err.message}`);
            if (typeof callback === 'function') callback(err, null);
        }
    }

    all(query, params, cb) {
        const callback = typeof params === 'function' ? params : cb;
        const actualParams = Array.isArray(params) ? params : [];
        try {
            const stmt = this.nativeDb.prepare(query);
            const rows = stmt.all(...actualParams);
            if (typeof callback === 'function') callback(null, rows);
        } catch (err) {
            logger.error(`Database error on all(): ${err.message}`);
            if (typeof callback === 'function') callback(err, null);
        }
    }
}

// Resilient DB Loader:
// 1. Try to load Node's native built-in `node:sqlite` (Available in Node v22.5.0+, 0% compile, 0% GLIBC mismatch)
// 2. Fall back to standard `sqlite3` package
// 3. Fall back to clean in-memory Mock DB
const dbPath = path.join(__dirname, '../database.sqlite');
dbExists = fs.existsSync(dbPath);

try {
    logger.info('Attempting to load built-in node:sqlite module...');
    db = new NodeSqliteAdapter(dbPath);
    logger.info('Connected to the SQLite database via built-in node:sqlite module successfully!');

    if (!dbExists) {
        try {
            fs.chmodSync(dbPath, 0o666);
            logger.info('Database file permissions set to 0666 (Read/Write for all processes).');
        } catch (chmodErr) {
            logger.warn(`Failed to set database file permissions: ${chmodErr.message}`);
        }
    }
    initDb();
} catch (nodeSqliteErr) {
    logger.warn(`node:sqlite not supported or failed: ${nodeSqliteErr.message}. Falling back to sqlite3 package...`);

    try {
        const sqlite3 = require('sqlite3').verbose();
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                logger.error(`Database connection error via sqlite3: ${err.message}`);
            } else {
                logger.info('Connected to the SQLite database via sqlite3 package.');
                if (!dbExists) {
                    try {
                        fs.chmodSync(dbPath, 0o666);
                    } catch (e) { }
                }
                initDb();
            }
        });
    } catch (sqlite3Err) {
        logger.error(`CRITICAL: sqlite3 native driver also failed: ${sqlite3Err.message}. Initializing safe mock DB...`);

        db = {
            serialize: (cb) => { if (typeof cb === 'function') cb(); },
            run: (query, params, cb) => {
                const callback = typeof params === 'function' ? params : cb;
                if (typeof callback === 'function') callback(null);
            },
            get: (query, params, cb) => {
                const callback = typeof params === 'function' ? params : cb;
                if (typeof callback === 'function') callback(null, null);
            },
            all: (query, params, cb) => {
                const callback = typeof params === 'function' ? params : cb;
                if (typeof callback === 'function') callback(null, []);
            }
        };
    }
}

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
