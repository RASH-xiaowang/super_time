#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <bcrypt.h>

#include <algorithm>
#include <cctype>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

#include "api_server.h"
#include "automation.h"
#include "license_gate.h"
#include "version.h"

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "iphlpapi.lib")

namespace feather::api {
namespace {

constexpr int kMaxRequestBytes = 8192;
constexpr unsigned long long kMaxResourceBytes = 20ULL * 1024ULL * 1024ULL;
constexpr int kMaxResourcesPerRequest = 9;
constexpr unsigned long long kResourceRetentionSeconds = 7ULL * 24ULL * 60ULL * 60ULL;
constexpr DWORD kStopTimeoutMs = 6000;

// One deadline covers the request headers and a JSON body, so a slow sender
// cannot hold a worker for longer than this regardless of how it trickles.
constexpr ULONGLONG kRequestDeadlineMs = 10000;
// Uploads extend that deadline by their Content-Length at this minimum rate
// (20 MiB => 320 s).
constexpr ULONGLONG kMinUploadBytesPerSecond = 64ULL * 1024ULL;
constexpr ULONGLONG kCloseDrainMs = 500;
constexpr int kMaxWorkers = 8;
// Request buffers live on the heap; this reservation covers the JSON paths
// (wide body plus parsed fields, well under 128 KiB) with ample margin.
constexpr SIZE_T kWorkerStackBytes = 1024 * 1024;
constexpr int kRecvTimedOut = -2;

// attachments may be a JSON string array; keep the element count bounded and
// join elements with ';' for the job queue.
constexpr int kMaxAttachmentPaths = 16;

struct Worker {
    HANDLE thread{};
    // Owned by the worker until stop() takes it to unblock a pending recv.
    SOCKET client{INVALID_SOCKET};
};

CRITICAL_SECTION g_lock{};
bool g_lock_ready = false;
HWND g_ui_window = nullptr;
UINT g_notify_message = 0;
UINT g_exit_message = 0;
SOCKET g_listen = INVALID_SOCKET;
// Accept thread; worker threads live in g_workers under g_lock.
HANDLE g_thread = nullptr;
Worker g_workers[kMaxWorkers]{};
// Serializes spool housekeeping against resource staging + enqueue, so a
// resource cannot be deleted between being resolved and being referenced.
SRWLOCK g_spool_lock = SRWLOCK_INIT;
volatile LONG g_stopping = 0;
volatile LONG g_allow_local_attachment_paths = 0;
char g_token[33]{};
unsigned short g_port = 0;
wchar_t g_port_path[MAX_PATH]{};
wchar_t g_token_path[MAX_PATH]{};
bool g_wsa_started = false;

class SpoolLock {
public:
    SpoolLock() { AcquireSRWLockExclusive(&g_spool_lock); }
    ~SpoolLock() { ReleaseSRWLockExclusive(&g_spool_lock); }
    SpoolLock(const SpoolLock&) = delete;
    SpoolLock& operator=(const SpoolLock&) = delete;
};

// recv() bounded by an absolute GetTickCount64 deadline. Returns the byte
// count, 0 on orderly close, -1 on error, or kRecvTimedOut.
int recv_until(SOCKET client, char* buffer, int length, ULONGLONG deadline) {
    const ULONGLONG now = GetTickCount64();
    if (now >= deadline) {
        return kRecvTimedOut;
    }
    const ULONGLONG wait_ms = deadline - now;
    fd_set readable{};
    FD_ZERO(&readable);
    FD_SET(client, &readable);
    timeval timeout{};
    timeout.tv_sec = static_cast<long>(wait_ms / 1000ULL);
    timeout.tv_usec = static_cast<long>((wait_ms % 1000ULL) * 1000ULL);
    const int ready = select(0, &readable, nullptr, nullptr, &timeout);
    if (ready == 0) {
        return kRecvTimedOut;
    }
    if (ready < 0) {
        return -1;
    }
    return recv(client, buffer, length, 0);
}

bool in_addr_is_loopback_v4(const in_addr& address) {
    return (ntohl(address.s_addr) & 0xFF000000UL) == 0x7F000000UL;
}

void set_local_attachment_paths_allowed(bool allowed) {
    InterlockedExchange(&g_allow_local_attachment_paths, allowed ? 1 : 0);
}

bool local_attachment_paths_allowed() {
    return InterlockedCompareExchange(
               &g_allow_local_attachment_paths, 0, 0) != 0;
}

// Local file paths are resolved on the machine running SuperLanguage, so they
// only make sense for callers that are already on this machine. With the API
// listening on the LAN, requests from 127.0.0.1 keep working while remote
// callers must upload resources first.
bool client_allows_local_attachment_paths(SOCKET client) {
    if (!local_attachment_paths_allowed()) {
        return false;
    }
    sockaddr_in peer{};
    int peer_length = sizeof(peer);
    if (getpeername(client, reinterpret_cast<sockaddr*>(&peer),
                    &peer_length) != 0) {
        return false;
    }
    return peer.sin_family == AF_INET && in_addr_is_loopback_v4(peer.sin_addr);
}

void skip_space(const wchar_t*& cursor) {
    while (*cursor == L' ' || *cursor == L'\t'
           || *cursor == L'\r' || *cursor == L'\n') {
        ++cursor;
    }
}

int hex_value(wchar_t value) {
    if (value >= L'0' && value <= L'9') {
        return value - L'0';
    }
    if (value >= L'a' && value <= L'f') {
        return value - L'a' + 10;
    }
    if (value >= L'A' && value <= L'F') {
        return value - L'A' + 10;
    }
    return -1;
}

// ---------------------------------------------------------------------------
/**
 * 从**扁平** JSON 里取一个字符串字段。
 *
 * 只用于 `/api/license/lease` 的 `claim` / `mac`：这两个值只可能是十六进制，
 * 因此刻意不接受转义、嵌套或非十六进制字符 —— 不为了两个定长字段引入通用 JSON 解析。
 */
bool json_string_field(const char* body, const char* key, char* out, size_t capacity) {
    if (body == nullptr || key == nullptr || out == nullptr || capacity == 0) return false;
    out[0] = 0;
    const std::string needle = std::string("\"") + key + "\"";
    const char* at = strstr(body, needle.c_str());
    if (at == nullptr) return false;
    at += needle.size();
    while (*at == ' ' || *at == '\t' || *at == '\r' || *at == '\n') ++at;
    if (*at != ':') return false;
    ++at;
    while (*at == ' ' || *at == '\t' || *at == '\r' || *at == '\n') ++at;
    if (*at != '"') return false;
    ++at;
    size_t written = 0;
    while (*at != 0 && *at != '"') {
        const unsigned char c = static_cast<unsigned char>(*at);
        const bool is_hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
            || (c >= 'A' && c <= 'F');
        if (!is_hex || written + 1 >= capacity) return false;
        out[written++] = static_cast<char>(c);
        ++at;
    }
    if (*at != '"') return false;
    out[written] = 0;
    return written > 0;
}

// Request JSON reader shared by /api/* and the inbound webhook.
//
// Walks one top-level object of the 8192-byte request body, maps known keys
// through an alias table, and skips any other value (including nested
// arrays/objects). attachments/resource_ids accept a string or a string array.
// ---------------------------------------------------------------------------

enum class JsonParseStatus {
    Ok,
    Invalid,
    TooLong,
    BadElement,  // empty array element, or one containing the ';' joiner
};

enum class RequestField {
    Unknown,
    Target,
    Message,
    Mention,
    Separator,
    Attachments,
    ResourceIds,
    Type,
    MentionNewline,
};

struct RequestFields {
    wchar_t target[128]{};
    wchar_t message[512]{};
    wchar_t mention[128]{};
    wchar_t mention_separator[32]{};
    wchar_t attachments[1024]{};
    wchar_t resource_ids[4096]{};
    wchar_t type[32]{};
    bool mention_newline{};
    bool mention_newline_set{};
    int target_priority{-1};
    int message_priority{-1};
    int mention_priority{-1};
    int separator_priority{-1};
    int attachments_priority{-1};
    int resource_ids_priority{-1};
    int type_priority{-1};
    // Field that caused a TooLong/BadElement result.
    RequestField error_field{RequestField::Unknown};
};

struct FieldAlias {
    const wchar_t* key;
    RequestField field;
    int priority;
};

// Alias priority follows the contract: the earliest listed alias wins when the
// same field is supplied more than once.
constexpr FieldAlias kWebhookAliases[] = {
    {L"target", RequestField::Target, 0},
    {L"to", RequestField::Target, 1},
    {L"session", RequestField::Target, 2},
    {L"chat", RequestField::Target, 3},
    {L"receiver", RequestField::Target, 4},
    {L"group", RequestField::Target, 5},
    {L"room", RequestField::Target, 6},
    {L"message", RequestField::Message, 0},
    {L"text", RequestField::Message, 1},
    {L"content", RequestField::Message, 2},
    {L"msg", RequestField::Message, 3},
    {L"mention", RequestField::Mention, 0},
    {L"at", RequestField::Mention, 1},
    {L"mention_name", RequestField::Mention, 2},
    {L"mention_separator", RequestField::Separator, 0},
    {L"attachments", RequestField::Attachments, 0},
    {L"files", RequestField::Attachments, 1},
    {L"file", RequestField::Attachments, 2},
    {L"resource_ids", RequestField::ResourceIds, 0},
    {L"resources", RequestField::ResourceIds, 1},
    {L"type", RequestField::Type, 0},
    {L"mention_newline", RequestField::MentionNewline, 0},
};

// /api/* only accepts the formal field names; any other key is ignored.
constexpr FieldAlias kApiAliases[] = {
    {L"target", RequestField::Target, 0},
    {L"message", RequestField::Message, 0},
    {L"mention", RequestField::Mention, 0},
    {L"mention_separator", RequestField::Separator, 0},
    {L"attachments", RequestField::Attachments, 0},
    {L"resource_ids", RequestField::ResourceIds, 0},
    {L"resources", RequestField::ResourceIds, 1},
    {L"mention_newline", RequestField::MentionNewline, 0},
};

// Advances past a JSON string (cursor must point at the opening quote).
bool json_skip_string(const wchar_t*& cursor) {
    if (*cursor != L'"') {
        return false;
    }
    ++cursor;
    while (*cursor) {
        const wchar_t character = *cursor++;
        if (character == L'\\') {
            if (!*cursor) {
                return false;
            }
            ++cursor;
        } else if (character == L'"') {
            return true;
        } else if (character < 0x20) {
            return false;
        }
    }
    return false;
}

// Advances past one arbitrary JSON value. Nesting is bounded so malformed input
// cannot exhaust the server thread stack.
bool json_skip_value(const wchar_t*& cursor, int depth) {
    if (depth > 16) {
        return false;
    }
    skip_space(cursor);
    if (*cursor == L'"') {
        return json_skip_string(cursor);
    }
    if (*cursor == L'{') {
        ++cursor;
        skip_space(cursor);
        if (*cursor == L'}') {
            ++cursor;
            return true;
        }
        while (true) {
            skip_space(cursor);
            if (*cursor != L'"' || !json_skip_string(cursor)) {
                return false;
            }
            skip_space(cursor);
            if (*cursor != L':') {
                return false;
            }
            ++cursor;
            if (!json_skip_value(cursor, depth + 1)) {
                return false;
            }
            skip_space(cursor);
            if (*cursor == L',') {
                ++cursor;
                continue;
            }
            if (*cursor == L'}') {
                ++cursor;
                return true;
            }
            return false;
        }
    }
    if (*cursor == L'[') {
        ++cursor;
        skip_space(cursor);
        if (*cursor == L']') {
            ++cursor;
            return true;
        }
        while (true) {
            if (!json_skip_value(cursor, depth + 1)) {
                return false;
            }
            skip_space(cursor);
            if (*cursor == L',') {
                ++cursor;
                continue;
            }
            if (*cursor == L']') {
                ++cursor;
                return true;
            }
            return false;
        }
    }
    const wchar_t* start = cursor;
    while (*cursor && *cursor != L',' && *cursor != L'}'
           && *cursor != L']' && *cursor != L' ' && *cursor != L'\t'
           && *cursor != L'\r' && *cursor != L'\n') {
        ++cursor;
    }
    return cursor != start;
}

// Reads one JSON string value into out, decoding escape sequences.
JsonParseStatus json_read_string_value(const wchar_t*& cursor,
                                       wchar_t* out, size_t capacity) {
    if (*cursor != L'"') {
        return JsonParseStatus::Invalid;
    }
    ++cursor;
    size_t length = 0;
    while (*cursor && *cursor != L'"') {
        wchar_t character = *cursor++;
        if (character == L'\\') {
            if (!*cursor) {
                return JsonParseStatus::Invalid;
            }
            character = *cursor++;
            switch (character) {
            case L'"':
            case L'\\':
            case L'/':
                break;
            case L'b':
                character = L'\b';
                break;
            case L'f':
                character = L'\f';
                break;
            case L'n':
                character = L'\n';
                break;
            case L'r':
                character = L'\r';
                break;
            case L't':
                character = L'\t';
                break;
            case L'u': {
                int code = 0;
                for (int index = 0; index < 4; ++index) {
                    const int digit = hex_value(*cursor);
                    if (digit < 0) {
                        return JsonParseStatus::Invalid;
                    }
                    code = code * 16 + digit;
                    ++cursor;
                }
                character = static_cast<wchar_t>(code);
                break;
            }
            default:
                return JsonParseStatus::Invalid;
            }
        } else if (character < 0x20) {
            return JsonParseStatus::Invalid;
        }
        if (character == 0) {
            return JsonParseStatus::Invalid;
        }
        if (length + 1 >= capacity) {
            return JsonParseStatus::TooLong;
        }
        out[length++] = character;
    }
    if (*cursor != L'"') {
        return JsonParseStatus::Invalid;
    }
    ++cursor;
    out[length] = 0;
    return JsonParseStatus::Ok;
}

// Reads a JSON array of strings and joins the elements with ';', matching the
// attachment string form consumed by the queue/sender.
JsonParseStatus json_read_string_array(const wchar_t*& cursor,
                                       wchar_t* out, size_t capacity,
                                       int max_elements) {
    if (*cursor != L'[') {
        return JsonParseStatus::Invalid;
    }
    ++cursor;
    out[0] = 0;
    size_t length = 0;
    int count = 0;
    skip_space(cursor);
    if (*cursor == L']') {
        ++cursor;
        return JsonParseStatus::Ok;
    }
    while (true) {
        skip_space(cursor);
        if (count >= max_elements) {
            return JsonParseStatus::TooLong;
        }
        wchar_t element[1200]{};
        const JsonParseStatus status =
            json_read_string_value(cursor, element, ARRAYSIZE(element));
        if (status != JsonParseStatus::Ok) {
            return status;
        }
        const size_t element_length = wcslen(element);
        if (element_length == 0 || wcschr(element, L';')) {
            return JsonParseStatus::BadElement;
        }
        const size_t separator = count > 0 ? 1 : 0;
        if (length + separator + element_length + 1 > capacity) {
            return JsonParseStatus::TooLong;
        }
        if (separator != 0) {
            out[length++] = L';';
        }
        memcpy(out + length, element, element_length * sizeof(wchar_t));
        length += element_length;
        out[length] = 0;
        ++count;
        skip_space(cursor);
        if (*cursor == L',') {
            ++cursor;
            continue;
        }
        if (*cursor == L']') {
            ++cursor;
            return JsonParseStatus::Ok;
        }
        return JsonParseStatus::Invalid;
    }
}

// Stores value only when it is non-empty and better than the already stored
// alias (lower priority number wins). Returns false when the value does not fit.
bool store_field(wchar_t* out, size_t capacity, int* stored_priority,
                 const wchar_t* value, int priority) {
    if (!value[0]) {
        return true;
    }
    if (*stored_priority >= 0 && *stored_priority <= priority) {
        return true;
    }
    if (wcslen(value) >= capacity) {
        return false;
    }
    wcscpy_s(out, capacity, value);
    *stored_priority = priority;
    return true;
}

JsonParseStatus parse_request_fields(const wchar_t* json,
                                     const FieldAlias* aliases,
                                     size_t alias_count,
                                     RequestFields* fields) {
    const wchar_t* cursor = json;
    if (*cursor == 0xFEFF) {
        ++cursor;
    }
    skip_space(cursor);
    if (*cursor != L'{') {
        return JsonParseStatus::Invalid;
    }
    ++cursor;
    while (true) {
        skip_space(cursor);
        if (*cursor == L'}') {
            ++cursor;
            break;
        }
        if (*cursor != L'"') {
            return JsonParseStatus::Invalid;
        }
        ++cursor;
        wchar_t key[64]{};
        size_t key_length = 0;
        while (*cursor && *cursor != L'"') {
            if (*cursor == L'\\' || key_length + 1 >= ARRAYSIZE(key)) {
                return JsonParseStatus::Invalid;
            }
            key[key_length++] = *cursor++;
        }
        if (*cursor != L'"') {
            return JsonParseStatus::Invalid;
        }
        ++cursor;
        key[key_length] = 0;
        skip_space(cursor);
        if (*cursor != L':') {
            return JsonParseStatus::Invalid;
        }
        ++cursor;
        skip_space(cursor);

        RequestField field = RequestField::Unknown;
        int priority = 0;
        for (size_t index = 0; index < alias_count; ++index) {
            if (wcscmp(aliases[index].key, key) == 0) {
                field = aliases[index].field;
                priority = aliases[index].priority;
                break;
            }
        }

        if (field == RequestField::Unknown) {
            if (!json_skip_value(cursor, 0)) {
                return JsonParseStatus::Invalid;
            }
        } else if (field == RequestField::MentionNewline) {
            // The delimiter check after the member rejects "trueX".
            if (wcsncmp(cursor, L"true", 4) == 0) {
                fields->mention_newline = true;
                fields->mention_newline_set = true;
                cursor += 4;
            } else if (wcsncmp(cursor, L"false", 5) == 0) {
                fields->mention_newline = false;
                fields->mention_newline_set = true;
                cursor += 5;
            } else {
                return JsonParseStatus::Invalid;
            }
        } else if (field == RequestField::Attachments
                   || field == RequestField::ResourceIds) {
            const bool is_attachments = field == RequestField::Attachments;
            wchar_t value[4096]{};
            const size_t capacity = is_attachments
                ? ARRAYSIZE(fields->attachments) : ARRAYSIZE(value);
            JsonParseStatus status = JsonParseStatus::Invalid;
            if (*cursor == L'[') {
                status = json_read_string_array(
                    cursor, value, capacity,
                    is_attachments ? kMaxAttachmentPaths
                                   : kMaxResourcesPerRequest);
            } else if (*cursor == L'"') {
                status = json_read_string_value(cursor, value, capacity);
            } else {
                return JsonParseStatus::Invalid;
            }
            if (status == JsonParseStatus::Ok
                && !(is_attachments
                         ? store_field(fields->attachments,
                                       ARRAYSIZE(fields->attachments),
                                       &fields->attachments_priority, value,
                                       priority)
                         : store_field(fields->resource_ids,
                                       ARRAYSIZE(fields->resource_ids),
                                       &fields->resource_ids_priority, value,
                                       priority))) {
                status = JsonParseStatus::TooLong;
            }
            if (status != JsonParseStatus::Ok) {
                if (status != JsonParseStatus::Invalid) {
                    fields->error_field = field;
                }
                return status;
            }
        } else {
            if (*cursor != L'"') {
                return JsonParseStatus::Invalid;
            }
            wchar_t value[1200]{};
            const JsonParseStatus status =
                json_read_string_value(cursor, value, ARRAYSIZE(value));
            if (status == JsonParseStatus::TooLong) {
                fields->error_field = field;
            }
            if (status != JsonParseStatus::Ok) {
                return status;
            }
            bool stored = true;
            if (field == RequestField::Target) {
                stored = store_field(fields->target,
                                     ARRAYSIZE(fields->target),
                                     &fields->target_priority, value,
                                     priority);
            } else if (field == RequestField::Message) {
                stored = store_field(fields->message,
                                     ARRAYSIZE(fields->message),
                                     &fields->message_priority, value,
                                     priority);
            } else if (field == RequestField::Mention) {
                stored = store_field(fields->mention,
                                     ARRAYSIZE(fields->mention),
                                     &fields->mention_priority, value,
                                     priority);
            } else if (field == RequestField::Separator) {
                stored = store_field(fields->mention_separator,
                                     ARRAYSIZE(fields->mention_separator),
                                     &fields->separator_priority, value,
                                     priority);
            } else if (field == RequestField::Type) {
                stored = store_field(fields->type,
                                     ARRAYSIZE(fields->type),
                                     &fields->type_priority, value,
                                     priority);
            }
            if (!stored) {
                fields->error_field = field;
                return JsonParseStatus::TooLong;
            }
        }

        skip_space(cursor);
        if (*cursor == L',') {
            ++cursor;
            continue;
        }
        if (*cursor == L'}') {
            ++cursor;
            break;
        }
        return JsonParseStatus::Invalid;
    }

    skip_space(cursor);
    if (*cursor != 0) {
        return JsonParseStatus::Invalid;
    }
    return JsonParseStatus::Ok;
}

// 400 message for a failed parse_request_fields; names the canonical field.
const char* request_fields_error(JsonParseStatus status,
                                 const RequestFields& fields) {
    if (status == JsonParseStatus::BadElement) {
        return fields.error_field == RequestField::ResourceIds
            ? "invalid resource_ids element"
            : "invalid attachments element";
    }
    if (status != JsonParseStatus::TooLong) {
        return "invalid json";
    }
    switch (fields.error_field) {
    case RequestField::Target: return "target too long";
    case RequestField::Message: return "message too long";
    case RequestField::Mention: return "mention too long";
    case RequestField::Separator: return "mention_separator too long";
    case RequestField::Attachments: return "attachments too long";
    case RequestField::ResourceIds: return "resource_ids too long";
    case RequestField::Type: return "type too long";
    default: return "field value too long";
    }
}

bool header_value_span(const char* request, const char* name,
                       const char** out, size_t* out_length) {
    const char* cursor = strstr(request, "\r\n");
    if (!cursor) {
        return false;
    }
    cursor += 2;
    const size_t name_length = strlen(name);
    while (*cursor) {
        if (cursor[0] == '\r' && cursor[1] == '\n') {
            break;
        }
        const char* end = strstr(cursor, "\r\n");
        if (!end) {
            break;
        }
        if (_strnicmp(cursor, name, name_length) == 0
            && cursor[name_length] == ':') {
            const char* value = cursor + name_length + 1;
            while (*value == ' ' || *value == '\t') {
                ++value;
            }
            size_t length = static_cast<size_t>(end - value);
            while (length > 0
                   && (value[length - 1] == ' ' || value[length - 1] == '\t')) {
                --length;
            }
            *out = value;
            *out_length = length;
            return true;
        }
        cursor = end + 2;
    }
    return false;
}

bool header_value(const char* request, const char* name,
                  char* out, size_t capacity) {
    const char* value = nullptr;
    size_t length = 0;
    if (!out || capacity == 0
        || !header_value_span(request, name, &value, &length)) {
        return false;
    }
    if (length >= capacity) {
        length = capacity - 1;
    }
    memcpy(out, value, length);
    out[length] = 0;
    return true;
}

bool media_type_matches(const char* value, size_t length,
                        const char* expected) {
    if (!value || !expected || !expected[0]) {
        return false;
    }
    const char* semicolon = static_cast<const char*>(
        memchr(value, ';', length));
    const char* end = semicolon ? semicolon : value + length;
    while (value < end && (*value == ' ' || *value == '\t')) {
        ++value;
    }
    while (end > value && (end[-1] == ' ' || end[-1] == '\t')) {
        --end;
    }
    const size_t media_length = static_cast<size_t>(end - value);
    const size_t expected_length = strlen(expected);
    return media_length == expected_length
        && _strnicmp(value, expected, expected_length) == 0;
}

enum class ContentLengthStatus {
    Missing,
    Invalid,
    TooLarge,
    Ok,
};

struct ContentLengthHeader {
    ContentLengthStatus status{ContentLengthStatus::Missing};
    unsigned long long value{};
};

ContentLengthHeader parse_content_length(const char* request,
                                         unsigned long long maximum) {
    ContentLengthHeader parsed{};
    const char* value = nullptr;
    size_t length = 0;
    if (!header_value_span(request, "Content-Length", &value, &length)) {
        return parsed;
    }
    parsed.status = ContentLengthStatus::Invalid;
    if (!value || length == 0) {
        return parsed;
    }
    unsigned long long number = 0;
    for (size_t index = 0; index < length; ++index) {
        const unsigned char character =
            static_cast<unsigned char>(value[index]);
        if (character < '0' || character > '9') {
            return parsed;
        }
        const unsigned int digit = character - '0';
        if (number > (ULLONG_MAX - digit) / 10ULL) {
            parsed.status = ContentLengthStatus::TooLarge;
            return parsed;
        }
        number = number * 10ULL + digit;
    }
    if (number > maximum) {
        parsed.status = ContentLengthStatus::TooLarge;
        return parsed;
    }
    parsed.status = ContentLengthStatus::Ok;
    parsed.value = number;
    return parsed;
}

const char* reason_phrase(int status) {
    switch (status) {
    case 200: return "OK";
    case 201: return "Created";
    case 202: return "Accepted";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 409: return "Conflict";
    case 411: return "Length Required";
    case 413: return "Payload Too Large";
    case 415: return "Unsupported Media Type";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    case 503: return "Service Unavailable";
    default: return "Error";
    }
}

bool send_all(SOCKET client, const char* data, int length) {
    while (length > 0) {
        const int sent = send(client, data, length, 0);
        if (sent <= 0) {
            return false;
        }
        data += sent;
        length -= sent;
    }
    return true;
}

void respond(SOCKET client, int status, const char* body) {
    char header[320]{};
    const int header_length = snprintf(
        header, sizeof(header),
        "HTTP/1.1 %d %s\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        "Content-Length: %d\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n"
        "\r\n",
        status, reason_phrase(status), static_cast<int>(strlen(body)));
    if (header_length <= 0
        || header_length >= static_cast<int>(sizeof(header))) {
        return;
    }
    if (send_all(client, header, header_length)) {
        send_all(client, body, static_cast<int>(strlen(body)));
    }
}

void respond_error(SOCKET client, int status, const char* message) {
    char body[256]{};
    snprintf(body, sizeof(body), "{\"message\":\"%s\"}", message);
    respond(client, status, body);
}

// Webhook responses (1.6.0) carry an explicit "ok" flag so external platforms
// can branch on success without inspecting the HTTP status alone.
void respond_webhook_error(SOCKET client, int status, const char* message) {
    char body[192]{};
    snprintf(body, sizeof(body), "{\"ok\":false,\"message\":\"%s\"}", message);
    respond(client, status, body);
}

bool executable_directory(wchar_t* directory, size_t capacity) {
    const DWORD length = GetModuleFileNameW(nullptr, directory,
                                            static_cast<DWORD>(capacity));
    if (length == 0 || length >= capacity) {
        return false;
    }
    wchar_t* slash = wcsrchr(directory, L'\\');
    if (!slash) {
        return false;
    }
    *slash = L'\0';
    return true;
}

bool resource_directory(wchar_t* directory, size_t capacity) {
    wchar_t base[MAX_PATH]{};
    if (!executable_directory(base, ARRAYSIZE(base))) return false;
    if (swprintf_s(directory, capacity, L"%s\\resource-spool", base) < 0) return false;
    if (!CreateDirectoryW(directory, nullptr)
        && GetLastError() != ERROR_ALREADY_EXISTS) {
        return false;
    }
    const DWORD attributes = GetFileAttributesW(directory);
    return attributes != INVALID_FILE_ATTRIBUTES
        && (attributes & FILE_ATTRIBUTE_DIRECTORY);
}

bool valid_resource_id(const wchar_t* id) {
    if (!id || wcslen(id) != 40) return false;
    for (int index = 0; index < 40; ++index) {
        if (!isxdigit(static_cast<unsigned char>(id[index]))) return false;
    }
    return true;
}

bool path_exists(const wchar_t* path) {
    return GetFileAttributesW(path) != INVALID_FILE_ATTRIBUTES;
}

// Removes resource-spool\<id>\ and the staged links inside it. A file still
// open elsewhere stays behind and is retried by the next cleanup.
void remove_resource_link_directory(const wchar_t* link_directory) {
    wchar_t pattern[MAX_PATH]{};
    if (swprintf_s(pattern, ARRAYSIZE(pattern), L"%s\\*", link_directory) < 0) {
        return;
    }
    WIN32_FIND_DATAW data{};
    HANDLE search = FindFirstFileW(pattern, &data);
    if (search != INVALID_HANDLE_VALUE) {
        do {
            if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
            wchar_t path[MAX_PATH]{};
            if (swprintf_s(path, ARRAYSIZE(path), L"%s\\%s", link_directory,
                           data.cFileName) >= 0) {
                DeleteFileW(path);
            }
        } while (FindNextFileW(search, &data));
        FindClose(search);
    }
    RemoveDirectoryW(link_directory);
}

// Keep unreferenced uploads for seven days. Queue rows are checked by resource
// id, so a delayed attachment task cannot lose its file to housekeeping.
// A resource is <id>.bin + <id>.json + the <id>\ link directory; it is aged by
// its .bin, or by whichever of the other two survives when the .bin is gone.
void cleanup_resource_spool() {
    wchar_t directory[MAX_PATH]{};
    if (!resource_directory(directory, ARRAYSIZE(directory))) return;
    SpoolLock lock;
    // WIN32_FIND_DATA uses FILETIME (100 ns ticks since 1601), not the
    // millisecond uptime returned by GetTickCount64().
    FILETIME now_filetime{};
    GetSystemTimeAsFileTime(&now_filetime);
    ULARGE_INTEGER now_value{};
    now_value.LowPart = now_filetime.dwLowDateTime;
    now_value.HighPart = now_filetime.dwHighDateTime;
    const ULONGLONG now = now_value.QuadPart;
    WIN32_FIND_DATAW data{};
    wchar_t pattern[MAX_PATH]{};
    if (swprintf_s(pattern, ARRAYSIZE(pattern), L"%s\\*", directory) < 0) return;
    HANDLE search = FindFirstFileW(pattern, &data);
    if (search == INVALID_HANDLE_VALUE) return;
    do {
        if (wcslen(data.cFileName) < 40) continue;
        wchar_t id[64]{};
        wcsncpy_s(id, ARRAYSIZE(id), data.cFileName, 40);
        if (!valid_resource_id(id)) continue;
        const wchar_t* suffix = data.cFileName + 40;
        const bool is_directory =
            (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
        wchar_t binary[MAX_PATH]{};
        wchar_t meta[MAX_PATH]{};
        wchar_t links[MAX_PATH]{};
        if (swprintf_s(binary, ARRAYSIZE(binary), L"%s\\%s.bin", directory, id) < 0
            || swprintf_s(meta, ARRAYSIZE(meta), L"%s\\%s.json", directory, id) < 0
            || swprintf_s(links, ARRAYSIZE(links), L"%s\\%s", directory, id) < 0) {
            continue;
        }
        bool owner = false;
        if (!is_directory && wcscmp(suffix, L".bin") == 0) {
            owner = true;
        } else if (!is_directory && wcscmp(suffix, L".json") == 0) {
            owner = !path_exists(binary);
        } else if (is_directory && suffix[0] == 0) {
            owner = !path_exists(binary) && !path_exists(meta);
        }
        if (!owner) continue;
        ULARGE_INTEGER modified{};
        modified.LowPart = data.ftLastWriteTime.dwLowDateTime;
        modified.HighPart = data.ftLastWriteTime.dwHighDateTime;
        const ULONGLONG age_ticks = now >= modified.QuadPart
            ? now - modified.QuadPart : 0;
        if (age_ticks <= static_cast<ULONGLONG>(kResourceRetentionSeconds)
                * 10000000ULL) continue;
        if (feather::queue::references_attachment(id)) continue;
        DeleteFileW(binary);
        DeleteFileW(meta);
        remove_resource_link_directory(links);
    } while (FindNextFileW(search, &data));
    FindClose(search);
}

std::string resource_error_json(int status, const char* message) {
    (void)status;
    std::string out = "{\"ok\":false,\"message\":\"";
    for (const char* p = message; p && *p; ++p) {
        if (*p == '"' || *p == '\\') out.push_back('\\');
        out.push_back(*p);
    }
    out += "\"}";
    return out;
}

// Win32 maps these names to devices regardless of extension ("nul.txt") and
// of trailing spaces before it ("CON .txt").
bool reserved_device_name(const wchar_t* name) {
    size_t stem = 0;
    while (name[stem] && name[stem] != L'.') ++stem;
    while (stem > 0 && name[stem - 1] == L' ') --stem;
    wchar_t base[8]{};
    if (stem == 0 || stem >= ARRAYSIZE(base)) return false;
    wcsncpy_s(base, ARRAYSIZE(base), name, stem);
    static const wchar_t* const kDevices[] = {
        L"CON", L"PRN", L"AUX", L"NUL", L"CONIN$", L"CONOUT$",
    };
    for (const wchar_t* device : kDevices) {
        if (_wcsicmp(base, device) == 0) return true;
    }
    if (stem == 4 && (_wcsnicmp(base, L"COM", 3) == 0
                      || _wcsnicmp(base, L"LPT", 3) == 0)) {
        const wchar_t digit = base[3];
        return (digit >= L'0' && digit <= L'9') || digit == L'\x00B9'
            || digit == L'\x00B2' || digit == L'\x00B3';
    }
    return false;
}

bool safe_resource_filename(const wchar_t* name, wchar_t* out, size_t capacity) {
    if (!name || !name[0] || wcslen(name) > 120) return false;
    size_t length = 0;
    for (const wchar_t* p = name; *p; ++p) {
        if (*p < 0x20 || *p == 0x7F || wcschr(L"<>:\"/\\|?*", *p)) return false;
        if (length + 1 >= capacity) return false;
        out[length++] = *p;
    }
    out[length] = 0;
    // Win32 silently strips trailing dots/spaces, which would change the name
    // (and turns "." / ".." into directory references).
    if (length == 0 || out[length - 1] == L'.' || out[length - 1] == L' ') {
        return false;
    }
    return !reserved_device_name(out);
}

bool header_utf8_to_wide(const char* value, wchar_t* out, size_t capacity) {
    if (!value || !value[0]) return false;
    const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                            value, -1, out,
                                            static_cast<int>(capacity));
    return length > 0;
}

bool resource_path_from_id(const wchar_t* id, const wchar_t* filename,
                           wchar_t* out, size_t capacity) {
    wchar_t directory[MAX_PATH]{};
    wchar_t safe_name[256]{};
    if (!valid_resource_id(id) || !resource_directory(directory, ARRAYSIZE(directory))
        || !safe_resource_filename(filename, safe_name, ARRAYSIZE(safe_name))) {
        return false;
    }
    if (swprintf_s(out, capacity, L"%s\\%s.bin", directory, id) < 0) return false;
    return true;
}

std::string resource_meta_path(const wchar_t* id) {
    wchar_t directory[MAX_PATH]{};
    wchar_t path[MAX_PATH]{};
    if (!resource_directory(directory, ARRAYSIZE(directory))
        || swprintf_s(path, ARRAYSIZE(path), L"%s\\%s.json", directory, id) < 0) {
        return {};
    }
    char utf8[MAX_PATH * 4]{};
    if (WideCharToMultiByte(CP_UTF8, 0, path, -1, utf8, sizeof(utf8),
                            nullptr, nullptr) <= 0) return {};
    return utf8;
}

bool write_resource_meta(const wchar_t* id, const wchar_t* filename,
                         unsigned long long size, const std::string& sha) {
    const std::string path = resource_meta_path(id);
    if (path.empty()) return false;
    const int required = WideCharToMultiByte(CP_UTF8, 0, filename, -1,
                                              nullptr, 0, nullptr, nullptr);
    if (required <= 1) return false;
    std::string name(static_cast<size_t>(required), '\0');
    if (WideCharToMultiByte(CP_UTF8, 0, filename, -1, name.data(), required,
                            nullptr, nullptr) != required) {
        return false;
    }
    name.resize(static_cast<size_t>(required - 1));
    const std::string body = "{\"name\":\"" + name + "\",\"size\":"
        + std::to_string(size) + ",\"sha256\":\"" + sha + "\"}";
    HANDLE file = CreateFileA(path.c_str(), GENERIC_WRITE, 0, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const bool ok = WriteFile(file, body.data(),
                              static_cast<DWORD>(body.size()), &written,
                              nullptr) != FALSE
        && written == body.size();
    CloseHandle(file);
    return ok;
}

bool read_resource_meta(const wchar_t* id, wchar_t* filename, size_t capacity,
                        unsigned long long* size, std::string* sha) {
    const std::string path = resource_meta_path(id);
    if (path.empty()) return false;
    HANDLE file = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL,
                              nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    char body[2048]{};
    DWORD read = 0;
    const bool read_ok = ReadFile(file, body, sizeof(body) - 1, &read, nullptr)
        != FALSE;
    CloseHandle(file);
    if (!read_ok || read == 0) return false;
    body[read] = 0;
    const char* name = strstr(body, "\"name\":\"");
    const char* length = strstr(body, "\"size\":");
    const char* hash = strstr(body, "\"sha256\":\"");
    if (!name || !length || !hash) return false;
    name += 8;
    const char* name_end = strchr(name, '"');
    if (!name_end) return false;
    const int name_length = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, name,
        static_cast<int>(name_end - name), filename,
        static_cast<int>(capacity));
    if (name_length <= 0 || static_cast<size_t>(name_length) >= capacity) return false;
    filename[name_length] = 0;
    *size = strtoull(length + 7, nullptr, 10);
    hash += 10;
    const char* hash_end = strchr(hash, '"');
    if (!hash_end || hash_end - hash != 64) return false;
    sha->assign(hash, 64);
    return *size > 0;
}

bool file_size_matches(const wchar_t* path, unsigned long long size) {
    HANDLE file = CreateFileW(
        path, FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    LARGE_INTEGER actual_size{};
    const bool matches =
        GetFileSizeEx(file, &actual_size) != FALSE
        && actual_size.QuadPart >= 0
        && static_cast<unsigned long long>(actual_size.QuadPart) == size;
    CloseHandle(file);
    return matches;
}

enum class ResourceLookup {
    Found,
    NotFound,
    StagingFailed,
};

// Resolves an uploaded resource to resource-spool\<id>\<original name>, a hard
// link (or copy) of <id>.bin, so WeChat sends it under its real filename.
// Each resource has its own directory, so equal names never collide. Caller
// must hold the spool lock until the returned path is referenced by a job.
ResourceLookup stage_resource_path(const wchar_t* id, wchar_t* out,
                                   size_t capacity) {
    wchar_t filename[256]{};
    unsigned long long size = 0;
    std::string sha;
    if (!valid_resource_id(id) || !read_resource_meta(id, filename,
                                                       ARRAYSIZE(filename),
                                                       &size, &sha)) {
        return ResourceLookup::NotFound;
    }
    wchar_t binary[MAX_PATH]{};
    if (!resource_path_from_id(id, filename, binary, ARRAYSIZE(binary))
        || !file_size_matches(binary, size)) {
        return ResourceLookup::NotFound;
    }
    wchar_t directory[MAX_PATH]{};
    wchar_t links[MAX_PATH]{};
    wchar_t link[MAX_PATH]{};
    if (!resource_directory(directory, ARRAYSIZE(directory))
        || swprintf_s(links, ARRAYSIZE(links), L"%s\\%s", directory, id) < 0
        || swprintf_s(link, ARRAYSIZE(link), L"%s\\%s", links, filename) < 0) {
        return ResourceLookup::StagingFailed;
    }
    if (!CreateDirectoryW(links, nullptr)
        && GetLastError() != ERROR_ALREADY_EXISTS) {
        return ResourceLookup::StagingFailed;
    }
    if (!file_size_matches(link, size)) {
        DeleteFileW(link);
        if (!CreateHardLinkW(link, binary, nullptr)
            && !CopyFileW(binary, link, TRUE)) {
            return ResourceLookup::StagingFailed;
        }
        if (!file_size_matches(link, size)) {
            return ResourceLookup::StagingFailed;
        }
    }
    return wcscpy_s(out, capacity, link) == 0
        ? ResourceLookup::Found
        : ResourceLookup::StagingFailed;
}

enum class AttachmentPlanStatus {
    Ready,
    BadRequest,
    Forbidden,
    NotFound,
    PayloadTooLarge,
    ServerError,
};

struct AttachmentPlan {
    AttachmentPlanStatus status{AttachmentPlanStatus::BadRequest};
    const char* message{"attachments or resource_ids required"};
    wchar_t paths[1024]{};
};

AttachmentPlan make_attachment_plan(const wchar_t* local_paths,
                                    const wchar_t* resource_ids,
                                    bool allow_local_paths) {
    AttachmentPlan plan{};
    const bool has_local_paths = local_paths && local_paths[0];
    const bool has_resource_ids = resource_ids && resource_ids[0];
    if (has_local_paths && has_resource_ids) {
        plan.message = "attachments and resource_ids are mutually exclusive";
        return plan;
    }
    if (!has_local_paths && !has_resource_ids) {
        return plan;
    }
    if (has_resource_ids) {
        const wchar_t* cursor = resource_ids;
        size_t joined_length = 0;
        int count = 0;
        while (cursor && *cursor) {
            if (count >= kMaxResourcesPerRequest) {
                plan.message = "invalid resource_ids";
                return plan;
            }
            const wchar_t* separator = wcschr(cursor, L';');
            const size_t length = separator
                ? static_cast<size_t>(separator - cursor)
                : wcslen(cursor);
            if (length == 0 || length >= 64
                || (separator && separator[1] == 0)) {
                plan.message = "invalid resource_ids";
                return plan;
            }
            wchar_t id[64]{};
            wcsncpy_s(id, ARRAYSIZE(id), cursor, length);
            if (!valid_resource_id(id)) {
                plan.message = "invalid resource_ids";
                return plan;
            }
            wchar_t path[MAX_PATH]{};
            const ResourceLookup lookup =
                stage_resource_path(id, path, ARRAYSIZE(path));
            if (lookup == ResourceLookup::NotFound) {
                plan.status = AttachmentPlanStatus::NotFound;
                plan.message = "resource not found";
                return plan;
            }
            if (lookup == ResourceLookup::StagingFailed) {
                plan.status = AttachmentPlanStatus::ServerError;
                plan.message = "resource staging failed";
                return plan;
            }
            const size_t path_length = wcslen(path);
            if (joined_length + (count > 0 ? 1 : 0) + path_length + 1
                > ARRAYSIZE(plan.paths)) {
                plan.status = AttachmentPlanStatus::PayloadTooLarge;
                plan.message = "resource paths too long";
                return plan;
            }
            if (count > 0) {
                plan.paths[joined_length++] = L';';
            }
            wcsncpy_s(plan.paths + joined_length,
                      ARRAYSIZE(plan.paths) - joined_length, path, _TRUNCATE);
            joined_length += path_length;
            ++count;
            cursor = separator ? separator + 1 : nullptr;
        }
        if (count == 0) {
            plan.message = "invalid resource_ids";
            return plan;
        }
        plan.status = AttachmentPlanStatus::Ready;
        return plan;
    }

    if (!allow_local_paths) {
        plan.status = AttachmentPlanStatus::Forbidden;
        plan.message =
            "local attachment paths are only available on loopback; use resource_ids";
        return plan;
    }
    const size_t local_length = wcslen(local_paths);
    if (local_length >= ARRAYSIZE(plan.paths)) {
        plan.status = AttachmentPlanStatus::PayloadTooLarge;
        plan.message = "attachment paths too long";
        return plan;
    }
    wcscpy_s(plan.paths, local_paths);
    plan.status = AttachmentPlanStatus::Ready;
    return plan;
}

int attachment_http_status(AttachmentPlanStatus status) {
    switch (status) {
    case AttachmentPlanStatus::Forbidden: return 403;
    case AttachmentPlanStatus::NotFound: return 404;
    case AttachmentPlanStatus::PayloadTooLarge: return 413;
    case AttachmentPlanStatus::ServerError: return 500;
    case AttachmentPlanStatus::Ready:
    case AttachmentPlanStatus::BadRequest:
    default: return 400;
    }
}

void respond_attachment_plan_error(SOCKET client, bool webhook,
                                   const AttachmentPlan& plan) {
    const int status = attachment_http_status(plan.status);
    if (webhook) {
        respond_webhook_error(client, status, plan.message);
    } else {
        respond_error(client, status, plan.message);
    }
}

bool send_resource_upload(SOCKET client, const char* request,
                          const char* body_start, int total,
                          unsigned long long content_length,
                          ULONGLONG deadline) {
    char filename_text[512]{};
    char sha_text[129]{};
    const bool has_filename =
        header_value(request, "X-SuperTime-Filename", filename_text,
                     sizeof(filename_text));
    const bool has_sha256 =
        header_value(request, "X-SuperTime-SHA256", sha_text,
                     sizeof(sha_text));
    if (!has_filename || !has_sha256) {
        respond(client, 400,
                resource_error_json(400, "filename and sha256 headers required").c_str());
        return false;
    }
    for (const char* p = sha_text; *p; ++p) {
        if (!isxdigit(static_cast<unsigned char>(*p))) {
            respond(client, 400,
                    resource_error_json(400, "invalid sha256 header").c_str());
            return false;
        }
    }
    if (strlen(sha_text) != 64) {
        respond(client, 400,
                resource_error_json(400, "invalid sha256 header").c_str());
        return false;
    }
    wchar_t filename[256]{};
    wchar_t safe_name[256]{};
    char utf8_name[512]{};
    if (!header_utf8_to_wide(filename_text, filename, ARRAYSIZE(filename))
        || !safe_resource_filename(filename, safe_name, ARRAYSIZE(safe_name))
        || WideCharToMultiByte(CP_UTF8, 0, safe_name, -1, utf8_name,
                               sizeof(utf8_name), nullptr, nullptr) <= 0) {
        respond(client, 400,
                resource_error_json(400, "invalid filename header").c_str());
        return false;
    }
    unsigned char random_bytes[20]{};
    if (BCryptGenRandom(nullptr, random_bytes, sizeof(random_bytes),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
        respond(client, 500,
                resource_error_json(500, "resource id generation failed").c_str());
        return false;
    }
    wchar_t resource_id[41]{};
    const char* digits = "0123456789abcdef";
    for (int index = 0; index < 20; ++index) {
        resource_id[index * 2] = static_cast<wchar_t>(digits[random_bytes[index] >> 4]);
        resource_id[index * 2 + 1] = static_cast<wchar_t>(digits[random_bytes[index] & 0x0F]);
    }
    resource_id[40] = 0;
    wchar_t path[MAX_PATH]{};
    if (!resource_path_from_id(resource_id, safe_name, path, ARRAYSIZE(path))) {
        respond(client, 500,
                resource_error_json(500, "spool path unavailable").c_str());
        return false;
    }
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                              FILE_ATTRIBUTE_TEMPORARY, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        respond(client, 500,
                resource_error_json(500, "spool write failed").c_str());
        return false;
    }

    // The request body may already contain bytes read with the headers. Copy
    // those first, then stream the remainder. Nothing is buffered in memory
    // beyond this fixed chunk.
    unsigned long long written_total = 0;
    bool write_ok = true;
    const char* available_start = body_start;
    const int available_now = std::max(0, total - static_cast<int>(body_start - request));
    if (available_now > 0) {
        const int take = static_cast<int>((std::min<unsigned long long>)(
            static_cast<unsigned long long>(available_now), content_length));
        DWORD written = 0;
        write_ok = WriteFile(file, available_start, take, &written, nullptr)
            != FALSE && written == static_cast<DWORD>(take);
        written_total += static_cast<unsigned long long>(take);
    }
    std::vector<char> chunk(64 * 1024);
    bool timed_out = false;
    while (write_ok && written_total < content_length) {
        const unsigned long long remaining = content_length - written_total;
        const DWORD wanted = static_cast<DWORD>((std::min<unsigned long long>)(
            remaining, chunk.size()));
        const int received = recv_until(client, chunk.data(),
                                        static_cast<int>(wanted), deadline);
        if (received <= 0) {
            timed_out = received == kRecvTimedOut;
            write_ok = false;
            break;
        }
        DWORD written = 0;
        write_ok = WriteFile(file, chunk.data(), static_cast<DWORD>(received),
                             &written, nullptr) != FALSE
            && written == static_cast<DWORD>(received);
        written_total += static_cast<unsigned long long>(received);
    }
    FlushFileBuffers(file);
    CloseHandle(file);
    if (!write_ok || written_total != content_length) {
        DeleteFileW(path);
        if (timed_out) {
            respond(client, 408,
                    resource_error_json(408, "request timeout").c_str());
        } else {
            respond(client, 400,
                    resource_error_json(400, "incomplete resource body").c_str());
        }
        return false;
    }

    // Hash the completed spool file in fixed-size chunks. This avoids keeping a
    // second 20 MB copy in memory.
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    BCRYPT_HASH_HANDLE hash = nullptr;
    DWORD object_length = 0;
    DWORD hash_length = 0;
    DWORD ignored = 0;
    std::vector<unsigned char> hash_object;
    std::vector<unsigned char> digest;
    bool hash_ready = false;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
                                    nullptr, 0) >= 0
        && BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                             reinterpret_cast<PUCHAR>(&object_length),
                             sizeof(object_length), &ignored, 0) >= 0
        && BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                             reinterpret_cast<PUCHAR>(&hash_length),
                             sizeof(hash_length), &ignored, 0) >= 0) {
        hash_object.resize(object_length);
        digest.resize(hash_length);
        hash_ready = BCryptCreateHash(algorithm, &hash, hash_object.data(),
                                      object_length, nullptr, 0, 0) >= 0;
    }
    HANDLE read_file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr,
                                   OPEN_EXISTING, FILE_ATTRIBUTE_TEMPORARY, nullptr);
    bool read_ok = read_file != INVALID_HANDLE_VALUE && hash_ready;
    while (read_ok) {
        DWORD read = 0;
        if (ReadFile(read_file, chunk.data(), static_cast<DWORD>(chunk.size()),
                     &read, nullptr) == FALSE) {
            read_ok = false;
            break;
        }
        if (read == 0) break;
        if (BCryptHashData(hash, reinterpret_cast<PUCHAR>(chunk.data()), read,
                           0) < 0) {
            read_ok = false;
        }
    }
    if (read_file != INVALID_HANDLE_VALUE) CloseHandle(read_file);
    std::string actual;
    if (read_ok && BCryptFinishHash(hash, digest.data(), hash_length, 0) >= 0) {
        const char* hex_chars = "0123456789abcdef";
        actual.resize(hash_length * 2);
        for (size_t index = 0; index < hash_length; ++index) {
            actual[index * 2] = hex_chars[digest[index] >> 4];
            actual[index * 2 + 1] = hex_chars[digest[index] & 0x0F];
        }
    }
    if (hash) BCryptDestroyHash(hash);
    if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
    if (!read_ok || actual.size() != 64
        || _stricmp(actual.c_str(), sha_text) != 0) {
        DeleteFileW(path);
        respond(client, 400,
                resource_error_json(400, "sha256 mismatch").c_str());
        return false;
    }
    if (!write_resource_meta(resource_id, safe_name, content_length, actual)) {
        DeleteFileW(path);
        respond(client, 500,
                resource_error_json(500, "resource metadata write failed").c_str());
        return false;
    }
    std::string response = "{\"ok\":true,\"id\":\"";
    const int id_length = WideCharToMultiByte(CP_UTF8, 0, resource_id, -1,
                                               nullptr, 0, nullptr, nullptr);
    std::string id_utf8(static_cast<size_t>(id_length), '\0');
    if (WideCharToMultiByte(CP_UTF8, 0, resource_id, -1, id_utf8.data(),
                            id_length, nullptr, nullptr) != id_length) {
        DeleteFileW(path);
        respond(client, 500,
                resource_error_json(500, "resource response failed").c_str());
        return false;
    }
    id_utf8.resize(static_cast<size_t>(id_length - 1));
    response += id_utf8 + "\",\"name\":\"" + utf8_name
        + "\",\"size\":" + std::to_string(content_length)
        + ",\"sha256\":\"" + actual + "\"}";
    cleanup_resource_spool();
    respond(client, 201, response.c_str());
    return true;
}

