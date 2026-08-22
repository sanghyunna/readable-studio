// Windows compatibility helper: Node has no standard binding for AppContainer
// tokens, STARTUPINFOEX security capabilities, filesystem ACLs, or Job Objects.
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>

#include <aclapi.h>
#include <bcrypt.h>
#include <io.h>
#include <sddl.h>
#include <userenv.h>
#include <ws2tcpip.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cwctype>
#include <filesystem>
#include <map>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace {

constexpr DWORD kHelperFailureExitCode = 125;
constexpr size_t kMaxRequestBytes = 4 * 1024 * 1024;

class Handle {
 public:
  Handle() = default;
  explicit Handle(HANDLE value) : value_(value) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value_(other.release()) {}
  Handle& operator=(Handle&& other) noexcept {
    if (this != &other) reset(other.release());
    return *this;
  }
  ~Handle() { reset(); }

  HANDLE get() const { return value_; }
  explicit operator bool() const { return value_ != nullptr && value_ != INVALID_HANDLE_VALUE; }
  HANDLE release() {
    HANDLE value = value_;
    value_ = nullptr;
    return value;
  }
  void reset(HANDLE value = nullptr) {
    if (*this) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = nullptr;
};

class LocalMemory {
 public:
  LocalMemory() = default;
  explicit LocalMemory(void* value) : value_(value) {}
  LocalMemory(const LocalMemory&) = delete;
  LocalMemory& operator=(const LocalMemory&) = delete;
  ~LocalMemory() {
    if (value_) LocalFree(value_);
  }
  void* get() const { return value_; }
  void reset(void* value = nullptr) {
    if (value_) LocalFree(value_);
    value_ = value;
  }

 private:
  void* value_ = nullptr;
};

std::wstring Utf8ToWide(std::string_view value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) throw std::runtime_error("request is not valid UTF-8");
  std::wstring output(static_cast<size_t>(size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output.data(), size) != size) {
    throw std::runtime_error("failed to decode UTF-8 request");
  }
  return output;
}

std::string WideToUtf8(std::wstring_view value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) throw std::runtime_error("failed to encode UTF-8 output");
  std::string output(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output.data(), size, nullptr, nullptr) != size) {
    throw std::runtime_error("failed to encode UTF-8 output");
  }
  return output;
}

std::string JsonEscape(std::wstring_view value) {
  std::string output = "\"";
  for (const unsigned char byte : WideToUtf8(value)) {
    switch (byte) {
      case '\"': output += "\\\""; break;
      case '\\': output += "\\\\"; break;
      case '\b': output += "\\b"; break;
      case '\f': output += "\\f"; break;
      case '\n': output += "\\n"; break;
      case '\r': output += "\\r"; break;
      case '\t': output += "\\t"; break;
      default:
        if (byte < 0x20) {
          constexpr char hex[] = "0123456789abcdef";
          output += "\\u00";
          output += hex[(byte >> 4) & 0x0f];
          output += hex[byte & 0x0f];
        } else {
          output += static_cast<char>(byte);
        }
    }
  }
  output += '\"';
  return output;
}

std::string Win32Message(std::string_view context, DWORD error) {
  wchar_t* raw = nullptr;
  const DWORD size = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr,
      error,
      0,
      reinterpret_cast<wchar_t*>(&raw),
      0,
      nullptr);
  LocalMemory message(raw);
  std::wstring detail = size == 0 ? L"Windows error " + std::to_wstring(error) : std::wstring(raw, size);
  while (!detail.empty() && (detail.back() == L'\r' || detail.back() == L'\n' || detail.back() == L' ')) detail.pop_back();
  return std::string(context) + ": " + WideToUtf8(detail);
}

[[noreturn]] void ThrowLastError(std::string_view context) {
  throw std::runtime_error(Win32Message(context, GetLastError()));
}

[[noreturn]] void ThrowWin32(std::string_view context, DWORD error) {
  throw std::runtime_error(Win32Message(context, error));
}

[[noreturn]] void ThrowHresult(std::string_view context, HRESULT result) {
  throw std::runtime_error(std::string(context) + ": HRESULT 0x" + [&] {
    constexpr char hex[] = "0123456789abcdef";
    std::string value(8, '0');
    const uint32_t number = static_cast<uint32_t>(result);
    for (size_t index = 0; index < value.size(); ++index) value[index] = hex[(number >> ((7 - index) * 4)) & 0x0f];
    return value;
  }());
}

void WriteAll(HANDLE handle, const void* data, size_t size) {
  const auto* bytes = static_cast<const std::byte*>(data);
  while (size > 0) {
    DWORD written = 0;
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(size, 64 * 1024));
    if (!WriteFile(handle, bytes, chunk, &written, nullptr) || written == 0) return;
    bytes += written;
    size -= written;
  }
}

void WriteUtf8(HANDLE handle, const std::string& value) {
  if (handle && handle != INVALID_HANDLE_VALUE) WriteAll(handle, value.data(), value.size());
}

bool ReadExact(HANDLE handle, void* data, size_t size) {
  auto* bytes = static_cast<std::byte*>(data);
  while (size > 0) {
    DWORD read = 0;
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(size, 64 * 1024));
    if (!ReadFile(handle, bytes, chunk, &read, nullptr) || read == 0) return false;
    bytes += read;
    size -= read;
  }
  return true;
}

std::string ReadFrame(HANDLE handle) {
  uint32_t size = 0;
  if (!ReadExact(handle, &size, sizeof(size))) throw std::runtime_error("broker channel closed");
  if (size > kMaxRequestBytes) throw std::runtime_error("broker frame exceeds 4 MiB");
  std::string value(size, '\0');
  if (size > 0 && !ReadExact(handle, value.data(), value.size())) throw std::runtime_error("broker frame ended early");
  return value;
}

void WriteFrame(HANDLE handle, const std::string& value) {
  if (value.size() > kMaxRequestBytes) throw std::runtime_error("broker frame exceeds 4 MiB");
  const uint32_t size = static_cast<uint32_t>(value.size());
  WriteAll(handle, &size, sizeof(size));
  WriteAll(handle, value.data(), value.size());
}

HANDLE ControlHandle() {
  const intptr_t raw = _get_osfhandle(3);
  return raw == -1 ? INVALID_HANDLE_VALUE : reinterpret_cast<HANDLE>(raw);
}

void WriteControlReady(const std::wstring& profile_name) {
  WriteUtf8(ControlHandle(), "{\"status\":\"ready\",\"profileName\":" + JsonEscape(profile_name) + "}\n");
}

void WriteControlError(const std::string& error) {
  WriteUtf8(ControlHandle(), "{\"status\":\"error\",\"error\":" + JsonEscape(Utf8ToWide(error)) + "}\n");
}

