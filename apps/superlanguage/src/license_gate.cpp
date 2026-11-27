/**
 * SuperLanguage 授权闸门实现（见 license_gate.h 的设计说明）。
 *
 * 线程模型：一个后台线程独占管道连接，负责 HELLO / 续期 / 到期判定；
 * 主线程只读原子状态。管道读用 PeekNamedPipe 轮询 + 截止时间，
 * 因此关停时不会被一次阻塞读挂住。
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "license_gate.h"

#pragma comment(lib, "bcrypt.lib")

namespace feather::license {
namespace {

constexpr int kGraceSeconds = 15 * 60;
constexpr int kRenewAheadSeconds = 180;
constexpr int kRetryBlockedMs = 30 * 1000;
constexpr int kRetryConnectMs = 10 * 1000;
constexpr int kReadTimeoutMs = 5000;
constexpr int kStartupWaitMs = 8000;
/** 推送模式：等主机发现端口并 POST 票据，窗口放宽到 20 秒。 */
constexpr int kPushStartupWaitMs = 20000;
constexpr char kIniName[] = "instance.ini";

std::atomic<bool> g_managed{false};
std::atomic<bool> g_testMode{false};
std::atomic<bool> g_stateOk{false};
std::atomic<bool> g_stop{false};
std::atomic<long long> g_expiresAt{0}; // unix 秒
std::atomic<long long> g_lastIat{0};   // 毫秒
std::mutex g_reasonMutex;
std::string g_reason = "uninitialized";
std::wstring g_startupMessage;
HANDLE g_thread = nullptr;
/** 推送模式：票据由托管主机 POST 进来，不再连命名管道。 */
std::atomic<bool> g_pushMode{false};
/** 本实例的票据验签密钥（hex 解码后）；initialize 时写入，之后只读。 */
std::mutex g_keyMutex;
std::vector<unsigned char> g_key;

struct Binding {
    std::string instanceId;
    std::string broker;
    std::string keyHex;
    std::string exeSha256;
};

struct Ticket {
    long long iat = 0; // 毫秒
    long long exp = 0; // 毫秒
    std::string caps;
    int maxJobsPerHour = 0;
};

std::string trimText(const std::string& value) {
    const size_t begin = value.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return std::string();
    const size_t end = value.find_last_not_of(" \t\r\n");
    return value.substr(begin, end - begin + 1);
}

std::string lowerText(std::string value) {
    for (char& c : value) {
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    }
    return value;
}

std::wstring widen(const std::string& value) {
    if (value.empty()) return std::wstring();
    const int size = MultiByteToWideChar(CP_UTF8, 0, value.c_str(),
                                         static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) return std::wstring();
    std::wstring out(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()),
                        out.data(), size);
    return out;
}

bool executableDirectory(wchar_t* out, size_t capacity) {
    if (out == nullptr || capacity == 0) return false;
    wchar_t path[MAX_PATH]{};
    const DWORD length = GetModuleFileNameW(nullptr, path, ARRAYSIZE(path));
    if (length == 0 || length >= ARRAYSIZE(path)) return false;
    wchar_t* slash = wcsrchr(path, L'\\');
    if (slash == nullptr) return false;
    *slash = L'\0';
    wcsncpy_s(out, capacity, path, _TRUNCATE);
    return true;
}

bool readFileBytes(const std::wstring& path, std::string* out, size_t maxBytes) {
    if (out == nullptr) return false;
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    std::string data;
    char buffer[2048];
    DWORD read = 0;
    while (data.size() < maxBytes
           && ReadFile(file, buffer, static_cast<DWORD>(sizeof(buffer)), &read, nullptr)
           && read > 0) {
        data.append(buffer, read);
    }
    CloseHandle(file);
    *out = std::move(data);
    return true;
}

std::string hexOf(const unsigned char* bytes, size_t length) {
    static const char* kDigits = "0123456789abcdef";
    std::string out;
    out.reserve(length * 2);
    for (size_t i = 0; i < length; ++i) {
        out.push_back(kDigits[bytes[i] >> 4]);
        out.push_back(kDigits[bytes[i] & 0x0F]);
    }
    return out;
}

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