bool read_text_file(const wchar_t* path, char* text, size_t capacity) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    char buffer[128]{};
    DWORD read = 0;
    const BOOL ok = ReadFile(file, buffer, sizeof(buffer) - 1, &read, nullptr);
    CloseHandle(file);
    if (!ok || read == 0) {
        return false;
    }
    size_t length = 0;
    while (length < read
           && !isspace(static_cast<unsigned char>(buffer[length]))) {
        ++length;
    }
    if (length == 0 || length >= capacity) {
        return false;
    }
    memcpy(text, buffer, length);
    text[length] = 0;
    return true;
}

bool write_text_file(const wchar_t* path, const char* text) {
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    const DWORD length = static_cast<DWORD>(strlen(text));
    DWORD written = 0;
    const BOOL ok = WriteFile(file, text, length, &written, nullptr)
        && written == length
        && WriteFile(file, "\r\n", 2, &written, nullptr)
        && written == 2;
    CloseHandle(file);
    return ok != FALSE;
}

bool valid_token_text(const char* text) {
    if (strlen(text) != 32) {
        return false;
    }
    for (int index = 0; index < 32; ++index) {
        if (!isxdigit(static_cast<unsigned char>(text[index]))) {
            return false;
        }
    }
    return true;
}

bool generate_token(char* token) {
    unsigned char bytes[16]{};
    if (BCryptGenRandom(nullptr, bytes, sizeof(bytes),
                         BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
        return false;
    }
    const char* hex = "0123456789abcdef";
    for (int index = 0; index < 16; ++index) {
        token[index * 2] = hex[bytes[index] >> 4];
        token[index * 2 + 1] = hex[bytes[index] & 0x0F];
    }
    token[32] = 0;
    return true;
}

// Constant-time over the 32 token characters; only the (public) token length
// affects timing.
bool token_matches(const char* candidate) {
    if (!g_lock_ready || !candidate) {
        return false;
    }
    char expected[sizeof(g_token)]{};
    EnterCriticalSection(&g_lock);
    memcpy(expected, g_token, sizeof(expected));
    LeaveCriticalSection(&g_lock);
    const size_t expected_length = strnlen(expected, sizeof(expected));
    const size_t candidate_length = strnlen(candidate, sizeof(expected));
    unsigned char difference =
        expected_length == 32 && candidate_length == 32 ? 0 : 1;
    for (size_t index = 0; index < 32; ++index) {
        const char actual = index < candidate_length ? candidate[index] : 0;
        difference |= static_cast<unsigned char>(actual ^ expected[index]);
    }
    SecureZeroMemory(expected, sizeof(expected));
    return difference == 0;
}

// Any attempted delivery without positive content verification is uncertain,
// even when the automation itself reported success.
bool job_delivery_uncertain(const feather::queue::Job& job) {
    return job.delivery_attempted
        && (job.state == feather::queue::JobState::Failed
            || !job.content_verified);
}

struct JobWrite {
    int status{500};
    const char* message{"queue write failed"};
    char api_id[feather::queue::kApiIdLength + 1]{};
};

JobWrite write_job(const feather::queue::Job& job) {
    JobWrite result{};
    if (InterlockedCompareExchange(&g_stopping, 0, 0) != 0) {
        result.status = 503;
        result.message = "service stopping";
        return result;
    }
    feather::queue::Job stored{};
    DWORD error = ERROR_SUCCESS;
    if (!feather::queue::enqueue(job, &stored, &error)) {
        if (error == ERROR_NOT_ENOUGH_QUOTA) {
            result.status = 503;
            result.message = "job queue full";
        }
        return result;
    }
    if (g_ui_window) {
        PostMessageW(g_ui_window, g_notify_message, 0, 0);
    }
    result.status = 202;
    result.message = nullptr;
    strcpy_s(result.api_id, stored.api_id);
    return result;
}

// Webhook responses carry an explicit "ok" flag for external platforms; the
// queue semantics are identical.
void respond_job_write(SOCKET client, bool webhook, const JobWrite& write) {
    if (write.status != 202) {
        if (webhook) {
            respond_webhook_error(client, write.status, write.message);
        } else {
            respond_error(client, write.status, write.message);
        }
        return;
    }
    char body[160]{};
    snprintf(body, sizeof(body),
             webhook ? "{\"ok\":true,\"id\":\"%s\",\"state\":\"queued\"}"
                     : "{\"id\":\"%s\",\"state\":\"queued\"}",
             write.api_id);
    respond(client, 202, body);
}

/**
 * 入队前的授权闸门。
 *
 * 这是「Super Time 没有可用授权就不发送」的最后一道服务端拦截：即使有人绕过
 * 界面直接调 HTTP / Webhook，只要票据失效（且宽限期结束），任务就进不了队列。
 * 读接口（health/status/jobs）不挡，方便宿主诊断。
 */
bool license_allows_enqueue(SOCKET client, bool webhook) {
    if (feather::license::available()) return true;
    if (webhook) {
        respond_webhook_error(client, 403, "license_required");
    } else {
        respond_error(client, 403, "license_required");
    }
    return false;
}

void enqueue_job(SOCKET client, bool webhook, const feather::queue::Job& job) {
    if (!license_allows_enqueue(client, webhook)) {
        return;
    }
    respond_job_write(client, webhook, write_job(job));
}

// Stages resources and stores the job under the spool lock, so housekeeping
// cannot delete a resource between being resolved and being referenced.
void enqueue_attachment_job(SOCKET client, bool webhook,
                            feather::queue::Job job,
                            const wchar_t* local_paths,
                            const wchar_t* resource_ids) {
    if (!license_allows_enqueue(client, webhook)) {
        return;
    }
    const bool allow_local_paths = client_allows_local_attachment_paths(client);
    AttachmentPlan plan{};
    JobWrite write{};
    {
        SpoolLock lock;
        plan = make_attachment_plan(local_paths, resource_ids,
                                    allow_local_paths);
        if (plan.status == AttachmentPlanStatus::Ready) {
            wcscpy_s(job.attachments, plan.paths);
            write = write_job(job);
        }
    }
    if (plan.status != AttachmentPlanStatus::Ready) {
        respond_attachment_plan_error(client, webhook, plan);
        return;
    }
    respond_job_write(client, webhook, write);
}

// Job ids are lowercase hex; lookups accept any case. False for ids that are
// empty, longer than 16 characters or not hex.
bool normalize_job_id(const char* id, char* out, size_t capacity) {
    const size_t length = strlen(id);
    if (length == 0 || length > feather::queue::kApiIdLength
        || length >= capacity) {
        return false;
    }
    for (size_t index = 0; index < length; ++index) {
        const unsigned char character = static_cast<unsigned char>(id[index]);
        if (!isxdigit(character)) {
            return false;
        }
        out[index] = static_cast<char>(tolower(character));
    }
    out[length] = 0;
    return true;
}

// Handles GET|POST /webhook/<32-hex API token>[/jobs/<1-16 hex job id>]. The
// token in the URL is the credential, so no Authorization header is required;
// Origin is still rejected so a web page cannot drive the queue cross-site.
// `rest` is the optional path after the 32-char key ("" when absent).
void handle_webhook(SOCKET client, const char* request, int total,
                    char* body_start, const char* method, const char* key,
                    const char* rest, ULONGLONG deadline) {
    char origin[8]{};
    if (header_value(request, "Origin", origin, sizeof(origin))) {
        respond_webhook_error(client, 403, "origin not allowed");
        return;
    }
    if (!key || !valid_token_text(key) || !token_matches(key)) {
        respond_webhook_error(client, 401, "invalid webhook key");
        return;
    }

    // 1.6.1: /webhook/<key>/jobs/<id> mirrors GET /api/jobs/<id> and adds
    // "ok":true; the webhook base route keeps its 1.6.0 GET/POST behavior.
    // The resource upload route is dispatched in the base-route section below.
    if (rest && rest[0]) {
        if (strncmp(rest, "/jobs/", 6) == 0) {
            if (strcmp(method, "GET") != 0) {
                respond_webhook_error(client, 405, "method not allowed");
                return;
            }
            char id[feather::queue::kApiIdLength + 1]{};
            feather::queue::Job job{};
            if (!normalize_job_id(rest + 6, id, sizeof(id))
                || !feather::queue::find(id, &job)) {
                respond_webhook_error(client, 404, "job not found");
                return;
            }
            char job_text[512]{};
            snprintf(job_text, sizeof(job_text),
                     "{\"ok\":true,\"id\":\"%s\",\"type\":\"%s\","
                     "\"state\":\"%s\",\"content_verified\":%s,"
                     "\"sent_count\":%d,\"mention_newline\":%s,"
                     "\"error\":%lu,\"delivery_attempted\":%s,"
                     "\"delivery_uncertain\":%s}",
                     job.api_id, feather::queue::type_name(job.type),
                     feather::queue::state_name(job.state),
                     job.content_verified ? "true" : "false",
                     job.sent_count,
                     job.mention_newline ? "true" : "false",
                     static_cast<unsigned long>(job.error),
                     job.delivery_attempted ? "true" : "false",
                     job_delivery_uncertain(job) ? "true" : "false");
            respond(client, 200, job_text);
            return;
        }
        if (strcmp(rest, "/resources") != 0) {
            respond_webhook_error(client, 404, "not found");
            return;
        }
    }

    const bool is_get = strcmp(method, "GET") == 0;
    const bool is_post = strcmp(method, "POST") == 0;
    if (!is_get && !is_post) {
        respond_webhook_error(client, 405, "method not allowed");
        return;
    }

    if (rest && strcmp(rest, "/resources") == 0) {
        if (!is_post) {
            respond_webhook_error(client, 405, "method not allowed");
            return;
        }
        const char* resource_content_type = nullptr;
        size_t resource_content_type_length = 0;
        if (!header_value_span(request, "Content-Type",
                               &resource_content_type,
                               &resource_content_type_length)
            || !media_type_matches(resource_content_type,
                                   resource_content_type_length,
                                   "application/octet-stream")) {
            respond_webhook_error(client, 415,
                                  "application/octet-stream required");
            return;
        }
        const ContentLengthHeader resource_length =
            parse_content_length(request, kMaxResourceBytes);
        if (resource_length.status == ContentLengthStatus::Missing) {
            respond_webhook_error(client, 411, "content-length required");
            return;
        }
        if (resource_length.status == ContentLengthStatus::Invalid) {
            respond_webhook_error(client, 400, "invalid content-length");
            return;
        }
        if (resource_length.status == ContentLengthStatus::TooLarge) {
            respond_webhook_error(client, 413,
                                  "resource payload too large");
            return;
        }
        if (resource_length.value == 0) {
            respond_webhook_error(client, 400, "resource payload required");
            return;
        }
        wchar_t resource_spool[MAX_PATH]{};
        if (!resource_directory(resource_spool,
                                ARRAYSIZE(resource_spool))) {
            respond_webhook_error(client, 500, "resource spool unavailable");
            return;
        }
        const ULONGLONG upload_deadline = deadline
            + resource_length.value * 1000ULL / kMinUploadBytesPerSecond;
        send_resource_upload(client, request, body_start, total,
                             resource_length.value, upload_deadline);
        return;
    }

    if (rest && rest[0]) {
        respond_webhook_error(client, 404, "not found");
        return;
    }

    if (is_get) {
        char body[192]{};
        snprintf(body, sizeof(body),
                 "{\"ok\":true,\"service\":\"supertime\",\"webhook\":true,"
                 "\"version\":\"%s\",\"api\":%d}",
                 FEATHER_VERSION_STRING, FEATHER_API_REVISION);
        respond(client, 200, body);
        return;
    }

    const char* content_type = nullptr;
    size_t content_type_length = 0;
    if (header_value_span(request, "Content-Type", &content_type,
                          &content_type_length)
        && !media_type_matches(content_type, content_type_length,
                               "application/json")
        && !media_type_matches(content_type, content_type_length,
                               "text/plain")) {
        respond_webhook_error(client, 415,
                              "json or text content-type required");
        return;
    }

    const ContentLengthHeader length =
        parse_content_length(request, kMaxRequestBytes);
    if (length.status == ContentLengthStatus::Missing) {
        respond_webhook_error(client, 411, "content-length required");
        return;
    }
    if (length.status == ContentLengthStatus::Invalid) {
        respond_webhook_error(client, 400, "invalid content-length");
        return;
    }
    if (length.status == ContentLengthStatus::TooLarge) {
        respond_webhook_error(client, 413, "payload too large");
        return;
    }
    const int content_length = static_cast<int>(length.value);
    const int body_offset = static_cast<int>(body_start - request);
    int available = std::max(0, total - body_offset);
    while (available < content_length) {
        const int received = recv_until(client, body_start + available,
                                        content_length - available, deadline);
        if (received == kRecvTimedOut) {
            respond_webhook_error(client, 408, "request timeout");
            return;
        }
        if (received <= 0) {
            respond_webhook_error(client, 400, "incomplete body");
            return;
        }
        available += received;
    }
    body_start[content_length] = 0;

    if (content_length == 0) {
        respond_webhook_error(client, 400, "empty body");
        return;
    }
    wchar_t wide_body[kMaxRequestBytes + 1]{};
    const int wide_length = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, body_start, content_length,
        wide_body, kMaxRequestBytes);
    if (wide_length <= 0) {
        respond_webhook_error(client, 400, "invalid utf-8");
        return;
    }
    wide_body[wide_length] = 0;

    RequestFields fields{};
    const JsonParseStatus json_status = parse_request_fields(
        wide_body, kWebhookAliases, ARRAYSIZE(kWebhookAliases), &fields);
    if (json_status != JsonParseStatus::Ok) {
        respond_webhook_error(client, 400,
                              request_fields_error(json_status, fields));
        return;
    }

    // mention_separator / mention_newline mirror /api/send-message semantics.
    bool mention_newline = false;
    if (fields.mention_separator[0]) {
        if (_wcsicmp(fields.mention_separator, L"newline") == 0
            || wcscmp(fields.mention_separator, L"换行") == 0) {
            mention_newline = true;
        } else if (_wcsicmp(fields.mention_separator, L"space") == 0
                   || wcscmp(fields.mention_separator, L"空格") == 0) {
            mention_newline = false;
        } else {
            respond_webhook_error(client, 400,
                                  "invalid mention_separator (space|newline)");
            return;
        }
    } else if (fields.mention_newline_set) {
        mention_newline = fields.mention_newline;
    }

    if (fields.attachments[0] && fields.resource_ids[0]) {
        respond_webhook_error(
            client, 400,
            "attachments and resource_ids are mutually exclusive");
        return;
    }

    bool attachments_task = fields.attachments[0] != 0 || fields.resource_ids[0] != 0;
    if (fields.type[0]) {
        if (_wcsicmp(fields.type, L"message") == 0
            || _wcsicmp(fields.type, L"text") == 0) {
            attachments_task = false;
        } else if (_wcsicmp(fields.type, L"attachments") == 0
                   || _wcsicmp(fields.type, L"attachment") == 0
                   || _wcsicmp(fields.type, L"file") == 0
                   || _wcsicmp(fields.type, L"files") == 0) {
            attachments_task = true;
        } else {
            respond_webhook_error(client, 400,
                                  "invalid type (message|attachments)");
            return;
        }
    }

    if (!fields.target[0]) {
        respond_webhook_error(client, 400, "target is required");
        return;
    }
    feather::queue::Job job{};
    wcscpy_s(job.source, L"webhook");
    wcscpy_s(job.target, fields.target);
    if (attachments_task) {
        job.type = feather::queue::JobType::Attachments;
        enqueue_attachment_job(client, true, job, fields.attachments,
                               fields.resource_ids);
        return;
    }
    if (!fields.message[0]) {
        respond_webhook_error(client, 400, "target and message required");
        return;
    }
    job.type = feather::queue::JobType::Message;
    wcscpy_s(job.message, fields.message);
    wcscpy_s(job.mention, fields.mention);
    job.mention_newline = mention_newline;
    enqueue_job(client, true, job);
}

