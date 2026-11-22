#include <windows.h>

#include <cstdio>
#include <cstring>
#include <cwchar>

#include "../src/queue_store.h"
#include "../third_party/sqlite/sqlite3.h"

namespace queue = feather::queue;

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const char* label, DWORD error = ERROR_SUCCESS) {
    ++g_checks;
    if (condition) {
        std::printf("PASS %s\n", label);
        return;
    }
    ++g_failures;
    std::printf("FAIL %s (error=%lu)\n", label,
                static_cast<unsigned long>(error));
}

void remove_database_files(const wchar_t* path) {
    DeleteFileW(path);
    wchar_t sidecar[MAX_PATH * 2]{};
    swprintf_s(sidecar, L"%s-wal", path);
    DeleteFileW(sidecar);
    swprintf_s(sidecar, L"%s-shm", path);
    DeleteFileW(sidecar);
}

queue::Job make_job(const wchar_t* target, const wchar_t* message,
                    queue::JobType type = queue::JobType::Message) {
    queue::Job job{};
    job.type = type;
    wcscpy_s(job.source, L"test");
    wcsncpy_s(job.target, target, _TRUNCATE);
    if (message) {
        wcsncpy_s(job.message, message, _TRUNCATE);
    }
    return job;
}

queue::Job enqueue_job(const wchar_t* target, const wchar_t* message,
                       queue::JobType type = queue::JobType::Message) {
    queue::Job stored{};
    DWORD error = ERROR_SUCCESS;
    const queue::Job input = make_job(target, message, type);
    check(queue::enqueue(input, &stored, &error), "enqueue job", error);
    return stored;
}

bool is_lower_hex_api_id(const char* api_id) {
    if (strlen(api_id) != static_cast<size_t>(queue::kApiIdLength)) {
        return false;
    }
    for (const char* p = api_id; *p; ++p) {
        if (!((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'f'))) {
            return false;
        }
    }
    return true;
}

bool to_utf8(const wchar_t* source, char* output, size_t capacity) {
    return WideCharToMultiByte(CP_UTF8, 0, source, -1, output,
                               static_cast<int>(capacity), nullptr,
                               nullptr) > 0;
}

bool exec_on_closed_database(const wchar_t* path, const char* sql) {
    char utf8_path[MAX_PATH * 4]{};
    if (!to_utf8(path, utf8_path, ARRAYSIZE(utf8_path))) {
        return false;
    }

    sqlite3* database = nullptr;
    if (sqlite3_open_v2(utf8_path, &database, SQLITE_OPEN_READWRITE, nullptr)
        != SQLITE_OK) {
        if (database) {
            sqlite3_close(database);
        }
        return false;
    }
    char* sqlite_error = nullptr;
    const int rc = sqlite3_exec(database, sql, nullptr, nullptr,
                                &sqlite_error);
    if (sqlite_error) {
        std::printf("sql_error=%s\n", sqlite_error);
        sqlite3_free(sqlite_error);
    }
    sqlite3_close(database);
    return rc == SQLITE_OK;
}

bool create_legacy_database(const wchar_t* path) {
    char utf8_path[MAX_PATH * 4]{};
    if (!to_utf8(path, utf8_path, ARRAYSIZE(utf8_path))) {
        return false;
    }

    sqlite3* database = nullptr;
    if (sqlite3_open_v2(utf8_path, &database,
                        SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr)
        != SQLITE_OK) {
        if (database) {
            sqlite3_close(database);
        }
        return false;
    }

    const char* sql =
        "CREATE TABLE jobs ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " api_id TEXT NOT NULL UNIQUE,"
        " type TEXT NOT NULL,"
        " source TEXT NOT NULL,"
        " target TEXT NOT NULL,"
        " message TEXT NOT NULL DEFAULT '',"
        " mention TEXT NOT NULL DEFAULT '',"
        " attachments TEXT NOT NULL DEFAULT '',"
        " state TEXT NOT NULL,"
        " created_at INTEGER NOT NULL,"
        " finished_at INTEGER NOT NULL DEFAULT 0,"
        " content_verified INTEGER NOT NULL DEFAULT 0,"
        " sent_count INTEGER NOT NULL DEFAULT 0,"
        " error INTEGER NOT NULL DEFAULT 0);"
        "INSERT INTO jobs"
        " (api_id,type,source,target,message,mention,attachments,state,"
        "  created_at,finished_at,content_verified,sent_count,error)"
        " VALUES"
        " ('legacy-running','message','api','legacy-target','hello','','',"
        "  'running',1,0,0,0,0),"
        " ('legacy-queued','message','api','legacy-target','later','','',"
        "  'queued',2,0,0,0,0);";
    char* sqlite_error = nullptr;
    const int rc = sqlite3_exec(database, sql, nullptr, nullptr,
                                &sqlite_error);
    if (sqlite_error) {
        std::printf("legacy_sql_error=%s\n", sqlite_error);
        sqlite3_free(sqlite_error);
    }
    sqlite3_close(database);
    return rc == SQLITE_OK;
}