bool bytesOfHex(const std::string& hex, std::vector<unsigned char>* out) {
    if (out == nullptr || hex.empty() || hex.size() % 2 != 0) return false;
    std::vector<unsigned char> bytes(hex.size() / 2);
    for (size_t i = 0; i < bytes.size(); ++i) {
        const int hi = hexValue(hex[i * 2]);
        const int lo = hexValue(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0) return false;
        bytes[i] = static_cast<unsigned char>((hi << 4) | lo);
    }
    *out = std::move(bytes);
    return true;
}

/** HMAC-SHA256；失败返回空串。 */
std::string hmacHex(const std::vector<unsigned char>& key, const std::string& text) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr,
                                    BCRYPT_ALG_HANDLE_HMAC_FLAG) < 0) {
        return std::string();
    }
    DWORD objectLength = 0;
    DWORD hashLength = 0;
    DWORD result = 0;
    std::string out;
    std::vector<unsigned char> object;
    do {
        if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                              reinterpret_cast<PUCHAR>(&objectLength),
                              sizeof(objectLength), &result, 0) < 0) {
            break;
        }
        if (BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                              reinterpret_cast<PUCHAR>(&hashLength),
                              sizeof(hashLength), &result, 0) < 0) {
            break;
        }
        object.resize(objectLength);
        BCRYPT_HASH_HANDLE hash = nullptr;
        if (BCryptCreateHash(algorithm, &hash, object.data(), objectLength,
                             const_cast<PUCHAR>(key.data()),
                             static_cast<ULONG>(key.size()), 0) < 0) {
            break;
        }
        const bool ok = BCryptHashData(hash,
                                       reinterpret_cast<PUCHAR>(const_cast<char*>(text.data())),
                                       static_cast<ULONG>(text.size()), 0) >= 0
            && BCryptFinishHash(hash, reinterpret_cast<PUCHAR>(object.data()), hashLength, 0) >= 0;
        BCryptDestroyHash(hash);
        if (ok) out = hexOf(object.data(), hashLength);
    } while (false);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    return out;
}

/** 自身 exe 的 SHA-256（小写 hex）。授权主机按这个摘要比对登记值。 */
std::string executableSha256() {
    wchar_t exe[MAX_PATH]{};
    const DWORD length = GetModuleFileNameW(nullptr, exe, ARRAYSIZE(exe));
    if (length == 0 || length >= ARRAYSIZE(exe)) return std::string();
    HANDLE file = CreateFileW(exe, GENERIC_READ, FILE_SHARE_READ, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return std::string();
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    std::string out;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) >= 0) {
        DWORD objectLength = 0;
        DWORD hashLength = 0;
        DWORD result = 0;
        BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                          reinterpret_cast<PUCHAR>(&objectLength), sizeof(objectLength), &result, 0);
        BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                          reinterpret_cast<PUCHAR>(&hashLength), sizeof(hashLength), &result, 0);
        std::vector<unsigned char> object(objectLength);
        std::vector<unsigned char> digest(hashLength);
        BCRYPT_HASH_HANDLE hash = nullptr;
        if (BCryptCreateHash(algorithm, &hash, object.data(), objectLength, nullptr, 0, 0) >= 0) {
            std::vector<unsigned char> chunk(64 * 1024);
            DWORD read = 0;
            bool ok = true;
            while (ok && ReadFile(file, chunk.data(), static_cast<DWORD>(chunk.size()), &read, nullptr)
                   && read > 0) {
                ok = BCryptHashData(hash, chunk.data(), read, 0) >= 0;
            }
            if (ok && BCryptFinishHash(hash, digest.data(), hashLength, 0) >= 0) {
                out = hexOf(digest.data(), hashLength);
            }
            BCryptDestroyHash(hash);
        }
        BCryptCloseAlgorithmProvider(algorithm, 0);
    }
    CloseHandle(file);
    return out;
}

