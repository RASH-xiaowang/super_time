#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <bcrypt.h>

#include <cstdio>
#include <cstring>
#include <cwchar>

#include "../third_party/sqlite/sqlite3.h"

#include "queue_store.h"

#pragma comment(lib, "bcrypt.lib")

namespace feather::queue {
namespace {

sqlite3* g_db = nullptr;
SRWLOCK g_db_lock = SRWLOCK_INIT;

class DbLock {
public:
    DbLock() { AcquireSRWLockExclusive(&g_db_lock); }
    ~DbLock() { ReleaseSRWLockExclusive(&g_db_lock); }
    DbLock(const DbLock&) = delete;
    DbLock& operator=(const DbLock&) = delete;
};

// delivery_attempted is 0 from enqueue until mark_delivery_attempted commits.
// Once 1, a crash must fail the row rather than risk sending it twice.
constexpr const char* kSchema =
    "CREATE TABLE IF NOT EXISTS jobs ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " api_id TEXT NOT NULL UNIQUE,"
    " type TEXT NOT NULL,"
    " source TEXT NOT NULL,"
    " target TEXT NOT NULL,"
    " message TEXT NOT NULL DEFAULT '',"
    " mention TEXT NOT NULL DEFAULT '',"
    " mention_newline INTEGER NOT NULL DEFAULT 0,"
    " attachments TEXT NOT NULL DEFAULT '',"
    " state TEXT NOT NULL,"
    " created_at INTEGER NOT NULL,"
    " finished_at INTEGER NOT NULL DEFAULT 0,"
    " content_verified INTEGER NOT NULL DEFAULT 0,"
    " sent_count INTEGER NOT NULL DEFAULT 0,"
    " error INTEGER NOT NULL DEFAULT 0,"
    " delivery_attempted INTEGER NOT NULL DEFAULT 0);";

constexpr const char* kMigrateMentionNewline =
    "ALTER TABLE jobs ADD COLUMN mention_newline INTEGER NOT NULL DEFAULT 0;";

constexpr const char* kMigrateDeliveryAttempted =
    "ALTER TABLE jobs ADD COLUMN delivery_attempted INTEGER NOT NULL DEFAULT 0;";

// Legacy running rows predate intent tracking. Their remote state is unknown,
// so the one-time migration treats them as attempted to prevent duplicate send.
constexpr const char* kBackfillLegacyRunningAttempted =
    "UPDATE jobs SET delivery_attempted = 1 WHERE state = 'running';";

constexpr const char* kTrimFinished =
    "DELETE FROM jobs WHERE state IN ('succeeded','failed') AND id <"
    " (SELECT COALESCE((SELECT id FROM jobs WHERE state IN ('succeeded','failed')"
    " ORDER BY id DESC LIMIT 1 OFFSET 49), 0));";

constexpr const char* kRecoverUnattempted =
    "UPDATE jobs SET state = 'queued', finished_at = 0, error = 0"
    " WHERE state = 'running' AND delivery_attempted = 0;";

constexpr const char* kRecoverAttempted =
    "UPDATE jobs SET state = 'failed', finished_at = ?1, error = ?2"
    " WHERE state = 'running' AND delivery_attempted = 1;";

constexpr const char* kCountActive =
    "SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running');";

constexpr const char* kInsert =
    "INSERT INTO jobs (api_id, type, source, target, message, mention,"
    " mention_newline, attachments, state, created_at) VALUES"
    " (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'queued', ?9);";

constexpr const char* kClaimSelect =
    "SELECT id, api_id, type, source, target, message, mention,"
    " mention_newline, attachments, state, created_at, finished_at,"
    " content_verified, sent_count, error, delivery_attempted FROM jobs"
    " WHERE state = 'queued' ORDER BY id ASC LIMIT 1;";

constexpr const char* kClaimUpdate =
    "UPDATE jobs SET state = 'running'"
    " WHERE id = ?1 AND state = 'queued';";

constexpr const char* kDeliveryState =
    "SELECT state, delivery_attempted FROM jobs WHERE api_id = ?1;";

constexpr const char* kMarkDeliveryAttempted =
    "UPDATE jobs SET delivery_attempted = 1"
    " WHERE api_id = ?1 AND state = 'running' AND delivery_attempted = 0;";

constexpr const char* kComplete =
    "UPDATE jobs SET state = ?2, finished_at = ?3, content_verified = ?4,"
    " sent_count = ?5, error = ?6"
    " WHERE api_id = ?1 AND state = 'running'"
    " AND (?2 = 'failed' OR type = 'search' OR delivery_attempted = 1);";

constexpr const char* kFind =
    "SELECT id, api_id, type, source, target, message, mention,"
    " mention_newline, attachments, state, created_at, finished_at,"
    " content_verified, sent_count, error, delivery_attempted"
    " FROM jobs WHERE api_id = ?1;";

constexpr const char* kRequeue =
    "UPDATE jobs SET state = 'queued', finished_at = 0, error = 0"
    " WHERE api_id = ?1 AND state = 'running' AND delivery_attempted = 0;";

// ?1 matches the legacy "<id>.bin" spool path, ?2 the "<id>\<name>" link.
constexpr const char* kReferencesAttachment =
    "SELECT 1 FROM jobs WHERE attachments LIKE ?1 OR attachments LIKE ?2"
    " LIMIT 1;";

constexpr const char* kView =
    "SELECT id, api_id, type, source, target, message, mention,"
    " mention_newline, attachments, state, created_at, finished_at,"
    " content_verified, sent_count, error, delivery_attempted"
    " FROM jobs ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1"
    " ELSE 2 END, CASE WHEN state IN ('running','queued') THEN id ELSE -id END"
    " LIMIT ?1;";

constexpr const char* kStats =
    "SELECT state, COUNT(*) FROM jobs GROUP BY state;";

long long now_unix() {
    FILETIME now{};
    GetSystemTimeAsFileTime(&now);
    ULARGE_INTEGER value{};
    value.LowPart = now.dwLowDateTime;
    value.HighPart = now.dwHighDateTime;
    return static_cast<long long>(
        (value.QuadPart - 116444736000000000ULL) / 10000000ULL);
}

bool to_utf8(const wchar_t* wide, char* out, size_t capacity) {
    out[0] = 0;
    const int needed = WideCharToMultiByte(CP_UTF8, 0, wide, -1, out,
                                           static_cast<int>(capacity),
                                           nullptr, nullptr);
    return needed > 0;
}

void copy_wide(const wchar_t* source, wchar_t* out, size_t capacity) {
    if (!source) {
        out[0] = L'\0';
        return;
    }
    wcsncpy_s(out, capacity, source, _TRUNCATE);
}

void copy_narrow(const char* source, wchar_t* out, size_t capacity) {
    out[0] = L'\0';
    if (!source) {
        return;
    }
    size_t index = 0;
    for (; index + 1 < capacity && source[index] != 0; ++index) {
        out[index] = static_cast<wchar_t>(
            static_cast<unsigned char>(source[index]));
    }
    out[index] = L'\0';
}

JobType type_from_name(const char* name) {
    if (name && strcmp(name, "search") == 0) {
        return JobType::Search;
    }
    if (name && strcmp(name, "attachments") == 0) {
        return JobType::Attachments;
    }
    return JobType::Message;
}

JobState state_from_name(const wchar_t* name) {
    if (!name) {
        return JobState::Queued;
    }
    if (wcscmp(name, L"running") == 0) {
        return JobState::Running;
    }
    if (wcscmp(name, L"succeeded") == 0) {
        return JobState::Succeeded;
    }
    if (wcscmp(name, L"failed") == 0) {
        return JobState::Failed;
    }
    return JobState::Queued;
}

bool make_api_id(char* id) {
    unsigned char bytes[kApiIdLength / 2]{};
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
        id[0] = 0;
        return false;
    }
    const char* hex = "0123456789abcdef";
    for (int index = 0; index < kApiIdLength / 2; ++index) {
        id[index * 2] = hex[bytes[index] >> 4];
        id[index * 2 + 1] = hex[bytes[index] & 0x0F];
    }
    id[kApiIdLength] = 0;
    return true;
}

bool bind_wide(sqlite3_stmt* stmt, int index, const wchar_t* value) {
    return sqlite3_bind_text16(stmt, index, value, -1,
                               SQLITE_TRANSIENT) == SQLITE_OK;
}

bool bind_narrow(sqlite3_stmt* stmt, int index, const char* value) {
    wchar_t wide[64]{};
    copy_narrow(value, wide, ARRAYSIZE(wide));
    return bind_wide(stmt, index, wide);
}

void read_text_column(sqlite3_stmt* stmt, int column, wchar_t* out,
                      size_t capacity) {
    const auto* text = static_cast<const wchar_t*>(
        sqlite3_column_text16(stmt, column));
    copy_wide(text, out, capacity);
}

void read_row(sqlite3_stmt* stmt, Job* job) {
    ZeroMemory(job, sizeof(Job));
    job->row_id = sqlite3_column_int64(stmt, 0);
    const auto* api_id = reinterpret_cast<const char*>(
        sqlite3_column_text(stmt, 1));
    if (api_id) {
        strncpy_s(job->api_id, ARRAYSIZE(job->api_id), api_id, _TRUNCATE);
    }
    const auto* type = reinterpret_cast<const char*>(
        sqlite3_column_text(stmt, 2));
    job->type = type_from_name(type);
    read_text_column(stmt, 3, job->source, ARRAYSIZE(job->source));
    read_text_column(stmt, 4, job->target, ARRAYSIZE(job->target));
    read_text_column(stmt, 5, job->message, ARRAYSIZE(job->message));
    read_text_column(stmt, 6, job->mention, ARRAYSIZE(job->mention));
    job->mention_newline = sqlite3_column_int(stmt, 7) != 0;
    read_text_column(stmt, 8, job->attachments, ARRAYSIZE(job->attachments));
    wchar_t state[16]{};
    read_text_column(stmt, 9, state, ARRAYSIZE(state));
    job->state = state_from_name(state);
    job->created_at = sqlite3_column_int64(stmt, 10);
    job->finished_at = sqlite3_column_int64(stmt, 11);
    job->content_verified = sqlite3_column_int(stmt, 12) != 0;
    job->sent_count = sqlite3_column_int(stmt, 13);
    job->error = static_cast<DWORD>(sqlite3_column_int64(stmt, 14));
    job->delivery_attempted = sqlite3_column_int(stmt, 15) != 0;
}

bool exec_simple(const char* sql, DWORD* error) {
    char* message = nullptr;
    const int rc = sqlite3_exec(g_db, sql, nullptr, nullptr, &message);
    if (message) {
        sqlite3_free(message);
    }
    if (rc != SQLITE_OK) {
        if (error) {
            *error = static_cast<DWORD>(rc);
        }
        return false;
    }
    return true;
}

void set_error(DWORD* error, DWORD value) {
    if (error) {
        *error = value;
    }
}

DWORD sqlite_failure_code() {
    return g_db ? static_cast<DWORD>(sqlite3_errcode(g_db))
                : ERROR_INVALID_STATE;
}

bool begin_transaction(DWORD* error) {
    return exec_simple("BEGIN IMMEDIATE;", error);
}

bool commit_transaction(DWORD* error) {
    return exec_simple("COMMIT;", error);
}

void rollback_transaction() {
    if (g_db) {
        sqlite3_exec(g_db, "ROLLBACK;", nullptr, nullptr, nullptr);
    }
}

bool table_has_column(const char* column, bool* present, DWORD* error) {
    *present = false;
    sqlite3_stmt* stmt = nullptr;
    const int prepared = sqlite3_prepare_v2(
        g_db, "PRAGMA table_info(jobs);", -1, &stmt, nullptr);
    if (prepared != SQLITE_OK) {
        set_error(error, static_cast<DWORD>(prepared));
        return false;
    }
    int rc = SQLITE_OK;
    while ((rc = sqlite3_step(stmt)) == SQLITE_ROW) {
        const char* name = reinterpret_cast<const char*>(
            sqlite3_column_text(stmt, 1));
        if (name && strcmp(name, column) == 0) {
            *present = true;
        }
    }
    sqlite3_finalize(stmt);
    if (rc != SQLITE_DONE) {
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    return true;
}

bool recover_running_jobs(int* recovered, DWORD* error) {
    DWORD failure = ERROR_SUCCESS;
    if (!begin_transaction(&failure)) {
        set_error(error, failure);
        return false;
    }

    sqlite3_stmt* attempted = nullptr;
    int rc = sqlite3_prepare_v2(g_db, kRecoverAttempted, -1,
                                &attempted, nullptr);
    if (rc == SQLITE_OK) {
        rc = sqlite3_bind_int64(attempted, 1, now_unix());
    }
    if (rc == SQLITE_OK) {
        rc = sqlite3_bind_int64(
            attempted, 2, static_cast<long long>(ERROR_PROCESS_ABORTED));
    }
    if (rc == SQLITE_OK) {
        rc = sqlite3_step(attempted);
    }
    const int attempted_rc = rc;
    if (attempted) {
        sqlite3_finalize(attempted);
    }
    if (attempted_rc != SQLITE_DONE) {
        failure = attempted_rc == SQLITE_OK
            ? sqlite_failure_code()
            : static_cast<DWORD>(attempted_rc);
        rollback_transaction();
        set_error(error, failure);
        return false;
    }

    sqlite3_stmt* requeue = nullptr;
    rc = sqlite3_prepare_v2(g_db, kRecoverUnattempted, -1,
                            &requeue, nullptr);
    if (rc == SQLITE_OK) {
        rc = sqlite3_step(requeue);
    }
    const int requeue_rc = rc;
    const int requeued = requeue_rc == SQLITE_DONE
        ? sqlite3_changes(g_db)
        : 0;
    if (requeue) {
        sqlite3_finalize(requeue);
    }
    if (requeue_rc != SQLITE_DONE) {
        failure = requeue_rc == SQLITE_OK
            ? sqlite_failure_code()
            : static_cast<DWORD>(requeue_rc);
        rollback_transaction();
        set_error(error, failure);
        return false;
    }

    if (!commit_transaction(&failure)) {
        rollback_transaction();
        set_error(error, failure);
        return false;
    }
    if (recovered) {
        *recovered = requeued;
    }
    return true;
}

} // namespace

const char* type_name(JobType type) {
    switch (type) {
    case JobType::Search: return "search";
    case JobType::Attachments: return "attachments";
    default: return "message";
    }
}

const char* state_name(JobState state) {
    switch (state) {
    case JobState::Running: return "running";
    case JobState::Succeeded: return "succeeded";
    case JobState::Failed: return "failed";
    default: return "queued";
    }
}

bool open(const wchar_t* db_path, int* recovered, DWORD* error) {
    DbLock lock;
    if (error) {
        *error = ERROR_SUCCESS;
    }
    if (recovered) {
        *recovered = 0;
    }
    if (g_db) {
        return true;
    }
    char path[MAX_PATH * 4]{};
    if (!to_utf8(db_path, path, ARRAYSIZE(path))) {
        if (error) {
            *error = ERROR_INVALID_PARAMETER;
        }
        return false;
    }
    sqlite3* db = nullptr;
    int rc = sqlite3_open_v2(path, &db,
                             SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
                                 | SQLITE_OPEN_FULLMUTEX,
                             nullptr);
    if (rc != SQLITE_OK || !db) {
        if (error) {
            *error = static_cast<DWORD>(rc);
        }
        if (db) {
            sqlite3_close(db);
        }
        return false;
    }
    g_db = db;
    sqlite3_busy_timeout(g_db, 3000);
    if (!exec_simple(kSchema, error)) {
        sqlite3_close(g_db);
        g_db = nullptr;
        return false;
    }

    // Migrations are additive and idempotent. Existing databases are probed
    // through PRAGMA before ALTER TABLE so old installations keep their rows.
    bool has_mention_newline = false;
    DWORD migration_error = ERROR_SUCCESS;
    if (!table_has_column("mention_newline", &has_mention_newline,
                          &migration_error)) {
        set_error(error, migration_error);
        sqlite3_close(g_db);
        g_db = nullptr;
        return false;
    }
    if (!has_mention_newline
        && !exec_simple(kMigrateMentionNewline, &migration_error)) {
        set_error(error, migration_error);
        sqlite3_close(g_db);
        g_db = nullptr;
        return false;
    }

    bool has_delivery_attempted = false;
    if (!table_has_column("delivery_attempted", &has_delivery_attempted,
                          &migration_error)) {
        set_error(error, migration_error);
        sqlite3_close(g_db);
        g_db = nullptr;
        return false;
    }
    if (!has_delivery_attempted) {
        bool migrated = begin_transaction(&migration_error);
        if (migrated) {
            migrated = exec_simple(kMigrateDeliveryAttempted,
                                   &migration_error);
        }
        if (migrated) {
            migrated = exec_simple(kBackfillLegacyRunningAttempted,
                                   &migration_error);
        }
        if (migrated) {
            migrated = commit_transaction(&migration_error);
        }
        if (!migrated) {
            rollback_transaction();
            set_error(error, migration_error);
            sqlite3_close(g_db);
            g_db = nullptr;
            return false;
        }
    }

    // Trim old history first so newly recovered failure rows remain visible.
    exec_simple(kTrimFinished, nullptr);

    // Recovery is one transaction: unattempted work is safe to retry, while
    // attempted work is never replayed because the remote side may have seen it.
    int requeued = 0;
    if (!recover_running_jobs(&requeued, &migration_error)) {
        set_error(error, migration_error);
        sqlite3_close(g_db);
        g_db = nullptr;
        return false;
    }
    if (recovered) {
        *recovered = requeued;
    }
    return true;
}

void close() {
    DbLock lock;
    if (g_db) {
        sqlite3_close(g_db);
        g_db = nullptr;
    }
}

bool enqueue(const Job& input, Job* stored, DWORD* error) {
    DbLock lock;
    if (error) {
        *error = ERROR_SUCCESS;
    }
    if (!g_db || !stored) {
        if (error) {
            *error = ERROR_INVALID_STATE;
        }
        return false;
    }

    DWORD transaction_error = ERROR_SUCCESS;
    if (!begin_transaction(&transaction_error)) {
        set_error(error, transaction_error);
        return false;
    }
    auto fail = [&](DWORD code) {
        rollback_transaction();
        set_error(error, code == ERROR_SUCCESS ? ERROR_WRITE_FAULT : code);
        return false;
    };

    int active = 0;
    sqlite3_stmt* counter = nullptr;
    int rc = sqlite3_prepare_v2(g_db, kCountActive, -1, &counter, nullptr);
    if (rc != SQLITE_OK) {
        return fail(static_cast<DWORD>(rc));
    }
    rc = sqlite3_step(counter);
    if (rc != SQLITE_ROW) {
        const DWORD code = rc == SQLITE_DONE
            ? ERROR_WRITE_FAULT
            : static_cast<DWORD>(rc);
        sqlite3_finalize(counter);
        return fail(code);
    }
    active = sqlite3_column_int(counter, 0);
    rc = sqlite3_finalize(counter);
    if (rc != SQLITE_OK) {
        return fail(static_cast<DWORD>(rc));
    }
    if (active >= kMaxPendingJobs) {
        rollback_transaction();
        if (error) {
            *error = ERROR_NOT_ENOUGH_QUOTA;
        }
        return false;
    }

    const long long created = now_unix();
    DWORD last_error = ERROR_WRITE_FAULT;
    for (int attempt = 0; attempt < 4; ++attempt) {
        Job candidate = input;
        if (!make_api_id(candidate.api_id)) {
            return fail(ERROR_GEN_FAILURE);
        }
        candidate.state = JobState::Queued;
        candidate.created_at = created;
        candidate.finished_at = 0;
        candidate.content_verified = false;
        candidate.sent_count = 0;
        candidate.error = ERROR_SUCCESS;
        candidate.delivery_attempted = false;

        sqlite3_stmt* insert = nullptr;
        rc = sqlite3_prepare_v2(g_db, kInsert, -1, &insert, nullptr);
        if (rc != SQLITE_OK) {
            return fail(static_cast<DWORD>(rc));
        }
        const bool bound =
            bind_narrow(insert, 1, candidate.api_id)
            && sqlite3_bind_text(insert, 2, type_name(candidate.type), -1,
                                 SQLITE_TRANSIENT) == SQLITE_OK
            && bind_wide(insert, 3, candidate.source)
            && bind_wide(insert, 4, candidate.target)
            && bind_wide(insert, 5, candidate.message)
            && bind_wide(insert, 6, candidate.mention)
            && sqlite3_bind_int(insert, 7,
                                candidate.mention_newline ? 1 : 0) == SQLITE_OK
            && bind_wide(insert, 8, candidate.attachments)
            && sqlite3_bind_int64(insert, 9, created) == SQLITE_OK;
        if (!bound) {
            sqlite3_finalize(insert);
            return fail(ERROR_WRITE_FAULT);
        }

        rc = sqlite3_step(insert);
        const int code = sqlite3_errcode(g_db);
        sqlite3_finalize(insert);
        if (rc == SQLITE_DONE) {
            candidate.row_id = sqlite3_last_insert_rowid(g_db);
            DWORD commit_error = ERROR_SUCCESS;
            if (!commit_transaction(&commit_error)) {
                return fail(commit_error);
            }
            *stored = candidate;
            return true;
        }
        last_error = static_cast<DWORD>(code);
        if (code != SQLITE_CONSTRAINT) {
            return fail(last_error);
        }
    }
    return fail(last_error);
}

bool claim_next(Job* out, DWORD* error) {
    if (error) {
        *error = ERROR_SUCCESS;
    }
    DbLock lock;
    if (!out) {
        set_error(error, ERROR_INVALID_PARAMETER);
        return false;
    }
    if (!g_db) {
        set_error(error, ERROR_INVALID_STATE);
        return false;
    }
    DWORD transaction_error = ERROR_SUCCESS;
    if (!begin_transaction(&transaction_error)) {
        set_error(error, transaction_error ? transaction_error
                                           : ERROR_INVALID_STATE);
        return false;
    }

    sqlite3_stmt* select = nullptr;
    int rc = sqlite3_prepare_v2(g_db, kClaimSelect, -1, &select, nullptr);
    if (rc != SQLITE_OK) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    bool found = false;
    long long row_id = 0;
    rc = sqlite3_step(select);
    if (rc == SQLITE_ROW) {
        read_row(select, out);
        row_id = out->row_id;
        found = true;
    }
    const int finalize_select = sqlite3_finalize(select);
    if (!found) {
        rollback_transaction();
        set_error(error, rc == SQLITE_DONE && finalize_select == SQLITE_OK
            ? ERROR_NOT_FOUND
            : static_cast<DWORD>(rc != SQLITE_DONE ? rc : finalize_select));
        return false;
    }
    if (finalize_select != SQLITE_OK) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(finalize_select));
        return false;
    }

    sqlite3_stmt* update = nullptr;
    rc = sqlite3_prepare_v2(g_db, kClaimUpdate, -1, &update, nullptr);
    if (rc != SQLITE_OK) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    rc = sqlite3_bind_int64(update, 1, row_id);
    if (rc != SQLITE_OK) {
        sqlite3_finalize(update);
        rollback_transaction();
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    rc = sqlite3_step(update);
    const int changed = rc == SQLITE_DONE ? sqlite3_changes(g_db) : 0;
    const int finalize_update = sqlite3_finalize(update);
    if (rc != SQLITE_DONE) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    if (finalize_update != SQLITE_OK) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(finalize_update));
        return false;
    }
    if (changed != 1) {
        rollback_transaction();
        set_error(error, ERROR_INVALID_STATE);
        return false;
    }
    DWORD commit_error = ERROR_SUCCESS;
    if (!commit_transaction(&commit_error)) {
        rollback_transaction();
        set_error(error, commit_error ? commit_error : ERROR_INVALID_STATE);
        return false;
    }
    out->state = JobState::Running;
    set_error(error, ERROR_SUCCESS);
    return true;
}

