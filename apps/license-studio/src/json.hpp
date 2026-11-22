// Minimal UTF-8 JSON DOM for the License Studio Win32 UI.
// Not a general-purpose library; enough to talk to engine.js.
#pragma once

#include <cctype>
#include <cmath>
#include <cstdio>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

struct Json {
  enum Type { kNull, kBool, kNumber, kString, kArray, kObject };
  Type type = kNull;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<Json> a;
  std::map<std::string, Json> o;

  static Json null() { return Json(); }
  static Json fromBool(bool v) { Json j; j.type = kBool; j.b = v; return j; }
  static Json number(double v) { Json j; j.type = kNumber; j.n = v; return j; }
  static Json numberInt(int v) { Json j; j.type = kNumber; j.n = v; return j; }
  static Json string(const std::string& v) { Json j; j.type = kString; j.s = v; return j; }
  static Json array() { Json j; j.type = kArray; return j; }
  static Json object() { Json j; j.type = kObject; return j; }

  bool is_null() const { return type == kNull; }
  bool is_array() const { return type == kArray; }
  bool is_object() const { return type == kObject; }

  const Json& get(const std::string& key) const {
    static Json empty;
    if (type != kObject) return empty;
    auto it = o.find(key);
    return it == o.end() ? empty : it->second;
  }
  Json& operator[](const std::string& key) {
    if (type != kObject) {
      *this = object();
    }
    return o[key];
  }
  const Json& at(size_t i) const {
    static Json empty;
    if (type != kArray || i >= a.size()) return empty;
    return a[i];
  }
  void push(const Json& v) {
    if (type != kArray) *this = array();
    a.push_back(v);
  }

  bool as_bool(bool def = false) const {
    if (type == kBool) return b;
    return def;
  }
  int as_int(int def = 0) const {
    if (type == kNumber) return static_cast<int>(n);
    if (type == kString) {
      try { return std::stoi(s); } catch (...) { return def; }
    }
    return def;
  }
  std::string as_string(const std::string& def = {}) const {
    if (type == kString) return s;
    if (type == kNumber) {
      std::ostringstream os;
      if (std::floor(n) == n) os << static_cast<long long>(n);
      else os << n;
      return os.str();
    }
    if (type == kBool) return b ? "true" : "false";
    return def;
  }
  std::string str(const std::string& key, const std::string& def = {}) const {
    return get(key).as_string(def);
  }
  bool boolean(const std::string& key, bool def = false) const {
    return get(key).as_bool(def);
  }
  int integer(const std::string& key, int def = 0) const {
    return get(key).as_int(def);
  }
  bool has(const std::string& key) const {
    return type == kObject && o.find(key) != o.end();
  }

  std::string stringify() const { return stringifyImpl(); }

  static Json parse(const std::string& text) {
    Parser p(text);
    Json v = p.parseValue();
    p.skip();
    if (p.i != p.in.size()) throw std::runtime_error("json trailing data");
    return v;
  }

private:
  struct Parser {
    const std::string& in;
    size_t i = 0;
    explicit Parser(const std::string& s) : in(s) {}

    void skip() {
      while (i < in.size() && std::isspace(static_cast<unsigned char>(in[i]))) i++;
    }
    char peek() { skip(); return i < in.size() ? in[i] : '\0'; }
    char next() { skip(); return i < in.size() ? in[i++] : '\0'; }
    void expect(char c) {
      char g = next();
      if (g != c) throw std::runtime_error(std::string("json expected ") + c);
    }

    Json parseValue() {
      char c = peek();
      if (c == '{') return parseObject();
      if (c == '[') return parseArray();
      if (c == '"') return Json::string(parseString());
      if (c == 't' || c == 'f') return parseBool();
      if (c == 'n') return parseNull();
      if (c == '-' || std::isdigit(static_cast<unsigned char>(c))) return parseNumber();
      throw std::runtime_error("json unexpected token");
    }

    Json parseObject() {
      expect('{');
      Json obj = Json::object();
      skip();
      if (peek() == '}') { next(); return obj; }
      for (;;) {
        if (peek() != '"') throw std::runtime_error("json object key");
        std::string key = parseString();
        expect(':');
        obj.o[key] = parseValue();
        char c = next();
        if (c == '}') return obj;
        if (c != ',') throw std::runtime_error("json object comma");
      }
    }

