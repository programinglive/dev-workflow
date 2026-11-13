import { assertSafeKnowledge } from '../../security/policy.js';
import { securityOutputFilter } from '../../security/sanitizer.js';

/**
 * Nilai `task_type` yang selalu boleh masuk kolom NOT NULL.
 *
 * MENGAPA ADA
 * -----------
 * Kolom `workflow_history.task_type` adalah NOT NULL, tetapi entri history
 * yang lebih tua tidak selalu punya nilainya: penanda `dropped` versi lama
 * ditulis tanpa `taskType` sama sekali, dan sebagian entri `forced` menyimpan
 * string kosong. Saat `undefined` di-bind, driver mengubahnya menjadi NULL dan
 * SQLite menolak dengan `NOT NULL constraint failed: workflow_history.task_type`.
 *
 * Dulu kegagalan itu membatalkan seluruh `syncToDatabase()`: ringkasan proyek
 * dan state workflow ikut tidak pernah ditulis, jadi riwayat proyek diam-diam
 * berhenti tersimpan. Normalisasi di sini membuat data lama tetap dapat
 * disinkronkan tanpa menebak isi aslinya.
 */
export function normalizeTaskType(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'other';
}

export class DbAdapter {
    constructor(config = {}) {
        this.config = config;
        // Guard direct adapter use as well as the db/index facade.
        for (const name of ['insertHistoryEntry','saveState','updateSummaryForUser']) {
            const operation=this[name].bind(this);
            this[name]=async(...args)=>{assertSafeKnowledge(args);return operation(...args);};
        }
        for (const name of ['getState','getHistoryForUser','getSummaryForUser','getHistorySummary']) {
            const operation=this[name].bind(this);
            this[name]=async(...args)=>securityOutputFilter(await operation(...args));
        }
    }

    async connect() {
        throw new Error("connect() must be implemented by subclass");
    }

    async migrate() {
        throw new Error("migrate() must be implemented by subclass");
    }

    /**
     * @param {string} userId - User identifier
     * @param {string} projectPath - Path/ID of the project
     * @param {Object} entry - Workflow history entry
     */
    async insertHistoryEntry(userId, projectPath, entry) {
        throw new Error("insertHistoryEntry() must be implemented by subclass");
    }

    async updateSummaryForUser(userId, projectPath) {
        throw new Error("updateSummaryForUser() must be implemented by subclass");
    }

    async getSummaryForUser(userId, projectPath) {
        throw new Error("getSummaryForUser() must be implemented by subclass");
    }

    async getHistoryForUser(userId, projectPath, options = {}) {
        throw new Error("getHistoryForUser() must be implemented by subclass");
    }

    async getHistorySummary(userId, projectPath, options = {}) {
        throw new Error("getHistorySummary() must be implemented by subclass");
    }

    async saveState(userId, projectPath, state) {
        throw new Error("saveState() must be implemented by subclass");
    }

    async getState(userId, projectPath) {
        throw new Error("getState() must be implemented by subclass");
    }
}