struct JsonValue {
  enum class Type { kNull, kBoolean, kString, kArray, kObject };
  Type type = Type::kNull;
  bool boolean = false;
  std::wstring string;
  std::vector<JsonValue> array;
  std::map<std::wstring, JsonValue> object;
};

class JsonParser {
 public:
  explicit JsonParser(std::wstring_view input) : input_(input) {}

  JsonValue Parse() {
    JsonValue value = ParseValue();
    SkipWhitespace();
    if (position_ != input_.size()) throw std::runtime_error("unexpected characters after JSON request");
    return value;
  }

 private:
  void SkipWhitespace() {
    while (position_ < input_.size() && (input_[position_] == L' ' || input_[position_] == L'\t' || input_[position_] == L'\r' || input_[position_] == L'\n')) ++position_;
  }

  wchar_t Take() {
    if (position_ >= input_.size()) throw std::runtime_error("unexpected end of JSON request");
    return input_[position_++];
  }

  void Expect(wchar_t expected) {
    if (Take() != expected) throw std::runtime_error("invalid JSON request");
  }

  bool Consume(std::wstring_view token) {
    if (input_.substr(position_, token.size()) != token) return false;
    position_ += token.size();
    return true;
  }

  static unsigned Hex(wchar_t value) {
    if (value >= L'0' && value <= L'9') return static_cast<unsigned>(value - L'0');
    if (value >= L'a' && value <= L'f') return static_cast<unsigned>(value - L'a' + 10);
    if (value >= L'A' && value <= L'F') return static_cast<unsigned>(value - L'A' + 10);
    throw std::runtime_error("invalid JSON Unicode escape");
  }

  std::wstring ParseString() {
    Expect(L'\"');
    std::wstring output;
    while (true) {
      const wchar_t value = Take();
      if (value == L'\"') return output;
      if (value < 0x20) throw std::runtime_error("unescaped control character in JSON string");
      if (value != L'\\') {
        output += value;
        continue;
      }
      switch (Take()) {
        case L'\"': output += L'\"'; break;
        case L'\\': output += L'\\'; break;
        case L'/': output += L'/'; break;
        case L'b': output += L'\b'; break;
        case L'f': output += L'\f'; break;
        case L'n': output += L'\n'; break;
        case L'r': output += L'\r'; break;
        case L't': output += L'\t'; break;
        case L'u': {
          unsigned code_unit = 0;
          for (int index = 0; index < 4; ++index) code_unit = (code_unit << 4) | Hex(Take());
          output += static_cast<wchar_t>(code_unit);
          break;
        }
        default: throw std::runtime_error("invalid JSON escape");
      }
    }
  }

  JsonValue ParseValue() {
    SkipWhitespace();
    if (position_ >= input_.size()) throw std::runtime_error("missing JSON value");
    if (input_[position_] == L'\"') {
      JsonValue value;
      value.type = JsonValue::Type::kString;
      value.string = ParseString();
      return value;
    }
    if (input_[position_] == L'[') return ParseArray();
    if (input_[position_] == L'{') return ParseObject();
    if (Consume(L"true")) {
      JsonValue value;
      value.type = JsonValue::Type::kBoolean;
      value.boolean = true;
      return value;
    }
    if (Consume(L"false")) {
      JsonValue value;
      value.type = JsonValue::Type::kBoolean;
      return value;
    }
    if (Consume(L"null")) return {};
    throw std::runtime_error("unsupported JSON value in request");
  }

  JsonValue ParseArray() {
    JsonValue value;
    value.type = JsonValue::Type::kArray;
    Expect(L'[');
    SkipWhitespace();
    if (position_ < input_.size() && input_[position_] == L']') {
      ++position_;
      return value;
    }
    while (true) {
      value.array.push_back(ParseValue());
      SkipWhitespace();
      const wchar_t separator = Take();
      if (separator == L']') return value;
      if (separator != L',') throw std::runtime_error("invalid JSON array");
    }
  }

  JsonValue ParseObject() {
    JsonValue value;
    value.type = JsonValue::Type::kObject;
    Expect(L'{');
    SkipWhitespace();
    if (position_ < input_.size() && input_[position_] == L'}') {
      ++position_;
      return value;
    }
    while (true) {
      SkipWhitespace();
      if (position_ >= input_.size() || input_[position_] != L'\"') throw std::runtime_error("JSON object key must be a string");
      std::wstring key = ParseString();
      SkipWhitespace();
      Expect(L':');
      if (!value.object.emplace(std::move(key), ParseValue()).second) throw std::runtime_error("duplicate JSON object key");
      SkipWhitespace();
      const wchar_t separator = Take();
      if (separator == L'}') return value;
      if (separator != L',') throw std::runtime_error("invalid JSON object");
    }
  }

  std::wstring_view input_;
  size_t position_ = 0;
};

std::string ReadRequestLine() {
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
  if (!input || input == INVALID_HANDLE_VALUE) throw std::runtime_error("helper stdin is unavailable");
  std::string request;
  request.reserve(16 * 1024);
  while (request.size() <= kMaxRequestBytes) {
    char byte = '\0';
    DWORD read = 0;
    if (!ReadFile(input, &byte, 1, &read, nullptr)) ThrowLastError("read helper request");
    if (read == 0) throw std::runtime_error("helper request ended before newline");
    if (byte == '\n') return request;
    request += byte;
  }
  throw std::runtime_error("helper request exceeds 4 MiB");
}

const JsonValue& RequiredField(const JsonValue& object, std::wstring_view name, JsonValue::Type type) {
  if (object.type != JsonValue::Type::kObject) throw std::runtime_error("helper request must be a JSON object");
  const auto found = object.object.find(std::wstring(name));
  if (found == object.object.end()) throw std::runtime_error("helper request is missing " + WideToUtf8(name));
  if (found->second.type != type) throw std::runtime_error("helper request field has the wrong type: " + WideToUtf8(name));
  return found->second;
}

std::wstring OptionalStringField(const JsonValue& object, std::wstring_view name) {
  if (object.type != JsonValue::Type::kObject) throw std::runtime_error("helper request must be a JSON object");
  const auto found = object.object.find(std::wstring(name));
  if (found == object.object.end()) return {};
  if (found->second.type != JsonValue::Type::kString) throw std::runtime_error("helper request field has the wrong type: " + WideToUtf8(name));
  return found->second.string;
}

std::vector<std::wstring> StringArray(const JsonValue& object, std::wstring_view name) {
  const JsonValue& array = RequiredField(object, name, JsonValue::Type::kArray);
  std::vector<std::wstring> values;
  values.reserve(array.array.size());
  for (const JsonValue& value : array.array) {
    if (value.type != JsonValue::Type::kString) throw std::runtime_error("helper request array contains a non-string: " + WideToUtf8(name));
    if (value.string.find(L'\0') != std::wstring::npos) throw std::runtime_error("helper request string contains NUL");
    values.push_back(value.string);
  }
  return values;
}

