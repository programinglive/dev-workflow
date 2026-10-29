import { safeLog } from '../../security/sanitizer.js';
import pg from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import { databaseConnectionUrl } from '../../security/config.js';
import { sanitize } from '../../security/sanitizer.js';

const require = createRequire(import.meta.url);
const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Silence stdout during dotenv loading to prevent noise in API output
const originalWrite = process.stdout.write;
process.stdout.write = () => true; // No-op

try {
    // Try web/.env
    dotenv.config({ path: path.join(__dirname, '../.env') });
    // Try root .env
    dotenv.config({ path: path.join(__dirname, '../../.env') });
} catch (e) {
    // dotenv might not be available
} finally {
    // Restore stdout
    process.stdout.write = originalWrite;
}

const connectionString = databaseConnectionUrl();
const rawSid = process.argv[2]; // Passed from API

// DEBUG: output connection details to stderr (so it doesn't break JSON on stdout)
try {
    const urlStr = connectionString.startsWith('postgres') ? connectionString : `postgres://${connectionString}`; // handle simpler strings if needed
    // Simple heuristic parsing or URL object
    const u = new URL(urlStr);
    safeLog('error', `DEBUG: Connecting to Host: ${u.hostname}, Port: ${u.port}, User: ${u.username}`);
} catch (err) {
    safeLog('error', 'DEBUG: Could not parse connection string for logging');
}

if (!connectionString) {
    // Should be unreachable with defaultUrl, but good for safety
    safeLog('error', JSON.stringify({ error: 'Database configuration missing' }));
    process.exit(1);
}

const pool = new Pool({ connectionString });

async function run() {
    try {
        let userId = null;

        // 1. Validate Session if provided
        if (rawSid) {
            // Parse 's:session_id.signature' -> 'session_id'
            // Simplified logic: between 's:' and '.'
            let sid = rawSid;
            if (rawSid.startsWith('s:')) {
                sid = rawSid.slice(2, rawSid.lastIndexOf('.'));
            } else if (rawSid.includes('.')) {
                // heuristic for signed cookie without s: prefix? 
                sid = rawSid.slice(0, rawSid.lastIndexOf('.'));
            }

            // Try lookup
            const sessionRes = await pool.query("SELECT sess FROM session WHERE sid = $1", [sid]);
            if (sessionRes.rows.length > 0) {
                const sessionData = sessionRes.rows[0].sess;
                if (sessionData && sessionData.userId) {
                    userId = sessionData.userId;
                }
            }
        }

        if(!userId) throw new Error('Authenticated session required; automatic admin fallback is denied');

        // 3. (Self-healing removed as it was causing schema errors)

        const result = await pool.query(`
            SELECT 
                classification,
                id, 
                task_type, 
                description, 
                commit_message, 
                completed_at, 
                tests_passed, 
                documentation_type 
            FROM workflow_history 
            WHERE user_id = $1
            ORDER BY completed_at DESC LIMIT 100
        `, [userId]);

        console.log(JSON.stringify(sanitize({ history: result.rows })));

    } catch (error) {
        safeLog('error', JSON.stringify({ error: error.message, stack: error.stack }));
        process.exit(1);
    } finally {
        await pool.end();
    }
}

run();