bool mark_delivery_attempted(const char* api_id, DWORD* error) {
    DbLock lock;
    if (error) {
        *error = ERROR_SUCCESS;
    }
    if (!api_id || !api_id[0]) {
        set_error(error, ERROR_INVALID_PARAMETER);
        return false;
    }
    if (!g_db) {
        set_error(error, ERROR_INVALID_STATE);
        return false;
    }

    DWORD failure = ERROR_SUCCESS;
    if (!begin_transaction(&failure)) {
        set_error(error, failure);
        return false;
    }

    sqlite3_stmt* select = nullptr;
    int rc = sqlite3_prepare_v2(g_db, kDeliveryState, -1, &select, nullptr);
    if (rc != SQLITE_OK) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    if (!bind_narrow(select, 1, api_id)) {
        sqlite3_finalize(select);
        rollback_transaction();
        set_error(error, ERROR_WRITE_FAULT);
        return false;
    }
    rc = sqlite3_step(select);
    if (rc != SQLITE_ROW) {
        sqlite3_finalize(select);
        rollback_transaction();
        set_error(error, rc == SQLITE_DONE ? ERROR_NOT_FOUND
                                           : static_cast<DWORD>(rc));
        return false;
    }

    wchar_t state[16]{};
    read_text_column(select, 0, state, ARRAYSIZE(state));
    const bool already_attempted = sqlite3_column_int(select, 1) != 0;
    sqlite3_finalize(select);
    if (wcscmp(state, L"running") != 0) {
        rollback_transaction();
        set_error(error, ERROR_INVALID_STATE);
        return false;
    }
    if (already_attempted) {
        rollback_transaction();
        set_error(error, ERROR_ALREADY_EXISTS);
        return false;
    }

    sqlite3_stmt* update = nullptr;
    rc = sqlite3_prepare_v2(g_db, kMarkDeliveryAttempted, -1,
                            &update, nullptr);
    if (rc != SQLITE_OK) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    if (!bind_narrow(update, 1, api_id)) {
        sqlite3_finalize(update);
        rollback_transaction();
        set_error(error, ERROR_WRITE_FAULT);
        return false;
    }
    rc = sqlite3_step(update);
    const int changed = rc == SQLITE_DONE ? sqlite3_changes(g_db) : 0;
    sqlite3_finalize(update);
    if (rc != SQLITE_DONE || changed != 1) {
        rollback_transaction();
        set_error(error, rc == SQLITE_DONE
            ? ERROR_INVALID_STATE
            : static_cast<DWORD>(rc));
        return false;
    }
    if (!commit_transaction(&failure)) {
        rollback_transaction();
        set_error(error, failure);
        return false;
    }
    return true;
}

