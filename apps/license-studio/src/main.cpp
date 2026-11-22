/**
 * Super Time 授权签发台 — Windows 原生 Win32 界面。
 *
 * 本程序只负责窗口、表单与文件对话框。Ed25519 密钥、载荷校验和签名
 * 全部交给同目录 engine.js，后者复用仓库根的 src/license 与
 * scripts/license-key-path，保证与主应用验签格式一致。
 *
 * 不要在本文件里硬编码私钥文件名或重写签名算法。
 */
#ifndef WINVER
#define WINVER 0x0A00
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlwapi.h>

#include <algorithm>
#include <cctype>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#include "json.hpp"

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "comdlg32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "advapi32.lib")

namespace {

const wchar_t kMainClass[] = L"SuperTimeLicenseStudio";
const wchar_t kScrollClass[] = L"SuperTimeLicenseStudioScroll";
const wchar_t kTitle[] = L"Super Time 授权签发台";

enum Ids {
  kIdKeyStatus = 1001,
  kIdBtnRefresh,
  kIdBtnGen,
  kIdBtnSync,
  kIdFingerprint,
  kIdHostname,
  kIdName,
  kIdCompany,
  kIdEmail,
  kIdEdition,
  kIdDays,
  kIdSeats,
  kIdAppVer,
  kIdNotes,
  kIdBtnImport,
  kIdBtnAll,
  kIdBtnData,
  kIdBtnCore,
  kIdBtnIssue,
  kIdIssueStatus,
  kIdFeatureHost,
  kIdFeatureCount,
  kIdBtnVerify,
  kIdVerifyStatus,
  kIdFeatureBase = 2000
};

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  std::wstring out(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n);
  return out;
}

std::string WideToUtf8(const std::wstring& s) {
  if (s.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0, nullptr, nullptr);
  std::string out(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), n, nullptr, nullptr);
  return out;
}

std::wstring QuoteArg(const std::wstring& s) {
  if (s.find_first_of(L" \t\"") == std::wstring::npos) return s;
  std::wstring out = L"\"";
  for (size_t i = 0; i < s.size(); i++) {
    if (s[i] == L'"') out += L"\\\"";
    else out += s[i];
  }
  out += L"\"";
  return out;
}

bool FileExists(const std::wstring& path) {
  return path.size() && PathFileExistsW(path.c_str()) && !PathIsDirectoryW(path.c_str());
}

bool DirExists(const std::wstring& path) {
  return path.size() && PathFileExistsW(path.c_str()) && PathIsDirectoryW(path.c_str());
}

std::wstring JoinPath(const std::wstring& a, const std::wstring& b) {
  wchar_t buf[MAX_PATH * 4];
  lstrcpynW(buf, a.c_str(), MAX_PATH * 4);
  PathAppendW(buf, b.c_str());
  return buf;
}

std::wstring ParentDir(const std::wstring& path) {
  wchar_t buf[MAX_PATH * 4];
  lstrcpynW(buf, path.c_str(), MAX_PATH * 4);
  PathRemoveFileSpecW(buf);
  return buf;
}

std::wstring GetEnvVar(const wchar_t* name) {
  DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
  if (!n) return {};
  std::wstring s(n, 0);
  DWORD got = GetEnvironmentVariableW(name, s.data(), n);
  if (!got) return {};
  s.resize(got);
  return s;
}

std::wstring ModulePath() {
  wchar_t buf[MAX_PATH * 4];
  DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH * 4);
  return std::wstring(buf, n);
}

std::wstring FindNode() {
  std::wstring fromEnv = GetEnvVar(L"SUPERTIME_NODE");
  if (!fromEnv.empty() && FileExists(fromEnv)) return fromEnv;
  wchar_t found[MAX_PATH];
  if (SearchPathW(nullptr, L"node.exe", nullptr, MAX_PATH, found, nullptr)) {
    return found;
  }
  const wchar_t* guesses[] = {
    L"C:\\Program Files\\nodejs\\node.exe",
    L"C:\\Program Files (x86)\\nodejs\\node.exe",
  };
  for (auto g : guesses) {
    if (FileExists(g)) return g;
  }
  return {};
}

struct Paths {
  std::wstring repoRoot;
  std::wstring studioDir;
  std::wstring engineJs;
  std::wstring nodeExe;
  std::wstring testRoot;
  std::wstring vendorDir;
  std::wstring clientPub;
  std::wstring privateKey;
};

bool LooksLikeRepo(const std::wstring& root) {
  return FileExists(JoinPath(root, L"src\\license\\schema.js")) &&
         FileExists(JoinPath(root, L"scripts\\license-key-path.js")) &&
         FileExists(JoinPath(root, L"apps\\license-studio\\engine.js"));
}

Paths DetectPaths() {
  Paths p;
  std::wstring exe = ModulePath();
  std::wstring dir = ParentDir(exe);
  if (FileExists(JoinPath(dir, L"engine.js"))) {
    p.studioDir = dir;
  } else if (FileExists(JoinPath(ParentDir(dir), L"engine.js"))) {
    p.studioDir = ParentDir(dir);
  }
  if (!p.studioDir.empty()) {
    p.repoRoot = ParentDir(ParentDir(p.studioDir));
  }
  if (p.repoRoot.empty() || !LooksLikeRepo(p.repoRoot)) {
    std::wstring walk = dir;
    for (int i = 0; i < 8; i++) {
      if (LooksLikeRepo(walk)) {
        p.repoRoot = walk;
        p.studioDir = JoinPath(walk, L"apps\\license-studio");
        break;
      }
      std::wstring up = ParentDir(walk);
      if (up == walk) break;
      walk = up;
    }
  }
  if (!p.studioDir.empty()) p.engineJs = JoinPath(p.studioDir, L"engine.js");
  p.nodeExe = FindNode();
  return p;
}

void ApplyTestRoot(Paths* p, const std::wstring& testRoot) {
  p->testRoot = testRoot;
  p->vendorDir = JoinPath(testRoot, L"vendor-keys");
  p->clientPub = JoinPath(testRoot, L"public-key.js");
  p->privateKey = JoinPath(testRoot, L"test-key.pem");
}

std::wstring FormatEngineError(const std::string& prefix, const Paths& paths) {
  std::wstring msg = Utf8ToWide(prefix);
  if (paths.nodeExe.empty()) msg += L"\n未找到 node.exe。请安装 Node.js，或设置 SUPERTIME_NODE。";
  if (paths.engineJs.empty() || !FileExists(paths.engineJs)) msg += L"\n未找到 engine.js。";
  if (paths.repoRoot.empty() || !LooksLikeRepo(paths.repoRoot)) msg += L"\n未能定位仓库根（需要 src/license 与 scripts/license-key-path）。";
  return msg;
}

