#pragma once

#include <windows.h>

namespace feather::automation {

enum class WeChatLoginState {
    Unknown,
    NotLoggedIn,
    LoggedIn,
};

enum class AutomationState {
    Idle,
    TargetValidated,
    SearchFocused,
    SearchEntered,
    TargetVerified,
    DraftVerifiedEmpty,
    Composed,
    SubmitReady,
    SendInjected,
};

enum class AutomationOutcome {
    NotAttempted,
    Failed,
    InjectedUnverified,
};

struct AutomationResult {
    AutomationOutcome outcome = AutomationOutcome::NotAttempted;
    AutomationState state = AutomationState::Idle;
    DWORD error = ERROR_SUCCESS;
    bool send_injected = false;
    // Nothing reads the sent content back, so this is always false.
    bool content_verified = false;
};

struct WeChatStatus {
    bool running = false;
    bool main_window = false;
    bool login_window = false;
    bool login_ui_visible = false;
    bool tray_window = false;
    int process_count = 0;
    HWND main_window_handle = nullptr;
    HWND login_window_handle = nullptr;
    WeChatLoginState login_state = WeChatLoginState::Unknown;
    wchar_t executable_path[MAX_PATH]{};
};

struct WeChatWindowAction {
    bool foregrounded = false;
    bool maximized = false;
    DWORD error = ERROR_SUCCESS;
};

struct WeChatSearchPanelAction {
    bool found = false;
    bool clicked = false;
    bool closed = false;
    POINT point{};
    DWORD error = ERROR_SUCCESS;
};

// Read-only window/process snapshot; safe to poll while WeChat starts or awaits login.
WeChatStatus query_wechat();

// Restores a minimized or hidden main window and brings it to the foreground.
// The window is never resized; `maximized` only reports its current state.
WeChatWindowAction present_wechat_window(HWND main_window);

// Reveals or hides the logged-in main window with ShowWindow. No-ops when the
// window is already in the requested visible state.
bool show_wechat_window(HWND main_window, DWORD* error_code);
bool hide_wechat_window(HWND main_window, DWORD* error_code);

// Detects the embedded right-side WeChat search web panel and clicks its
// top-right close control. The click is skipped unless the hit window is a
// Chromium child whose root is main_window, so a missing panel can never click
// the main window's close button.
WeChatSearchPanelAction dismiss_wechat_search_panel(HWND main_window);

// Starts the task guard, refuses to continue when the composer already shows
// content, focuses WeChat's search box with Ctrl+F, clears it, and types the
// conversation name without opening a result.
bool search_wechat_conversation(HWND main_window, const wchar_t* conversation,
                                DWORD* error_code);

// Sends Enter to open the highlighted search result.
bool press_enter_in_wechat(HWND main_window, DWORD* error_code);

// Accepts the conversation opened by Ctrl+F + Enter. The conversation title is
// not read back; the search itself is the only evidence of the target.
bool accept_current_conversation(HWND main_window, const wchar_t* expected_name,
                                 DWORD* error_code);

// Accepts the conversation that is already open from the previous job. Only
// the foreground window, its process and the guard deadline are checked; the
// conversation title is not read.
bool accept_reused_conversation(HWND main_window, const wchar_t* expected_name,
                                DWORD* error_code);

// Starts the task-scoped guard used by every semantic injection. The public
// entry point requires the low-level mouse guard to be active.
bool begin_automation_guard(HWND target_window, unsigned timeout_ms,
                            DWORD* error_code);
void end_automation_guard();
AutomationState automation_state();

// Types the message (optionally selecting an @mention first) and sends it once
// with Ctrl+Enter. A true return always means InjectedUnverified.
bool send_wechat_message(HWND main_window, const wchar_t* message,
                         const wchar_t* mention, bool mention_line_break,
                         AutomationResult* result, DWORD* error_code);

// Stages multiple file paths via the clipboard and sends them as attachments.
// Refuses to start when the composer already shows content (visual probe of
// the send button; a failed screen capture reads as empty). A card staged by
// this call is cleared again when staging or submission fails before Ctrl+Enter
// was injected.
bool send_wechat_attachments(HWND main_window, const wchar_t* paths,
                             AutomationResult* result, int* sent_count,
                             DWORD* error_code);

// Resolves WeChat 4.x (Weixin.exe) or 3.x (WeChat.exe) installation path.
bool find_wechat_install(wchar_t* path, size_t capacity);

// Raises any window above the rest, falling back to input attachment when the
// foreground lock refuses the first attempt.
bool force_foreground(HWND hwnd);

// Mouse-only input guard used while the automation drives WeChat: a low-level
// mouse hook swallows physical mouse input (move/wheel/buttons) while letting
// injected SendInput events through, so scripted clicks keep working and the
// user keeps the keyboard. The hook is released automatically after timeout_ms
// even if the automation is stuck.
bool begin_input_guard(unsigned timeout_ms);
void end_input_guard();
bool input_guard_active();

// Flags the running automation to stop and asks the guard thread to unhook the
// mouse immediately (used by the app's stop hotkey). Safe from any thread.
void emergency_stop_input();

// True once the input guard timed out or emergency_stop_input() was called.
bool automation_aborted();

// Timeout (ms) used by the most recent input guard; 45000 when none ran yet.
unsigned input_guard_timeout_ms();

// How the most recent search opened the box; the current path is always
// "快捷键 Ctrl+F".
const wchar_t* last_search_method();

// The send path uses Ctrl+Enter only; no send-button click fallback exists.
const wchar_t* last_send_method();

// How the most recent show/hide was applied: "ShowWindow", or "无需切换" when
// the window already had the requested visibility.
const wchar_t* last_visibility_method();

// Starts the client. On failure, returns false and writes the Win32 error code.
bool launch_wechat(const wchar_t* executable_path, DWORD* error_code);

} // namespace feather::automation
