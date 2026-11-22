#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define WINVER 0x0A00
#define _WIN32_WINNT 0x0A00
#define NTDDI_VERSION 0x0A00000D

#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <psapi.h>
#include <shellapi.h>

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cwchar>
#include <string>

#include "api_server.h"
#include "automation.h"
#include "queue_store.h"
#include "resource.h"
#include "version.h"

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "msimg32.lib")

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_BORDER_COLOR
#define DWMWA_BORDER_COLOR 34
#endif
#ifndef DWMWA_CAPTION_COLOR
#define DWMWA_CAPTION_COLOR 35
#endif
#ifndef DWMWA_TEXT_COLOR
#define DWMWA_TEXT_COLOR 36
#endif

namespace {

constexpr wchar_t kWindowClass[] = L"SuperLanguage.AutomationShell";
constexpr wchar_t kHelpClass[] = L"SuperLanguage.ApiGuide";
constexpr wchar_t kWindowTitle[] = L"SuperLanguage — 微信消息自动化";
constexpr wchar_t kHelpTitle[] = L"API / Webhook / MCP 调用示例";
constexpr wchar_t kMutexName[] = L"Local\\SuperLanguage.AutomationShell.Singleton";
constexpr wchar_t kAppName[] = L"SuperLanguage";
constexpr wchar_t kTrayTip[] = L"SuperLanguage · 微信消息自动化";
// queue.db 按 exe 目录共享，单实例互斥量只覆盖当前会话；跨会话靠这个独占文件。
constexpr wchar_t kInstanceLockFile[] = L"instance.lock";
constexpr ULONGLONG kLogRotateBytes = 1024 * 1024;
constexpr ULONGLONG kLoginWaitMs = 300000;
constexpr unsigned kQueueBackoffInitialMs = 30000;
constexpr unsigned kQueueBackoffMaxMs = 300000;

// First-run reminder: the automation sends with WeChat's 发送消息 shortcut,
// so WeChat has to be configured to send with Ctrl+Enter. The marker file
// keeps the reminder to one acknowledged showing per installation.
constexpr wchar_t kShortcutTipFile[] = L"shortcut-tip.txt";
constexpr wchar_t kShortcutTipTitle[] = L"SuperLanguage · 首次使用提示";
constexpr wchar_t kShortcutTipText[] =
    L"请先把微信的发送快捷键设为 Ctrl+Enter。\n\n"
    L"SuperLanguage 通过模拟 Ctrl+Enter 发送消息，设置方法：\n"
    L"微信 → 设置 → 快捷按键（部分版本叫“快捷键”）→ 发送消息 → 选择 Ctrl+Enter\n\n"
    L"SuperLanguage 固定注入 Ctrl+Enter，不会点击发送按钮，也不会自动清空已有草稿。\n"
    L"如果微信仍设置为 Enter 发送，任务只会标记为“已注入未验证”，\n"
    L"请在微信中人工确认是否实际发出。\n\n"
    L"已经设置好了吗？\n"
    L"    是：不再提示　　否：下次启动继续提醒";

constexpr DWORD kWindowStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU
    | WS_MINIMIZEBOX | WS_CLIPCHILDREN;
constexpr int kClientWidth = 600;
constexpr int kClientHeight = 740;

constexpr int kHelpClientWidth = 700;
constexpr int kHelpClientHeight = 816;
constexpr int kHelpExampleCount = 7;
constexpr int kHelpMaxLines = 3;
constexpr size_t kHelpLineChars = 200;
constexpr int kHelpStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU
    | WS_MINIMIZEBOX;

// Run-log / send-queue details live in their own standalone windows.
constexpr wchar_t kLogClass[] = L"SuperLanguage.LogWindow";
constexpr wchar_t kQueueClass[] = L"SuperLanguage.QueueWindow";
constexpr wchar_t kLogTitle[] = L"SuperLanguage · 运行日志";
constexpr wchar_t kQueueTitle[] = L"SuperLanguage · 发送队列";
constexpr int kLogClientWidth = 780;
constexpr int kLogClientHeight = 460;
constexpr int kQueueClientWidth = 880;
constexpr int kQueueClientHeight = 460;
constexpr int kDetailRowHeight = 15;
constexpr int kQueueRowHeight = 16;
constexpr int kDetailQueueCapacity = 64;
constexpr int kDetailStyle = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU
    | WS_MINIMIZEBOX | WS_VSCROLL;

constexpr UINT kTrayMessage = WM_APP + 1;
constexpr UINT kActivateMessage = WM_APP + 2;
constexpr UINT kExitMessage = WM_APP + 3;
constexpr int kStopHotkeyId = 1;
constexpr UINT kStopHotkeyModifiers = MOD_CONTROL | MOD_ALT;
constexpr UINT kStopHotkeyKey = 'Q';
constexpr UINT kJobMessage = WM_APP + 4;
constexpr UINT_PTR kSampleTimer = 1;
constexpr UINT_PTR kWeChatPollTimer = 2;
constexpr UINT_PTR kQueueRefreshTimer = 3;
constexpr UINT_PTR kJobPumpTimer = 4;
constexpr int kSearchEditId = 1001;
constexpr int kContentEditId = 1002;
constexpr int kAttachmentEditId = 1003;
constexpr int kMentionEditId = 1004;
constexpr UINT kEmSetMargins = 0x00D3;
constexpr WPARAM kEcLeftMargin = 0x0001;
constexpr WPARAM kEcRightMargin = 0x0002;
constexpr UINT kEmSetCueBanner = 0x1501;

constexpr int kMenuShow = 40001;
constexpr int kMenuCheck = 40002;
constexpr int kMenuExit = 40003;

constexpr size_t kLogCapacity = 256;
constexpr size_t kLogWidth = 240;

constexpr COLORREF kBgTop = RGB(14, 19, 25);
constexpr COLORREF kBgBottom = RGB(8, 11, 15);
constexpr COLORREF kCard = RGB(17, 22, 29);
constexpr COLORREF kCardAlt = RGB(13, 18, 24);
constexpr COLORREF kLogBg = RGB(9, 13, 18);
constexpr COLORREF kBorder = RGB(34, 44, 56);
constexpr COLORREF kBorderSoft = RGB(25, 33, 43);
constexpr COLORREF kText = RGB(233, 240, 246);
constexpr COLORREF kTextSoft = RGB(197, 208, 220);
constexpr COLORREF kMuted = RGB(140, 153, 168);
constexpr COLORREF kFaint = RGB(92, 104, 118);
constexpr COLORREF kAccent = RGB(110, 231, 183);
constexpr COLORREF kAccentHover = RGB(142, 244, 204);
constexpr COLORREF kAccentPressed = RGB(84, 201, 159);
constexpr COLORREF kAmber = RGB(245, 185, 95);
constexpr COLORREF kRed = RGB(248, 113, 113);
constexpr COLORREF kInk = RGB(7, 20, 15);
constexpr COLORREF kButton = RGB(20, 27, 35);
constexpr COLORREF kButtonHover = RGB(28, 37, 47);
constexpr COLORREF kButtonPressed = RGB(24, 31, 40);

enum class Hot {
    None,
    Primary,
    Secondary,
    Search,
    Send,
    SendAttachment,
    MentionNewline,
    ApiToggle,
    ApiCopy,
    ApiRefresh,
    TabLog,
    TabQueue,
    Help,
    Exit,
};

enum class WeChatUiState {
    Unknown,
    Checking,
    LoginRequired,
    LoggedIn,
    NotInstalled,
    Unconfirmed,
    Error,
};

struct FontSet {
    HFONT title{};
    HFONT status{};
    HFONT subtitle{};
    HFONT body{};
    HFONT bodyBold{};
    HFONT smallText{};
    HFONT metric{};
    HFONT unit{};
    HFONT log{};
    HFONT code{};
    HFONT hint{};
};

struct Brushes {
    HBRUSH background{};
    HBRUSH card{};
    HBRUSH cardAlt{};
    HBRUSH log{};
    HBRUSH border{};
    HBRUSH borderSoft{};
    HBRUSH accent{};
    HBRUSH accentHover{};
    HBRUSH accentPressed{};
    HBRUSH muted{};
    HBRUSH amber{};
    HBRUSH red{};
    HBRUSH ink{};
    HBRUSH button{};
    HBRUSH buttonHover{};
    HBRUSH buttonPressed{};
};

struct App {
    HINSTANCE instance{};
    HWND hwnd{};
    HWND searchEdit{};
    HWND contentEdit{};
    HWND attachmentEdit{};
    HWND mentionEdit{};
    bool mentionNewline{};
    UINT dpi{96};
    bool trayAdded{};
    bool hidden{};
    bool exitRequested{};
    bool trackingMouse{};
    bool balloonShown{};
    Hot hot{Hot::None};
    Hot pressed{Hot::None};

    HICON iconWindow{};
    HICON iconSmall{};
    HICON iconHeader{};

    FontSet fonts{};
    Brushes brushes{};

    PROCESS_MEMORY_COUNTERS_EX2 memory{};
    SIZE_T privateWorkingSet{};
    DWORD handleCount{};
    ULONGLONG startTick{};
    UINT taskbarCreatedMessage{};

    WeChatUiState wechatState{WeChatUiState::Unknown};
    bool wechatPolling{};
    ULONGLONG wechatPollDeadline{};
    wchar_t pendingSearch[128]{};
    wchar_t pendingMessage[512]{};
    wchar_t pendingMention[128]{};
    bool pendingMentionNewline{};
    wchar_t pendingAttachments[1024]{};

    int statsMessages{};
    int statsAttachments{};
    int statsFiles{};
    int statsUnverified{};

    bool apiRunning{};
    unsigned short apiPort{};
    char apiToken[33]{};
    // apiHost is the IPv4 advertised in URLs (never "0.0.0.0"), apiListen is
    // the actual bind address.
    wchar_t apiHost[64]{L"127.0.0.1"};
    wchar_t apiListen[64]{L"127.0.0.1"};
    bool jobActive{};
    char jobApiId[17]{};
    feather::queue::JobType jobType{feather::queue::JobType::Message};
    bool jobHadSend{};
    int jobSentCount{};
    DWORD jobError{};
    wchar_t lastClaimedTarget[128]{};
    bool jobTargetRepeatsLastClaimed{};
    wchar_t lastConversationTarget[128]{};
    HWND lastConversationWindow{};
    DWORD lastConversationProcessId{};
    bool queueConsumptionBlocked{};
    // 微信不可用时暂停领取任务：到期时间与当前退避步长，登录成功或用户手动检查时清零。
    ULONGLONG queueBackoffUntil{};
    unsigned queueBackoffMs{};
    // MessageBox、菜单、窗口拖动等嵌套消息循环期间不领取任务、不推进登录轮询。
    int modalDepth{};
    DWORD lastClaimError{};
    ULONGLONG lastClaimErrorAt{};
    bool inputGuardHeld{};
    unsigned sendTimeoutMs{45000};

    feather::queue::Job queueRows[feather::queue::kViewCapacity]{};
    int queueRowCount{};
    feather::queue::Stats queueStats{};

    HWND helpWindow{};
    wchar_t helpTitles[kHelpExampleCount][56]{};
    // helpBodies 是界面显示（令牌已遮挡），helpCopies 是“复制”得到的完整内容。
    std::wstring helpBodies[kHelpExampleCount];
    std::wstring helpCopies[kHelpExampleCount];
    int helpCopiedIndex{-1};
    int helpHotIndex{-1};
    bool helpTrackingMouse{};
    wchar_t helpStatus[96]{};

    HWND logWindow{};
    int logTopLine{};
    bool logFollow{true};
    int logHotIndex{-1};
    bool logTrackingMouse{};

    HWND queueWindow{};
    int queueTopRow{};
    int queueHotIndex{-1};
    bool queueTrackingMouse{};
    feather::queue::Job detailQueueRows[kDetailQueueCapacity]{};
    int detailQueueRowCount{};

    wchar_t logLines[kLogCapacity][kLogWidth]{};
    int logCount{};
};

App g;

void complete_active_job(bool succeeded, int sent_count, DWORD error);
void start_next_job();
bool enqueue_ui_job(feather::queue::JobType type, const wchar_t* target,
                    const wchar_t* message, const wchar_t* mention,
                    const wchar_t* attachments, bool mention_newline);
void apply_api_layout();
void center_window();
void raise_main_window();
void refresh_queue_view();
void build_help_examples();
void open_help_window();
void refresh_help_window();
void open_log_window();
void open_queue_window();
void copy_api_token_to_clipboard();

void enter_modal_loop() {
    ++g.modalDepth;
}

void leave_modal_loop() {
    if (g.modalDepth > 0) {
        --g.modalDepth;
    }
    if (g.modalDepth == 0 && g.hwnd) {
        PostMessageW(g.hwnd, kJobMessage, 0, 0);
    }
}

struct ModalScope {
    ModalScope() { enter_modal_loop(); }
    ~ModalScope() { leave_modal_loop(); }
    ModalScope(const ModalScope&) = delete;
    ModalScope& operator=(const ModalScope&) = delete;
};

// Every window of this thread shares the job pump, so a nested modal loop in
// any of them (caption drag, scroll-bar tracking, system menu) must pause it.
bool handle_modal_loop_message(HWND hwnd, UINT message, WPARAM wParam,
                               LPARAM lParam, LRESULT* result) {
    switch (message) {
    case WM_ENTERSIZEMOVE:
    case WM_ENTERMENULOOP:
        enter_modal_loop();
        return false;
    case WM_EXITSIZEMOVE:
    case WM_EXITMENULOOP:
        leave_modal_loop();
        return false;
    case WM_NCLBUTTONDOWN: {
        ModalScope scope;
        *result = DefWindowProcW(hwnd, message, wParam, lParam);
        return true;
    }
    default:
        return false;
    }
}

struct Layout {
    RECT icon;
    RECT title;
    RECT subtitle;
    RECT help;
    RECT divider;
    RECT status;
    RECT composer;
    RECT composerTitle;
    RECT composerHint;
    RECT searchLabel;
    RECT searchField;
    RECT searchButton;
    RECT messageLabel;
    RECT messageField;
    RECT messageButton;
    RECT attachmentLabel;
    RECT attachmentField;
    RECT attachmentButton;
    RECT mentionLabel;
    RECT mentionField;
    RECT mentionNewlineCheck;
    RECT stats;
    RECT api;
    RECT apiToggle;
    RECT apiCopy;
    RECT apiRefreshButton;
    RECT activity;
    RECT tabLog;
    RECT tabQueue;
    RECT primary;
    RECT secondary;
    RECT exit;
    RECT hintLeft;
    RECT hintRight;
};

int scale(int value) {
    return MulDiv(value, static_cast<int>(g.dpi), 96);
}

void fill(HDC dc, const RECT& rect, HBRUSH brush) {
    FillRect(dc, &rect, brush);
}

void outline(HDC dc, const RECT& rect, HBRUSH brush) {
    FrameRect(dc, &rect, brush);
}

void draw_text(HDC dc, HFONT font, COLORREF color, const wchar_t* value,
               RECT rect, UINT flags) {
    HGDIOBJ previousFont = SelectObject(dc, font ? font : GetStockObject(DEFAULT_GUI_FONT));
    const int previousMode = SetBkMode(dc, TRANSPARENT);
    const COLORREF previousColor = SetTextColor(dc, color);
    DrawTextW(dc, value, -1, &rect, flags);
    SetTextColor(dc, previousColor);
    SetBkMode(dc, previousMode);
    SelectObject(dc, previousFont);
}

Layout make_layout(int width, int height) {
    Layout layout{};
    const int pad = scale(28);
    const int icon_size = scale(38);

    layout.icon = {pad, scale(18), pad + icon_size, scale(18) + icon_size};
    layout.help = {width - pad - scale(64), scale(21), width - pad, scale(53)};
    layout.title = {layout.icon.right + scale(12), scale(8),
                    layout.help.left - scale(18), scale(41)};
    layout.subtitle = {layout.icon.right + scale(12), scale(40),
                       layout.help.left - scale(18), scale(60)};
    layout.divider = {pad, scale(74), width - pad, scale(75)};

    layout.status = {pad, scale(88), width - pad, scale(156)};
    layout.composer = {pad, scale(166), width - pad, scale(388)};
    layout.composerTitle = {
        layout.composer.left + scale(18), layout.composer.top + scale(12),
        layout.composer.left + scale(160), layout.composer.top + scale(32)};
    layout.composerHint = {
        layout.composer.right - scale(290), layout.composer.top + scale(12),
        layout.composer.right - scale(18), layout.composer.top + scale(32)};

    const int row_left = layout.composer.left + scale(18);
    const int row_right = layout.composer.right - scale(18);
    const int label_width = scale(62);
    const int field_left = row_left + label_width + scale(8);
    const int row_height = scale(34);
    const int button_width = scale(72);
    const int input_top = layout.composer.top + scale(44);
    const int row_gap = scale(42);

    layout.searchLabel = {row_left, input_top, row_left + label_width,
                          input_top + row_height};
    layout.searchButton = {row_right - button_width, input_top, row_right,
                           input_top + row_height};
    layout.searchField = {field_left, input_top,
                          layout.searchButton.left - scale(8),
                          input_top + row_height};

    const int message_top = input_top + row_gap;
    layout.messageLabel = {row_left, message_top, row_left + label_width,
                           message_top + row_height};
    layout.messageButton = {row_right - button_width, message_top, row_right,
                            message_top + row_height};
    layout.messageField = {field_left, message_top,
                           layout.messageButton.left - scale(8),
                           message_top + row_height};

    const int attachment_top = input_top + row_gap * 2;
    layout.attachmentLabel = {row_left, attachment_top,
                              row_left + label_width,
                              attachment_top + row_height};
    layout.attachmentButton = {row_right - button_width, attachment_top,
                               row_right, attachment_top + row_height};
    layout.attachmentField = {field_left, attachment_top,
                              layout.attachmentButton.left - scale(8),
                              attachment_top + row_height};

    const int mention_top = input_top + row_gap * 3;
    layout.mentionLabel = {row_left, mention_top, row_left + label_width,
                           mention_top + row_height};
    const int mention_check_width = scale(146);
    layout.mentionField = {field_left, mention_top,
                           row_right - mention_check_width - scale(8),
                           mention_top + row_height};
    layout.mentionNewlineCheck = {row_right - mention_check_width, mention_top,
                                  row_right, mention_top + row_height};

    layout.stats = {pad, scale(400), width - pad, scale(478)};
    layout.api = {pad, scale(490), width - pad, scale(562)};
    layout.apiToggle = {layout.api.right - scale(60), layout.api.top + scale(9),
                        layout.api.right - scale(18),
                        layout.api.top + scale(31)};
    layout.apiRefreshButton = {
        layout.api.right - scale(18) - scale(52), layout.api.top + scale(40),
        layout.api.right - scale(18), layout.api.top + scale(64)};
    layout.apiCopy = {
        layout.apiRefreshButton.left - scale(8) - scale(58),
        layout.apiRefreshButton.top, layout.apiRefreshButton.left - scale(8),
        layout.apiRefreshButton.bottom};

    layout.activity = {pad, scale(574), width - pad, scale(644)};
    const int tab_height = scale(28);
    const int tab_top = layout.activity.top + scale(10);
    layout.tabQueue = {layout.activity.right - scale(18) - scale(76), tab_top,
                       layout.activity.right - scale(18), tab_top + tab_height};
    layout.tabLog = {layout.tabQueue.left - scale(8) - scale(76), tab_top,
                     layout.tabQueue.left - scale(8), tab_top + tab_height};

    const int hint_bottom = height - scale(14);
    layout.hintLeft = {pad, hint_bottom - scale(18),
                       width - pad - scale(210), hint_bottom};
    layout.hintRight = {width - pad - scale(200), hint_bottom - scale(18),
                        width - pad, hint_bottom};

    const int button_height = scale(40);
    const int button_top = layout.hintLeft.top - scale(12) - button_height;
    layout.primary = {pad, button_top, pad + scale(174),
                      button_top + button_height};
    layout.secondary = {layout.primary.right + scale(10), button_top,
                        layout.primary.right + scale(10) + scale(128),
                        button_top + button_height};
    layout.exit = {width - pad - scale(52), button_top, width - pad,
                   button_top + button_height};
    return layout;
}

void format_megabytes(wchar_t* buffer, size_t capacity, double megabytes) {
    if (megabytes < 10.0) {
        swprintf_s(buffer, capacity, L"%.2f", megabytes);
    } else if (megabytes < 100.0) {
        swprintf_s(buffer, capacity, L"%.1f", megabytes);
    } else {
        swprintf_s(buffer, capacity, L"%.0f", megabytes);
    }
}

bool api_file_path(const wchar_t* file_name, wchar_t* path, size_t capacity) {
    wchar_t directory[MAX_PATH]{};
    const DWORD length = GetModuleFileNameW(nullptr, directory,
                                            ARRAYSIZE(directory));
    if (length == 0 || length >= ARRAYSIZE(directory)) {
        return false;
    }
    wchar_t* slash = wcsrchr(directory, L'\\');
    if (!slash) {
        return false;
    }
    *slash = L'\0';
    return _snwprintf_s(path, capacity, _TRUNCATE, L"%s\\%s", directory,
                        file_name) > 0;
}

// Keeps one previous generation (flow-debug.log.1) once the live file passes
// kLogRotateBytes.
void rotate_debug_log(const wchar_t* path) {
    WIN32_FILE_ATTRIBUTE_DATA attributes{};
    if (!GetFileAttributesExW(path, GetFileExInfoStandard, &attributes)) {
        return;
    }
    const ULONGLONG size =
        (static_cast<ULONGLONG>(attributes.nFileSizeHigh) << 32)
        | attributes.nFileSizeLow;
    if (size < kLogRotateBytes) {
        return;
    }
    wchar_t previous[MAX_PATH + 4]{};
    if (_snwprintf_s(previous, ARRAYSIZE(previous), _TRUNCATE, L"%s.1",
                     path) > 0) {
        MoveFileExW(path, previous, MOVEFILE_REPLACE_EXISTING);
    }
}

void add_log(const wchar_t* format, ...) {
    wchar_t message[200]{};
    va_list arguments;
    va_start(arguments, format);
    _vsnwprintf_s(message, ARRAYSIZE(message), _TRUNCATE, format, arguments);
    va_end(arguments);

    SYSTEMTIME now{};
    GetLocalTime(&now);
    wchar_t line[kLogWidth]{};
    swprintf_s(line, ARRAYSIZE(line), L"%02u:%02u:%02u  %s",
               now.wHour, now.wMinute, now.wSecond, message);

    // The in-memory log is lost on exit; mirror every line to flow-debug.log
    // next to the executable.
    {
        wchar_t path[MAX_PATH]{};
        if (api_file_path(L"flow-debug.log", path, ARRAYSIZE(path))) {
            rotate_debug_log(path);
            FILE* file = nullptr;
            if (_wfopen_s(&file, path, L"a, ccs=UTF-8") == 0 && file) {
                std::fwprintf(file, L"%04u-%02u-%02u %s\n", now.wYear,
                              now.wMonth, now.wDay, line);
                std::fclose(file);
            }
        }
    }

    if (g.logCount < static_cast<int>(kLogCapacity)) {
        wcsncpy_s(g.logLines[g.logCount], kLogWidth, line, _TRUNCATE);
        ++g.logCount;
    } else {
        for (size_t index = 1; index < kLogCapacity; ++index) {
            wcsncpy_s(g.logLines[index - 1], kLogWidth, g.logLines[index], _TRUNCATE);
        }
        wcsncpy_s(g.logLines[kLogCapacity - 1], kLogWidth, line, _TRUNCATE);
    }

    if (g.hwnd) {
        InvalidateRect(g.hwnd, nullptr, FALSE);
    }
    if (g.logWindow && IsWindow(g.logWindow)) {
        InvalidateRect(g.logWindow, nullptr, FALSE);
    }
}

void sample_metrics() {
    g.memory.cb = sizeof(g.memory);
    if (K32GetProcessMemoryInfo(GetCurrentProcess(),
                                reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&g.memory),
                                sizeof(g.memory))) {
        g.privateWorkingSet = g.memory.PrivateWorkingSetSize;
    } else {
        PROCESS_MEMORY_COUNTERS_EX fallback{};
        fallback.cb = sizeof(fallback);
        if (K32GetProcessMemoryInfo(GetCurrentProcess(),
                                    reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&fallback),
                                    sizeof(fallback))) {
            g.memory.WorkingSetSize = fallback.WorkingSetSize;
            g.memory.PrivateUsage = fallback.PrivateUsage;
            g.privateWorkingSet = fallback.PrivateUsage;
        }
    }
    GetProcessHandleCount(GetCurrentProcess(), &g.handleCount);
}