struct Request {
  std::wstring command;
  std::vector<std::wstring> args;
  std::wstring cwd;
  std::map<std::wstring, std::wstring> env;
  std::vector<std::wstring> read_execute_paths;
  std::vector<std::wstring> writable_paths;
  bool windows_verbatim_arguments = false;
  std::wstring broker_pipe_name;
};

Request ParseRequest(const std::string& input) {
  const JsonValue root = JsonParser(Utf8ToWide(input)).Parse();
  Request request;
  request.command = RequiredField(root, L"command", JsonValue::Type::kString).string;
  request.args = StringArray(root, L"args");
  request.cwd = RequiredField(root, L"cwd", JsonValue::Type::kString).string;
  request.read_execute_paths = StringArray(root, L"readExecutePaths");
  request.writable_paths = StringArray(root, L"writablePaths");
  request.windows_verbatim_arguments = RequiredField(root, L"windowsVerbatimArguments", JsonValue::Type::kBoolean).boolean;
  request.broker_pipe_name = OptionalStringField(root, L"brokerPipeName");
  const JsonValue& env = RequiredField(root, L"env", JsonValue::Type::kObject);
  for (const auto& [key, value] : env.object) {
    if (value.type != JsonValue::Type::kString || key.empty() || key.find(L'=') != std::wstring::npos || key.find(L'\0') != std::wstring::npos || value.string.find(L'\0') != std::wstring::npos) {
      throw std::runtime_error("helper request contains an invalid environment entry");
    }
    request.env.emplace(key, value.string);
  }
  if (request.command.empty() || request.cwd.empty()) throw std::runtime_error("helper request command and cwd must be non-empty");
  if (!request.broker_pipe_name.empty()) {
    constexpr std::wstring_view prefix = L"\\\\.\\pipe\\LOCAL\\ReadableStudio.";
    if (!request.broker_pipe_name.starts_with(prefix) || request.broker_pipe_name.size() > prefix.size() + 160) {
      throw std::runtime_error("isolated broker pipe name is invalid");
    }
    for (const wchar_t value : request.broker_pipe_name.substr(prefix.size())) {
      if (!iswalnum(value) && value != L'.' && value != L'-') throw std::runtime_error("isolated broker pipe name is invalid");
    }
  }
  return request;
}

std::wstring FullPath(const std::wstring& input) {
  if (input.empty() || !std::filesystem::path(input).is_absolute()) throw std::runtime_error("isolated paths must be absolute");
  DWORD size = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  if (size == 0) ThrowLastError("resolve isolated path");
  std::wstring output(size, L'\0');
  const DWORD written = GetFullPathNameW(input.c_str(), size, output.data(), nullptr);
  if (written == 0 || written >= size) ThrowLastError("resolve isolated path");
  output.resize(written);
  while (output.size() > 3 && (output.back() == L'\\' || output.back() == L'/')) output.pop_back();
  return output;
}

DWORD PathAttributes(const std::wstring& path) {
  const DWORD attributes = GetFileAttributesW(path.c_str());
  if (attributes == INVALID_FILE_ATTRIBUTES) ThrowLastError("inspect isolated path " + WideToUtf8(path));
  return attributes;
}

void RequireNoReparsePoint(const std::wstring& path, DWORD attributes) {
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    throw std::runtime_error("isolated grant path must not be a reparse point: " + WideToUtf8(path));
  }
}

void RequirePersistentAcls(const std::wstring& path) {
  std::array<wchar_t, MAX_PATH + 1> volume_path{};
  if (!GetVolumePathNameW(path.c_str(), volume_path.data(), static_cast<DWORD>(volume_path.size()))) {
    ThrowLastError("resolve volume for " + WideToUtf8(path));
  }
  DWORD flags = 0;
  if (!GetVolumeInformationW(volume_path.data(), nullptr, 0, nullptr, nullptr, &flags, nullptr, 0)) {
    ThrowLastError("inspect filesystem for " + WideToUtf8(path));
  }
  if ((flags & FILE_PERSISTENT_ACLS) == 0) throw std::runtime_error("filesystem does not support persistent ACLs: " + WideToUtf8(path));
}

struct CaseInsensitivePathLess {
  bool operator()(const std::wstring& left, const std::wstring& right) const {
    return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(), static_cast<int>(right.size()), TRUE) == CSTR_LESS_THAN;
  }
};

struct GrantSpec {
  DWORD permissions = 0;
  DWORD inheritance = NO_INHERITANCE;
};

bool PathContains(const std::wstring& parent, const std::wstring& child) {
  if (child.size() < parent.size()) return false;
  if (CompareStringOrdinal(parent.c_str(), static_cast<int>(parent.size()), child.c_str(), static_cast<int>(parent.size()), TRUE) != CSTR_EQUAL) {
    return false;
  }
  return child.size() == parent.size() || parent.back() == L'\\' || child[parent.size()] == L'\\';
}

void ChangePathAccess(const std::wstring& path, PSID sid, const GrantSpec* grant) {
  // ponytail: one named ACL mutex; shard by volume only if launch contention is measurable.
  Handle acl_mutex(CreateMutexW(nullptr, FALSE, L"Local\\ReadableStudio.AgentIsolator.Acl.v1"));
  if (!acl_mutex) ThrowLastError("create AppContainer ACL mutex");
  const DWORD wait_result = WaitForSingleObject(acl_mutex.get(), 30'000);
  if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED) {
    if (wait_result == WAIT_TIMEOUT) throw std::runtime_error("timed out waiting for AppContainer ACL mutex");
    ThrowLastError("wait for AppContainer ACL mutex");
  }
  struct MutexRelease {
    HANDLE value;
    ~MutexRelease() { ReleaseMutex(value); }
  } mutex_release{acl_mutex.get()};

  PACL old_acl = nullptr;
  PSECURITY_DESCRIPTOR raw_descriptor = nullptr;
  const DWORD read_result = GetNamedSecurityInfoW(
      path.c_str(), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &old_acl, nullptr, &raw_descriptor);
  if (read_result != ERROR_SUCCESS) ThrowWin32("read ACL for " + WideToUtf8(path), read_result);
  LocalMemory descriptor(raw_descriptor);

  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = grant ? grant->permissions : 0;
  access.grfAccessMode = grant ? GRANT_ACCESS : REVOKE_ACCESS;
  access.grfInheritance = grant ? grant->inheritance : NO_INHERITANCE;
  BuildTrusteeWithSidW(&access.Trustee, sid);
  PACL raw_new_acl = nullptr;
  const DWORD merge_result = SetEntriesInAclW(1, &access, old_acl, &raw_new_acl);
  if (merge_result != ERROR_SUCCESS) ThrowWin32("update ACL for " + WideToUtf8(path), merge_result);
  LocalMemory new_acl(raw_new_acl);
  const DWORD write_result = SetNamedSecurityInfoW(
      const_cast<wchar_t*>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, raw_new_acl, nullptr);
  if (write_result != ERROR_SUCCESS) ThrowWin32("write ACL for " + WideToUtf8(path), write_result);
}