struct EngineResult {
  bool ok = false;
  Json json;
  std::string error;
  std::string stderrText;
};

EngineResult RunEngine(const Paths& paths, const std::vector<std::wstring>& args, const std::string& stdinText = {}) {
  EngineResult out;
  if (paths.nodeExe.empty() || !FileExists(paths.engineJs) || paths.repoRoot.empty()) {
    out.error = WideToUtf8(FormatEngineError("发证引擎无法启动。", paths));
    return out;
  }

  std::wstring cmd = QuoteArg(paths.nodeExe) + L" " + QuoteArg(paths.engineJs);
  cmd += L" --repo-root " + QuoteArg(paths.repoRoot);
  if (!paths.vendorDir.empty()) cmd += L" --vendor-dir " + QuoteArg(paths.vendorDir);
  if (!paths.clientPub.empty()) cmd += L" --client-pub " + QuoteArg(paths.clientPub);
  if (!paths.privateKey.empty()) cmd += L" --private-key " + QuoteArg(paths.privateKey);
  for (const auto& a : args) {
    cmd += L" ";
    cmd += a;
  }

  SECURITY_ATTRIBUTES sa{};
  sa.nLength = sizeof(sa);
  sa.bInheritHandle = TRUE;
  HANDLE inR = nullptr, inW = nullptr, outR = nullptr, outW = nullptr, errR = nullptr, errW = nullptr;
  if (!CreatePipe(&inR, &inW, &sa, 0) ||
      !CreatePipe(&outR, &outW, &sa, 0) ||
      !CreatePipe(&errR, &errW, &sa, 0)) {
    out.error = "无法创建进程管道";
    return out;
  }
  SetHandleInformation(inW, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(outR, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(errR, HANDLE_FLAG_INHERIT, 0);

  STARTUPINFOW si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  si.hStdInput = inR;
  si.hStdOutput = outW;
  si.hStdError = errW;
  PROCESS_INFORMATION pi{};
  std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
  cmdBuf.push_back(0);
  BOOL created = CreateProcessW(
    nullptr, cmdBuf.data(), nullptr, nullptr, TRUE,
    CREATE_NO_WINDOW, nullptr, paths.repoRoot.c_str(), &si, &pi);
  CloseHandle(inR);
  CloseHandle(outW);
  CloseHandle(errW);
  if (!created) {
    CloseHandle(inW);
    CloseHandle(outR);
    CloseHandle(errR);
    out.error = "启动 node 失败（CreateProcess）";
    return out;
  }

  if (!stdinText.empty()) {
    DWORD written = 0;
    WriteFile(inW, stdinText.data(), static_cast<DWORD>(stdinText.size()), &written, nullptr);
  }
  CloseHandle(inW);

  auto readAll = [](HANDLE h) {
    std::string s;
    char buf[4096];
    DWORD n = 0;
    while (ReadFile(h, buf, sizeof(buf), &n, nullptr) && n) s.append(buf, n);
    return s;
  };
  // Wait with timeout; still drain pipes after.
  WaitForSingleObject(pi.hProcess, 30000);
  std::string stdoutText = readAll(outR);
  out.stderrText = readAll(errR);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  if (code == STILL_ACTIVE) {
    TerminateProcess(pi.hProcess, 1);
    out.error = "发证引擎超时";
  }
  CloseHandle(outR);
  CloseHandle(errR);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);

  if (out.error.empty()) {
    try {
      // engine always prints one JSON object
      std::string trimmed = stdoutText;
      while (!trimmed.empty() && (trimmed.back() == '\n' || trimmed.back() == '\r' || trimmed.back() == ' ')) {
        trimmed.pop_back();
      }
      out.json = Json::parse(trimmed);
      out.ok = out.json.boolean("ok", false);
      if (!out.ok) out.error = out.json.str("error", "发证引擎返回失败");
    } catch (const std::exception& ex) {
      out.error = std::string("无法解析引擎输出：") + ex.what();
      if (!stdoutText.empty()) out.error += "\n" + stdoutText.substr(0, 400);
      if (!out.stderrText.empty()) out.error += "\n" + out.stderrText.substr(0, 400);
    }
  }
  return out;
}

void SetWindowTextUtf8(HWND hwnd, const std::string& text) {
  SetWindowTextW(hwnd, Utf8ToWide(text).c_str());
}

std::string GetWindowTextUtf8(HWND hwnd) {
  int n = GetWindowTextLengthW(hwnd);
  std::wstring s(n + 1, 0);
  if (n) GetWindowTextW(hwnd, s.data(), n + 1);
  s.resize(n);
  // trim
  while (!s.empty() && (s.back() == L' ' || s.back() == L'\r' || s.back() == L'\n' || s.back() == L'\t')) s.pop_back();
  size_t i = 0;
  while (i < s.size() && (s[i] == L' ' || s[i] == L'\t')) i++;
  return WideToUtf8(s.substr(i));
}

bool OpenJsonDialog(HWND owner, bool save, std::wstring* path, const wchar_t* title, const wchar_t* defaultName) {
  wchar_t file[MAX_PATH * 2] = {};
  if (defaultName) lstrcpynW(file, defaultName, MAX_PATH * 2);
  OPENFILENAMEW ofn{};
  ofn.lStructSize = sizeof(ofn);
  ofn.hwndOwner = owner;
  ofn.lpstrFilter = L"JSON 文件\0*.json\0所有文件\0*.*\0";
  ofn.lpstrFile = file;
  ofn.nMaxFile = MAX_PATH * 2;
  ofn.lpstrTitle = title;
  ofn.Flags = OFN_EXPLORER | OFN_HIDEREADONLY;
  if (save) {
    ofn.Flags |= OFN_OVERWRITEPROMPT;
    ofn.lpstrDefExt = L"json";
    if (!GetSaveFileNameW(&ofn)) return false;
  } else {
    ofn.Flags |= OFN_FILEMUSTEXIST;
    if (!GetOpenFileNameW(&ofn)) return false;
  }
  *path = file;
  return true;
}

struct FeatureCtl {
  std::string id;
  std::string group;
  std::string label;
  bool required = false;
  HWND box = nullptr;
  HWND title = nullptr;
};

struct App {
  Paths paths;
  HWND wnd = nullptr;
  HWND keyStatus = nullptr;
  HWND issueStatus = nullptr;
  HWND verifyStatus = nullptr;
  HWND featureHost = nullptr;
  HWND featureCount = nullptr;
  HWND edition = nullptr;
  HWND btnIssue = nullptr;
  HFONT font = nullptr;
  Json meta;
  std::vector<FeatureCtl> features;
  int scrollY = 0;
  int contentH = 0;
  int dpi = 96;
  int Scale(int v) const { return MulDiv(v, dpi, 96); }
};

App g;

void RecreateFont(HWND hwnd) {
  if (g.font) DeleteObject(g.font);
  LOGFONTW lf{};
  if (SystemParametersInfoW(SPI_GETICONTITLELOGFONT, sizeof(lf), &lf, 0)) {
    g.font = CreateFontIndirectW(&lf);
  } else {
    g.font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);
  }
  (void)hwnd;
}

