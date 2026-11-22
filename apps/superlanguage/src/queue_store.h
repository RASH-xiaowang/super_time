#pragma once

#include <windows.h>

#include <cstddef>

namespace feather::queue {

enum class JobType {
    Search,
    Message,
    Attachments,
};

enum class JobState {
    Queued,
    Running,
    Succeeded,
    Failed,
};

constexpr int kApiIdLength = 16;
constexpr int kViewCapacity = 6;
constexpr int kMaxPendingJobs = 200;

struct Job {
    long long row_id{};
    char api_id[kApiIdLength + 1]{};
    JobType type{JobType::Message};
    JobState state{JobState::Queued};
    wchar_t source[8]{};
    wchar_t target[128]{};
    wchar_t message[512]{};
    wchar_t mention[128]{};
    bool mention_newline{};
    wchar_t attachments[1024]{};
    long long created_at{};
    long long finished_at{};
    bool content_verified{};
    int sent_count{};
    DWORD error{};
    bool delivery_attempted{};
};

struct Stats {
    int queued{};
    int running{};
    int succeeded{};
    int failed{};
};

// Opens (creating/migrating if needed) the queue database. Running jobs that
// never started delivery return to queued; attempted jobs become failed.
// A legacy database without the column treats its pre-existing running rows as
// attempted because their remote delivery state is unknown.
// `recovered` reports only the jobs safely returned to queued.
bool open(const wchar_t* db_path, int* recovered, DWORD* error);
void close();

// Assigns a random 16-hex api_id (BCryptGenRandom).
bool enqueue(const Job& input, Job* stored, DWORD* error);
// Atomically claims the oldest queued job. Returned Job.delivery_attempted
// tells the executor whether an irreversible delivery was already started.
// On failure, error is ERROR_NOT_FOUND for an empty queue or the underlying
// operational error otherwise. On success it is ERROR_SUCCESS.
bool claim_next(Job* out, DWORD* error = nullptr);
// Durably records intent immediately before an irreversible send. Returns true
// only when this call changed a running job from unattempted to attempted and
// committed; false means do not perform the send. Common false errors are
// ERROR_NOT_FOUND, ERROR_INVALID_STATE, and ERROR_ALREADY_EXISTS.
bool mark_delivery_attempted(const char* api_id, DWORD* error);
// Returns a running job to queued so it can be claimed again later. Only
// allowed while delivery_attempted is still 0; otherwise fails with
// ERROR_ALREADY_EXISTS (attempted) or ERROR_INVALID_STATE (not running).
bool requeue(const char* api_id, DWORD* error);
// A successful completion also trims finished history to the newest 50 rows.
bool complete(const char* api_id, bool succeeded, bool content_verified,
              int sent_count, DWORD error);
bool find(const char* api_id, Job* out);
// True while any queued/running/finished job still points at this spool
// resource (legacy "<id>.bin" or "<id>\<name>" path), and also whenever the
// database is closed or the lookup fails, so callers never delete on doubt.
bool references_attachment(const wchar_t* resource_id);

// Newest activity first for the panel: running, then queued (oldest next to
// run), then finished jobs.
int view(Job* rows, int capacity, Stats* stats);

const char* type_name(JobType type);
const char* state_name(JobState state);

} // namespace feather::queue
