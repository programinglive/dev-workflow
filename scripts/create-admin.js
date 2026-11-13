#!/usr/bin/env node
import { safeLog } from '../security/sanitizer.js';
import 'dotenv/config';
import pg from 'pg';
import { createUser } from '../web/lib/auth.js';
import { databaseConnectionUrl } from '../security/config.js';

const { Pool } = pg;

// Get database configuration from environment
const dbUrl = databaseConnectionUrl();

if (!dbUrl) {
    safeLog('error', 'Error: DEV_WORKFLOW_DB_URL environment variable is not set');
    process.exit(1);
}

const pool = new Pool({ connectionString: dbUrl });

async function createAdminUser() {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD;
    if(!password || password.length<16) throw new Error('Provision ADMIN_PASSWORD privately with at least 16 characters');
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';

    try {
        // Check if admin user already exists
        const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);

        if (existing.rows.length > 0) {
            safeLog('info', `✓ Admin user '${username}' already exists`);
            process.exit(0);
        }

        // Create admin user
        const user = await createUser(pool, username, password, email);
        safeLog('info', `✓ Created admin user: ${user.username}`);
        safeLog('info', `  Email: ${user.email}`);
        safeLog('info','Administrator created; credential value omitted');

    } catch (error) {
        safeLog('error', 'Error creating admin user:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

createAdminUser();