void ApplyFont(HWND child) {
  if (g.font) SendMessageW(child, WM_SETFONT, (WPARAM)g.font, TRUE);
}

HWND AddChild(HWND parent, const wchar_t* cls, const wchar_t* text, DWORD style, int id, int x, int y, int w, int h, DWORD ex = 0) {
  HWND hwnd = CreateWindowExW(ex, cls, text, style | WS_CHILD | WS_VISIBLE, x, y, w, h, parent, (HMENU)(INT_PTR)id, GetModuleHandleW(nullptr), nullptr);
  ApplyFont(hwnd);
  return hwnd;
}

void SetStatus(HWND hwnd, const std::string& text) {
  SetWindowTextUtf8(hwnd, text);
}

void RebuildFeatures();
void UpdateFeatureCount();
void RefreshKeys();
void Relayout();

void LoadMeta() {
  auto r = RunEngine(g.paths, {L"meta"});
  if (!r.ok) {
    g.meta = Json::object();
    EnableWindow(g.btnIssue, FALSE);
    SetStatus(g.issueStatus, std::string("功能目录读取失败：") + r.error);
    return;
  }
  g.meta = r.json;
  EnableWindow(g.btnIssue, TRUE);
  // editions
  SendMessageW(g.edition, CB_RESETCONTENT, 0, 0);
  const Json& eds = g.meta.get("editions");
  int sel = 0;
  for (size_t i = 0; i < eds.a.size(); i++) {
    std::wstring label = Utf8ToWide(eds.at(i).str("label", eds.at(i).str("value")));
    SendMessageW(g.edition, CB_ADDSTRING, 0, (LPARAM)label.c_str());
    SendMessageW(g.edition, CB_SETITEMDATA, (WPARAM)i, (LPARAM)i);
    if (eds.at(i).str("value") == "pro") sel = static_cast<int>(i);
  }
  SendMessageW(g.edition, CB_SETCURSEL, sel, 0);
  RebuildFeatures();
}

void RebuildFeatures() {
  for (auto& f : g.features) {
    if (f.box) DestroyWindow(f.box);
    if (f.title) DestroyWindow(f.title);
  }
  g.features.clear();
  g.scrollY = 0;

  const Json& catalog = g.meta.get("featureCatalog");
  const Json& groups = g.meta.get("featureGroups");
  int y = g.Scale(8);
  int width = 0;
  RECT rc{};
  if (g.featureHost) GetClientRect(g.featureHost, &rc);
  width = std::max(80, (int)(rc.right - rc.left) - g.Scale(24));
  int id = kIdFeatureBase;

  for (size_t gi = 0; gi < groups.a.size(); gi++) {
    const Json& group = groups.at(gi);
    std::string gid = group.str("id");
    std::wstring head = Utf8ToWide(group.str("label"));
    std::string desc = group.str("description");
    if (!desc.empty()) head += L"  ·  " + Utf8ToWide(desc);
    HWND title = AddChild(g.featureHost, L"STATIC", head.c_str(), SS_LEFT | SS_NOPREFIX, 0, g.Scale(8), y, width, g.Scale(20));
    y += g.Scale(24);
    FeatureCtl header;
    header.group = gid;
    header.title = title;
    header.box = nullptr;
    g.features.push_back(header);

    for (size_t i = 0; i < catalog.a.size(); i++) {
      const Json& feat = catalog.at(i);
      if (feat.str("group") != gid) continue;
      FeatureCtl fc;
      fc.id = feat.str("id");
      fc.group = gid;
      fc.label = feat.str("label");
      fc.required = feat.boolean("required", false);
      std::wstring text = Utf8ToWide(fc.label);
      if (fc.required) text += L"（必选）";
      fc.box = AddChild(g.featureHost, L"BUTTON", text.c_str(),
                        BS_AUTOCHECKBOX | WS_TABSTOP, id++, g.Scale(12), y, width, g.Scale(22));
      SendMessageW(fc.box, BM_SETCHECK, BST_CHECKED, 0);
      if (fc.required) EnableWindow(fc.box, FALSE);
      std::wstring tip = Utf8ToWide(std::string("功能标识：") + fc.id);
      if (!feat.str("description").empty()) {
        tip += L"\n";
        tip += Utf8ToWide(feat.str("description"));
      }
      // tooltip via title is enough; SetWindowTheme not needed
      y += g.Scale(22);
      g.features.push_back(fc);
    }
    y += g.Scale(8);
  }
  g.contentH = y;
  UpdateFeatureCount();
  Relayout();
}

std::vector<std::string> SelectedFeatures() {
  std::vector<std::string> ids;
  for (const auto& f : g.features) {
    if (!f.box) continue;
    if (SendMessageW(f.box, BM_GETCHECK, 0, 0) == BST_CHECKED) ids.push_back(f.id);
  }
  const Json& req = g.meta.get("requiredFeatures");
  for (size_t i = 0; i < req.a.size(); i++) {
    std::string id = req.at(i).as_string();
    if (std::find(ids.begin(), ids.end(), id) == ids.end()) ids.push_back(id);
  }
  // preserve catalog order
  std::vector<std::string> ordered;
  const Json& catalog = g.meta.get("featureCatalog");
  for (size_t i = 0; i < catalog.a.size(); i++) {
    std::string id = catalog.at(i).str("id");
    if (std::find(ids.begin(), ids.end(), id) != ids.end()) ordered.push_back(id);
  }
  return ordered;
}

void SetFeatureSelection(const std::vector<std::string>& ids) {
  std::map<std::string, bool> pick;
  for (const auto& id : ids) pick[id] = true;
  const Json& req = g.meta.get("requiredFeatures");
  for (size_t i = 0; i < req.a.size(); i++) pick[req.at(i).as_string()] = true;
  for (auto& f : g.features) {
    if (!f.box) continue;
    bool on = pick[f.id] || f.required;
    SendMessageW(f.box, BM_SETCHECK, on ? BST_CHECKED : BST_UNCHECKED, 0);
  }
  UpdateFeatureCount();
}