class AclGrants {
 public:
  explicit AclGrants(PSID sid) : sid_(sid) {}
  AclGrants(const AclGrants&) = delete;
  AclGrants& operator=(const AclGrants&) = delete;
  ~AclGrants() { CleanupBestEffort(); }

  void Add(const std::wstring& path, const GrantSpec& grant) {
    ChangePathAccess(path, sid_, &grant);
    paths_.push_back(path);
  }

  void Cleanup() {
    std::optional<std::string> first_error;
    for (auto path = paths_.rbegin(); path != paths_.rend(); ++path) {
      try {
        ChangePathAccess(*path, sid_, nullptr);
      } catch (const std::exception& error) {
        if (!first_error) first_error = error.what();
      }
    }
    paths_.clear();
    if (first_error) throw std::runtime_error("failed to remove AppContainer ACL: " + *first_error);
  }

 private:
  void CleanupBestEffort() noexcept {
    for (auto path = paths_.rbegin(); path != paths_.rend(); ++path) {
      try {
        ChangePathAccess(*path, sid_, nullptr);
      } catch (...) {
      }
    }
    paths_.clear();
  }

  PSID sid_;
  std::vector<std::wstring> paths_;
};

std::wstring UniqueProfileName() {
  std::array<unsigned char, 12> random{};
  if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    throw std::runtime_error("secure random generation failed");
  }
  constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring suffix;
  suffix.reserve(random.size() * 2);
  for (const unsigned char value : random) {
    suffix += hex[(value >> 4) & 0x0f];
    suffix += hex[value & 0x0f];
  }
  return L"ReadableStudio.Agent." + std::to_wstring(GetCurrentProcessId()) + L"." + suffix;
}

class AppContainerProfile {
 public:
  AppContainerProfile() : name_(UniqueProfileName()) {
    const HRESULT result = CreateAppContainerProfile(name_.c_str(), L"isolated agent", L"Ephemeral sandbox", nullptr, 0, &sid_);
    if (FAILED(result)) ThrowHresult("create AppContainer profile", result);
    active_ = true;
  }
  AppContainerProfile(const AppContainerProfile&) = delete;
  AppContainerProfile& operator=(const AppContainerProfile&) = delete;
  ~AppContainerProfile() {
    if (active_) DeleteAppContainerProfile(name_.c_str());
    if (sid_) FreeSid(sid_);
  }

  const std::wstring& name() const { return name_; }
  PSID sid() const { return sid_; }

  void Delete() {
    if (!active_) return;
    const HRESULT result = DeleteAppContainerProfile(name_.c_str());
    if (FAILED(result)) ThrowHresult("delete AppContainer profile", result);
    active_ = false;
  }

 private:
  std::wstring name_;
  PSID sid_ = nullptr;
  bool active_ = false;
};

std::vector<wchar_t> EnvironmentBlock(const std::map<std::wstring, std::wstring>& env) {
  std::vector<std::pair<std::wstring, std::wstring>> entries(env.begin(), env.end());
  std::sort(entries.begin(), entries.end(), [](const auto& left, const auto& right) {
    return CompareStringOrdinal(left.first.c_str(), -1, right.first.c_str(), -1, TRUE) == CSTR_LESS_THAN;
  });
  size_t size = 1;
  for (const auto& [key, value] : entries) size += key.size() + value.size() + 2;
  std::vector<wchar_t> block;
  block.reserve(size);
  for (const auto& [key, value] : entries) {
    block.insert(block.end(), key.begin(), key.end());
    block.push_back(L'=');
    block.insert(block.end(), value.begin(), value.end());
    block.push_back(L'\0');
  }
  block.push_back(L'\0');
  if (entries.empty()) block.push_back(L'\0');
  return block;
}

std::wstring QuoteArgument(const std::wstring& argument) {
  if (!argument.empty() && argument.find_first_of(L" \t\n\v\"") == std::wstring::npos) return argument;
  std::wstring output = L"\"";
  size_t backslashes = 0;
  for (const wchar_t value : argument) {
    if (value == L'\\') {
      ++backslashes;
    } else if (value == L'\"') {
      output.append(backslashes * 2 + 1, L'\\');
      output += L'\"';
      backslashes = 0;
    } else {
      output.append(backslashes, L'\\');
      backslashes = 0;
      output += value;
    }
  }
  output.append(backslashes * 2, L'\\');
  output += L'\"';
  return output;
}

std::wstring CommandLine(const Request& request) {
  std::wstring line = QuoteArgument(request.command);
  for (const std::wstring& argument : request.args) {
    line += L' ';
    line += request.windows_verbatim_arguments ? argument : QuoteArgument(argument);
  }
  return line;
}

void MakePipe(Handle& read, Handle& write, bool child_reads) {
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  HANDLE raw_read = nullptr;
  HANDLE raw_write = nullptr;
  if (!CreatePipe(&raw_read, &raw_write, &security, 0)) ThrowLastError("create child stdio pipe");
  read.reset(raw_read);
  write.reset(raw_write);
  HANDLE parent_end = child_reads ? write.get() : read.get();
  if (!SetHandleInformation(parent_end, HANDLE_FLAG_INHERIT, 0)) ThrowLastError("protect parent stdio pipe handle");
}

