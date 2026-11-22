#include "automation.h"

#include <tlhelp32.h>
#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cwchar>
#include <random>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "advapi32.lib")

namespace feather::automation {

bool guard_aborted();  // defined with the mouse input guard below
bool window_belongs_to_task(HWND window);  // defined with the injection guard

namespace {

enum class InjectionPurpose {
    SearchFocus,
    SearchListFocus,
    SearchClear,
    SearchText,
    SubmitSearch,
    SearchPanelClose,
    ComposeFocus,
    ComposeText,
    MentionSelect,
    MentionLineBreak,
    AttachmentPaste,
    ComposeClear,
    SubmitMessage,
};

struct AutomationGuard {
    HWND target_window = nullptr;
    DWORD process_id = 0;
    ULONGLONG deadline_ms = 0;
    AutomationState stage = AutomationState::Idle;
    bool active = false;
    bool send_injected = false;
    wchar_t target_name[128]{};
};

AutomationGuard g_task_guard{};

bool guard_validate(InjectionPurpose purpose, const POINT* screen_point,
                    DWORD* error_code);
void apply_injection_transition(InjectionPurpose purpose);
bool begin_guard_for_target(HWND target_window, unsigned timeout_ms,
                            DWORD* error_code);
bool inject_guarded(InjectionPurpose purpose, const INPUT* inputs, UINT count,
                    const POINT* screen_point, DWORD* error_code);
bool inject_wm_char_guarded(HWND target_window, WPARAM character,
                            InjectionPurpose purpose, DWORD* error_code);
bool send_unicode_text(const wchar_t* text, InjectionPurpose purpose,
                       DWORD per_character_delay_ms, DWORD* error_code);
bool send_shift_enter(InjectionPurpose purpose, DWORD* error_code);
bool send_shift_enter(InjectionPurpose purpose, DWORD* error_code);

constexpr int kMaxWeChatProcesses = 24;
constexpr int kLargeMainWidth = 800;
constexpr int kLargeMainHeight = 500;
// Every automation click target is expressed relative to the WeChat client
// area: positive values measure from the left/top edge, negative values from
// the right/bottom edge. The UI is anchored to the window edges, so one set of
// offsets stays valid at any window size and WeChat no longer has to be
// maximized for automation to work.
//
// The composer is bottom-anchored with a fixed height, not a proportional one:
// measured from screenshots, its rounded box spans roughly 11..92 px above the
// client bottom at 96 DPI in the 954x444 dual-pane layout, the 424x444
// single-pane layout and the full-height 424x1400 single-pane window alike (the
// icon row sits ~39..47 px above the bottom, the text area just above it).
// A proportional offset only matches the 444-high windows and lands in the
// message list once WeChat's compact mode stretches to the screen height, so
// use a fixed DIP offset in the middle of the text area instead.
constexpr int kComposerBottomDips = 64;
// In the single-pane (narrow) layout the chat list is hidden behind the header
// back arrow. The same client-relative point is inside the chat-list search box
// in the wide layout, so clicking it is safe in both: it either navigates back
// to the list or focuses the search field before Ctrl+F.
constexpr int kSearchListPointXDips = 100;
constexpr int kSearchListPointYDips = 58;
constexpr int kSearchClosePointXDips = -15;  // right edge -> search view close
constexpr int kSearchClosePointYDips = 45;   // top edge
// WeChat paints the send button green only while the composer holds content and
// leaves it grey when it is empty. It is the one focus-independent signal for
// "did typed text land in the message editor?" on 4.x, where the
// editor is a windowless render widget. Sample the whole bottom-right corner of
// the composer rather than one fixed point: the send button sits at different
// offsets in the narrow and wide layouts.
constexpr int kSendButtonRegionRightDips = 8;
constexpr int kSendButtonRegionBottomDips = 8;
constexpr int kSendButtonRegionWidthDips = 120;
constexpr int kSendButtonRegionHeightDips = 56;
constexpr int kSendButtonGreenPixelThreshold = 40;

struct ProcessScan {
    DWORD pids[kMaxWeChatProcesses]{};
    int count = 0;
    wchar_t executable[MAX_PATH]{};
};

struct WindowScan {
    const DWORD* pids{};
    int process_count = 0;
    bool login_window = false;
    bool login_ui_visible = false;
    bool legacy_main = false;
    bool large_main = false;
    bool tray_window = false;
    HWND main_handle = nullptr;
    HWND qt_handle = nullptr;
    int qt_area = 0;
    HWND login_handle = nullptr;
};

bool is_wechat_process(const wchar_t* name) {
    return _wcsicmp(name, L"Weixin.exe") == 0 || _wcsicmp(name, L"WeChat.exe") == 0;
}

bool file_exists(const wchar_t* path) {
    if (!path || !path[0]) {
        return false;
    }
    const DWORD attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES
        && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

void scan_processes(ProcessScan& scan) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) {
        return;
    }

    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (!is_wechat_process(entry.szExeFile)) {
                continue;
            }
            if (scan.count < kMaxWeChatProcesses) {
                scan.pids[scan.count++] = entry.th32ProcessID;
            }
            if (!scan.executable[0]) {
                HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE,
                                             entry.th32ProcessID);
                if (process) {
                    DWORD length = static_cast<DWORD>(ARRAYSIZE(scan.executable));
                    if (!QueryFullProcessImageNameW(process, 0, scan.executable, &length)) {
                        scan.executable[0] = L'\0';
                    }
                    CloseHandle(process);
                }
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
}

bool pid_belongs_to_wechat(const WindowScan& scan, DWORD pid) {
    for (int index = 0; index < scan.process_count; ++index) {
        if (scan.pids[index] == pid) {
            return true;
        }
    }
    return false;
}

BOOL CALLBACK scan_window(HWND hwnd, LPARAM parameter) {
    auto& scan = *reinterpret_cast<WindowScan*>(parameter);

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (!pid_belongs_to_wechat(scan, pid)) {
        return TRUE;
    }

    wchar_t class_name[256]{};
    wchar_t title[512]{};
    GetClassNameW(hwnd, class_name, ARRAYSIZE(class_name));
    GetWindowTextW(hwnd, title, ARRAYSIZE(title));
    const bool visible = IsWindowVisible(hwnd) != FALSE;

    if (_wcsicmp(class_name, L"WeChatLoginWndForPC") == 0
        || wcsstr(title, L"扫码登录") != nullptr
        || wcsstr(title, L"登录微信") != nullptr
        || wcsstr(title, L"扫描二维码") != nullptr) {
        scan.login_window = true;
        if (!scan.login_handle) {
            scan.login_handle = hwnd;
        }
    }

    if (_wcsicmp(class_name, L"WeChatMainWndForPC") == 0) {
        scan.legacy_main = true;
        if (!scan.main_handle) {
            scan.main_handle = hwnd;
        }
    }

    if (wcsstr(class_name, L"TrayIconMessageWindow") != nullptr
        || _wcsicmp(title, L"WxTrayIconMessageWindow") == 0) {
        scan.tray_window = true;
    }

    const bool qt_window = wcsncmp(class_name, L"Qt", 2) == 0;
    const bool wechat_title = wcsstr(title, L"微信") != nullptr
        || _wcsicmp(title, L"WeChat") == 0
        || _wcsicmp(title, L"Weixin") == 0;

    if (qt_window && wechat_title) {
        WINDOWPLACEMENT placement{};
        placement.length = sizeof(placement);
        RECT bounds{};
        bool have_bounds = false;
        if (GetWindowPlacement(hwnd, &placement)
            && placement.rcNormalPosition.right > placement.rcNormalPosition.left
            && placement.rcNormalPosition.bottom > placement.rcNormalPosition.top) {
            bounds = placement.rcNormalPosition;
            have_bounds = true;
        } else if (GetWindowRect(hwnd, &bounds)) {
            have_bounds = true;
        }

        if (have_bounds) {
            const int width = bounds.right - bounds.left;
            const int height = bounds.bottom - bounds.top;
            UINT dpi = GetDpiForWindow(hwnd);
            if (dpi == 0) {
                dpi = 96;
            }
            const int logical_width = MulDiv(width, 96, static_cast<int>(dpi));
            const int logical_height = MulDiv(height, 96, static_cast<int>(dpi));
            const int area = logical_width * logical_height;
            if (!scan.qt_handle || area > scan.qt_area) {
                scan.qt_handle = hwnd;
                scan.qt_area = area;
            }
            if (logical_width >= kLargeMainWidth && logical_height >= kLargeMainHeight) {
                scan.large_main = true;
                if (!scan.main_handle) {
                    scan.main_handle = hwnd;
                }
            } else if (visible && !IsIconic(hwnd) && logical_width > 0 && logical_height > 0) {
                scan.login_ui_visible = true;
                if (!scan.login_handle) {
                    scan.login_handle = hwnd;
                }
            }
        }
    }

    return TRUE;
}

bool read_registry_string(HKEY root, const wchar_t* subkey, const wchar_t* value,
                          wchar_t* output, size_t capacity) {
    if (!output || capacity == 0) {
        return false;
    }
    output[0] = L'\0';
    DWORD size = static_cast<DWORD>(capacity * sizeof(wchar_t));
    const LSTATUS status = RegGetValueW(root, subkey, value,
                                       RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ,
                                       nullptr, output, &size);
    return status == ERROR_SUCCESS && output[0] != L'\0';
}

bool build_candidate_path(const wchar_t* base, const wchar_t* executable,
                          wchar_t* output, size_t capacity) {
    if (!base || !base[0]) {
        return false;
    }

    wchar_t cleaned[1024]{};
    wcsncpy_s(cleaned, base, _TRUNCATE);

    wchar_t* start = cleaned;
    while (*start == L' ' || *start == L'\t' || *start == L'"') {
        ++start;
    }
    size_t length = wcslen(start);
    while (length > 0) {
        const wchar_t last = start[length - 1];
        if (last != L' ' && last != L'\t' && last != L'"') {
            break;
        }
        start[--length] = L'\0';
    }
    if (length == 0) {
        return false;
    }

    if (length > 4 && _wcsicmp(start + length - 4, L".exe") == 0) {
        wcsncpy_s(output, capacity, start, _TRUNCATE);
    } else {
        if (start[length - 1] == L'\\') {
            start[--length] = L'\0';
        }
        if (swprintf_s(output, capacity, L"%s\\%s", start, executable) < 0) {
            return false;
        }
    }
    return file_exists(output);
}

struct InstallKey {
    HKEY root;
    const wchar_t* subkey;
    const wchar_t* value;
    const wchar_t* executable;
};

const InstallKey kInstallKeys[] = {
    {HKEY_CURRENT_USER, L"Software\\Tencent\\Weixin", L"InstallPath", L"Weixin.exe"},
    {HKEY_LOCAL_MACHINE, L"SOFTWARE\\Tencent\\Weixin", L"InstallPath", L"Weixin.exe"},
    {HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Tencent\\Weixin", L"InstallPath", L"Weixin.exe"},
    {HKEY_CURRENT_USER, L"Software\\Tencent\\WeChat", L"InstallPath", L"WeChat.exe"},
    {HKEY_LOCAL_MACHINE, L"SOFTWARE\\Tencent\\WeChat", L"InstallPath", L"WeChat.exe"},
    {HKEY_LOCAL_MACHINE, L"SOFTWARE\\WOW6432Node\\Tencent\\WeChat", L"InstallPath", L"WeChat.exe"},
};

const InstallKey kAppPathKeys[] = {
    {HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Weixin.exe", L"", L"Weixin.exe"},
    {HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Weixin.exe", L"", L"Weixin.exe"},
    {HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WeChat.exe", L"", L"WeChat.exe"},
    {HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WeChat.exe", L"", L"WeChat.exe"},
};

const wchar_t* const kCommonPaths[] = {
    L"%ProgramFiles%\\Tencent\\Weixin\\Weixin.exe",
    L"%ProgramFiles(x86)%\\Tencent\\Weixin\\Weixin.exe",
    L"%ProgramFiles%\\Tencent\\WeChat\\WeChat.exe",
    L"%ProgramFiles(x86)%\\Tencent\\WeChat\\WeChat.exe",
};

// Resolves a window-relative point into screen coordinates. Positive values
// measure from the client's left/top edge, negative values from its
// right/bottom edge (for example (-15, 45) means 15 DIPs left of the right
// edge, 45 DIPs below the top edge). The window DPI scale is applied and the
// result is clamped to the client area.
bool client_relative_point(HWND main_window, int x_dips, int y_dips,
                           POINT* point, DWORD* error_code) {
    if (!point || !error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!main_window || !IsWindow(main_window)) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }
    RECT client{};
    POINT origin{};
    if (!GetClientRect(main_window, &client)
        || !ClientToScreen(main_window, &origin)) {
        *error_code = GetLastError();
        return false;
    }
    const int width = client.right - client.left;
    const int height = client.bottom - client.top;
    if (width <= 0 || height <= 0) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }
    UINT dpi = GetDpiForWindow(main_window);
    if (dpi == 0) {
        dpi = 96;
    }
    const int offset_x = MulDiv(x_dips, static_cast<int>(dpi), 96);
    const int offset_y = MulDiv(y_dips, static_cast<int>(dpi), 96);
    const int x = x_dips >= 0 ? origin.x + offset_x
                              : origin.x + width + offset_x;
    const int y = y_dips >= 0 ? origin.y + offset_y
                              : origin.y + height + offset_y;
    const int left = static_cast<int>(origin.x);
    const int top = static_cast<int>(origin.y);
    point->x = std::clamp(x, left, left + width - 1);
    point->y = std::clamp(y, top, top + height - 1);
    return true;
}

bool get_message_input_point(HWND main_window, POINT* point,
                             DWORD* error_code) {
    if (!point || !error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!main_window || !IsWindow(main_window)) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }
    RECT client{};
    POINT origin{};
    if (!GetClientRect(main_window, &client)
        || !ClientToScreen(main_window, &origin)) {
        *error_code = GetLastError();
        return false;
    }
    const int width = client.right - client.left;
    const int height = client.bottom - client.top;
    if (width <= 0 || height <= 0) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }
    // Horizontal center of the composer; the message list above it ends well
    // before this point, so the click can only land in the editor or its
    // toolbar, never in a chat row.
    UINT dpi = GetDpiForWindow(main_window);
    if (dpi == 0) {
        dpi = 96;
    }
    int offset_y = MulDiv(kComposerBottomDips, static_cast<int>(dpi), 96);
    if (offset_y < 1) {
        offset_y = 1;
    }
    // Never target above the vertical middle of a pathologically short window.
    if (offset_y > height / 2) {
        offset_y = height / 2;
    }
    point->x = origin.x + width / 2;
    point->y = origin.y + height - offset_y;
    return true;
}

// True when the message composer currently holds content. Read from the screen
// because WeChat 4.x renders its editor inside MMUIRenderSubWindowHW, so there is
// no child HWND or accessible value to query. This is deliberately fail-open (returns
// false on capture errors) since callers only use it as a safety net.
bool composer_has_content(HWND main_window) {
    if (!main_window || !IsWindow(main_window)) {
        return false;
    }
    POINT top_left{};
    POINT bottom_right{};
    DWORD point_error = ERROR_SUCCESS;
    if (!client_relative_point(
            main_window,
            -(kSendButtonRegionRightDips + kSendButtonRegionWidthDips),
            -(kSendButtonRegionBottomDips + kSendButtonRegionHeightDips),
            &top_left, &point_error)
        || !client_relative_point(main_window, -kSendButtonRegionRightDips,
                                  -kSendButtonRegionBottomDips,
                                  &bottom_right, &point_error)) {
        return false;
    }
    const int region_width = bottom_right.x - top_left.x + 1;
    const int region_height = bottom_right.y - top_left.y + 1;
    if (region_width <= 0 || region_height <= 0) {
        return false;
    }

    // One BitBlt into a DIB section, then read the pixels from memory. Per-pixel
    // GetPixel on the screen DC costs milliseconds here (~5s for a 41x41 block),
    // which made the draft probe and the paste staging poll unusably slow.
    HDC screen = GetDC(nullptr);
    if (!screen) {
        return false;
    }
    HDC memory = CreateCompatibleDC(screen);
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = region_width;
    info.bmiHeader.biHeight = -region_height;  // top-down rows
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits,
                                      nullptr, 0);
    int green_pixels = 0;
    if (memory && bitmap && bits) {
        HGDIOBJ previous = SelectObject(memory, bitmap);
        if (BitBlt(memory, 0, 0, region_width, region_height, screen,
                   top_left.x, top_left.y, SRCCOPY)) {
            const auto* pixels = static_cast<const DWORD*>(bits);
            const int pixel_count = region_width * region_height;
            for (int index = 0; index < pixel_count; ++index) {
                const DWORD pixel = pixels[index];
                const int red = static_cast<int>((pixel >> 16) & 0xFF);
                const int green = static_cast<int>((pixel >> 8) & 0xFF);
                const int blue = static_cast<int>(pixel & 0xFF);
                // The active icon is (0,163,97); the empty one is neutral grey.
                if (green > 110 && green > red + 40 && green > blue + 40) {
                    ++green_pixels;
                }
            }
        }
        if (previous) {
            SelectObject(memory, previous);
        }
    }
    if (bitmap) {
        DeleteObject(bitmap);
    }
    if (memory) {
        DeleteDC(memory);
    }
    ReleaseDC(nullptr, screen);
    return green_pixels >= kSendButtonGreenPixelThreshold;
}

// ---------------------------------------------------------------------------
// Humanized cursor motion: a Qian Xuesen-style boost-glide trajectory with a
// mid-course maneuver and terminal guidance.
//
// The pointer follows a freshly randomized cubic Bezier curve. The time warp
// starts at zero speed (boost), spends most of its distance in a fast glide,
// then decays into a slow terminal approach. Two control points produce the
// curved course; the second control point usually crosses to the opposite side
// of the straight line, creating the mid-course "orbit change". A damped
// terminal oscillation and a small settling overshoot make every approach
// different.
//
// Movement must use SendInput rather than SetCursorPos. During automation the
// low-level mouse guard swallows non-injected pointer input, so SetCursorPos
// is not a reliable way to drive the cursor through that guard.
// ---------------------------------------------------------------------------

struct CursorRandom {
    std::mt19937_64 engine;