// Offset of the blank line ending the headers within data, or -1.
int find_header_end(const char* data, int length) {
    for (int index = 0; index + 3 < length; ++index) {
        if (data[index] == '\r' && data[index + 1] == '\n'
            && data[index + 2] == '\r' && data[index + 3] == '\n') {
            return index;
        }
    }
    return -1;
}

void handle_client(SOCKET client) {
    const ULONGLONG deadline = GetTickCount64() + kRequestDeadlineMs;
    DWORD timeout = 5000;
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO,
               reinterpret_cast<const char*>(&timeout), sizeof(timeout));

    // Uploads use a dedicated streaming path. The buffer holds the header
    // budget plus the 8 KiB JSON body; the upload route keeps only the body
    // prefix read with the headers and streams the rest into the spool file.
    constexpr int kRequestHeaderBudget = 16 * 1024;
    std::vector<char> request_buffer(kRequestHeaderBudget + kMaxRequestBytes + 1);
    char* request = request_buffer.data();
    int total = 0;
    char* header_end = nullptr;
    while (total < kRequestHeaderBudget) {
        const int received = recv_until(client, request + total,
                                        kRequestHeaderBudget - total, deadline);
        if (received == kRecvTimedOut) {
            respond_error(client, 408, "request timeout");
            return;
        }
        if (received <= 0) {
            respond_error(client, 400, "incomplete request");
            return;
        }
        const int scan_from = std::max(0, total - 3);
        total += received;
        request[total] = 0;
        const int end = find_header_end(request + scan_from, total - scan_from);
        const int header_bytes = end >= 0 ? scan_from + end : total;
        // The string helpers below stop at NUL, so it must not hide header text.
        if (memchr(request, 0, static_cast<size_t>(header_bytes))) {
            respond_error(client, 400, "invalid request headers");
            return;
        }
        if (end >= 0) {
            header_end = request + header_bytes;
            break;
        }
    }
    if (!header_end) {
        respond_error(client, 413, "headers too large");
        return;
    }

    char method[8]{};
    char path[256]{};
    const char* first_space = strchr(request, ' ');
    if (!first_space || first_space == request) {
        respond_error(client, 400, "invalid request line");
        return;
    }
    const size_t method_length = static_cast<size_t>(first_space - request);
    if (method_length >= sizeof(method)) {
        respond_error(client, 405, "method not allowed");
        return;
    }
    memcpy(method, request, method_length);
    const char* after_method = first_space + 1;
    const char* second_space = strchr(after_method, ' ');
    if (!second_space) {
        respond_error(client, 400, "invalid request line");
        return;
    }
    size_t path_length = static_cast<size_t>(second_space - after_method);
    const char* query = strchr(after_method, '?');
    if (query && query < second_space) {
        path_length = static_cast<size_t>(query - after_method);
    }
    if (path_length == 0 || path_length >= sizeof(path)) {
        respond_error(client, 404, "not found");
        return;
    }
    memcpy(path, after_method, path_length);
    path[path_length] = 0;

    const bool stopping =
        InterlockedCompareExchange(&g_stopping, 0, 0) != 0;
    const bool stop_request =
        strcmp(method, "POST") == 0 && strcmp(path, "/api/stop") == 0;
    if (stopping && !stop_request && strcmp(method, "GET") != 0) {
        if (strcmp(path, "/webhook") == 0
            || strncmp(path, "/webhook/", 9) == 0) {
            respond_webhook_error(client, 503, "service stopping");
        } else {
            respond_error(client, 503, "service stopping");
        }
        return;
    }

    // Inbound webhook (1.6.1): the 32-hex API token travels in the URL,
    // optionally followed by /jobs/<id>, so these routes are dispatched before
    // the Bearer requirement applies.
    if (strcmp(path, "/webhook") == 0) {
        handle_webhook(client, request, total, header_end + 4, method, nullptr,
                       nullptr, deadline);
        return;
    }
    if (strncmp(path, "/webhook/", 9) == 0) {
        const char* after_prefix = path + 9;
        const size_t available = strlen(after_prefix);
        const size_t key_length = available < 32 ? available : 32;
        char webhook_key[33]{};
        memcpy(webhook_key, after_prefix, key_length);
        webhook_key[key_length] = 0;
        handle_webhook(client, request, total, header_end + 4, method,
                       webhook_key, after_prefix + key_length, deadline);
        return;
    }

    char authorization[128]{};
    if (!header_value(request, "Authorization", authorization,
                      sizeof(authorization))) {
        respond_error(client, 401, "unauthorized");
        return;
    }
    const char* token = authorization;
    if (_strnicmp(token, "Bearer ", 7) != 0) {
        respond_error(client, 401, "unauthorized");
        return;
    }
    token += 7;
    if (!token_matches(token)) {
        respond_error(client, 401, "unauthorized");
        return;
    }

    char origin[8]{};
    if (header_value(request, "Origin", origin, sizeof(origin))) {
        respond_error(client, 403, "origin not allowed");
        return;
    }

    const bool is_post = strcmp(method, "POST") == 0;
    const bool is_get = strcmp(method, "GET") == 0;
    if (!is_post && !is_get) {
        respond_error(client, 405, "method not allowed");
        return;
    }

    // Remote stop (1.5.0): release the mouse guard immediately and ask the UI
    // thread to exit. No request body is required.
    if (is_post && strcmp(path, "/api/stop") == 0) {
        InterlockedExchange(&g_stopping, 1);
        set_local_attachment_paths_allowed(false);
        respond(client, 202, "{\"ok\":true,\"state\":\"stopping\"}");
        feather::automation::emergency_stop_input();
        if (g_ui_window) {
            PostMessageW(g_ui_window, g_exit_message, 0, 0);
        }
        return;
    }

    char* body = header_end + 4;
    int content_length = 0;
    if (is_post) {
        const char* content_type = nullptr;
        size_t content_type_length = 0;
        if (!header_value_span(request, "Content-Type", &content_type,
                               &content_type_length)
            || !media_type_matches(content_type, content_type_length,
                                   "application/json")) {
            respond_error(client, 415, "application/json required");
            return;
        }
        const ContentLengthHeader length =
            parse_content_length(request, kMaxRequestBytes);
        if (length.status == ContentLengthStatus::Missing) {
            respond_error(client, 411, "content-length required");
            return;
        }
        if (length.status == ContentLengthStatus::Invalid) {
            respond_error(client, 400, "invalid content-length");
            return;
        }
        if (length.status == ContentLengthStatus::TooLarge) {
            respond_error(client, 413, "payload too large");
            return;
        }
        content_length = static_cast<int>(length.value);
        const int body_offset = static_cast<int>(body - request);
        int available = std::max(0, total - body_offset);
        while (available < content_length) {
            const int received = recv_until(client, body + available,
                                            content_length - available,
                                            deadline);
            if (received == kRecvTimedOut) {
                respond_error(client, 408, "request timeout");
                return;
            }
            if (received <= 0) {
                respond_error(client, 400, "incomplete body");
                return;
            }
            available += received;
            total += received;
        }
        body[content_length] = 0;
    }

    if (is_get) {
        if (strcmp(path, "/api/health") == 0) {
            char body_text[320]{};
            snprintf(body_text, sizeof(body_text),
                     "{\"ok\":true,\"service\":\"supertime\",\"port\":%u,"
                     "\"version\":\"%s\",\"api\":%d,"
                     "\"webhook\":true,\"license\":%s}",
                     static_cast<unsigned>(g_port), FEATHER_VERSION_STRING,
                     FEATHER_API_REVISION, feather::license::status_json().c_str());
            respond(client, 200, body_text);
            return;
        }
        if (strcmp(path, "/api/status") == 0) {
            feather::queue::Job rows[feather::queue::kViewCapacity]{};
            feather::queue::Stats stats{};
            feather::queue::view(rows, feather::queue::kViewCapacity, &stats);
            const feather::automation::WeChatStatus wechat =
                feather::automation::query_wechat();
            const bool window_visible =
                wechat.main_window_handle
                && IsWindowVisible(wechat.main_window_handle) != FALSE;
            const bool logged_in =
                wechat.login_state
                == feather::automation::WeChatLoginState::LoggedIn;
            char body_text[768]{};
            snprintf(body_text, sizeof(body_text),
                     "{\"service\":\"supertime\",\"version\":\"%s\",\"api\":%d,"
                     "\"queue\":{\"queued\":%d,\"running\":%d,"
                     "\"succeeded\":%d,\"failed\":%d},"
                     "\"mouse_guard\":{\"active\":%s,\"aborted\":%s,"
                     "\"timeout_ms\":%u},"
                     "\"wechat\":{\"running\":%s,\"logged_in\":%s,"
                     "\"window_visible\":%s},\"license\":%s}",
                     FEATHER_VERSION_STRING, FEATHER_API_REVISION,
                     stats.queued, stats.running, stats.succeeded, stats.failed,
                     feather::automation::input_guard_active() ? "true"
                                                                : "false",
                     feather::automation::automation_aborted() ? "true"
                                                               : "false",
                     feather::automation::input_guard_timeout_ms(),
                     wechat.running ? "true" : "false",
                     logged_in ? "true" : "false",
                     window_visible ? "true" : "false",
                     feather::license::status_json().c_str());
            respond(client, 200, body_text);
            return;
        }
        constexpr const char* kJobPrefix = "/api/jobs/";
        const size_t prefix_length = strlen(kJobPrefix);
        if (strncmp(path, kJobPrefix, prefix_length) == 0) {
            char id[feather::queue::kApiIdLength + 1]{};
            feather::queue::Job job{};
            if (!normalize_job_id(path + prefix_length, id, sizeof(id))
                || !feather::queue::find(id, &job)) {
                respond_error(client, 404, "job not found");
                return;
            }
            char job_text[512]{};
            snprintf(job_text, sizeof(job_text),
                     "{\"id\":\"%s\",\"type\":\"%s\",\"state\":\"%s\","
                     "\"content_verified\":%s,\"sent_count\":%d,"
                     "\"mention_newline\":%s,\"error\":%lu,"
                     "\"delivery_attempted\":%s,"
                     "\"delivery_uncertain\":%s}",
                     job.api_id, feather::queue::type_name(job.type),
                     feather::queue::state_name(job.state),
                     job.content_verified ? "true" : "false",
                     job.sent_count,
                     job.mention_newline ? "true" : "false",
                     static_cast<unsigned long>(job.error),
                     job.delivery_attempted ? "true" : "false",
                     job_delivery_uncertain(job) ? "true" : "false");
            respond(client, 200, job_text);
            return;
        }
        respond_error(client, 404, "not found");
        return;
    }

    wchar_t wide_body[kMaxRequestBytes + 1]{};
    const int wide_length = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, body, content_length,
        wide_body, kMaxRequestBytes);
    if (wide_length <= 0) {
        respond_error(client, 400, "invalid utf-8");
        return;
    }
    wide_body[wide_length] = 0;

    // 跨机托管：托管主机在这里推送运行票据（本机模式走命名管道，不经过这里）。
    if (strcmp(path, "/api/license/lease") == 0) {
        char claim[4096]{};
        char mac[128]{};
        if (!json_string_field(body, "claim", claim, ARRAYSIZE(claim))
            || !json_string_field(body, "mac", mac, ARRAYSIZE(mac))) {
            respond_error(client, 400, "claim and mac are required");
            return;
        }
        if (!feather::license::acceptTicket(claim, mac)) {
            respond(client, 403, feather::license::status_json().c_str());
            return;
        }
        respond(client, 200, feather::license::status_json().c_str());
        return;
    }

    const bool send_message = strcmp(path, "/api/send-message") == 0;
    if (!send_message && strcmp(path, "/api/send-attachments") != 0) {
        respond_error(client, 404, "not found");
        return;
    }

    RequestFields fields{};
    const JsonParseStatus json_status = parse_request_fields(
        wide_body, kApiAliases, ARRAYSIZE(kApiAliases), &fields);
    if (json_status != JsonParseStatus::Ok) {
        respond_error(client, 400, request_fields_error(json_status, fields));
        return;
    }

    feather::queue::Job job{};
    wcscpy_s(job.source, L"api");
    if (!send_message) {
        if (!fields.target[0]) {
            respond_error(client, 400, "target is required");
            return;
        }
        job.type = feather::queue::JobType::Attachments;
        wcscpy_s(job.target, fields.target);
        enqueue_attachment_job(client, false, job, fields.attachments,
                               fields.resource_ids);
        return;
    }

    if (!fields.target[0] || !fields.message[0]) {
        respond_error(client, 400, "target and message required");
        return;
    }
    job.type = feather::queue::JobType::Message;
    wcscpy_s(job.target, fields.target);
    wcscpy_s(job.message, fields.message);
    wcscpy_s(job.mention, fields.mention);

    // 可选：@ 成员与正文之间用空格还是换行。
    //   mention_separator: "space" | "newline"（也接受 空格/换行）
    //   mention_newline:   true | false（别名）
    if (fields.mention_separator[0]) {
        if (_wcsicmp(fields.mention_separator, L"newline") == 0
            || wcscmp(fields.mention_separator, L"换行") == 0) {
            job.mention_newline = true;
        } else if (_wcsicmp(fields.mention_separator, L"space") == 0
                   || wcscmp(fields.mention_separator, L"空格") == 0) {
            job.mention_newline = false;
        } else {
            respond_error(client, 400,
                          "invalid mention_separator (space|newline)");
            return;
        }
    } else if (fields.mention_newline_set) {
        job.mention_newline = fields.mention_newline;
    }
    enqueue_job(client, false, job);
}