Handle CreateBrokerPipe(const std::wstring& name, PSID app_container_sid) {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) ThrowLastError("open isolated broker token");
  Handle token(raw_token);
  DWORD user_size = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &user_size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || user_size == 0) ThrowLastError("size isolated broker user SID");
  std::vector<std::byte> user_storage(user_size);
  if (!GetTokenInformation(token.get(), TokenUser, user_storage.data(), user_size, &user_size)) {
    ThrowLastError("read isolated broker user SID");
  }
  const auto* user = reinterpret_cast<const TOKEN_USER*>(user_storage.data());
  std::array<EXPLICIT_ACCESSW, 2> access{};
  for (EXPLICIT_ACCESSW& entry : access) {
    entry.grfAccessPermissions = GENERIC_READ | GENERIC_WRITE;
    entry.grfAccessMode = SET_ACCESS;
    entry.grfInheritance = NO_INHERITANCE;
  }
  BuildTrusteeWithSidW(&access[0].Trustee, app_container_sid);
  BuildTrusteeWithSidW(&access[1].Trustee, user->User.Sid);
  PACL raw_acl = nullptr;
  const DWORD acl_result = SetEntriesInAclW(static_cast<ULONG>(access.size()), access.data(), nullptr, &raw_acl);
  if (acl_result != ERROR_SUCCESS) ThrowWin32("create isolated broker ACL", acl_result);
  LocalMemory acl(raw_acl);
  SECURITY_DESCRIPTOR descriptor{};
  if (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION)) {
    ThrowLastError("initialize isolated broker security descriptor");
  }
  if (!SetSecurityDescriptorDacl(&descriptor, TRUE, raw_acl, FALSE)) {
    ThrowLastError("set isolated broker DACL");
  }
  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.lpSecurityDescriptor = &descriptor;
  Handle pipe(CreateNamedPipeW(
      name.c_str(),
      PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
      1,
      static_cast<DWORD>(kMaxRequestBytes),
      static_cast<DWORD>(kMaxRequestBytes),
      0,
      &security));
  if (!pipe) ThrowLastError("create isolated broker named pipe");
  return pipe;
}

void ServeBrokerPipe(HANDLE pipe, HANDLE control_input, HANDLE control_output) {
  while (true) {
    if (!ConnectNamedPipe(pipe, nullptr) && GetLastError() != ERROR_PIPE_CONNECTED) return;
    try {
      WriteFrame(control_output, ReadFrame(pipe));
      WriteFrame(pipe, ReadFrame(control_input));
      FlushFileBuffers(pipe);
    } catch (...) {
      DisconnectNamedPipe(pipe);
      throw;
    }
    DisconnectNamedPipe(pipe);
  }
}

std::vector<std::byte> CurrentAppContainerSid() {
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) ThrowLastError("open broker proxy token");
  Handle token(raw_token);
  DWORD size = 0;
  GetTokenInformation(token.get(), TokenAppContainerSid, nullptr, 0, &size);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || size == 0) throw std::runtime_error("broker proxy is not in an AppContainer");
  std::vector<std::byte> storage(size);
  if (!GetTokenInformation(token.get(), TokenAppContainerSid, storage.data(), size, &size)) {
    ThrowLastError("read broker proxy AppContainer SID");
  }
  const auto* information = reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(storage.data());
  if (!information->TokenAppContainer) throw std::runtime_error("broker proxy is not in an AppContainer");
  return storage;
}

int RunBrokerProxy(int argc, wchar_t** argv) {
  if (argc != 3) return kHelperFailureExitCode;
  std::vector<std::byte> sid_storage = CurrentAppContainerSid();
  const auto* information = reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(sid_storage.data());
  Handle pipe = CreateBrokerPipe(argv[2], information->TokenAppContainer);
  ServeBrokerPipe(pipe.get(), GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE));
  return 0;
}

void CopyStream(HANDLE source, HANDLE destination, bool close_destination) {
  std::array<std::byte, 64 * 1024> buffer{};
  while (true) {
    DWORD read = 0;
    if (!ReadFile(source, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) || read == 0) break;
    WriteAll(destination, buffer.data(), read);
  }
  CloseHandle(source);
  if (close_destination) CloseHandle(destination);
}

std::wstring ModulePath();

std::map<std::wstring, GrantSpec, CaseInsensitivePathLess> RequestedGrants(Request& request) {
  request.cwd = FullPath(request.cwd);
  const DWORD cwd_attributes = PathAttributes(request.cwd);
  RequireNoReparsePoint(request.cwd, cwd_attributes);
  if ((cwd_attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) throw std::runtime_error("isolated cwd is not a directory");

  std::map<std::wstring, GrantSpec, CaseInsensitivePathLess> grants;
  const GrantSpec read_execute{FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, SUB_CONTAINERS_AND_OBJECTS_INHERIT};
  const GrantSpec writable{FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE, SUB_CONTAINERS_AND_OBJECTS_INHERIT};
  for (std::wstring& path : request.read_execute_paths) {
    path = FullPath(path);
    const DWORD attributes = PathAttributes(path);
    RequireNoReparsePoint(path, attributes);
    RequirePersistentAcls(path);
    GrantSpec grant = read_execute;
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) grant.inheritance = NO_INHERITANCE;
    grants[path] = grant;
  }
  for (std::wstring& path : request.writable_paths) {
    path = FullPath(path);
    const DWORD attributes = PathAttributes(path);
    RequireNoReparsePoint(path, attributes);
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) throw std::runtime_error("isolated writable path is not a directory");
    RequirePersistentAcls(path);
    grants[path] = writable;
  }
  if (!request.broker_pipe_name.empty()) {
    std::wstring helper_dir = FullPath(std::filesystem::path(ModulePath()).parent_path().wstring());
    const DWORD attributes = PathAttributes(helper_dir);
    RequireNoReparsePoint(helper_dir, attributes);
    RequirePersistentAcls(helper_dir);
    grants[helper_dir] = read_execute;
  }
  if (std::none_of(request.writable_paths.begin(), request.writable_paths.end(), [&](const std::wstring& path) {
        return PathContains(path, request.cwd);
      })) {
    throw std::runtime_error("isolated cwd must be inside a writable path");
  }
  RequirePersistentAcls(request.cwd);
  const std::wstring command = FullPath(request.command);
  RequireNoReparsePoint(command, PathAttributes(command));
  RequirePersistentAcls(command);
  request.command = command;
  return grants;
}