    CursorRandom() {
        std::random_device device;
        const unsigned long long seed =
            (static_cast<unsigned long long>(device()) << 32)
            ^ static_cast<unsigned long long>(GetTickCount64())
            ^ (static_cast<unsigned long long>(GetCurrentProcessId()) << 17);
        engine.seed(seed);
    }

    double unit() {
        return std::uniform_real_distribution<double>(0.0, 1.0)(engine);
    }

    int range(int low, int high) {
        return std::uniform_int_distribution<int>(low, high)(engine);
    }
};

CursorRandom& cursor_random() {
    static CursorRandom source;
    return source;
}

int cursor_random_int(int low, int high) {
    return cursor_random().range(low, high);
}

double cursor_random_unit() {
    return cursor_random().unit();
}

double cursor_clamp01(double value) {
    return value < 0.0 ? 0.0 : (value > 1.0 ? 1.0 : value);
}

RECT cursor_virtual_desktop() {
    RECT desktop{
        GetSystemMetrics(SM_XVIRTUALSCREEN),
        GetSystemMetrics(SM_YVIRTUALSCREEN),
        GetSystemMetrics(SM_XVIRTUALSCREEN) + GetSystemMetrics(SM_CXVIRTUALSCREEN),
        GetSystemMetrics(SM_YVIRTUALSCREEN) + GetSystemMetrics(SM_CYVIRTUALSCREEN)};
    if (desktop.right <= desktop.left || desktop.bottom <= desktop.top) {
        desktop = {0, 0, GetSystemMetrics(SM_CXSCREEN),
                   GetSystemMetrics(SM_CYSCREEN)};
    }
    return desktop;
}

POINT cursor_clamp_to_desktop(POINT point) {
    const RECT desktop = cursor_virtual_desktop();
    if (desktop.right <= desktop.left || desktop.bottom <= desktop.top) {
        return point;
    }
    point.x = (std::max)(desktop.left, (std::min)(desktop.right - 1, point.x));
    point.y = (std::max)(desktop.top, (std::min)(desktop.bottom - 1, point.y));
    return point;
}

// SendInput movement is tagged with LLMHF_INJECTED, so the automation mouse
// guard lets it through. Absolute virtual-desktop coordinates also work on
// multi-monitor and mixed-DPI layouts.
bool cursor_move_injected(POINT target) {
    target = cursor_clamp_to_desktop(target);
    const RECT desktop = cursor_virtual_desktop();
    const LONG width = desktop.right - desktop.left;
    const LONG height = desktop.bottom - desktop.top;
    if (width <= 1 || height <= 1) {
        return false;
    }
    const double normalized_x =
        static_cast<double>(target.x - desktop.left) * 65535.0
        / static_cast<double>(width - 1);
    const double normalized_y =
        static_cast<double>(target.y - desktop.top) * 65535.0
        / static_cast<double>(height - 1);

    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dx = static_cast<LONG>(std::lround(normalized_x));
    input.mi.dy = static_cast<LONG>(std::lround(normalized_y));
    input.mi.dwFlags =
        MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    SetLastError(ERROR_SUCCESS);
    return SendInput(1, &input, sizeof(INPUT)) == 1;
}

bool cursor_move_to(POINT target) {
    target = cursor_clamp_to_desktop(target);
    if (cursor_move_injected(target)) {
        return true;
    }
    if (input_guard_active()) {
        return false;
    }
    return SetCursorPos(target.x, target.y) != FALSE;
}

// The smootherstep gives the boost a zero initial velocity and a smooth
// hand-off into the glide. Raising it to a randomized power places more of the
// distance early, then leaves a long decelerating tail for terminal guidance.
double cursor_progress(double t, double power) {
    const double clamped = cursor_clamp01(t);
    const double smooth = clamped * clamped * (3.0 - 2.0 * clamped);
    return 1.0 - std::pow(1.0 - smooth, power);
}

POINT cursor_bezier(const POINT& a, const POINT& b, const POINT& c,
                    const POINT& d, double t) {
    const double inv = 1.0 - t;
    const double w0 = inv * inv * inv;
    const double w1 = 3.0 * inv * inv * t;
    const double w2 = 3.0 * inv * t * t;
    const double w3 = t * t * t;
    POINT point{};
    point.x = static_cast<LONG>(a.x * w0 + b.x * w1 + c.x * w2 + d.x * w3);
    point.y = static_cast<LONG>(a.y * w0 + b.y * w1 + c.y * w2 + d.y * w3);
    return point;
}

// Flies the physical pointer to `target` along a fresh random curve. `speed`
// scales the duration (1.0 = normal approach, <1 = quicker return).
bool glide_cursor_to(POINT target, double speed = 1.0) {
    POINT start{};
    if (!GetCursorPos(&start)) {
        return false;
    }
    start = cursor_clamp_to_desktop(start);
    target = cursor_clamp_to_desktop(target);
    const double dx = static_cast<double>(target.x - start.x);
    const double dy = static_cast<double>(target.y - start.y);
    const double distance = std::sqrt(dx * dx + dy * dy);
    if (distance < 2.0) {
        return cursor_move_to(target);
    }

    // Randomized geometry: the first control point establishes the boost
    // heading and the second usually crosses the original course, producing a
    // visible mid-course maneuver. Lateral offsets are capped on long moves so
    // the pointer does not sweep across unrelated windows.
    //
    // Arc height: both control points are pushed well off the direct line, so
    // the boost-glide bows visibly instead of hugging the straight path. The
    // fractions and caps below are the "trajectory amplitude" knobs: raising
    // them raises the arc, raising the cross-course chance makes the mid-course
    // maneuver (变轨) more frequent.
    constexpr double kCursorArcFirstMin = 0.16;       // fraction of distance
    constexpr double kCursorArcFirstSpread = 0.40;
    constexpr double kCursorArcSecondMin = 0.10;
    constexpr double kCursorArcSecondSpread = 0.34;
    constexpr double kCursorArcFirstCap = 620.0;      // pixels
    constexpr double kCursorArcSecondCap = 500.0;
    constexpr double kCursorCrossCourseChance = 0.92;
    const double nx = -dy / distance;
    const double ny = dx / distance;
    const double first_along = 0.10 + cursor_random_unit() * 0.20;
    const double second_along = 0.50 + cursor_random_unit() * 0.34;
    const double first_side = cursor_random_unit() < 0.5 ? -1.0 : 1.0;
    const bool cross_course = cursor_random_unit() < kCursorCrossCourseChance;
    const double second_side = cross_course
        ? -first_side
        : (cursor_random_unit() < 0.5 ? -1.0 : 1.0);
    const double first_offset =
        (std::min)(distance
                       * (kCursorArcFirstMin
                          + cursor_random_unit() * kCursorArcFirstSpread),
                   kCursorArcFirstCap)
        * first_side;
    const double second_offset =
        (std::min)(distance
                       * (kCursorArcSecondMin
                          + cursor_random_unit() * kCursorArcSecondSpread),
                   kCursorArcSecondCap)
        * second_side;
    POINT first{};
    first.x = start.x
        + static_cast<LONG>(std::lround(dx * first_along + nx * first_offset));
    first.y = start.y
        + static_cast<LONG>(std::lround(dy * first_along + ny * first_offset));
    first = cursor_clamp_to_desktop(first);
    POINT second{};
    second.x = start.x
        + static_cast<LONG>(std::lround(dx * second_along + nx * second_offset));
    second.y = start.y
        + static_cast<LONG>(std::lround(dy * second_along + ny * second_offset));
    second = cursor_clamp_to_desktop(second);

    // A taller arc needs a little more flight time or it reads as a twitch
    // instead of a boost-glide: keep the extra lateral distance visible.
    double duration_ms =
        (130.0 + distance * 0.30) * speed * (0.82 + cursor_random_unit() * 0.36);
    if (duration_ms < 80.0) {
        duration_ms = 80.0;
    }
    const double step_ms = 9.0 + cursor_random_unit() * 5.0;
    int steps = static_cast<int>(duration_ms / step_ms);
    if (steps < 10) {
        steps = 10;
    } else if (steps > 110) {
        steps = 110;
    }
    // Stronger boost exponent: more of the distance is covered while climbing,
    // then the pointer glides in on a longer decelerating tail.
    const double power = 1.85 + cursor_random_unit() * 1.05;
    const double tremor_phase = cursor_random_unit() * 6.283185307179586;

    for (int step = 1; step <= steps; ++step) {
        const double raw = static_cast<double>(step) / static_cast<double>(steps);
        POINT point =
            cursor_bezier(start, first, second, target, cursor_progress(raw, power));
        if (raw > 0.72 && distance > 160.0) {
            const double fade = (1.0 - raw) / 0.28;
            const double tremor =
                std::sin(raw * 22.0 + tremor_phase) * 1.4 * fade;
            point.x += static_cast<LONG>(std::lround(nx * tremor));
            point.y += static_cast<LONG>(std::lround(ny * tremor));
        }
        if (!cursor_move_to(cursor_clamp_to_desktop(point))) {
            return false;
        }
        Sleep(static_cast<DWORD>(
            (std::max)(1.0, step_ms * (0.75 + cursor_random_unit() * 0.5))));
    }

    // A fast glide sometimes overshoots a little and settles back. Keep this
    // phase injected as well, otherwise the guard would swallow the correction.
    if (distance > 140.0 && cursor_random_unit() < 0.45) {
        const double ux = dx / distance;
        const double uy = dy / distance;
        const double overshoot_px = 2.0 + cursor_random_unit() * 5.0;
        POINT overshoot{
            target.x + static_cast<LONG>(std::lround(ux * overshoot_px))
                + cursor_random_int(-2, 2),
            target.y + static_cast<LONG>(std::lround(uy * overshoot_px))
                + cursor_random_int(-2, 2)};
        overshoot = cursor_clamp_to_desktop(overshoot);
        if (!cursor_move_to(overshoot)) {
            return false;
        }
        Sleep(static_cast<DWORD>(cursor_random_int(10, 24)));
        const POINT correction{
            target.x - cursor_random_int(0, 2),
            target.y - cursor_random_int(0, 2)};
        if (!cursor_move_to(cursor_clamp_to_desktop(correction))) {
            return false;
        }
        Sleep(static_cast<DWORD>(cursor_random_int(5, 12)));
    }
    if (!cursor_move_to(target)) {
        return false;
    }
    Sleep(static_cast<DWORD>(cursor_random_int(4, 12)));
    return true;
}

// Uses one guarded SendInput call so a guard failure can never leave the left
// button held down between separate down/up calls.
bool press_left_button(InjectionPurpose purpose, const POINT* screen_point,
                       DWORD* error_code) {
    INPUT inputs[2]{};
    inputs[0].type = INPUT_MOUSE;
    inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    inputs[1].type = INPUT_MOUSE;
    inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
    return inject_guarded(purpose, inputs, ARRAYSIZE(inputs), screen_point,
                          error_code);
}

// Returns the pointer to where the user left it; a visible jump is the
// fallback if the glide itself cannot start.
void restore_cursor(POINT previous) {
    if (!glide_cursor_to(previous, 0.55)) {
        cursor_move_to(previous);
    }
}

bool click_search_field(HWND main_window, POINT point,
                        InjectionPurpose purpose, DWORD* error_code) {
    if (!guard_validate(purpose, &point, error_code)) {
        return false;
    }
    RECT window_rect{};
    if (!GetWindowRect(main_window, &window_rect) || !PtInRect(&window_rect, point)) {
        *error_code = ERROR_INVALID_PARAMETER;
        return false;
    }

    HWND hit = WindowFromPoint(point);
    DWORD hit_pid = 0;
    DWORD main_pid = 0;
    GetWindowThreadProcessId(hit, &hit_pid);
    GetWindowThreadProcessId(main_window, &main_pid);
    if (!hit || hit_pid != main_pid) {
        *error_code = ERROR_ACCESS_DENIED;
        return false;
    }

    POINT previous{};
    if (!GetCursorPos(&previous)) {
        *error_code = GetLastError();
        return false;
    }
    if (!glide_cursor_to(point)) {
        *error_code = GetLastError();
        restore_cursor(previous);
        return false;
    }
    Sleep(static_cast<DWORD>(cursor_random_int(35, 85)));

    DWORD click_error = ERROR_SUCCESS;
    const bool clicked = press_left_button(purpose, &point, &click_error);
    Sleep(static_cast<DWORD>(cursor_random_int(45, 100)));
    restore_cursor(previous);
    if (!clicked) {
        *error_code = click_error;
        return false;
    }
    *error_code = ERROR_SUCCESS;
    return true;
}

bool send_ctrl_a(InjectionPurpose purpose, DWORD* error_code) {
    INPUT inputs[4]{};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = 'A';
    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = 'A';
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
    return inject_guarded(purpose, inputs, ARRAYSIZE(inputs), nullptr,
                          error_code);
}

bool send_backspace(InjectionPurpose purpose, DWORD* error_code) {
    INPUT inputs[2]{};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_BACK;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_BACK;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
    return inject_guarded(purpose, inputs, ARRAYSIZE(inputs), nullptr,
                          error_code);
}

bool send_ctrl_v(InjectionPurpose purpose, DWORD* error_code) {
    INPUT inputs[4]{};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = 'V';
    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = 'V';
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
    return inject_guarded(purpose, inputs, ARRAYSIZE(inputs), nullptr,
                          error_code);
}

bool send_ctrl_key(WORD vk, InjectionPurpose purpose, DWORD* error_code) {
    INPUT inputs[4]{};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = vk;
    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = vk;
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
    return inject_guarded(purpose, inputs, ARRAYSIZE(inputs), nullptr,
                          error_code);
}

// EmptyClipboard after OpenClipboard(nullptr) leaves the clipboard without an
// owner, and SetClipboardData then fails. A window belongs to the thread that
// created it, so every calling thread gets its own message-only owner.
HWND clipboard_owner_window(DWORD* error_code) {
    constexpr wchar_t kClipboardOwnerClass[] = L"SuperLanguageClipboardOwner";
    thread_local HWND owner = nullptr;
    if (owner && IsWindow(owner)) {
        return owner;
    }
    const HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSEXW window_class{};
    window_class.cbSize = sizeof(window_class);
    window_class.lpfnWndProc = DefWindowProcW;
    window_class.hInstance = instance;
    window_class.lpszClassName = kClipboardOwnerClass;
    if (!RegisterClassExW(&window_class)) {
        const DWORD register_error = GetLastError();
        if (register_error != ERROR_CLASS_ALREADY_EXISTS) {
            *error_code = register_error ? register_error : ERROR_NOT_READY;
            return nullptr;
        }
    }
    owner = CreateWindowExW(0, kClipboardOwnerClass, L"", 0, 0, 0, 0, 0,
                            HWND_MESSAGE, nullptr, instance, nullptr);
    if (!owner) {
        const DWORD create_error = GetLastError();
        *error_code = create_error ? create_error : ERROR_NOT_READY;
    }
    return owner;
}

bool open_owned_clipboard(DWORD* error_code) {
    const HWND owner = clipboard_owner_window(error_code);
    if (!owner) {
        return false;
    }
    if (!OpenClipboard(owner)) {
        *error_code = GetLastError();
        return false;
    }
    return true;
}

// Copy clipboard payloads into private memory before replacing the clipboard.
// Holding an OLE IDataObject from OleGetClipboard is not enough: EmptyClipboard
// invalidates it, so the user's data would be lost when restoring afterwards.
struct ClipboardSnapshotItem {
    UINT format;
    HGLOBAL memory;
};

struct ClipboardSnapshot {
    ClipboardSnapshotItem items[64];
    int count;
};

bool clipboard_format_is_handle(UINT format) {
    switch (format) {
    case CF_BITMAP:
    case CF_METAFILEPICT:
    case CF_PALETTE:
    case CF_ENHMETAFILE:
    case CF_OWNERDISPLAY:
    case CF_DSPBITMAP:
    case CF_DSPMETAFILEPICT:
    case CF_DSPENHMETAFILE:
        return true;
    default:
        return format >= CF_GDIOBJFIRST && format <= CF_GDIOBJLAST;
    }
}

void free_clipboard_snapshot(ClipboardSnapshot* snapshot) {
    for (int index = 0; index < snapshot->count; ++index) {
        if (snapshot->items[index].memory) {
            GlobalFree(snapshot->items[index].memory);
            snapshot->items[index].memory = nullptr;
        }
    }
    snapshot->count = 0;
}

bool snapshot_clipboard(ClipboardSnapshot* snapshot, DWORD* error_code) {
    snapshot->count = 0;
    if (!open_owned_clipboard(error_code)) {
        return false;
    }
    constexpr size_t kMaxSnapshotBytes = 64u * 1024u * 1024u;
    size_t total_bytes = 0;
    bool complete = true;
    UINT format = 0;
    while ((format = EnumClipboardFormats(format)) != 0) {
        if (clipboard_format_is_handle(format)) {
            continue;
        }
        HANDLE data = GetClipboardData(format);
        if (!data) {
            continue;
        }
        const SIZE_T size = GlobalSize(data);
        if (size == 0) {
            continue;
        }
        if (snapshot->count >= ARRAYSIZE(snapshot->items)
            || total_bytes + size > kMaxSnapshotBytes) {
            *error_code = ERROR_NOT_ENOUGH_MEMORY;
            complete = false;
            break;
        }
        HGLOBAL copy = GlobalAlloc(GMEM_MOVEABLE, size);
        if (!copy) {
            *error_code = ERROR_NOT_ENOUGH_MEMORY;
            complete = false;
            break;
        }
        const void* source = GlobalLock(data);
        void* destination = GlobalLock(copy);
        if (!source || !destination) {
            if (destination) {
                GlobalUnlock(copy);
            }
            GlobalFree(copy);
            *error_code = ERROR_NOT_ENOUGH_MEMORY;
            complete = false;
            break;
        }
        memcpy(destination, source, size);
        GlobalUnlock(copy);
        GlobalUnlock(data);
        snapshot->items[snapshot->count].format = format;
        snapshot->items[snapshot->count].memory = copy;
        ++snapshot->count;
        total_bytes += size;
    }
    CloseClipboard();
    if (!complete) {
        free_clipboard_snapshot(snapshot);
        return false;
    }
    return true;
}

bool restore_clipboard(ClipboardSnapshot* snapshot, DWORD* error_code) {
    bool restored = false;
    for (int attempt = 0; attempt < 3 && !restored; ++attempt) {
        if (!open_owned_clipboard(error_code)) {
            Sleep(100);
            continue;
        }
        if (attempt == 0) {
            EmptyClipboard();
        }
        restored = true;
        for (int index = 0; index < snapshot->count; ++index) {
            HGLOBAL& memory = snapshot->items[index].memory;
            if (!memory) {
                continue;
            }
            if (SetClipboardData(snapshot->items[index].format, memory)) {
                memory = nullptr;
            } else {
                restored = false;
            }
        }
        CloseClipboard();
        if (!restored) {
            Sleep(100);
        }
    }
    free_clipboard_snapshot(snapshot);
    return restored;
}

// `after_queued_input` must be true when the caller has just injected SendInput
// keys (for example a Shift+Enter separator) that this text must not overtake.
// Single code unit through WM_CHAR, which preserves BMP characters exactly,
// including the '-' that SendInput's VK_PACKET path mangles (see below).
bool type_code_unit_guarded(HWND target, wchar_t unit, InjectionPurpose purpose,
                            DWORD* error_code) {
    return inject_wm_char_guarded(target, static_cast<WPARAM>(unit), purpose,
                                  error_code);
}

// A surrogate pair cannot travel through WM_CHAR: WeChat's Qt editor drops lone
// surrogates, so an emoji or a CJK extension B ideograph would vanish. The
// VK_PACKET path carries the pair intact (verified against 4.2.0.13). One
// guarded SendInput call keeps the four events together.
bool type_surrogate_pair_guarded(HWND target, wchar_t high, wchar_t low,
                                 InjectionPurpose purpose, DWORD* error_code) {
    if (!window_belongs_to_task(target)
        || !guard_validate(purpose, nullptr, error_code)) {
        if (!window_belongs_to_task(target)) {
            *error_code = ERROR_INVALID_STATE;
        }
        return false;
    }
    const wchar_t units[2] = {high, low};
    INPUT inputs[4]{};
    for (int unit_index = 0; unit_index < 2; ++unit_index) {
        for (int phase = 0; phase < 2; ++phase) {
            INPUT& input = inputs[unit_index * 2 + phase];
            input.type = INPUT_KEYBOARD;
            input.ki.wVk = 0;
            input.ki.wScan = static_cast<WORD>(units[unit_index]);
            input.ki.dwFlags = KEYEVENTF_UNICODE
                | (phase == 1 ? KEYEVENTF_KEYUP : 0);
        }
    }
    if (!inject_guarded(purpose, inputs, ARRAYSIZE(inputs), nullptr,
                        error_code)) {
        return false;
    }
    apply_injection_transition(purpose);
    *error_code = ERROR_SUCCESS;
    return true;
}

// Characters go through WM_CHAR because it preserves BMP text exactly. WeChat
// 4.2 replaces the character after a VK_PACKET '-' with '-' (verified against
// 4.2.0.13: "-2" arrives as "--"), which is why the '-' of a group name like
// "ai-2" must not use that path. Surrogate pairs are the exception: WM_CHAR
// drops them, so they are sent as VK_PACKET keystrokes instead.
//
// A line break has no WM_CHAR equivalent: the composer ignores 0x0D and 0x0A.
// It has to be a real Shift+Enter, which only SendInput can produce. That key
// is queued while the characters below are sent synchronously, so the loop
// waits after the break before continuing; the wait is what keeps the next
// character from overtaking the queued key.
// The window that owns WeChat's keyboard focus: the main window, or a
// same-process top-level popup that took the foreground (the Ctrl+F search
// popup, the mention picker). Never another application's window.
HWND text_input_target(HWND main_window) {
    const HWND foreground = GetForegroundWindow();
    if (foreground && foreground != main_window) {
        DWORD foreground_process_id = 0;
        GetWindowThreadProcessId(foreground, &foreground_process_id);
        if (foreground_process_id != 0
            && foreground_process_id == g_task_guard.process_id) {
            return foreground;
        }
    }
    return main_window;
}

bool type_text_guarded(HWND main_window, const wchar_t* text,
                       InjectionPurpose purpose, DWORD* error_code) {
    // WM_CHAR must be addressed to the window that owns WeChat's keyboard
    // focus. In the wide layout Ctrl+F opens the search as a separate top-level
    // Qt popup that takes the foreground, so the characters belong to that
    // popup. Same process only: never type into another application.
    HWND text_target = text_input_target(main_window);

    constexpr int kKeystrokeGapMinMs = 4;
    constexpr int kKeystrokeGapMaxMs = 12;
    constexpr DWORD kLineBreakSettleMs = 250;
    for (const wchar_t* cursor = text; *cursor; ++cursor) {
        if (*cursor == L'\r' || *cursor == L'\n') {
            // Only the message composer carries line breaks; the search field
            // and the mention filter are single-line.
            if (purpose == InjectionPurpose::ComposeText) {
                if (!send_shift_enter(purpose, error_code)) {
                    return false;
                }
                Sleep(kLineBreakSettleMs);
                if (*cursor == L'\r' && cursor[1] == L'\n') {
                    ++cursor;
                }
            }
            continue;
        }
        if (IS_HIGH_SURROGATE(*cursor) && IS_LOW_SURROGATE(cursor[1])) {
            if (!type_surrogate_pair_guarded(text_target, cursor[0],
                                             cursor[1], purpose, error_code)) {
                return false;
            }
            ++cursor;
        } else if (!type_code_unit_guarded(text_target, *cursor, purpose,
                                           error_code)) {
            return false;
        }
        Sleep(static_cast<DWORD>(
            cursor_random_int(kKeystrokeGapMinMs, kKeystrokeGapMaxMs)));
    }
    *error_code = ERROR_SUCCESS;
    return true;
}

bool send_unicode_text(const wchar_t* text, InjectionPurpose purpose,
                       DWORD per_character_delay_ms, DWORD* error_code) {
    if (!text || !error_code) {
        if (error_code) {
            *error_code = ERROR_INVALID_PARAMETER;
        }
        return false;
    }
    *error_code = ERROR_SUCCESS;
    for (const wchar_t* cursor = text; *cursor; ++cursor) {
        if (*cursor == L'\r' || *cursor == L'\n') {
            *error_code = ERROR_INVALID_PARAMETER;
            return false;
        }
        INPUT inputs[2]{};
        for (int index = 0; index < 2; ++index) {
            inputs[index].type = INPUT_KEYBOARD;
            inputs[index].ki.wScan = static_cast<WORD>(*cursor);
            inputs[index].ki.dwFlags = KEYEVENTF_UNICODE
                | (index == 1 ? KEYEVENTF_KEYUP : 0);
        }
        if (!inject_guarded(purpose, inputs, ARRAYSIZE(inputs), nullptr,
                            error_code)) {
            return false;
        }
        if (per_character_delay_ms) {
            Sleep(per_character_delay_ms);
        }
    }
    *error_code = ERROR_SUCCESS;
    return true;
}

const wchar_t* g_search_method = L"-";
const wchar_t* g_send_method = L"-";
const wchar_t* g_visibility_method = L"-";

// Visibility is a window-state operation, not a semantic input injection.
// Avoid the global hotkey path so hidden/background windows never require a
// synthetic foreground key event.
bool set_wechat_visibility(HWND main_window, bool visible, DWORD* error_code) {
    *error_code = ERROR_SUCCESS;
    if (!main_window || !IsWindow(main_window)) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }
    if ((IsWindowVisible(main_window) != FALSE) == visible) {
        g_visibility_method = L"无需切换";
        return true;
    }
    // Preserve the user's window size: restore a minimized window, otherwise
    // just show it. Maximizing here would fight the window-relative click
    // model, which works at any size.
    const int show_command =
        visible ? (IsIconic(main_window) ? SW_RESTORE : SW_SHOW) : SW_HIDE;
    ShowWindow(main_window, show_command);
    for (int attempt = 0; attempt < 10; ++attempt) {
        Sleep(30);
        if ((IsWindowVisible(main_window) != FALSE) == visible) {
            g_visibility_method = L"ShowWindow";
            return true;
        }
    }
    *error_code = ERROR_NOT_READY;
    return false;
}