void UpdateFeatureCount() {
  int count = 0, total = 0;
  for (const auto& f : g.features) {
    if (!f.box) continue;
    total++;
    if (SendMessageW(f.box, BM_GETCHECK, 0, 0) == BST_CHECKED) count++;
  }
  std::ostringstream os;
  os << "已开放 " << count << " / " << total << " 项";
  if (g.featureCount) SetStatus(g.featureCount, os.str());
}

void SelectAllFeatures() {
  std::vector<std::string> ids;
  for (const auto& f : g.features) if (f.box) ids.push_back(f.id);
  SetFeatureSelection(ids);
}

void SelectDataFeatures() {
  std::vector<std::string> ids;
  for (const auto& f : g.features) {
    if (f.box && (f.group == "base" || f.group == "data")) ids.push_back(f.id);
  }
  SetFeatureSelection(ids);
}

void SelectCoreFeatures() {
  std::vector<std::string> ids;
  const Json& req = g.meta.get("requiredFeatures");
  for (size_t i = 0; i < req.a.size(); i++) ids.push_back(req.at(i).as_string());
  SetFeatureSelection(ids);
}

std::string EditionValue() {
  int sel = (int)SendMessageW(g.edition, CB_GETCURSEL, 0, 0);
  const Json& eds = g.meta.get("editions");
  if (sel >= 0 && sel < (int)eds.a.size()) return eds.at((size_t)sel).str("value", "pro");
  return "pro";
}

std::string EditionLabel(const std::string& value) {
  const Json& eds = g.meta.get("editions");
  for (size_t i = 0; i < eds.a.size(); i++) {
    if (eds.at(i).str("value") == value) return eds.at(i).str("label", value);
  }
  return value.empty() ? "—" : value;
}

void RefreshKeys() {
  auto r = RunEngine(g.paths, {L"keys"});
  if (!r.ok) {
    SetStatus(g.keyStatus, r.error);
    return;
  }
  const Json& k = r.json;
  std::ostringstream os;
  os << "私钥：" << (k.boolean("hasPrivate") ? "已就绪" : "缺失") << "\r\n";
  if (!k.str("privatePath").empty()) os << k.str("privatePath") << "\r\n";
  else if (!k.str("privateError").empty()) os << k.str("privateError") << "\r\n";
  bool match = k.boolean("matchClient") && k.boolean("matchPrivate");
  os << "公钥一致性：" << (match ? "客户端与 vendor-keys 一致" : "不一致，可能导致 signature_invalid") << "\r\n";
  os << "私钥匹配：" << (k.boolean("matchPrivate") ? "是" : "否")
     << "  ·  客户端匹配：" << (k.boolean("matchClient") ? "是" : "否");
  SetStatus(g.keyStatus, os.str());
}

void OnGenerateKeys() {
  int ret = MessageBoxW(
    g.wnd,
    L"将生成新的 Ed25519 密钥对：私钥写到仓库之外（默认 ~/.supertime/），公钥同步到 vendor-keys 与客户端。\n\n"
    L"旧私钥签发的许可证将全部失效。生成后需重启 Super Time 主程序。",
    L"生成新密钥对",
    MB_YESNO | MB_ICONWARNING | MB_DEFBUTTON2);
  if (ret != IDYES) return;
  auto r = RunEngine(g.paths, {L"generate-keys", L"--yes"});
  RefreshKeys();
  if (!r.ok) {
    MessageBoxW(g.wnd, Utf8ToWide(r.error).c_str(), L"生成失败", MB_OK | MB_ICONERROR);
  }
}

void OnSyncPub() {
  auto r = RunEngine(g.paths, {L"sync-client-pub"});
  RefreshKeys();
  if (r.ok) {
    MessageBoxW(g.wnd, L"已同步客户端公钥。\n请重启 Super Time 主程序后再导入许可证。", L"同步完成", MB_OK | MB_ICONINFORMATION);
  } else {
    MessageBoxW(g.wnd, Utf8ToWide(r.error).c_str(), L"同步失败", MB_OK | MB_ICONERROR);
  }
}

void OnImportRequest() {
  std::wstring path;
  if (!OpenJsonDialog(g.wnd, false, &path, L"导入激活请求", nullptr)) return;
  auto r = RunEngine(g.paths, {L"import-request", L"--in", QuoteArg(path)});
  if (!r.ok) {
    SetStatus(g.issueStatus, r.error);
    return;
  }
  const Json& req = r.json.get("request");
  SetWindowTextUtf8(GetDlgItem(g.wnd, kIdFingerprint), req.str("fingerprint"));
  SetWindowTextUtf8(GetDlgItem(g.wnd, kIdHostname), req.str("hostname"));
  if (!req.str("appVersion").empty()) {
    SetWindowTextUtf8(GetDlgItem(g.wnd, kIdAppVer), req.str("appVersion"));
  }
  SetStatus(g.issueStatus, std::string("已导入激活请求\r\n") + r.json.str("path"));
}

Json ReadForm() {
  Json form = Json::object();
  form["fingerprint"] = Json::string(GetWindowTextUtf8(GetDlgItem(g.wnd, kIdFingerprint)));
  form["hostname"] = Json::string(GetWindowTextUtf8(GetDlgItem(g.wnd, kIdHostname)));
  form["name"] = Json::string(GetWindowTextUtf8(GetDlgItem(g.wnd, kIdName)));
  form["company"] = Json::string(GetWindowTextUtf8(GetDlgItem(g.wnd, kIdCompany)));
  form["email"] = Json::string(GetWindowTextUtf8(GetDlgItem(g.wnd, kIdEmail)));
  form["edition"] = Json::string(EditionValue());
  int days = 365;
  try { days = std::stoi(GetWindowTextUtf8(GetDlgItem(g.wnd, kIdDays))); } catch (...) { days = 365; }
  int seats = 1;
  try { seats = std::stoi(GetWindowTextUtf8(GetDlgItem(g.wnd, kIdSeats))); } catch (...) { seats = 1; }
  form["days"] = Json::numberInt(days);
  form["seats"] = Json::numberInt(seats);
  std::string ver = GetWindowTextUtf8(GetDlgItem(g.wnd, kIdAppVer));
  if (ver.empty()) ver = "1.0.0";
  form["appVersionMin"] = Json::string(ver);
  form["notes"] = Json::string(GetWindowTextUtf8(GetDlgItem(g.wnd, kIdNotes)));
  Json feats = Json::array();
  for (const auto& id : SelectedFeatures()) feats.push(Json::string(id));
  form["features"] = feats;
  return form;
}