DWORD RunContained(Request request, bool announce_ready) {
  const auto grants_requested = RequestedGrants(request);
  AppContainerProfile profile;
  AclGrants grants(profile.sid());
  for (const auto& [path, grant] : grants_requested) grants.Add(path, grant);
  const bool has_broker = !request.broker_pipe_name.empty();

  Handle child_stdin_read;
  Handle parent_stdin_write;
  Handle parent_stdout_read;
  Handle child_stdout_write;
  Handle parent_stderr_read;
  Handle child_stderr_write;
  MakePipe(child_stdin_read, parent_stdin_write, true);
  MakePipe(parent_stdout_read, child_stdout_write, false);
  MakePipe(parent_stderr_read, child_stderr_write, false);

  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job) ThrowLastError("create isolated process job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION job_limits{};
  job_limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &job_limits, sizeof(job_limits))) {
    ThrowLastError("set isolated process job limits");
  }

  std::array<unsigned char, SECURITY_MAX_SID_SIZE> capability_buffer{};
  DWORD capability_size = static_cast<DWORD>(capability_buffer.size());
  if (!CreateWellKnownSid(WinCapabilityInternetClientSid, nullptr, capability_buffer.data(), &capability_size)) {
    ThrowLastError("create internetClient capability SID");
  }
  SID_AND_ATTRIBUTES capability{};
  capability.Sid = capability_buffer.data();
  capability.Attributes = SE_GROUP_ENABLED;
  SECURITY_CAPABILITIES security_capabilities{};
  security_capabilities.AppContainerSid = profile.sid();
  security_capabilities.Capabilities = &capability;
  security_capabilities.CapabilityCount = 1;

  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = child_stdin_read.get();
  startup.StartupInfo.hStdOutput = child_stdout_write.get();
  startup.StartupInfo.hStdError = child_stderr_write.get();
  SIZE_T attribute_size = 0;
  InitializeProcThreadAttributeList(nullptr, 3, 0, &attribute_size);
  std::vector<std::byte> attribute_storage(attribute_size);
  startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 3, 0, &attribute_size)) {
    ThrowLastError("initialize isolated process attributes");
  }
  struct AttributeCleanup {
    LPPROC_THREAD_ATTRIBUTE_LIST value;
    ~AttributeCleanup() { DeleteProcThreadAttributeList(value); }
  } attribute_cleanup{startup.lpAttributeList};
  if (!UpdateProcThreadAttribute(
          startup.lpAttributeList,
          0,
          PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
          &security_capabilities,
          sizeof(security_capabilities),
          nullptr,
          nullptr)) {
    ThrowLastError("set AppContainer security capabilities");
  }
  std::array<HANDLE, 3> inherited_handles{child_stdin_read.get(), child_stdout_write.get(), child_stderr_write.get()};
  if (!UpdateProcThreadAttribute(
          startup.lpAttributeList,
          0,
          PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
          inherited_handles.data(),
          sizeof(inherited_handles),
          nullptr,
          nullptr)) {
    ThrowLastError("restrict inherited child handles");
  }
  DWORD child_process_policy = PROCESS_CREATION_CHILD_PROCESS_OVERRIDE;
  if (!UpdateProcThreadAttribute(
          startup.lpAttributeList,
          0,
          PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY,
          &child_process_policy,
          sizeof(child_process_policy),
          nullptr,
          nullptr)) {
    ThrowLastError("allow contained child processes");
  }

  std::wstring command_line = CommandLine(request);
  std::vector<wchar_t> environment = EnvironmentBlock(request.env);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
          request.command.c_str(),
          command_line.data(),
          nullptr,
          nullptr,
          TRUE,
          EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
          environment.data(),
          request.cwd.c_str(),
          &startup.StartupInfo,
          &process)) {
    ThrowLastError("launch AppContainer process");
  }
  Handle process_handle(process.hProcess);
  Handle thread_handle(process.hThread);
  if (!AssignProcessToJobObject(job.get(), process_handle.get())) {
    TerminateProcess(process_handle.get(), kHelperFailureExitCode);
    ThrowLastError("assign AppContainer process to job");
  }
  Handle broker_process_handle;
  Handle broker_thread_handle;
  if (has_broker) {
    if (!announce_ready) throw std::runtime_error("isolated broker requires a control channel");
    HANDLE raw_broker_control = nullptr;
    if (!DuplicateHandle(
            GetCurrentProcess(),
            ControlHandle(),
            GetCurrentProcess(),
            &raw_broker_control,
            0,
            TRUE,
            DUPLICATE_SAME_ACCESS)) {
      ThrowLastError("duplicate isolated broker control handle");
    }
    Handle broker_control(raw_broker_control);
    SECURITY_ATTRIBUTES inherit{};
    inherit.nLength = sizeof(inherit);
    inherit.bInheritHandle = TRUE;
    Handle broker_null(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (!broker_null) ThrowLastError("open isolated broker null output");

    STARTUPINFOEXW broker_startup{};
    broker_startup.StartupInfo.cb = sizeof(broker_startup);
    broker_startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    broker_startup.StartupInfo.hStdInput = broker_control.get();
    broker_startup.StartupInfo.hStdOutput = broker_control.get();
    broker_startup.StartupInfo.hStdError = broker_null.get();
    SIZE_T broker_attribute_size = 0;
    InitializeProcThreadAttributeList(nullptr, 2, 0, &broker_attribute_size);
    std::vector<std::byte> broker_attribute_storage(broker_attribute_size);
    broker_startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(broker_attribute_storage.data());
    if (!InitializeProcThreadAttributeList(broker_startup.lpAttributeList, 2, 0, &broker_attribute_size)) {
      ThrowLastError("initialize isolated broker attributes");
    }
    struct BrokerAttributeCleanup {
      LPPROC_THREAD_ATTRIBUTE_LIST value;
      ~BrokerAttributeCleanup() { DeleteProcThreadAttributeList(value); }
    } broker_attribute_cleanup{broker_startup.lpAttributeList};
    if (!UpdateProcThreadAttribute(
            broker_startup.lpAttributeList,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
            &security_capabilities,
            sizeof(security_capabilities),
            nullptr,
            nullptr)) {
      ThrowLastError("set isolated broker security capabilities");
    }
    std::array<HANDLE, 2> broker_handles{broker_control.get(), broker_null.get()};
    if (!UpdateProcThreadAttribute(
            broker_startup.lpAttributeList,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
            broker_handles.data(),
            sizeof(broker_handles),
            nullptr,
            nullptr)) {
      ThrowLastError("restrict inherited broker handles");
    }
    const std::wstring broker_module = ModulePath();
    std::wstring broker_command_line = QuoteArgument(broker_module) + L" --broker-proxy " + QuoteArgument(request.broker_pipe_name);
    PROCESS_INFORMATION broker_process{};
    if (!CreateProcessW(
            broker_module.c_str(),
            broker_command_line.data(),
            nullptr,
            nullptr,
            TRUE,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment.data(),
            request.cwd.c_str(),
            &broker_startup.StartupInfo,
            &broker_process)) {
      ThrowLastError("launch isolated broker proxy");
    }
    broker_process_handle.reset(broker_process.hProcess);
    broker_thread_handle.reset(broker_process.hThread);
    if (!AssignProcessToJobObject(job.get(), broker_process_handle.get())) {
      TerminateProcess(broker_process_handle.get(), kHelperFailureExitCode);
      ThrowLastError("assign isolated broker proxy to job");
    }
    WriteControlReady(profile.name());
    unsigned char acknowledge = 0;
    if (!ReadExact(ControlHandle(), &acknowledge, 1) || acknowledge != 0x06) {
      TerminateJobObject(job.get(), kHelperFailureExitCode);
      throw std::runtime_error("isolated broker control channel was not acknowledged");
    }
    if (ResumeThread(broker_thread_handle.get()) == static_cast<DWORD>(-1)) {
      TerminateJobObject(job.get(), kHelperFailureExitCode);
      ThrowLastError("resume isolated broker proxy");
    }
    broker_thread_handle.reset();
  }
  if (ResumeThread(thread_handle.get()) == static_cast<DWORD>(-1)) {
    TerminateJobObject(job.get(), kHelperFailureExitCode);
    ThrowLastError("resume AppContainer process");
  }

  child_stdin_read.reset();
  child_stdout_write.reset();
  child_stderr_write.reset();
  thread_handle.reset();

  std::thread input_thread(CopyStream, GetStdHandle(STD_INPUT_HANDLE), parent_stdin_write.release(), true);
  input_thread.detach();
  std::thread output_thread(CopyStream, parent_stdout_read.release(), GetStdHandle(STD_OUTPUT_HANDLE), false);
  std::thread error_thread(CopyStream, parent_stderr_read.release(), GetStdHandle(STD_ERROR_HANDLE), false);
  if (announce_ready && !has_broker) WriteControlReady(profile.name());

  WaitForSingleObject(process_handle.get(), INFINITE);
  DWORD exit_code = kHelperFailureExitCode;
  if (!GetExitCodeProcess(process_handle.get(), &exit_code)) ThrowLastError("read AppContainer process exit code");
  TerminateJobObject(job.get(), exit_code);
  job.reset();
  if (broker_process_handle) WaitForSingleObject(broker_process_handle.get(), INFINITE);
  output_thread.join();
  error_thread.join();
  process_handle.reset();
  grants.Cleanup();
  profile.Delete();
  return exit_code;
}

