#pragma once

#include <windows.h>

#include "queue_store.h"

namespace feather::api {

struct StartResult {
    bool started{};
    unsigned short port{};
    DWORD error{};
    char token[33]{};
    wchar_t token_path[MAX_PATH]{};
    wchar_t port_path[MAX_PATH]{};
    // Bind address configured by api-listen.txt next to the exe. A missing or
    // empty file binds 0.0.0.0 (LAN); "loopback"/"127.0.0.1"/"0" binds
    // 127.0.0.1 only.
    bool lan_exposed{};            // bound to 0.0.0.0 or a concrete non-loopback IPv4
    bool listen_fallback{};        // config asked for non-loopback, loopback was used
    wchar_t listen_address[64]{};  // actual bind address: "127.0.0.1"/"0.0.0.0"/"192.168.1.4"
    wchar_t advertise_ipv4[64]{};  // concrete IPv4 to use in URLs (never "0.0.0.0")
};

StartResult start(HWND ui_window, UINT notify_message, UINT exit_message);
// True means the accept thread and every request worker are confirmed stopped
// and their queue users are gone.
// On false, the caller must leave queue/database resources alive.
bool stop();

// Replaces the bearer token with a fresh random value, persists it, and
// invalidates the previous token immediately. out receives the new token.
bool rotate_token(char* out, size_t capacity, DWORD* error);

} // namespace feather::api