void OnIssue() {
  Json form = ReadForm();
  std::string fp = form.str("fingerprint");
  bool hex = fp.size() >= 32;
  for (char c : fp) {
    if (!std::isxdigit(static_cast<unsigned char>(c))) hex = false;
  }
  if (!hex) {
    SetStatus(g.issueStatus, "请先填写有效的设备指纹（至少 32 位十六进制字符）");
    return;
  }
  if (form.str("name").empty()) {
    SetStatus(g.issueStatus, "请填写客户姓名");
    return;
  }
  EnableWindow(g.btnIssue, FALSE);
  SetStatus(g.issueStatus, "签发中…");
  // Dry-run first by asking engine... we need an output path from the save dialog,
  // but we should validate before asking? The engine signs only when writing.
  // Ask save path with a temporary name after a preliminary client-side check.
  // We'll generate a placeholder name; licenseId is assigned by the engine,
  // so use the customer name first, then rename is unnecessary — we only have
  // the id after issue. Use name + timestamp for the default filename.
  std::wstring def = Utf8ToWide("license-" + form.str("name") + ".json");
  for (auto& ch : def) {
    if (ch == L'\\' || ch == L'/' || ch == L':' || ch == L'*' || ch == L'?' || ch == L'"' || ch == L'<' || ch == L'>' || ch == L'|') ch = L'_';
  }
  std::wstring outPath;
  if (!OpenJsonDialog(g.wnd, true, &outPath, L"保存许可证", def.c_str())) {
    SetStatus(g.issueStatus, "已取消保存");
    EnableWindow(g.btnIssue, TRUE);
    return;
  }
  auto r = RunEngine(g.paths, {L"issue", L"--form", L"-", L"--out", QuoteArg(outPath)}, form.stringify());
  EnableWindow(g.btnIssue, TRUE);
  if (!r.ok) {
    SetStatus(g.issueStatus, r.error);
    return;
  }
  const Json& payload = r.json.get("payload");
  std::ostringstream os;
  os << "已保存许可证\r\n" << r.json.str("path") << "\r\n";
  os << "许可证编号：" << payload.str("licenseId") << "\r\n";
  os << "到期：" << (payload.get("expiresAt").is_null() || payload.str("expiresAt").empty() ? "永久" : payload.str("expiresAt")) << "\r\n";
  os << "开放功能（" << r.json.get("featureLabels").a.size() << " 项）：";
  for (size_t i = 0; i < r.json.get("featureLabels").a.size(); i++) {
    if (i) os << "、";
    os << r.json.get("featureLabels").at(i).as_string();
  }
  SetStatus(g.issueStatus, os.str());
}

void OnVerify() {
  std::wstring path;
  if (!OpenJsonDialog(g.wnd, false, &path, L"选择许可证文件", nullptr)) {
    SetStatus(g.verifyStatus, "已取消");
    return;
  }
  SetStatus(g.verifyStatus, "校验中…");
  auto r = RunEngine(g.paths, {L"verify", L"--in", QuoteArg(path)});
  if (!r.ok) {
    SetStatus(g.verifyStatus, r.error);
    return;
  }
  const Json& payload = r.json.get("payload");
  std::ostringstream os;
  os << "签名与结构有效\r\n";
  os << "客户：" << payload.get("issuedTo").str("name") << " " << payload.get("issuedTo").str("company") << "\r\n";
  os << "公司：" << payload.get("issuedTo").str("company") << "\r\n";
  os << "版本：" << EditionLabel(payload.str("edition")) << "  ·  席位：" << payload.integer("seats", 1) << "\r\n";
  os << "到期：" << (payload.get("expiresAt").is_null() || payload.str("expiresAt").empty() ? "永久" : payload.str("expiresAt")) << "\r\n";
  int schema = payload.integer("featureSchemaVersion", 0);
  int current = g.meta.integer("featureSchemaVersion", 0);
  os << "功能目录：" << (schema == current && schema != 0 ? "新版（逐项授权）" : "旧版（兼容模式）") << "\r\n";
  const Json& labels = r.json.get("featureLabels");
  os << "开放功能（" << labels.a.size() << " 项）：";
  if (labels.a.empty()) os << "无";
  for (size_t i = 0; i < labels.a.size(); i++) {
    if (i) os << "、";
    os << labels.at(i).as_string();
  }
  SetStatus(g.verifyStatus, os.str());
}

void SyncFeatureScroll() {
  if (!g.featureHost) return;
  RECT rc{};
  GetClientRect(g.featureHost, &rc);
  int view = rc.bottom - rc.top;
  int maxScroll = std::max(0, g.contentH - view);
  if (g.scrollY > maxScroll) g.scrollY = maxScroll;
  if (g.scrollY < 0) g.scrollY = 0;
  SCROLLINFO si{};
  si.cbSize = sizeof(si);
  si.fMask = SIF_RANGE | SIF_PAGE | SIF_POS;
  si.nMin = 0;
  si.nMax = std::max(0, g.contentH);
  si.nPage = view;
  si.nPos = g.scrollY;
  SetScrollInfo(g.featureHost, SB_VERT, &si, TRUE);

  // Move children relative to scroll
  HDWP hdwp = BeginDeferWindowPos(32);
  HWND child = GetWindow(g.featureHost, GW_CHILD);
  // We stored positions at create time; easier to walk features + headers with remembered layout.
  // Recreate positions from a simple pass: headers and checkboxes were created top-to-bottom.
  // Use stored Y from creation? We didn't keep original Y. Re-run placement.
  int y = g.Scale(8) - g.scrollY;
  int width = std::max(80, (int)(rc.right - rc.left) - g.Scale(24));
  for (auto& f : g.features) {
    if (f.title && !f.box) {
      hdwp = DeferWindowPos(hdwp, f.title, nullptr, g.Scale(8), y, width, g.Scale(20), SWP_NOZORDER);
      y += g.Scale(24);
    } else if (f.box) {
      hdwp = DeferWindowPos(hdwp, f.box, nullptr, g.Scale(12), y, width, g.Scale(22), SWP_NOZORDER);
      y += g.Scale(22);
    }
    if (&f + 1 != g.features.data() + g.features.size()) {
      // add group padding after last item of a group: if next is a header
    }
  }
  // group padding: when next is header, add 8 already accounted in Rebuild? headers start after +8 from previous loop in Rebuild.
  // Rebuild added y += 8 after each group. Recreate that: after a checkbox followed by a title, add 8.
  // Simpler to store origY. For now, second pass with same rules as Rebuild.
  EndDeferWindowPos(hdwp);

  // The padding after groups was not replayed accurately. Rebuild placement exactly:
  y = g.Scale(8) - g.scrollY;
  bool afterItem = false;
  HDWP hdwp2 = BeginDeferWindowPos((int)g.features.size() + 1);
  for (size_t i = 0; i < g.features.size(); i++) {
    auto& f = g.features[i];
    if (f.title && !f.box) {
      if (afterItem) y += g.Scale(8);
      hdwp2 = DeferWindowPos(hdwp2, f.title, nullptr, g.Scale(8), y, width, g.Scale(20), SWP_NOZORDER);
      y += g.Scale(24);
      afterItem = false;
    } else if (f.box) {
      hdwp2 = DeferWindowPos(hdwp2, f.box, nullptr, g.Scale(12), y, width, g.Scale(22), SWP_NOZORDER);
      y += g.Scale(22);
      afterItem = true;
    }
  }
  EndDeferWindowPos(hdwp2);
}

