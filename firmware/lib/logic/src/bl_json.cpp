#include "bl_json.h"

#include <algorithm>
#include <cstring>

namespace bl {

Json Json::boolean(bool v) {
  Json j;
  j.type_ = Type::Bool;
  j.b_ = v;
  return j;
}

Json Json::integer(int64_t v) {
  Json j;
  j.type_ = Type::Int;
  j.i_ = v;
  return j;
}

Json Json::string(std::string v) {
  Json j;
  j.type_ = Type::String;
  j.s_ = std::move(v);
  return j;
}

Json Json::array() {
  Json j;
  j.type_ = Type::Array;
  return j;
}

Json Json::object() {
  Json j;
  j.type_ = Type::Object;
  return j;
}

const Json* Json::get(const std::string& key) const {
  if (type_ != Type::Object) return nullptr;
  for (const auto& m : obj_) {
    if (m.first == key) return &m.second;
  }
  return nullptr;
}

Json& Json::push(Json v) {
  arr_.push_back(std::move(v));
  return arr_.back();
}

Json& Json::set(const std::string& key, Json v) {
  for (auto& m : obj_) {
    if (m.first == key) {
      m.second = std::move(v);
      return m.second;
    }
  }
  obj_.emplace_back(key, std::move(v));
  return obj_.back().second;
}

std::string intToString(int64_t v) {
  char buf[24];
  uint64_t u = v < 0 ? (uint64_t)0 - (uint64_t)v : (uint64_t)v;
  int pos = (int)sizeof(buf);
  do {
    buf[--pos] = (char)('0' + (u % 10));
    u /= 10;
  } while (u != 0);
  if (v < 0) buf[--pos] = '-';
  return std::string(buf + pos, sizeof(buf) - (size_t)pos);
}

bool isPrintableAscii(const std::string& s) {
  for (unsigned char c : s) {
    if (c < 0x20 || c > 0x7E || c == '"' || c == '\\') return false;
  }
  return true;
}

namespace {

void dumpString(const std::string& s, std::string& out) {
  out.push_back('"');
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back((char)c);
    } else if (c < 0x20) {
      static const char hex[] = "0123456789abcdef";
      out += "\\u00";
      out.push_back(hex[c >> 4]);
      out.push_back(hex[c & 15]);
    } else {
      out.push_back((char)c);
    }
  }
  out.push_back('"');
}

void dumpTo(const Json& v, std::string& out) {
  switch (v.type()) {
    case Json::Type::Null:
      out += "null";
      break;
    case Json::Type::Bool:
      out += v.asBool() ? "true" : "false";
      break;
    case Json::Type::Int:
      out += intToString(v.asInt());
      break;
    case Json::Type::String:
      dumpString(v.asString(), out);
      break;
    case Json::Type::Array: {
      out.push_back('[');
      bool first = true;
      for (const auto& item : v.items()) {
        if (!first) out.push_back(',');
        first = false;
        dumpTo(item, out);
      }
      out.push_back(']');
      break;
    }
    case Json::Type::Object: {
      out.push_back('{');
      bool first = true;
      for (const auto& m : v.members()) {
        if (!first) out.push_back(',');
        first = false;
        dumpString(m.first, out);
        out.push_back(':');
        dumpTo(m.second, out);
      }
      out.push_back('}');
      break;
    }
  }
}

// Строки после строгого разбора — печатный ASCII без `"` и `\`: пишутся как есть (§3.1).
void canonTo(const Json& v, std::string& out, const char* omit) {
  switch (v.type()) {
    case Json::Type::String:
      out.push_back('"');
      out += v.asString();
      out.push_back('"');
      break;
    case Json::Type::Array: {
      out.push_back('[');
      bool first = true;
      for (const auto& item : v.items()) {
        if (!first) out.push_back(',');
        first = false;
        canonTo(item, out, nullptr);
      }
      out.push_back(']');
      break;
    }
    case Json::Type::Object: {
      std::vector<const std::pair<std::string, Json>*> ms;
      ms.reserve(v.members().size());
      for (const auto& m : v.members()) {
        if (omit != nullptr && m.first == omit) continue;
        ms.push_back(&m);
      }
      // Сравнение байтов: std::string::compare идёт по char_traits<char> (как unsigned char).
      std::sort(ms.begin(), ms.end(), [](const std::pair<std::string, Json>* a, const std::pair<std::string, Json>* b) {
        return a->first.compare(b->first) < 0;
      });
      out.push_back('{');
      bool first = true;
      for (const auto* m : ms) {
        if (!first) out.push_back(',');
        first = false;
        out.push_back('"');
        out += m->first;
        out += "\":";
        canonTo(m->second, out, nullptr);
      }
      out.push_back('}');
      break;
    }
    default:
      dumpTo(v, out);
      break;
  }
}

}  // namespace