void test_new_database_recovery(const wchar_t* path) {
    DWORD error = ERROR_SUCCESS;
    int recovered = -1;
    check(queue::open(path, &recovered, &error), "open new database", error);
    check(recovered == 0, "new database has nothing to recover", error);

    const queue::Job stored = enqueue_job(L"new-target", L"new-message");
    check(!stored.delivery_attempted, "new job starts unattempted");
    check(is_lower_hex_api_id(stored.api_id),
          "api_id is 16 lowercase hexadecimal characters");

    queue::Job claimed{};
    check(queue::claim_next(&claimed), "claim unattempted job");
    check(!claimed.delivery_attempted, "claimed job is unattempted");
    queue::close();

    recovered = -1;
    check(queue::open(path, &recovered, &error),
          "reopen database after unattempted crash", error);
    check(recovered == 1, "unattempted running job is requeued", error);

    queue::Job recovered_job{};
    check(queue::find(stored.api_id, &recovered_job),
          "find requeued job");
    check(recovered_job.state == queue::JobState::Queued,
          "requeued job state is queued");
    check(!recovered_job.delivery_attempted,
          "requeued job remains unattempted");

    queue::Job reclaimed{};
    check(queue::claim_next(&reclaimed), "claim requeued job");
    check(queue::mark_delivery_attempted(reclaimed.api_id, &error),
          "persist delivery intent", error);
    check(!queue::mark_delivery_attempted(reclaimed.api_id, &error),
          "duplicate delivery intent is rejected");
    check(error == ERROR_ALREADY_EXISTS,
          "duplicate delivery intent reports ERROR_ALREADY_EXISTS", error);

    error = ERROR_SUCCESS;
    check(queue::complete(reclaimed.api_id, true, true, 1, error),
          "complete attempted job", error);
    queue::close();

    recovered = -1;
    check(queue::open(path, &recovered, &error),
          "reopen completed database", error);
    check(recovered == 0, "completed jobs are not recovered", error);
    queue::Job completed{};
    check(queue::find(reclaimed.api_id, &completed),
          "find completed job");
    check(completed.state == queue::JobState::Succeeded,
          "completed job state is succeeded");
    check(completed.content_verified, "completed job keeps verification flag");
    check(completed.sent_count == 1, "completed job keeps sent count");
    queue::close();
}

void test_completion_invariants(const wchar_t* path) {
    DWORD error = ERROR_SUCCESS;
    int recovered = 0;
    check(queue::open(path, &recovered, &error),
          "open completion-invariant database", error);

    const queue::Job message = enqueue_job(L"complete-target", L"complete");
    queue::Job claimed_message{};
    check(queue::claim_next(&claimed_message), "claim message without intent");
    check(!queue::complete(claimed_message.api_id, true, false, 1,
                           ERROR_SUCCESS),
          "successful non-search completion requires delivery intent");

    queue::Job still_running{};
    check(queue::find(claimed_message.api_id, &still_running),
          "find message after rejected completion");
    check(still_running.state == queue::JobState::Running,
          "rejected completion leaves job running");
    check(queue::mark_delivery_attempted(claimed_message.api_id, &error),
          "record intent for completion test", error);
    error = ERROR_SUCCESS;
    check(queue::complete(claimed_message.api_id, true, false, 1, error),
          "attempted non-search job can complete");
    check(!queue::complete(claimed_message.api_id, false, false, 0,
                           ERROR_TIMEOUT),
          "completed job cannot be completed twice");

    const queue::Job search = enqueue_job(
        L"search-target", nullptr, queue::JobType::Search);
    queue::Job claimed_search{};
    check(queue::claim_next(&claimed_search), "claim search job");
    check(strcmp(claimed_search.api_id, search.api_id) == 0,
          "claimed search job matches enqueue");
    check(queue::complete(claimed_search.api_id, true, false, 0,
                          ERROR_SUCCESS),
          "search completion does not require delivery intent");
    queue::close();
}