bool requeue(const char* api_id, DWORD* error) {
    DbLock lock;
    if (error) {
        *error = ERROR_SUCCESS;
    }
    if (!api_id || !api_id[0]) {
        set_error(error, ERROR_INVALID_PARAMETER);
        return false;
    }
    if (!g_db) {
        set_error(error, ERROR_INVALID_STATE);
        return false;
    }

    DWORD failure = ERROR_SUCCESS;
    if (!begin_transaction(&failure)) {
        set_error(error, failure);
        return false;
    }

    sqlite3_stmt* select = nullptr;
    int rc = sqlite3_prepare_v2(g_db, kDeliveryState, -1, &select, nullptr);
    if (rc != SQLITE_OK) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    if (!bind_narrow(select, 1, api_id)) {
        sqlite3_finalize(select);
        rollback_transaction();
        set_error(error, ERROR_WRITE_FAULT);
        return false;
    }
    rc = sqlite3_step(select);
    if (rc != SQLITE_ROW) {
        sqlite3_finalize(select);
        rollback_transaction();
        set_error(error, rc == SQLITE_DONE ? ERROR_NOT_FOUND
                                           : static_cast<DWORD>(rc));
        return false;
    }

    wchar_t state[16]{};
    read_text_column(select, 0, state, ARRAYSIZE(state));
    const bool already_attempted = sqlite3_column_int(select, 1) != 0;
    sqlite3_finalize(select);
    if (wcscmp(state, L"running") != 0) {
        rollback_transaction();
        set_error(error, ERROR_INVALID_STATE);
        return false;
    }
    if (already_attempted) {
        rollback_transaction();
        set_error(error, ERROR_ALREADY_EXISTS);
        return false;
    }

    // The row keeps its id and created_at, so claim_next (oldest id first)
    // picks it up again before anything enqueued after it.
    sqlite3_stmt* update = nullptr;
    rc = sqlite3_prepare_v2(g_db, kRequeue, -1, &update, nullptr);
    if (rc != SQLITE_OK) {
        rollback_transaction();
        set_error(error, static_cast<DWORD>(rc));
        return false;
    }
    if (!bind_narrow(update, 1, api_id)) {
        sqlite3_finalize(update);
        rollback_transaction();
        set_error(error, ERROR_WRITE_FAULT);
        return false;
    }
    rc = sqlite3_step(update);
    const int changed = rc == SQLITE_DONE ? sqlite3_changes(g_db) : 0;
    sqlite3_finalize(update);
    if (rc != SQLITE_DONE || changed != 1) {
        rollback_transaction();
        set_error(error, rc == SQLITE_DONE
            ? ERROR_INVALID_STATE
            : static_cast<DWORD>(rc));
        return false;
    }
    if (!commit_transaction(&failure)) {
        rollback_transaction();
        set_error(error, failure);
        return false;
    }
    return true;
}