    Json parseArray() {
      expect('[');
      Json arr = Json::array();
      skip();
      if (peek() == ']') { next(); return arr; }
      for (;;) {
        arr.a.push_back(parseValue());
        char c = next();
        if (c == ']') return arr;
        if (c != ',') throw std::runtime_error("json array comma");
      }
    }

    std::string parseString() {
      expect('"');
      std::string out;
      while (i < in.size()) {
        char c = in[i++];
        if (c == '"') return out;
        if (c == '\\') {
          if (i >= in.size()) throw std::runtime_error("json bad escape");
          char e = in[i++];
          switch (e) {
            case '"': case '\\': case '/': out.push_back(e); break;
            case 'b': out.push_back('\b'); break;
            case 'f': out.push_back('\f'); break;
            case 'n': out.push_back('\n'); break;
            case 'r': out.push_back('\r'); break;
            case 't': out.push_back('\t'); break;
            case 'u': {
              if (i + 4 > in.size()) throw std::runtime_error("json bad unicode");
              unsigned code = 0;
              for (int k = 0; k < 4; k++) {
                char h = in[i++];
                code <<= 4;
                if (h >= '0' && h <= '9') code += h - '0';
                else if (h >= 'a' && h <= 'f') code += h - 'a' + 10;
                else if (h >= 'A' && h <= 'F') code += h - 'A' + 10;
                else throw std::runtime_error("json bad hex");
              }
              if (code < 0x80) out.push_back(static_cast<char>(code));
              else if (code < 0x800) {
                out.push_back(static_cast<char>(0xC0 | (code >> 6)));
                out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
              } else {
                out.push_back(static_cast<char>(0xE0 | (code >> 12)));
                out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
                out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
              }
              break;
            }
            default: throw std::runtime_error("json unknown escape");
          }
        } else {
          out.push_back(c);
        }
      }
      throw std::runtime_error("json unterminated string");
    }

    Json parseBool() {
      if (in.compare(i, 4, "true") == 0) { i += 4; return Json::fromBool(true); }
      if (in.compare(i, 5, "false") == 0) { i += 5; return Json::fromBool(false); }
      throw std::runtime_error("json bad bool");
    }
    Json parseNull() {
      if (in.compare(i, 4, "null") == 0) { i += 4; return Json::null(); }
      throw std::runtime_error("json bad null");
    }
    Json parseNumber() {
      size_t start = i;
      if (peek() == '-') i++;
      while (i < in.size() && std::isdigit(static_cast<unsigned char>(in[i]))) i++;
      if (i < in.size() && in[i] == '.') {
        i++;
        while (i < in.size() && std::isdigit(static_cast<unsigned char>(in[i]))) i++;
      }
      if (i < in.size() && (in[i] == 'e' || in[i] == 'E')) {
        i++;
        if (i < in.size() && (in[i] == '+' || in[i] == '-')) i++;
        while (i < in.size() && std::isdigit(static_cast<unsigned char>(in[i]))) i++;
      }
      return Json::number(std::stod(in.substr(start, i - start)));
    }
  };

  std::string stringifyImpl() const {
    switch (type) {
      case kNull: return "null";
      case kBool: return b ? "true" : "false";
      case kNumber: {
        std::ostringstream os;
        if (std::floor(n) == n) os << static_cast<long long>(n);
        else os << n;
        return os.str();
      }
      case kString: return quote(s);
      case kArray: {
        std::string out = "[";
        for (size_t i = 0; i < a.size(); i++) {
          if (i) out += ",";
          out += a[i].stringifyImpl();
        }
        out += "]";
        return out;
      }
      case kObject: {
        std::string out = "{";
        bool first = true;
        for (const auto& kv : o) {
          if (!first) out += ",";
          first = false;
          out += quote(kv.first);
          out += ":";
          out += kv.second.stringifyImpl();
        }
        out += "}";
        return out;
      }
    }
    return "null";
  }

  static std::string quote(const std::string& in) {
    std::string out = "\"";
    for (unsigned char c : in) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
          if (c < 0x20) {
            char buf[8];
            std::snprintf(buf, sizeof(buf), "\\u%04x", c);
            out += buf;
          } else {
            out.push_back(static_cast<char>(c));
          }
      }
    }
    out += "\"";
    return out;
  }
};