void test_legacy_migration(const wchar_t* path) {
    check(create_legacy_database(path), "create legacy database");

    DWORD error = ERROR_SUCCESS;
    int recovered = -1;
    check(queue::open(path, &recovered, &error),
          "migrate legacy database", error);
    check(recovered == 0,
          "legacy running row is failed rather than replayed", error);

    queue::Job running{};
    check(queue::find("legacy-running", &running),
          "find migrated legacy running row");
    check(running.state == queue::JobState::Failed,
          "legacy running row becomes failed");
    check(running.delivery_attempted,
          "legacy running row is conservatively attempted");
    check(running.error == ERROR_PROCESS_ABORTED,
          "legacy running row reports process abort", running.error);

    queue::Job queued{};
    check(queue::find("legacy-queued", &queued),
          "find migrated legacy queued row");
    check(queued.state == queue::JobState::Queued,
          "legacy queued row remains queued");
    check(!queued.delivery_attempted,
          "legacy queued row remains unattempted");

    queue::Job claimed{};
    check(queue::claim_next(&claimed), "claim migrated legacy queued row");
    check(strcmp(claimed.api_id, "legacy-queued") == 0,
          "legacy queued row is the next claim");
    queue::close();
}

void test_attempted_crash_recovery(const wchar_t* path) {
    DWORD error = ERROR_SUCCESS;
    int recovered = 0;
    check(queue::open(path, &recovered, &error),
          "open crash-recovery database", error);
    const queue::Job first = enqueue_job(L"crash-target", L"first");
    const queue::Job second = enqueue_job(L"crash-target", L"second");

    queue::Job claimed{};
    check(queue::claim_next(&claimed), "claim first crash-recovery job");
    check(queue::mark_delivery_attempted(claimed.api_id, &error),
          "mark first crash-recovery job attempted", error);
    queue::close();

    recovered = -1;
    check(queue::open(path, &recovered, &error),
          "reopen after attempted crash", error);
    check(recovered == 0,
          "attempted crash is not requeued", error);

    queue::Job failed{};
    check(queue::find(first.api_id, &failed),
          "find attempted crash row");
    check(failed.state == queue::JobState::Failed,
          "attempted crash row becomes failed");
    check(failed.delivery_attempted,
          "attempted crash row keeps intent flag");
    check(failed.error == ERROR_PROCESS_ABORTED,
          "attempted crash row reports process abort", failed.error);

    queue::Job next{};
    check(queue::claim_next(&next), "claim next job after attempted crash");
    check(strcmp(next.api_id, second.api_id) == 0,
          "next job is not the attempted crash row");
    check(!next.delivery_attempted,
          "next job remains unattempted");
    queue::close();
}

void test_requeue(const wchar_t* path) {
    DWORD error = ERROR_SUCCESS;
    int recovered = 0;
    check(queue::open(path, &recovered, &error),
          "open requeue database", error);

    const queue::Job stored = enqueue_job(L"requeue-target", L"requeue");
    check(!queue::requeue(stored.api_id, &error),
          "queued job cannot be requeued");
    check(error == ERROR_INVALID_STATE,
          "requeue of queued job reports ERROR_INVALID_STATE", error);

    queue::Job claimed{};
    check(queue::claim_next(&claimed), "claim job for requeue");
    check(strcmp(claimed.api_id, stored.api_id) == 0,
          "claimed job matches requeue enqueue");
    error = ERROR_SUCCESS;
    check(queue::requeue(claimed.api_id, &error),
          "unattempted running job is requeued", error);

    queue::Job requeued{};
    check(queue::find(stored.api_id, &requeued), "find requeued job");
    check(requeued.state == queue::JobState::Queued,
          "requeue returns job to queued");
    check(!requeued.delivery_attempted, "requeued job stays unattempted");

    queue::Job reclaimed{};
    check(queue::claim_next(&reclaimed), "claim job again after requeue");
    check(strcmp(reclaimed.api_id, stored.api_id) == 0,
          "requeued job is claimed again");
    check(reclaimed.state == queue::JobState::Running,
          "reclaimed job is running");
    check(queue::mark_delivery_attempted(reclaimed.api_id, &error),
          "record intent after requeue", error);
    check(!queue::requeue(reclaimed.api_id, &error),
          "attempted running job cannot be requeued");
    check(error == ERROR_ALREADY_EXISTS,
          "requeue of attempted job reports ERROR_ALREADY_EXISTS", error);

    queue::Job attempted{};
    check(queue::find(stored.api_id, &attempted),
          "find job after rejected requeue");
    check(attempted.state == queue::JobState::Running
              && attempted.delivery_attempted,
          "rejected requeue leaves job running and attempted");

    check(queue::complete(reclaimed.api_id, true, true, 1, ERROR_SUCCESS),
          "complete job after rejected requeue");
    check(!queue::requeue(reclaimed.api_id, &error),
          "completed job cannot be requeued");
    check(error == ERROR_INVALID_STATE,
          "requeue of completed job reports ERROR_INVALID_STATE", error);
    queue::close();
}