/** 读 `instance.ini`；文件不存在返回 false。 */
bool readBinding(Binding* binding) {
    if (binding == nullptr) return false;
    wchar_t directory[MAX_PATH]{};
    if (!executableDirectory(directory, ARRAYSIZE(directory))) return false;
    wchar_t path[MAX_PATH]{};
    swprintf_s(path, L"%s\\%s", directory, widen(kIniName).c_str());
    std::string text;
    if (!readFileBytes(path, &text, 8192) || text.empty()) return false;
    std::map<std::string, std::string> values;
    size_t start = 0;
    while (start <= text.size()) {
        const size_t end = text.find('\n', start);
        const std::string line = trimText(text.substr(start, end == std::string::npos
                                                                    ? std::string::npos
                                                                    : end - start));
        if (!line.empty() && line[0] != '#') {
            const size_t equals = line.find('=');
            if (equals != std::string::npos) {
                values[trimText(line.substr(0, equals))] = trimText(line.substr(equals + 1));
            }
        }
        if (end == std::string::npos) break;
        start = end + 1;
    }
    binding->instanceId = values["instance"];
    binding->broker = values["broker"];
    binding->keyHex = lowerText(values["key"]);
    binding->exeSha256 = values["exeSha256"];
    const bool pushMode = binding->broker == "push";
    const bool pipeMode = binding->broker.rfind("\\\\.\\pipe\\", 0) == 0;
    return binding->instanceId.size() == 36
        && (pushMode || pipeMode)
        && binding->keyHex.size() == 64;
}

void setReason(const char* code, const char* message) {
    std::lock_guard<std::mutex> lock(g_reasonMutex);
    g_reason = std::string(code) + ": " + message;
}

void setBlocked(const char* code, const char* message) {
    g_stateOk.store(false);
    setReason(code, message);
}

/**
 * 连接/续期失败：仍在票据宽限期内就保持可用（让在飞任务跑完），否则直接阻塞。
 * 这条规则只在「曾经拿到过票据」时生效 —— 从未拿到票据时 expires=0，必然阻塞。
 */
void markUnavailable(const char* code, const char* message) {
    const long long expires = g_expiresAt.load();
    const long long now = static_cast<long long>(time(nullptr));
    if (expires > 0 && now <= expires + kGraceSeconds) {
        setReason(code, message);
        return;
    }
    setBlocked(code, message);
}

bool writeAll(HANDLE pipe, const std::string& line) {
    DWORD written = 0;
    return WriteFile(pipe, line.c_str(), static_cast<DWORD>(line.size()), &written, nullptr)
        && written == line.size();
}

/** 轮询管道可读字节，超时返回空串（不会挂住线程）。 */
std::string readLine(HANDLE pipe) {
    std::string buffer;
    const ULONGLONG deadline = GetTickCount64() + kReadTimeoutMs;
    while (GetTickCount64() < deadline) {
        DWORD available = 0;
        if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) return std::string();
        if (available > 0) {
            char chunk[512];
            DWORD read = 0;
            const DWORD want = available < sizeof(chunk) ? available : static_cast<DWORD>(sizeof(chunk));
            if (!ReadFile(pipe, chunk, want, &read, nullptr) || read == 0) return std::string();
            buffer.append(chunk, read);
            const size_t newline = buffer.find('\n');
            if (newline != std::string::npos) return trimText(buffer.substr(0, newline));
        } else {
            Sleep(30);
        }
    }
    return std::string();
}

bool applyTicket(const std::string& claimHex, const std::string& macHex,
                 const Binding& binding, const std::vector<unsigned char>& key) {
    std::vector<unsigned char> claimBytes;
    if (!bytesOfHex(claimHex, &claimBytes)) return false;
    const std::string claim(reinterpret_cast<const char*>(claimBytes.data()), claimBytes.size());
    const std::string expected = hmacHex(key, claim);
    if (expected.empty() || expected.size() != macHex.size()
        || !std::equal(expected.begin(), expected.end(), macHex.begin())) {
        setReason("BAD_TICKET", "票据签名不匹配");
        return false;
    }
    std::vector<std::string> fields;
    size_t start = 0;
    while (true) {
        const size_t end = claim.find('\n', start);
        fields.push_back(claim.substr(start, end == std::string::npos ? std::string::npos : end - start));
        if (end == std::string::npos) break;
        start = end + 1;
    }
    if (fields.size() != 11) {
        setReason("BAD_TICKET", "票据字段数量不符");
        return false;
    }
    if (fields[0] != "superlanguage" || fields[1] != binding.instanceId || fields[10] != "1") {
        setReason("BAD_TICKET", "票据与实例绑定不一致");
        return false;
    }
    const long long iatSeconds = _strtoi64(fields[4].c_str(), nullptr, 10);
    const long long expSeconds = _strtoi64(fields[5].c_str(), nullptr, 10);
    const long long nowSeconds = static_cast<long long>(time(nullptr));
    if (iatSeconds <= 0 || expSeconds <= iatSeconds) {
        setReason("BAD_TICKET", "票据时间无效");
        return false;
    }
    if (nowSeconds + 60 < iatSeconds) {
        setBlocked("CLOCK_SKEW", "本机时钟比授权主机慢");
        return false;
    }
    if (nowSeconds - 60 > expSeconds) {
        setBlocked("TICKET_EXPIRED", "票据已过期，正在尝试续期");
        return false;
    }
    const long long iatMs = iatSeconds * 1000;
    if (g_lastIat.load() > 0 && iatMs < g_lastIat.load()) {
        setBlocked("CLOCK_SKEW", "检测到系统时间被调回");
        return false;
    }
    g_lastIat.store(iatMs);
    g_expiresAt.store(expSeconds);
    g_stateOk.store(true);
    setReason("ok", "票据有效");
    return true;
}