const wchar_t* wechat_state_label(WeChatUiState state) {
    switch (state) {
    case WeChatUiState::Checking:
        return L"正在检查微信";
    case WeChatUiState::LoginRequired:
        return L"等待登录微信";
    case WeChatUiState::LoggedIn:
        return L"微信已登录";
    case WeChatUiState::NotInstalled:
        return L"未找到微信客户端";
    case WeChatUiState::Unconfirmed:
        return L"登录状态未确认";
    case WeChatUiState::Error:
        return L"微信连接失败";
    case WeChatUiState::Unknown:
    default:
        return L"尚未检查微信";
    }
}

const wchar_t* wechat_state_description(WeChatUiState state) {
    switch (state) {
    case WeChatUiState::Checking:
        return L"正在确认客户端运行与登录状态，请稍候";
    case WeChatUiState::LoginRequired:
        return L"请在微信窗口扫码或点击“进入微信”，登录后自动继续（最多等 5 分钟）";
    case WeChatUiState::LoggedIn:
        return L"连接正常，可以手动发送，也可以调用本地接口";
    case WeChatUiState::NotInstalled:
        return L"请先安装微信 PC 客户端，再重新检查";
    case WeChatUiState::Unconfirmed:
        return L"客户端状态不明确，建议重新检查后再发送";
    case WeChatUiState::Error:
        return L"检查未通过，请确认微信已安装并正常运行";
    case WeChatUiState::Unknown:
    default:
        return L"点击下方“检查微信状态”开始连接";
    }
}

COLORREF wechat_state_color(WeChatUiState state) {
    switch (state) {
    case WeChatUiState::LoggedIn:
    case WeChatUiState::Checking:
        return kAccent;
    case WeChatUiState::LoginRequired:
    case WeChatUiState::Unconfirmed:
        return kAmber;
    case WeChatUiState::NotInstalled:
    case WeChatUiState::Error:
        return kRed;
    case WeChatUiState::Unknown:
    default:
        return kMuted;
    }
}

HBRUSH wechat_state_brush(WeChatUiState state) {
    switch (state) {
    case WeChatUiState::LoggedIn:
    case WeChatUiState::Checking:
        return g.brushes.accent;
    case WeChatUiState::LoginRequired:
    case WeChatUiState::Unconfirmed:
        return g.brushes.amber;
    case WeChatUiState::NotInstalled:
    case WeChatUiState::Error:
        return g.brushes.red;
    case WeChatUiState::Unknown:
    default:
        return g.brushes.muted;
    }
}

void set_wechat_state(WeChatUiState state) {
    if (g.wechatState == state) {
        return;
    }
    g.wechatState = state;
    if (g.hwnd) {
        InvalidateRect(g.hwnd, nullptr, FALSE);
    }
}

void stop_wechat_poll() {
    if (g.hwnd) {
        KillTimer(g.hwnd, kWeChatPollTimer);
    }
    g.wechatPolling = false;
}

ULONGLONG queue_backoff_remaining_ms() {
    const ULONGLONG now = GetTickCount64();
    return now < g.queueBackoffUntil ? g.queueBackoffUntil - now : 0;
}

void clear_queue_backoff(const wchar_t* reason) {
    const bool waiting = queue_backoff_remaining_ms() > 0;
    g.queueBackoffUntil = 0;
    g.queueBackoffMs = 0;
    if (waiting) {
        add_log(L"队列恢复领取 · %s", reason);
    }
    if (g.hwnd) {
        InvalidateRect(g.hwnd, nullptr, FALSE);
    }
}

void pause_queue_for_wechat() {
    if (g.queueBackoffMs == 0) {
        g.queueBackoffMs = kQueueBackoffInitialMs;
    } else if (g.queueBackoffMs < kQueueBackoffMaxMs) {
        g.queueBackoffMs = g.queueBackoffMs * 2 < kQueueBackoffMaxMs
            ? g.queueBackoffMs * 2
            : kQueueBackoffMaxMs;
    }
    g.queueBackoffUntil = GetTickCount64() + g.queueBackoffMs;
    add_log(L"队列等待微信 · %u 秒后自动重试 · 点击“检查微信状态”可立即重试",
            g.queueBackoffMs / 1000);
    if (g.hwnd) {
        InvalidateRect(g.hwnd, nullptr, FALSE);
    }
}

// Only valid before the send intent is persisted: queue::requeue refuses jobs
// whose delivery_attempted flag is already set.
bool requeue_active_job() {
    if (!g.jobActive) {
        return false;
    }
    DWORD error = ERROR_SUCCESS;
    if (!feather::queue::requeue(g.jobApiId, &error)) {
        add_log(L"任务放回队列失败 · 错误码 %lu", error);
        return false;
    }
    g.jobActive = false;
    g.jobApiId[0] = '\0';
    refresh_queue_view();
    return true;
}

void finish_wechat_check(WeChatUiState state) {
    stop_wechat_poll();
    if (state == WeChatUiState::LoggedIn) {
        clear_queue_backoff(L"微信已登录");
    } else {
        g.lastConversationTarget[0] = L'\0';
        g.lastConversationWindow = nullptr;
        g.lastConversationProcessId = 0;
        g.pendingSearch[0] = L'\0';
        g.pendingMessage[0] = L'\0';
        g.pendingMention[0] = L'\0';
        g.pendingAttachments[0] = L'\0';
        if (g.jobActive) {
            if (requeue_active_job()) {
                add_log(L"微信未就绪 · 当前任务未执行 · 已放回队列");
            } else {
                add_log(L"微信未就绪 · 当前任务未执行 · 判为失败");
                complete_active_job(false, 0, ERROR_NOT_READY);
            }
        }
        refresh_queue_view();
        if (g.queueStats.queued > 0) {
            pause_queue_for_wechat();
        }
    }
    if (g.hwnd) {
        PostMessageW(g.hwnd, kJobMessage, 0, 0);
    }
    set_wechat_state(state);
    // 检查成功会把微信窗口前置（不改变大小）；没有后续自动化时把焦点还给 SuperLanguage 自己。
    // 待扫码/超时等状态保持微信可见，不抢回前台。
    if (state == WeChatUiState::LoggedIn && !g.pendingSearch[0]
        && !g.pendingMessage[0] && !g.pendingAttachments[0]
        && !g.jobActive) {
        raise_main_window();
    }
}

// 任务结束后通过 ShowWindow 隐藏微信；隐藏失败只记日志。
void hide_wechat_after_task(HWND main_window) {
    if (!main_window || !IsWindowVisible(main_window)) {
        return;
    }
    DWORD hide_error = ERROR_SUCCESS;
    if (feather::automation::hide_wechat_window(main_window, &hide_error)) {
        add_log(L"微信窗口已隐藏 · %s",
                feather::automation::last_visibility_method());
    } else {
        add_log(L"隐藏微信窗口失败 · 错误码 %lu", hide_error);
    }
}

void restore_desktop_after_job(HWND main_window) {
    // A search-only job is a navigation request: leave the matched
    // conversation visible so the user can inspect the result. Message and
    // attachment jobs keep the original behavior of hiding WeChat afterwards.
    if (g.jobActive && g.jobType == feather::queue::JobType::Search) {
        add_log(L"仅搜索任务结束 · 保持微信窗口可见");
        return;
    }
    hide_wechat_after_task(main_window);
}

// 搜索/发送阶段锁鼠标（键盘可用）；超时或退出时由 automation 的鼠标保护
// 线程自动解锁。begin_automation_guard 要求鼠标锁已生效，锁定失败时任务无法执行。
bool begin_task_input_guard() {
    if (g.inputGuardHeld) {
        return true;
    }
    if (!feather::automation::begin_input_guard(g.sendTimeoutMs)) {
        return false;
    }
    g.inputGuardHeld = true;
    add_log(L"已锁定鼠标 · 键盘可用 · 超时 %u 秒自动释放",
            g.sendTimeoutMs / 1000);
    return true;
}

void end_task_input_guard() {
    const bool held = g.inputGuardHeld;
    feather::automation::end_automation_guard();
    feather::automation::end_input_guard();
    g.inputGuardHeld = false;
    if (!held) {
        return;
    }
    if (feather::automation::automation_aborted()) {
        add_log(L"发送超时或停止请求 · 已自动释放鼠标");
    } else {
        add_log(L"已释放鼠标");
    }
}

void forget_active_conversation() {
    g.lastConversationTarget[0] = L'\0';
    g.lastConversationWindow = nullptr;
    g.lastConversationProcessId = 0;
}

void remember_active_conversation(HWND main_window, const wchar_t* target) {
    if (!main_window || !IsWindow(main_window) || !target || !target[0]) {
        forget_active_conversation();
        return;
    }
    wcsncpy_s(g.lastConversationTarget, target, _TRUNCATE);
    g.lastConversationWindow = main_window;
    g.lastConversationProcessId = 0;
    GetWindowThreadProcessId(main_window, &g.lastConversationProcessId);
}

// 只有右侧停靠的“搜一搜”面板（主窗口内的 Chromium 子窗口）命中关闭点时才点击；
// 面板不存在时不产生任何点击。
void click_search_close_point(HWND main_window) {
    const feather::automation::WeChatSearchPanelAction panel =
        feather::automation::dismiss_wechat_search_panel(main_window);
    if (panel.clicked) {
        add_log(L"已点击关闭搜索面板位置 · %d,%d · 窗口相对坐标",
                panel.point.x, panel.point.y);
        if (!panel.closed) {
            add_log(L"搜索面板点击后仍未关闭 · 错误码 %lu",
                    panel.error ? panel.error : ERROR_NOT_READY);
        }
    } else if (panel.found) {
        add_log(L"搜索面板关闭点击失败 · 错误码 %lu",
                panel.error ? panel.error : ERROR_NOT_READY);
    }
}

bool try_reuse_active_conversation(HWND main_window, const wchar_t* target) {
    // @ mentions need real keyboard focus in the message editor. Reusing the
    // last conversation skips Ctrl+F + Enter, and WeChat does not restore
    // editor focus when the window is re-shown, so the mention picker never
    // opens. Always re-enter through search when a mention is requested.
    if (g.pendingMention[0]) {
        add_log(L"含 @ 对象 · 跳过会话复用 · 执行 Ctrl+F 搜索以恢复输入框焦点");
        return false;
    }
    DWORD process_id = 0;
    if (main_window) {
        GetWindowThreadProcessId(main_window, &process_id);
    }
    if (!g.jobTargetRepeatsLastClaimed) {
        return false;
    }
    if (!target || !target[0] || !g.lastConversationTarget[0]
        || g.lastConversationWindow != main_window
        || !process_id
        || process_id != g.lastConversationProcessId
        || wcscmp(g.lastConversationTarget, target) != 0) {
        add_log(L"目标会话与上次领取一致 · 上次会话状态不可复用 · 执行 Ctrl+F 搜索");
        return false;
    }

    DWORD guard_error = ERROR_SUCCESS;
    if (!feather::automation::begin_automation_guard(
            main_window, g.sendTimeoutMs, &guard_error)) {
        add_log(L"目标会话复用前置失败 · 回退 Ctrl+F 搜索 · 错误码 %lu",
                guard_error);
        return false;
    }

    DWORD reuse_error = ERROR_NOT_READY;
    const ULONGLONG deadline = GetTickCount64() + 500;
    for (;;) {
        if (feather::automation::accept_reused_conversation(
                main_window, target, &reuse_error)) {
            add_log(L"目标会话与上次领取一致 · 同一目标复用（未读取标题）· 跳过 Ctrl+F 搜索 · %s",
                    target);
            click_search_close_point(main_window);
            return true;
        }
        if (reuse_error == ERROR_NOT_SUPPORTED
            || feather::automation::automation_aborted()
            || GetTickCount64() >= deadline) {
            break;
        }
        Sleep(50);
    }

    feather::automation::end_automation_guard();
    add_log(L"目标会话复用未确认 · 回退 Ctrl+F 搜索 · 错误码 %lu",
            reuse_error ? reuse_error : ERROR_NOT_READY);
    return false;
}

void send_pending_content(HWND main_window) {
    bool delivery_allowed = true;
    if (g.jobActive && g.jobType != feather::queue::JobType::Search) {
        DWORD mark_error = ERROR_SUCCESS;
        if (!feather::queue::mark_delivery_attempted(g.jobApiId,
                                                     &mark_error)) {
            delivery_allowed = false;
            g.jobError = mark_error ? mark_error : ERROR_WRITE_FAULT;
            add_log(L"发送意图写入失败 · 已禁止发送并停止当前任务 · 错误码 %lu",
                    g.jobError);
        } else {
            add_log(L"已持久化发送意图 · 崩溃后不会再自动重发");
        }
    }

    if (delivery_allowed && g.pendingMessage[0]) {
        wchar_t message[512]{};
        wcsncpy_s(message, g.pendingMessage, _TRUNCATE);
        g.pendingMessage[0] = L'\0';
        wchar_t mention[128]{};
        if (g.pendingMention[0]) {
            wcsncpy_s(mention, g.pendingMention, _TRUNCATE);
            g.pendingMention[0] = L'\0';
        }
        add_log(L"正在发送对话内容 · %u 字",
                static_cast<unsigned>(wcslen(message)));
        if (mention[0]) {
            add_log(L"含 @ 对象 · 正在选择成员 · @后%s",
                    g.pendingMentionNewline ? L"换行" : L"空格");
        }
        DWORD send_error = ERROR_SUCCESS;
        feather::automation::AutomationResult send_result{};
        const bool message_returned =
            feather::automation::send_wechat_message(
                main_window, message, mention[0] ? mention : nullptr,
                g.pendingMentionNewline, &send_result, &send_error);
        const bool message_sent =
            message_returned
            && send_result.outcome ==
                   feather::automation::AutomationOutcome::InjectedUnverified;
        if (message_sent) {
            if (g.jobActive) {
                g.jobHadSend = true;
                g.jobError = ERROR_SUCCESS;
            }
            ++g.statsMessages;
            ++g.statsUnverified;
            add_log(L"对话内容已注入（未做内容校验）· %s",
                    feather::automation::last_send_method());
        } else {
            if (g.jobActive) {
                g.jobHadSend = false;
                g.jobError = send_result.error
                    ? send_result.error
                    : send_error;
            }
            add_log(L"发送对话内容失败 · 错误码 %lu",
                    send_result.error ? send_result.error : send_error);
        }
    }
    if (delivery_allowed && g.pendingAttachments[0]) {
        wchar_t attachments[1024]{};
        wcsncpy_s(attachments, g.pendingAttachments, _TRUNCATE);
        g.pendingAttachments[0] = L'\0';
        add_log(L"正在发送附件");
        int sent_count = 0;
        DWORD attach_error = ERROR_SUCCESS;
        feather::automation::AutomationResult attach_result{};
        const bool attachment_returned =
            feather::automation::send_wechat_attachments(
                main_window, attachments, &attach_result, &sent_count,
                &attach_error);
        const bool attachment_sent =
            attachment_returned
            && attach_result.outcome ==
                   feather::automation::AutomationOutcome::InjectedUnverified;
        if (attachment_sent) {
            if (g.jobActive) {
                g.jobHadSend = true;
                g.jobSentCount = sent_count;
                g.jobError = ERROR_SUCCESS;
            }
            ++g.statsAttachments;
            ++g.statsUnverified;
            g.statsFiles += sent_count;
            add_log(L"附件已注入（未做内容校验）· %d 个", sent_count);
        } else {
            if (g.jobActive) {
                g.jobHadSend = false;
                g.jobError = attach_result.error
                    ? attach_result.error
                    : attach_error;
            }
            add_log(L"发送附件失败 · 错误码 %lu",
                    attach_result.error ? attach_result.error : attach_error);
        }
    }
    if (!delivery_allowed) {
        g.pendingMessage[0] = L'\0';
        g.pendingMention[0] = L'\0';
        g.pendingAttachments[0] = L'\0';
        g.jobHadSend = false;
    }
    // 超时/停止请求已由鼠标保护线程置位：本条任务按失败处理，不再继续注入输入。
    if (g.jobActive && feather::automation::automation_aborted()) {
        add_log(L"发送超时/已停止 · 本条任务判为失败");
        g.jobHadSend = false;
        g.jobError = ERROR_TIMEOUT;
    }
    // 发送类任务结束后把微信收起来；仅搜索任务保留结果窗口。
    restore_desktop_after_job(main_window);
    end_task_input_guard();
    if (g.jobActive) {
        if (g.jobType == feather::queue::JobType::Search) {
            // 仅搜索会话的任务：进入目标会话即视为完成，没有内容需要发送。
            complete_active_job(true, 0, ERROR_SUCCESS);
        } else {
            complete_active_job(g.jobHadSend, g.jobSentCount, g.jobError);
        }
    }
}

void perform_pending_search(HWND main_window) {
    if (!g.pendingSearch[0]) {
        return;
    }
    wchar_t target[128]{};
    wcsncpy_s(target, g.pendingSearch, _TRUNCATE);
    g.pendingSearch[0] = L'\0';
    if (!begin_task_input_guard()) {
        // Nothing has been typed and no send intent exists yet.
        add_log(L"鼠标锁定失败 · 无法安全操作微信 · 本条任务判为失败（未发送）");
        g.pendingMessage[0] = L'\0';
        g.pendingMention[0] = L'\0';
        g.pendingAttachments[0] = L'\0';
        restore_desktop_after_job(main_window);
        end_task_input_guard();
        complete_active_job(false, 0, ERROR_LOCK_FAILED);
        return;
    }

    bool entered = try_reuse_active_conversation(main_window, target);

    // Simplified path: Ctrl+F, type the target, Enter, then use the focused
    // message editor. The conversation title is never read back.
    //
    // Two attempts: WeChat can restart between jobs (automatic update or crash
    // recovery) while this job still holds the main-window handle captured at
    // claim time. Every guarded injection then fails with
    // ERROR_INVALID_WINDOW_HANDLE. Re-resolve the handle and retry once instead
    // of failing a job that never reached the send stage.
    constexpr int kMaxAttempts = 2;
    DWORD last_error = ERROR_NOT_FOUND;
    for (int attempt = 1; attempt <= kMaxAttempts && !entered
                           && !feather::automation::automation_aborted();
         ++attempt) {
        if (!main_window || !IsWindow(main_window)) {
            const feather::automation::WeChatStatus refreshed =
                feather::automation::query_wechat();
            if (refreshed.running && refreshed.main_window_handle) {
                main_window = refreshed.main_window_handle;
                add_log(L"微信主窗口已更新 · 重新搜索 · %p", main_window);
            }
        }
        add_log(L"搜索并进入会话 · 尝试 %d/%d", attempt, kMaxAttempts);

        DWORD error = ERROR_SUCCESS;
        if (!feather::automation::search_wechat_conversation(main_window, target,
                                                             &error)) {
            last_error = error;
            add_log(L"搜索会话失败 · 错误码 %lu", error);
            feather::automation::end_automation_guard();
            continue;
        }
        add_log(L"搜索框已激活 · %s", feather::automation::last_search_method());
        Sleep(500);

        if (!feather::automation::press_enter_in_wechat(main_window, &error)) {
            last_error = error;
            add_log(L"回车进入会话失败 · 错误码 %lu", error);
            feather::automation::end_automation_guard();
            continue;
        }
        Sleep(600);
        DWORD accept_error = ERROR_SUCCESS;
        if (!feather::automation::accept_current_conversation(
                main_window, target, &accept_error)) {
            last_error = accept_error;
            add_log(L"进入会话后状态异常 · 错误码 %lu", accept_error);
            feather::automation::end_automation_guard();
            continue;
        }

        click_search_close_point(main_window);
        Sleep(300);

        remember_active_conversation(main_window, target);
        add_log(L"已进入目标会话（最简模式，未校验标题）· %s", target);
        entered = true;
        continue;
    }

    if (entered) {
        send_pending_content(main_window);
        return;
    }

    if (feather::automation::automation_aborted()) {
        add_log(L"搜索被超时/停止请求中断 · 本条任务判为失败");
    } else {
        add_log(L"未进入目标会话 · 请手动确认");
    }
    if (g.pendingMessage[0]) {
        add_log(L"消息未发送");
        g.pendingMessage[0] = L'\0';
    }
    g.pendingMention[0] = L'\0';
    if (g.pendingAttachments[0]) {
        add_log(L"附件未发送");
        g.pendingAttachments[0] = L'\0';
    }
    forget_active_conversation();
    feather::automation::end_automation_guard();
    // 仅搜索任务即使失败也保留微信窗口，方便用户检查搜索/登录状态。
    restore_desktop_after_job(main_window);
    end_task_input_guard();
    if (g.jobActive) {
        complete_active_job(false, 0,
                            feather::automation::automation_aborted()
                                ? ERROR_TIMEOUT
                                : last_error);
    }
}
void start_wechat_poll(ULONGLONG timeout_ms, UINT interval_ms) {
    if (!g.hwnd) {
        return;
    }
    stop_wechat_poll();
    g.wechatPolling = true;
    g.wechatPollDeadline = GetTickCount64() + timeout_ms;
    SetTimer(g.hwnd, kWeChatPollTimer, interval_ms, nullptr);
}