void OnFeatureScroll(WPARAM wParam) {
  RECT rc{};
  GetClientRect(g.featureHost, &rc);
  int view = rc.bottom - rc.top;
  int maxScroll = std::max(0, g.contentH - view);
  int y = g.scrollY;
  switch (LOWORD(wParam)) {
    case SB_LINEUP: y -= g.Scale(22); break;
    case SB_LINEDOWN: y += g.Scale(22); break;
    case SB_PAGEUP: y -= view; break;
    case SB_PAGEDOWN: y += view; break;
    case SB_THUMBTRACK:
    case SB_THUMBPOSITION: y = HIWORD(wParam); break;
    default: break;
  }
  y = std::max(0, std::min(y, maxScroll));
  if (y != g.scrollY) {
    g.scrollY = y;
    SyncFeatureScroll();
  }
}

LRESULT CALLBACK ScrollProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
    case WM_VSCROLL:
      OnFeatureScroll(wParam);
      return 0;
    case WM_MOUSEWHEEL: {
      int delta = GET_WHEEL_DELTA_WPARAM(wParam);
      int steps = -delta / WHEEL_DELTA * g.Scale(22);
      RECT rc{};
      GetClientRect(hwnd, &rc);
      int maxScroll = std::max(0, g.contentH - (int)(rc.bottom - rc.top));
      g.scrollY = std::max(0, std::min(g.scrollY + steps, maxScroll));
      SyncFeatureScroll();
      return 0;
    }
    case WM_SIZE:
      SyncFeatureScroll();
      return 0;
    case WM_ERASEBKGND: {
      RECT rc;
      GetClientRect(hwnd, &rc);
      FillRect((HDC)wParam, &rc, GetSysColorBrush(COLOR_WINDOW));
      return 1;
    }
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

HWND Place(HWND parent, const wchar_t* cls, const wchar_t* text, DWORD style, int id, int x, int y, int w, int h, DWORD ex = 0) {
  return AddChild(parent, cls, text, style, id, g.Scale(x), g.Scale(y), g.Scale(w), g.Scale(h), ex);
}

void Relayout() {
  if (!g.wnd) return;
  RECT rc;
  GetClientRect(g.wnd, &rc);
  int W = rc.right - rc.left;
  int H = rc.bottom - rc.top;
  int m = g.Scale(14);
  int mid = W / 2;
  int leftW = mid - m - g.Scale(8);
  int rightX = mid + g.Scale(8);
  int rightW = W - rightX - m;
  if (leftW < g.Scale(280)) {
    // narrow: stack is still two columns but shrink
    leftW = std::max(g.Scale(260), W / 2 - m);
    rightX = leftW + m * 2;
    rightW = std::max(g.Scale(260), W - rightX - m);
  }

  int y = g.Scale(52);
  // key group
  HWND keyBox = GetDlgItem(g.wnd, 3001);
  int keyH = g.Scale(150);
  MoveWindow(keyBox, m, y, W - 2 * m, keyH, TRUE);
  MoveWindow(g.keyStatus, m + g.Scale(12), y + g.Scale(22), W - 2 * m - g.Scale(24), g.Scale(72), TRUE);
  int btnY = y + g.Scale(100);
  int bw = g.Scale(140), bh = g.Scale(28), gap = g.Scale(8);
  MoveWindow(GetDlgItem(g.wnd, kIdBtnRefresh), m + g.Scale(12), btnY, bw, bh, TRUE);
  MoveWindow(GetDlgItem(g.wnd, kIdBtnGen), m + g.Scale(12) + bw + gap, btnY, bw, bh, TRUE);
  MoveWindow(GetDlgItem(g.wnd, kIdBtnSync), m + g.Scale(12) + (bw + gap) * 2, btnY, g.Scale(168), bh, TRUE);

  int bodyY = y + keyH + g.Scale(12);
  int bodyH = H - bodyY - m;
  int issueBox = 3002, featBox = 3003, verBox = 3004;
  int verifyH = g.Scale(200);
  int issueH = bodyH;
  MoveWindow(GetDlgItem(g.wnd, issueBox), m, bodyY, leftW, issueH, TRUE);
  MoveWindow(GetDlgItem(g.wnd, featBox), rightX, bodyY, rightW, bodyH - verifyH - g.Scale(10), TRUE);
  MoveWindow(GetDlgItem(g.wnd, verBox), rightX, bodyY + bodyH - verifyH, rightW, verifyH, TRUE);

  auto move = [&](int id, int x, int yy, int w, int h) {
    HWND hwnd = GetDlgItem(g.wnd, id);
    if (hwnd) MoveWindow(hwnd, x, yy, w, h, TRUE);
  };

  int lx = m + g.Scale(12);
  int lw = leftW - g.Scale(24);
  int ly = bodyY + g.Scale(22);
  int lh = g.Scale(20), eh = g.Scale(22), row = g.Scale(42);
  // labels are id-100 offset? We'll look up by stored positions via GetWindow + text.
  // Simpler: enumerate known label statics by consecutive IDs 4001+
  struct Field { int labelId; int editId; int h; };
  Field fields[] = {
    {4001, kIdFingerprint, eh},
    {4002, kIdHostname, eh},
    {4003, kIdName, eh},
    {4004, kIdCompany, eh},
    {4005, kIdEmail, eh},
    {4006, kIdEdition, eh},
    {4007, kIdDays, eh},
    {4008, kIdSeats, eh},
    {4009, kIdAppVer, eh},
    {4010, kIdNotes, g.Scale(46)},
  };
  for (const auto& f : fields) {
    move(f.labelId, lx, ly, lw, lh);
    ly += g.Scale(18);
    move(f.editId, lx, ly, lw, f.h);
    ly += f.h + g.Scale(6);
  }
  int b2 = g.Scale(100);
  move(kIdBtnImport, lx, ly, g.Scale(130), bh);
  move(kIdBtnAll, lx + g.Scale(138), ly, b2, bh);
  move(kIdBtnData, lx + g.Scale(138) + b2 + gap, ly, b2, bh);
  move(kIdBtnCore, lx + g.Scale(138) + (b2 + gap) * 2, ly, b2, bh);
  ly += bh + g.Scale(8);
  move(kIdBtnIssue, lx, ly, g.Scale(130), bh);
  ly += bh + g.Scale(8);
  int issueStatusH = std::max(g.Scale(80), (bodyY + issueH) - g.Scale(12) - ly);
  move(kIdIssueStatus, lx, ly, lw, issueStatusH);

  int fx = rightX + g.Scale(12);
  int fw = rightW - g.Scale(24);
  int fy = bodyY + g.Scale(22);
  move(kIdFeatureCount, fx, fy, fw, lh);
  fy += g.Scale(22);
  int featBoxH = bodyH - verifyH - g.Scale(10);
  int featH = std::max(g.Scale(80), (bodyY + featBoxH) - g.Scale(12) - fy);
  if (g.featureHost) MoveWindow(g.featureHost, fx, fy, fw, featH, TRUE);

  int vx = rightX + g.Scale(12);
  int vw = rightW - g.Scale(24);
  int vy = bodyY + bodyH - verifyH + g.Scale(22);
  move(kIdBtnVerify, vx, vy, g.Scale(140), bh);
  vy += bh + g.Scale(8);
  int vsH = std::max(g.Scale(60), (bodyY + bodyH) - g.Scale(12) - vy);
  move(kIdVerifyStatus, vx, vy, vw, vsH);

  if (g.featureHost) SyncFeatureScroll();
}