// Finishes a served connection without turning the response into a TCP RST.
// Rejected POSTs (for example a 415 before the body is read) leave unread bytes
// in the receive buffer; closing such a socket makes Windows reset the
// connection and some clients then report a transport error instead of the
// HTTP status. Sending FIN first and draining what the peer already sent keeps
// the response deliverable. The drain has its own short deadline so a peer
// trickling bytes cannot keep the connection open.
void close_client_gracefully(SOCKET client, ULONGLONG drain_ms) {
    shutdown(client, SD_SEND);
    const ULONGLONG deadline = GetTickCount64() + drain_ms;
    char discard[1024];
    int drained = 0;
    while (drained <= kMaxRequestBytes) {
        const int received = recv_until(client, discard, sizeof(discard),
                                        deadline);
        if (received <= 0) {
            break;
        }
        drained += received;
    }
    closesocket(client);
}

DWORD WINAPI worker_thread(LPVOID parameter) {
    Worker& worker = g_workers[reinterpret_cast<INT_PTR>(parameter)];
    EnterCriticalSection(&g_lock);
    const SOCKET client = worker.client;
    LeaveCriticalSection(&g_lock);
    if (client == INVALID_SOCKET) {
        return 0;
    }

    handle_client(client);

    bool should_close = false;
    EnterCriticalSection(&g_lock);
    if (worker.client == client) {
        worker.client = INVALID_SOCKET;
        should_close = true;
    }
    LeaveCriticalSection(&g_lock);
    if (should_close) {
        close_client_gracefully(client, kCloseDrainMs);
    }
    return 0;
}