std::wstring ModulePath() {
  std::wstring path(32 * 1024, L'\0');
  const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  if (size == 0 || size >= path.size()) ThrowLastError("resolve helper executable path");
  path.resize(size);
  return path;
}

bool WriteFileText(const std::wstring& path, std::string_view contents) {
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!file) return false;
  DWORD written = 0;
  return WriteFile(file.get(), contents.data(), static_cast<DWORD>(contents.size()), &written, nullptr) && written == contents.size();
}

bool CanReadFile(const std::wstring& path) {
  Handle file(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  return static_cast<bool>(file);
}

bool LoopbackConnects(unsigned short port) {
  SOCKET socket_value = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (socket_value == INVALID_SOCKET) return false;
  u_long nonblocking = 1;
  if (ioctlsocket(socket_value, FIONBIO, &nonblocking) != 0) {
    closesocket(socket_value);
    return false;
  }
  sockaddr_in endpoint{};
  endpoint.sin_family = AF_INET;
  endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  endpoint.sin_port = htons(port);
  bool connected = connect(socket_value, reinterpret_cast<const sockaddr*>(&endpoint), sizeof(endpoint)) == 0;
  if (!connected && WSAGetLastError() == WSAEWOULDBLOCK) {
    fd_set writable;
    FD_ZERO(&writable);
    FD_SET(socket_value, &writable);
    timeval timeout{1, 500'000};
    if (select(0, nullptr, &writable, nullptr, &timeout) > 0) {
      int socket_error = 0;
      int socket_error_size = sizeof(socket_error);
      connected = getsockopt(socket_value, SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&socket_error), &socket_error_size) == 0 && socket_error == 0;
    }
  }
  closesocket(socket_value);
  return connected;
}

bool HasExpectedAppContainerToken() {
  Handle token;
  HANDLE raw_token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw_token)) return false;
  token.reset(raw_token);
  DWORD is_app_container = 0;
  DWORD returned = 0;
  if (!GetTokenInformation(token.get(), TokenIsAppContainer, &is_app_container, sizeof(is_app_container), &returned) || is_app_container == 0) {
    return false;
  }
  DWORD capability_bytes = 0;
  GetTokenInformation(token.get(), TokenCapabilities, nullptr, 0, &capability_bytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || capability_bytes == 0) return false;
  std::vector<std::byte> capabilities(capability_bytes);
  if (!GetTokenInformation(token.get(), TokenCapabilities, capabilities.data(), capability_bytes, &capability_bytes)) return false;
  std::array<unsigned char, SECURITY_MAX_SID_SIZE> internet_client{};
  DWORD internet_client_bytes = static_cast<DWORD>(internet_client.size());
  if (!CreateWellKnownSid(WinCapabilityInternetClientSid, nullptr, internet_client.data(), &internet_client_bytes)) return false;
  const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(capabilities.data());
  for (DWORD index = 0; index < groups->GroupCount; ++index) {
    if (EqualSid(groups->Groups[index].Sid, internet_client.data())) return true;
  }
  return false;
}

int FileNetworkChild(int argc, wchar_t** argv, bool emit_json) {
  if (argc != 5) return kHelperFailureExitCode;
  WSADATA winsock{};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) return kHelperFailureExitCode;
  struct WinsockCleanup {
    ~WinsockCleanup() { WSACleanup(); }
  } winsock_cleanup;
  const std::wstring protected_file = argv[2];
  const std::wstring denied_write = argv[3];
  const unsigned long raw_port = wcstoul(argv[4], nullptr, 10);
  if (raw_port == 0 || raw_port > 65535) return kHelperFailureExitCode;
  const bool allowed_write = WriteFileText(L"allowed-write.txt", "ok");
  const bool protected_read_denied = !CanReadFile(protected_file);
  const bool protected_write_denied = !WriteFileText(denied_write, "denied");
  const bool expected_token = HasExpectedAppContainerToken();
  const bool loopback_denied = !LoopbackConnects(static_cast<unsigned short>(raw_port));
  if (emit_json) {
    WriteUtf8(
        GetStdHandle(STD_OUTPUT_HANDLE),
        std::string("{\"allowedWrite\":") + (allowed_write ? "true" : "false") +
            ",\"protectedReadDenied\":" + (protected_read_denied ? "true" : "false") +
            ",\"protectedWriteDenied\":" + (protected_write_denied ? "true" : "false") +
            ",\"internetClient\":" + (expected_token ? "true" : "false") +
            ",\"loopbackDenied\":" + (loopback_denied ? "true" : "false") + "}\n");
  }
  return allowed_write && protected_read_denied && protected_write_denied && expected_token && loopback_denied ? 0 : 1;
}

std::map<std::wstring, std::wstring> CurrentEnvironment() {
  std::map<std::wstring, std::wstring> env;
  wchar_t* block = GetEnvironmentStringsW();
  if (!block) ThrowLastError("read current environment");
  for (const wchar_t* entry = block; *entry; entry += wcslen(entry) + 1) {
    const wchar_t* separator = wcschr(entry + (entry[0] == L'=' ? 1 : 0), L'=');
    if (!separator || entry[0] == L'=') continue;
    env.emplace(std::wstring(entry, separator), std::wstring(separator + 1));
  }
  FreeEnvironmentStringsW(block);
  return env;
}