void CreateMainUi(HWND hwnd) {
  g.wnd = hwnd;
  RecreateFont(hwnd);

  Place(hwnd, L"STATIC", L"SUPER TIME", SS_LEFT | SS_NOPREFIX, 0, 14, 10, 200, 14);
  Place(hwnd, L"STATIC", L"授权签发台（Win32）", SS_LEFT | SS_NOPREFIX, 0, 14, 26, 400, 22);
  Place(hwnd, L"STATIC", L"密钥管理、导入激活请求、签发与校验许可证。签名由现有 src/license 引擎完成。",
        SS_LEFT | SS_NOPREFIX, 0, 420, 28, 520, 18);

  AddChild(hwnd, L"BUTTON", L"密钥", BS_GROUPBOX, 3001, 0, 0, 100, 100);
  g.keyStatus = AddChild(hwnd, L"EDIT", L"正在读取密钥状态…",
                         ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL | WS_BORDER, kIdKeyStatus,
                         0, 0, 100, 40, WS_EX_CLIENTEDGE);
  AddChild(hwnd, L"BUTTON", L"刷新", BS_PUSHBUTTON | WS_TABSTOP, kIdBtnRefresh, 0, 0, 80, 24);
  AddChild(hwnd, L"BUTTON", L"生成密钥对", BS_PUSHBUTTON | WS_TABSTOP, kIdBtnGen, 0, 0, 80, 24);
  AddChild(hwnd, L"BUTTON", L"同步客户端公钥", BS_PUSHBUTTON | WS_TABSTOP, kIdBtnSync, 0, 0, 80, 24);

  AddChild(hwnd, L"BUTTON", L"签发许可证", BS_GROUPBOX, 3002, 0, 0, 100, 100);
  const wchar_t* labels[] = {
    L"设备指纹", L"主机名（可选）", L"客户名称", L"公司", L"邮箱",
    L"版本", L"有效天数（0 = 永久）", L"席位", L"最低应用版本", L"备注"
  };
  int labelIds[] = {4001,4002,4003,4004,4005,4006,4007,4008,4009,4010};
  int editIds[] = {kIdFingerprint,kIdHostname,kIdName,kIdCompany,kIdEmail,0,kIdDays,kIdSeats,kIdAppVer,kIdNotes};
  for (int i = 0; i < 10; i++) {
    AddChild(hwnd, L"STATIC", labels[i], SS_LEFT | SS_NOPREFIX, labelIds[i], 0, 0, 80, 16);
    if (i == 5) {
      g.edition = AddChild(hwnd, L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, kIdEdition, 0, 0, 80, 200);
    } else if (i == 9) {
      AddChild(hwnd, L"EDIT", L"", ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN | WS_VSCROLL | WS_TABSTOP | WS_BORDER,
               kIdNotes, 0, 0, 80, 40, WS_EX_CLIENTEDGE);
    } else {
      DWORD style = ES_AUTOHSCROLL | WS_TABSTOP | WS_BORDER;
      HWND e = AddChild(hwnd, L"EDIT", L"", style, editIds[i], 0, 0, 80, 20, WS_EX_CLIENTEDGE);
      if (editIds[i] == kIdDays) SetWindowTextW(e, L"365");
      if (editIds[i] == kIdSeats) SetWindowTextW(e, L"1");
      if (editIds[i] == kIdAppVer) SetWindowTextW(e, L"1.0.0");
    }
  }
  AddChild(hwnd, L"BUTTON", L"导入激活请求", BS_PUSHBUTTON | WS_TABSTOP, kIdBtnImport, 0, 0, 80, 24);
  AddChild(hwnd, L"BUTTON", L"全选", BS_PUSHBUTTON | WS_TABSTOP, kIdBtnAll, 0, 0, 80, 24);
  AddChild(hwnd, L"BUTTON", L"基础浏览", BS_PUSHBUTTON | WS_TABSTOP, kIdBtnData, 0, 0, 80, 24);
  AddChild(hwnd, L"BUTTON", L"仅基础", BS_PUSHBUTTON | WS_TABSTOP, kIdBtnCore, 0, 0, 80, 24);
  g.btnIssue = AddChild(hwnd, L"BUTTON", L"签发并保存", BS_DEFPUSHBUTTON | WS_TABSTOP, kIdBtnIssue, 0, 0, 80, 24);
  g.issueStatus = AddChild(hwnd, L"EDIT", L"",
                           ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL | WS_BORDER, kIdIssueStatus,
                           0, 0, 80, 40, WS_EX_CLIENTEDGE);

  AddChild(hwnd, L"BUTTON", L"开放功能", BS_GROUPBOX, 3003, 0, 0, 100, 100);
  g.featureCount = AddChild(hwnd, L"STATIC", L"已开放 0 / 0 项", SS_LEFT | SS_NOPREFIX, kIdFeatureCount, 0, 0, 80, 16);
  g.featureHost = CreateWindowExW(WS_EX_CLIENTEDGE, kScrollClass, L"",
                                  WS_CHILD | WS_VISIBLE | WS_VSCROLL | WS_TABSTOP,
                                  0, 0, 100, 100, hwnd, (HMENU)kIdFeatureHost, GetModuleHandleW(nullptr), nullptr);
  ApplyFont(g.featureHost);

  AddChild(hwnd, L"BUTTON", L"校验许可证", BS_GROUPBOX, 3004, 0, 0, 100, 100);
  AddChild(hwnd, L"BUTTON", L"选择并校验", BS_PUSHBUTTON | WS_TABSTOP, kIdBtnVerify, 0, 0, 80, 24);
  g.verifyStatus = AddChild(hwnd, L"EDIT", L"",
                            ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL | WS_BORDER, kIdVerifyStatus,
                            0, 0, 80, 40, WS_EX_CLIENTEDGE);

  Relayout();
  LoadMeta();
  RefreshKeys();
}