void complete_wechat_login(HWND main_window) {
    // 上一条任务结束时微信可能已被隐藏；先用 ShowWindow 重新显示，再前置。
    // 不改变窗口大小/最大化状态：所有点击点都是窗口相对坐标。
    // 显示失败不阻断：present_wechat_window 仍会 ShowWindow。
    if (main_window && !IsWindowVisible(main_window)) {
        DWORD reveal_error = ERROR_SUCCESS;
        if (feather::automation::show_wechat_window(main_window, &reveal_error)) {
            add_log(L"微信窗口已显示 · %s",
                    feather::automation::last_visibility_method());
        } else {
            add_log(L"显示微信窗口失败 · 错误码 %lu", reveal_error);
        }
    }
    const feather::automation::WeChatWindowAction action =
        feather::automation::present_wechat_window(main_window);
    if (action.foregrounded) {
        add_log(L"微信账号已登录 · 窗口已前置 · %s",
                action.maximized ? L"保持最大化状态" : L"保持当前窗口大小");
    } else {
        add_log(L"微信账号已登录 · 窗口前置失败 · 错误码 %lu", action.error);
    }
    finish_wechat_check(WeChatUiState::LoggedIn);
    perform_pending_search(main_window);
}

// 登录界面（扫码或“进入微信”）只交给用户操作：显示并前置窗口后轮询，
// 直到主窗口出现或超时。
void wait_for_wechat_login(HWND login_window) {
    if (IsIconic(login_window)) {
        ShowWindow(login_window, SW_RESTORE);
    }
    const bool raised = feather::automation::force_foreground(login_window);
    add_log(L"微信未登录 · 请扫码或点击进入微信 · 最多等待 %llu 秒",
            kLoginWaitMs / 1000);
    if (!raised) {
        add_log(L"微信登录窗口前置失败 · 请手动切换到微信");
    }
    set_wechat_state(WeChatUiState::LoginRequired);
    start_wechat_poll(kLoginWaitMs, 1000);
}

void start_wechat_check() {
    if (g.wechatPolling) {
        add_log(L"微信状态检查正在进行中");
        return;
    }

    set_wechat_state(WeChatUiState::Checking);
    add_log(L"检查微信 · 正在确认运行与登录状态");

    const feather::automation::WeChatStatus status = feather::automation::query_wechat();
    if (status.running) {
        if (status.login_state == feather::automation::WeChatLoginState::LoggedIn) {
            complete_wechat_login(status.main_window_handle);
            return;
        }
        if (status.login_window_handle) {
            wait_for_wechat_login(status.login_window_handle);
            return;
        }
        add_log(L"微信正在运行 · 正在确认登录状态");
        start_wechat_poll(8000, 800);
        return;
    }

    wchar_t executable[MAX_PATH]{};
    if (!feather::automation::find_wechat_install(executable, ARRAYSIZE(executable))) {
        add_log(L"未找到微信安装路径 · 请确认客户端已安装");
        finish_wechat_check(WeChatUiState::NotInstalled);
        return;
    }

    add_log(L"微信未运行 · 正在启动客户端");
    DWORD launch_error = ERROR_SUCCESS;
    if (!feather::automation::launch_wechat(executable, &launch_error)) {
        add_log(L"启动微信失败 · 错误码 %lu", launch_error);
        finish_wechat_check(WeChatUiState::Error);
        return;
    }

    add_log(L"微信已启动 · 正在检测登录状态");
    start_wechat_poll(20000, 700);
}

void poll_wechat() {
    // complete_wechat_login drives WeChat synchronously; never start that from
    // inside a nested modal loop.
    if (!g.wechatPolling || g.modalDepth > 0) {
        return;
    }

    const feather::automation::WeChatStatus status = feather::automation::query_wechat();
    if (status.running && status.login_state == feather::automation::WeChatLoginState::LoggedIn) {
        complete_wechat_login(status.main_window_handle);
        return;
    }

    if (g.wechatState != WeChatUiState::LoginRequired
        && status.login_window_handle) {
        wait_for_wechat_login(status.login_window_handle);
        return;
    }

    if (!status.running && g.wechatState == WeChatUiState::LoginRequired) {
        add_log(L"微信已退出 · 停止等待登录");
        finish_wechat_check(WeChatUiState::Unconfirmed);
        return;
    }

    if (GetTickCount64() >= g.wechatPollDeadline) {
        if (g.wechatState == WeChatUiState::LoginRequired) {
            add_log(L"等待登录超时（%llu 秒）· 登录微信后点击“检查微信状态”",
                    kLoginWaitMs / 1000);
        } else {
            add_log(L"微信登录状态未确认 · 请手动检查");
        }
        finish_wechat_check(WeChatUiState::Unconfirmed);
    }
}

// “检查微信状态”按钮 / F5 / 托盘菜单：用户主动重试，立即解除队列等待。
void user_check_wechat() {
    clear_queue_backoff(L"用户手动检查微信");
    start_wechat_check();
}

void trim_field(wchar_t* value) {
    wchar_t* begin = value;
    while (*begin == L' ' || *begin == L'\t') {
        ++begin;
    }
    if (begin != value) {
        MoveMemory(value, begin, (wcslen(begin) + 1) * sizeof(wchar_t));
    }
    size_t length = wcslen(value);
    while (length > 0) {
        const wchar_t last = value[length - 1];
        if (last != L' ' && last != L'\t') {
            break;
        }
        value[--length] = L'\0';
    }
}

void start_search_task() {
    if (!g.searchEdit) {
        add_log(L"会话对象输入框不可用");
        return;
    }
    wchar_t target[128]{};
    GetWindowTextW(g.searchEdit, target, ARRAYSIZE(target));
    trim_field(target);
    if (!target[0]) {
        add_log(L"请先输入会话对象");
        SetFocus(g.searchEdit);
        return;
    }
    enqueue_ui_job(feather::queue::JobType::Search, target, nullptr, nullptr,
                   nullptr, false);
}

void start_send_task() {
    if (!g.searchEdit || !g.contentEdit) {
        add_log(L"输入框不可用");
        return;
    }

    wchar_t target[128]{};
    GetWindowTextW(g.searchEdit, target, ARRAYSIZE(target));
    trim_field(target);
    if (!target[0]) {
        add_log(L"请先输入会话对象");
        SetFocus(g.searchEdit);
        return;
    }

    wchar_t message[512]{};
    GetWindowTextW(g.contentEdit, message, ARRAYSIZE(message));
    if (!message[0]) {
        add_log(L"请先输入对话内容");
        SetFocus(g.contentEdit);
        return;
    }

    wchar_t mention[128]{};
    if (g.mentionEdit) {
        GetWindowTextW(g.mentionEdit, mention, ARRAYSIZE(mention));
    }
    wchar_t* mention_begin = mention;
    while (*mention_begin == L' ' || *mention_begin == L'\t'
           || *mention_begin == L'@') {
        ++mention_begin;
    }
    if (mention_begin != mention) {
        MoveMemory(mention, mention_begin,
                   (wcslen(mention_begin) + 1) * sizeof(wchar_t));
    }
    trim_field(mention);

    enqueue_ui_job(feather::queue::JobType::Message, target, message, mention,
                   nullptr, g.mentionNewline);
}

void start_attachment_task() {
    if (!g.searchEdit || !g.attachmentEdit) {
        add_log(L"输入框不可用");
        return;
    }

    wchar_t target[128]{};
    GetWindowTextW(g.searchEdit, target, ARRAYSIZE(target));
    trim_field(target);
    if (!target[0]) {
        add_log(L"请先输入会话对象");
        SetFocus(g.searchEdit);
        return;
    }

    wchar_t attachments[1024]{};
    GetWindowTextW(g.attachmentEdit, attachments, ARRAYSIZE(attachments));
    bool has_content = false;
    for (const wchar_t* cursor = attachments; *cursor; ++cursor) {
        if (*cursor != L' ' && *cursor != L'\t' && *cursor != L';') {
            has_content = true;
            break;
        }
    }
    if (!has_content) {
        add_log(L"请先输入附件路径");
        SetFocus(g.attachmentEdit);
        return;
    }

    enqueue_ui_job(feather::queue::JobType::Attachments, target, nullptr,
                   nullptr, attachments, false);
}

const wchar_t* job_type_label(feather::queue::JobType type) {
    switch (type) {
    case feather::queue::JobType::Search: return L"搜索会话";
    case feather::queue::JobType::Attachments: return L"发送附件";
    default: return L"发送消息";
    }
}

void refresh_queue_view() {
    g.queueRowCount = feather::queue::view(g.queueRows,
                                           ARRAYSIZE(g.queueRows),
                                           &g.queueStats);
}

bool enqueue_ui_job(feather::queue::JobType type, const wchar_t* target,
                    const wchar_t* message, const wchar_t* mention,
                    const wchar_t* attachments, bool mention_newline) {
    feather::queue::Job job{};
    job.type = type;
    job.mention_newline = mention_newline;
    wcscpy_s(job.source, L"ui");
    wcsncpy_s(job.target, target, _TRUNCATE);
    if (message) {
        wcsncpy_s(job.message, message, _TRUNCATE);
    }
    if (mention) {
        wcsncpy_s(job.mention, mention, _TRUNCATE);
    }
    if (attachments) {
        wcsncpy_s(job.attachments, attachments, _TRUNCATE);
    }

    feather::queue::Job stored{};
    DWORD error = ERROR_SUCCESS;
    if (!feather::queue::enqueue(job, &stored, &error)) {
        add_log(L"任务入队失败 · 错误码 %lu", error);
        return false;
    }
    refresh_queue_view();
    add_log(L"任务已入队 #%lld · %s · %s", stored.row_id,
            job_type_label(type), target);
    if (g.hwnd) {
        PostMessageW(g.hwnd, kJobMessage, 0, 0);
        InvalidateRect(g.hwnd, nullptr, FALSE);
    }
    return true;
}

// The automation can only inject, never verify, so content_verified is
// always recorded as false.
void complete_active_job(bool succeeded, int sent_count, DWORD error) {
    if (!g.jobActive) {
        return;
    }
    if (!feather::queue::complete(g.jobApiId, succeeded, false, sent_count,
                                  error)) {
        g.queueConsumptionBlocked = true;
        feather::queue::Job current{};
        if (feather::queue::find(g.jobApiId, &current)) {
            add_log(L"任务状态写入失败 · 已停止领取后续任务，请重启程序 · 行状态 %d · 意图 %d · 结果 %d",
                    static_cast<int>(current.state),
                    current.delivery_attempted ? 1 : 0, succeeded ? 1 : 0);
        } else {
            add_log(L"任务状态写入失败 · 已停止领取后续任务，请重启程序 · 行不存在");
        }
    }
    g.jobActive = false;
    g.jobApiId[0] = '\0';
    refresh_queue_view();
    if (g.hwnd && !g.queueConsumptionBlocked) {
        PostMessageW(g.hwnd, kJobMessage, 0, 0);
    }
}

void start_next_job() {
    if (!g.hwnd || g.modalDepth > 0 || g.jobActive
        || g.queueConsumptionBlocked || g.wechatPolling
        || g.pendingSearch[0] || g.pendingMessage[0]
        || g.pendingMention[0] || g.pendingAttachments[0]
        || queue_backoff_remaining_ms() > 0) {
        return;
    }

    feather::queue::Job job{};
    DWORD claim_error = ERROR_SUCCESS;
    if (!feather::queue::claim_next(&job, &claim_error)) {
        if (claim_error == ERROR_NOT_FOUND) {
            g.lastClaimError = ERROR_SUCCESS;
            return;
        }
        const ULONGLONG now = GetTickCount64();
        if (claim_error != g.lastClaimError
            || now - g.lastClaimErrorAt >= 30000) {
            add_log(L"队列领取失败 · 错误码 %lu · 将自动重试",
                    claim_error);
            g.lastClaimError = claim_error;
            g.lastClaimErrorAt = now;
        }
        return;
    }
    g.lastClaimError = ERROR_SUCCESS;

    g.jobActive = true;
    strncpy_s(g.jobApiId, job.api_id, _TRUNCATE);
    g.jobType = job.type;
    g.jobTargetRepeatsLastClaimed =
        g.lastClaimedTarget[0] && wcscmp(g.lastClaimedTarget, job.target) == 0;
    wcsncpy_s(g.lastClaimedTarget, job.target, _TRUNCATE);
    g.jobHadSend = false;
    g.jobSentCount = 0;
    g.jobError = ERROR_SUCCESS;

    g.pendingMessage[0] = L'\0';
    g.pendingMention[0] = L'\0';
    g.pendingMentionNewline = false;
    g.pendingAttachments[0] = L'\0';
    wcsncpy_s(g.pendingSearch, job.target, _TRUNCATE);

    if (job.type == feather::queue::JobType::Message) {
        wcsncpy_s(g.pendingMessage, job.message, _TRUNCATE);
        wcsncpy_s(g.pendingMention, job.mention, _TRUNCATE);
        g.pendingMentionNewline = job.mention_newline;
    } else if (job.type == feather::queue::JobType::Attachments) {
        wcsncpy_s(g.pendingAttachments, job.attachments, _TRUNCATE);
    }
    refresh_queue_view();
    add_log(L"队列任务 #%lld · %s · %s · 来源 %s", job.row_id,
            job_type_label(job.type), job.target, job.source);
    {
        feather::queue::Job persisted{};
        if (feather::queue::find(g.jobApiId, &persisted)) {
            add_log(L"领取已落库 · 行状态 %d · 意图 %d",
                    static_cast<int>(persisted.state),
                    persisted.delivery_attempted ? 1 : 0);
        } else {
            add_log(L"领取已落库校验失败 · 行不存在");
        }
    }
    start_wechat_check();
}

// 每条任务（搜索/发送）允许占用鼠标的最长时间，来自可选的
// <exe目录>\send-timeout.txt（单位：秒；默认 45，限制 5~600）。
unsigned read_send_timeout_ms() {
    constexpr unsigned kDefaultMs = 45000;
    constexpr unsigned kMinMs = 5000;
    constexpr unsigned kMaxMs = 600000;

    wchar_t path[MAX_PATH]{};
    if (!api_file_path(L"send-timeout.txt", path, ARRAYSIZE(path))) {
        return kDefaultMs;
    }
    HANDLE file = CreateFileW(path, GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return kDefaultMs;
    }
    char raw[32]{};
    DWORD read = 0;
    const BOOL ok = ReadFile(file, raw, ARRAYSIZE(raw) - 1, &read, nullptr);
    CloseHandle(file);
    if (!ok || read == 0) {
        return kDefaultMs;
    }
    raw[read] = '\0';
    while (read > 0 && (raw[read - 1] == '\r' || raw[read - 1] == '\n'
                        || raw[read - 1] == ' ' || raw[read - 1] == '\t')) {
        raw[--read] = '\0';
    }
    char* end = nullptr;
    const long seconds = std::strtol(raw, &end, 10);
    if (!end || *end != '\0' || seconds <= 0) {
        return kDefaultMs;
    }
    unsigned ms = static_cast<unsigned>(seconds) * 1000u;
    if (ms < kMinMs) {
        ms = kMinMs;
    } else if (ms > kMaxMs) {
        ms = kMaxMs;
    }
    return ms;
}

bool read_api_enabled_setting() {
    wchar_t path[MAX_PATH]{};
    if (!api_file_path(L"api-enabled.txt", path, ARRAYSIZE(path))) {
        return false;
    }
    HANDLE file = CreateFileW(path, GENERIC_READ,
                              FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                              OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return false;
    }
    char value = 0;
    DWORD read = 0;
    const BOOL ok = ReadFile(file, &value, 1, &read, nullptr);
    CloseHandle(file);
    return ok != FALSE && read == 1 && value == '1';
}

void write_api_enabled_setting(bool enabled) {
    wchar_t path[MAX_PATH]{};
    if (!api_file_path(L"api-enabled.txt", path, ARRAYSIZE(path))) {
        return;
    }
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return;
    }
    const char value = enabled ? '1' : '0';
    DWORD written = 0;
    WriteFile(file, &value, 1, &written, nullptr);
    WriteFile(file, "\r\n", 2, &written, nullptr);
    CloseHandle(file);
}

// True once the user acknowledged the first-run shortcut reminder. A missing
// marker (fresh install, or a user upgrading from a build that predates the
// reminder) means the tip still has to be shown.
bool shortcut_tip_acknowledged() {
    wchar_t path[MAX_PATH]{};
    if (!api_file_path(kShortcutTipFile, path, ARRAYSIZE(path))) {
        return false;
    }
    const DWORD attributes = GetFileAttributesW(path);
    return attributes != INVALID_FILE_ATTRIBUTES
        && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

void acknowledge_shortcut_tip() {
    wchar_t path[MAX_PATH]{};
    if (!api_file_path(kShortcutTipFile, path, ARRAYSIZE(path))) {
        return;
    }
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                              FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        return;
    }
    DWORD written = 0;
    WriteFile(file, "1\r\n", 3, &written, nullptr);
    CloseHandle(file);
}

// Opens <exe目录>\instance.lock without sharing and keeps it for the process
// lifetime. Returns nullptr and sets *error when the lock is unavailable.
HANDLE acquire_instance_lock(DWORD* error) {
    *error = ERROR_SUCCESS;
    wchar_t path[MAX_PATH]{};
    if (!api_file_path(kInstanceLockFile, path, ARRAYSIZE(path))) {
        *error = ERROR_FILENAME_EXCED_RANGE;
        return nullptr;
    }
    HANDLE file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) {
        *error = GetLastError();
        return nullptr;
    }
    return file;
}

// Shows the one-time reminder. "是" acknowledges it (writes the marker);
// "否" or closing the dialog keeps it for the next start, so a user who has
// not touched WeChat's settings yet gets reminded again.
void show_shortcut_tip() {
    add_log(L"首次使用提示 · 请把微信发送快捷键设为 Ctrl+Enter");
    int result = IDNO;
    {
        // The queue must not start sending before the user has seen this.
        ModalScope modal;
        result = MessageBoxW(
            g.hwnd, kShortcutTipText, kShortcutTipTitle,
            MB_YESNO | MB_ICONINFORMATION | MB_DEFBUTTON1 | MB_SETFOREGROUND);
    }
    if (result == IDYES) {
        acknowledge_shortcut_tip();
        add_log(L"发送快捷键提醒已确认 · 不再提示");
    } else {
        add_log(L"发送快捷键尚未确认 · 下次启动将再次提醒");
    }
}

void remove_api_port_file() {
    wchar_t path[MAX_PATH]{};
    if (api_file_path(L"api-port.txt", path, ARRAYSIZE(path))) {
        DeleteFileW(path);
    }
}

void reset_api_endpoint() {
    g.apiPort = 0;
    g.apiToken[0] = '\0';
    wcscpy_s(g.apiHost, L"127.0.0.1");
    wcscpy_s(g.apiListen, L"127.0.0.1");
}

// 界面、日志只显示令牌首尾各 4 位；完整令牌只通过“复制”进入剪贴板。
void format_masked_token(wchar_t* out, size_t capacity) {
    wchar_t raw[33]{};
    for (int index = 0; index < 32 && g.apiToken[index]; ++index) {
        raw[index] = static_cast<wchar_t>(
            static_cast<unsigned char>(g.apiToken[index]));
    }
    const size_t length = wcslen(raw);
    if (length > 8) {
        _snwprintf_s(out, capacity, _TRUNCATE, L"%.4ls••••••••%ls", raw,
                     raw + length - 4);
    } else if (length > 0) {
        wcsncpy_s(out, capacity, L"••••••••", _TRUNCATE);
    } else {
        wcsncpy_s(out, capacity, L"—", _TRUNCATE);
    }
}

std::wstring webhook_url(bool masked) {
    std::wstring token;
    if (masked) {
        wchar_t hidden[48]{};
        format_masked_token(hidden, ARRAYSIZE(hidden));
        token = hidden;
    } else {
        for (int index = 0; index < 32 && g.apiToken[index]; ++index) {
            token.push_back(static_cast<wchar_t>(
                static_cast<unsigned char>(g.apiToken[index])));
        }
    }
    return L"http://" + std::wstring(g.apiHost) + L":"
        + std::to_wstring(static_cast<unsigned>(g.apiPort)) + L"/webhook/"
        + token;
}

void start_http_api() {
    if (g.apiRunning) {
        return;
    }
    const feather::api::StartResult result =
        feather::api::start(g.hwnd, kJobMessage, kExitMessage);
    if (!result.started) {
        // A transient bind failure must not silently turn the API off for
        // future launches; only an explicit user toggle writes 0.
        g.apiRunning = false;
        reset_api_endpoint();
        add_log(L"HTTP API 启动失败 · 错误码 %lu · 可在界面重新开启", result.error);
        if (g.hwnd) {
            InvalidateRect(g.hwnd, nullptr, FALSE);
        }
        return;
    }
    g.apiRunning = true;
    g.apiPort = result.port;
    strcpy_s(g.apiToken, result.token);
    wcscpy_s(g.apiListen, ARRAYSIZE(g.apiListen),
             result.listen_address[0] ? result.listen_address : L"127.0.0.1");
    wcscpy_s(g.apiHost, ARRAYSIZE(g.apiHost),
             result.advertise_ipv4[0] ? result.advertise_ipv4 : L"127.0.0.1");
    if (wcscmp(g.apiHost, L"0.0.0.0") == 0) {
        // Defensive: a bind-any address is useless inside a URL.
        wcscpy_s(g.apiHost, L"127.0.0.1");
    }
    write_api_enabled_setting(true);
    add_log(L"HTTP API 已开启 · %ls:%u", g.apiListen,
            static_cast<unsigned>(g.apiPort));
    if (result.lan_exposed) {
        add_log(L"局域网 Webhook 地址 · %ls · 完整地址请在帮助窗口复制",
                webhook_url(true).c_str());
        add_log(L"局域网监听 · 端口由系统自动分配 · 其他电脑无法连接时请在 Windows 防火墙放行本程序");
    } else {
        add_log(L"Webhook 地址 · %ls · 完整地址请在帮助窗口复制",
                webhook_url(true).c_str());
    }
    if (result.listen_fallback) {
        add_log(L"api-listen.txt 指定地址绑定失败 · 已回退 127.0.0.1");
    }
    apply_api_layout();
    refresh_help_window();
}