bool sendAndApply(HANDLE pipe, const std::string& request, const Binding& binding,
                  const std::vector<unsigned char>& key) {
    if (!writeAll(pipe, request + "\n")) return false;
    const std::string reply = readLine(pipe);
    if (reply.empty()) return false;
    if (reply.rfind("TICKET ", 0) == 0) {
        const size_t split = reply.find(' ', 7);
        if (split == std::string::npos) return false;
        return applyTicket(reply.substr(7, split - 7), reply.substr(split + 1), binding, key);
    }
    if (reply.rfind("DENY ", 0) == 0) {
        const size_t split = reply.find(' ', 5);
        const std::string code = split == std::string::npos ? reply.substr(5) : reply.substr(5, split - 5);
        const std::string message = split == std::string::npos ? std::string() : reply.substr(split + 1);
        setBlocked(code.c_str(), message.c_str());
        return false;
    }
    setReason("BAD_REPLY", "授权管道返回了无法识别的报文");
    return false;
}

std::string helloRequest(const Binding& binding, const std::vector<unsigned char>& key) {
    const std::string proof = hmacHex(key, "hello:v1:" + binding.instanceId + ":" + binding.exeSha256);
    return "HELLO 1 " + binding.instanceId + " " + binding.exeSha256 + " " + proof;
}

std::string renewRequest(const Binding& binding, const std::vector<unsigned char>& key) {
    // 续期按登记摘要算证明：换 exe 后旧密钥不能自动续期（主机侧还会再比一次）。
    const std::string seed = binding.exeSha256.empty() ? std::string() : binding.exeSha256;
    const std::string proof = hmacHex(key, "renew:v1:" + binding.instanceId + ":" + seed);
    return "RENEW " + binding.instanceId + " " + proof;
}