std::string Json::dump() const {
  std::string out;
  dumpTo(*this, out);
  return out;
}

std::string canonicalize(const Json& v, const char* omitTopLevelKey) {
  std::string out;
  canonTo(v, out, omitTopLevelKey);
  return out;
}

class Parser {
 public:
  Parser(const char* d, size_t n, ParseMode m) : p_(d), end_(d + n), mode_(m) {}

  ParseResult run(Json& out) {
    if (strict()) {
      for (const char* q = p_; q < end_; ++q) {
        if (*q == '\\') return fail("backslash");
      }
    }
    ws();
    if (!value(out, 0)) return result();
    ws();
    if (p_ != end_) return fail("json_syntax");
    return ParseResult{true, ""};
  }

 private:
  const char* p_;
  const char* end_;
  ParseMode mode_;
  const char* reason_ = "json_syntax";

  bool strict() const { return mode_ == ParseMode::Strict; }
  ParseResult result() const { return ParseResult{false, reason_}; }
  ParseResult fail(const char* r) {
    reason_ = r;
    return result();
  }
  bool err(const char* r) {
    reason_ = r;
    return false;
  }

  void ws() {
    while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r')) ++p_;
  }

  bool literal(const char* word) {
    size_t n = std::strlen(word);
    if ((size_t)(end_ - p_) < n || std::memcmp(p_, word, n) != 0) return err("json_syntax");
    p_ += n;
    return true;
  }

  bool value(Json& out, int depth) {
    if (p_ >= end_) return err("json_syntax");
    switch (*p_) {
      case '{':
        return object(out, depth);
      case '[':
        return array(out, depth);
      case '"':
        out.type_ = Json::Type::String;
        return str(out.s_, false);
      case 't':
        out.type_ = Json::Type::Bool;
        out.b_ = true;
        return literal("true");
      case 'f':
        out.type_ = Json::Type::Bool;
        out.b_ = false;
        return literal("false");
      case 'n':
        out.type_ = Json::Type::Null;
        return literal("null");
      default:
        if (*p_ == '-' || (*p_ >= '0' && *p_ <= '9')) return number(out);
        return err("json_syntax");
    }
  }

  bool object(Json& out, int depth) {
    if (depth >= (strict() ? kMaxDepth : 64)) return err("too_deep");
    out.type_ = Json::Type::Object;
    ++p_;  // {
    ws();
    if (p_ < end_ && *p_ == '}') {
      ++p_;
      return true;
    }
    for (;;) {
      ws();
      if (p_ >= end_ || *p_ != '"') return err("json_syntax");
      std::string key;
      if (!str(key, true)) return false;
      for (const auto& m : out.obj_) {
        if (m.first == key) return err("duplicate_key");
      }
      if (strict() && depth > 0 && key == "sig") return err("nested_sig");
      ws();
      if (p_ >= end_ || *p_ != ':') return err("json_syntax");
      ++p_;
      ws();
      out.obj_.emplace_back(std::move(key), Json());
      if (!value(out.obj_.back().second, depth + 1)) return false;
      ws();
      if (p_ >= end_) return err("json_syntax");
      if (*p_ == ',') {
        ++p_;
        continue;
      }
      if (*p_ == '}') {
        ++p_;
        return true;
      }
      return err("json_syntax");
    }
  }

  bool array(Json& out, int depth) {
    if (depth >= (strict() ? kMaxDepth : 64)) return err("too_deep");
    out.type_ = Json::Type::Array;
    ++p_;  // [
    ws();
    if (p_ < end_ && *p_ == ']') {
      ++p_;
      return true;
    }
    for (;;) {
      ws();
      out.arr_.emplace_back();
      if (!value(out.arr_.back(), depth + 1)) return false;
      ws();
      if (p_ >= end_) return err("json_syntax");
      if (*p_ == ',') {
        ++p_;
        continue;
      }
      if (*p_ == ']') {
        ++p_;
        return true;
      }
      return err("json_syntax");
    }
  }