void stop_http_api() {
    if (g.jobActive) {
        add_log(L"HTTP API 任务执行中 · 请稍候");
        return;
    }
    bool stopped = true;
    DWORD stop_error = ERROR_SUCCESS;
    if (g.apiRunning) {
        stopped = feather::api::stop();
        stop_error = stopped ? ERROR_SUCCESS : GetLastError();
    }
    g.apiRunning = false;
    reset_api_endpoint();
    write_api_enabled_setting(false);
    remove_api_port_file();
    if (stopped) {
        add_log(L"HTTP API 已关闭");
    } else {
        // stop() closed the listener first, so no new requests arrive.
        add_log(L"HTTP API 已停止监听 · 后台线程未按时退出 · 错误码 %lu · 重新开启失败时请重启程序",
                stop_error);
    }
    apply_api_layout();
    refresh_help_window();
}

void toggle_http_api() {
    if (g.apiRunning) {
        stop_http_api();
    } else {
        start_http_api();
    }
}

void refresh_http_api_token() {
    if (!g.apiRunning) {
        add_log(L"HTTP API 未开启 · 无法刷新令牌");
        return;
    }
    char token[33]{};
    DWORD error = ERROR_SUCCESS;
    if (!feather::api::rotate_token(token, ARRAYSIZE(token), &error)) {
        add_log(L"HTTP API 令牌刷新失败 · 错误码 %lu", error);
        return;
    }
    strcpy_s(g.apiToken, token);
    add_log(L"HTTP API 令牌已刷新 · Webhook 地址随之更新（请同步外部平台）");
    if (g.hwnd) {
        InvalidateRect(g.hwnd, nullptr, FALSE);
    }
    refresh_help_window();
}

template <typename Handle>
void destroy_gdi_handle(Handle& handle) {
    if (handle) {
        DeleteObject(handle);
        handle = nullptr;
    }
}

void destroy_fonts() {
    destroy_gdi_handle(g.fonts.title);
    destroy_gdi_handle(g.fonts.status);
    destroy_gdi_handle(g.fonts.subtitle);
    destroy_gdi_handle(g.fonts.body);
    destroy_gdi_handle(g.fonts.bodyBold);
    destroy_gdi_handle(g.fonts.smallText);
    destroy_gdi_handle(g.fonts.metric);
    destroy_gdi_handle(g.fonts.unit);
    destroy_gdi_handle(g.fonts.log);
    destroy_gdi_handle(g.fonts.code);
    destroy_gdi_handle(g.fonts.hint);
}

HFONT create_font(int pixelHeight, int weight, const wchar_t* face) {
    return CreateFontW(-scale(pixelHeight), 0, 0, 0, weight, FALSE, FALSE, FALSE,
                       DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS,
                       CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, face);
}

void create_fonts() {
    destroy_fonts();
    g.fonts.title = create_font(26, FW_SEMIBOLD, L"Microsoft YaHei UI");
    g.fonts.status = create_font(18, FW_SEMIBOLD, L"Microsoft YaHei UI");
    g.fonts.subtitle = create_font(10, FW_NORMAL, L"Microsoft YaHei UI");
    g.fonts.body = create_font(12, FW_NORMAL, L"Microsoft YaHei UI");
    g.fonts.bodyBold = create_font(12, FW_SEMIBOLD, L"Microsoft YaHei UI");
    g.fonts.smallText = create_font(10, FW_NORMAL, L"Microsoft YaHei UI");
    g.fonts.metric = create_font(23, FW_BOLD, L"Microsoft YaHei UI");
    g.fonts.unit = create_font(13, FW_SEMIBOLD, L"Consolas");
    g.fonts.log = create_font(11, FW_NORMAL, L"Consolas");
    g.fonts.code = create_font(10, FW_NORMAL, L"Consolas");
    g.fonts.hint = create_font(9, FW_NORMAL, L"Microsoft YaHei UI");
}

void create_brushes() {
    g.brushes.background = CreateSolidBrush(kBgBottom);
    g.brushes.card = CreateSolidBrush(kCard);
    g.brushes.cardAlt = CreateSolidBrush(kCardAlt);
    g.brushes.log = CreateSolidBrush(kLogBg);
    g.brushes.border = CreateSolidBrush(kBorder);
    g.brushes.borderSoft = CreateSolidBrush(kBorderSoft);
    g.brushes.accent = CreateSolidBrush(kAccent);
    g.brushes.accentHover = CreateSolidBrush(kAccentHover);
    g.brushes.accentPressed = CreateSolidBrush(kAccentPressed);
    g.brushes.muted = CreateSolidBrush(kMuted);
    g.brushes.amber = CreateSolidBrush(kAmber);
    g.brushes.red = CreateSolidBrush(kRed);
    g.brushes.ink = CreateSolidBrush(kInk);
    g.brushes.button = CreateSolidBrush(kButton);
    g.brushes.buttonHover = CreateSolidBrush(kButtonHover);
    g.brushes.buttonPressed = CreateSolidBrush(kButtonPressed);
}

void destroy_brushes() {
    destroy_gdi_handle(g.brushes.background);
    destroy_gdi_handle(g.brushes.card);
    destroy_gdi_handle(g.brushes.cardAlt);
    destroy_gdi_handle(g.brushes.log);
    destroy_gdi_handle(g.brushes.border);
    destroy_gdi_handle(g.brushes.borderSoft);
    destroy_gdi_handle(g.brushes.accent);
    destroy_gdi_handle(g.brushes.accentHover);
    destroy_gdi_handle(g.brushes.accentPressed);
    destroy_gdi_handle(g.brushes.muted);
    destroy_gdi_handle(g.brushes.amber);
    destroy_gdi_handle(g.brushes.red);
    destroy_gdi_handle(g.brushes.ink);
    destroy_gdi_handle(g.brushes.button);
    destroy_gdi_handle(g.brushes.buttonHover);
    destroy_gdi_handle(g.brushes.buttonPressed);
}

HICON load_app_icon(int size) {
    return static_cast<HICON>(
        LoadImageW(g.instance, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON, size, size,
                   LR_DEFAULTCOLOR));
}

void update_tray_icon();

void refresh_icons() {
    const int big = GetSystemMetricsForDpi(SM_CXICON, g.dpi);
    const int smallIconSize = GetSystemMetricsForDpi(SM_CXSMICON, g.dpi);

    HICON newWindow = load_app_icon(big);
    HICON newSmall = load_app_icon(smallIconSize);
    HICON newHeader = load_app_icon(scale(34));

    if (newWindow) {
        SendMessageW(g.hwnd, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(newWindow));
        if (g.iconWindow) {
            DestroyIcon(g.iconWindow);
        }
        g.iconWindow = newWindow;
    }
    if (newSmall) {
        SendMessageW(g.hwnd, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(newSmall));
        HICON previousSmall = g.iconSmall;
        g.iconSmall = newSmall;
        update_tray_icon();
        if (previousSmall) {
            DestroyIcon(previousSmall);
        }
    }
    if (newHeader) {
        if (g.iconHeader) {
            DestroyIcon(g.iconHeader);
        }
        g.iconHeader = newHeader;
    }
}

void apply_input_edit_styles() {
    HWND edits[] = {g.searchEdit, g.contentEdit, g.attachmentEdit, g.mentionEdit};
    for (HWND edit : edits) {
        if (!edit) {
            continue;
        }
        SendMessageW(edit, WM_SETFONT,
                     reinterpret_cast<WPARAM>(g.fonts.body), TRUE);
        SendMessageW(edit, kEmSetMargins, kEcLeftMargin | kEcRightMargin,
                     MAKELPARAM(scale(8), scale(8)));
    }
}

void position_input_edits() {
    if (!g.hwnd) {
        return;
    }
    RECT client{};
    GetClientRect(g.hwnd, &client);
    const Layout layout = make_layout(client.right, client.bottom);
    const int horizontal_inset = scale(1);
    const int edit_height = scale(24);

    auto position_edit = [&](HWND edit, const RECT& field) {
        if (!edit) {
            return;
        }
        const int field_height = field.bottom - field.top;
        const int edit_top = field.top + (field_height - edit_height) / 2;
        SetWindowPos(edit, nullptr, field.left + horizontal_inset, edit_top,
                     (field.right - field.left) - 2 * horizontal_inset,
                     edit_height, SWP_NOZORDER | SWP_NOACTIVATE);
    };

    position_edit(g.searchEdit, layout.searchField);
    position_edit(g.contentEdit, layout.messageField);
    position_edit(g.attachmentEdit, layout.attachmentField);
    position_edit(g.mentionEdit, layout.mentionField);
}

void apply_api_layout() {
    if (!g.hwnd) {
        return;
    }
    RECT window{};
    GetWindowRect(g.hwnd, &window);
    RECT frame{0, 0, scale(kClientWidth), scale(kClientHeight)};
    AdjustWindowRectExForDpi(&frame, kWindowStyle, FALSE, 0, g.dpi);
    SetWindowPos(g.hwnd, nullptr, window.left, window.top,
                 frame.right - frame.left, frame.bottom - frame.top,
                 SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    if (!IsWindowVisible(g.hwnd)) {
        center_window();
    }
    position_input_edits();
    InvalidateRect(g.hwnd, nullptr, FALSE);
}

void create_input_edits(HWND hwnd) {
    g.searchEdit = CreateWindowExW(
        0, L"EDIT", L"",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_LEFT | ES_AUTOHSCROLL,
        0, 0, scale(100), scale(30), hwnd,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(kSearchEditId)),
        g.instance, nullptr);
    g.contentEdit = CreateWindowExW(
        0, L"EDIT", L"",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_LEFT | ES_AUTOHSCROLL,
        0, 0, scale(100), scale(30), hwnd,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(kContentEditId)),
        g.instance, nullptr);
    g.attachmentEdit = CreateWindowExW(
        0, L"EDIT", L"",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_LEFT | ES_AUTOHSCROLL,
        0, 0, scale(100), scale(30), hwnd,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(kAttachmentEditId)),
        g.instance, nullptr);
    g.mentionEdit = CreateWindowExW(
        0, L"EDIT", L"",
        WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_LEFT | ES_AUTOHSCROLL,
        0, 0, scale(100), scale(30), hwnd,
        reinterpret_cast<HMENU>(static_cast<INT_PTR>(kMentionEditId)),
        g.instance, nullptr);
    apply_input_edit_styles();
    if (g.searchEdit) {
        SendMessageW(g.searchEdit, EM_SETLIMITTEXT, 120, 0);
        SendMessageW(g.searchEdit, kEmSetCueBanner, TRUE,
                     reinterpret_cast<LPARAM>(L"输入联系人或群聊名称"));
    }
    if (g.contentEdit) {
        SendMessageW(g.contentEdit, EM_SETLIMITTEXT, 500, 0);
        SendMessageW(g.contentEdit, kEmSetCueBanner, TRUE,
                     reinterpret_cast<LPARAM>(L"输入要发送的对话内容"));
    }
    if (g.attachmentEdit) {
        SendMessageW(g.attachmentEdit, EM_SETLIMITTEXT, 1000, 0);
        SendMessageW(g.attachmentEdit, kEmSetCueBanner, TRUE,
                     reinterpret_cast<LPARAM>(L"文件路径，多个用 ; 分隔"));
    }
    if (g.mentionEdit) {
        SendMessageW(g.mentionEdit, EM_SETLIMITTEXT, 120, 0);
        SendMessageW(g.mentionEdit, kEmSetCueBanner, TRUE,
                     reinterpret_cast<LPARAM>(L"要 @ 的成员名称（可选）"));
    }
    position_input_edits();
}

NOTIFYICONDATAW make_tray_data() {
    NOTIFYICONDATAW data{};
    data.cbSize = sizeof(data);
    data.hWnd = g.hwnd;
    data.uID = 1;
    return data;
}

bool add_tray_icon() {
    NOTIFYICONDATAW data = make_tray_data();
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    data.uCallbackMessage = kTrayMessage;
    data.hIcon = g.iconSmall ? g.iconSmall : LoadIconW(nullptr, IDI_APPLICATION);
    wcsncpy_s(data.szTip, ARRAYSIZE(data.szTip), kTrayTip, _TRUNCATE);
    g.trayAdded = Shell_NotifyIconW(NIM_ADD, &data) != FALSE;
    return g.trayAdded;
}

void remove_tray_icon() {
    if (!g.trayAdded || !g.hwnd) {
        g.trayAdded = false;
        return;
    }
    NOTIFYICONDATAW data = make_tray_data();
    Shell_NotifyIconW(NIM_DELETE, &data);
    g.trayAdded = false;
}

void update_tray_icon() {
    if (!g.trayAdded || !g.iconSmall) {
        return;
    }
    NOTIFYICONDATAW data = make_tray_data();
    data.uFlags = NIF_ICON;
    data.hIcon = g.iconSmall;
    Shell_NotifyIconW(NIM_MODIFY, &data);
}

void show_tray_balloon() {
    if (!g.trayAdded || g.balloonShown) {
        return;
    }
    NOTIFYICONDATAW data = make_tray_data();
    data.uFlags = NIF_INFO;
    wcsncpy_s(data.szInfoTitle, ARRAYSIZE(data.szInfoTitle), kAppName, _TRUNCATE);
    wcsncpy_s(data.szInfo, ARRAYSIZE(data.szInfo),
              L"已转入后台运行，自动化进程保持在线。", _TRUNCATE);
    data.dwInfoFlags = NIIF_INFO;
    Shell_NotifyIconW(NIM_MODIFY, &data);
    g.balloonShown = true;
}

void show_main_window() {
    if (!g.hwnd) {
        return;
    }
    g.hidden = false;
    g.hot = Hot::None;
    g.pressed = Hot::None;
    g.trackingMouse = false;
    ShowWindow(g.hwnd, SW_SHOWNORMAL);
    SetForegroundWindow(g.hwnd);
    SetFocus(g.hwnd);
    SetTimer(g.hwnd, kSampleTimer, 1000, nullptr);
    sample_metrics();
    InvalidateRect(g.hwnd, nullptr, FALSE);
}

void raise_main_window() {
    if (!g.hwnd || g.hidden || !IsWindowVisible(g.hwnd)) {
        return;
    }
    if (IsIconic(g.hwnd)) {
        ShowWindow(g.hwnd, SW_RESTORE);
    }
    feather::automation::force_foreground(g.hwnd);
    InvalidateRect(g.hwnd, nullptr, FALSE);
}

void hide_to_tray() {
    if (!g.hwnd) {
        return;
    }
    if (!g.trayAdded) {
        add_tray_icon();
    }
    if (!g.trayAdded) {
        add_log(L"系统托盘不可用，窗口保持显示");
        return;
    }
    if (GetCapture() == g.hwnd) {
        ReleaseCapture();
    }
    ShowWindow(g.hwnd, SW_HIDE);
    g.hidden = true;
    g.hot = Hot::None;
    g.pressed = Hot::None;
    g.trackingMouse = false;
    KillTimer(g.hwnd, kSampleTimer);
    show_tray_balloon();
}

void begin_exit() {
    if (g.exitRequested || !g.hwnd) {
        return;
    }
    g.exitRequested = true;
    DestroyWindow(g.hwnd);
}

// ---------------------------------------------------------------------------
// 停止快捷键：Ctrl+Alt+Q。独立线程注册全局热键，因此即使 UI 线程正被自动化
// 阻塞也能立即释放鼠标并请求退出，避免程序一直占用鼠标。
// ---------------------------------------------------------------------------
HANDLE g_stopHotkeyThread = nullptr;
DWORD g_stopHotkeyThreadId = 0;
volatile LONG g_stopHotkeyQuit = 0;
HANDLE g_stopHotkeyReady = nullptr;
DWORD g_stopHotkeyError = ERROR_SUCCESS;

DWORD WINAPI stop_hotkey_thread(LPVOID /*parameter*/) {
    if (!RegisterHotKey(nullptr, kStopHotkeyId, kStopHotkeyModifiers,
                        kStopHotkeyKey)) {
        g_stopHotkeyError = GetLastError();
        SetEvent(g_stopHotkeyReady);
        return 1;
    }
    SetEvent(g_stopHotkeyReady);
    MSG message{};
    while (InterlockedCompareExchange(&g_stopHotkeyQuit, 0, 0) == 0
           && GetMessageW(&message, nullptr, 0, 0) > 0) {
        if (message.message == WM_HOTKEY && message.wParam == kStopHotkeyId) {
            feather::automation::emergency_stop_input();
            if (g.hwnd) {
                PostMessageW(g.hwnd, kExitMessage, 0, 0);
            }
            break;
        }
    }
    UnregisterHotKey(nullptr, kStopHotkeyId);
    return 0;
}

void start_stop_hotkey() {
    g_stopHotkeyQuit = 0;
    g_stopHotkeyError = ERROR_SUCCESS;
    g_stopHotkeyReady = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_stopHotkeyReady) {
        return;
    }
    g_stopHotkeyThread = CreateThread(nullptr, 0, stop_hotkey_thread, nullptr,
                                      0, &g_stopHotkeyThreadId);
    if (!g_stopHotkeyThread) {
        CloseHandle(g_stopHotkeyReady);
        g_stopHotkeyReady = nullptr;
        add_log(L"停止快捷键线程创建失败");
        return;
    }
    WaitForSingleObject(g_stopHotkeyReady, 1000);
    if (g_stopHotkeyError == ERROR_SUCCESS) {
        add_log(L"停止快捷键已就绪 · Ctrl+Alt+Q（立即释放鼠标并退出）");
    } else {
        add_log(L"停止快捷键注册失败 · 错误码 %lu", g_stopHotkeyError);
    }
    CloseHandle(g_stopHotkeyReady);
    g_stopHotkeyReady = nullptr;
}

void stop_stop_hotkey() {
    InterlockedExchange(&g_stopHotkeyQuit, 1);
    if (g_stopHotkeyThreadId) {
        PostThreadMessageW(g_stopHotkeyThreadId, WM_QUIT, 0, 0);
    }
    if (g_stopHotkeyThread) {
        WaitForSingleObject(g_stopHotkeyThread, 2000);
        CloseHandle(g_stopHotkeyThread);
        g_stopHotkeyThread = nullptr;
    }
    g_stopHotkeyThreadId = 0;
}

bool has_argument(const wchar_t* wanted) {
    int count = 0;
    LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments) {
        return false;
    }
    bool found = false;
    for (int index = 1; index < count; ++index) {
        if (_wcsicmp(arguments[index], wanted) == 0) {
            found = true;
            break;
        }
    }
    LocalFree(arguments);
    return found;
}

void apply_dwm_style() {
    const BOOL dark = TRUE;
    if (FAILED(DwmSetWindowAttribute(g.hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE,
                                     &dark, sizeof(dark)))) {
        constexpr DWORD kLegacyDarkModeAttribute = 19;
        DwmSetWindowAttribute(g.hwnd, kLegacyDarkModeAttribute, &dark, sizeof(dark));
    }

    const COLORREF caption = RGB(11, 15, 20);
    DwmSetWindowAttribute(g.hwnd, DWMWA_CAPTION_COLOR, &caption, sizeof(caption));

    const COLORREF border = RGB(35, 45, 57);
    DwmSetWindowAttribute(g.hwnd, DWMWA_BORDER_COLOR, &border, sizeof(border));

    const COLORREF text = RGB(235, 242, 248);
    DwmSetWindowAttribute(g.hwnd, DWMWA_TEXT_COLOR, &text, sizeof(text));
}