bool complete(const char* api_id, bool succeeded, bool content_verified,
              int sent_count, DWORD error) {
    DbLock lock;
    if (!g_db || !api_id || !api_id[0]) {
        return false;
    }
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(g_db, kComplete, -1, &stmt, nullptr) != SQLITE_OK) {
        return false;
    }
    const bool bound =
        bind_narrow(stmt, 1, api_id)
        && bind_wide(stmt, 2, succeeded ? L"succeeded" : L"failed")
        && sqlite3_bind_int64(stmt, 3, now_unix()) == SQLITE_OK
        && sqlite3_bind_int(stmt, 4, content_verified ? 1 : 0) == SQLITE_OK
        && sqlite3_bind_int(stmt, 5, sent_count) == SQLITE_OK
        && sqlite3_bind_int64(stmt, 6, static_cast<long long>(error))
            == SQLITE_OK;
    if (!bound) {
        sqlite3_finalize(stmt);
        return false;
    }
    const int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    const bool completed = rc == SQLITE_DONE && sqlite3_changes(g_db) == 1;
    if (completed) {
        // Trimmed rows stop referencing their spool resources; the spool's
        // retention window then applies to those files.
        exec_simple(kTrimFinished, nullptr);
    }
    return completed;
}

bool find(const char* api_id, Job* out) {
    DbLock lock;
    if (!g_db || !api_id || !api_id[0] || !out) {
        return false;
    }
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(g_db, kFind, -1, &stmt, nullptr) != SQLITE_OK) {
        return false;
    }
    bind_narrow(stmt, 1, api_id);
    bool found = false;
    if (sqlite3_step(stmt) == SQLITE_ROW) {
        read_row(stmt, out);
        found = true;
    }
    sqlite3_finalize(stmt);
    return found;
}