// WeChat ships a new Qt build with almost every release, and the version
// prefix is part of its window class names (for example
// "Qt51514QWindowToolSaveBits"). Matching the stable suffix keeps the mention
// picker detectable after a WeChat upgrade.
bool is_wechat_tool_window_class(const wchar_t* class_name) {
    return class_name && wcsncmp(class_name, L"Qt", 2) == 0
           && wcsstr(class_name, L"QWindowTool") != nullptr;
}

// A truncated query is incomplete: a truncated baseline cannot prove that a
// window is new, so find_new_tool_window() refuses to use one.
struct ToolWindowQuery {
    DWORD process_id;
    HWND handles[64];
    int count;
    bool truncated;
};

BOOL CALLBACK collect_tool_window(HWND hwnd, LPARAM lparam) {
    auto* query = reinterpret_cast<ToolWindowQuery*>(lparam);
    DWORD process_id = 0;
    GetWindowThreadProcessId(hwnd, &process_id);
    if (process_id != query->process_id || !IsWindowVisible(hwnd)) {
        return TRUE;
    }
    wchar_t class_name[64]{};
    if (GetClassNameW(hwnd, class_name, ARRAYSIZE(class_name)) == 0
        || !is_wechat_tool_window_class(class_name)) {
        return TRUE;
    }
    RECT rect{};
    if (!GetWindowRect(hwnd, &rect)) {
        return TRUE;
    }
    const int width = rect.right - rect.left;
    const int height = rect.bottom - rect.top;
    if (width < 60 || width > 900 || height < 30 || height > 700) {
        return TRUE;
    }
    if (query->count >= static_cast<int>(ARRAYSIZE(query->handles))) {
        query->truncated = true;
        return FALSE;
    }
    query->handles[query->count++] = hwnd;
    return TRUE;
}