DWORD WINAPI workerProc(LPVOID parameter) {
    Binding binding = *static_cast<Binding*>(parameter);
    delete static_cast<Binding*>(parameter);
    std::vector<unsigned char> key;
    if (!bytesOfHex(binding.keyHex, &key)) {
        setBlocked("BAD_KEY", "instance.ini 中的实例密钥格式无效");
        return 0;
    }
    // 推送模式：票据由托管主机 POST 到 /api/license/lease（见 acceptTicket）。
    // 这里只做「到期/宽限」的时间收口，不再连管道。
    if (g_pushMode.load()) {
        setReason("pending", "等待 Super Time 推送运行票据");
        while (!g_stop.load()) {
            const long long nowSeconds = static_cast<long long>(time(nullptr));
            const long long expires = g_expiresAt.load();
            // 推送模式下 `markUnavailable` 不适用：没有任何「重连」可做，
            // 过期就如实阻塞，等主机下一次推送把它救回来。
            if (expires > 0 && nowSeconds > expires + kGraceSeconds) {
                setBlocked("TICKET_EXPIRED", "票据与宽限期都已结束；请在 Super Time 中重新签发");
            }
            Sleep(1000);
        }
        return 0;
    }
    HANDLE pipe = INVALID_HANDLE_VALUE;
    while (!g_stop.load()) {
        if (pipe == INVALID_HANDLE_VALUE) {
            pipe = CreateFileW(widen(binding.broker).c_str(), GENERIC_READ | GENERIC_WRITE,
                               0, nullptr, OPEN_EXISTING, 0, nullptr);
            if (pipe == INVALID_HANDLE_VALUE) {
                markUnavailable("BROKER_DOWN", "授权主机未运行；请先启动 Super Time");
                Sleep(kRetryConnectMs);
                continue;
            }
            if (!sendAndApply(pipe, helloRequest(binding, key), binding, key)) {
                CloseHandle(pipe);
                pipe = INVALID_HANDLE_VALUE;
                markUnavailable("BROKER_DOWN", "授权主机拒绝或未响应；将自动重试");
                Sleep(kRetryBlockedMs);
                continue;
            }
        } else {
            const long long nowSeconds = static_cast<long long>(time(nullptr));
            const long long expires = g_expiresAt.load();
            if (expires > 0 && nowSeconds >= expires - kRenewAheadSeconds) {
                if (!sendAndApply(pipe, renewRequest(binding, key), binding, key)) {
                    CloseHandle(pipe);
                    pipe = INVALID_HANDLE_VALUE;
                    markUnavailable("BROKER_DOWN", "续期失败；宽限期内仍可跑完在飞任务");
                    Sleep(kRetryBlockedMs);
                    continue;
                }
            }
        }
        const long long nowSeconds = static_cast<long long>(time(nullptr));
        const long long expires = g_expiresAt.load();
        if (expires > 0 && nowSeconds > expires + kGraceSeconds) {
            setBlocked("TICKET_EXPIRED", "票据与宽限期都已结束；请启动 Super Time");
            if (pipe != INVALID_HANDLE_VALUE) {
                CloseHandle(pipe);
                pipe = INVALID_HANDLE_VALUE;
            }
        }
        Sleep(1000);
    }
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
    return 0;
}

} // namespace

bool initialize(bool allow_unmanaged) {
    if (g_thread != nullptr) return g_stateOk.load();
    Binding binding;
    if (!readBinding(&binding)) {
        if (allow_unmanaged) {
            g_testMode.store(true);
            g_stateOk.store(true);
            setReason("test-mode", "已跳过授权校验（隔离测试）");
            return true;
        }
        g_managed.store(false);
        setBlocked("NOT_MANAGED", "缺少 instance.ini：本程序只能由 Super Time 部署并授权后运行");
        g_startupMessage =
            L"SuperLanguage 需要由 Super Time 授权后才能启动。\n\n"
            L"请打开 Super Time →「应用托管」→ 新建实例 → 部署并启动；\n"
            L"本程序会自动连接授权主机并换取运行票据。\n\n"
            L"机器码：NOT_MANAGED";
        return false;
    }
    g_managed.store(true);
    binding.exeSha256 = executableSha256();
    if (binding.exeSha256.empty()) {
        setBlocked("EXE_HASH_FAILED", "无法计算自身摘要，拒绝启动");
        g_startupMessage = L"无法计算程序摘要，已拒绝启动。\n\n机器码：EXE_HASH_FAILED";
        return false;
    }
    g_stop.store(false);
    g_stateOk.store(false);
    // 推送模式（跨机托管）：票据由托管主机 POST 到 /api/license/lease。
    g_pushMode.store(binding.broker == "push");
    {
        std::lock_guard<std::mutex> lock(g_keyMutex);
        g_key.clear();
        if (!bytesOfHex(binding.keyHex, &g_key)) g_key.clear();
    }
    setReason("pending", g_pushMode.load()
        ? "等待 Super Time 推送运行票据"
        : "正在向 Super Time 换取运行票据");
    auto* threadBinding = new Binding(binding);
    g_thread = CreateThread(nullptr, 0, workerProc, threadBinding, 0, nullptr);
    if (g_thread == nullptr) {
        delete threadBinding;
        setBlocked("THREAD_FAILED", "无法启动授权线程");
        g_startupMessage = L"无法启动授权线程，已拒绝启动。\n\n机器码：THREAD_FAILED";
        return false;
    }
    // **推送模式必须先让 API 起来**：票据要从局域网 POST 进来，而端口是实例
    // 自己开的。这里若也阻塞等待，就会形成「等票据 → 不给端口 → 推不进来」的死锁。
    // 因此推送模式下 initialize 立即返回；`available()` 在票据到达前恒为 false，
    // 队列自然暂停（没有任何消息会发出去），面板显示「等待票据」。
    if (g_pushMode.load()) return true;
    // 推送模式要给主机「发现端口并 POST 票据」的时间，窗口比管道模式宽一些。
    const ULONGLONG waitMs = g_pushMode.load() ? kPushStartupWaitMs : kStartupWaitMs;
    const ULONGLONG deadline = GetTickCount64() + waitMs;
    while (GetTickCount64() < deadline) {
        if (g_stateOk.load()) return true;
        {
            std::lock_guard<std::mutex> lock(g_reasonMutex);
            // DENY 是终态：不必等满窗口。
            if (g_reason.rfind("ok", 0) != 0 && g_reason.rfind("pending", 0) != 0
                && g_reason.rfind("test-mode", 0) != 0) {
                break;
            }
        }
        Sleep(50);
    }
    if (g_stateOk.load()) return true;
    std::string reason;
    {
        std::lock_guard<std::mutex> lock(g_reasonMutex);
        reason = g_reason;
    }
    g_startupMessage = g_pushMode.load()
        ? L"等待 Super Time 推送运行票据超时，已拒绝启动。\n\n"
          + widen(reason)
          + L"\n\n请确认 Super Time 正在运行，且这台电脑已在「应用托管」中登记为该实例的目标机器。"
        : L"Super Time 授权校验未通过，已拒绝启动。\n\n"
          + widen(reason)
          + L"\n\n请打开 Super Time →「应用托管」确认授权与实例状态后重试。";
    return false;
}