void center_window() {
    RECT window{};
    GetWindowRect(g.hwnd, &window);
    const int width = window.right - window.left;
    const int height = window.bottom - window.top;

    MONITORINFO monitor{};
    monitor.cbSize = sizeof(monitor);
    GetMonitorInfoW(MonitorFromWindow(g.hwnd, MONITOR_DEFAULTTOPRIMARY), &monitor);

    const RECT& work = monitor.rcWork;
    const int x = work.left + (work.right - work.left - width) / 2;
    const int y = work.top + (work.bottom - work.top - height) / 2;
    SetWindowPos(g.hwnd, nullptr, x, y, 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

Hot hit_test(POINT point) {
    RECT client{};
    GetClientRect(g.hwnd, &client);
    const Layout layout = make_layout(client.right, client.bottom);
    if (PtInRect(&layout.primary, point)) {
        return Hot::Primary;
    }
    if (PtInRect(&layout.secondary, point)) {
        return Hot::Secondary;
    }
    if (PtInRect(&layout.searchButton, point)) {
        return Hot::Search;
    }
    if (PtInRect(&layout.messageButton, point)) {
        return Hot::Send;
    }
    if (PtInRect(&layout.attachmentButton, point)) {
        return Hot::SendAttachment;
    }
    if (PtInRect(&layout.mentionNewlineCheck, point)) {
        return Hot::MentionNewline;
    }
    if (PtInRect(&layout.apiCopy, point)) {
        return Hot::ApiCopy;
    }
    if (PtInRect(&layout.apiRefreshButton, point)) {
        return Hot::ApiRefresh;
    }
    if (PtInRect(&layout.apiToggle, point)) {
        return Hot::ApiToggle;
    }
    if (PtInRect(&layout.tabQueue, point)) {
        return Hot::TabQueue;
    }
    if (PtInRect(&layout.tabLog, point)) {
        return Hot::TabLog;
    }
    if (PtInRect(&layout.help, point)) {
        return Hot::Help;
    }
    if (PtInRect(&layout.exit, point)) {
        return Hot::Exit;
    }
    return Hot::None;
}

void activate_hot(Hot hot) {
    if (hot == Hot::None) {
        return;
    }
    switch (hot) {
    case Hot::Primary:
        user_check_wechat();
        break;
    case Hot::Secondary:
        hide_to_tray();
        break;
    case Hot::Search:
        start_search_task();
        break;
    case Hot::Send:
        start_send_task();
        break;
    case Hot::SendAttachment:
        start_attachment_task();
        break;
    case Hot::MentionNewline:
        g.mentionNewline = !g.mentionNewline;
        add_log(L"@对象后分隔：%s", g.mentionNewline ? L"换行" : L"空格");
        InvalidateRect(g.hwnd, nullptr, FALSE);
        break;
    case Hot::ApiToggle:
        toggle_http_api();
        break;
    case Hot::ApiCopy:
        copy_api_token_to_clipboard();
        break;
    case Hot::ApiRefresh:
        refresh_http_api_token();
        break;
    case Hot::TabLog:
        open_log_window();
        break;
    case Hot::TabQueue:
        open_queue_window();
        break;
    case Hot::Help:
        open_help_window();
        break;
    case Hot::Exit:
        begin_exit();
        break;
    case Hot::None:
        break;
    }
}

void paint_header(HDC dc, const Layout& layout) {
    if (g.iconHeader) {
        DrawIconEx(dc, layout.icon.left, layout.icon.top, g.iconHeader,
                   layout.icon.right - layout.icon.left,
                   layout.icon.bottom - layout.icon.top, 0, nullptr, DI_NORMAL);
    }

    draw_text(dc, g.fonts.title, kText, kAppName, layout.title,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    const int previousExtra = SetTextCharacterExtra(dc, scale(1));
    draw_text(dc, g.fonts.subtitle, kMuted,
              L"微信消息自动化 · 本地运行 · Win32 原生",
              layout.subtitle, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SetTextCharacterExtra(dc, previousExtra);

    const bool helpHot = g.hot == Hot::Help || g.pressed == Hot::Help;
    fill(dc, layout.help, helpHot ? g.brushes.buttonHover : g.brushes.cardAlt);
    outline(dc, layout.help, helpHot ? g.brushes.accent : g.brushes.border);
    draw_text(dc, g.fonts.smallText, helpHot ? kText : kMuted, L"帮助",
              layout.help, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    fill(dc, layout.divider, g.brushes.borderSoft);

    fill(dc, layout.status, g.brushes.cardAlt);
    outline(dc, layout.status, g.brushes.border);

    HBRUSH stateBrush = wechat_state_brush(g.wechatState);
    RECT stateBar{layout.status.left + scale(1), layout.status.top + scale(12),
                  layout.status.left + scale(4),
                  layout.status.bottom - scale(12)};
    fill(dc, stateBar, stateBrush);

    const int dot = scale(7);
    const int centerY = layout.status.top + scale(20);
    HGDIOBJ previousBrush = SelectObject(dc, wechat_state_brush(g.wechatState));
    Ellipse(dc, layout.status.left + scale(16), centerY - dot / 2,
            layout.status.left + scale(16) + dot, centerY - dot / 2 + dot);
    SelectObject(dc, previousBrush);

    const int split = layout.status.right - scale(216);
    RECT statusText{layout.status.left + scale(30), layout.status.top + scale(4),
                    split - scale(12), layout.status.top + scale(35)};
    draw_text(dc, g.fonts.status, wechat_state_color(g.wechatState),
              wechat_state_label(g.wechatState), statusText,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    RECT statusDetail{layout.status.left + scale(30),
                      layout.status.top + scale(35),
                      split - scale(12), layout.status.top + scale(58)};
    const ULONGLONG backoffMs = queue_backoff_remaining_ms();
    wchar_t backoffText[96]{};
    if (backoffMs > 0) {
        swprintf_s(backoffText, ARRAYSIZE(backoffText),
                   L"队列等待微信 · %llu 秒后重试，或点击“检查微信状态”",
                   (backoffMs + 999) / 1000);
    }
    draw_text(dc, g.fonts.smallText, backoffMs > 0 ? kAmber : kMuted,
              backoffMs > 0 ? backoffText
                            : wechat_state_description(g.wechatState),
              statusDetail,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                  | DT_NOPREFIX);

    RECT splitLine{split, layout.status.top + scale(12), split + scale(1),
                  layout.status.bottom - scale(12)};
    fill(dc, splitLine, g.brushes.borderSoft);

    const int labelLeft = split + scale(14);
    const int valueLeft = labelLeft + scale(56);
    RECT apiLabel{labelLeft, layout.status.top + scale(8), valueLeft,
                  layout.status.top + scale(31)};
    RECT apiValue{valueLeft, apiLabel.top, layout.status.right - scale(16),
                  apiLabel.bottom};
    draw_text(dc, g.fonts.smallText, kFaint, L"本地接口", apiLabel,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(dc, g.fonts.smallText, g.apiRunning ? kAccent : kMuted,
              g.apiRunning ? L"已开启" : L"未开启", apiValue,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    RECT queueLabel{labelLeft, layout.status.top + scale(31), valueLeft,
                    layout.status.top + scale(54)};
    RECT queueValue{valueLeft, queueLabel.top, layout.status.right - scale(16),
                    queueLabel.bottom};
    wchar_t queueLine[64]{};
    if (backoffMs > 0) {
        swprintf_s(queueLine, ARRAYSIZE(queueLine), L"%d 待发 · 等待微信",
                   g.queueStats.queued);
    } else {
        swprintf_s(queueLine, ARRAYSIZE(queueLine), L"%d 待发 · %d 执行中",
                   g.queueStats.queued, g.queueStats.running);
    }
    draw_text(dc, g.fonts.smallText, kFaint, L"发送队列", queueLabel,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(dc, g.fonts.smallText, backoffMs > 0 ? kAmber : kTextSoft,
              queueLine, queueValue,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void paint_search_row(HDC dc, const Layout& layout) {
    fill(dc, layout.composer, g.brushes.card);
    outline(dc, layout.composer, g.brushes.border);

    RECT titleBar{layout.composer.left + scale(17),
                  layout.composer.top + scale(13),
                  layout.composer.left + scale(19),
                  layout.composer.top + scale(30)};
    fill(dc, titleBar, g.brushes.accent);
    draw_text(dc, g.fonts.bodyBold, kText, L"新建任务", layout.composerTitle,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(dc, g.fonts.smallText, kFaint,
              L"每行可单独执行 · 结果可在队列追踪", layout.composerHint,
              DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    RECT composerDivider{layout.composer.left + scale(18),
                         layout.composer.top + scale(37),
                         layout.composer.right - scale(18),
                         layout.composer.top + scale(38)};
    fill(dc, composerDivider, g.brushes.borderSoft);

    draw_text(dc, g.fonts.smallText, kMuted, L"会话对象", layout.searchLabel,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    const bool focused = g.searchEdit && GetFocus() == g.searchEdit;
    fill(dc, layout.searchField, g.brushes.cardAlt);
    outline(dc, layout.searchField, focused ? g.brushes.accent : g.brushes.border);

    HBRUSH background = g.brushes.button;
    if (g.pressed == Hot::Search) {
        background = g.brushes.buttonPressed;
    } else if (g.hot == Hot::Search) {
        background = g.brushes.buttonHover;
    }
    fill(dc, layout.searchButton, background);
    outline(dc, layout.searchButton,
            g.hot == Hot::Search ? g.brushes.accent : g.brushes.border);
    const COLORREF color = g.hot == Hot::Search ? kText : kAccent;
    draw_text(dc, g.fonts.bodyBold, color, L"搜索会话", layout.searchButton,
              DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void paint_message_row(HDC dc, const Layout& layout) {
    draw_text(dc, g.fonts.smallText, kMuted, L"对话内容", layout.messageLabel,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    const bool focused = g.contentEdit && GetFocus() == g.contentEdit;
    fill(dc, layout.messageField, g.brushes.cardAlt);
    outline(dc, layout.messageField, focused ? g.brushes.accent : g.brushes.border);

    HBRUSH background = g.brushes.button;
    if (g.pressed == Hot::Send) {
        background = g.brushes.buttonPressed;
    } else if (g.hot == Hot::Send) {
        background = g.brushes.buttonHover;
    }
    fill(dc, layout.messageButton, background);
    outline(dc, layout.messageButton,
            g.hot == Hot::Send ? g.brushes.accent : g.brushes.border);
    const COLORREF color = g.hot == Hot::Send ? kText : kAccent;
    draw_text(dc, g.fonts.bodyBold, color, L"发送消息", layout.messageButton,
              DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void paint_attachment_row(HDC dc, const Layout& layout) {
    draw_text(dc, g.fonts.smallText, kMuted, L"附件内容", layout.attachmentLabel,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    const bool focused = g.attachmentEdit && GetFocus() == g.attachmentEdit;
    fill(dc, layout.attachmentField, g.brushes.cardAlt);
    outline(dc, layout.attachmentField, focused ? g.brushes.accent : g.brushes.border);

    HBRUSH background = g.brushes.button;
    if (g.pressed == Hot::SendAttachment) {
        background = g.brushes.buttonPressed;
    } else if (g.hot == Hot::SendAttachment) {
        background = g.brushes.buttonHover;
    }
    fill(dc, layout.attachmentButton, background);
    outline(dc, layout.attachmentButton,
            g.hot == Hot::SendAttachment ? g.brushes.accent : g.brushes.border);
    const COLORREF color = g.hot == Hot::SendAttachment ? kText : kAccent;
    draw_text(dc, g.fonts.bodyBold, color, L"发送附件", layout.attachmentButton,
              DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void paint_mention_option(HDC dc, const Layout& layout) {
    const bool hot = g.hot == Hot::MentionNewline
        || g.pressed == Hot::MentionNewline;
    const RECT& area = layout.mentionNewlineCheck;
    const int box_size = scale(16);
    const int left = area.left;
    RECT square{left, area.top + (area.bottom - area.top - box_size) / 2,
                left + box_size,
                area.top + (area.bottom - area.top - box_size) / 2 + box_size};
    if (g.mentionNewline) {
        fill(dc, square, g.brushes.accent);
        outline(dc, square, g.brushes.accent);
        draw_text(dc, g.fonts.smallText, kInk, L"✓", square,
                  DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    } else {
        fill(dc, square, g.brushes.cardAlt);
        outline(dc, square, hot ? g.brushes.accent : g.brushes.border);
    }
    RECT label{square.right + scale(8), area.top,
               area.right, area.bottom};
    draw_text(dc, g.fonts.smallText, hot ? kText : kTextSoft,
              L"换行（否则空格）", label,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void paint_mention_row(HDC dc, const Layout& layout) {
    draw_text(dc, g.fonts.smallText, kMuted, L"@对象", layout.mentionLabel,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    const bool focused = g.mentionEdit && GetFocus() == g.mentionEdit;
    fill(dc, layout.mentionField, g.brushes.cardAlt);
    outline(dc, layout.mentionField, focused ? g.brushes.accent : g.brushes.border);

}

void paint_api_card(HDC dc, const Layout& layout) {
    const bool enabled = g.apiRunning;
    fill(dc, layout.api, g.brushes.card);
    outline(dc, layout.api, g.brushes.border);

    RECT titleBar{layout.api.left + scale(1), layout.api.top + scale(13),
                  layout.api.left + scale(4), layout.api.top + scale(30)};
    fill(dc, titleBar, g.brushes.accent);

    RECT title{layout.api.left + scale(17), layout.api.top + scale(8),
               layout.api.left + scale(103), layout.api.top + scale(32)};
    draw_text(dc, g.fonts.bodyBold, kText, L"本地接口", title,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    RECT apiStatus{title.right, title.top, layout.apiToggle.left - scale(12),
                   title.bottom};
    draw_text(dc, g.fonts.smallText, enabled ? kAccent : kMuted,
              enabled ? L"运行中 · 供 AI Agent 调用"
                      : L"未开启 · 开启后供 AI Agent 调用",
              apiStatus, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                             | DT_NOPREFIX);

    const bool toggleHot = g.hot == Hot::ApiToggle
        || g.pressed == Hot::ApiToggle;
    fill(dc, layout.apiToggle,
         enabled ? g.brushes.accent : g.brushes.button);
    outline(dc, layout.apiToggle,
            toggleHot ? g.brushes.accentHover
                      : (enabled ? g.brushes.accent : g.brushes.border));

    const int knob = scale(16);
    const int knob_x = enabled
        ? layout.apiToggle.right - scale(3) - knob
        : layout.apiToggle.left + scale(3);
    const int knob_y =
        (layout.apiToggle.top + layout.apiToggle.bottom - knob) / 2;
    HGDIOBJ previousBrush = SelectObject(
        dc, enabled ? g.brushes.ink : g.brushes.muted);
    HGDIOBJ previousPen = SelectObject(dc, GetStockObject(NULL_PEN));
    Ellipse(dc, knob_x, knob_y, knob_x + knob, knob_y + knob);
    SelectObject(dc, previousPen);
    SelectObject(dc, previousBrush);

    RECT divider{layout.api.left + scale(18), layout.api.top + scale(34),
                 layout.api.right - scale(18), layout.api.top + scale(35)};
    fill(dc, divider, g.brushes.borderSoft);

    wchar_t address[80]{};
    if (enabled) {
        swprintf_s(address, ARRAYSIZE(address), L"%ls:%u", g.apiHost,
                   static_cast<unsigned>(g.apiPort));
    } else {
        wcscpy_s(address, L"启动后显示地址");
    }

    wchar_t tokenText[48]{};
    if (enabled) {
        format_masked_token(tokenText, ARRAYSIZE(tokenText));
    } else {
        wcscpy_s(tokenText, L"—");
    }

    const int textLeft = layout.api.left + scale(18);
    const int textRight = layout.apiCopy.left - scale(12);
    RECT addressLabel{textLeft, layout.api.top + scale(36),
                      textLeft + scale(34), layout.api.top + scale(53)};
    RECT addressValue{addressLabel.right, addressLabel.top, textRight,
                      addressLabel.bottom};
    draw_text(dc, g.fonts.smallText, kFaint, L"地址", addressLabel,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(dc, g.fonts.log, enabled ? kAccent : kFaint, address,
              addressValue,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                  | DT_NOPREFIX);

    RECT tokenLabel{textLeft, layout.api.top + scale(52),
                    textLeft + scale(34), layout.api.top + scale(69)};
    RECT tokenValue{tokenLabel.right, tokenLabel.top, textRight,
                    tokenLabel.bottom};
    draw_text(dc, g.fonts.smallText, kFaint, L"令牌", tokenLabel,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(dc, g.fonts.log, enabled ? kTextSoft : kFaint, tokenText,
              tokenValue,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                  | DT_NOPREFIX);

    auto paint_action = [&](const RECT& rect, const wchar_t* label, Hot hot) {
        const bool actionHot = enabled
            && (g.hot == hot || g.pressed == hot);
        HBRUSH background = g.brushes.button;
        if (enabled && g.pressed == hot) {
            background = g.brushes.buttonPressed;
        } else if (actionHot) {
            background = g.brushes.buttonHover;
        }
        fill(dc, rect, background);
        outline(dc, rect,
                actionHot ? g.brushes.accent : g.brushes.border);
        const COLORREF color = !enabled ? kFaint
            : actionHot ? kText : kAccent;
        draw_text(dc, g.fonts.smallText, color, label, rect,
                  DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    };
    paint_action(layout.apiCopy, L"复制令牌", Hot::ApiCopy);
    paint_action(layout.apiRefreshButton, L"刷新", Hot::ApiRefresh);
}

void paint_stats(HDC dc, const Layout& layout) {
    fill(dc, layout.stats, g.brushes.card);
    outline(dc, layout.stats, g.brushes.border);

    RECT titleBar{layout.stats.left + scale(1), layout.stats.top + scale(13),
                  layout.stats.left + scale(4), layout.stats.top + scale(29)};
    fill(dc, titleBar, g.brushes.accent);

    const int inset = scale(18);
    RECT title{layout.stats.left + scale(17), layout.stats.top + scale(7),
               layout.stats.right - inset, layout.stats.top + scale(27)};
    draw_text(dc, g.fonts.bodyBold, kText, L"本次运行", title,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    wchar_t scopeText[80]{};
    swprintf_s(scopeText, ARRAYSIZE(scopeText), L"附件文件 %d · 队列失败 %d",
               g.statsFiles, g.queueStats.failed);
    RECT scope{title.left, title.top, layout.stats.right - inset, title.bottom};
    draw_text(dc, g.fonts.smallText, kFaint, scopeText, scope,
              DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    RECT divider{layout.stats.left + inset, layout.stats.top + scale(28),
                 layout.stats.right - inset, layout.stats.top + scale(29)};
    fill(dc, divider, g.brushes.borderSoft);

    const int pendingJobs = g.queueStats.queued + g.queueStats.running;
    wchar_t values[5][16]{};
    swprintf_s(values[0], ARRAYSIZE(values[0]), L"%d",
               g.statsMessages + g.statsAttachments);
    swprintf_s(values[1], ARRAYSIZE(values[1]), L"%d", g.statsMessages);
    swprintf_s(values[2], ARRAYSIZE(values[2]), L"%d", g.statsAttachments);
    swprintf_s(values[3], ARRAYSIZE(values[3]), L"%d", g.statsUnverified);
    swprintf_s(values[4], ARRAYSIZE(values[4]), L"%d", pendingJobs);

    const wchar_t* labels[] = {
        L"已处理", L"文字消息", L"附件任务", L"待确认", L"队列中"};
    const COLORREF colors[] = {
        kAccent, kText, kText,
        g.statsUnverified > 0 ? kAmber : kFaint,
        pendingJobs > 0 ? kAccent : kFaint};

    const int left = layout.stats.left + inset;
    const int right = layout.stats.right - inset;
    const int gap = scale(10);
    const int column_width = (right - left - gap * 4) / 5;
    for (int index = 0; index < 5; ++index) {
        const int x = left + (column_width + gap) * index;
        RECT value{x, layout.stats.top + scale(30),
                   x + column_width, layout.stats.top + scale(54)};
        RECT label{x, layout.stats.top + scale(55),
                   x + column_width, layout.stats.top + scale(73)};
        draw_text(dc, g.fonts.metric, colors[index], values[index], value,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
        draw_text(dc, g.fonts.smallText, kMuted, labels[index], label,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }
}

const wchar_t* job_state_label(feather::queue::JobState state) {
    switch (state) {
    case feather::queue::JobState::Running:
        return L"执行中";
    case feather::queue::JobState::Succeeded:
        return L"已完成";
    case feather::queue::JobState::Failed:
        return L"失败";
    default:
        return L"待发送";
    }
}

void format_job_time(long long unix_seconds, wchar_t* out, size_t capacity) {
    out[0] = L'\0';
    if (unix_seconds <= 0) {
        return;
    }
    ULARGE_INTEGER value{};
    value.QuadPart = static_cast<ULONGLONG>(unix_seconds) * 10000000ULL
        + 116444736000000000ULL;
    FILETIME stamp{};
    stamp.dwLowDateTime = value.LowPart;
    stamp.dwHighDateTime = value.HighPart;
    SYSTEMTIME utc{};
    SYSTEMTIME local{};
    if (FileTimeToSystemTime(&stamp, &utc)
        && SystemTimeToTzSpecificLocalTime(nullptr, &utc, &local)) {
        swprintf_s(out, capacity, L"%02u:%02u:%02u",
                   static_cast<unsigned>(local.wHour),
                   static_cast<unsigned>(local.wMinute),
                   static_cast<unsigned>(local.wSecond));
    } else {
        wcscpy_s(out, capacity, L"--:--:--");
    }
}

void paint_activity(HDC dc, const Layout& layout) {
    fill(dc, layout.activity, g.brushes.log);
    outline(dc, layout.activity, g.brushes.border);

    RECT titleBar{layout.activity.left + scale(1),
                  layout.activity.top + scale(16),
                  layout.activity.left + scale(4),
                  layout.activity.top + scale(32)};
    fill(dc, titleBar, g.brushes.accent);

    RECT title{layout.activity.left + scale(17),
               layout.activity.top + scale(10),
               layout.activity.left + scale(103),
               layout.activity.top + scale(38)};
    draw_text(dc, g.fonts.bodyBold, kText, L"最近动态", title,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    wchar_t counts[96]{};
    swprintf_s(counts, ARRAYSIZE(counts), L"待发 %d · 执行 %d · 失败 %d",
               g.queueStats.queued, g.queueStats.running,
               g.queueStats.failed);
    RECT counter{title.right, title.top, layout.tabLog.left - scale(10),
                 title.bottom};
    draw_text(dc, g.fonts.smallText, kMuted, counts, counter,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                  | DT_NOPREFIX);

    auto paint_open_button = [&](const RECT& rect, const wchar_t* label,
                                 Hot hot) {
        const bool isHot = g.hot == hot;
        const bool isPressed = g.pressed == hot;
        fill(dc, rect, isPressed ? g.brushes.buttonPressed
                                 : (isHot ? g.brushes.buttonHover
                                          : g.brushes.button));
        outline(dc, rect, isHot ? g.brushes.accent : g.brushes.border);
        draw_text(dc, g.fonts.smallText, isHot ? kText : kAccent, label, rect,
                  DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    };
    paint_open_button(layout.tabLog, L"运行日志", Hot::TabLog);
    paint_open_button(layout.tabQueue, L"发送队列", Hot::TabQueue);

    RECT divider{layout.activity.left + scale(18),
                 layout.activity.top + scale(40),
                 layout.activity.right - scale(18),
                 layout.activity.top + scale(41)};
    fill(dc, divider, g.brushes.borderSoft);

    RECT latest{layout.activity.left + scale(18),
                layout.activity.top + scale(43),
                layout.activity.right - scale(18),
                layout.activity.bottom - scale(3)};
    const wchar_t* latestText =
        g.logCount > 0 ? g.logLines[g.logCount - 1] : L"暂无动态";
    draw_text(dc, g.fonts.log, g.logCount > 0 ? kTextSoft : kFaint,
              latestText, latest,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                  | DT_NOPREFIX);
}

void paint_buttons(HDC dc, const Layout& layout) {
    {
        HBRUSH background = g.brushes.accent;
        if (g.pressed == Hot::Primary) {
            background = g.brushes.accentPressed;
        } else if (g.hot == Hot::Primary) {
            background = g.brushes.accentHover;
        }
        fill(dc, layout.primary, background);

        const int left = layout.primary.left + scale(20);
        const int centerY = (layout.primary.top + layout.primary.bottom) / 2;
        POINT triangle[3] = {
            {left, centerY - scale(5)},
            {left, centerY + scale(5)},
            {left + scale(9), centerY},
        };
        HGDIOBJ previousPen = SelectObject(dc, GetStockObject(NULL_PEN));
        HGDIOBJ previousBrush = SelectObject(dc, g.brushes.ink);
        Polygon(dc, triangle, 3);
        SelectObject(dc, previousBrush);
        SelectObject(dc, previousPen);

        RECT label{layout.primary.left + scale(38), layout.primary.top,
                   layout.primary.right - scale(10), layout.primary.bottom};
        draw_text(dc, g.fonts.bodyBold, kInk, L"检查微信状态", label,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }

    {
        HBRUSH background = g.brushes.button;
        if (g.pressed == Hot::Secondary) {
            background = g.brushes.buttonPressed;
        } else if (g.hot == Hot::Secondary) {
            background = g.brushes.buttonHover;
        }
        fill(dc, layout.secondary, background);
        outline(dc, layout.secondary, g.brushes.border);

        const COLORREF color = g.hot == Hot::Secondary ? kText : kMuted;
        draw_text(dc, g.fonts.body, color, L"隐藏到托盘", layout.secondary,
                  DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }

    {
        if (g.hot == Hot::Exit || g.pressed == Hot::Exit) {
            fill(dc, layout.exit, g.brushes.button);
            outline(dc, layout.exit, g.brushes.borderSoft);
        }
        const COLORREF color = g.hot == Hot::Exit ? kText : kMuted;
        draw_text(dc, g.fonts.body, color, L"退出", layout.exit,
                  DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    }
}

void paint_footer(HDC dc, const Layout& layout) {
    const int previousExtra = SetTextCharacterExtra(dc, scale(1));
    draw_text(dc, g.fonts.hint, kFaint,
              L"F5 检查状态   ·   Esc 隐藏   ·   关闭窗口后驻留托盘",
              layout.hintLeft, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    SetTextCharacterExtra(dc, previousExtra);

    const SIZE_T privateBytes = g.privateWorkingSet
        ? g.privateWorkingSet
        : g.memory.PrivateUsage;
    wchar_t memoryText[32]{};
    format_megabytes(memoryText, ARRAYSIZE(memoryText),
                     static_cast<double>(privateBytes) / (1024.0 * 1024.0));
    wchar_t runtimeText[96]{};
    swprintf_s(runtimeText, ARRAYSIZE(runtimeText),
               L"内存 %ls MB · %lu 句柄", memoryText, g.handleCount);
    draw_text(dc, g.fonts.hint, kFaint, runtimeText, layout.hintRight,
              DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

struct HelpLayout {
    RECT title;
    RECT info;
    RECT closeButton;
    RECT refreshButton;
    RECT blocks[kHelpExampleCount];
    RECT copyButtons[kHelpExampleCount];
    RECT status;
};

HelpLayout make_help_layout(int width, int height) {
    HelpLayout layout{};
    const int pad = scale(22);
    const int buttonHeight = scale(28);
    layout.title = {pad, scale(14), width - pad - scale(176),
                    scale(14) + buttonHeight};
    layout.refreshButton = {width - pad - scale(166), scale(14),
                            width - pad - scale(86), scale(14) + buttonHeight};
    layout.closeButton = {width - pad - scale(78), scale(14), width - pad,
                          scale(14) + buttonHeight};
    layout.info = {pad, scale(54), width - pad, scale(98)};

    int top = scale(108);
    const int blockHeight = scale(88);
    for (int index = 0; index < kHelpExampleCount; ++index) {
        layout.blocks[index] = {pad, top, width - pad, top + blockHeight};
        layout.copyButtons[index] = {
            layout.blocks[index].right - scale(64), top + scale(5),
            layout.blocks[index].right - scale(10), top + scale(26)};
        top += blockHeight + scale(8);
    }
    layout.status = {pad, top + scale(2), width - pad, top + scale(24)};
    (void)height;
    return layout;
}

std::wstring json_escape(const std::wstring& source) {
    std::wstring escaped;
    escaped.reserve(source.size() + 8);
    for (const wchar_t character : source) {
        if (character == L'\\' || character == L'"') {
            escaped.push_back(L'\\');
        }
        escaped.push_back(character);
    }
    return escaped;
}

bool regular_file_exists(const std::wstring& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES
        && (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

// Empty when the path has no parent component.
std::wstring parent_directory(const std::wstring& path) {
    const size_t slash = path.find_last_of(L'\\');
    if (slash == std::wstring::npos || slash == 0) {
        return std::wstring();
    }
    return path.substr(0, slash);
}

// The script ships either next to the exe (release layout) or one level up
// (<project>\build\SuperLanguage.exe in the source tree).
std::wstring build_mcp_client_config() {
    wchar_t executable[MAX_PATH]{};
    const DWORD length = GetModuleFileNameW(nullptr, executable,
                                            ARRAYSIZE(executable));
    std::wstring exe_directory;
    if (length > 0 && length < ARRAYSIZE(executable)) {
        exe_directory = parent_directory(executable);
    }

    std::wstring script;
    if (!exe_directory.empty()) {
        const std::wstring candidates[] = {
            exe_directory + L"\\mcp\\supertime_mcp.py",
            parent_directory(exe_directory) + L"\\mcp\\supertime_mcp.py",
        };
        for (const std::wstring& candidate : candidates) {
            if (candidate.front() != L'\\' && regular_file_exists(candidate)) {
                script = candidate;
                break;
            }
        }
    }
    if (script.empty()) {
        script = L"<未找到 supertime_mcp.py，请填写 mcp\\supertime_mcp.py 的完整路径>";
    }
    const std::wstring config_directory = exe_directory.empty()
        ? std::wstring(L"<SuperLanguage.exe 所在目录>")
        : exe_directory;

    return L"{\"mcpServers\":{\"supertime\":{\"command\":\"python\","
           L"\"args\":[\"" + json_escape(script) + L"\"],"
           L"\"env\":{\"SUPERTIME_CONFIG_DIR\":\""
        + json_escape(config_directory) + L"\"}}}}";
}

void build_help_examples() {
    const std::wstring placeholder = L"http://127.0.0.1:<端口>/webhook/<令牌>";
    const std::wstring shown = g.apiRunning ? webhook_url(true) : placeholder;
    const std::wstring full = g.apiRunning ? webhook_url(false) : placeholder;

    auto set_webhook_block = [&](int index, const wchar_t* title,
                                 const std::wstring& prefix,
                                 const std::wstring& suffix) {
        wcscpy_s(g.helpTitles[index], ARRAYSIZE(g.helpTitles[index]), title);
        g.helpBodies[index] = prefix + shown + suffix;
        g.helpCopies[index] = prefix + full + suffix;
    };

    set_webhook_block(
        0, L"Webhook 地址 · 复制后填入外部平台（无需 Authorization 头）", L"",
        L"\n"
        L"POST JSON：{\"target\":\"文件传输助手\","
        L"\"message\":\"你好\"}\n"
        L"GET 同一地址返回包含 ok:true 的 JSON，可用于连通性校验");
    // Block 0 copies only the Webhook URL, never the sample payload, so it can
    // be pasted straight into an external platform.
    g.helpCopies[0] = full;

    set_webhook_block(
        1, L"健康检查 / 连通性校验 · GET Webhook 地址", L"curl ",
        L"\n"
        L"→ {\"ok\":true,\"service\":\"supertime\","
        L"\"webhook\":true,\"version\":\"" FEATHER_VERSION_STRING_W
        L"\",\"api\":" + std::to_wstring(FEATHER_API_REVISION) + L"}");

    set_webhook_block(
        2, L"发送消息 · POST Webhook 地址", L"curl -X POST ",
        L" ^\n"
        L"  -H \"Content-Type:application/json\" ^\n"
        L"  -d \"{\\\"target\\\":\\\"文件传输助手\\\","
        L"\\\"message\\\":\\\"你好\\\"}\"");

    set_webhook_block(
        3, L"发送附件 · POST Webhook 地址", L"curl -X POST ",
        L" ^\n"
        L"  -H \"Content-Type:application/json\" ^\n"
        L"  -d \"{\\\"target\\\":\\\"文件传输助手\\\","
        L"\\\"attachments\\\":\\\"C:\\\\notes.txt;"
        L"C:\\\\photo.png\\\"}\"");

    set_webhook_block(
        4, L"@ 群成员 · 输入 @、成员名并回车选择",
        L"简化链路：输入 @，等待 200ms；输入成员名（逐字 100ms），"
        L"等待 200ms；回车，等待 200ms；选择器关闭后按空格/换行"
        L"分隔并写入正文。成员选择器未出现则失败。\n"
        L"curl -X POST ",
        L" -H \"Content-Type:application/json\"\n"
        L"  -d \"{\\\"target\\\":\\\"群名\\\",\\\"message\\\":"
        L"\\\"你好\\\",\\\"mention\\\":\\\"成员名\\\","
        L"\\\"mention_separator\\\":\\\"newline\\\"}\"");

    set_webhook_block(
        5, L"查询任务 · GET Webhook 地址/jobs/{id} · ID 来自 POST 响应",
        L"curl ",
        L"/jobs/<任务ID>\n"
        L"200 {\"ok\":true,\"id\":\"...\","
        L"\"state\":\"succeeded\",...}");

    const std::wstring mcp_config = build_mcp_client_config();
    wcscpy_s(g.helpTitles[6], ARRAYSIZE(g.helpTitles[6]),
             L"MCP 调用 · stdio 配置 / send_message / wait_job（job_id）");
    g.helpBodies[6] = mcp_config
        + L"\n"
          L"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\","
          L"\"params\":{\"name\":\"send_message\",\"arguments\":"
          L"{\"target\":\"文件传输助手\",\"message\":\"你好\"}}}\n"
          L"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\","
          L"\"params\":{\"name\":\"wait_job\",\"arguments\":"
          L"{\"job_id\":\"<任务ID>\",\"timeout_seconds\":30}}}";
    g.helpCopies[6] = mcp_config;
}

int split_help_lines(const wchar_t* body,
                     wchar_t lines[kHelpMaxLines][kHelpLineChars]) {
    int count = 0;
    const wchar_t* cursor = body;
    while (cursor && *cursor && count < kHelpMaxLines) {
        const wchar_t* end = wcschr(cursor, L'\n');
        const size_t length = end ? static_cast<size_t>(end - cursor)
                                  : wcslen(cursor);
        wcsncpy_s(lines[count], kHelpLineChars, cursor,
                  length < kHelpLineChars - 1 ? length : kHelpLineChars - 1);
        ++count;
        if (!end) {
            break;
        }
        cursor = end + 1;
    }
    return count;
}

bool copy_text_to_clipboard(HWND owner, const wchar_t* text) {
    if (!OpenClipboard(owner)) {
        return false;
    }
    bool copied = false;
    const SIZE_T bytes = (wcslen(text) + 1) * sizeof(wchar_t);
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (memory) {
        void* block = GlobalLock(memory);
        if (block) {
            CopyMemory(block, text, bytes);
            GlobalUnlock(memory);
            EmptyClipboard();
            copied = SetClipboardData(CF_UNICODETEXT, memory) != nullptr;
        }
        if (!copied) {
            GlobalFree(memory);
        }
    }
    CloseClipboard();
    return copied;
}

void copy_api_token_to_clipboard() {
    if (!g.apiRunning || !g.apiToken[0]) {
        add_log(L"本地接口未开启 · 没有可复制的令牌");
        return;
    }

    wchar_t token[33]{};
    for (int index = 0; index < 32 && g.apiToken[index]; ++index) {
        token[index] = static_cast<wchar_t>(
            static_cast<unsigned char>(g.apiToken[index]));
    }
    if (copy_text_to_clipboard(g.hwnd, token)) {
        add_log(L"本地接口令牌已复制 · 请妥善保管");
    } else {
        add_log(L"复制令牌失败 · 剪贴板当前被其他程序占用");
    }
}

void paint_help_button(HDC dc, const RECT& rect, const wchar_t* label,
                       bool hot, bool pressed) {
    HBRUSH background = g.brushes.button;
    if (pressed) {
        background = g.brushes.buttonPressed;
    } else if (hot) {
        background = g.brushes.buttonHover;
    }
    fill(dc, rect, background);
    outline(dc, rect, hot ? g.brushes.accent : g.brushes.border);
    draw_text(dc, g.fonts.smallText, hot ? kText : kAccent, label, rect,
              DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
}

void paint_help(HWND hwnd) {
    PAINTSTRUCT paintStruct{};
    HDC target = BeginPaint(hwnd, &paintStruct);

    RECT client{};
    GetClientRect(hwnd, &client);
    const int width = client.right - client.left;
    const int height = client.bottom - client.top;
    if (width <= 0 || height <= 0) {
        EndPaint(hwnd, &paintStruct);
        return;
    }

    HDC buffer = CreateCompatibleDC(target);
    HBITMAP bitmap = CreateCompatibleBitmap(target, width, height);
    HGDIOBJ previousBitmap = SelectObject(buffer, bitmap);

    TRIVERTEX vertices[2]{};
    vertices[0].x = 0;
    vertices[0].y = 0;
    vertices[0].Red = 0x0E0E;
    vertices[0].Green = 0x1313;
    vertices[0].Blue = 0x1919;
    vertices[0].Alpha = 0xFF00;
    vertices[1].x = width;
    vertices[1].y = height;
    vertices[1].Red = 0x0808;
    vertices[1].Green = 0x0B0B;
    vertices[1].Blue = 0x0F0F;
    vertices[1].Alpha = 0xFF00;
    GRADIENT_RECT gradient{0, 1};
    if (!GradientFill(buffer, vertices, 2, &gradient, 1,
                      GRADIENT_FILL_RECT_V)) {
        fill(buffer, client, g.brushes.background);
    }

    const HelpLayout layout = make_help_layout(width, height);
    draw_text(buffer, g.fonts.title, kText, kHelpTitle, layout.title,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    paint_help_button(buffer, layout.refreshButton, L"刷新示例",
                      g.helpHotIndex == -3, false);
    paint_help_button(buffer, layout.closeButton, L"关闭",
                      g.helpHotIndex == -2, false);

    fill(buffer, layout.info, g.brushes.cardAlt);
    outline(buffer, layout.info, g.brushes.border);
    wchar_t info[256]{};
    if (g.apiRunning) {
        wchar_t token[48]{};
        format_masked_token(token, ARRAYSIZE(token));
        _snwprintf_s(info, ARRAYSIZE(info), _TRUNCATE,
                     L"当前监听 %ls:%u · 令牌 %ls · Webhook 直连 + MCP stdio",
                     g.apiListen, static_cast<unsigned>(g.apiPort), token);
    } else {
        wcscpy_s(info, ARRAYSIZE(info),
                 L"HTTP API 未开启 · 先在主界面开启，再点“刷新示例”"
                 L"（Webhook/MCP 均需 API）");
    }
    RECT infoText{layout.info.left + scale(14), layout.info.top,
                  layout.info.right - scale(14), layout.info.bottom};
    draw_text(buffer, g.fonts.smallText, g.apiRunning ? kTextSoft : kAmber,
              info, infoText,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                  | DT_NOPREFIX);

    for (int index = 0; index < kHelpExampleCount; ++index) {
        const RECT& block = layout.blocks[index];
        fill(buffer, block, g.brushes.card);
        outline(buffer, block, g.brushes.border);

        RECT title{block.left + scale(14), block.top + scale(4),
                   layout.copyButtons[index].left - scale(8),
                   block.top + scale(28)};
        draw_text(buffer, g.fonts.bodyBold, kText, g.helpTitles[index], title,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                      | DT_NOPREFIX);
        paint_help_button(buffer, layout.copyButtons[index],
                          g.helpCopiedIndex == index ? L"已复制" : L"复制",
                          g.helpHotIndex == index, false);

        wchar_t lines[kHelpMaxLines][kHelpLineChars]{};
        const int lineCount =
            split_help_lines(g.helpBodies[index].c_str(), lines);
        int top = block.top + scale(30);
        for (int line = 0; line < lineCount; ++line) {
            RECT code{block.left + scale(14), top, block.right - scale(14),
                      top + scale(16)};
            draw_text(buffer, g.fonts.code, kTextSoft, lines[line], code,
                      DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                          | DT_NOPREFIX);
            top += scale(17);
        }
    }

    draw_text(buffer, g.fonts.smallText,
              g.helpCopiedIndex >= 0 ? kAccent : kFaint,
              g.helpStatus[0] ? g.helpStatus
                              : L"提示：queued 仅表示入队；用 wait_job 查询，勿自动重发",
              layout.status,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                  | DT_NOPREFIX);

    BitBlt(target, 0, 0, width, height, buffer, 0, 0, SRCCOPY);
    SelectObject(buffer, previousBitmap);
    DeleteObject(bitmap);
    DeleteDC(buffer);
    EndPaint(hwnd, &paintStruct);
}

int help_hit_test(HWND hwnd, POINT point) {
    RECT client{};
    GetClientRect(hwnd, &client);
    const HelpLayout layout = make_help_layout(client.right, client.bottom);
    if (PtInRect(&layout.closeButton, point)) {
        return -2;
    }
    if (PtInRect(&layout.refreshButton, point)) {
        return -3;
    }
    for (int index = 0; index < kHelpExampleCount; ++index) {
        if (PtInRect(&layout.copyButtons[index], point)) {
            return index;
        }
    }
    return -1;
}

LRESULT CALLBACK help_window_proc(HWND hwnd, UINT message, WPARAM wParam,
                                  LPARAM lParam) {
    LRESULT modal_result = 0;
    if (handle_modal_loop_message(hwnd, message, wParam, lParam,
                                  &modal_result)) {
        return modal_result;
    }
    switch (message) {
    case WM_PAINT:
        paint_help(hwnd);
        return 0;

    case WM_ERASEBKGND:
        return 1;

    case WM_MOUSEMOVE: {
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        const int hit = help_hit_test(hwnd, point);
        if (hit != g.helpHotIndex) {
            g.helpHotIndex = hit;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        if (!g.helpTrackingMouse) {
            g.helpTrackingMouse = true;
            TRACKMOUSEEVENT track{};
            track.cbSize = sizeof(track);
            track.dwFlags = TME_LEAVE;
            track.hwndTrack = hwnd;
            TrackMouseEvent(&track);
        }
        SetCursor(LoadCursorW(nullptr, hit == -1 ? IDC_ARROW : IDC_HAND));
        return 0;
    }

    case WM_MOUSELEAVE:
        g.helpTrackingMouse = false;
        if (g.helpHotIndex != -1) {
            g.helpHotIndex = -1;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;

    case WM_LBUTTONUP: {
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        const int hit = help_hit_test(hwnd, point);
        if (hit == -2) {
            DestroyWindow(hwnd);
            return 0;
        }
        if (hit == -3) {
            build_help_examples();
            g.helpCopiedIndex = -1;
            g.helpStatus[0] = L'\0';
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        }
        if (hit >= 0) {
            if (copy_text_to_clipboard(hwnd, g.helpCopies[hit].c_str())) {
                g.helpCopiedIndex = hit;
                _snwprintf_s(g.helpStatus, ARRAYSIZE(g.helpStatus), _TRUNCATE,
                             L"已复制到剪贴板 · %s", g.helpTitles[hit]);
            } else {
                g.helpCopiedIndex = -1;
                wcscpy_s(g.helpStatus, ARRAYSIZE(g.helpStatus),
                         L"复制失败 · 剪贴板当前被其他程序占用");
            }
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        }
        return 0;
    }

    case WM_KEYDOWN:
        if (wParam == VK_ESCAPE) {
            DestroyWindow(hwnd);
            return 0;
        }
        break;

    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        if (g.helpWindow == hwnd) {
            g.helpWindow = nullptr;
        }
        return 0;

    default:
        break;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

void refresh_help_window() {
    build_help_examples();
    if (g.helpWindow && IsWindow(g.helpWindow)) {
        g.helpCopiedIndex = -1;
        g.helpStatus[0] = L'\0';
        InvalidateRect(g.helpWindow, nullptr, FALSE);
    }
}

void open_help_window() {
    if (g.helpWindow && IsWindow(g.helpWindow)) {
        ShowWindow(g.helpWindow, SW_SHOWNORMAL);
        feather::automation::force_foreground(g.helpWindow);
        return;
    }
    build_help_examples();
    g.helpCopiedIndex = -1;
    g.helpStatus[0] = L'\0';

    RECT frame{0, 0, scale(kHelpClientWidth), scale(kHelpClientHeight)};
    AdjustWindowRectExForDpi(&frame, kHelpStyle, FALSE, 0, g.dpi);
    RECT owner{};
    GetWindowRect(g.hwnd, &owner);
    const int width = frame.right - frame.left;
    const int height = frame.bottom - frame.top;
    const int x = owner.left + ((owner.right - owner.left) - width) / 2;
    const int y = owner.top + ((owner.bottom - owner.top) - height) / 2;

    HWND hwnd = CreateWindowExW(
        WS_EX_DLGMODALFRAME, kHelpClass,
        L"SuperLanguage · API / Webhook / MCP 调用示例",
        kHelpStyle, x < 0 ? 0 : x, y < 0 ? 0 : y, width, height, g.hwnd,
        nullptr, g.instance, nullptr);
    if (!hwnd) {
        add_log(L"无法打开 API 与 MCP 示例面板");
        return;
    }
    g.helpWindow = hwnd;
    ShowWindow(hwnd, SW_SHOWNORMAL);
    feather::automation::force_foreground(hwnd);
}

// ---------------------------------------------------------------------------
// Standalone run-log / send-queue detail windows. The main window only
// keeps the two open buttons, the queue summary and a one-line hint.
// ---------------------------------------------------------------------------
void paint_detail_gradient(HDC dc, int width, int height) {
    TRIVERTEX vertices[2]{};
    vertices[0].x = 0;
    vertices[0].y = 0;
    vertices[0].Red = 0x0E0E;
    vertices[0].Green = 0x1313;
    vertices[0].Blue = 0x1919;
    vertices[0].Alpha = 0xFF00;
    vertices[1].x = width;
    vertices[1].y = height;
    vertices[1].Red = 0x0808;
    vertices[1].Green = 0x0B0B;
    vertices[1].Blue = 0x0F0F;
    vertices[1].Alpha = 0xFF00;
    GRADIENT_RECT gradient{0, 1};
    RECT client{0, 0, width, height};
    if (!GradientFill(dc, vertices, 2, &gradient, 1, GRADIENT_FILL_RECT_V)) {
        fill(dc, client, g.brushes.background);
    }
}

struct LogLayout {
    RECT title;
    RECT clearButton;
    RECT closeButton;
    RECT subtitle;
    RECT divider;
    RECT rows;
};

LogLayout make_log_layout(int width, int height) {
    LogLayout layout{};
    const int pad = scale(20);
    const int buttonHeight = scale(26);
    layout.title = {pad, scale(12), width - pad - scale(150),
                    scale(12) + buttonHeight};
    layout.closeButton = {width - pad - scale(64), scale(12), width - pad,
                          scale(12) + buttonHeight};
    layout.clearButton = {layout.closeButton.left - scale(74), scale(12),
                          layout.closeButton.left - scale(10),
                          scale(12) + buttonHeight};
    layout.subtitle = {pad, scale(44), width - pad, scale(64)};
    layout.divider = {pad, scale(68), width - pad, scale(69)};
    layout.rows = {pad, scale(76), width - pad, height - scale(14)};
    return layout;
}

struct QueueLayout {
    RECT title;
    RECT refreshButton;
    RECT closeButton;
    RECT subtitle;
    RECT header;
    RECT divider;
    RECT rows;
};

QueueLayout make_queue_layout(int width, int height) {
    QueueLayout layout{};
    const int pad = scale(20);
    const int buttonHeight = scale(26);
    layout.title = {pad, scale(12), width - pad - scale(150),
                    scale(12) + buttonHeight};
    layout.closeButton = {width - pad - scale(64), scale(12), width - pad,
                          scale(12) + buttonHeight};
    layout.refreshButton = {layout.closeButton.left - scale(74), scale(12),
                            layout.closeButton.left - scale(10),
                            scale(12) + buttonHeight};
    layout.subtitle = {pad, scale(44), width - pad, scale(64)};
    layout.header = {pad, scale(71), width - pad, scale(89)};
    layout.divider = {pad, scale(92), width - pad, scale(93)};
    layout.rows = {pad, scale(99), width - pad, height - scale(14)};
    return layout;
}

void make_queue_columns(const RECT& area, RECT columns[7]) {
    const int gap = scale(6);
    const int idWidth = scale(56);
    const int typeWidth = scale(68);
    const int sourceWidth = scale(44);
    const int stateWidth = scale(56);
    const int errorWidth = scale(54);
    const int timeWidth = scale(64);
    const int tail = stateWidth + gap + errorWidth + gap + timeWidth;
    int x = area.left;
    columns[0] = {x, area.top, x + idWidth, area.bottom};
    x += idWidth + gap;
    columns[1] = {x, area.top, x + typeWidth, area.bottom};
    x += typeWidth + gap;
    columns[2] = {x, area.top, x + sourceWidth, area.bottom};
    x += sourceWidth + gap;
    columns[3] = {x, area.top, area.right - tail, area.bottom};
    x = area.right - tail;
    columns[4] = {x, area.top, x + stateWidth, area.bottom};
    x += stateWidth + gap;
    columns[5] = {x, area.top, x + errorWidth, area.bottom};
    x += errorWidth + gap;
    columns[6] = {x, area.top, x + timeWidth, area.bottom};
}

COLORREF queue_state_color(feather::queue::JobState state) {
    switch (state) {
    case feather::queue::JobState::Failed:
        return kRed;
    case feather::queue::JobState::Running:
        return kAccent;
    case feather::queue::JobState::Queued:
        return kTextSoft;
    default:
        return kFaint;
    }
}

void update_vscroll(HWND hwnd, int totalRows, int visibleRows, int topRow) {
    SCROLLINFO info{};
    info.cbSize = sizeof(info);
    info.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
    info.nMin = 0;
    info.nMax = totalRows > 0 ? totalRows - 1 : 0;
    info.nPage = static_cast<UINT>(visibleRows > 0 ? visibleRows : 1);
    info.nPos = topRow;
    SetScrollInfo(hwnd, SB_VERT, &info, TRUE);
}

int detail_max_top(int totalRows, int visibleRows) {
    return totalRows > visibleRows ? totalRows - visibleRows : 0;
}

void clamp_detail_top(int totalRows, int visibleRows, int* topRow) {
    const int maxTop = detail_max_top(totalRows, visibleRows);
    if (*topRow > maxTop) {
        *topRow = maxTop;
    }
    if (*topRow < 0) {
        *topRow = 0;
    }
}

void refresh_detail_queue() {
    g.detailQueueRowCount = feather::queue::view(
        g.detailQueueRows, ARRAYSIZE(g.detailQueueRows), &g.queueStats);
}

int log_visible_rows(HWND hwnd) {
    RECT client{};
    GetClientRect(hwnd, &client);
    const int rowHeight = scale(kDetailRowHeight);
    const LogLayout layout = make_log_layout(client.right, client.bottom);
    const int visible = (layout.rows.bottom - layout.rows.top) / rowHeight;
    return visible > 0 ? visible : 1;
}

void paint_log_window(HWND hwnd) {
    PAINTSTRUCT paintStruct{};
    HDC target = BeginPaint(hwnd, &paintStruct);

    RECT client{};
    GetClientRect(hwnd, &client);
    const int width = client.right - client.left;
    const int height = client.bottom - client.top;
    if (width <= 0 || height <= 0) {
        EndPaint(hwnd, &paintStruct);
        return;
    }

    const int rowHeight = scale(kDetailRowHeight);
    const int visible = log_visible_rows(hwnd);
    const int maxTop = detail_max_top(g.logCount, visible);
    if (g.logFollow) {
        g.logTopLine = maxTop;
    } else if (g.logTopLine > maxTop) {
        g.logTopLine = maxTop;
    }
    if (g.logTopLine < 0) {
        g.logTopLine = 0;
    }
    update_vscroll(hwnd, g.logCount, visible, g.logTopLine);

    HDC buffer = CreateCompatibleDC(target);
    HBITMAP bitmap = CreateCompatibleBitmap(target, width, height);
    HGDIOBJ previousBitmap = SelectObject(buffer, bitmap);
    paint_detail_gradient(buffer, width, height);

    const LogLayout layout = make_log_layout(width, height);
    draw_text(buffer, g.fonts.title, kText, L"运行日志", layout.title,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    paint_help_button(buffer, layout.clearButton, L"清空",
                      g.logHotIndex == 0, false);
    paint_help_button(buffer, layout.closeButton, L"关闭",
                      g.logHotIndex == 1, false);

    wchar_t subtitle[64]{};
    swprintf_s(subtitle, ARRAYSIZE(subtitle), L"共 %d 行 · 最新在下",
               g.logCount);
    draw_text(buffer, g.fonts.smallText, kMuted, subtitle, layout.subtitle,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    fill(buffer, layout.divider, g.brushes.borderSoft);

    if (g.logCount == 0) {
        RECT empty{layout.rows.left, layout.rows.top, layout.rows.right,
                   layout.rows.top + rowHeight};
        draw_text(buffer, g.fonts.log, kFaint, L"暂无日志", empty,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    } else {
        const int last = g.logTopLine + visible < g.logCount
                             ? g.logTopLine + visible
                             : g.logCount;
        int top = layout.rows.top;
        for (int index = g.logTopLine; index < last; ++index) {
            RECT line{layout.rows.left, top, layout.rows.right,
                      top + rowHeight};
            const COLORREF color = index == g.logCount - 1 ? kTextSoft : kFaint;
            draw_text(buffer, g.fonts.log, color, g.logLines[index], line,
                      DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                          | DT_NOPREFIX);
            top += rowHeight;
        }
    }

    BitBlt(target, 0, 0, width, height, buffer, 0, 0, SRCCOPY);
    SelectObject(buffer, previousBitmap);
    DeleteObject(bitmap);
    DeleteDC(buffer);
    EndPaint(hwnd, &paintStruct);
}

int log_hit_test(HWND hwnd, POINT point) {
    RECT client{};
    GetClientRect(hwnd, &client);
    const LogLayout layout = make_log_layout(client.right, client.bottom);
    if (PtInRect(&layout.closeButton, point)) {
        return 1;
    }
    if (PtInRect(&layout.clearButton, point)) {
        return 0;
    }
    return -1;
}

void scroll_log_by(HWND hwnd, int delta) {
    const int visible = log_visible_rows(hwnd);
    g.logTopLine += delta;
    clamp_detail_top(g.logCount, visible, &g.logTopLine);
    g.logFollow = g.logTopLine >= detail_max_top(g.logCount, visible);
    update_vscroll(hwnd, g.logCount, visible, g.logTopLine);
    InvalidateRect(hwnd, nullptr, FALSE);
}

void scroll_log_to(HWND hwnd, int position) {
    const int visible = log_visible_rows(hwnd);
    g.logTopLine = position;
    clamp_detail_top(g.logCount, visible, &g.logTopLine);
    g.logFollow = g.logTopLine >= detail_max_top(g.logCount, visible);
    update_vscroll(hwnd, g.logCount, visible, g.logTopLine);
    InvalidateRect(hwnd, nullptr, FALSE);
}

void handle_log_vscroll(HWND hwnd, WPARAM wParam) {
    switch (LOWORD(wParam)) {
    case SB_LINEUP:
        scroll_log_by(hwnd, -1);
        break;
    case SB_LINEDOWN:
        scroll_log_by(hwnd, 1);
        break;
    case SB_PAGEUP:
        scroll_log_by(hwnd, -log_visible_rows(hwnd));
        break;
    case SB_PAGEDOWN:
        scroll_log_by(hwnd, log_visible_rows(hwnd));
        break;
    case SB_THUMBTRACK:
    case SB_THUMBPOSITION: {
        SCROLLINFO info{};
        info.cbSize = sizeof(info);
        info.fMask = SIF_TRACKPOS;
        GetScrollInfo(hwnd, SB_VERT, &info);
        scroll_log_to(hwnd, static_cast<int>(info.nTrackPos));
        break;
    }
    case SB_TOP:
        scroll_log_to(hwnd, 0);
        break;
    case SB_BOTTOM:
        scroll_log_to(hwnd, g.logCount);
        break;
    default:
        break;
    }
}

LRESULT CALLBACK log_window_proc(HWND hwnd, UINT message, WPARAM wParam,
                                 LPARAM lParam) {
    LRESULT modal_result = 0;
    if (handle_modal_loop_message(hwnd, message, wParam, lParam,
                                  &modal_result)) {
        return modal_result;
    }
    switch (message) {
    case WM_PAINT:
        paint_log_window(hwnd);
        return 0;

    case WM_ERASEBKGND:
        return 1;

    case WM_MOUSEMOVE: {
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        const int hit = log_hit_test(hwnd, point);
        if (hit != g.logHotIndex) {
            g.logHotIndex = hit;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        if (!g.logTrackingMouse) {
            g.logTrackingMouse = true;
            TRACKMOUSEEVENT track{};
            track.cbSize = sizeof(track);
            track.dwFlags = TME_LEAVE;
            track.hwndTrack = hwnd;
            TrackMouseEvent(&track);
        }
        SetCursor(LoadCursorW(nullptr, hit == -1 ? IDC_ARROW : IDC_HAND));
        return 0;
    }

    case WM_MOUSELEAVE:
        g.logTrackingMouse = false;
        if (g.logHotIndex != -1) {
            g.logHotIndex = -1;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;

    case WM_LBUTTONDOWN:
        SetFocus(hwnd);
        return 0;

    case WM_LBUTTONUP: {
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        const int hit = log_hit_test(hwnd, point);
        if (hit == 1) {
            DestroyWindow(hwnd);
            return 0;
        }
        if (hit == 0) {
            g.logCount = 0;
            g.logTopLine = 0;
            g.logFollow = true;
            update_vscroll(hwnd, 0, log_visible_rows(hwnd), 0);
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        }
        return 0;
    }

    case WM_MOUSEWHEEL: {
        const int steps = GET_WHEEL_DELTA_WPARAM(wParam) / WHEEL_DELTA;
        scroll_log_by(hwnd, -steps * 3);
        return 0;
    }

    case WM_VSCROLL:
        handle_log_vscroll(hwnd, wParam);
        return 0;

    case WM_KEYDOWN:
        switch (wParam) {
        case VK_ESCAPE:
            DestroyWindow(hwnd);
            return 0;
        case VK_PRIOR:
            scroll_log_by(hwnd, -log_visible_rows(hwnd));
            return 0;
        case VK_NEXT:
            scroll_log_by(hwnd, log_visible_rows(hwnd));
            return 0;
        case VK_HOME:
            scroll_log_to(hwnd, 0);
            return 0;
        case VK_END:
            scroll_log_to(hwnd, g.logCount);
            return 0;
        default:
            break;
        }
        break;

    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        if (g.logWindow == hwnd) {
            g.logWindow = nullptr;
        }
        return 0;

    default:
        break;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

void open_log_window() {
    if (g.logWindow && IsWindow(g.logWindow)) {
        ShowWindow(g.logWindow, SW_SHOWNORMAL);
        feather::automation::force_foreground(g.logWindow);
        return;
    }
    g.logHotIndex = -1;
    g.logTrackingMouse = false;
    g.logFollow = true;

    RECT frame{0, 0, scale(kLogClientWidth), scale(kLogClientHeight)};
    AdjustWindowRectExForDpi(&frame, kDetailStyle, FALSE, 0, g.dpi);
    // AdjustWindowRectExForDpi does not reserve the non-client scroll bar.
    frame.right += GetSystemMetricsForDpi(SM_CXVSCROLL, g.dpi);
    RECT owner{};
    GetWindowRect(g.hwnd, &owner);
    const int width = frame.right - frame.left;
    const int height = frame.bottom - frame.top;
    const int x = owner.left + ((owner.right - owner.left) - width) / 2;
    const int y = owner.top + ((owner.bottom - owner.top) - height) / 2;

    HWND hwnd = CreateWindowExW(
        WS_EX_DLGMODALFRAME, kLogClass, kLogTitle, kDetailStyle,
        x < 0 ? 0 : x, y < 0 ? 0 : y, width, height, g.hwnd, nullptr,
        g.instance, nullptr);
    if (!hwnd) {
        add_log(L"无法打开运行日志窗口");
        return;
    }
    g.logWindow = hwnd;
    ShowWindow(hwnd, SW_SHOWNORMAL);
    feather::automation::force_foreground(hwnd);
}

int queue_visible_rows(HWND hwnd) {
    RECT client{};
    GetClientRect(hwnd, &client);
    const int rowHeight = scale(kQueueRowHeight);
    const QueueLayout layout = make_queue_layout(client.right, client.bottom);
    const int visible = (layout.rows.bottom - layout.rows.top) / rowHeight;
    return visible > 0 ? visible : 1;
}

void paint_queue_window(HWND hwnd) {
    PAINTSTRUCT paintStruct{};
    HDC target = BeginPaint(hwnd, &paintStruct);

    RECT client{};
    GetClientRect(hwnd, &client);
    const int width = client.right - client.left;
    const int height = client.bottom - client.top;
    if (width <= 0 || height <= 0) {
        EndPaint(hwnd, &paintStruct);
        return;
    }

    const int rowHeight = scale(kQueueRowHeight);
    const int visible = queue_visible_rows(hwnd);
    clamp_detail_top(g.detailQueueRowCount, visible, &g.queueTopRow);
    update_vscroll(hwnd, g.detailQueueRowCount, visible, g.queueTopRow);

    HDC buffer = CreateCompatibleDC(target);
    HBITMAP bitmap = CreateCompatibleBitmap(target, width, height);
    HGDIOBJ previousBitmap = SelectObject(buffer, bitmap);
    paint_detail_gradient(buffer, width, height);

    const QueueLayout layout = make_queue_layout(width, height);
    draw_text(buffer, g.fonts.title, kText, L"发送队列", layout.title,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    paint_help_button(buffer, layout.refreshButton, L"刷新",
                      g.queueHotIndex == 0, false);
    paint_help_button(buffer, layout.closeButton, L"关闭",
                      g.queueHotIndex == 1, false);

    wchar_t subtitle[96]{};
    swprintf_s(subtitle, ARRAYSIZE(subtitle),
               L"待发送 %d · 执行中 %d · 已完成 %d · 失败 %d",
               g.queueStats.queued, g.queueStats.running,
               g.queueStats.succeeded, g.queueStats.failed);
    draw_text(buffer, g.fonts.smallText, kMuted, subtitle, layout.subtitle,
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);

    RECT headerCells[7]{};
    make_queue_columns(layout.header, headerCells);
    draw_text(buffer, g.fonts.smallText, kMuted, L"ID", headerCells[0],
              DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(buffer, g.fonts.smallText, kMuted, L"类型", headerCells[1],
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(buffer, g.fonts.smallText, kMuted, L"来源", headerCells[2],
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(buffer, g.fonts.smallText, kMuted, L"对象", headerCells[3],
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                  | DT_NOPREFIX);
    draw_text(buffer, g.fonts.smallText, kMuted, L"状态", headerCells[4],
              DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(buffer, g.fonts.smallText, kMuted, L"错误", headerCells[5],
              DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    draw_text(buffer, g.fonts.smallText, kMuted, L"时间", headerCells[6],
              DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    fill(buffer, layout.divider, g.brushes.borderSoft);

    if (g.detailQueueRowCount == 0) {
        RECT empty{layout.rows.left, layout.rows.top, layout.rows.right,
                   layout.rows.top + rowHeight};
        draw_text(buffer, g.fonts.log, kFaint,
                  L"队列为空 · 界面与 API 任务都会先入队再消费", empty,
                  DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
    } else {
        const int last = g.queueTopRow + visible < g.detailQueueRowCount
                             ? g.queueTopRow + visible
                             : g.detailQueueRowCount;
        int top = layout.rows.top;
        for (int index = g.queueTopRow; index < last; ++index) {
            const feather::queue::Job& job = g.detailQueueRows[index];
            const COLORREF color = queue_state_color(job.state);
            RECT rowArea{layout.rows.left, top, layout.rows.right,
                         top + rowHeight};
            RECT cells[7]{};
            make_queue_columns(rowArea, cells);

            wchar_t idText[24]{};
            swprintf_s(idText, ARRAYSIZE(idText), L"#%lld", job.row_id);
            draw_text(buffer, g.fonts.log, color, idText, cells[0],
                      DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            draw_text(buffer, g.fonts.log, color, job_type_label(job.type),
                      cells[1],
                      DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            draw_text(buffer, g.fonts.log, color, job.source, cells[2],
                      DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            draw_text(buffer, g.fonts.log, color, job.target, cells[3],
                      DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS
                          | DT_NOPREFIX);
            draw_text(buffer, g.fonts.log, color, job_state_label(job.state),
                      cells[4],
                      DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            wchar_t errorText[16]{};
            swprintf_s(errorText, ARRAYSIZE(errorText), L"%lu", job.error);
            draw_text(buffer, g.fonts.log, color, errorText, cells[5],
                      DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            wchar_t stamp[16]{};
            format_job_time(job.created_at, stamp, ARRAYSIZE(stamp));
            draw_text(buffer, g.fonts.log, kFaint, stamp, cells[6],
                      DT_RIGHT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
            top += rowHeight;
        }
    }

    BitBlt(target, 0, 0, width, height, buffer, 0, 0, SRCCOPY);
    SelectObject(buffer, previousBitmap);
    DeleteObject(bitmap);
    DeleteDC(buffer);
    EndPaint(hwnd, &paintStruct);
}

int queue_hit_test(HWND hwnd, POINT point) {
    RECT client{};
    GetClientRect(hwnd, &client);
    const QueueLayout layout = make_queue_layout(client.right, client.bottom);
    if (PtInRect(&layout.closeButton, point)) {
        return 1;
    }
    if (PtInRect(&layout.refreshButton, point)) {
        return 0;
    }
    return -1;
}

void scroll_queue_by(HWND hwnd, int delta) {
    const int visible = queue_visible_rows(hwnd);
    g.queueTopRow += delta;
    clamp_detail_top(g.detailQueueRowCount, visible, &g.queueTopRow);
    update_vscroll(hwnd, g.detailQueueRowCount, visible, g.queueTopRow);
    InvalidateRect(hwnd, nullptr, FALSE);
}

void scroll_queue_to(HWND hwnd, int position) {
    const int visible = queue_visible_rows(hwnd);
    g.queueTopRow = position;
    clamp_detail_top(g.detailQueueRowCount, visible, &g.queueTopRow);
    update_vscroll(hwnd, g.detailQueueRowCount, visible, g.queueTopRow);
    InvalidateRect(hwnd, nullptr, FALSE);
}

void handle_queue_vscroll(HWND hwnd, WPARAM wParam) {
    switch (LOWORD(wParam)) {
    case SB_LINEUP:
        scroll_queue_by(hwnd, -1);
        break;
    case SB_LINEDOWN:
        scroll_queue_by(hwnd, 1);
        break;
    case SB_PAGEUP:
        scroll_queue_by(hwnd, -queue_visible_rows(hwnd));
        break;
    case SB_PAGEDOWN:
        scroll_queue_by(hwnd, queue_visible_rows(hwnd));
        break;
    case SB_THUMBTRACK:
    case SB_THUMBPOSITION: {
        SCROLLINFO info{};
        info.cbSize = sizeof(info);
        info.fMask = SIF_TRACKPOS;
        GetScrollInfo(hwnd, SB_VERT, &info);
        scroll_queue_to(hwnd, static_cast<int>(info.nTrackPos));
        break;
    }
    case SB_TOP:
        scroll_queue_to(hwnd, 0);
        break;
    case SB_BOTTOM:
        scroll_queue_to(hwnd, g.detailQueueRowCount);
        break;
    default:
        break;
    }
}

LRESULT CALLBACK queue_window_proc(HWND hwnd, UINT message, WPARAM wParam,
                                   LPARAM lParam) {
    LRESULT modal_result = 0;
    if (handle_modal_loop_message(hwnd, message, wParam, lParam,
                                  &modal_result)) {
        return modal_result;
    }
    switch (message) {
    case WM_CREATE:
        refresh_detail_queue();
        SetTimer(hwnd, kQueueRefreshTimer, 1000, nullptr);
        return 0;

    case WM_PAINT:
        paint_queue_window(hwnd);
        return 0;

    case WM_ERASEBKGND:
        return 1;

    case WM_TIMER:
        if (wParam == kQueueRefreshTimer) {
            refresh_detail_queue();
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;

    case WM_MOUSEMOVE: {
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        const int hit = queue_hit_test(hwnd, point);
        if (hit != g.queueHotIndex) {
            g.queueHotIndex = hit;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        if (!g.queueTrackingMouse) {
            g.queueTrackingMouse = true;
            TRACKMOUSEEVENT track{};
            track.cbSize = sizeof(track);
            track.dwFlags = TME_LEAVE;
            track.hwndTrack = hwnd;
            TrackMouseEvent(&track);
        }
        SetCursor(LoadCursorW(nullptr, hit == -1 ? IDC_ARROW : IDC_HAND));
        return 0;
    }

    case WM_MOUSELEAVE:
        g.queueTrackingMouse = false;
        if (g.queueHotIndex != -1) {
            g.queueHotIndex = -1;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;

    case WM_LBUTTONDOWN:
        SetFocus(hwnd);
        return 0;

    case WM_LBUTTONUP: {
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        const int hit = queue_hit_test(hwnd, point);
        if (hit == 1) {
            DestroyWindow(hwnd);
            return 0;
        }
        if (hit == 0) {
            refresh_detail_queue();
            InvalidateRect(hwnd, nullptr, FALSE);
            return 0;
        }
        return 0;
    }

    case WM_MOUSEWHEEL: {
        const int steps = GET_WHEEL_DELTA_WPARAM(wParam) / WHEEL_DELTA;
        scroll_queue_by(hwnd, -steps * 3);
        return 0;
    }

    case WM_VSCROLL:
        handle_queue_vscroll(hwnd, wParam);
        return 0;

    case WM_KEYDOWN:
        switch (wParam) {
        case VK_ESCAPE:
            DestroyWindow(hwnd);
            return 0;
        case VK_PRIOR:
            scroll_queue_by(hwnd, -queue_visible_rows(hwnd));
            return 0;
        case VK_NEXT:
            scroll_queue_by(hwnd, queue_visible_rows(hwnd));
            return 0;
        case VK_HOME:
            scroll_queue_to(hwnd, 0);
            return 0;
        case VK_END:
            scroll_queue_to(hwnd, g.detailQueueRowCount);
            return 0;
        default:
            break;
        }
        break;

    case WM_CLOSE:
        DestroyWindow(hwnd);
        return 0;

    case WM_DESTROY:
        KillTimer(hwnd, kQueueRefreshTimer);
        if (g.queueWindow == hwnd) {
            g.queueWindow = nullptr;
        }
        return 0;

    default:
        break;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

void open_queue_window() {
    if (g.queueWindow && IsWindow(g.queueWindow)) {
        ShowWindow(g.queueWindow, SW_SHOWNORMAL);
        feather::automation::force_foreground(g.queueWindow);
        return;
    }
    g.queueHotIndex = -1;
    g.queueTrackingMouse = false;
    g.queueTopRow = 0;
    refresh_detail_queue();

    RECT frame{0, 0, scale(kQueueClientWidth), scale(kQueueClientHeight)};
    AdjustWindowRectExForDpi(&frame, kDetailStyle, FALSE, 0, g.dpi);
    // AdjustWindowRectExForDpi does not reserve the non-client scroll bar.
    frame.right += GetSystemMetricsForDpi(SM_CXVSCROLL, g.dpi);
    RECT owner{};
    GetWindowRect(g.hwnd, &owner);
    const int width = frame.right - frame.left;
    const int height = frame.bottom - frame.top;
    const int x = owner.left + ((owner.right - owner.left) - width) / 2;
    const int y = owner.top + ((owner.bottom - owner.top) - height) / 2;

    HWND hwnd = CreateWindowExW(
        WS_EX_DLGMODALFRAME, kQueueClass, kQueueTitle, kDetailStyle,
        x < 0 ? 0 : x, y < 0 ? 0 : y, width, height, g.hwnd, nullptr,
        g.instance, nullptr);
    if (!hwnd) {
        add_log(L"无法打开发送队列窗口");
        return;
    }
    g.queueWindow = hwnd;
    ShowWindow(hwnd, SW_SHOWNORMAL);
    feather::automation::force_foreground(hwnd);
}

void paint(HWND hwnd) {
    PAINTSTRUCT paintStruct{};
    HDC target = BeginPaint(hwnd, &paintStruct);

    RECT client{};
    GetClientRect(hwnd, &client);
    const int width = client.right - client.left;
    const int height = client.bottom - client.top;
    if (width <= 0 || height <= 0) {
        EndPaint(hwnd, &paintStruct);
        return;
    }

    HDC buffer = CreateCompatibleDC(target);
    HBITMAP bitmap = CreateCompatibleBitmap(target, width, height);
    HGDIOBJ previousBitmap = SelectObject(buffer, bitmap);

    TRIVERTEX vertices[2]{};
    vertices[0].x = 0;
    vertices[0].y = 0;
    vertices[0].Red = 0x0E0E;
    vertices[0].Green = 0x1313;
    vertices[0].Blue = 0x1919;
    vertices[0].Alpha = 0xFF00;
    vertices[1].x = width;
    vertices[1].y = height;
    vertices[1].Red = 0x0808;
    vertices[1].Green = 0x0B0B;
    vertices[1].Blue = 0x0F0F;
    vertices[1].Alpha = 0xFF00;

    GRADIENT_RECT gradient{0, 1};
    if (!GradientFill(buffer, vertices, 2, &gradient, 1, GRADIENT_FILL_RECT_V)) {
        fill(buffer, client, g.brushes.background);
    }

    const Layout layout = make_layout(width, height);
    paint_header(buffer, layout);
    paint_search_row(buffer, layout);
    paint_message_row(buffer, layout);
    paint_attachment_row(buffer, layout);
    paint_mention_row(buffer, layout);
    paint_mention_option(buffer, layout);
    paint_api_card(buffer, layout);
    paint_stats(buffer, layout);
    paint_activity(buffer, layout);
    paint_buttons(buffer, layout);
    paint_footer(buffer, layout);

    BitBlt(target, 0, 0, width, height, buffer, 0, 0, SRCCOPY);

    SelectObject(buffer, previousBitmap);
    DeleteObject(bitmap);
    DeleteDC(buffer);
    EndPaint(hwnd, &paintStruct);
}

LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == g.taskbarCreatedMessage && message != 0) {
        g.trayAdded = false;
        add_tray_icon();
        return 0;
    }
    LRESULT modal_result = 0;
    if (handle_modal_loop_message(hwnd, message, wParam, lParam,
                                  &modal_result)) {
        return modal_result;
    }

    switch (message) {
    case WM_CREATE:
        g.hwnd = hwnd;
        SetTimer(hwnd, kJobPumpTimer, 1000, nullptr);
        return 0;

    case WM_ERASEBKGND: {
        HDC dc = reinterpret_cast<HDC>(wParam);
        RECT client{};
        GetClientRect(hwnd, &client);
        fill(dc, client, g.brushes.background);
        return 1;
    }

    case WM_PAINT:
        paint(hwnd);
        return 0;

    case WM_CTLCOLOREDIT: {
        HDC edit_dc = reinterpret_cast<HDC>(wParam);
        SetTextColor(edit_dc, kText);
        SetBkColor(edit_dc, kLogBg);
        return reinterpret_cast<LRESULT>(g.brushes.log);
    }

    case WM_COMMAND:
        if (LOWORD(wParam) == kSearchEditId || LOWORD(wParam) == kContentEditId
            || LOWORD(wParam) == kAttachmentEditId
            || LOWORD(wParam) == kMentionEditId) {
            const WORD notification = HIWORD(wParam);
            if (notification == EN_SETFOCUS || notification == EN_KILLFOCUS) {
                InvalidateRect(hwnd, nullptr, FALSE);
            }
            return 0;
        }
        break;

    case WM_SIZE: {
        if (wParam == SIZE_MINIMIZED) {
            hide_to_tray();
        } else {
            position_input_edits();
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;
    }

    case WM_GETMINMAXINFO: {
        auto* info = reinterpret_cast<MINMAXINFO*>(lParam);
        RECT frame{0, 0, scale(kClientWidth), scale(kClientHeight)};
        AdjustWindowRectExForDpi(&frame, kWindowStyle, FALSE, 0, g.dpi);
        info->ptMinTrackSize.x = frame.right - frame.left;
        info->ptMinTrackSize.y = frame.bottom - frame.top;
        info->ptMaxTrackSize = info->ptMinTrackSize;
        return 0;
    }

    case WM_SYSCOMMAND:
        if ((wParam & 0xFFF0) == SC_MAXIMIZE) {
            return 0;
        }
        break;

    case WM_NCLBUTTONDBLCLK:
        if (wParam == HTCAPTION) {
            return 0;
        }
        break;

    case WM_TIMER:
        if (wParam == kSampleTimer) {
            sample_metrics();
            refresh_queue_view();
            if (g.logWindow && IsWindow(g.logWindow)) {
                InvalidateRect(g.logWindow, nullptr, FALSE);
            }
            if (g.queueWindow && IsWindow(g.queueWindow)) {
                InvalidateRect(g.queueWindow, nullptr, FALSE);
            }
            InvalidateRect(hwnd, nullptr, FALSE);
        } else if (wParam == kWeChatPollTimer) {
            poll_wechat();
        } else if (wParam == kJobPumpTimer) {
            start_next_job();
        }
        return 0;

    case WM_DPICHANGED: {
        g.dpi = LOWORD(wParam);
        create_fonts();
        apply_input_edit_styles();
        refresh_icons();
        const RECT* suggested = reinterpret_cast<const RECT*>(lParam);
        SetWindowPos(hwnd, nullptr, suggested->left, suggested->top,
                     suggested->right - suggested->left,
                     suggested->bottom - suggested->top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        apply_api_layout();
        return 0;
    }

    case WM_MOUSEMOVE: {
        if (!g.trackingMouse) {
            TRACKMOUSEEVENT track{};
            track.cbSize = sizeof(track);
            track.dwFlags = TME_LEAVE;
            track.hwndTrack = hwnd;
            TrackMouseEvent(&track);
            g.trackingMouse = true;
        }
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        const Hot hot = hit_test(point);
        if (hot != g.hot) {
            g.hot = hot;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;
    }

    case WM_MOUSELEAVE:
        g.trackingMouse = false;
        if (g.hot != Hot::None) {
            g.hot = Hot::None;
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;

    case WM_SETCURSOR:
        if (LOWORD(lParam) == HTCLIENT) {
            POINT point{};
            GetCursorPos(&point);
            ScreenToClient(hwnd, &point);
            if (hit_test(point) != Hot::None) {
                SetCursor(LoadCursorW(nullptr, IDC_HAND));
                return TRUE;
            }
        }
        return DefWindowProcW(hwnd, message, wParam, lParam);

    case WM_LBUTTONDOWN: {
        SetFocus(hwnd);
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        const Hot hot = hit_test(point);
        if (hot != Hot::None) {
            g.pressed = hot;
            SetCapture(hwnd);
            InvalidateRect(hwnd, nullptr, FALSE);
        }
        return 0;
    }

    case WM_LBUTTONUP: {
        if (g.pressed == Hot::None) {
            return 0;
        }
        const Hot pressed = g.pressed;
        g.pressed = Hot::None;
        if (GetCapture() == hwnd) {
            ReleaseCapture();
        }
        const POINT point{GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
        if (hit_test(point) == pressed) {
            activate_hot(pressed);
        }
        if (g.hwnd) {
            InvalidateRect(g.hwnd, nullptr, FALSE);
        }
        return 0;
    }

    case WM_CAPTURECHANGED:
        g.pressed = Hot::None;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;

    case WM_KEYDOWN:
        if (wParam == VK_F5) {
            user_check_wechat();
            return 0;
        }
        if (wParam == VK_ESCAPE) {
            hide_to_tray();
            return 0;
        }
        break;

    case WM_CLOSE:
        if (g.exitRequested) {
            DestroyWindow(hwnd);
        } else {
            hide_to_tray();
        }
        return 0;

    case WM_DESTROY:
        KillTimer(hwnd, kSampleTimer);
        KillTimer(hwnd, kWeChatPollTimer);
        KillTimer(hwnd, kJobPumpTimer);
        g.wechatPolling = false;
        if (g.logWindow && IsWindow(g.logWindow)) {
            DestroyWindow(g.logWindow);
        }
        if (g.queueWindow && IsWindow(g.queueWindow)) {
            DestroyWindow(g.queueWindow);
        }
        remove_tray_icon();
        g.hwnd = nullptr;
        PostQuitMessage(0);
        return 0;

    case kTrayMessage:
        if (LOWORD(lParam) == WM_RBUTTONUP || LOWORD(lParam) == WM_CONTEXTMENU) {
            POINT point{};
            GetCursorPos(&point);
            HMENU menu = CreatePopupMenu();
            AppendMenuW(menu, MF_STRING, kMenuShow, L"打开 SuperLanguage");
            AppendMenuW(menu, MF_STRING, kMenuCheck, L"检查微信状态");
            AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
            AppendMenuW(menu, MF_STRING, kMenuExit, L"退出");
            SetMenuDefaultItem(menu, kMenuShow, FALSE);
            SetForegroundWindow(hwnd);
            int command = 0;
            {
                ModalScope modal;
                command = TrackPopupMenu(
                    menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, point.x, point.y, 0,
                    hwnd, nullptr);
            }
            DestroyMenu(menu);
            PostMessageW(hwnd, WM_NULL, 0, 0);
            if (command == kMenuShow) {
                show_main_window();
            } else if (command == kMenuCheck) {
                show_main_window();
                user_check_wechat();
            } else if (command == kMenuExit) {
                begin_exit();
            }
        } else if (LOWORD(lParam) == WM_LBUTTONDBLCLK) {
            show_main_window();
        }
        return 0;

    case kActivateMessage:
        show_main_window();
        {
            FLASHWINFO flash{};
            flash.cbSize = sizeof(flash);
            flash.hwnd = hwnd;
            flash.dwFlags = FLASHW_ALL;
            flash.uCount = 3;
            FlashWindowEx(&flash);
        }
        return 0;

    case kJobMessage:
        start_next_job();
        refresh_queue_view();
        return 0;

    case kExitMessage:
        add_log(L"收到停止请求 · 正在退出");
        begin_exit();
        return 0;

    default:
        break;
    }

    return DefWindowProcW(hwnd, message, wParam, lParam);
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, LPWSTR, int) {
    // The manifest already declares PerMonitorV2; this call then fails with
    // ERROR_ACCESS_DENIED, which is expected and harmless.
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

    HANDLE mutex = CreateMutexW(nullptr, TRUE, kMutexName);
    if (!mutex) {
        MessageBoxW(nullptr, L"无法初始化单实例锁。", kAppName, MB_ICONERROR | MB_OK);
        return 1;
    }
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND existing = nullptr;
        for (int attempt = 0; attempt < 40; ++attempt) {
            existing = FindWindowW(kWindowClass, nullptr);
            if (existing) {
                break;
            }
            Sleep(50);
        }
        if (existing) {
            ShowWindow(existing, SW_SHOWNORMAL);
            SetForegroundWindow(existing);
            PostMessageW(existing, kActivateMessage, 0, 0);
        }
        CloseHandle(mutex);
        return 0;
    }

    // Must be held before queue::open: a second instance's crash recovery
    // would otherwise requeue/fail the first instance's running jobs.
    DWORD instance_lock_error = ERROR_SUCCESS;
    HANDLE instance_lock = acquire_instance_lock(&instance_lock_error);
    if (!instance_lock
        && (instance_lock_error == ERROR_SHARING_VIOLATION
            || instance_lock_error == ERROR_LOCK_VIOLATION)) {
        MessageBoxW(nullptr,
                    L"同一目录下的 SuperLanguage 已在另一个 Windows 用户会话中运行。\n\n"
                    L"两个实例共用同一个发送队列会互相破坏任务状态，"
                    L"请先退出另一个会话中的 SuperLanguage。",
                    kAppName, MB_ICONWARNING | MB_OK);
        ReleaseMutex(mutex);
        CloseHandle(mutex);
        return 0;
    }

    g.instance = instance;
    g.startTick = GetTickCount64();
    g.taskbarCreatedMessage = RegisterWindowMessageW(L"TaskbarCreated");
    create_brushes();

    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.style = CS_HREDRAW | CS_VREDRAW;
    windowClass.lpfnWndProc = window_proc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground = g.brushes.background;
    windowClass.lpszClassName = kWindowClass;

    if (!RegisterClassExW(&windowClass)) {
        MessageBoxW(nullptr, L"无法注册窗口类。", kAppName, MB_ICONERROR | MB_OK);
        destroy_brushes();
        CloseHandle(mutex);
        return 1;
    }

    WNDCLASSEXW helpClass = windowClass;
    helpClass.lpfnWndProc = help_window_proc;
    helpClass.lpszClassName = kHelpClass;
    if (!RegisterClassExW(&helpClass)) {
        MessageBoxW(nullptr, L"无法注册 API 与 MCP 示例窗口类。", kAppName,
                    MB_ICONERROR | MB_OK);
        UnregisterClassW(kWindowClass, instance);
        destroy_brushes();
        CloseHandle(mutex);
        return 1;
    }

    WNDCLASSEXW logClass = windowClass;
    logClass.lpfnWndProc = log_window_proc;
    logClass.lpszClassName = kLogClass;
    if (!RegisterClassExW(&logClass)) {
        MessageBoxW(nullptr, L"无法注册运行日志窗口类。", kAppName,
                    MB_ICONERROR | MB_OK);
        UnregisterClassW(kHelpClass, instance);
        UnregisterClassW(kWindowClass, instance);
        destroy_brushes();
        CloseHandle(mutex);
        return 1;
    }

    WNDCLASSEXW queueClass = windowClass;
    queueClass.lpfnWndProc = queue_window_proc;
    queueClass.lpszClassName = kQueueClass;
    if (!RegisterClassExW(&queueClass)) {
        MessageBoxW(nullptr, L"无法注册发送队列窗口类。", kAppName,
                    MB_ICONERROR | MB_OK);
        UnregisterClassW(kLogClass, instance);
        UnregisterClassW(kHelpClass, instance);
        UnregisterClassW(kWindowClass, instance);
        destroy_brushes();
        CloseHandle(mutex);
        return 1;
    }

    g.dpi = GetDpiForSystem();
    RECT windowRect{0, 0, scale(kClientWidth), scale(kClientHeight)};
    AdjustWindowRectExForDpi(&windowRect, kWindowStyle, FALSE, 0, g.dpi);

    HWND hwnd = CreateWindowExW(
        0, kWindowClass, kWindowTitle, kWindowStyle,
        CW_USEDEFAULT, CW_USEDEFAULT,
        windowRect.right - windowRect.left, windowRect.bottom - windowRect.top,
        nullptr, nullptr, instance, nullptr);

    if (!hwnd) {
        MessageBoxW(nullptr, L"无法创建主窗口。", kAppName, MB_ICONERROR | MB_OK);
        UnregisterClassW(kWindowClass, instance);
        destroy_brushes();
        CloseHandle(mutex);
        return 1;
    }

    g.hwnd = hwnd;
    g.dpi = GetDpiForWindow(hwnd);

    wchar_t queue_path[MAX_PATH]{};
    int recovered_jobs = 0;
    DWORD queue_error = ERROR_SUCCESS;
    const bool queue_ready =
        api_file_path(L"queue.db", queue_path, ARRAYSIZE(queue_path))
        && feather::queue::open(queue_path, &recovered_jobs, &queue_error);
    if (queue_ready) {
        refresh_queue_view();
        if (recovered_jobs > 0) {
            add_log(L"上次中断的任务已回到队列 · %d 条", recovered_jobs);
        }
        if (g.queueStats.queued > 0) {
            add_log(L"发送队列 · %d 条待发送", g.queueStats.queued);
        }
    } else {
        add_log(L"发送队列不可用 · 错误码 %lu", queue_error);
    }
    if (!instance_lock) {
        add_log(L"实例锁 instance.lock 创建失败 · 错误码 %lu · 请勿在其他会话同时运行本目录的程序",
                instance_lock_error);
    }

    create_fonts();
    create_input_edits(hwnd);
    refresh_icons();
    apply_dwm_style();
    center_window();
    sample_metrics();

    add_tray_icon();
    const ULONGLONG startupMs = GetTickCount64() - g.startTick;
    add_log(L"SuperLanguage 已启动 · 原生启动 %llu ms", startupMs);
    add_log(L"渲染后端 · Win32 + GDI · 无 WebView / 无托管运行时");
    if (g.trayAdded) {
        add_log(L"托盘已就绪 · 关闭或最小化窗口后继续驻留");
    } else {
        add_log(L"托盘不可用 · 窗口将保持前台运行");
    }
    add_log(L"F5 检查微信状态 · 关闭窗口后驻留托盘");

    g.sendTimeoutMs = read_send_timeout_ms();
    add_log(L"鼠标保护 · 发送超时 %u 秒（send-timeout.txt 可调）· 键盘可用",
            g.sendTimeoutMs / 1000);
    start_stop_hotkey();

    if (read_api_enabled_setting()) {
        start_http_api();
    } else {
        remove_api_port_file();
        add_log(L"HTTP API 已关闭 · 可在界面开启");
    }

    const bool startInTray = has_argument(L"--tray");
    const bool shortcutTipPending = !shortcut_tip_acknowledged();
    if (startInTray && g.trayAdded && !shortcutTipPending) {
        g.hidden = true;
        show_tray_balloon();
    } else {
        ShowWindow(hwnd, SW_SHOWNORMAL);
        if (shortcutTipPending) {
            // First start (or the user chose "next time"). The reminder needs a
            // visible window, so --tray does not hide the first-run prompt.
            UpdateWindow(hwnd);
            show_shortcut_tip();
        }
        SetTimer(hwnd, kSampleTimer, 1000, nullptr);
        SetFocus(hwnd);
    }

    if (startInTray) {
        add_log(L"托盘启动 · 暂不检查微信 · 有任务时再检查");
    } else {
        start_wechat_check();
    }
    if (queue_ready) {
        PostMessageW(hwnd, kJobMessage, 0, 0);
    }

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }

    stop_stop_hotkey();
    feather::automation::end_automation_guard();
    feather::automation::end_input_guard();
    const bool api_stopped = feather::api::stop();
    if (api_stopped) {
        feather::queue::close();
    }
    // If API shutdown failed, its worker may still use SQLite. Leave queue
    // resources alive and let process teardown reclaim them without racing.
    destroy_fonts();
    destroy_brushes();
    if (g.iconWindow) {
        DestroyIcon(g.iconWindow);
        g.iconWindow = nullptr;
    }
    if (g.iconSmall) {
        DestroyIcon(g.iconSmall);
        g.iconSmall = nullptr;
    }
    if (g.iconHeader) {
        DestroyIcon(g.iconHeader);
        g.iconHeader = nullptr;
    }
    UnregisterClassW(kQueueClass, instance);
    UnregisterClassW(kLogClass, instance);
    UnregisterClassW(kHelpClass, instance);
    UnregisterClassW(kWindowClass, instance);
    if (instance_lock && api_stopped) {
        CloseHandle(instance_lock);
    }
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return static_cast<int>(message.wParam);
}