void collect_tool_windows(DWORD process_id, ToolWindowQuery* query) {
    query->process_id = process_id;
    query->count = 0;
    query->truncated = false;
    EnumWindows(collect_tool_window, reinterpret_cast<LPARAM>(query));
}

bool tool_window_in(const ToolWindowQuery& query, HWND hwnd) {
    for (int index = 0; index < query.count; ++index) {
        if (query.handles[index] == hwnd) {
            return true;
        }
    }
    return false;
}

HWND find_new_tool_window(DWORD process_id, const ToolWindowQuery& baseline,
                          UINT timeout_ms) {
    if (baseline.truncated) {
        return nullptr;
    }
    const ULONGLONG deadline = GetTickCount64() + timeout_ms;
    while (true) {
        ToolWindowQuery current{};
        collect_tool_windows(process_id, &current);
        for (int index = 0; index < current.count; ++index) {
            if (!tool_window_in(baseline, current.handles[index])) {
                return current.handles[index];
            }
        }
        if (guard_aborted() || GetTickCount64() >= deadline) {
            return nullptr;
        }
        Sleep(80);
    }
}

bool wait_for_tool_window_close(HWND tool_window, UINT timeout_ms) {
    if (!tool_window) {
        return true;
    }
    const ULONGLONG deadline = GetTickCount64() + timeout_ms;
    while (IsWindow(tool_window) && IsWindowVisible(tool_window)) {
        if (guard_aborted() || GetTickCount64() >= deadline) {
            return false;
        }
        Sleep(40);
    }
    return true;
}

bool tool_window_visible(HWND tool_window) {
    return tool_window && IsWindow(tool_window)
           && IsWindowVisible(tool_window);
}

// A single hidden frame while the Qt list re-renders is not a close. Require
// the window to stay invisible for a short confirmation window. An abort
// returns false so the next guarded injection reports the abort.
bool tool_window_closed(HWND tool_window, UINT confirm_ms) {
    if (!tool_window) {
        return true;
    }
    const ULONGLONG deadline = GetTickCount64() + confirm_ms;
    while (true) {
        if (tool_window_visible(tool_window) || guard_aborted()) {
            return false;
        }
        if (GetTickCount64() >= deadline) {
            return true;
        }
        Sleep(40);
    }
}

// The Qt picker resizes while its candidate list loads. Treat it as ready only
// after its rectangle has been stable for a short window; otherwise the first
// Enter can land before any candidate is highlighted.
bool wait_for_tool_window_settle(HWND tool_window, UINT stable_ms,
                                 UINT timeout_ms) {
    if (!tool_window_visible(tool_window)) {
        return false;
    }
    const ULONGLONG deadline = GetTickCount64() + timeout_ms;
    RECT previous{};
    ULONGLONG stable_since = GetTickCount64();
    bool have_previous = false;
    while (true) {
        if (!tool_window_visible(tool_window)) {
            return false;
        }
        RECT current{};
        if (!GetWindowRect(tool_window, &current)) {
            return false;
        }
        const bool same = have_previous
                          && current.left == previous.left
                          && current.top == previous.top
                          && current.right == previous.right
                          && current.bottom == previous.bottom;
        if (!same) {
            previous = current;
            have_previous = true;
            stable_since = GetTickCount64();
        } else if (GetTickCount64() - stable_since >= stable_ms) {
            return true;
        }
        if (guard_aborted() || GetTickCount64() >= deadline) {
            return false;
        }
        Sleep(40);
    }
}

// Mention callers often pass "@name" even though the executor injects its own
// trigger. Strip only the outer whitespace and a single leading '@'; inner
// spaces are preserved because they can be part of a group nickname.
bool normalize_mention(const wchar_t* input, wchar_t* output, size_t capacity) {
    if (!input || !output || capacity == 0) {
        return false;
    }
    const wchar_t* begin = input;
    while (*begin == L' ' || *begin == L'\t' || *begin == L'　') {
        ++begin;
    }
    if (*begin == L'@') {
        ++begin;
    }
    while (*begin == L' ' || *begin == L'\t' || *begin == L'　') {
        ++begin;
    }
    const wchar_t* end = begin + wcslen(begin);
    while (end > begin
           && (end[-1] == L' ' || end[-1] == L'\t' || end[-1] == L'　')) {
        --end;
    }
    const size_t length = static_cast<size_t>(end - begin);
    if (length == 0 || length >= capacity) {
        return false;
    }
    for (const wchar_t* cursor = begin; cursor < end; ++cursor) {
        if (*cursor == L'\r' || *cursor == L'\n') {
            return false;
        }
    }
    wmemcpy(output, begin, length);
    output[length] = L'\0';
    return true;
}

// WeChat's picker treats a space as "confirm the highlighted candidate", so a
// display name that contains spaces cannot be typed literally. Filter by the
// longest whitespace-separated token instead: "ai-微信助理 19978937690"
// becomes "19978937690", which selects the numbered member even when another
// member shares the "ai-微信助理" prefix.
void mention_filter_token(const wchar_t* name, wchar_t* output,
                          size_t capacity) {
    if (!name || !output || capacity == 0) {
        return;
    }
    const wchar_t* best = name;
    size_t best_length = 0;
    const wchar_t* cursor = name;
    while (*cursor) {
        while (*cursor == L' ' || *cursor == L'\t' || *cursor == L'　') {
            ++cursor;
        }
        const wchar_t* start = cursor;
        while (*cursor && *cursor != L' ' && *cursor != L'\t'
               && *cursor != L'　') {
            ++cursor;
        }
        const size_t length = static_cast<size_t>(cursor - start);
        if (length > best_length) {
            best = start;
            best_length = length;
        }
    }
    if (best_length == 0) {
        best = name;
        best_length = wcslen(name);
    }
    if (best_length >= capacity) {
        best_length = capacity - 1;
    }
    wmemcpy(output, best, best_length);
    output[best_length] = L'\0';
}

// Structural diagnostics only: never log nicknames, targets or message bodies.
void mention_log(const wchar_t* format, ...) {
    wchar_t path[MAX_PATH * 2]{};
    if (GetModuleFileNameW(nullptr, path, MAX_PATH) == 0) {
        return;
    }
    wchar_t* separator = wcsrchr(path, L'\\');
    if (!separator) {
        return;
    }
    wcscpy_s(separator + 1,
             MAX_PATH * 2 - static_cast<size_t>(separator + 1 - path),
             L"mention-debug.log");
    constexpr ULONGLONG kMaxLogBytes = 1024ull * 1024ull;
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (GetFileAttributesExW(path, GetFileExInfoStandard, &attributes)) {
        const ULONGLONG size =
            (static_cast<ULONGLONG>(attributes.nFileSizeHigh) << 32)
            | attributes.nFileSizeLow;
        wchar_t rotated[MAX_PATH * 2 + 2]{};
        if (size > kMaxLogBytes
            && swprintf_s(rotated, ARRAYSIZE(rotated), L"%s.1", path) > 0) {
            MoveFileExW(path, rotated, MOVEFILE_REPLACE_EXISTING);
        }
    }
    FILE* file = nullptr;
    if (_wfopen_s(&file, path, L"a, ccs=UTF-8") != 0 || !file) {
        return;
    }
    SYSTEMTIME now{};
    GetLocalTime(&now);
    std::fwprintf(file, L"%04u-%02u-%02u %02u:%02u:%02u.%03u ",
                  now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute,
                  now.wSecond, now.wMilliseconds);
    va_list arguments;
    va_start(arguments, format);
    std::vfwprintf(file, format, arguments);
    va_end(arguments);
    std::fwprintf(file, L"\n");
    std::fclose(file);
}

// Focus diagnostics: hwndFocus/hwndCaret plus the caret rectangle let
// the log show whether the composer or the search box owns keyboard focus.
void log_focus_state(HWND main_window, const wchar_t* tag) {
    if (!main_window) {
        return;
    }
    DWORD process_id = 0;
    const DWORD thread_id = GetWindowThreadProcessId(main_window, &process_id);
    GUITHREADINFO info{};
    info.cbSize = sizeof(info);
    if (!thread_id || !GetGUIThreadInfo(thread_id, &info)) {
        mention_log(L"%ls gui_info failed err=%lu", tag,
                    static_cast<unsigned long>(GetLastError()));
        return;
    }
    wchar_t focus_class[64]{};
    wchar_t caret_class[64]{};
    GetClassNameW(info.hwndFocus, focus_class, ARRAYSIZE(focus_class));
    GetClassNameW(info.hwndCaret, caret_class, ARRAYSIZE(caret_class));
    RECT client{};
    POINT origin{};
    GetClientRect(main_window, &client);
    ClientToScreen(main_window, &origin);
    mention_log(
        L"%ls focus=%p/%ls caret=%p/%ls rc=%ld,%ld,%ld,%ld origin=%ld,%ld size=%ldx%ld flags=%lu",
        tag, info.hwndFocus, focus_class, info.hwndCaret, caret_class,
        info.rcCaret.left, info.rcCaret.top, info.rcCaret.right,
        info.rcCaret.bottom, origin.x, origin.y,
        client.right - client.left, client.bottom - client.top, info.flags);
}