// Closes handles of finished workers and returns a free slot, or -1 when all
// kMaxWorkers are busy. Caller holds g_lock.
int reap_workers_locked() {
    int free_slot = -1;
    for (int index = 0; index < kMaxWorkers; ++index) {
        Worker& worker = g_workers[index];
        if (worker.thread
            && WaitForSingleObject(worker.thread, 0) == WAIT_OBJECT_0) {
            CloseHandle(worker.thread);
            worker.thread = nullptr;
            worker.client = INVALID_SOCKET;
        }
        if (!worker.thread && free_slot < 0) {
            free_slot = index;
        }
    }
    return free_slot;
}

// Accepts connections and hands each to a worker thread. Handlers share only
// g_lock-protected state (token, worker table), the internally locked queue,
// the spool lock, and Interlocked/PostMessage calls into automation and UI.
DWORD WINAPI server_thread(LPVOID) {
    const SOCKET listen_socket = g_listen;
    while (InterlockedCompareExchange(&g_stopping, 0, 0) == 0) {
        SOCKET client = accept(listen_socket, nullptr, nullptr);
        if (client == INVALID_SOCKET) {
            if (InterlockedCompareExchange(&g_stopping, 0, 0) != 0) {
                break;
            }
            Sleep(50);
            continue;
        }
        bool started = false;
        EnterCriticalSection(&g_lock);
        const int slot = reap_workers_locked();
        if (slot >= 0) {
            Worker& worker = g_workers[slot];
            worker.client = client;
            worker.thread = CreateThread(
                nullptr, kWorkerStackBytes, worker_thread,
                reinterpret_cast<LPVOID>(static_cast<INT_PTR>(slot)),
                STACK_SIZE_PARAM_IS_A_RESERVATION, nullptr);
            started = worker.thread != nullptr;
            if (!started) {
                worker.client = INVALID_SOCKET;
            }
        }
        LeaveCriticalSection(&g_lock);
        if (!started) {
            DWORD timeout = 1000;
            setsockopt(client, SOL_SOCKET, SO_SNDTIMEO,
                       reinterpret_cast<const char*>(&timeout),
                       sizeof(timeout));
            respond_error(client, 503, "server busy");
            close_client_gracefully(client, 50);
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Listening configuration: the optional api-listen.txt next to the executable
// selects the bind address. Missing/empty now means LAN (0.0.0.0) so other
// computers on the same network can call the API; write "loopback" /
// "127.0.0.1" to restrict it to this machine, or a concrete IPv4 literal.
// Every request still needs the bearer token.
// ---------------------------------------------------------------------------

enum class ListenMode {
    Loopback,    // 127.0.0.1: this machine only
    AnyAddress,  // 0.0.0.0: all IPv4 interfaces (default)
    Specific,    // one concrete IPv4 literal
    Invalid,     // unrecognized value: LAN request that cannot be honored
};

struct ListenConfig {
    ListenMode mode{ListenMode::AnyAddress};
    in_addr address{};
};

bool text_equals_ignore_case(const char* text, const char* value) {
    return _stricmp(text, value) == 0;
}

// Reads the first whitespace-delimited token of the optional config file.
// A missing or empty file is not an error: the caller keeps the default.
bool read_listen_token(const wchar_t* path, char* token, size_t capacity) {
    token[0] = 0;
    HANDLE file = CreateFileW(path, GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    char buffer[128]{};
    DWORD read = 0;
    const BOOL ok = ReadFile(file, buffer, sizeof(buffer), &read, nullptr);
    CloseHandle(file);
    if (!ok || read == 0) {
        return false;
    }
    size_t index = 0;
    if (read >= 3 && static_cast<unsigned char>(buffer[0]) == 0xEF
        && static_cast<unsigned char>(buffer[1]) == 0xBB
        && static_cast<unsigned char>(buffer[2]) == 0xBF) {
        index = 3;  // UTF-8 BOM
    }
    while (index < read
           && isspace(static_cast<unsigned char>(buffer[index]))) {
        ++index;
    }
    size_t length = 0;
    while (index < read && length + 1 < capacity
           && !isspace(static_cast<unsigned char>(buffer[index]))) {
        token[length++] = buffer[index++];
    }
    token[length] = 0;
    return length > 0;
}

ListenConfig load_listen_config(const wchar_t* path) {
    ListenConfig config{};
    char token[64]{};
    if (!read_listen_token(path, token, ARRAYSIZE(token))) {
        return config;
    }
    if (text_equals_ignore_case(token, "loopback") || strcmp(token, "0") == 0
        || strcmp(token, "127.0.0.1") == 0) {
        config.mode = ListenMode::Loopback;
        return config;
    }
    if (text_equals_ignore_case(token, "lan")
        || text_equals_ignore_case(token, "any")
        || text_equals_ignore_case(token, "all")
        || strcmp(token, "0.0.0.0") == 0 || strcmp(token, "*") == 0) {
        config.mode = ListenMode::AnyAddress;
        return config;
    }
    wchar_t wide_token[64]{};
    if (MultiByteToWideChar(CP_UTF8, 0, token, -1, wide_token,
                            ARRAYSIZE(wide_token)) > 0) {
        in_addr address{};
        if (InetPtonW(AF_INET, wide_token, &address) == 1) {
            config.mode = ListenMode::Specific;
            config.address = address;
            return config;
        }
    }
    // Unrecognized value: report it as a failed LAN request.
    config.mode = ListenMode::Invalid;
    return config;
}

// Binds a listening socket to `address` with an OS-assigned port. The actual
// port is written to api-port.txt so local callers can discover it.
SOCKET listen_on_address(in_addr address, unsigned short* port,
                         in_addr* actual_address, DWORD* error) {
    *port = 0;
    actual_address->s_addr = htonl(INADDR_ANY);
    *error = ERROR_SUCCESS;
    SOCKET listen_socket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listen_socket == INVALID_SOCKET) {
        *error = static_cast<DWORD>(WSAGetLastError());
        return INVALID_SOCKET;
    }
    sockaddr_in socket_address{};
    socket_address.sin_family = AF_INET;
    socket_address.sin_addr = address;
    socket_address.sin_port = 0;  // let the OS pick a free port
    if (bind(listen_socket,
             reinterpret_cast<sockaddr*>(&socket_address),
             sizeof(socket_address)) != 0) {
        *error = static_cast<DWORD>(WSAGetLastError());
        closesocket(listen_socket);
        return INVALID_SOCKET;
    }
    int address_length = sizeof(socket_address);
    if (getsockname(listen_socket,
                    reinterpret_cast<sockaddr*>(&socket_address),
                    &address_length) != 0
        || listen(listen_socket, kMaxWorkers * 2) != 0) {
        *error = static_cast<DWORD>(WSAGetLastError());
        closesocket(listen_socket);
        return INVALID_SOCKET;
    }
    *port = ntohs(socket_address.sin_port);
    *actual_address = socket_address.sin_addr;
    return listen_socket;
}

// True when the unicast address is a usable LAN IPv4 (not loopback, not
// link-local, not unspecified); writes the dotted text to `out`.
bool adapter_ipv4(const IP_ADAPTER_UNICAST_ADDRESS* unicast, wchar_t* out,
                  size_t capacity) {
    const sockaddr* address = unicast->Address.lpSockaddr;
    if (!address || address->sa_family != AF_INET) {
        return false;
    }
    const sockaddr_in* ipv4 = reinterpret_cast<const sockaddr_in*>(address);
    const unsigned long host = ntohl(ipv4->sin_addr.s_addr);
    if (host == 0UL || (host >> 24) == 127UL
        || (host & 0xFFFF0000UL) == 0xA9FE0000UL) {
        return false;
    }
    return InetNtopW(AF_INET, &ipv4->sin_addr, out, capacity) != nullptr;
}

// Picks the concrete IPv4 to advertise for URLs in lan/0.0.0.0 mode: only
// adapters that are up, skipping loopback/link-local/unspecified addresses and
// preferring an adapter that has a gateway.
bool select_advertise_ipv4(wchar_t* out, size_t capacity) {
    const ULONG flags = static_cast<ULONG>(
        GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST
        | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER);
    ULONG buffer_size = 0;
    DWORD status = GetAdaptersAddresses(AF_INET, flags, nullptr, nullptr,
                                        &buffer_size);
    if (status != ERROR_BUFFER_OVERFLOW || buffer_size == 0) {
        return false;
    }
    IP_ADAPTER_ADDRESSES* addresses = static_cast<IP_ADAPTER_ADDRESSES*>(
        malloc(buffer_size));
    if (!addresses) {
        return false;
    }
    status = GetAdaptersAddresses(AF_INET, flags, nullptr, addresses,
                                  &buffer_size);
    bool found = false;
    if (status == ERROR_SUCCESS) {
        for (IP_ADAPTER_ADDRESSES* adapter = addresses; adapter && !found;
             adapter = adapter->Next) {
            if (adapter->OperStatus != IfOperStatusUp
                || adapter->FirstGatewayAddress == nullptr) {
                continue;
            }
            for (const IP_ADAPTER_UNICAST_ADDRESS* unicast =
                     adapter->FirstUnicastAddress;
                 unicast && !found; unicast = unicast->Next) {
                found = adapter_ipv4(unicast, out, capacity);
            }
        }
        for (IP_ADAPTER_ADDRESSES* adapter = addresses; adapter && !found;
             adapter = adapter->Next) {
            if (adapter->OperStatus != IfOperStatusUp) {
                continue;
            }
            for (const IP_ADAPTER_UNICAST_ADDRESS* unicast =
                     adapter->FirstUnicastAddress;
                 unicast && !found; unicast = unicast->Next) {
                found = adapter_ipv4(unicast, out, capacity);
            }
        }
    }
    free(addresses);
    return found;
}

} // namespace

StartResult start(HWND ui_window, UINT notify_message, UINT exit_message) {
    StartResult result{};
    if (g_thread || g_wsa_started) {
        result.error = ERROR_ALREADY_EXISTS;
        return result;
    }

    set_local_attachment_paths_allowed(false);
    g_ui_window = ui_window;
    g_notify_message = notify_message;
    g_exit_message = exit_message;
    g_stopping = 0;
    for (Worker& worker : g_workers) {
        worker = Worker{};
    }
    g_listen = INVALID_SOCKET;
    g_port_path[0] = 0;
    g_token_path[0] = 0;
    cleanup_resource_spool();
    InitializeCriticalSection(&g_lock);
    g_lock_ready = true;

    WSADATA wsa{};
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
        result.error = static_cast<DWORD>(WSAGetLastError());
        g_wsa_started = false;
    } else {
        g_wsa_started = true;

        wchar_t directory[MAX_PATH]{};
        if (!executable_directory(directory, ARRAYSIZE(directory))) {
            result.error = ERROR_PATH_NOT_FOUND;
        } else {
            swprintf_s(result.token_path, L"%s\\api-token.txt", directory);
            swprintf_s(result.port_path, L"%s\\api-port.txt", directory);
            wchar_t listen_config_path[MAX_PATH]{};
            swprintf_s(listen_config_path, L"%s\\api-listen.txt", directory);
            wcscpy_s(g_token_path, result.token_path);

            char token[33]{};
            if (!read_text_file(result.token_path, token, ARRAYSIZE(token))
                || !valid_token_text(token)) {
                if (!generate_token(token)
                    || !write_text_file(result.token_path, token)) {
                    result.error = GetLastError();
                    token[0] = 0;
                }
            }
            if (token[0]) {
                strcpy_s(g_token, token);
                strcpy_s(result.token, token);

                const ListenConfig listen_config =
                    load_listen_config(listen_config_path);
                // Non-loopback configurations fall back to loopback when the
                // requested address cannot be bound, so the API stays reachable.
                const bool wants_network =
                    listen_config.mode != ListenMode::Loopback;
                in_addr bind_address{};
                bind_address.s_addr = htonl(INADDR_LOOPBACK);
                if (listen_config.mode == ListenMode::AnyAddress) {
                    bind_address.s_addr = htonl(INADDR_ANY);
                } else if (listen_config.mode == ListenMode::Specific) {
                    bind_address = listen_config.address;
                }

                unsigned short bound_port = 0;
                in_addr actual_address{};
                DWORD bind_error = ERROR_SUCCESS;
                SOCKET listen_socket = INVALID_SOCKET;
                if (listen_config.mode != ListenMode::Invalid) {
                    listen_socket = listen_on_address(bind_address,
                                                      &bound_port,
                                                      &actual_address,
                                                      &bind_error);
                }
                if (listen_socket == INVALID_SOCKET && wants_network) {
                    // The LAN address is unusable (invalid literal or not
                    // present on this machine): keep loopback and report it.
                    result.listen_fallback = true;
                    bind_address.s_addr = htonl(INADDR_LOOPBACK);
                    listen_socket = listen_on_address(bind_address,
                                                      &bound_port,
                                                      &actual_address,
                                                      &bind_error);
                }

                if (listen_socket == INVALID_SOCKET) {
                    result.error = bind_error != ERROR_SUCCESS
                                       ? bind_error
                                       : static_cast<DWORD>(WSAGetLastError());
                } else {
                    const bool bound_loopback =
                        in_addr_is_loopback_v4(actual_address);
                    result.lan_exposed = !bound_loopback;
                    if (listen_config.mode == ListenMode::AnyAddress
                        && !result.listen_fallback) {
                        wcscpy_s(result.listen_address, L"0.0.0.0");
                        wchar_t advertise[64]{};
                        if (!select_advertise_ipv4(advertise,
                                                   ARRAYSIZE(advertise))) {
                            wcscpy_s(advertise, L"127.0.0.1");
                        }
                        wcscpy_s(result.advertise_ipv4, advertise);
                    } else if (InetNtopW(AF_INET, &actual_address,
                                         result.listen_address,
                                         ARRAYSIZE(result.listen_address))
                               == nullptr) {
                        wcscpy_s(result.listen_address, L"127.0.0.1");
                        wcscpy_s(result.advertise_ipv4, L"127.0.0.1");
                    } else {
                        wcscpy_s(result.advertise_ipv4,
                                 result.listen_address);
                    }

                    g_port = bound_port;
                    char port_text[16]{};
                    snprintf(port_text, sizeof(port_text), "%u",
                             static_cast<unsigned>(g_port));
                    if (!write_text_file(result.port_path, port_text)) {
                        result.error = GetLastError();
                        closesocket(listen_socket);
                    } else {
                        wcscpy_s(g_port_path, result.port_path);
                        // Locality is decided per request from the peer address
                        // (client_allows_local_attachment_paths), so the service
                        // gate stays open regardless of the bind address.
                        set_local_attachment_paths_allowed(true);
                        g_listen = listen_socket;
                        g_thread = CreateThread(nullptr, 0, server_thread,
                                                 nullptr, 0, nullptr);
                        if (!g_thread) {
                            result.error = GetLastError();
                            set_local_attachment_paths_allowed(false);
                            closesocket(listen_socket);
                            g_listen = INVALID_SOCKET;
                        } else {
                            result.started = true;
                            result.port = g_port;
                            return result;
                        }
                    }
                }
            } else if (result.error == ERROR_SUCCESS) {
                result.error = ERROR_WRITE_FAULT;
            }
        }
    }

    if (result.error == ERROR_SUCCESS) {
        result.error = ERROR_GEN_FAILURE;
    }
    set_local_attachment_paths_allowed(false);
    if (g_listen != INVALID_SOCKET) {
        closesocket(g_listen);
        g_listen = INVALID_SOCKET;
    }
    if (g_thread) {
        CloseHandle(g_thread);
        g_thread = nullptr;
    }
    if (g_wsa_started) {
        WSACleanup();
        g_wsa_started = false;
    }
    if (g_lock_ready) {
        DeleteCriticalSection(&g_lock);
        g_lock_ready = false;
    }
    if (g_port_path[0]) {
        DeleteFileW(g_port_path);
        g_port_path[0] = 0;
    }
    g_token_path[0] = 0;
    g_token[0] = 0;
    g_ui_window = nullptr;
    g_notify_message = 0;
    g_exit_message = 0;
    return result;
}

bool stop() {
    set_local_attachment_paths_allowed(false);
    InterlockedExchange(&g_stopping, 1);

    const ULONGLONG deadline = GetTickCount64() + kStopTimeoutMs;
    if (g_listen != INVALID_SOCKET) {
        SOCKET listen_socket = g_listen;
        g_listen = INVALID_SOCKET;
        closesocket(listen_socket);
    }
    if (g_thread) {
        const DWORD wait = WaitForSingleObject(g_thread, kStopTimeoutMs);
        if (wait != WAIT_OBJECT_0) {
            if (wait != WAIT_FAILED) {
                SetLastError(ERROR_TIMEOUT);
            }
            return false;
        }
        CloseHandle(g_thread);
        g_thread = nullptr;
    }

    // The accept thread is gone, so the worker table no longer grows. Taking
    // each socket away unblocks a worker waiting in recv/send.
    if (g_lock_ready) {
        HANDLE threads[kMaxWorkers]{};
        DWORD thread_count = 0;
        EnterCriticalSection(&g_lock);
        for (Worker& worker : g_workers) {
            if (worker.client != INVALID_SOCKET) {
                closesocket(worker.client);
                worker.client = INVALID_SOCKET;
            }
            if (worker.thread) {
                threads[thread_count++] = worker.thread;
            }
        }
        LeaveCriticalSection(&g_lock);
        if (thread_count > 0) {
            const ULONGLONG now = GetTickCount64();
            const DWORD remaining = now < deadline
                ? static_cast<DWORD>(deadline - now) : 0;
            const DWORD wait = WaitForMultipleObjects(thread_count, threads,
                                                      TRUE, remaining);
            if (wait >= WAIT_OBJECT_0 + thread_count) {
                if (wait != WAIT_FAILED) {
                    SetLastError(ERROR_TIMEOUT);
                }
                return false;
            }
            EnterCriticalSection(&g_lock);
            for (Worker& worker : g_workers) {
                if (worker.thread) {
                    CloseHandle(worker.thread);
                    worker.thread = nullptr;
                }
            }
            LeaveCriticalSection(&g_lock);
        }
    }
    if (g_wsa_started) {
        WSACleanup();
        g_wsa_started = false;
    }
    if (g_lock_ready) {
        DeleteCriticalSection(&g_lock);
        g_lock_ready = false;
    }
    if (g_port_path[0]) {
        DeleteFileW(g_port_path);
        g_port_path[0] = 0;
    }
    g_token_path[0] = 0;
    g_token[0] = 0;
    g_port = 0;
    g_ui_window = nullptr;
    g_notify_message = 0;
    g_exit_message = 0;
    return true;
}

bool rotate_token(char* out, size_t capacity, DWORD* error) {
    if (error) {
        *error = ERROR_SUCCESS;
    }
    if (!out || capacity < 33) {
        if (error) {
            *error = ERROR_INVALID_PARAMETER;
        }
        return false;
    }
    if (!g_thread || !g_lock_ready || !g_token_path[0]) {
        if (error) {
            *error = ERROR_INVALID_STATE;
        }
        return false;
    }

    char token[33]{};
    if (!generate_token(token)) {
        if (error) {
            *error = ERROR_GEN_FAILURE;
        }
        return false;
    }
    if (!write_text_file(g_token_path, token)) {
        if (error) {
            *error = GetLastError();
        }
        return false;
    }

    EnterCriticalSection(&g_lock);
    strcpy_s(g_token, token);
    LeaveCriticalSection(&g_lock);
    memcpy(out, token, sizeof(token));
    return true;
}

} // namespace feather::api