LRESULT CALLBACK MainProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
  switch (msg) {
    case WM_CREATE:
      CreateMainUi(hwnd);
      return 0;
    case WM_DPICHANGED: {
      g.dpi = HIWORD(wParam);
      RecreateFont(hwnd);
      EnumChildWindows(hwnd, [](HWND child, LPARAM) -> BOOL {
        ApplyFont(child);
        return TRUE;
      }, 0);
      RECT* r = (RECT*)lParam;
      SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      Relayout();
      return 0;
    }
    case WM_SIZE:
      Relayout();
      return 0;
    case WM_GETMINMAXINFO: {
      auto* m = (MINMAXINFO*)lParam;
      m->ptMinTrackSize.x = g.Scale(900);
      m->ptMinTrackSize.y = g.Scale(700);
      return 0;
    }
    case WM_COMMAND: {
      int id = LOWORD(wParam);
      int code = HIWORD(wParam);
      if (code == BN_CLICKED) {
        switch (id) {
          case kIdBtnRefresh: RefreshKeys(); break;
          case kIdBtnGen: OnGenerateKeys(); break;
          case kIdBtnSync: OnSyncPub(); break;
          case kIdBtnImport: OnImportRequest(); break;
          case kIdBtnAll: SelectAllFeatures(); break;
          case kIdBtnData: SelectDataFeatures(); break;
          case kIdBtnCore: SelectCoreFeatures(); break;
          case kIdBtnIssue: OnIssue(); break;
          case kIdBtnVerify: OnVerify(); break;
          default:
            if (id >= kIdFeatureBase) UpdateFeatureCount();
            break;
        }
      }
      return 0;
    }
    case WM_CTLCOLORSTATIC:
    case WM_CTLCOLOREDIT: {
      HDC hdc = (HDC)wParam;
      SetBkColor(hdc, GetSysColor(COLOR_WINDOW));
      SetTextColor(hdc, GetSysColor(COLOR_WINDOWTEXT));
      return (LRESULT)GetSysColorBrush(COLOR_WINDOW);
    }
    case WM_DESTROY:
      if (g.font) DeleteObject(g.font);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(hwnd, msg, wParam, lParam);
}

int RunSmoke(const Paths& paths, const std::wstring& outFile) {
  auto meta = RunEngine(paths, {L"meta"});
  Json report = Json::object();
  report["ok"] = Json::fromBool(meta.ok);
  if (!meta.ok) {
    report["error"] = Json::string(meta.error);
  } else {
    report["product"] = Json::string(meta.json.str("product"));
    report["featureCount"] = Json::numberInt((int)meta.json.get("featureCatalog").a.size());
    report["engine"] = Json::string(WideToUtf8(paths.engineJs));
    report["node"] = Json::string(WideToUtf8(paths.nodeExe));
  }
  std::string text = report.stringify();
  if (!outFile.empty()) {
    HANDLE h = CreateFileW(outFile.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return 2;
    std::string line = text + "\n";
    DWORD written = 0;
    BOOL wrok = WriteFile(h, line.data(), (DWORD)line.size(), &written, nullptr);
    CloseHandle(h);
    if (!wrok) return 2;
  }
  return meta.ok ? 0 : 1;
}

std::wstring ArgValue(const std::vector<std::wstring>& args, const std::wstring& name) {
  for (size_t i = 0; i + 1 < args.size(); i++) {
    if (args[i] == name) return args[i + 1];
  }
  return {};
}

bool HasArg(const std::vector<std::wstring>& args, const std::wstring& name) {
  return std::find(args.begin(), args.end(), name) != args.end();
}

}  // namespace

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR cmdLine, int show) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  std::vector<std::wstring> args;
  for (int i = 1; i < argc; i++) args.push_back(argv[i]);
  LocalFree(argv);
  (void)cmdLine;

  g.paths = DetectPaths();
  std::wstring testRoot = ArgValue(args, L"--test-root");
  if (!testRoot.empty()) ApplyTestRoot(&g.paths, testRoot);

  if (HasArg(args, L"--smoke")) {
    std::wstring out = ArgValue(args, L"--out");
    int rc = RunSmoke(g.paths, out);
    return rc;
  }

  INITCOMMONCONTROLSEX icc{sizeof(icc), ICC_WIN95_CLASSES | ICC_STANDARD_CLASSES};
  InitCommonControlsEx(&icc);

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = MainProc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.hbrBackground = GetSysColorBrush(COLOR_BTNFACE);
  wc.lpszClassName = kMainClass;
  wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
  RegisterClassExW(&wc);

  WNDCLASSEXW sc = wc;
  sc.lpfnWndProc = ScrollProc;
  sc.lpszClassName = kScrollClass;
  sc.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
  RegisterClassExW(&sc);

  HWND hwnd = CreateWindowExW(
    0, kMainClass, kTitle, WS_OVERLAPPEDWINDOW | WS_VISIBLE,
    CW_USEDEFAULT, CW_USEDEFAULT, 1180, 900,
    nullptr, nullptr, inst, nullptr);
  if (!hwnd) return 1;
  g.dpi = GetDpiForWindow(hwnd);
  ShowWindow(hwnd, show);
  UpdateWindow(hwnd);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0)) {
    if (!IsDialogMessageW(hwnd, &msg)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
  }
  return (int)msg.wParam;
}

#ifdef __clang__
// keep MSVC entry
#endif