bool send_shift_enter(InjectionPurpose purpose, DWORD* error_code) {
    INPUT inputs[4]{};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_SHIFT;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_RETURN;
    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = VK_RETURN;
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_SHIFT;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;
    return inject_guarded(purpose, inputs, ARRAYSIZE(inputs), nullptr,
                          error_code);
}

bool send_enter_key(InjectionPurpose purpose, DWORD* error_code) {
    INPUT inputs[2]{};
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_RETURN;
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = VK_RETURN;
    inputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
    return inject_guarded(purpose, inputs, ARRAYSIZE(inputs), nullptr,
                          error_code);
}

} // namespace

WeChatSearchPanelAction dismiss_wechat_search_panel(HWND main_window) {
    WeChatSearchPanelAction action{};
    if (!main_window || !IsWindow(main_window)) {
        action.error = ERROR_INVALID_WINDOW_HANDLE;
        return action;
    }

    // Ctrl+F's in-window search view is already dismissed by the Enter that
    // selects the conversation. What remains is the docked 搜一搜 Chromium
    // panel, which is only present on some WeChat builds. Clicking this point
    // unconditionally is unsafe: in the single-pane (narrow) layout the same
    // top-right point lands on the chat header's "..." button, and the menu it
    // opens swallows the following composer click and @ trigger. Click only
    // when the hit window really is a Chromium panel embedded in the main
    // window; otherwise report no panel and leave the UI untouched.
    if (guard_aborted()) {
        action.error = ERROR_OPERATION_ABORTED;
        return action;
    }
    DWORD point_error = ERROR_SUCCESS;
    if (!client_relative_point(main_window, kSearchClosePointXDips,
                               kSearchClosePointYDips, &action.point,
                               &point_error)) {
        action.error = point_error ? point_error : ERROR_NOT_READY;
        return action;
    }
    HWND hit = WindowFromPoint(action.point);
    if (!hit || GetAncestor(hit, GA_ROOT) != main_window) {
        action.error = ERROR_SUCCESS;
        return action;
    }
    wchar_t hit_class[64]{};
    if (GetClassNameW(hit, hit_class, ARRAYSIZE(hit_class)) == 0
        || _wcsnicmp(hit_class, L"Chrome_WidgetWin", 16) != 0) {
        action.error = ERROR_SUCCESS;
        return action;
    }
    action.found = true;

    // The docked 搜一搜 web panel is a child of the WeChat main window, which
    // the injection guard accepts.
    POINT previous{};
    const bool have_previous = GetCursorPos(&previous) != FALSE;
    if (!glide_cursor_to(action.point)) {
        action.error = GetLastError();
        if (have_previous) {
            restore_cursor(previous);
        }
        return action;
    }
    Sleep(static_cast<DWORD>(cursor_random_int(35, 85)));
    DWORD click_error = ERROR_SUCCESS;
    if (!press_left_button(InjectionPurpose::SearchPanelClose,
                           &action.point, &click_error)) {
        action.error = click_error ? click_error : ERROR_NOT_READY;
        if (have_previous) {
            restore_cursor(previous);
        }
        return action;
    }
    action.clicked = true;
    Sleep(static_cast<DWORD>(cursor_random_int(45, 100)));
    if (have_previous) {
        restore_cursor(previous);
    }

    // The click is the exit gesture itself; there is no panel window left to
    // poll for disappearance.
    action.closed = true;
    return action;
}

const wchar_t* last_search_method() {
    return g_search_method;
}

const wchar_t* last_send_method() {
    return g_send_method;
}

const wchar_t* last_visibility_method() {
    return g_visibility_method;
}

bool show_wechat_window(HWND main_window, DWORD* error_code) {
    return set_wechat_visibility(main_window, true, error_code);
}

bool hide_wechat_window(HWND main_window, DWORD* error_code) {
    return set_wechat_visibility(main_window, false, error_code);
}

// ---------------------------------------------------------------------------
// Mouse-only input guard.
//
// While the automation clicks through WeChat, a real mouse would fight the
// scripted pointer. The low-level hook below swallows *physical* mouse input
// (move/wheel/buttons) and lets injected SendInput events through, so scripted
// clicks keep working while the user keeps the keyboard. A watchdog thread
// unhooks the mouse at the deadline even when the automation is wedged, so the
// user can always take the mouse back.
// ---------------------------------------------------------------------------
constexpr UINT kGuardReleaseMessage = WM_APP + 40;
constexpr UINT_PTR kGuardTimerId = 0x51AC;
constexpr unsigned kGuardDefaultMs = 45000;

HHOOK g_mouse_hook = nullptr;
HANDLE g_guard_thread = nullptr;
DWORD g_guard_thread_id = 0;
HANDLE g_guard_ready = nullptr;
volatile LONG g_guard_stop = 0;
volatile LONG g_guard_abort = 0;
volatile LONG g_guard_active = 0;
ULONGLONG g_guard_deadline = 0;
unsigned g_guard_timeout_ms = kGuardDefaultMs;

bool guard_aborted() {
    return InterlockedCompareExchange(&g_guard_abort, 0, 0) != 0;
}

void stop_mouse_guard();

LRESULT CALLBACK mouse_guard_proc(int code, WPARAM wparam, LPARAM lparam) {
    if (code == HC_ACTION) {
        const auto* info = reinterpret_cast<const MSLLHOOKSTRUCT*>(lparam);
        if (info && (info->flags & LLMHF_INJECTED) == 0) {
            return 1;  // swallow physical mouse input
        }
    }
    return CallNextHookEx(nullptr, code, wparam, lparam);
}

DWORD WINAPI input_guard_thread(LPVOID /*parameter*/) {
    g_mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, mouse_guard_proc, nullptr, 0);
    if (!g_mouse_hook) {
        InterlockedExchange(&g_guard_abort, 1);
        SetEvent(g_guard_ready);
        return 1;
    }
    InterlockedExchange(&g_guard_active, 1);
    SetEvent(g_guard_ready);
    SetTimer(nullptr, kGuardTimerId, 100, nullptr);
    MSG message{};
    while (InterlockedCompareExchange(&g_guard_stop, 0, 0) == 0) {
        const BOOL got = GetMessageW(&message, nullptr, 0, 0);
        if (got <= 0) {
            break;
        }
        if (message.message == kGuardReleaseMessage) {
            InterlockedExchange(&g_guard_abort, 1);
            break;
        }
        if (message.message == WM_TIMER && message.hwnd == nullptr) {
            if (GetTickCount64() >= g_guard_deadline) {
                InterlockedExchange(&g_guard_abort, 1);
                break;
            }
            continue;
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    KillTimer(nullptr, kGuardTimerId);
    if (g_mouse_hook) {
        UnhookWindowsHookEx(g_mouse_hook);
        g_mouse_hook = nullptr;
    }
    InterlockedExchange(&g_guard_active, 0);
    return 0;
}

bool start_mouse_guard(unsigned timeout_ms) {
    if (InterlockedCompareExchange(&g_guard_active, 0, 0) != 0) {
        return true;
    }
    stop_mouse_guard();
    InterlockedExchange(&g_guard_stop, 0);
    InterlockedExchange(&g_guard_abort, 0);
    const unsigned hold_ms = timeout_ms >= 1000 ? timeout_ms : kGuardDefaultMs;
    g_guard_timeout_ms = hold_ms;
    g_guard_deadline = GetTickCount64() + hold_ms;
    g_guard_ready = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_guard_ready) {
        return false;
    }
    g_guard_thread = CreateThread(nullptr, 0, input_guard_thread, nullptr, 0,
                                  &g_guard_thread_id);
    if (!g_guard_thread) {
        CloseHandle(g_guard_ready);
        g_guard_ready = nullptr;
        return false;
    }
    WaitForSingleObject(g_guard_ready, 1000);
    if (InterlockedCompareExchange(&g_guard_active, 0, 0) == 0) {
        stop_mouse_guard();
        return false;
    }
    return true;
}

void stop_mouse_guard() {
    InterlockedExchange(&g_guard_stop, 1);
    if (g_guard_thread_id) {
        PostThreadMessageW(g_guard_thread_id, WM_QUIT, 0, 0);
    }
    if (g_guard_thread) {
        WaitForSingleObject(g_guard_thread, 2000);
        CloseHandle(g_guard_thread);
        g_guard_thread = nullptr;
    }
    g_guard_thread_id = 0;
    if (g_guard_ready) {
        CloseHandle(g_guard_ready);
        g_guard_ready = nullptr;
    }
}

void release_mouse_guard_async() {
    if (g_guard_thread_id) {
        PostThreadMessageW(g_guard_thread_id, kGuardReleaseMessage, 0, 0);
    }
}

bool begin_input_guard(unsigned timeout_ms) {
    return start_mouse_guard(timeout_ms);
}

void end_input_guard() {
    stop_mouse_guard();
}

bool input_guard_active() {
    return InterlockedCompareExchange(&g_guard_active, 0, 0) != 0;
}

void emergency_stop_input() {
    InterlockedExchange(&g_guard_abort, 1);
    release_mouse_guard_async();
}

bool automation_aborted() {
    return guard_aborted();
}

unsigned input_guard_timeout_ms() {
    return g_guard_timeout_ms;
}

bool begin_automation_guard(HWND target_window, unsigned timeout_ms,
                            DWORD* error_code) {
    return begin_guard_for_target(target_window, timeout_ms, error_code);
}

void end_automation_guard() {
    g_task_guard = {};
}

AutomationState automation_state() {
    return g_task_guard.active ? g_task_guard.stage : AutomationState::Idle;
}

// WeChat 4.x renders parts of its UI as separate top-level Qt windows of the
// same process: the Ctrl+F search popup (wide layout), the mention picker, and
// the docked 搜一搜 panel. Any of them can legitimately own the foreground while
// the automation types into it, so "the foreground is WeChat" has to mean the
// process, not the main-window handle. Without this, the first keystroke after
// Ctrl+F is rejected with ERROR_ACCESS_DENIED as soon as the search popup takes
// the foreground.
bool window_belongs_to_task(HWND window) {
    if (!window || !g_task_guard.active) {
        return false;
    }
    if (window == g_task_guard.target_window) {
        return true;
    }
    DWORD process_id = 0;
    GetWindowThreadProcessId(window, &process_id);
    return process_id != 0 && process_id == g_task_guard.process_id;
}

bool foreground_belongs_to_target() {
    return window_belongs_to_task(GetForegroundWindow());
}

namespace {

bool purpose_allowed(InjectionPurpose purpose, AutomationState stage) {
    switch (purpose) {
    case InjectionPurpose::SearchFocus:
        return stage == AutomationState::TargetValidated
            || stage == AutomationState::SearchFocused;
    case InjectionPurpose::SearchListFocus:
        return stage == AutomationState::TargetValidated;
    case InjectionPurpose::SearchClear:
    case InjectionPurpose::SearchText:
    case InjectionPurpose::SubmitSearch:
        return stage == AutomationState::SearchFocused;
    case InjectionPurpose::SearchPanelClose:
        return stage == AutomationState::TargetVerified;
    case InjectionPurpose::ComposeFocus:
        return stage == AutomationState::DraftVerifiedEmpty
            || stage == AutomationState::Composed;
    case InjectionPurpose::ComposeText:
    case InjectionPurpose::MentionSelect:
        return stage == AutomationState::DraftVerifiedEmpty
            || stage == AutomationState::Composed;
    case InjectionPurpose::MentionLineBreak:
        return stage == AutomationState::Composed;
    case InjectionPurpose::AttachmentPaste:
        return stage == AutomationState::DraftVerifiedEmpty;
    // Removes a staged attachment card after a failed paste or submit. Never
    // allowed from SendInjected: nothing may follow an injected Ctrl+Enter.
    case InjectionPurpose::ComposeClear:
        return stage == AutomationState::Composed
            || stage == AutomationState::SubmitReady;
    case InjectionPurpose::SubmitMessage:
        return stage == AutomationState::SubmitReady;
    }
    return false;
}

void apply_injection_transition(InjectionPurpose purpose) {
    switch (purpose) {
    case InjectionPurpose::SubmitSearch:
        g_task_guard.stage = AutomationState::SearchEntered;
        break;
    case InjectionPurpose::ComposeText:
    case InjectionPurpose::MentionSelect:
    case InjectionPurpose::MentionLineBreak:
    case InjectionPurpose::AttachmentPaste:
        g_task_guard.stage = AutomationState::Composed;
        break;
    case InjectionPurpose::SubmitMessage:
        g_task_guard.send_injected = true;
        g_task_guard.stage = AutomationState::SendInjected;
        break;
    default:
        break;
    }
}

bool begin_guard_for_target(HWND target_window, unsigned timeout_ms,
                            DWORD* error_code) {
    if (!error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!target_window || !IsWindow(target_window) || !IsWindowVisible(target_window)) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }
    if (g_task_guard.active) {
        *error_code = ERROR_INVALID_STATE;
        return false;
    }
    if (!input_guard_active() || guard_aborted()) {
        *error_code = ERROR_NOT_READY;
        return false;
    }

    DWORD process_id = 0;
    GetWindowThreadProcessId(target_window, &process_id);
    if (!process_id) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }

    const unsigned hold_ms = timeout_ms >= 1000 ? timeout_ms : kGuardDefaultMs;
    ULONGLONG deadline = GetTickCount64() + hold_ms;
    if (g_guard_deadline && g_guard_deadline < deadline) {
        deadline = g_guard_deadline;
    }
    g_task_guard = {};
    g_task_guard.target_window = target_window;
    g_task_guard.process_id = process_id;
    g_task_guard.deadline_ms = deadline;
    g_task_guard.stage = AutomationState::TargetValidated;
    g_task_guard.active = true;
    g_task_guard.send_injected = false;
    return true;
}