  static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }

  bool hex4(uint32_t& v) {
    if (end_ - p_ < 4) return err("json_syntax");
    v = 0;
    for (int i = 0; i < 4; ++i) {
      int h = hexval(p_[i]);
      if (h < 0) return err("json_syntax");
      v = (v << 4) | (uint32_t)h;
    }
    p_ += 4;
    return true;
  }

  static void utf8(uint32_t cp, std::string& out) {
    if (cp < 0x80) {
      out.push_back((char)cp);
    } else if (cp < 0x800) {
      out.push_back((char)(0xC0 | (cp >> 6)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back((char)(0xE0 | (cp >> 12)));
      out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    } else {
      out.push_back((char)(0xF0 | (cp >> 18)));
      out.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    }
  }

  bool str(std::string& out, bool isKey) {
    ++p_;  // "
    for (;;) {
      if (p_ >= end_) return err("json_syntax");
      unsigned char c = (unsigned char)*p_;
      if (c == '"') {
        ++p_;
        return true;
      }
      if (c < 0x20) return err("json_syntax");
      if (c == '\\') {
        // Только в Relaxed: в Strict обратная косая черта отсечена до разбора.
        ++p_;
        if (p_ >= end_) return err("json_syntax");
        char e = *p_++;
        switch (e) {
          case '"': out.push_back('"'); break;
          case '\\': out.push_back('\\'); break;
          case '/': out.push_back('/'); break;
          case 'b': out.push_back('\b'); break;
          case 'f': out.push_back('\f'); break;
          case 'n': out.push_back('\n'); break;
          case 'r': out.push_back('\r'); break;
          case 't': out.push_back('\t'); break;
          case 'u': {
            uint32_t cp = 0;
            if (!hex4(cp)) return false;
            if (cp >= 0xD800 && cp <= 0xDBFF) {
              uint32_t lo = 0;
              if (end_ - p_ < 2 || p_[0] != '\\' || p_[1] != 'u') return err("json_syntax");
              p_ += 2;
              if (!hex4(lo) || lo < 0xDC00 || lo > 0xDFFF) return err("json_syntax");
              cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
            }
            utf8(cp, out);
            break;
          }
          default:
            return err("json_syntax");
        }
        continue;
      }
      if (strict() && c > 0x7E) return err(isKey ? "key_charset" : "string_charset");
      out.push_back((char)c);
      ++p_;
    }
  }

  bool number(Json& out) {
    const char* start = p_;
    bool neg = false;
    if (*p_ == '-') {
      neg = true;
      ++p_;
    }
    if (p_ >= end_ || *p_ < '0' || *p_ > '9') return err("json_syntax");
    const char* digits = p_;
    if (*p_ == '0') {
      ++p_;
    } else {
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') ++p_;
    }
    const char* digitsEnd = p_;
    bool notInteger = false;
    if (p_ < end_ && *p_ == '.') {
      ++p_;
      if (p_ >= end_ || *p_ < '0' || *p_ > '9') return err("json_syntax");
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') ++p_;
      notInteger = true;
    }
    if (p_ < end_ && (*p_ == 'e' || *p_ == 'E')) {
      ++p_;
      if (p_ < end_ && (*p_ == '+' || *p_ == '-')) ++p_;
      if (p_ >= end_ || *p_ < '0' || *p_ > '9') return err("json_syntax");
      while (p_ < end_ && *p_ >= '0' && *p_ <= '9') ++p_;
      notInteger = true;
    }
    // После числа — только разделитель (ведущий ноль «042» — синтаксическая ошибка).
    if (p_ < end_ && *p_ >= '0' && *p_ <= '9') return err("json_syntax");
    if (notInteger) return err("number_not_integer");
    size_t n = (size_t)(digitsEnd - digits);
    if (neg && n == 1 && *digits == '0') return err("number_not_integer");  // -0
    if (n > 16) return err("number_out_of_range");
    uint64_t u = 0;
    for (const char* q = digits; q < digitsEnd; ++q) u = u * 10 + (uint64_t)(*q - '0');
    if (u > (uint64_t)kMaxSafeInt) return err("number_out_of_range");
    (void)start;
    out.type_ = Json::Type::Int;
    out.i_ = neg ? -(int64_t)u : (int64_t)u;
    return true;
  }
};

ParseResult parseJson(const char* data, size_t len, Json& out, ParseMode mode) {
  out = Json();
  Parser parser(data, len, mode);
  ParseResult r = parser.run(out);
  if (!r.ok) out = Json();
  return r;
}

}  // namespace bl