int RunProbe() {
  WSADATA winsock{};
  if (WSAStartup(MAKEWORD(2, 2), &winsock) != 0) throw std::runtime_error("initialize Winsock probe");
  struct WinsockCleanup {
    ~WinsockCleanup() { WSACleanup(); }
  } winsock_cleanup;

  SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (listener == INVALID_SOCKET) throw std::runtime_error("create loopback probe listener");
  struct SocketCleanup {
    SOCKET value;
    ~SocketCleanup() { closesocket(value); }
  } socket_cleanup{listener};
  sockaddr_in endpoint{};
  endpoint.sin_family = AF_INET;
  endpoint.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  endpoint.sin_port = 0;
  if (bind(listener, reinterpret_cast<const sockaddr*>(&endpoint), sizeof(endpoint)) != 0 || listen(listener, 1) != 0) {
    throw std::runtime_error("bind loopback probe listener");
  }
  int endpoint_size = sizeof(endpoint);
  if (getsockname(listener, reinterpret_cast<sockaddr*>(&endpoint), &endpoint_size) != 0) throw std::runtime_error("inspect loopback probe listener");

  std::array<wchar_t, 32 * 1024> temp{};
  const DWORD temp_size = GetTempPathW(static_cast<DWORD>(temp.size()), temp.data());
  if (temp_size == 0 || temp_size >= temp.size()) ThrowLastError("resolve probe temp directory");
  const std::filesystem::path base = std::filesystem::path(temp.data()) / UniqueProfileName();
  const std::filesystem::path allowed = base / L"allowed";
  const std::filesystem::path protected_dir = base / L"protected";
  std::filesystem::create_directories(allowed);
  std::filesystem::create_directories(protected_dir);
  struct DirectoryCleanup {
    std::filesystem::path path;
    ~DirectoryCleanup() {
      std::error_code ignored;
      std::filesystem::remove_all(path, ignored);
    }
  } directory_cleanup{base};
  const std::filesystem::path protected_file = protected_dir / L"secret.txt";
  const std::filesystem::path denied_write = protected_dir / L"denied.txt";
  if (!WriteFileText(protected_file.wstring(), "secret")) throw std::runtime_error("create protected probe file");

  Request request;
  request.command = ModulePath();
  request.args = {
      L"--probe-child",
      protected_file.wstring(),
      denied_write.wstring(),
      std::to_wstring(ntohs(endpoint.sin_port)),
  };
  request.cwd = allowed.wstring();
  request.env = CurrentEnvironment();
  request.read_execute_paths = {std::filesystem::path(request.command).parent_path().wstring()};
  request.writable_paths = {allowed.wstring()};
  const DWORD result = RunContained(std::move(request), false);
  if (result != 0 || !CanReadFile((allowed / L"allowed-write.txt").wstring()) || CanReadFile(denied_write.wstring())) {
    throw std::runtime_error("AppContainer denial/capability smoke check failed");
  }
  WriteUtf8(
      GetStdHandle(STD_OUTPUT_HANDLE),
      "{\"supported\":true,\"capabilities\":{\"appContainer\":true,\"filesystemAcl\":true,\"internetClient\":true,\"killOnJobClose\":true,\"loopbackDenied\":true}}\n");
  return 0;
}

int SpawnDescendantChild(int argc, wchar_t** argv) {
  if (argc != 3) return kHelperFailureExitCode;
  const std::wstring module = ModulePath();
  std::wstring command_line = QuoteArgument(module) + L" --harness-sleep";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(module.c_str(), command_line.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
    return kHelperFailureExitCode;
  }
  Handle child_process(process.hProcess);
  Handle child_thread(process.hThread);
  if (!WriteFileText(argv[2], WideToUtf8(std::to_wstring(process.dwProcessId)))) return kHelperFailureExitCode;
  return 0;
}

int SpawnExternalChild(int argc, wchar_t** argv) {
  if (argc < 3) return kHelperFailureExitCode;
  const std::wstring command = argv[2];
  std::wstring command_line = QuoteArgument(command);
  for (int index = 3; index < argc; ++index) {
    command_line += L' ';
    command_line += QuoteArgument(argv[index]);
  }
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(command.c_str(), command_line.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
    WriteUtf8(GetStdHandle(STD_ERROR_HANDLE), Win32Message("spawn external child", GetLastError()) + "\n");
    return kHelperFailureExitCode;
  }
  Handle child_process(process.hProcess);
  Handle child_thread(process.hThread);
  WaitForSingleObject(child_process.get(), INFINITE);
  DWORD exit_code = kHelperFailureExitCode;
  return GetExitCodeProcess(child_process.get(), &exit_code) ? static_cast<int>(exit_code) : kHelperFailureExitCode;
}

int CheckProfileDeleted(int argc, wchar_t** argv) {
  if (argc != 3) return kHelperFailureExitCode;
  PSID sid = nullptr;
  const HRESULT result = CreateAppContainerProfile(argv[2], L"cleanup check", L"cleanup check", nullptr, 0, &sid);
  if (FAILED(result)) return 1;
  if (sid) FreeSid(sid);
  const HRESULT cleanup = DeleteAppContainerProfile(argv[2]);
  return SUCCEEDED(cleanup) ? 0 : 1;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  const bool exec_mode = argc >= 2 && std::wstring_view(argv[1]) == L"--exec";
  try {
    if (argc >= 2 && std::wstring_view(argv[1]) == L"--probe") return RunProbe();
    if (argc >= 2 && std::wstring_view(argv[1]) == L"--broker-proxy") return RunBrokerProxy(argc, argv);
    if (argc >= 2 && std::wstring_view(argv[1]) == L"--probe-child") return FileNetworkChild(argc, argv, false);
    if (argc >= 2 && std::wstring_view(argv[1]) == L"--harness-files") return FileNetworkChild(argc, argv, true);
    if (argc >= 2 && std::wstring_view(argv[1]) == L"--harness-descendant") return SpawnDescendantChild(argc, argv);
    if (argc >= 2 && std::wstring_view(argv[1]) == L"--harness-spawn-external") return SpawnExternalChild(argc, argv);
    if (argc >= 2 && std::wstring_view(argv[1]) == L"--harness-sleep") {
      Sleep(60'000);
      return 0;
    }
    if (argc >= 2 && std::wstring_view(argv[1]) == L"--check-profile-deleted") return CheckProfileDeleted(argc, argv);
    if (exec_mode) return static_cast<int>(RunContained(ParseRequest(ReadRequestLine()), true));
    throw std::runtime_error("expected --probe or --exec");
  } catch (const std::exception& error) {
    if (exec_mode) WriteControlError(error.what());
    WriteUtf8(GetStdHandle(STD_ERROR_HANDLE), std::string("agent-isolator: ") + error.what() + "\n");
    return kHelperFailureExitCode;
  }
}