bool guard_validate(InjectionPurpose purpose, const POINT* screen_point,
                    DWORD* error_code) {
    if (!error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!g_task_guard.active || g_task_guard.stage == AutomationState::Idle) {
        *error_code = ERROR_INVALID_STATE;
        return false;
    }
    if (!purpose_allowed(purpose, g_task_guard.stage)) {
        *error_code = ERROR_INVALID_STATE;
        return false;
    }
    if (!input_guard_active() || guard_aborted()) {
        *error_code = guard_aborted() ? ERROR_OPERATION_ABORTED : ERROR_NOT_READY;
        return false;
    }
    if (guard_aborted() || GetTickCount64() >= g_task_guard.deadline_ms) {
        InterlockedExchange(&g_guard_abort, 1);
        *error_code = ERROR_TIMEOUT;
        return false;
    }
    if (!IsWindow(g_task_guard.target_window)
        || !IsWindowVisible(g_task_guard.target_window)) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }
    DWORD process_id = 0;
    GetWindowThreadProcessId(g_task_guard.target_window, &process_id);
    if (process_id != g_task_guard.process_id) {
        *error_code = ERROR_ACCESS_DENIED;
        return false;
    }
    if (!foreground_belongs_to_target()) {
        *error_code = ERROR_ACCESS_DENIED;
        return false;
    }

    if (screen_point) {
        const HWND hit = WindowFromPoint(*screen_point);
        DWORD hit_process_id = 0;
        if (hit) {
            GetWindowThreadProcessId(hit, &hit_process_id);
        }
        // Accept the WeChat process' own windows (the main window, the mention
        // picker tool window) and any window embedded in the main window tree.
        // The docked 搜一搜 web panel is such a child although it is rendered by
        // the WeChatAppEx helper process; the close click must reach it.
        const bool embedded_in_wechat =
            hit && GetAncestor(hit, GA_ROOT) == g_task_guard.target_window;
        if (!hit
            || (hit_process_id != g_task_guard.process_id
                && !embedded_in_wechat)) {
            *error_code = ERROR_ACCESS_DENIED;
            return false;
        }
    }
    return true;
}

bool release_partial_injection(const INPUT* inputs, UINT inserted,
                               DWORD* error_code) {
    if (error_code) {
        *error_code = ERROR_SUCCESS;
    }
    INPUT releases[8]{};
    UINT release_count = 0;
    for (UINT index = inserted; index > 0; --index) {
        const INPUT& input = inputs[index - 1];
        INPUT release{};
        bool release_needed = false;
        if (input.type == INPUT_KEYBOARD
            && (input.ki.dwFlags & KEYEVENTF_KEYUP) == 0) {
            release.type = INPUT_KEYBOARD;
            release.ki = input.ki;
            release.ki.dwFlags = KEYEVENTF_KEYUP
                | (input.ki.dwFlags
                   & (KEYEVENTF_EXTENDEDKEY | KEYEVENTF_SCANCODE));
            release_needed = true;
        } else if (input.type == INPUT_MOUSE) {
            DWORD up_flags = 0;
            if ((input.mi.dwFlags & MOUSEEVENTF_LEFTDOWN) != 0) {
                up_flags |= MOUSEEVENTF_LEFTUP;
            }
            if ((input.mi.dwFlags & MOUSEEVENTF_RIGHTDOWN) != 0) {
                up_flags |= MOUSEEVENTF_RIGHTUP;
            }
            if ((input.mi.dwFlags & MOUSEEVENTF_MIDDLEDOWN) != 0) {
                up_flags |= MOUSEEVENTF_MIDDLEUP;
            }
            if ((input.mi.dwFlags & MOUSEEVENTF_XDOWN) != 0) {
                up_flags |= MOUSEEVENTF_XUP;
            }
            if (up_flags != 0) {
                release.type = INPUT_MOUSE;
                release.mi = input.mi;
                release.mi.dwFlags = up_flags;
                release_needed = true;
            }
        }
        if (release_needed
            && release_count < static_cast<UINT>(ARRAYSIZE(releases))) {
            releases[release_count++] = release;
        }
    }
    if (release_count > 0) {
        UINT released = 0;
        DWORD release_failure = ERROR_SUCCESS;
        for (int attempt = 0; attempt < 3 && released < release_count; ++attempt) {
            SetLastError(ERROR_SUCCESS);
            const UINT sent = SendInput(release_count - released,
                                        releases + released, sizeof(INPUT));
            released += sent;
            if (released < release_count) {
                release_failure = GetLastError();
                Sleep(20);
            }
        }
        if (released != release_count) {
            if (error_code) {
                *error_code = release_failure ? release_failure : ERROR_NOT_READY;
            }
            return false;
        }
    }
    return true;
}

bool inserted_key_down(const INPUT* inputs, UINT inserted, WORD virtual_key) {
    for (UINT index = 0; index < inserted; ++index) {
        if (inputs[index].type == INPUT_KEYBOARD
            && (inputs[index].ki.dwFlags & KEYEVENTF_KEYUP) == 0
            && inputs[index].ki.wVk == virtual_key) {
            return true;
        }
    }
    return false;
}

bool inject_guarded(InjectionPurpose purpose, const INPUT* inputs, UINT count,
                    const POINT* screen_point, DWORD* error_code) {
    if (!inputs || count == 0 || !guard_validate(purpose, screen_point, error_code)) {
        return false;
    }
    SetLastError(ERROR_SUCCESS);
    const UINT sent =
        SendInput(count, const_cast<INPUT*>(inputs), sizeof(INPUT));
    if (sent != count) {
        const DWORD last_error = GetLastError();
        const bool enter_injected =
            purpose == InjectionPurpose::SubmitMessage
            && inserted_key_down(inputs, sent, VK_RETURN);
        if (enter_injected) {
            g_task_guard.send_injected = true;
            g_task_guard.stage = AutomationState::SendInjected;
        }
        if (sent > 0) {
            DWORD release_error = ERROR_SUCCESS;
            if (!release_partial_injection(inputs, sent, &release_error)) {
                *error_code = release_error;
                return false;
            }
        }
        *error_code = last_error ? last_error : ERROR_NOT_READY;
        return false;
    }
    apply_injection_transition(purpose);
    *error_code = ERROR_SUCCESS;
    return true;
}

bool inject_wm_char_guarded(HWND target_window, WPARAM character,
                            InjectionPurpose purpose, DWORD* error_code) {
    // A same-process popup (search popup, mention picker) is an acceptable
    // recipient: it is WeChat's own input surface and owns the keyboard focus
    // while it is open.
    if (!window_belongs_to_task(target_window)
        || !guard_validate(purpose, nullptr, error_code)) {
        if (!window_belongs_to_task(target_window)) {
            *error_code = ERROR_INVALID_STATE;
        }
        return false;
    }
    constexpr UINT kWmCharTimeoutMs = 2000;
    DWORD_PTR message_result = 0;
    SetLastError(ERROR_SUCCESS);
    if (!SendMessageTimeoutW(target_window, WM_CHAR, character, 1,
                             SMTO_ABORTIFHUNG | SMTO_BLOCK, kWmCharTimeoutMs,
                             &message_result)) {
        const DWORD send_error = GetLastError();
        *error_code = send_error && send_error != ERROR_TIMEOUT
            ? send_error : ERROR_TIMEOUT;
        return false;
    }
    apply_injection_transition(purpose);
    *error_code = ERROR_SUCCESS;
    return true;
}

} // namespace

// The foreground switch is asynchronous for cross-process windows: a Qt window
// usually becomes foreground a frame after SetForegroundWindow returns, so a
// single immediate comparison reported failure for a window that was already up.
bool wait_until_foreground(HWND hwnd, DWORD timeout_ms) {
    const DWORD deadline = GetTickCount() + timeout_ms;
    for (;;) {
        if (GetForegroundWindow() == hwnd) {
            return true;
        }
        if (static_cast<LONG>(GetTickCount() - deadline) >= 0) {
            return false;
        }
        Sleep(25);
    }
}

bool force_foreground(HWND hwnd) {
    if (!hwnd || !IsWindow(hwnd)) {
        return false;
    }
    SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE);
    if (SetForegroundWindow(hwnd) && wait_until_foreground(hwnd, 150)) {
        return true;
    }

    const HWND foreground = GetForegroundWindow();
    const DWORD foreground_thread =
        foreground ? GetWindowThreadProcessId(foreground, nullptr) : 0;
    const DWORD current_thread = GetCurrentThreadId();
    if (!foreground_thread || foreground_thread == current_thread) {
        BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd);
        return wait_until_foreground(hwnd, 800);
    }
    if (!AttachThreadInput(current_thread, foreground_thread, TRUE)) {
        return false;
    }
    SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    SetForegroundWindow(hwnd);
    SetFocus(hwnd);
    AttachThreadInput(current_thread, foreground_thread, FALSE);
    return wait_until_foreground(hwnd, 800);
}

WeChatStatus query_wechat() {
    WeChatStatus status{};

    ProcessScan processes{};
    scan_processes(processes);
    status.running = processes.count > 0;
    status.process_count = processes.count;
    if (processes.executable[0]) {
        wcsncpy_s(status.executable_path, ARRAYSIZE(status.executable_path),
                  processes.executable, _TRUNCATE);
    }
    if (!status.running) {
        return status;
    }

    WindowScan windows{};
    windows.pids = processes.pids;
    windows.process_count = processes.count;
    EnumWindows(scan_window, reinterpret_cast<LPARAM>(&windows));

    status.main_window = windows.legacy_main || windows.large_main;
    status.login_window = windows.login_window;
    status.login_ui_visible = windows.login_ui_visible;
    status.tray_window = windows.tray_window;
    status.main_window_handle = windows.main_handle;
    status.login_window_handle = windows.login_handle;

    if (windows.login_window) {
        status.login_state = WeChatLoginState::NotLoggedIn;
    } else if (windows.tray_window || windows.legacy_main) {
        status.login_state = WeChatLoginState::LoggedIn;
    } else if (windows.login_ui_visible) {
        status.login_state = WeChatLoginState::NotLoggedIn;
    } else if (windows.large_main) {
        status.login_state = WeChatLoginState::LoggedIn;
    }
    if (status.login_state == WeChatLoginState::LoggedIn && !status.main_window_handle) {
        status.main_window_handle = windows.qt_handle;
    }
    return status;
}

WeChatWindowAction present_wechat_window(HWND main_window) {
    WeChatWindowAction action{};
    if (!main_window || !IsWindow(main_window)) {
        action.error = ERROR_INVALID_WINDOW_HANDLE;
        return action;
    }

    // Never resize or maximize the window: every click target is expressed
    // relative to the client area, so the automation works at any window size
    // and the user's layout is left untouched.
    if (IsIconic(main_window)) {
        ShowWindow(main_window, SW_RESTORE);
    } else if (!IsWindowVisible(main_window)) {
        ShowWindow(main_window, SW_SHOW);
    }

    action.foregrounded = force_foreground(main_window);
    action.maximized = IsZoomed(main_window) != FALSE;
    if (!action.foregrounded) {
        action.error = ERROR_ACCESS_DENIED;
    }
    return action;
}

bool search_wechat_conversation(HWND main_window, const wchar_t* conversation,
                                DWORD* error_code) {
    if (!error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!main_window || !IsWindow(main_window)) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }
    if (!conversation || !conversation[0]) {
        *error_code = ERROR_INVALID_PARAMETER;
        return false;
    }
    if (guard_aborted()) {
        *error_code = ERROR_TIMEOUT;
        return false;
    }

    const WeChatWindowAction action = present_wechat_window(main_window);
    if (!action.foregrounded) {
        *error_code = action.error ? action.error : ERROR_NOT_READY;
        return false;
    }
    if (!begin_automation_guard(main_window, input_guard_timeout_ms(),
                                error_code)) {
        return false;
    }
    const auto fail = [error_code](DWORD code) {
        end_automation_guard();
        *error_code = code ? code : ERROR_NOT_READY;
        return false;
    };

    // Refuse to start when the composer already holds a draft: any leftover
    // text would be prepended to our message.
    Sleep(250);
    if (composer_has_content(main_window)) {
        mention_log(L"search blocked: composer already holds content");
        return fail(ERROR_ALREADY_EXISTS);
    }

    // WeChat switches to a single-pane layout on narrow windows. There the chat
    // list and its Ctrl+F search box are hidden while a conversation is open,
    // and Ctrl+F is a no-op. The point below is the header back arrow in the
    // single-pane layout and the chat-list search field in the wide layout, so
    // clicking it normalizes both cases without guessing the window size.
    POINT list_point{};
    DWORD list_error = ERROR_SUCCESS;
    if (client_relative_point(main_window, kSearchListPointXDips,
                              kSearchListPointYDips, &list_point,
                              &list_error)) {
        DWORD list_click_error = ERROR_SUCCESS;
        if (!click_search_field(main_window, list_point,
                                InjectionPurpose::SearchListFocus,
                                &list_click_error)) {
            // Best effort: Ctrl+F still works in the wide layout even when this
            // click is rejected by the guard or hits a non-WeChat window.
            mention_log(L"search list focus click skipped err=%lu",
                        static_cast<unsigned long>(list_click_error));
        }
        Sleep(150);
    }

    if (!send_ctrl_key('F', InjectionPurpose::SearchFocus, error_code)) {
        return fail(*error_code);
    }
    // Re-send after the overlay mounts. Pressing Ctrl+F again while the search
    // box is open only re-focuses it (does not toggle it closed), and the repeat
    // makes the first search after a window restore reliable.
    Sleep(120);
    if (!send_ctrl_key('F', InjectionPurpose::SearchFocus, error_code)) {
        return fail(*error_code);
    }
    g_search_method = L"快捷键 Ctrl+F";
    g_task_guard.stage = AutomationState::SearchFocused;

    if (!send_ctrl_a(InjectionPurpose::SearchClear, error_code)) {
        return fail(*error_code);
    }
    Sleep(60);
    if (!send_backspace(InjectionPurpose::SearchClear, error_code)) {
        return fail(*error_code);
    }
    Sleep(80);
    if (!type_text_guarded(main_window, conversation,
                           InjectionPurpose::SearchText, error_code)) {
        return fail(*error_code);
    }
    // Ctrl+F can silently miss the search box (window just restored, overlay not
    // mounted yet); the name then lands in the composer and would be prepended to
    // the message. The composer was verified empty above, so anything there now
    // is our search text: clear it and fail instead of sending a dirty message.
    Sleep(200);
    if (composer_has_content(main_window)) {
        mention_log(L"search text landed in composer: clearing and failing");
        DWORD clear_error = ERROR_SUCCESS;
        send_ctrl_a(InjectionPurpose::SearchClear, &clear_error);
        Sleep(40);
        send_backspace(InjectionPurpose::SearchClear, &clear_error);
        return fail(ERROR_NOT_READY);
    }
    return true;
}