void test_history_trim(const wchar_t* path) {
    DWORD error = ERROR_SUCCESS;
    int recovered = 0;
    check(queue::open(path, &recovered, &error), "open trim database", error);

    char oldest_id[queue::kApiIdLength + 1]{};
    char newest_id[queue::kApiIdLength + 1]{};
    bool created = true;
    for (int i = 0; i < 51 && created; ++i) {
        const queue::Job input = make_job(L"trim-target", nullptr,
                                         queue::JobType::Search);
        queue::Job stored{};
        queue::Job claimed{};
        created = queue::enqueue(input, &stored, &error)
                  && queue::claim_next(&claimed)
                  && queue::complete(claimed.api_id, true, false, 0,
                                     ERROR_SUCCESS);
        if (created) {
            if (i == 0) {
                strcpy_s(oldest_id, claimed.api_id);
            }
            strcpy_s(newest_id, claimed.api_id);
        }
    }
    check(created, "create 51 finished jobs", error);

    queue::Job rows[queue::kViewCapacity]{};
    queue::Stats stats{};
    queue::view(rows, ARRAYSIZE(rows), &stats);
    check(stats.succeeded == 50, "complete keeps exactly 50 finished jobs");
    check(stats.succeeded + stats.failed == 50,
          "complete leaves no extra finished history");
    queue::Job trimmed{};
    check(!queue::find(oldest_id, &trimmed),
          "complete trims the oldest finished job");
    queue::Job newest{};
    check(queue::find(newest_id, &newest),
          "complete keeps the newest finished job");
    queue::close();

    check(exec_on_closed_database(
              path,
              "INSERT INTO jobs (api_id,type,source,target,state,created_at,"
              " finished_at) VALUES"
              " ('trim-extra-1','search','test','trim-target','succeeded',1,1),"
              " ('trim-extra-2','search','test','trim-target','failed',1,1);"),
          "add finished rows while the store is closed");

    recovered = -1;
    check(queue::open(path, &recovered, &error),
          "reopen to trim history", error);
    stats = queue::Stats{};
    queue::view(rows, ARRAYSIZE(rows), &stats);
    check(stats.succeeded + stats.failed == 50,
          "startup keeps exactly 50 finished jobs");
    queue::Job extra{};
    check(queue::find("trim-extra-2", &extra),
          "startup trim keeps the newest finished row");
    check(queue::find(newest_id, &extra),
          "startup trim removes only the oldest rows");
    queue::close();
}

} // namespace

int main() {
    wchar_t temporary[MAX_PATH]{};
    if (GetTempPathW(ARRAYSIZE(temporary), temporary) == 0) {
        std::printf("FAIL GetTempPathW error=%lu\n",
                    static_cast<unsigned long>(GetLastError()));
        return 1;
    }

    wchar_t database[MAX_PATH * 2]{};
    const unsigned long long nonce =
        static_cast<unsigned long long>(GetTickCount64());
    if (swprintf_s(database, L"%ssupertime-queue-state-%lu-%llu.db",
                   temporary, static_cast<unsigned long>(GetCurrentProcessId()),
                   nonce) < 0) {
        std::printf("FAIL cannot build temporary database path\n");
        return 1;
    }
    remove_database_files(database);

    test_new_database_recovery(database);
    remove_database_files(database);
    test_completion_invariants(database);
    remove_database_files(database);
    test_legacy_migration(database);
    remove_database_files(database);
    test_attempted_crash_recovery(database);
    remove_database_files(database);
    test_requeue(database);
    remove_database_files(database);
    test_history_trim(database);
    remove_database_files(database);

    std::printf("RESULT checks=%d failures=%d\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