bool references_attachment(const wchar_t* resource_id) {
    DbLock lock;
    if (!resource_id || !resource_id[0]) {
        return false;
    }
    // Without the database the answer is unknown; keeping the file is safe.
    if (!g_db) {
        return true;
    }
    wchar_t legacy_pattern[80]{};
    wchar_t link_pattern[80]{};
    if (swprintf_s(legacy_pattern, ARRAYSIZE(legacy_pattern), L"%%%s.bin%%",
                   resource_id) < 0
        || swprintf_s(link_pattern, ARRAYSIZE(link_pattern), L"%%\\%s\\%%",
                      resource_id) < 0) {
        return true;
    }
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(g_db, kReferencesAttachment, -1, &stmt, nullptr)
        != SQLITE_OK) {
        return true;
    }
    if (!bind_wide(stmt, 1, legacy_pattern) || !bind_wide(stmt, 2, link_pattern)) {
        sqlite3_finalize(stmt);
        return true;
    }
    const int rc = sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    return rc != SQLITE_DONE;
}

int view(Job* rows, int capacity, Stats* stats) {
    DbLock lock;
    if (!g_db || !rows || capacity <= 0) {
        return 0;
    }
    int count = 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(g_db, kView, -1, &stmt, nullptr) == SQLITE_OK) {
        sqlite3_bind_int(stmt, 1, capacity);
        while (count < capacity && sqlite3_step(stmt) == SQLITE_ROW) {
            read_row(stmt, &rows[count]);
            ++count;
        }
        sqlite3_finalize(stmt);
    }
    if (stats) {
        ZeroMemory(stats, sizeof(Stats));
        sqlite3_stmt* counter = nullptr;
        if (sqlite3_prepare_v2(g_db, kStats, -1, &counter, nullptr)
            == SQLITE_OK) {
            while (sqlite3_step(counter) == SQLITE_ROW) {
                const auto* state = static_cast<const wchar_t*>(
                    sqlite3_column_text16(counter, 0));
                const int value = sqlite3_column_int(counter, 1);
                if (!state) {
                    continue;
                }
                if (wcscmp(state, L"queued") == 0) {
                    stats->queued = value;
                } else if (wcscmp(state, L"running") == 0) {
                    stats->running = value;
                } else if (wcscmp(state, L"succeeded") == 0) {
                    stats->succeeded = value;
                } else if (wcscmp(state, L"failed") == 0) {
                    stats->failed = value;
                }
            }
            sqlite3_finalize(counter);
        }
    }
    return count;
}

} // namespace feather::queue