bool press_enter_in_wechat(HWND main_window, DWORD* error_code) {
    if (!error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!main_window || !IsWindow(main_window)) {
        *error_code = ERROR_INVALID_WINDOW_HANDLE;
        return false;
    }

    // The search overlay owns keyboard focus after typing; do not raise or refocus
    // the main window here or the subsequent Enter will miss the search field.
    if (guard_aborted()) {
        *error_code = ERROR_TIMEOUT;
        return false;
    }
    return send_enter_key(InjectionPurpose::SubmitSearch, error_code);
}

bool accept_current_conversation(HWND main_window, const wchar_t* expected_name,
                                 DWORD* error_code) {
    if (!error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!main_window || !IsWindow(main_window) || !expected_name
        || !expected_name[0]) {
        *error_code = ERROR_INVALID_PARAMETER;
        return false;
    }
    if (!g_task_guard.active || g_task_guard.target_window != main_window
        || g_task_guard.stage != AutomationState::SearchEntered) {
        *error_code = ERROR_INVALID_STATE;
        return false;
    }
    if (wcslen(expected_name) >= ARRAYSIZE(g_task_guard.target_name)) {
        *error_code = ERROR_BUFFER_OVERFLOW;
        return false;
    }
    wcscpy_s(g_task_guard.target_name, expected_name);
    g_task_guard.stage = AutomationState::TargetVerified;
    return true;
}

bool accept_reused_conversation(HWND main_window, const wchar_t* expected_name,
                                DWORD* error_code) {
    if (!error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!main_window || !IsWindow(main_window) || !expected_name
        || !expected_name[0]) {
        *error_code = ERROR_INVALID_PARAMETER;
        return false;
    }
    if (!g_task_guard.active || g_task_guard.target_window != main_window
        || g_task_guard.stage != AutomationState::TargetValidated) {
        *error_code = ERROR_INVALID_STATE;
        return false;
    }
    if (guard_aborted() || GetTickCount64() >= g_task_guard.deadline_ms) {
        *error_code = ERROR_TIMEOUT;
        return false;
    }
    if (!foreground_belongs_to_target()) {
        *error_code = ERROR_ACCESS_DENIED;
        return false;
    }
    if (wcslen(expected_name) >= ARRAYSIZE(g_task_guard.target_name)) {
        *error_code = ERROR_BUFFER_OVERFLOW;
        return false;
    }

    wcscpy_s(g_task_guard.target_name, expected_name);
    g_task_guard.stage = AutomationState::TargetVerified;
    *error_code = ERROR_SUCCESS;
    return true;
}