bool push_mode() {
    return g_pushMode.load();
}

bool acceptTicket(const char* claim_hex, const char* mac_hex) {
    if (!g_managed.load()) {
        setReason("NOT_MANAGED", "实例未由 Super Time 部署");
        return false;
    }
    if (claim_hex == nullptr || mac_hex == nullptr) return false;
    std::vector<unsigned char> key;
    {
        std::lock_guard<std::mutex> lock(g_keyMutex);
        key = g_key;
    }
    if (key.empty()) {
        setReason("BAD_KEY", "实例密钥不可用");
        return false;
    }
    Binding binding;
    if (!readBinding(&binding) || binding.instanceId.empty()) {
        setReason("NOT_MANAGED", "缺少 instance.ini");
        return false;
    }
    return applyTicket(std::string(claim_hex), lowerText(std::string(mac_hex)), binding, key);
}

void shutdown() {
    g_stop.store(true);
    if (g_thread != nullptr) {
        WaitForSingleObject(g_thread, 3000);
        CloseHandle(g_thread);
        g_thread = nullptr;
    }
}

bool available() {
    if (g_testMode.load()) return true;
    if (!g_stateOk.load()) return false;
    const long long expires = g_expiresAt.load();
    if (expires <= 0) return false;
    return static_cast<long long>(time(nullptr)) <= expires + kGraceSeconds;
}

bool managed() {
    return g_managed.load();
}

const char* state_code() {
    if (g_testMode.load()) return "unmanaged";
    if (!g_managed.load()) return "unmanaged";
    if (available()) return "ok";
    return "blocked";
}

int expires_in_seconds() {
    const long long expires = g_expiresAt.load();
    if (expires <= 0) return 0;
    const long long delta = expires - static_cast<long long>(time(nullptr));
    return delta > 0 ? static_cast<int>(delta) : 0;
}

std::string status_json() {
    std::string code;
    {
        std::lock_guard<std::mutex> lock(g_reasonMutex);
        const size_t colon = g_reason.find(':');
        code = colon == std::string::npos ? g_reason : g_reason.substr(0, colon);
    }
    if (code.empty()) code = "unknown";
    char buffer[160]{};
    snprintf(buffer, sizeof(buffer),
             "{\"state\":\"%s\",\"code\":\"%s\",\"expires_in\":%d,\"managed\":%s}",
             state_code(), code.c_str(), expires_in_seconds(),
             managed() ? "true" : "false");
    return std::string(buffer);
}

std::wstring startup_block_message() {
    if (!g_startupMessage.empty()) return g_startupMessage;
    return std::wstring(L"Super Time 授权校验未通过，已拒绝启动。");
}

} // namespace feather::license