bool send_wechat_message(HWND main_window, const wchar_t* message,
                         const wchar_t* mention, bool mention_line_break,
                         AutomationResult* result, DWORD* error_code) {
    if (!error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (!result) {
        *error_code = ERROR_INVALID_PARAMETER;
        return false;
    }
    *result = AutomationResult{};
    const auto finish = [result](AutomationOutcome outcome, DWORD error) {
        result->outcome = outcome;
        result->state = automation_state();
        result->error = error;
        result->send_injected = g_task_guard.send_injected;
    };
    const auto fail = [&](DWORD error) {
        const DWORD reported = error ? error : ERROR_NOT_READY;
        finish(AutomationOutcome::Failed, reported);
        *error_code = reported;
        return false;
    };

    if (!main_window || !IsWindow(main_window)) {
        return fail(ERROR_INVALID_WINDOW_HANDLE);
    }
    if (!message || !message[0]) {
        return fail(ERROR_INVALID_PARAMETER);
    }
    if (!g_task_guard.active || g_task_guard.target_window != main_window
        || g_task_guard.stage != AutomationState::TargetVerified
        || !g_task_guard.target_name[0]) {
        return fail(ERROR_INVALID_STATE);
    }
    if (guard_aborted()) {
        return fail(ERROR_TIMEOUT);
    }

    g_task_guard.stage = AutomationState::DraftVerifiedEmpty;
    // WeChat's editor can still be focused on the search result after Enter.
    // Use the guarded pointer path when possible so the humanized trajectory
    // also performs useful work: it focuses the composer and restores the
    // user's cursor. A failed click is non-fatal; typing follows the keyboard
    // focus anyway.
    POINT message_point{};
    DWORD focus_error = ERROR_SUCCESS;
    bool input_point_ready = false;
    bool compose_clicked = false;
    DWORD compose_click_error = ERROR_SUCCESS;
    const bool mention_requested = mention && mention[0];
    if (mention_requested) {
        log_focus_state(main_window, L"pre-click");
    }
    if (get_message_input_point(main_window, &message_point, &focus_error)) {
        input_point_ready = true;
        if (click_search_field(main_window, message_point,
                               InjectionPurpose::ComposeFocus,
                               &compose_click_error)) {
            compose_clicked = true;
            Sleep(80);
        }
    }
    if (mention_requested) {
        log_focus_state(main_window, L"post-click");
    }
    // Clicking a Qt child can move foreground ownership for a frame. Make
    // the target window authoritative again before typing.
    force_foreground(main_window);
    Sleep(80);
    if (mention && mention[0]) {
        // WeChat 4.x renders the mention picker in a separate Qt tool
        // window. Use Unicode keyboard injection, which follows keyboard
        // focus, so both the trigger and the filter reach that picker.
        constexpr DWORD kMentionStageDelayMs = 200;
        constexpr UINT kPickerAppearTimeoutMs = 2000;
        constexpr UINT kPickerSettleTimeoutMs = 1500;
        constexpr UINT kPickerSettleStableMs = 200;
        constexpr UINT kPickerCloseTimeoutMs = 1500;
        constexpr DWORD kMentionCharacterDelayMs = 100;

        wchar_t mention_name[128]{};
        if (!normalize_mention(mention, mention_name,
                               ARRAYSIZE(mention_name))) {
            mention_log(L"mention invalid");
            return fail(ERROR_INVALID_PARAMETER);
        }
        wchar_t mention_filter[128]{};
        mention_filter_token(mention_name, mention_filter,
                             ARRAYSIZE(mention_filter));
        mention_log(L"mention begin len=%u filter_len=%u",
                    static_cast<unsigned>(wcslen(mention_name)),
                    static_cast<unsigned>(wcslen(mention_filter)));
        {
            wchar_t fg_class[64]{};
            const HWND foreground = GetForegroundWindow();
            GetClassNameW(foreground, fg_class, ARRAYSIZE(fg_class));
            mention_log(L"focus point=%d clicked=%d click_err=%lu fg=%p fgcls=%ls",
                        input_point_ready, compose_clicked,
                        static_cast<unsigned long>(compose_click_error),
                        foreground, fg_class);
        }

        DWORD process_id = 0;
        GetWindowThreadProcessId(main_window, &process_id);
        ToolWindowQuery baseline{};
        collect_tool_windows(process_id, &baseline);
        if (baseline.truncated) {
            mention_log(L"tool window baseline truncated count=%d",
                        baseline.count);
            return fail(ERROR_NOT_READY);
        }
        if (!send_unicode_text(L"@", InjectionPurpose::ComposeText, 0,
                               error_code)) {
            mention_log(L"trigger failed err=%lu",
                        static_cast<unsigned long>(*error_code));
            return fail(*error_code);
        }
        {
            wchar_t fg_class[64]{};
            const HWND foreground = GetForegroundWindow();
            GetClassNameW(foreground, fg_class, ARRAYSIZE(fg_class));
            mention_log(L"trigger fg=%p fgcls=%ls baseline_tools=%d",
                        foreground, fg_class, baseline.count);
        }
        log_focus_state(main_window, L"post-trigger");
        Sleep(kMentionStageDelayMs);
        // The picker is a readiness signal, not a best-effort hint: typing
        // a name without it leaves literal "@name" in the composer because
        // Enter becomes a newline under the Ctrl+Enter send shortcut.
        const ULONGLONG picker_start = GetTickCount64();
        HWND picker_window =
            find_new_tool_window(process_id, baseline,
                                 kPickerAppearTimeoutMs);
        const ULONGLONG picker_elapsed = GetTickCount64() - picker_start;
        if (!picker_window) {
            ToolWindowQuery current{};
            collect_tool_windows(process_id, &current);
            mention_log(L"picker missing elapsed=%llu baseline=%d current=%d",
                        static_cast<unsigned long long>(picker_elapsed),
                        baseline.count, current.count);
            log_focus_state(main_window, L"picker-missing");
            return fail(guard_aborted() ? ERROR_OPERATION_ABORTED
                                        : ERROR_NOT_FOUND);
        }
        wchar_t picker_class[64]{};
        GetClassNameW(picker_window, picker_class, ARRAYSIZE(picker_class));
        if (!wait_for_tool_window_settle(picker_window,
                                         kPickerSettleStableMs,
                                         kPickerSettleTimeoutMs)) {
            mention_log(L"picker unstable elapsed=%llu",
                        static_cast<unsigned long long>(picker_elapsed));
            return fail(guard_aborted() ? ERROR_OPERATION_ABORTED
                                        : ERROR_NOT_READY);
        }

        // Type the filter token one code unit at a time and watch the
        // picker. The token has no spaces, so Enter can only mean "select
        // the highlighted candidate". WM_CHAR reaches the picker as well
        // (a filter that matches nothing leaves the typed text instead of a
        // chip), and unlike VK_PACKET it keeps a '-' from a nickname intact.
        size_t typed = 0;
        // WM_CHAR goes to the window that owns the keyboard focus, which is
        // the picker while it is open; sending to the main window instead was
        // verified to reach the filter as well.
        for (; mention_filter[typed]; ++typed) {
            if (tool_window_closed(picker_window, 120)) {
                mention_log(L"picker closed during typing at=%u",
                            static_cast<unsigned>(typed));
                return fail(ERROR_INVALID_STATE);
            }
            const HWND filter_target = text_input_target(main_window);
            const wchar_t unit = mention_filter[typed];
            const bool surrogate_pair =
                IS_HIGH_SURROGATE(unit)
                && IS_LOW_SURROGATE(mention_filter[typed + 1]);
            const bool typed_ok = surrogate_pair
                ? type_surrogate_pair_guarded(filter_target, unit,
                                              mention_filter[typed + 1],
                                              InjectionPurpose::ComposeText,
                                              error_code)
                : type_code_unit_guarded(filter_target, unit,
                                         InjectionPurpose::ComposeText,
                                         error_code);
            if (!typed_ok) {
                mention_log(L"type failed at=%u err=%lu",
                            static_cast<unsigned>(typed),
                            static_cast<unsigned long>(*error_code));
                return fail(*error_code);
            }
            if (surrogate_pair) {
                ++typed;
            }
            Sleep(kMentionCharacterDelayMs);
        }

        Sleep(kMentionStageDelayMs);
        if (!tool_window_visible(picker_window)) {
            mention_log(L"picker closed before enter");
            return fail(ERROR_INVALID_STATE);
        }
        DWORD mention_error = ERROR_SUCCESS;
        if (!send_enter_key(InjectionPurpose::MentionSelect,
                            &mention_error)) {
            mention_log(L"enter failed err=%lu",
                        static_cast<unsigned long>(mention_error));
            return fail(mention_error);
        }
        Sleep(kMentionStageDelayMs);

        // The separator and body are only written after the picker has
        // actually closed; otherwise they can be swallowed or treated as
        // further filter text.
        const ULONGLONG close_start = GetTickCount64();
        bool closed = wait_for_tool_window_close(picker_window,
                                                 kPickerCloseTimeoutMs);
        if (!closed) {
            // Retrying is safe only while the picker is still open: the
            // second Enter selects the highlighted candidate rather than
            // submitting a message.
            DWORD retry_error = ERROR_SUCCESS;
            if (send_enter_key(InjectionPurpose::MentionSelect,
                               &retry_error)) {
                Sleep(kMentionStageDelayMs);
                closed = wait_for_tool_window_close(picker_window, 800);
            }
        }
        const ULONGLONG close_elapsed = GetTickCount64() - close_start;
        if (!closed) {
            mention_log(L"picker did not close elapsed=%llu",
                        static_cast<unsigned long long>(close_elapsed));
            return fail(guard_aborted() ? ERROR_OPERATION_ABORTED
                                        : ERROR_TIMEOUT);
        }
        mention_log(
            L"mention selected picker_ms=%llu close_ms=%llu class=%ls",
            static_cast<unsigned long long>(picker_elapsed),
            static_cast<unsigned long long>(close_elapsed), picker_class);

        // The picker briefly owns focus while it closes. Restore the
        // composer before adding the separator and message body.
        force_foreground(main_window);
        if (message_point.x || message_point.y) {
            DWORD reclick_error = ERROR_SUCCESS;
            click_search_field(main_window, message_point,
                               InjectionPurpose::ComposeFocus,
                               &reclick_error);
        }
        force_foreground(main_window);
        Sleep(200);
        if (mention_line_break) {
            if (!send_shift_enter(InjectionPurpose::MentionLineBreak,
                                  error_code)) {
                return fail(*error_code);
            }
        } else if (!type_text_guarded(main_window, L" ",
                                      InjectionPurpose::ComposeText,
                                      error_code)) {
            return fail(*error_code);
        }
    }
    if (!type_text_guarded(main_window, message,
                           InjectionPurpose::ComposeText, error_code)) {
        return fail(*error_code);
    }
    g_task_guard.stage = AutomationState::SubmitReady;
    DWORD submit_error = ERROR_SUCCESS;
    if (!send_ctrl_key(VK_RETURN, InjectionPurpose::SubmitMessage,
                       &submit_error)) {
        finish(g_task_guard.send_injected
                   ? AutomationOutcome::InjectedUnverified
                   : AutomationOutcome::Failed,
               submit_error);
        *error_code = submit_error ? submit_error : ERROR_NOT_READY;
        return g_task_guard.send_injected;
    }
    g_send_method = L"快捷键 Ctrl+Enter";
    Sleep(350);
    finish(AutomationOutcome::InjectedUnverified, ERROR_SUCCESS);
    *error_code = ERROR_SUCCESS;
    return true;
}

bool send_wechat_attachments(HWND main_window, const wchar_t* paths,
                             AutomationResult* result, int* sent_count,
                             DWORD* error_code) {
    if (!error_code) {
        return false;
    }
    *error_code = ERROR_SUCCESS;
    if (sent_count) {
        *sent_count = 0;
    }
    if (!result) {
        *error_code = ERROR_INVALID_PARAMETER;
        return false;
    }
    *result = AutomationResult{};
    const auto finish = [result](AutomationOutcome outcome, DWORD error) {
        result->outcome = outcome;
        result->state = automation_state();
        result->error = error;
        result->send_injected = g_task_guard.send_injected;
    };
    const auto fail = [&](AutomationOutcome outcome, DWORD error) {
        const DWORD reported = error ? error : ERROR_NOT_READY;
        finish(outcome, reported);
        *error_code = reported;
        return false;
    };

    if (!main_window || !IsWindow(main_window)) {
        return fail(AutomationOutcome::Failed, ERROR_INVALID_WINDOW_HANDLE);
    }
    if (!paths || !paths[0]) {
        return fail(AutomationOutcome::Failed, ERROR_INVALID_PARAMETER);
    }
    if (guard_aborted()) {
        return fail(AutomationOutcome::Failed, ERROR_TIMEOUT);
    }

    constexpr int kMaxFiles = 10;
    constexpr int kPathCapacity = 1024;
    wchar_t files[kMaxFiles][kPathCapacity]{};
    int file_count = 0;

    const wchar_t* cursor = paths;
    while (cursor && *cursor) {
        const wchar_t* separator = wcschr(cursor, L';');
        size_t length = separator ? static_cast<size_t>(separator - cursor)
                                  : wcslen(cursor);
        while (length > 0 && (*cursor == L' ' || *cursor == L'\t')) {
            ++cursor;
            --length;
        }
        while (length > 0) {
            const wchar_t last = cursor[length - 1];
            if (last != L' ' && last != L'\t') {
                break;
            }
            --length;
        }
        if (length >= 2 && cursor[0] == L'"' && cursor[length - 1] == L'"') {
            ++cursor;
            length -= 2;
        }
        if (length > 0) {
            if (file_count >= kMaxFiles) {
                return fail(AutomationOutcome::Failed,
                            ERROR_TOO_MANY_OPEN_FILES);
            }
            if (length >= kPathCapacity) {
                return fail(AutomationOutcome::Failed, ERROR_BUFFER_OVERFLOW);
            }
            wcsncpy_s(files[file_count], kPathCapacity, cursor, length);
            const DWORD attributes = GetFileAttributesW(files[file_count]);
            if (attributes == INVALID_FILE_ATTRIBUTES
                || (attributes & FILE_ATTRIBUTE_DIRECTORY)) {
                return fail(AutomationOutcome::Failed, ERROR_FILE_NOT_FOUND);
            }
            ++file_count;
        }
        if (!separator) {
            break;
        }
        cursor = separator + 1;
    }
    if (file_count == 0) {
        return fail(AutomationOutcome::Failed, ERROR_INVALID_PARAMETER);
    }

    if (!g_task_guard.active || g_task_guard.target_window != main_window
        || g_task_guard.stage != AutomationState::TargetVerified
        || !g_task_guard.target_name[0]) {
        return fail(AutomationOutcome::Failed, ERROR_INVALID_STATE);
    }

    POINT input_point{};
    if (!get_message_input_point(main_window, &input_point, error_code)) {
        return fail(AutomationOutcome::Failed, *error_code);
    }

    // WeChat 4.x renders the editor as a windowless pane, so the composer is
    // probed visually: the send button turns green only while the composer
    // holds content, which is also how a staged paste is detected below.
    Sleep(150);
    if (composer_has_content(main_window)) {
        return fail(AutomationOutcome::NotAttempted, ERROR_ALREADY_EXISTS);
    }
    g_task_guard.stage = AutomationState::DraftVerifiedEmpty;
    mention_log(L"attach begin files=%d", file_count);

    if (!click_search_field(main_window, input_point,
                            InjectionPurpose::ComposeFocus, error_code)) {
        return fail(AutomationOutcome::Failed, *error_code);
    }
    mention_log(L"attach composer clicked err=%lu",
                error_code ? *error_code : 0UL);

    ClipboardSnapshot snapshot{};
    if (!snapshot_clipboard(&snapshot, error_code)) {
        return fail(AutomationOutcome::Failed, *error_code);
    }
    const auto restore = [&snapshot]() {
        DWORD restore_error = ERROR_SUCCESS;
        restore_clipboard(&snapshot, &restore_error);
    };
    // The composer was verified empty before the paste, so anything still in it
    // after a failed stage or submit is ours. Leaving a file card behind would
    // make every later job fail the draft check (ERROR_ALREADY_EXISTS).
    // ComposeClear is rejected once Ctrl+Enter was injected (SendInjected).
    const auto clear_composer = [main_window]() {
        DWORD clear_error = ERROR_SUCCESS;
        if (send_ctrl_a(InjectionPurpose::ComposeClear, &clear_error)) {
            Sleep(40);
            send_backspace(InjectionPurpose::ComposeClear, &clear_error);
        }
        Sleep(80);
        mention_log(L"attach composer cleared err=%lu content=%d",
                    static_cast<unsigned long>(clear_error),
                    composer_has_content(main_window) ? 1 : 0);
    };

    struct LocalDropFiles {
        DWORD pFiles;
        POINT pt;
        BOOL fNC;
        BOOL fWide;
    };

    wchar_t file_list[kMaxFiles * kPathCapacity + 2]{};
    size_t list_length = 0;
    for (int index = 0; index < file_count; ++index) {
        const size_t item_length = wcslen(files[index]);
        if (list_length + item_length + 2 > ARRAYSIZE(file_list)) {
            restore();
            return fail(AutomationOutcome::Failed, ERROR_BUFFER_OVERFLOW);
        }
        wcsncpy_s(file_list + list_length,
                  ARRAYSIZE(file_list) - list_length, files[index], _TRUNCATE);
        list_length += item_length + 1;
    }
    file_list[list_length++] = L'\0';
    const size_t list_bytes = list_length * sizeof(wchar_t);

    HGLOBAL drop_memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT,
                                      sizeof(LocalDropFiles) + list_bytes);
    if (!drop_memory) {
        restore();
        return fail(AutomationOutcome::Failed, ERROR_NOT_ENOUGH_MEMORY);
    }
    auto* drop_header = static_cast<LocalDropFiles*>(GlobalLock(drop_memory));
    if (!drop_header) {
        GlobalFree(drop_memory);
        restore();
        return fail(AutomationOutcome::Failed, ERROR_NOT_ENOUGH_MEMORY);
    }
    drop_header->pFiles = sizeof(LocalDropFiles);
    drop_header->fWide = TRUE;
    memcpy(reinterpret_cast<BYTE*>(drop_header) + sizeof(LocalDropFiles),
           file_list, list_bytes);
    GlobalUnlock(drop_memory);

    DWORD clipboard_error = ERROR_SUCCESS;
    bool clipboard_set = false;
    if (open_owned_clipboard(&clipboard_error)) {
        if (!EmptyClipboard()) {
            clipboard_error = GetLastError();
        } else if (SetClipboardData(CF_HDROP, drop_memory)) {
            clipboard_set = true;
        } else {
            clipboard_error = GetLastError();
        }
        CloseClipboard();
    }
    if (!clipboard_set) {
        GlobalFree(drop_memory);
        restore();
        return fail(AutomationOutcome::Failed, clipboard_error);
    }

    DWORD operation_error = ERROR_SUCCESS;
    const ULONGLONG paste_started = GetTickCount64();
    const bool pasted = send_ctrl_v(InjectionPurpose::AttachmentPaste,
                                    &operation_error);
    mention_log(L"attach paste injected=%d err=%lu ms=%llu", pasted ? 1 : 0,
                operation_error, GetTickCount64() - paste_started);
    if (!pasted) {
        restore();
        return fail(AutomationOutcome::Failed, operation_error);
    }

    // The clipboard only proves that Ctrl+V was injected. Require the composer
    // to show content before allowing the submission key.
    bool attachment_staged = false;
    operation_error = ERROR_NOT_READY;
    const ULONGLONG stage_deadline = GetTickCount64() + 10000;
    for (;;) {
        if (composer_has_content(main_window)) {
            attachment_staged = true;
            operation_error = ERROR_SUCCESS;
            break;
        }
        if (guard_aborted()) {
            operation_error = ERROR_OPERATION_ABORTED;
            break;
        }
        if (GetTickCount64() >= stage_deadline) {
            break;
        }
        Sleep(50);
    }
    restore();
    mention_log(L"attach staged=%d err=%lu ms=%llu", attachment_staged ? 1 : 0,
                operation_error, GetTickCount64() - paste_started);
    if (!attachment_staged) {
        clear_composer();
        return fail(AutomationOutcome::Failed, operation_error);
    }

    g_task_guard.stage = AutomationState::SubmitReady;
    DWORD submit_error = ERROR_SUCCESS;
    const bool submitted =
        send_ctrl_key(VK_RETURN, InjectionPurpose::SubmitMessage,
                      &submit_error);
    if (!submitted) {
        if (!g_task_guard.send_injected) {
            clear_composer();
        }
        finish(g_task_guard.send_injected
                   ? AutomationOutcome::InjectedUnverified
                   : AutomationOutcome::Failed,
               submit_error);
        *error_code = submit_error ? submit_error : ERROR_NOT_READY;
        return g_task_guard.send_injected;
    }

    g_send_method = L"快捷键 Ctrl+Enter";
    // Best-effort settle: the send button turns grey once the composer
    // empties after submission. Delivery stays InjectedUnverified either way.
    const ULONGLONG clear_deadline = GetTickCount64() + 350;
    while (composer_has_content(main_window)
           && GetTickCount64() < clear_deadline) {
        Sleep(50);
    }
    if (sent_count) {
        *sent_count = file_count;
    }
    finish(AutomationOutcome::InjectedUnverified, ERROR_SUCCESS);
    *error_code = ERROR_SUCCESS;
    return true;
}

bool find_wechat_install(wchar_t* path, size_t capacity) {
    if (!path || capacity == 0) {
        return false;
    }
    path[0] = L'\0';

    wchar_t raw[1024]{};
    for (const InstallKey& key : kInstallKeys) {
        if (read_registry_string(key.root, key.subkey, key.value, raw, ARRAYSIZE(raw))
            && build_candidate_path(raw, key.executable, path, capacity)) {
            return true;
        }
    }
    for (const InstallKey& key : kAppPathKeys) {
        if (read_registry_string(key.root, key.subkey, key.value, raw, ARRAYSIZE(raw))
            && build_candidate_path(raw, key.executable, path, capacity)) {
            return true;
        }
    }
    for (const wchar_t* pattern : kCommonPaths) {
        wchar_t expanded[1024]{};
        const DWORD length = ExpandEnvironmentStringsW(pattern, expanded,
                                                       ARRAYSIZE(expanded));
        if (length > 0 && length <= ARRAYSIZE(expanded) && file_exists(expanded)) {
            wcsncpy_s(path, capacity, expanded, _TRUNCATE);
            return true;
        }
    }
    return false;
}

bool launch_wechat(const wchar_t* executable_path, DWORD* error_code) {
    if (error_code) {
        *error_code = ERROR_SUCCESS;
    }
    if (!executable_path || !file_exists(executable_path)) {
        if (error_code) {
            *error_code = ERROR_FILE_NOT_FOUND;
        }
        return false;
    }

    wchar_t working_directory[MAX_PATH]{};
    wcsncpy_s(working_directory, executable_path, _TRUNCATE);
    wchar_t* last_separator = wcsrchr(working_directory, L'\\');
    if (last_separator) {
        *last_separator = L'\0';
    } else {
        working_directory[0] = L'\0';
    }

    const wchar_t* file_name = wcsrchr(executable_path, L'\\');
    file_name = file_name ? file_name + 1 : executable_path;

    wchar_t command_line[MAX_PATH + 32]{};
    if (_wcsicmp(file_name, L"Weixin.exe") == 0) {
        swprintf_s(command_line, ARRAYSIZE(command_line), L"\"%s\" --scene=desktop",
                   executable_path);
    } else {
        swprintf_s(command_line, ARRAYSIZE(command_line), L"\"%s\"", executable_path);
    }

    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_SHOWNORMAL;
    PROCESS_INFORMATION process{};
    const BOOL created = CreateProcessW(
        executable_path, command_line, nullptr, nullptr, FALSE, 0, nullptr,
        working_directory[0] ? working_directory : nullptr, &startup, &process);
    if (!created) {
        if (error_code) {
            *error_code = GetLastError();
        }
        return false;
    }

    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return true;
}

} // namespace feather::automation
